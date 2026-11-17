(function () {
  "use strict";

  const UCI_MOVE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
  const FULL_BACKEND = "stockfish-19-full-single-wasm";
  const LITE_BACKEND = "stockfish-19-lite-asm";
  const MAX_QUEUE = 8;
  const IDLE_CLOSE_MS = 3 * 60 * 1000;

  let worker = null;
  let suspended = false;
  let ready = false;
  let phase = "idle";
  let generation = 0;
  let initPromise = null;
  let initResolve = null;
  let initReject = null;
  let initTimer = null;
  let drainTimer = null;
  let idleTimer = null;
  let idleEpoch = 0;
  let configuredHashMb = 64;
  let configuredBackend = FULL_BACKEND;
  let configuredMultiPv = 1;
  let configuredLimitStrength = null;
  let configuredElo = null;
  let activeJob = null;
  const queue = [];
  const resultCache = new Map();
  const RESULT_CACHE_LIMIT = 48;

  function engineSettings(request = {}) {
    const profile = globalThis.__CC_DEVICE_PROFILE__;
    const recommendation = profile?.recommendation || {};
    const mobile = Boolean(globalThis.__CC_ENGINE_RUNTIME__ || profile?.recommendation);
    const constrained = Boolean(profile?.power?.saveMode || profile?.power?.backgroundRestricted || Number(profile?.power?.thermalStatus) >= 2);
    const tier = constrained ? "LOW" : String(recommendation.tier || "BALANCED").toUpperCase();
    const hashLimit = mobile ? (tier === "LOW" ? 16 : 32) : 128;
    const timeLimit = mobile ? (tier === "LOW" ? 180 : tier === "HIGH" ? 400 : 260) : 10000;
    const recommendedHash = Number(recommendation.hashMiB) || hashLimit;
    const recommendedTime = Number(recommendation.maxMovetimeMs) || timeLimit;
    return {
      mobile,
      backend: mobile && tier !== "HIGH" ? LITE_BACKEND : request.backend || FULL_BACKEND,
      hashMb: Math.max(16, Math.min(hashLimit, recommendedHash, Math.round(Number(request.hashMb) || 64))),
      movetimeMs: Math.max(20, Math.min(timeLimit, recommendedTime, Math.round(Number(request.movetimeMs) || 190))),
      multiPv: Math.max(1, Math.min(mobile ? 2 : 3, Math.floor(Number(request.multiPv) || 1)))
    };
  }

  function resources() {
    return { fullNnue: configuredBackend === FULL_BACKEND, primaryHashMb: configuredHashMb, totalHashMb: configuredHashMb, dualWorker: false, mobile: engineSettings().mobile };
  }

  function getStrengthProfile(meta) {
    const eloValue = meta?.elo;
    const rawElo = Number(eloValue);
    const engineMax = Boolean(meta?.engineMax || meta?.engineMaxMode);
    const hasElo = eloValue !== null && eloValue !== undefined && eloValue !== "" && Number.isFinite(rawElo);
    return {
      limited: hasElo && !engineMax,
      elo: hasElo ? Math.max(1320, Math.min(3190, Math.round(rawElo))) : null
    };
  }

  function getCacheKey(job) {
    const strength = getStrengthProfile(job.meta);
    const strengthKey = strength.limited ? `elo:${strength.elo}` : "max";
    return `${job.fen}|${job.multiPv}|${job.movetimeMs}|${job.hashMb}|${job.backend}|${strengthKey}`;
  }

  function cacheResult(job, result) {
    if (
      !job || job.settled || job.cancelled || job.timedOut || result?.partial ||
      !result?.bestUci || result.primaryLine?.uci !== result.bestUci ||
      Object.keys(result.lines || {}).length < job.multiPv
    ) return;
    const key = getCacheKey(job);
    resultCache.delete(key);
    resultCache.set(key, { ...result, meta: null });
    while (resultCache.size > RESULT_CACHE_LIMIT) resultCache.delete(resultCache.keys().next().value);
  }

  function response(ok, requestId, extra = {}) {
    return { ok, requestId, backend: configuredBackend, ...extra };
  }

  function settle(job, payload) {
    if (!job || job.settled) return;
    job.settled = true;
    clearTimeout(job.timer);
    const replies = [job, ...(job.followers || [])];
    job.followers = [];
    for (const reply of replies) {
      reply.settled = true;
      clearTimeout(reply.timer);
      const result = payload.result ? { ...payload.result, meta: reply.meta } : undefined;
      try { reply.sendResponse({ ...payload, requestId: reply.requestId, ...(result ? { result } : {}) }); } catch (e) {}
    }
  }

  function clearEngineTimers() {
    clearTimeout(initTimer);
    clearTimeout(drainTimer);
    initTimer = null;
    drainTimer = null;
  }

  function scheduleIdleClose() {
    clearTimeout(idleTimer);
    idleTimer = null;
    if (!worker || suspended || activeJob || queue.length) return;
    const epoch = ++idleEpoch;
    idleTimer = setTimeout(() => {
      if (activeJob || queue.length || epoch !== idleEpoch) return;
      chrome.runtime.sendMessage({ target: "background-engine", type: "ENGINE_OFFSCREEN_IDLE", epoch }, () => void chrome.runtime.lastError);
    }, engineSettings().mobile ? 30000 : IDLE_CLOSE_MS);
  }

  function resetWorker(message) {
    generation++;
    clearEngineTimers();
    clearTimeout(idleTimer);
    idleTimer = null;
    idleEpoch++;
    if (worker) {
      if (phase === "searching") {
        try { worker.postMessage("stop"); } catch (e) {}
      }
      try { worker.terminate(); } catch (e) {}
    }
    worker = null;
    ready = false;
    phase = "idle";
    configuredMultiPv = 1;
    configuredLimitStrength = null;
    configuredElo = null;
    if (initReject) initReject(new Error(message));
    initResolve = null;
    initReject = null;
    initPromise = null;
  }

  function closeEngine(code = "RELEASED") {
    resetWorker(code);
    settle(activeJob, response(false, activeJob?.requestId, { code }));
    activeJob = null;
    while (queue.length) {
      const job = queue.shift();
      settle(job, response(false, job.requestId, { code }));
    }
    resultCache.clear();
  }

  function failEngine(message) {
    resetWorker(message);
    settle(activeJob, response(false, activeJob?.requestId, { code: "ENGINE_CRASH", error: message }));
    activeJob = null;
    while (queue.length) {
      const job = queue.shift();
      settle(job, response(false, job.requestId, { code: "ENGINE_CRASH", error: message }));
    }
    scheduleIdleClose();
  }

  function selectLines(job, bestUci = null) {
    const depths = [...job.depthLines.keys()].sort((a, b) => b - a);
    let deepestPartial = {};
    for (const depth of depths) {
      const lines = job.depthLines.get(depth);
      const contiguous = {};
      if (bestUci) {
        const ordered = Object.keys(lines)
          .map(Number)
          .sort((a, b) => a - b)
          .map(index => lines[index])
          .filter(Boolean);
        const matching = ordered.find(candidate => candidate.uci === bestUci);
        if (!matching) continue;
        const reordered = [matching, ...ordered.filter(candidate => candidate !== matching && candidate.uci !== bestUci)];
        for (let index = 0; index < reordered.length && index < job.multiPv; index++) {
          contiguous[index + 1] = reordered[index];
        }
      } else {
        if (!lines[1]) continue;
        for (let index = 1; index <= job.multiPv; index++) {
          if (!lines[index]) break;
          contiguous[index] = lines[index];
        }
      }
      if (!deepestPartial[1] && contiguous[1]) deepestPartial = contiguous;
      if (Object.keys(contiguous).length >= job.multiPv) return contiguous;
    }
    return deepestPartial;
  }

  function fallbackLine(bestUci) {
    return {
      uci: bestUci,
      from: bestUci.slice(0, 2),
      to: bestUci.slice(2, 4),
      promo: bestUci[4] || null,
      depth: 0,
      selDepth: 0,
      nodes: 0,
      nps: 0,
      hashFull: 0,
      scoreCp: 0,
      isMate: false,
      mateIn: null,
      pv: [bestUci],
      wdl: null,
      pvChain: `${bestUci.slice(0, 2)}->${bestUci.slice(2, 4)}${bestUci[4] ? `=${bestUci[4].toUpperCase()}` : ""}`
    };
  }

  function finishActiveFromBestMove(bestUci) {
    const job = activeJob;
    if (!job) return;
    activeJob = null;
    phase = "idle";
    if (job.settled || job.cancelled || job.timedOut) {
      pump();
      return;
    }
    if (!bestUci) {
      settle(job, response(false, job.requestId, { code: "EMPTY_ENGINE_RESULT" }));
      pump();
      return;
    }
    const lines = selectLines(job, bestUci);
    const usedFallback = !lines[1];
    if (usedFallback) lines[1] = fallbackLine(bestUci);
    const partial = usedFallback || Object.keys(lines).length < job.multiPv;
    const result = {
        bestUci,
        lines,
        primaryLine: lines[1],
        partial,
        searchCompleted: true,
        workers: 1,
        coresUsed: 1,
        hashMb: configuredHashMb,
        consensus: configuredBackend === FULL_BACKEND ? "full-nnue" : "lite-primary",
        backend: configuredBackend,
        meta: job.meta,
        resources: resources()
      };
    cacheResult(job, result);
    settle(job, response(true, job.requestId, { result }));
    pump();
  }

  function handleLine(rawLine) {
    const line = String(rawLine || "").trim();
    if (!line) return;

    if (line === "uciok" && phase === "uci") {
      phase = "initializing";
      worker.postMessage("setoption name Threads value 1");
      worker.postMessage(`setoption name Hash value ${configuredHashMb}`);
      worker.postMessage("setoption name UCI_ShowWDL value true");
      worker.postMessage("isready");
      return;
    }

    if (line === "readyok") {
      if (phase === "initializing") {
        clearTimeout(initTimer);
        initTimer = null;
        ready = true;
        phase = "idle";
        initResolve?.(true);
        initResolve = null;
        initReject = null;
        initPromise = null;
        pump();
      } else if (phase === "sync" && activeJob) {
        clearTimeout(activeJob.timer);
        if (activeJob.settled) {
          activeJob = null;
          phase = "idle";
          pump();
          return;
        }
        const job = activeJob;
        const position = `position fen ${job.fen}`;
        phase = "searching";
        worker.postMessage(position);
        worker.postMessage(`go movetime ${job.movetimeMs}`);
        job.timer = setTimeout(() => {
          if (activeJob !== job || phase !== "searching") return;
          job.timedOut = true;
          const lines = selectLines(job);
          const bestUci = lines[1]?.uci || null;
          if (bestUci) {
            const result = {
              bestUci: lines[1]?.uci || null,
              lines,
              primaryLine: lines[1],
              partial: true,
              searchCompleted: false,
              workers: 1,
              coresUsed: 1,
              hashMb: configuredHashMb,
              consensus: "engine-timeout",
              backend: configuredBackend,
              meta: job.meta,
              resources: resources()
            };
            settle(job, response(true, job.requestId, { result }));
          } else {
            settle(job, response(false, job.requestId, { code: "ENGINE_TIMEOUT" }));
          }
          phase = "stopping";
          try { worker.postMessage("stop"); } catch (e) { failEngine(String(e)); }
          drainTimer = setTimeout(() => failEngine("Stockfish stop timeout"), 3500);
        }, job.movetimeMs + 2500);
      }
      return;
    }

    if (!activeJob) return;
    if (line.startsWith("bestmove ")) {
      if (phase !== "searching" && phase !== "stopping") return;
      clearTimeout(drainTimer);
      drainTimer = null;
      const uci = line.split(/\s+/)[1];
      finishActiveFromBestMove(UCI_MOVE.test(uci) ? uci : null);
      return;
    }

    if (phase !== "searching" || !line.startsWith("info ") || /\b(?:lowerbound|upperbound)\b/.test(line)) return;
    const pvMatch = line.match(/\bpv\s+(.+)$/);
    const scoreMatch = line.match(/\bscore\s+(cp|mate)\s+(-?\d+)/);
    if (!pvMatch || !scoreMatch) return;
    const moves = pvMatch[1].trim().split(/\s+/).filter(move => UCI_MOVE.test(move));
    if (!moves.length) return;
    const depth = Number(line.match(/\bdepth\s+(\d+)/)?.[1]) || 0;
    const index = Number(line.match(/\bmultipv\s+(\d+)/)?.[1]) || 1;
    if (index > activeJob.multiPv) return;
    const isMate = scoreMatch[1] === "mate";
    const value = Number(scoreMatch[2]);
    const scoreCp = isMate ? (value > 0 ? 30000 - value * 20 : -30000 - value * 20) : value;
    const wdlMatch = line.match(/\bwdl\s+(\d+)\s+(\d+)\s+(\d+)/);
    if (!activeJob.depthLines.has(depth)) activeJob.depthLines.set(depth, {});
    activeJob.depthLines.get(depth)[index] = {
      uci: moves[0],
      from: moves[0].slice(0, 2),
      to: moves[0].slice(2, 4),
      promo: moves[0][4] || null,
      depth,
      selDepth: Number(line.match(/\bseldepth\s+(\d+)/)?.[1]) || depth,
      nodes: Number(line.match(/\bnodes\s+(\d+)/)?.[1]) || 0,
      nps: Number(line.match(/\bnps\s+(\d+)/)?.[1]) || 0,
      hashFull: Number(line.match(/\bhashfull\s+(\d+)/)?.[1]) || 0,
      scoreCp,
      isMate,
      mateIn: isMate ? value : null,
      pv: moves.slice(0, 12),
      wdl: wdlMatch ? wdlMatch.slice(1).map(Number) : null,
      pvChain: moves.slice(0, 4).map(move => `${move.slice(0, 2)}→${move.slice(2, 4)}${move[4] ? `=${move[4].toUpperCase()}` : ""}`).join(" ➔ ")
    };
    while (activeJob.depthLines.size > 6) activeJob.depthLines.delete(Math.min(...activeJob.depthLines.keys()));
  }

  function ensureEngine(hashMb = 64, backend = FULL_BACKEND) {
    if (suspended) return Promise.reject(new Error("Engine is suspended"));
    const settings = engineSettings({ hashMb, backend });
    if (worker && ready && (activeJob || configuredBackend === settings.backend)) return Promise.resolve(true);
    if (initPromise) return initPromise;
    if (worker) resetWorker("Engine backend changed while idle");
    configuredHashMb = settings.hashMb;
    configuredBackend = settings.backend;
    const token = generation;
    initPromise = new Promise((resolve, reject) => {
      initResolve = resolve;
      initReject = reject;
    });
    const pendingInit = initPromise;
    initTimer = setTimeout(() => {
      if (token === generation) failEngine("Stockfish initialization timeout");
    }, configuredBackend === LITE_BACKEND ? 15000 : 45000);
    try {
      const path = configuredBackend === LITE_BACKEND ? "lib/stockfish-local.js" : "vendor/stockfish/stockfish-19-single.js";
      const currentWorker = new Worker(chrome.runtime.getURL(path));
      worker = currentWorker;
      phase = "uci";
      currentWorker.onmessage = event => {
        if (worker !== currentWorker) return;
        const lines = Array.isArray(event.data) ? event.data : String(event.data || "").split(/\r?\n/);
        for (const line of lines) handleLine(line);
      };
      currentWorker.onerror = event => {
        if (worker === currentWorker) failEngine(event.message || "Stockfish worker error");
      };
      currentWorker.onmessageerror = () => {
        if (worker === currentWorker) failEngine("Stockfish message error");
      };
      currentWorker.postMessage("uci");
    } catch (error) {
      failEngine(String(error?.message || error));
    }
    return pendingInit;
  }

  function cancelClient(clientKey, code = "CANCELLED") {
    for (let index = queue.length - 1; index >= 0; index--) {
      if (queue[index].clientKey !== clientKey) continue;
      const job = queue.splice(index, 1)[0];
      job.cancelled = true;
      settle(job, response(false, job.requestId, { code }));
    }
    if (!activeJob || activeJob.clientKey !== clientKey) {
      scheduleIdleClose();
      return;
    }
    const job = activeJob;
    job.cancelled = true;
    settle(job, response(false, job.requestId, { code }));
    if (phase === "searching") {
      phase = "stopping";
      try { worker.postMessage("stop"); } catch (e) { failEngine(String(e)); }
      clearTimeout(drainTimer);
      drainTimer = setTimeout(() => failEngine("Stockfish cancellation timeout"), 3500);
    }
  }

  function enqueue(job) {
    clearTimeout(idleTimer);
    idleEpoch++;
    const cacheKey = getCacheKey(job);
    const equivalent = [activeJob, ...queue].find(current => current?.clientKey === job.clientKey &&
      !current.settled && !current.cancelled && !current.timedOut && getCacheKey(current) === cacheKey);
    if (equivalent) {
      equivalent.followers ||= [];
      if (equivalent.followers.length >= 32) {
        settle(job, response(false, job.requestId, { code: "QUEUE_FULL" }));
      } else {
        equivalent.followers.push(job);
      }
      return;
    }
    for (let index = queue.length - 1; index >= 0; index--) {
      if (queue[index].clientKey !== job.clientKey) continue;
      queue[index].cancelled = true;
      settle(queue[index], response(false, queue[index].requestId, { code: "SUPERSEDED" }));
      queue.splice(index, 1);
    }
    if (activeJob?.clientKey === job.clientKey) cancelClient(job.clientKey, "SUPERSEDED");
    const cached = resultCache.get(cacheKey);
    if (cached) {
      resultCache.delete(cacheKey);
      resultCache.set(cacheKey, cached);
      settle(job, response(true, job.requestId, { backend: job.backend, result: { ...cached, meta: job.meta, cached: true, consensus: "engine-cache" } }));
      scheduleIdleClose();
      return;
    }
    queue.push(job);
    while (queue.length > MAX_QUEUE) {
      const dropped = queue.shift();
      settle(dropped, response(false, dropped.requestId, { code: "QUEUE_FULL" }));
    }
    pump();
  }

  function pump() {
    if (suspended || activeJob || phase !== "idle") return;
    if (!queue.length) {
      scheduleIdleClose();
      return;
    }
    const nextJob = queue[0];
    if (!ready || !worker || configuredBackend !== nextJob.backend) {
      ensureEngine(nextJob.hashMb, nextJob.backend).then(pump).catch(error => {
        settle(nextJob, response(false, nextJob.requestId, { code: "ENGINE_INIT_FAILED", error: String(error?.message || error) }));
      });
      return;
    }
    activeJob = queue.shift();
    const job = activeJob;
    job.expiresAt = Date.now() + job.movetimeMs + 20000;
    phase = "sync";
    if (configuredHashMb !== job.hashMb) {
      configuredHashMb = job.hashMb;
      worker.postMessage(`setoption name Hash value ${configuredHashMb}`);
    }
    const strength = getStrengthProfile(job.meta);
    if (configuredLimitStrength !== strength.limited) {
      worker.postMessage(`setoption name UCI_LimitStrength value ${strength.limited ? "true" : "false"}`);
      configuredLimitStrength = strength.limited;
    }
    if (strength.limited && configuredElo !== strength.elo) {
      worker.postMessage(`setoption name UCI_Elo value ${strength.elo}`);
      configuredElo = strength.elo;
    }
    if (configuredMultiPv !== job.multiPv) {
      worker.postMessage(`setoption name MultiPV value ${job.multiPv}`);
      configuredMultiPv = job.multiPv;
    }
    worker.postMessage("isready");
    job.timer = setTimeout(() => {
      if (activeJob === job && phase === "sync") failEngine("Stockfish ready timeout");
    }, 8000);
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.target !== "offscreen-engine") return false;
    clearTimeout(idleTimer);
    idleEpoch++;
    const requestId = String(message.requestId || "");
    const clientKey = String(message.clientKey || "unknown");
    if (suspended) {
      sendResponse(response(false, requestId, { code: "ENGINE_SUSPENDED" }));
      return false;
    }
    if (message.backend && ![FULL_BACKEND, LITE_BACKEND].includes(message.backend)) {
      sendResponse(response(false, requestId, { code: "INVALID_BACKEND" }));
      return false;
    }
    const settings = engineSettings(message);

    if (message.type === "ENGINE_INIT") {
      ensureEngine(settings.hashMb, settings.backend).then(() => {
        sendResponse(response(true, requestId, { status: { ready, backend: configuredBackend, hashMb: configuredHashMb } }));
        scheduleIdleClose();
      }).catch(error => {
        sendResponse(response(false, requestId, { code: "ENGINE_INIT_FAILED", error: String(error?.message || error) }));
        scheduleIdleClose();
      });
      return true;
    }

    if (message.type === "ENGINE_STATUS") {
      sendResponse(response(true, requestId, { status: { ready, phase, backend: configuredBackend, hashMb: configuredHashMb, queueLength: queue.length, busy: Boolean(activeJob) } }));
      scheduleIdleClose();
      return false;
    }

    if (message.type === "ENGINE_CANCEL" || message.type === "ENGINE_RELEASE") {
      cancelClient(clientKey, message.type === "ENGINE_RELEASE" ? "RELEASED" : "CANCELLED");
      const released = message.type === "ENGINE_RELEASE" && !queue.length && (!activeJob || activeJob.clientKey === clientKey);
      if (released) closeEngine();
      sendResponse(response(true, requestId, { cancelled: true, released }));
      return false;
    }

    if (message.type !== "ENGINE_ANALYZE") return false;
    const job = {
      requestId,
      clientKey,
      fen: message.fen,
      backend: settings.backend,
      movetimeMs: settings.movetimeMs,
      multiPv: settings.multiPv,
      uciMoves: Array.isArray(message.uciMoves) ? message.uciMoves.slice() : [],
      useStartposMoves: Boolean(message.useStartposMoves),
      hashMb: settings.hashMb,
      meta: message.meta || null,
      depthLines: new Map(),
      settled: false,
      cancelled: false,
      timedOut: false,
      timer: null,
      expiresAt: null,
      sendResponse
    };
    enqueue(job);
    return true;
  });

  globalThis.__CC_ENGINE_RUNTIME__?.registerOffscreenController(Object.freeze({
    close: () => closeEngine(),
    suspend() {
      suspended = true;
      closeEngine("ENGINE_SUSPENDED");
    },
    resume: () => { suspended = false; },
    refreshProfile() {
      const settings = engineSettings({ backend: configuredBackend, hashMb: configuredHashMb, movetimeMs: activeJob?.movetimeMs || 20 });
      if (worker && (settings.backend !== configuredBackend || settings.hashMb < configuredHashMb || (activeJob && settings.movetimeMs < activeJob.movetimeMs))) {
        closeEngine("PROFILE_CHANGED");
      }
    }
  }));

  scheduleIdleClose();
})();
