(function () {
  if (typeof window !== "undefined" && window.ChessCoachEngine?.create) return;
  "use strict";

  const UCI_MOVE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
  const FULL_BACKEND = "stockfish-19-full-single-wasm";
  const LITE_BACKEND = "stockfish-19-lite-asm";

  function hasOwnedEngineHost() {
    return typeof window !== "undefined" && window.__CC_ANDROID_RUNTIME__?.version === 1;
  }

  function getAndroidCapability() {
    const liveProfile = typeof window !== "undefined" ? window.__CC_ANDROID_RUNTIME__?.profile : null;
    const profile = liveProfile?.recommendation ? liveProfile : typeof window !== "undefined" ? window.__CC_DEVICE_PROFILE__ : null;
    const recommendation = profile?.recommendation || {};
    const constrained = Boolean(profile?.power?.saveMode || profile?.power?.backgroundRestricted || Number(profile?.power?.thermalStatus) >= 2);
    const tier = constrained ? "LOW" : String(recommendation.tier || "").toUpperCase();
    const hashMiB = Number(recommendation.hashMiB);
    const totalBucketMiB = Number(profile?.memory?.totalBucketMiB);
    const logicalCores = Number(profile?.cpu?.logicalCores);
    return {
      available: Boolean(profile?.recommendation),
      tier: ["LOW", "BALANCED", "HIGH"].includes(tier) ? tier : "BALANCED",
      hashMiB: Number.isFinite(hashMiB) ? Math.max(16, Math.min(tier === "LOW" ? 16 : 32, Math.round(hashMiB))) : tier === "LOW" ? 16 : 32,
      maxMovetimeMs: Math.max(20, Math.min(tier === "LOW" ? 180 : tier === "HIGH" ? 400 : 260, Number(recommendation.maxMovetimeMs) || 10000)),
      memoryGb: Number.isFinite(totalBucketMiB) ? totalBucketMiB / 1024 : null,
      logicalCores: Number.isFinite(logicalCores) ? Math.max(1, Math.floor(logicalCores)) : 2
    };
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

  function createPerformanceGovernor() {
    if (hasOwnedEngineHost() || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent || "") || typeof requestAnimationFrame !== "function" || typeof performance === "undefined") {
      return {
        getMode: () => "normal",
        getSnapshot: () => ({ mode: "normal", p95FrameGap: 0, longTaskMs: 0 }),
        start: () => {},
        destroy: () => {}
      };
    }
    let mode = "normal";
    let gaps = [];
    let previousFrame = 0;
    let windowStarted = performance.now();
    let longTaskMs = 0;
    let badWindows = 0;
    let goodWindows = 0;
    let snapshot = { mode, p95FrameGap: 0, longTaskMs: 0 };
    let observer = null;
    let rafId = null;
    let running = false;

    const tick = now => {
      if (!running) return;
      if (typeof document === "undefined" || document.visibilityState !== "hidden") {
        if (previousFrame > 0) {
          const gap = now - previousFrame;
          if (gap < 1000) gaps.push(gap);
        }
        previousFrame = now;
        if (now - windowStarted >= 5000) {
          const sorted = gaps.slice().sort((a, b) => a - b);
          const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0;
          const critical = p95 > 55 || longTaskMs > 400;
          const constrained = critical || p95 > 34 || longTaskMs > 150;
          if (constrained) { badWindows++; goodWindows = 0; }
          else { goodWindows++; badWindows = 0; }
          if (critical && badWindows >= 2) mode = "critical";
          else if (constrained && badWindows >= 2 && mode === "normal") mode = "constrained";
          else if (!constrained && goodWindows >= 3) mode = "normal";
          snapshot = { mode, p95FrameGap: Math.round(p95 * 10) / 10, longTaskMs: Math.round(longTaskMs) };
          gaps = [];
          longTaskMs = 0;
          windowStarted = now;
        }
      } else {
        previousFrame = 0;
        gaps = [];
        longTaskMs = 0;
        windowStarted = now;
      }
      rafId = requestAnimationFrame(tick);
    };

    function start() {
      if (running) return;
      running = true;
      gaps = [];
      previousFrame = 0;
      longTaskMs = 0;
      windowStarted = performance.now();
      if (typeof PerformanceObserver === "function") {
        try {
          observer = new PerformanceObserver(list => {
            if (!running) return;
            for (const entry of list.getEntries()) longTaskMs += entry.duration;
          });
          observer.observe({ type: "longtask", buffered: false });
        } catch (e) {
          try { observer?.disconnect(); } catch (disconnectError) {}
          observer = null;
        }
      }
      rafId = requestAnimationFrame(tick);
    }

    function destroy() {
      running = false;
      if (rafId !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(rafId);
      rafId = null;
      try { observer?.disconnect(); } catch (e) {}
      observer = null;
      gaps = [];
      previousFrame = 0;
      longTaskMs = 0;
    }

    start();
    return { getMode: () => mode, getSnapshot: () => ({ ...snapshot }), start, destroy };
  }

  const performanceGovernor = createPerformanceGovernor();
  const ownedEngines = new Set();
  if (typeof window !== "undefined") {
    const releaseOwnedEngines = () => {
      for (const engine of Array.from(ownedEngines)) engine.terminate();
      performanceGovernor.destroy();
    };
    window.addEventListener("pagehide", releaseOwnedEngines);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") releaseOwnedEngines();
    });
  }

  let engineSourcePromise = null;

  function getEngineSource() {
    if (!engineSourcePromise) {
      engineSourcePromise = fetch(chrome.runtime.getURL("lib/stockfish-local.js")).then(response => {
        if (!response.ok) throw new Error("Stockfish could not be loaded");
        return response.text();
      }).catch(error => {
        engineSourcePromise = null;
        throw error;
      });
    }
    return engineSourcePromise;
  }

  function createLane({ isEnabled = () => true, hashMb: requestedHashMb = null, laneName = "primary" } = {}) {
    const androidCapability = getAndroidCapability();
    const detectedMemory = Number(navigator.deviceMemory);
    const fallbackHash = androidCapability.available ? androidCapability.hashMiB : Number.isFinite(detectedMemory)
      ? (detectedMemory <= 2 ? 32 : detectedMemory <= 4 ? 64 : detectedMemory >= 16 ? 256 : 128)
      : 64;
    const hashMb = Math.max(16, Math.min(256, Number(requestedHashMb) || fallbackHash));
    let worker = null;
    let blobUrl = null;
    let ready = false;
    let initPromise = null;
    let initResolve = null;
    let initTimer = null;
    let generation = 0;
    let phase = "idle";
    let activeJob = null;
    let pendingJob = null;
    let drainTimer = null;
    let configuredMultiPv = 1;
    let configuredLimitStrength = null;
    let configuredElo = null;

    function settle(job, result) {
      if (!job || job.settled) return;
      job.settled = true;
      clearTimeout(job.timer);
      job.resolve(result);
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

    function terminate() {
      generation++;
      clearTimeout(initTimer);
      clearTimeout(drainTimer);
      initTimer = drainTimer = null;
      settle(activeJob, null);
      settle(pendingJob, null);
      activeJob = pendingJob = null;
      if (worker) {
        try { worker.terminate(); } catch (e) {}
      }
      worker = null;
      ready = false;
      phase = "idle";
      configuredMultiPv = 1;
      configuredLimitStrength = null;
      configuredElo = null;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      blobUrl = null;
      if (initResolve) initResolve(false);
      initResolve = null;
      initPromise = null;
    }

    function stopActive() {
      if (!activeJob || phase === "stopping") return;
      settle(activeJob, null);
      if (phase === "searching") {
        phase = "stopping";
        try {
          worker.postMessage("stop");
          // readyok does not drain a search: wait for its bestmove before reusing the worker.
          drainTimer = setTimeout(terminate, 2500);
        } catch (e) {
          terminate();
        }
      }
    }

    function cancel() {
      settle(pendingJob, null);
      pendingJob = null;
      stopActive();
    }

    function pump() {
      if (!ready || !worker || activeJob || !pendingJob) return;
      if (!isEnabled()) {
        cancel();
        return;
      }
      activeJob = pendingJob;
      pendingJob = null;
      phase = "sync";
      try {
        const job = activeJob;
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
        job.timer = setTimeout(terminate, 5000);
      } catch (e) {
        terminate();
      }
    }

    function handleLine(line) {
      line = line.trim();
      if (!line) return;
      if (line === "uciok" && phase === "uci") {
        phase = "initializing";
        worker.postMessage("setoption name Threads value 1");
        worker.postMessage(`setoption name Hash value ${hashMb}`);
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
          if (blobUrl) URL.revokeObjectURL(blobUrl);
          blobUrl = null;
          if (initResolve) initResolve(true);
          initResolve = null;
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
            const lines = selectLines(job);
            const bestUci = lines[1]?.uci || null;
            settle(job, bestUci ? {
              bestUci,
              lines,
              primaryLine: lines[1],
              partial: true,
              searchCompleted: false,
              hashMb,
              lane: laneName
            } : null);
            stopActive();
          }, job.movetimeMs + 1500);
        }
        return;
      }

      if (!activeJob) return;
      if (line.startsWith("bestmove ")) {
        if (phase !== "searching" && phase !== "stopping") return;
        clearTimeout(drainTimer);
        drainTimer = null;
        const job = activeJob;
        const uci = line.split(/\s+/)[1];
        const bestUci = UCI_MOVE.test(uci) ? uci : null;
        activeJob = null;
        phase = "idle";
        if (!job.settled && bestUci) {
          const lines = selectLines(job, bestUci);
          const usedFallback = !lines[1];
          if (usedFallback) lines[1] = fallbackLine(bestUci);
          settle(job, {
            bestUci,
            lines,
            primaryLine: lines[1],
            partial: usedFallback || Object.keys(lines).length < job.multiPv,
            searchCompleted: true,
            hashMb,
            lane: laneName
          });
        } else {
          settle(job, null);
        }
        pump();
        return;
      }
      if (phase !== "searching" || !line.startsWith("info ") || /\b(?:lowerbound|upperbound)\b/.test(line)) return;
      const pvMatch = line.match(/\bpv\s+(.+)$/);
      const scoreMatch = line.match(/\bscore\s+(cp|mate)\s+(-?\d+)/);
      if (!pvMatch || !scoreMatch) return;
      const moves = pvMatch[1].trim().split(/\s+/).filter(m => UCI_MOVE.test(m));
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
        pvChain: moves.slice(0, 4).map(m => `${m.slice(0, 2)}\u2192${m.slice(2, 4)}${m[4] ? `=${m[4].toUpperCase()}` : ""}`).join(" \u2794 ")
      };
      while (activeJob.depthLines.size > 4) {
        activeJob.depthLines.delete(Math.min(...activeJob.depthLines.keys()));
      }
    }

    function initWorker() {
      if (!isEnabled()) return Promise.resolve(false);
      if (worker && ready) return Promise.resolve(true);
      if (initPromise) return initPromise;
      const token = generation;
      initPromise = new Promise(resolve => { initResolve = resolve; });
      initTimer = setTimeout(terminate, 15000);
      (async () => {
        try {
          const code = await getEngineSource();
          if (token !== generation || !isEnabled()) {
            if (token === generation) terminate();
            return;
          }
          blobUrl = URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
          const currentWorker = new Worker(blobUrl);
          worker = currentWorker;
          phase = "uci";
          currentWorker.onmessage = event => {
            if (worker !== currentWorker) return;
            try {
              const lines = Array.isArray(event.data) ? event.data : String(event.data || "").split(/\r?\n/);
              lines.forEach(line => handleLine(String(line)));
            } catch (e) {
              terminate();
            }
          };
          currentWorker.onerror = currentWorker.onmessageerror = () => {
            if (worker === currentWorker) terminate();
          };
          worker.postMessage("uci");
        } catch (e) {
          if (token === generation) terminate();
        }
      })();
      return initPromise;
    }

    function analyze(fen, movetimeMs = 190, multiPv = 3, uciMoves = [], useStartposMoves = false, meta = null) {
      if (!isEnabled() || typeof fen !== "string" || !fen.trim() || /[\r\n]/.test(fen)) return Promise.resolve(null);
      return new Promise(resolve => {
        settle(pendingJob, null);
        const moves = Array.isArray(uciMoves) ? uciMoves.slice() : [];
        pendingJob = {
          fen,
          movetimeMs: Math.max(20, Math.min(getLegacyResourceProfile().mobile ? getAndroidCapability().maxMovetimeMs : 10000, Number(movetimeMs) || 190)),
          multiPv: Math.max(1, Math.min(3, Number(multiPv) || 1)),
          uciMoves: moves,
          useStartposMoves: false,
          meta,
          depthLines: new Map(),
          resolve,
          settled: false,
          timer: null
        };
        stopActive();
        initWorker();
        pump();
      });
    }

    return { initWorker, analyze, cancel, terminate, isReady: () => ready, getHashMb: () => hashMb };
  }

  function getLegacyResourceProfile() {
    const androidCapability = getAndroidCapability();
    const memoryValue = Number(navigator.deviceMemory);
    const coresValue = Number(navigator.hardwareConcurrency);
    const memory = androidCapability.available ? androidCapability.memoryGb : Number.isFinite(memoryValue) ? memoryValue : null;
    const logicalCores = androidCapability.available ? androidCapability.logicalCores : Number.isFinite(coresValue) ? Math.max(1, Math.floor(coresValue)) : 2;
    const mobile = androidCapability.available || Boolean(navigator.userAgentData?.mobile) || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent || "");
    const detectedHashMb = androidCapability.available
      ? androidCapability.hashMiB
      : memory === null ? 64 : memory <= 2 ? 32 : memory <= 4 ? 64 : memory < 16 ? 128 : 256;
    const primaryHashMb = mobile ? Math.min(32, detectedHashMb) : detectedHashMb;
    const dualWorker = !mobile && memory !== null && memory >= 8 && logicalCores >= 6;
    const verifierHashMb = dualWorker ? 64 : 0;
    return {
      memoryGb: memory,
      logicalCores,
      mobile,
      dualWorker,
      primaryHashMb,
      verifierHashMb,
      totalHashMb: primaryHashMb + verifierHashMb
    };
  }

  function mergeLaneResults(primary, verifier, resources) {
    if (!primary && !verifier) return null;
    if (!primary) {
      return { ...verifier, workers: 1, coresUsed: 1, consensus: "verifier-only", resources };
    }
    if (!verifier || !verifier.lines?.[1]) {
      return { ...primary, workers: 1, coresUsed: 1, consensus: "primary-only", resources };
    }

    const primaryLine = primary.lines?.[1] || null;
    const verifierLines = Object.values(verifier.lines).filter(Boolean);
    const matchingVerifier = primaryLine
      ? verifierLines.find(line => line.uci === primaryLine.uci)
      : null;
    const ordered = [];
    if (primaryLine) {
      ordered.push(matchingVerifier
        ? { ...matchingVerifier, primaryDepth: primaryLine.depth, primaryNps: primaryLine.nps, primaryHashFull: primaryLine.hashFull }
        : primaryLine);
    }
    for (const line of verifierLines) {
      if (!ordered.some(existing => existing.uci === line.uci)) ordered.push(line);
      if (ordered.length >= 3) break;
    }
    const lines = Object.fromEntries(ordered.map((line, index) => [index + 1, line]));
    const verifierTop = verifier.lines[1];
    return {
      bestUci: primary.bestUci || lines[1]?.uci || null,
      lines,
      primaryLine,
      verifierLines: verifier.lines,
      hashMb: primary.hashMb + verifier.hashMb,
      primaryHashMb: primary.hashMb,
      verifierHashMb: verifier.hashMb,
      workers: 2,
      coresUsed: 2,
      consensus: matchingVerifier
        ? (verifierTop?.uci === primaryLine?.uci ? "strong" : "weak")
        : "split",
      resources
    };
  }

  function createLegacyEngine({ isEnabled = () => true } = {}) {
    const resources = getLegacyResourceProfile();
    const primary = createLane({ isEnabled, hashMb: resources.primaryHashMb, laneName: "primary" });
    const verifier = resources.dualWorker
      ? createLane({ isEnabled, hashMb: resources.verifierHashMb, laneName: "verifier" })
      : null;

    async function analyze(fen, movetimeMs = 190, multiPv = 3, uciMoves = [], useStartposMoves = false, meta = null) {
      const time = Math.max(20, Math.min(10000, Number(movetimeMs) || 190));
      const pageVisible = typeof document === "undefined" || document.visibilityState !== "hidden";
      const verifierNeeded = Boolean(meta?.engineMaxMode || meta?.isDangerPosition || meta?.criticalDecision);
      const useVerifier = Boolean(verifier && pageVisible && time >= 180 && verifierNeeded && meta?.performanceMode !== "critical");
      if (!useVerifier) {
        const primaryMultiPv = Math.max(1, Math.min(2, Number(multiPv) || 1));
        const result = await primary.analyze(fen, time, primaryMultiPv, uciMoves, useStartposMoves, meta);
        return result ? { ...result, workers: 1, coresUsed: 1, consensus: "primary-only", resources } : null;
      }

      const verifierTime = Math.max(150, Math.round(time * 0.75));
      const [primaryResult, verifierResult] = await Promise.all([
        primary.analyze(fen, time, 1, uciMoves, useStartposMoves, meta),
        verifier.analyze(fen, verifierTime, Math.max(2, Math.min(3, Number(multiPv) || 1)), uciMoves, useStartposMoves, meta)
      ]);
      return mergeLaneResults(primaryResult, verifierResult, resources);
    }

    function cancel() {
      primary.cancel();
      verifier?.cancel();
    }

    function terminate() {
      primary.terminate();
      verifier?.terminate();
    }

    return {
      initWorker: () => primary.initWorker(),
      analyze,
      cancel,
      terminate,
      isReady: () => primary.isReady(),
      getHashMb: () => resources.totalHashMb,
      getResourceProfile: () => ({ ...resources })
    };
  }

  function getPreferredResourceProfile() {
    const legacy = getLegacyResourceProfile();
    const androidCapability = getAndroidCapability();
    const fullEligible = (hasOwnedEngineHost() && !androidCapability.available ? false : androidCapability.available
      ? androidCapability.tier === "HIGH"
      : legacy.memoryGb !== null && legacy.memoryGb >= 8) &&
      Boolean(typeof chrome !== "undefined" && chrome.runtime?.sendMessage);
    if (!fullEligible) return { ...legacy, backend: LITE_BACKEND, fullNnue: false };
    const hashMb = androidCapability.available ? androidCapability.hashMiB : legacy.memoryGb >= 16 ? 64 : 32;
    return {
      memoryGb: legacy.memoryGb,
      logicalCores: legacy.logicalCores,
      mobile: legacy.mobile,
      dualWorker: false,
      primaryHashMb: hashMb,
      verifierHashMb: 0,
      totalHashMb: hashMb,
      backend: FULL_BACKEND,
      fullNnue: true
    };
  }

  function sendEngineMessage(message, timeoutMs = 55000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const error = new Error("Engine service timeout");
        error.code = "ENGINE_SERVICE_TIMEOUT";
        error.requestId = message.requestId;
        reject(error);
      }, timeoutMs);
      try {
        chrome.runtime.sendMessage({ ...message, target: "background-engine" }, response => {
          const runtimeError = chrome.runtime.lastError;
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (runtimeError) {
            const error = new Error(runtimeError.message);
            error.code = runtimeError.code;
            reject(error);
            return;
          }
          resolve(response || { ok: false, code: "EMPTY_ENGINE_RESPONSE" });
        });
      } catch (error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  function createOwnedEngine({ isEnabled }) {
    const instanceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
    let requestSequence = 0;
    let generation = 0;
    let activeRequestId = null;
    let readyBackend = null;
    let initPromise = null;
    let fullRetryAt = 0;
    let releasePromise = null;
    let dispatchPromise = Promise.resolve(null);
    let resolveDispatch = null;
    let activeMeta = null;

    function currentResources() {
      const preferred = getPreferredResourceProfile();
      return preferred.fullNnue && Date.now() < fullRetryAt
        ? { ...preferred, backend: LITE_BACKEND, fullNnue: false }
        : preferred;
    }

    function send(type, payload = {}, timeoutMs = 65000) {
      const requestId = `${instanceId}:${type.toLowerCase()}:${++requestSequence}`;
      return { requestId, promise: sendEngineMessage({ type, requestId, clientInstanceId: instanceId, ...payload }, timeoutMs) };
    }

    function usable() {
      return isEnabled() && !window.__CC_ANDROID_RUNTIME__?.disposed && document.visibilityState !== "hidden";
    }

    async function initWorker() {
      if (!usable()) return false;
      if (readyBackend === currentResources().backend) return true;
      if (initPromise) return initPromise;
      ownedEngines.add(handle);
      const token = generation;
      const resources = currentResources();
      const pending = (async () => {
        if (releasePromise) await releasePromise;
        if (token !== generation || !usable()) return false;
        try {
          const { promise } = send("ENGINE_INIT", { backend: resources.backend, hashMb: resources.primaryHashMb });
          const response = await promise;
          if (token !== generation) return false;
          if (!response?.ok || response.status?.ready === false) {
            if (resources.fullNnue) fullRetryAt = Date.now() + 5000;
            return false;
          }
          readyBackend = response.backend || resources.backend;
          return true;
        } catch (error) {
          if (token === generation && resources.fullNnue) fullRetryAt = Date.now() + 5000;
          return false;
        }
      })();
      initPromise = pending;
      try { return await pending; } finally {
        if (initPromise === pending) initPromise = null;
      }
    }

    async function analyze(fen, movetimeMs = 190, multiPv = 3, uciMoves = [], useStartposMoves = false, meta = null) {
      resolveDispatch?.(null);
      let dispatched;
      dispatchPromise = new Promise(resolve => { dispatched = resolve; });
      resolveDispatch = dispatched;
      let token = generation;
      let resources = null;
      let requestId = null;
      try {
        if (!usable() || typeof fen !== "string" || !fen.trim() || /[\r\n]/.test(fen)) return null;
        ownedEngines.add(handle);
        token = ++generation;
        const effectiveMeta = { ...(meta || {}), performanceMode: meta?.performanceMode || "normal" };
        activeMeta = effectiveMeta;
        if (releasePromise) await releasePromise;
        if (token !== generation || !usable()) return null;
        resources = currentResources();
        const time = Math.max(20, Math.min(getAndroidCapability().maxMovetimeMs, Number(movetimeMs) || 190));
        const sent = send("ENGINE_ANALYZE", {
          backend: resources.backend, fen, movetimeMs: Math.round(time),
          multiPv: Math.max(1, Math.min(2, Math.floor(Number(multiPv) || 1))),
          uciMoves: [], useStartposMoves: false, hashMb: resources.primaryHashMb, meta: effectiveMeta
        });
        requestId = sent.requestId;
        activeRequestId = requestId;
        dispatched({ requestId });
        if (resolveDispatch === dispatched) resolveDispatch = null;
        const promise = sent.promise;
        const response = await promise;
        if (token !== generation) return null;
        if (response?.ok && response.result?.searchCompleted === true && UCI_MOVE.test(response.result.bestUci || "") && response.result.lines?.[1]?.uci === response.result.bestUci) {
          readyBackend = response.backend || resources.backend;
          return { ...response.result, backend: readyBackend, resources: response.result.resources || resources, meta: effectiveMeta };
        }
        if (!["CANCELLED", "SUPERSEDED", "RELEASED", "ENGINE_SUSPENDED", "PROFILE_CHANGED"].includes(response?.code)) {
          readyBackend = null;
          if (resources.fullNnue) fullRetryAt = Date.now() + 5000;
        }
        return null;
      } catch (error) {
        if (token !== generation) return null;
        readyBackend = null;
        if (resources?.fullNnue && error.code !== "ENGINE_SUSPENDED") fullRetryAt = Date.now() + 5000;
        if (requestId) void send("ENGINE_CANCEL", { meta: activeMeta }, 5000).promise.catch(() => {});
        return null;
      } finally {
        dispatched(null);
        if (resolveDispatch === dispatched) resolveDispatch = null;
        if (activeRequestId === requestId) activeRequestId = null;
      }
    }

    function cancel() {
      generation++;
      resolveDispatch?.(null);
      resolveDispatch = null;
      if (activeRequestId || activeMeta) void send("ENGINE_CANCEL", { meta: activeMeta, cancelAnalysis: true }, 5000).promise.catch(() => {});
      activeRequestId = null;
    }

    function terminate() {
      if (!ownedEngines.has(handle) && !readyBackend && !activeRequestId && !initPromise) return;
      generation++;
      activeRequestId = null;
      readyBackend = null;
      initPromise = null;
      fullRetryAt = 0;
      ownedEngines.delete(handle);
      resolveDispatch?.(null);
      resolveDispatch = null;
      const releasing = send("ENGINE_RELEASE", { meta: activeMeta, cancelAnalysis: true }, 5000).promise.catch(() => {});
      activeMeta = null;
      releasePromise = releasing;
      releasing.finally(() => { if (releasePromise === releasing) releasePromise = null; });
    }

    const handle = {
      initWorker, analyze, cancel, terminate,
      whenDispatched: () => dispatchPromise,
      isReady: () => readyBackend === currentResources().backend,
      getHashMb: () => currentResources().totalHashMb,
      getResourceProfile: () => ({ ...currentResources() })
    };
    return handle;
  }

  function create({ isEnabled = () => true } = {}) {
    if (hasOwnedEngineHost()) return createOwnedEngine({ isEnabled });
    const preferredResources = getPreferredResourceProfile();
    const fullEligible = preferredResources.fullNnue;
    const retryBaseMs = 5000;
    const retryMaxMs = 60000;
    const retryFailureCap = 5;
    const fullDrainGraceMs = 4000;
    const instanceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
    let requestSequence = 0;
    let generation = 0;
    let activeRequestId = null;
    let fullReady = false;
    let fullFailureCount = 0;
    let fullRetryAt = 0;
    let fullDrainUntil = 0;
    let legacyEngine = null;

    function getLegacy() {
      if (!legacyEngine) legacyEngine = createLegacyEngine({ isEnabled });
      return legacyEngine;
    }

    function nextRequestId(prefix) {
      return `${instanceId}:${prefix}:${++requestSequence}`;
    }

    function sendInstanceMessage(message, timeoutMs) {
      return sendEngineMessage({ ...message, clientInstanceId: instanceId }, timeoutMs);
    }

    function canAttemptFull() {
      return fullEligible && Date.now() >= fullRetryAt;
    }

    function canStartLegacy() {
      return Date.now() >= fullDrainUntil;
    }

    function recordFullSuccess() {
      fullFailureCount = 0;
      fullRetryAt = 0;
      fullDrainUntil = 0;
      fullReady = true;
    }

    function recordFullFailure() {
      fullFailureCount = Math.min(retryFailureCap, fullFailureCount + 1);
      const cooldownMs = Math.min(retryMaxMs, retryBaseMs * (2 ** (fullFailureCount - 1)));
      fullRetryAt = Date.now() + cooldownMs;
      fullReady = false;
    }

    function stopLegacyBeforeFull() {
      if (!legacyEngine) return;
      legacyEngine.terminate();
      legacyEngine = null;
    }

    function isUsableResult(result) {
      return Boolean(
        result && result.searchCompleted !== false && UCI_MOVE.test(result.bestUci || "") &&
        result.lines?.[1]?.uci === result.bestUci
      );
    }

    async function abortTimedOutFull(type = "ENGINE_CANCEL") {
      fullDrainUntil = Math.max(fullDrainUntil, Date.now() + fullDrainGraceMs);
      try {
        await sendInstanceMessage({ type, requestId: nextRequestId(type === "ENGINE_RELEASE" ? "release" : "cancel") }, 5000);
      } catch (e) {}
      fullDrainUntil = Math.max(fullDrainUntil, Date.now() + fullDrainGraceMs);
    }

    async function initWorker() {
      if (!isEnabled()) return false;
      performanceGovernor.start();
      if (!fullEligible || !canAttemptFull()) {
        return canStartLegacy() ? getLegacy().initWorker() : false;
      }
      stopLegacyBeforeFull();
      const token = generation;
      const requestId = nextRequestId("init");
      try {
        const response = await sendInstanceMessage({
          type: "ENGINE_INIT",
          requestId,
          hashMb: preferredResources.primaryHashMb
        });
        if (token !== generation) return false;
        if (!response?.ok) {
          recordFullFailure();
          return canStartLegacy() ? getLegacy().initWorker() : false;
        }
        recordFullSuccess();
        return true;
      } catch (error) {
        if (token !== generation) return false;
        recordFullFailure();
        await abortTimedOutFull("ENGINE_RELEASE");
        return false;
      }
    }

    async function analyze(fen, movetimeMs = 190, multiPv = 3, uciMoves = [], useStartposMoves = false, meta = null) {
      if (!isEnabled() || typeof fen !== "string" || !fen.trim() || /[\r\n]/.test(fen)) return null;
      performanceGovernor.start();
      const token = ++generation;
      const moves = Array.isArray(uciMoves) ? uciMoves.slice() : [];
      const time = Math.max(20, Math.min(preferredResources.mobile ? getAndroidCapability().maxMovetimeMs : 10000, Number(movetimeMs) || 190));
      const requestedMultiPv = Math.max(1, Math.min(3, Number(multiPv) || 1));
      const eloValue = meta?.elo;
      const rawElo = Number(eloValue);
      const hasElo = eloValue !== null && eloValue !== undefined && eloValue !== "" && Number.isFinite(rawElo);
      const effectiveMeta = {
        ...(meta || {}),
        elo: hasElo ? Math.max(400, Math.min(3000, Math.round(rawElo))) : null,
        engineMaxMode: Boolean(meta?.engineMaxMode || meta?.engineMax),
        performanceMode: performanceGovernor.getMode()
      };
      if (canAttemptFull()) {
        stopLegacyBeforeFull();
        const requestId = nextRequestId("analyze");
        activeRequestId = requestId;
        let response;
        try {
          response = await sendInstanceMessage({
            type: "ENGINE_ANALYZE",
            requestId,
            fen,
            movetimeMs: time,
            multiPv: requestedMultiPv,
            uciMoves: [],
            useStartposMoves: false,
            hashMb: preferredResources.primaryHashMb,
            meta: effectiveMeta
          }, Math.max(65000, time + 55000));
          if (token !== generation) return null;
        } catch (error) {
          if (token !== generation) return null;
          if (activeRequestId === requestId) activeRequestId = null;
          recordFullFailure();
          await abortTimedOutFull("ENGINE_CANCEL");
          return null;
        }
        if (activeRequestId === requestId) activeRequestId = null;
        if (response?.ok && isUsableResult(response.result)) {
          recordFullSuccess();
          return {
            ...response.result,
            backend: response.backend || preferredResources.backend,
            resources: response.result.resources || preferredResources,
            meta: effectiveMeta
          };
        }
        if (["CANCELLED", "SUPERSEDED", "RELEASED"].includes(response?.code)) return null;
        recordFullFailure();
        if (["ENGINE_TIMEOUT", "EMPTY_ENGINE_RESPONSE", "EMPTY_OFFSCREEN_RESPONSE", "OFFSCREEN_MESSAGE_FAILED"].includes(response?.code)) {
          await abortTimedOutFull("ENGINE_CANCEL");
          return null;
        }
      }

      if (!canStartLegacy()) return null;
      const result = await getLegacy().analyze(fen, time, requestedMultiPv, moves, false, effectiveMeta);
      if (token !== generation) return null;
      return isUsableResult(result) ? { ...result, backend: "stockfish-19-lite-asm", meta: effectiveMeta } : null;
    }

    function cancel() {
      generation++;
      const hadActiveFullRequest = Boolean(activeRequestId);
      activeRequestId = null;
      if (fullEligible && hadActiveFullRequest) {
        fullDrainUntil = Math.max(fullDrainUntil, Date.now() + fullDrainGraceMs);
        void sendInstanceMessage({ type: "ENGINE_CANCEL", requestId: nextRequestId("cancel") }, 5000).catch(() => {});
      }
      legacyEngine?.cancel();
    }

    function terminate() {
      generation++;
      const hadActiveFullRequest = Boolean(activeRequestId);
      activeRequestId = null;
      if (fullEligible) {
        if (hadActiveFullRequest) fullDrainUntil = Math.max(fullDrainUntil, Date.now() + fullDrainGraceMs);
        void sendInstanceMessage({ type: "ENGINE_RELEASE", requestId: nextRequestId("release") }, 5000).catch(() => {});
      }
      legacyEngine?.terminate();
      legacyEngine = null;
      fullReady = false;
      performanceGovernor.destroy();
    }

    function prefersFullNow() {
      return fullEligible && Date.now() >= fullRetryAt;
    }

    return {
      initWorker,
      analyze,
      cancel,
      terminate,
      isReady: () => fullReady || Boolean(legacyEngine?.isReady()),
      getHashMb: () => prefersFullNow() ? preferredResources.totalHashMb : getLegacyResourceProfile().totalHashMb,
      getResourceProfile: () => prefersFullNow()
        ? { ...preferredResources }
        : { ...getLegacyResourceProfile(), backend: "stockfish-19-lite-asm", fullNnue: false }
    };
  }

  window.ChessCoachEngine = {
    __ccLifecycleVersion: 1,
    create,
    revive: () => performanceGovernor.start(),
    getResourceProfile: getPreferredResourceProfile,
    getPerformanceMode: () => performanceGovernor.getMode(),
    getPerformanceSnapshot: () => performanceGovernor.getSnapshot()
  };
})();
