let experienceDB = {};
let totalLearnedGames = 0;
const transpositionTable = new Map();
const TT_MAX_ENTRIES = 260000;
const cloudCache = new Map();
const syzygyCache = new Map();
const cloudNegativeCache = new Map();
const syzygyNegativeCache = new Map();
const REMOTE_CACHE_MAX_ENTRIES = 2000;
const NEGATIVE_CACHE_MAX_ENTRIES = 256;
const killerMoves = Array.from({ length: 16 }, () => [null, null]);
let localEcoBook = null;

try {
  if (typeof importScripts === "function" && chrome.runtime?.getURL) {
    importScripts(chrome.runtime.getURL("data/eco-book.js"));
    localEcoBook = globalThis.CHESSCOACH_ECO_BOOK || null;
    try { delete globalThis.CHESSCOACH_ECO_BOOK; } catch (e) {}
  }
} catch (e) {
  localEcoBook = null;
}

function getLocalEcoBookMoves(uciHistory, historyTrusted) {
  if (!historyTrusted || !localEcoBook?.positions || !Array.isArray(uciHistory)) return [];
  if (uciHistory.length > Number(localEcoBook.maxPly || 20)) return [];
  if (!uciHistory.every(move => /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move))) return [];
  const entries = localEcoBook.positions[uciHistory.join(" ")];
  if (!Array.isArray(entries)) return [];
  return entries.slice(0, 5).map(([uci, support, eco, nameId]) => ({
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promo: uci[4] || null,
    bonus: Math.min(110, 20 + Math.round(Math.log2(Math.max(1, support) + 1) * 8)),
    name: uciHistory.length < 4
      ? `ECO LOCAL · ${Number(support) || 1} линий`
      : `${eco} · ${localEcoBook.names?.[nameId] || "ECO"}`,
    support: Number(support) || 1,
    source: "eco-local"
  }));
}

async function syncRoomBeacon(roomId, myColor, style, elo, autoMove) {
  // Public unauthenticated topics leak room activity and can be spoofed.
  // Keep the established response shape while disabling all network traffic.
  return { detected: false, disabled: true };
}

const analyzedStateByClient = new Map();
const latestAnalysisMetaByClient = new Map();
const stockfishWorkByPosition = new Map();
const pendingMobileAnalysis = new Map();
const activeMobileAnalysis = new Map();
const mobileAnalysisCache = new Map();
const cancelledMobileGeneration = new Map();

function createAnalyzedState() {
  return {
    board: null,
    boardHash: "",
    turn: null,
    pureBestScoreForWhite: 0,
    prevTurnScoreForWhite: 0,
    lastDropPawns: 0
  };
}

const ENGINE_UCI_MOVE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const ENGINE_BACKENDS = new Set(["stockfish-19-full-single-wasm", "stockfish-19-lite-asm"]);
const OFFSCREEN_URL = "offscreen/offscreen.html";
let creatingOffscreenDocument = null;
let closingOffscreenDocument = null;
let engineActivityEpoch = 0;
const engineCancellationByClient = new Map();

const SEARCH_INTERRUPTED = Object.freeze({ message: "Local search budget exhausted" });
const SEARCH_SUPERSEDED = Object.freeze({ message: "Obsolete analysis", code: "SUPERSEDED" });

function isAnalysisGenerationCurrent(meta, contextKey) {
  const cancelled = cancelledMobileGeneration.get(contextKey);
  if (meta && cancelled && meta.sessionId === cancelled.sessionId &&
      (Number(meta.positionId) < Number(cancelled.positionId) ||
       (Number(meta.positionId) === Number(cancelled.positionId) && Number(meta.analysisId) <= Number(cancelled.analysisId)))) return false;
  const latest = latestAnalysisMetaByClient.get(contextKey);
  if (!meta || !latest) return true;
  return meta.sessionId === latest.sessionId && (
    Number(meta.positionId) > Number(latest.positionId) ||
    (meta.positionId === latest.positionId && Number(meta.analysisId) >= Number(latest.analysisId))
  );
}

function analysisContextKey(sender, meta) {
  const raw = String(meta?.sessionId || "legacy");
  const session = /^[a-z0-9:._-]{1,96}$/i.test(raw) ? raw : "legacy";
  return `${sender?.tab?.id ?? sender?.origin ?? sender?.url ?? "unknown"}:${sender?.frameId ?? 0}:${session}`;
}

function ownedAnnotationCurrent(meta, fen, contextKey) {
  const work = stockfishWorkByPosition.get(`${meta?.sessionId || ""}|${meta?.positionId ?? ""}|${fen}`);
  return Boolean(work?.expiresAt > Date.now() && work.requestId === meta?.ownedEngineRequestId &&
    work.analysisId === meta?.analysisId && work.contextKey === contextKey &&
    work.lifecycleEpoch === globalThis.__CC_ENGINE_RUNTIME__?.lifecycleEpoch &&
    (engineCancellationByClient.get(work.clientKey)?.epoch || 0) === work.clientEpoch);
}

function mobileAnalysisKey(request, contextKey) {
  const profile = globalThis.__CC_DEVICE_PROFILE__;
  const power = profile?.power || {};
  const tier = power.saveMode || power.backgroundRestricted || Number(power.thermalStatus) >= 2
    ? "LOW" : profile?.recommendation?.tier || "BALANCED";
  return JSON.stringify([contextKey, request.fen, request.elo, request.style, request.pass,
    request.calcAverage !== false, request.calcWorst !== false, request.bulletTurbo === true,
    request.myColor || "w", request.mySeconds ?? 999, request.enemySeconds ?? 999,
    request.trapRadarEnabled !== false, request.lastEnemyMove || null, request.lastOurMove || null,
    request.recentPositions || [], request.uciHistory || [], request.historyTrusted === true,
    request.meta?.annotationOnly === true, tier, profile?.recommendation?.movetimeScale || 1]);
}

function queueMobileAnalysis(request, sender, contextKey, run, sendResponse) {
  const previous = pendingMobileAnalysis.get(contextKey);
  if (previous) {
    clearTimeout(previous.timer);
    previous.finish({ error: "Obsolete analysis", code: "SUPERSEDED", status: "error" });
  }
  activeMobileAnalysis.get(contextKey)?.controller.abort();
  const controller = new AbortController();
  const runtimeEpoch = globalThis.__CC_ENGINE_RUNTIME__?.lifecycleEpoch;
  const cacheKey = mobileAnalysisKey(request, contextKey);
  const job = {
    sender, meta: request.meta, controller, timer: null, settled: false,
    finish(payload) {
      if (job.settled) return;
      job.settled = true;
      clearTimeout(job.timer);
      if (pendingMobileAnalysis.get(contextKey) === job) pendingMobileAnalysis.delete(contextKey);
      try { sendResponse({ ...payload, meta: request.meta || null }); } catch (_) {}
    }
  };
  pendingMobileAnalysis.set(contextKey, job);
  while (pendingMobileAnalysis.size > 32) {
    const oldest = pendingMobileAnalysis.values().next().value;
    oldest.finish({ error: "Analysis queue is full", code: "SUPERSEDED", status: "error" });
  }
  // Let queued native tasks replace obsolete generations before any root work.
  job.timer = setTimeout(async () => {
    if (job.settled) return;
    pendingMobileAnalysis.delete(contextKey);
    activeMobileAnalysis.set(contextKey, job);
    try {
      const runtime = globalThis.__CC_ENGINE_RUNTIME__;
      if (runtime?.suspended || runtime?.lifecycleEpoch !== runtimeEpoch ||
          !isAnalysisGenerationCurrent(request.meta, contextKey) || controller.signal.aborted) throw SEARCH_SUPERSEDED;
      if (request.meta?.annotationOnly === true && !ownedAnnotationCurrent(request.meta, request.fen, contextKey)) throw SEARCH_SUPERSEDED;
      const cached = mobileAnalysisCache.get(cacheKey);
      if (cached) {
        const result = JSON.parse(cached);
        result.search = { ...result.search, cached: true, nodes: 0, elapsedMs: 0 };
        job.finish({ ...result, status: result.best ? "ok" : "terminal" });
        return;
      }
      const result = await run(controller.signal);
      if (controller.signal.aborted || !isAnalysisGenerationCurrent(request.meta, contextKey)) throw SEARCH_SUPERSEDED;
      if (result?.best && result.search?.interrupted === false &&
          (result.search.annotationOnly || !result.analysisIncomplete)) {
        const encoded = JSON.stringify({ ...result, meta: null });
        if (encoded.length <= 64000) setBoundedCacheEntry(mobileAnalysisCache, cacheKey, encoded, 32);
      }
      job.finish({ ...result, status: result?.best ? "ok" : "terminal" });
    } catch (error) {
      job.finish({ error: error.message, code: error.code || "ANALYSIS_FAILED", status: "error" });
    } finally {
      if (activeMobileAnalysis.get(contextKey) === job) activeMobileAnalysis.delete(contextKey);
    }
  }, request.bulletTurbo ? 4 : 20);
}

function cancelMobileAnalysis(sender, meta) {
  const contextKey = analysisContextKey(sender, meta);
  const latest = latestAnalysisMetaByClient.get(contextKey) || meta;
  if (latest) setBoundedCacheEntry(cancelledMobileGeneration, contextKey, { ...latest }, 32);
  const matches = (key, job) => key === contextKey || (meta?.sessionId && job.meta?.sessionId === meta.sessionId &&
    job.sender?.origin === sender?.origin && (job.sender?.frameId || 0) === (sender?.frameId || 0));
  for (const [key, job] of pendingMobileAnalysis) {
    if (matches(key, job)) job.finish({ error: "Analysis cancelled", code: "CANCELLED", status: "error" });
  }
  for (const [key, job] of activeMobileAnalysis) if (matches(key, job)) job.controller.abort();
}

function searchNow() {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

function createSearchBudget(timeBudgetMs, nodeLimit) {
  const startedAt = searchNow();
  return {
    startedAt,
    lastNow: startedAt,
    deadline: startedAt + timeBudgetMs,
    timeBudgetMs,
    nodeLimit,
    nodes: 0,
    interrupted: false,
    lifecycleEpoch: globalThis.__CC_ENGINE_RUNTIME__?.lifecycleEpoch
  };
}

function checkSearchBudget(budget) {
  if (!budget) return;
  if (budget.isCurrent && !budget.isCurrent()) throw SEARCH_SUPERSEDED;
  budget.lastNow = Math.max(budget.lastNow, searchNow());
  const runtime = globalThis.__CC_ENGINE_RUNTIME__;
  if (budget.interrupted || budget.nodes >= budget.nodeLimit || budget.lastNow >= budget.deadline || (runtime && (runtime.suspended || runtime.lifecycleEpoch !== budget.lifecycleEpoch))) {
    budget.interrupted = true;
    throw SEARCH_INTERRUPTED;
  }
  // Count tactical branch work as well as recursive PV nodes.
  budget.nodes++;
}

function searchStats(budget) {
  return { nodes: budget.nodes, nodeLimit: budget.nodeLimit, timeBudgetMs: budget.timeBudgetMs, elapsedMs: Math.max(0, Math.round(searchNow() - budget.startedAt)), interrupted: budget.interrupted };
}

function validateEngineFen(fen) {
  if (typeof fen !== "string" || fen.length > 128 || /[\r\n\0-\x08\x0B\x0C\x0E-\x1F]/.test(fen)) return false;
  const fields = fen.trim().split(/\s+/);
  if (fields.length !== 6) return false;
  const rows = fields[0].split("/");
  if (rows.length !== 8) return false;
  for (const row of rows) {
    let squares = 0;
    for (const char of row) {
      if (/[1-8]/.test(char)) squares += Number(char);
      else if (/[prnbqkPRNBQK]/.test(char)) squares++;
      else return false;
    }
    if (squares !== 8) return false;
  }
  return /^[wb]$/.test(fields[1]) && /^(?:-|[KQkq]{1,4})$/.test(fields[2]) &&
    /^(?:-|[a-h][36])$/.test(fields[3]) && /^\d+$/.test(fields[4]) && /^[1-9]\d*$/.test(fields[5]);
}

function validateEnginePayload(request) {
  if (!validateEngineFen(request.fen)) return "INVALID_FEN";
  if (
    request.useStartposMoves &&
    (!Array.isArray(request.uciMoves) || request.uciMoves.length > 1024 || !request.uciMoves.every(move => ENGINE_UCI_MOVE.test(move)))
  ) return "INVALID_HISTORY";
  const movetimeMs = Number(request.movetimeMs);
  const multiPv = Number(request.multiPv);
  if (!Number.isFinite(movetimeMs) || movetimeMs < 20 || movetimeMs > 10000) return "INVALID_MOVETIME";
  if (!Number.isInteger(multiPv) || multiPv < 1 || multiPv > 3) return "INVALID_MULTIPV";
  return null;
}

async function hasOffscreenDocument() {
  if (!chrome.runtime.getContexts) return false;
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType?.OFFSCREEN_DOCUMENT || "OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });
  return contexts.length > 0;
}

function ensureOffscreenDocument() {
  if (!chrome.offscreen?.createDocument) return Promise.reject(new Error("Offscreen API unavailable"));
  if (creatingOffscreenDocument) return creatingOffscreenDocument;
  creatingOffscreenDocument = (async () => {
    if (closingOffscreenDocument) {
      try { await closingOffscreenDocument; } catch (e) {}
    }
    if (await hasOffscreenDocument()) return true;
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason?.WORKERS || "WORKERS"],
      justification: "Runs the packaged full-NNUE Stockfish worker for local chess analysis"
    });
    return true;
  })().finally(() => { creatingOffscreenDocument = null; });
  return creatingOffscreenDocument;
}

function forwardToOffscreen(message, sendResponse) {
  chrome.runtime.sendMessage({ ...message, target: "offscreen-engine" }, response => {
    if (chrome.runtime.lastError) {
      sendResponse({ ok: false, requestId: message.requestId, code: "OFFSCREEN_MESSAGE_FAILED", error: chrome.runtime.lastError.message });
      return;
    }
    sendResponse(response || { ok: false, requestId: message.requestId, code: "EMPTY_OFFSCREEN_RESPONSE" });
  });
}

function handleEngineMessage(request, sender, sendResponse) {
  const requestId = String(request.requestId || "");
  const rawClientInstanceId = String(request.clientInstanceId || "legacy");
  const clientInstanceId = /^[a-z0-9-]{6,64}$/i.test(rawClientInstanceId) ? rawClientInstanceId : "legacy";
  const clientKey = `${sender?.tab?.id ?? "extension"}:${sender?.frameId ?? 0}:${clientInstanceId}`;
  const type = request.type;
  if (request.backend !== undefined && !ENGINE_BACKENDS.has(request.backend)) {
    sendResponse({ ok: false, requestId, code: "INVALID_BACKEND" });
    return false;
  }
  engineActivityEpoch++;
  const runtimeEpoch = globalThis.__CC_ENGINE_RUNTIME__?.lifecycleEpoch;
  let clientEpoch = engineCancellationByClient.get(clientKey)?.epoch || 0;
  if (type === "ENGINE_CANCEL" || type === "ENGINE_RELEASE") {
    clientEpoch++;
    setBoundedCacheEntry(engineCancellationByClient, clientKey, { epoch: clientEpoch, code: type === "ENGINE_RELEASE" ? "RELEASED" : "CANCELLED" }, 128);
    for (const [key, work] of stockfishWorkByPosition) {
      if (work.clientKey === clientKey) stockfishWorkByPosition.delete(key);
    }
    if (request.cancelAnalysis) cancelMobileAnalysis(sender, request.meta);
  }
  const canForward = () => {
    const runtime = globalThis.__CC_ENGINE_RUNTIME__;
    return (!runtime || (!runtime.suspended && runtime.lifecycleEpoch === runtimeEpoch)) && (engineCancellationByClient.get(clientKey)?.epoch || 0) === clientEpoch;
  };
  if (type === "ENGINE_ANALYZE") {
    const validationError = validateEnginePayload(request);
    if (validationError) {
      sendResponse({ ok: false, requestId, code: validationError });
      return false;
    }
  }
  const message = {
    type,
    backend: request.backend || "stockfish-19-full-single-wasm",
    requestId,
    clientKey,
    fen: request.fen,
    movetimeMs: Math.max(20, Math.min(10000, Number(request.movetimeMs) || 190)),
    multiPv: Math.max(1, Math.min(3, Number(request.multiPv) || 1)),
    uciMoves: Array.isArray(request.uciMoves) ? request.uciMoves.slice() : [],
    useStartposMoves: Boolean(request.useStartposMoves),
    hashMb: Math.max(16, Math.min(128, Number(request.hashMb) || 64)),
    meta: request.meta || null
  };
  if (["ENGINE_CANCEL", "ENGINE_RELEASE", "ENGINE_STATUS"].includes(type)) {
    hasOffscreenDocument().then(exists => {
      if (!canForward()) {
        sendResponse({ ok: true, requestId, cancelled: true });
        return;
      }
      if (!exists) {
        sendResponse({ ok: type !== "ENGINE_STATUS", requestId, code: "OFFSCREEN_NOT_RUNNING", status: { ready: false } });
        return;
      }
      forwardToOffscreen(message, sendResponse);
    }).catch(error => sendResponse({ ok: false, requestId, code: "OFFSCREEN_LOOKUP_FAILED", error: String(error?.message || error) }));
    return true;
  }
  const positionKey = `${request.meta?.sessionId || ""}|${request.meta?.positionId ?? ""}|${request.fen || ""}`;
  const engineWork = {
    expiresAt: Date.now() + 10000, requestId, analysisId: request.meta?.analysisId, clientKey, clientEpoch,
    contextKey: analysisContextKey(sender, request.meta),
    lifecycleEpoch: runtimeEpoch
  };
  if (type === "ENGINE_ANALYZE") setBoundedCacheEntry(stockfishWorkByPosition, positionKey, engineWork, 32);
  const respond = payload => {
    if (type === "ENGINE_ANALYZE" && stockfishWorkByPosition.get(positionKey) === engineWork && (!payload?.ok || payload.result?.searchCompleted !== true)) {
      stockfishWorkByPosition.delete(positionKey);
    }
    sendResponse(payload);
  };
  ensureOffscreenDocument().then(() => {
    if (!canForward()) {
      respond({ ok: false, requestId, code: engineCancellationByClient.get(clientKey)?.code || "ENGINE_SUSPENDED" });
      return;
    }
    forwardToOffscreen(message, respond);
  }).catch(error => {
    stockfishWorkByPosition.delete(positionKey);
    sendResponse({ ok: false, requestId, code: "OFFSCREEN_CREATE_FAILED", error: String(error?.message || error) });
  });
  return true;
}

function handleOffscreenIdle(sender, sendResponse) {
  if (sender?.url !== chrome.runtime.getURL(OFFSCREEN_URL)) {
    sendResponse({ ok: false, code: "INVALID_OFFSCREEN_SENDER" });
    return false;
  }
  const epoch = engineActivityEpoch;
  chrome.runtime.sendMessage({ target: "offscreen-engine", type: "ENGINE_STATUS", requestId: `idle-${Date.now()}`, clientKey: "background-idle" }, statusResponse => {
    if (chrome.runtime.lastError || !statusResponse?.ok || statusResponse.status?.busy || statusResponse.status?.queueLength > 0 || epoch !== engineActivityEpoch) {
      sendResponse({ ok: true, closed: false });
      return;
    }
    if (!closingOffscreenDocument) {
      closingOffscreenDocument = chrome.offscreen.closeDocument()
        .finally(() => { closingOffscreenDocument = null; });
    }
    closingOffscreenDocument
      .then(() => sendResponse({ ok: true, closed: true }))
      .catch(error => sendResponse({ ok: false, code: "OFFSCREEN_CLOSE_FAILED", error: String(error?.message || error) }));
  });
  return true;
}

const EXPERIENCE_MAX_POSITIONS = 2500;
const EXPERIENCE_MAX_MOVES_PER_POSITION = 16;
const EXPERIENCE_MAX_ENTRY_GAMES = 1000000;
const EXPERIENCE_MAX_TOTAL_GAMES = 1000000000;
const EXPERIENCE_FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const EXPERIENCE_MESSAGE_TYPES = new Set([
  "RECORD_GAME_RESULT",
  "TRAIN_MOVE_MANUAL",
  "GET_MEMORY_STATS",
  "IMPORT_MEMORY",
  "CLEAR_MEMORY"
]);

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isValidExperiencePositionKey(fenKey) {
  if (
    typeof fenKey !== "string" ||
    fenKey.length < 3 ||
    fenKey.length > 128 ||
    fenKey !== fenKey.trim() ||
    /[\r\n\0-\x1F]/.test(fenKey) ||
    EXPERIENCE_FORBIDDEN_KEYS.has(fenKey)
  ) {
    return false;
  }
  const fieldCount = fenKey.split(/\s+/).length;
  if (fieldCount === 2) return validateEngineFen(`${fenKey} - - 0 1`);
  if (fieldCount === 4) return validateEngineFen(`${fenKey} 0 1`);
  return false;
}

function experienceEntryWeight(entry) {
  return Math.min(EXPERIENCE_MAX_ENTRY_GAMES, Number(entry?.games) || 0) * 10 + Math.abs(Number(entry?.bonus) || 0);
}

function enforceExperienceLimits(db, protectedKeys = new Set()) {
  for (const fenKey of Object.keys(db)) {
    const position = db[fenKey];
    const rankedMoves = Object.entries(position).sort((a, b) => experienceEntryWeight(b[1]) - experienceEntryWeight(a[1]));
    if (rankedMoves.length > EXPERIENCE_MAX_MOVES_PER_POSITION) {
      const trimmed = {};
      for (const [uci, entry] of rankedMoves.slice(0, EXPERIENCE_MAX_MOVES_PER_POSITION)) trimmed[uci] = entry;
      db[fenKey] = trimmed;
    }
  }

  const positionKeys = Object.keys(db);
  if (positionKeys.length > EXPERIENCE_MAX_POSITIONS) {
    positionKeys.sort((a, b) => {
      const protectedDelta = Number(protectedKeys.has(a)) - Number(protectedKeys.has(b));
      if (protectedDelta !== 0) return protectedDelta;
      const weightA = Object.values(db[a]).reduce((sum, entry) => sum + experienceEntryWeight(entry), 0);
      const weightB = Object.values(db[b]).reduce((sum, entry) => sum + experienceEntryWeight(entry), 0);
      return weightA - weightB;
    });
    const removeCount = positionKeys.length - EXPERIENCE_MAX_POSITIONS;
    for (let i = 0; i < removeCount; i++) delete db[positionKeys[i]];
  }
  return db;
}

function normalizeExperienceDB(raw, strict = false) {
  if (!isPlainRecord(raw)) {
    return strict
      ? { ok: false, code: "INVALID_IMPORT_SCHEMA", error: "Memory import must be an object" }
      : { ok: true, data: {} };
  }

  const positions = Object.entries(raw);
  if (strict && positions.length > EXPERIENCE_MAX_POSITIONS) {
    return { ok: false, code: "IMPORT_TOO_LARGE", error: `Memory import exceeds ${EXPERIENCE_MAX_POSITIONS} positions` };
  }

  const normalized = {};
  for (const [fenKey, rawPosition] of positions) {
    if (!isValidExperiencePositionKey(fenKey) || !isPlainRecord(rawPosition)) {
      if (strict) return { ok: false, code: "INVALID_IMPORT_SCHEMA", error: "Invalid position key or move map" };
      continue;
    }

    const moves = Object.entries(rawPosition);
    if (strict && moves.length > EXPERIENCE_MAX_MOVES_PER_POSITION) {
      return { ok: false, code: "IMPORT_TOO_LARGE", error: `Position exceeds ${EXPERIENCE_MAX_MOVES_PER_POSITION} moves` };
    }

    const normalizedPosition = {};
    for (const [uci, rawEntry] of moves) {
      const entryKeys = isPlainRecord(rawEntry) ? Object.keys(rawEntry) : [];
      const validEntry =
        ENGINE_UCI_MOVE.test(uci) &&
        !EXPERIENCE_FORBIDDEN_KEYS.has(uci) &&
        isPlainRecord(rawEntry) &&
        entryKeys.length === 2 &&
        entryKeys.includes("bonus") &&
        entryKeys.includes("games") &&
        typeof rawEntry.bonus === "number" &&
        Number.isFinite(rawEntry.bonus) &&
        rawEntry.bonus >= -250 &&
        rawEntry.bonus <= 180 &&
        Number.isInteger(rawEntry.games) &&
        rawEntry.games >= 0 &&
        rawEntry.games <= EXPERIENCE_MAX_ENTRY_GAMES;
      if (!validEntry) {
        if (strict) return { ok: false, code: "INVALID_IMPORT_SCHEMA", error: "Invalid move experience entry" };
        continue;
      }
      normalizedPosition[uci] = { bonus: rawEntry.bonus, games: rawEntry.games };
    }
    if (Object.keys(normalizedPosition).length > 0) normalized[fenKey] = normalizedPosition;
  }

  enforceExperienceLimits(normalized);
  return { ok: true, data: normalized };
}

function cloneExperienceDB(db = experienceDB) {
  const copy = {};
  for (const [fenKey, position] of Object.entries(db)) {
    const positionCopy = {};
    for (const [uci, entry] of Object.entries(position)) {
      positionCopy[uci] = { bonus: entry.bonus, games: entry.games };
    }
    copy[fenKey] = positionCopy;
  }
  return copy;
}

let experienceLoadError = null;
const experienceReady = new Promise((resolve) => {
  if (typeof chrome === "undefined" || !chrome.storage?.local) {
    resolve();
    return;
  }
  try {
    chrome.storage.local.get(["experienceDB", "totalLearnedGames"], (res) => {
      const lastError = chrome.runtime?.lastError;
      if (lastError) {
        experienceLoadError = String(lastError.message || lastError);
        resolve();
        return;
      }
      const normalized = normalizeExperienceDB(res?.experienceDB || {}, false);
      experienceDB = normalized.data;
      const storedGames = Number(res?.totalLearnedGames);
      if (Number.isSafeInteger(storedGames) && storedGames >= 0) {
        totalLearnedGames = Math.min(EXPERIENCE_MAX_TOTAL_GAMES, storedGames);
      }
      resolve();
    });
  } catch (error) {
    experienceLoadError = String(error?.message || error);
    resolve();
  }
});

let experienceSaveQueue = Promise.resolve();
let experienceOperationQueue = Promise.resolve();

function createStorageError(message) {
  const error = new Error(message || "Failed to persist memory");
  error.code = /quota|bytes_per_item|max_items/i.test(error.message)
    ? "STORAGE_QUOTA_EXCEEDED"
    : "STORAGE_WRITE_FAILED";
  return error;
}

function persistExperienceSnapshot(snapshot) {
  return new Promise((resolve, reject) => {
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      reject(createStorageError("Storage API unavailable"));
      return;
    }
    try {
      chrome.storage.local.set(snapshot, () => {
        const lastError = chrome.runtime?.lastError;
        if (lastError) reject(createStorageError(String(lastError.message || lastError)));
        else resolve();
      });
    } catch (error) {
      reject(createStorageError(String(error?.message || error)));
    }
  });
}

function saveExperienceDB() {
  const snapshot = {
    experienceDB: cloneExperienceDB(),
    totalLearnedGames
  };
  const operation = experienceSaveQueue.catch(() => undefined).then(() => persistExperienceSnapshot(snapshot));
  experienceSaveQueue = operation;
  return operation;
}

function experienceErrorResponse(error, extra = {}) {
  return {
    ok: false,
    code: error?.code || "MEMORY_OPERATION_FAILED",
    error: String(error?.message || error || "Memory operation failed"),
    ...extra
  };
}

async function handleExperienceMessage(request, sendResponse) {
  if (experienceLoadError) {
    const error = new Error(experienceLoadError);
    error.code = "STORAGE_READ_FAILED";
    sendResponse(experienceErrorResponse(error, {
      totalLearnedGames,
      positionsCount: Object.keys(experienceDB).length
    }));
    return;
  }
  if (request.type === "GET_MEMORY_STATS") {
    sendResponse({
      totalLearnedGames,
      positionsCount: Object.keys(experienceDB).length,
      experienceDB
    });
    return;
  }

  const previousDB = cloneExperienceDB();
  const previousTotalLearnedGames = totalLearnedGames;
  const restoreAfterFailure = (error, extra = {}) => {
    experienceDB = previousDB;
    totalLearnedGames = previousTotalLearnedGames;
    sendResponse(experienceErrorResponse(error, extra));
  };

  if (request.type === "RECORD_GAME_RESULT") {
    const { history, result } = request;
    if (Array.isArray(history) && history.length > 0) {
      totalLearnedGames = Math.min(EXPERIENCE_MAX_TOTAL_GAMES, totalLearnedGames + 1);
      const protectedKeys = new Set();
      const startIdx = Math.max(0, history.length - 10);
      for (let idx = startIdx; idx < history.length; idx++) {
        const item = history[idx];
        if (!item || !isValidExperiencePositionKey(item.fenKey) || !ENGINE_UCI_MOVE.test(String(item.uci || ""))) continue;
        const fenKey = item.fenKey;
        const uci = item.uci;
        protectedKeys.add(fenKey);
        if (!experienceDB[fenKey]) experienceDB[fenKey] = {};
        if (!experienceDB[fenKey][uci]) experienceDB[fenKey][uci] = { bonus: 0, games: 0 };
        const entry = experienceDB[fenKey][uci];
        entry.games = Math.min(EXPERIENCE_MAX_ENTRY_GAMES, entry.games + 1);
        if (result === "win") {
          entry.bonus = Math.min(65, entry.bonus + 15);
        } else if (result === "loss") {
          entry.bonus = idx >= history.length - 4
            ? Math.max(-160, entry.bonus - 55)
            : Math.max(-60, entry.bonus - 15);
        }
      }
      enforceExperienceLimits(experienceDB, protectedKeys);
      try {
        await saveExperienceDB();
      } catch (error) {
        restoreAfterFailure(error, {
          totalLearnedGames: previousTotalLearnedGames,
          positionsCount: Object.keys(previousDB).length
        });
        return;
      }
    }
    sendResponse({
      ok: true,
      totalLearnedGames,
      positionsCount: Object.keys(experienceDB).length
    });
    return;
  }

  if (request.type === "TRAIN_MOVE_MANUAL") {
    const { fenKey, uci } = request;
    const delta = Number(request.delta);
    if (fenKey && uci) {
      if (!isValidExperiencePositionKey(fenKey) || !ENGINE_UCI_MOVE.test(String(uci)) || !Number.isFinite(delta)) {
        sendResponse(experienceErrorResponse(new Error("Invalid training entry"), {
          positionsCount: Object.keys(experienceDB).length
        }));
        return;
      }
      if (!experienceDB[fenKey]) experienceDB[fenKey] = {};
      if (!experienceDB[fenKey][uci]) experienceDB[fenKey][uci] = { bonus: 0, games: 0 };
      experienceDB[fenKey][uci].bonus = Math.max(-250, Math.min(180, experienceDB[fenKey][uci].bonus + delta));
      experienceDB[fenKey][uci].games = Math.min(EXPERIENCE_MAX_ENTRY_GAMES, experienceDB[fenKey][uci].games + 1);
      enforceExperienceLimits(experienceDB, new Set([fenKey]));
      try {
        await saveExperienceDB();
      } catch (error) {
        restoreAfterFailure(error, { positionsCount: Object.keys(previousDB).length });
        return;
      }
    }
    sendResponse({ ok: true, positionsCount: Object.keys(experienceDB).length });
    return;
  }

  if (request.type === "IMPORT_MEMORY") {
    const normalized = normalizeExperienceDB(request.data, true);
    if (!normalized.ok) {
      sendResponse({
        ok: false,
        code: normalized.code,
        error: normalized.error,
        positionsCount: Object.keys(experienceDB).length
      });
      return;
    }
    const merged = cloneExperienceDB();
    for (const [fenKey, position] of Object.entries(normalized.data)) merged[fenKey] = position;
    experienceDB = enforceExperienceLimits(merged, new Set(Object.keys(normalized.data)));
    try {
      await saveExperienceDB();
    } catch (error) {
      restoreAfterFailure(error, { positionsCount: Object.keys(previousDB).length });
      return;
    }
    sendResponse({ ok: true, positionsCount: Object.keys(experienceDB).length });
    return;
  }

  if (request.type === "CLEAR_MEMORY") {
    experienceDB = {};
    totalLearnedGames = 0;
    transpositionTable.clear();
    cloudCache.clear();
    syzygyCache.clear();
    cloudNegativeCache.clear();
    syzygyNegativeCache.clear();
    analyzedStateByClient.clear();
    latestAnalysisMetaByClient.clear();
    for (const pair of killerMoves) pair.fill(null);
    cloudRetryAfter = 0;
    try {
      await saveExperienceDB();
    } catch (error) {
      restoreAfterFailure(error);
      return;
    }
    sendResponse({ ok: true });
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.target === "background-engine" && request?.type === "ENGINE_OFFSCREEN_IDLE") {
    return handleOffscreenIdle(sender, sendResponse);
  }
  if (request?.target === "background-engine" && /^ENGINE_(?:INIT|ANALYZE|CANCEL|RELEASE|STATUS)$/.test(request.type || "")) {
    return handleEngineMessage(request, sender, sendResponse);
  }
  if (EXPERIENCE_MESSAGE_TYPES.has(request?.type)) {
    experienceOperationQueue = experienceOperationQueue
      .catch(() => undefined)
      .then(() => experienceReady)
      .then(() => handleExperienceMessage(request, sendResponse))
      .catch((error) => sendResponse(experienceErrorResponse(error, {
        positionsCount: Object.keys(experienceDB).length
      })));
    return true;
  }
  if (request.type === "CHECK_PEER_BEACON") {
    syncRoomBeacon(request.roomId, request.myColor, request.style, request.elo, request.autoMove)
      .then((res) => sendResponse(res))
      .catch(() => sendResponse({ detected: false }));
    return true;
  }

  if (request.type === "ANALYZE_POSITION") {
    if (!validateEngineFen(request.fen)) {
      sendResponse({ error: "Invalid analysis FEN", meta: request.meta || null, status: "error" });
      return false;
    }
    const contextKey = analysisContextKey(sender, request.meta);
    const requestedElo = Number(request.elo);
    const normalizedElo = Number.isFinite(requestedElo)
      ? Math.max(400, Math.min(3000, Math.round(requestedElo)))
      : 2000;
    const requestedStyle = typeof request.style === "string" ? request.style : "tal";
    const normalizedStyle = Object.hasOwn(GM_STYLES, requestedStyle) ? requestedStyle : "balanced";
    if (!isAnalysisGenerationCurrent(request.meta, contextKey)) {
      sendResponse({ error: "Obsolete analysis", code: "SUPERSEDED", meta: request.meta || null, status: "error" });
      return false;
    }
    if (request.meta) setBoundedCacheEntry(latestAnalysisMetaByClient, contextKey, request.meta, 32);
    const run = signal => experienceReady
      .then(() => analyzeAdaptiveMaster(
        request.fen,
        normalizedElo,
        normalizedStyle,
        request.pass || "fast",
        request.lastEnemyMove || null,
        Boolean(request.bulletTurbo),
        request.calcAverage !== false,
        request.calcWorst !== false,
        request.myColor || "w",
        request.mySeconds ?? 999,
        request.enemySeconds ?? 999,
        request.trapRadarEnabled !== false,
        Array.isArray(request.recentPositions) ? request.recentPositions : [],
        request.lastOurMove || null,
        contextKey,
        Array.isArray(request.uciHistory) ? request.uciHistory : [],
        Boolean(request.historyTrusted),
        request.meta || null,
        signal
      ));
    if (globalThis.__CC_ENGINE_RUNTIME__) {
      queueMobileAnalysis(request, sender, contextKey, run, sendResponse);
      return true;
    }
    run(null)
      .then((res) => sendResponse({ ...res, meta: request.meta || null, status: res?.best ? "ok" : "terminal" }))
      .catch((err) => sendResponse({ error: err.message, code: err.code || "ANALYSIS_FAILED", meta: request.meta || null, status: "error" }));
    return true;
  }

  if (request.type === "GET_BOARD_HEATMAP") {
    try {
      if (!validateEngineFen(request.fen)) throw new Error("Invalid heatmap FEN");
      const { board } = parseFEN(request.fen);
      const myColor = request.myColor || "w";
      const heatmap = computeBoardControlHeatmap(board, myColor);
      sendResponse({ ok: true, heatmap });
    } catch (e) {
      sendResponse({ ok: false });
    }
    return false;
  }

  if (request.type === "BUILD_PONDER_POSITION") {
    try {
      if (!validateEngineFen(request.fen)) throw new Error("Invalid ponder FEN");
      const parsed = parseFEN(request.fen);
      const requestedUci = String(request.enemyMoveUci || "");
      if (!ENGINE_UCI_MOVE.test(requestedUci)) throw new Error("Invalid ponder move");
      const legalMoves = generateLegalMoves(parsed.board, parsed.turn, parsed.castling, parsed.epSquare);
      const move = legalMoves.find(candidate =>
        `${FILES[candidate.fromC]}${8 - candidate.fromR}${FILES[candidate.toC]}${8 - candidate.toR}${candidate.promo || ""}` === requestedUci
      );
      if (!move) throw new Error("Predicted move is not legal");
      const nextBoard = makeMove(parsed.board, move);
      const nextTurn = parsed.turn === "w" ? "b" : "w";
      const nextCastling = updateCastlingAfterMove(parsed.castling, move);
      const nextEp = getNextEpSquare(move) || "-";
      const halfmove = move.piece === "p" || move.captured ? 0 : parsed.halfmoveClock + 1;
      const fullmove = parsed.fullmoveNumber + (parsed.turn === "b" ? 1 : 0);
      const history = Array.isArray(request.uciHistory) ? request.uciHistory.slice() : [];
      history.push(requestedUci);
      sendResponse({
        ok: true,
        fen: `${boardToFenPart(nextBoard)} ${nextTurn} ${nextCastling} ${nextEp} ${halfmove} ${fullmove}`,
        uciHistory: history,
        useStartposMoves: Boolean(request.historyTrusted),
        sourcePositionId: request.positionId
      });
    } catch (error) {
      sendResponse({ ok: false, error: String(error?.message || error) });
    }
    return false;
  }

  if (request.type === "GET_INSTANT_PREMOVE") {
    try {
      if (!validateEngineFen(request.fen)) throw new Error("Invalid premove FEN");
      const { board, castling, epSquare, pieceCount } = parseFEN(request.fen);
      const myColor = request.myColor || "w";
      const enemyColor = myColor === "w" ? "b" : "w";
      const plan = computeSmartNextPremove(
        board,
        myColor,
        enemyColor,
        castling,
        epSquare,
        request.lastOurMove || null,
        request.style || "tal",
        Array.isArray(request.recentPositions) ? request.recentPositions : [],
        request.predictedEnemyMove?.uci || null,
        Number(request.predictionConfidence) || 0
      );
      const staticMyEval = evaluateBoard(board, myColor, request.style || "tal");
      const wdl = computeWinDrawLossChances(staticMyEval, false, false);
      const heatmap = computeBoardControlHeatmap(board, myColor);
      sendResponse({
        ...(plan || { canPremove: false }),
        heatmap,
        telemetry: {
          serverSource: pieceCount <= 7 ? "SYZYGY READY" : "PREMOVE RADAR",
          pingMs: 8,
          myWin: wdl.myWin,
          draw: wdl.draw,
          enemyWin: wdl.enemyWin,
          evalCp: staticMyEval,
          nearestThreatText: plan && plan.canPremove
            ? `Готов премув ${plan.premove.from}→${plan.premove.to} (${plan.confidence}%)`
            : "Ожидание хода соперника (контроль угроз)"
        }
      });
    } catch (err) {
      sendResponse({ canPremove: false });
    }
    return false;
  }

});

const PIECE_VALUES = { p: 100, n: 320, b: 335, r: 500, q: 920, k: 20000 };
const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];

const GM_STYLES = {
  mogging:   { tropism: 2.25, safety: 2.20, space: 1.55, bishopBonus: 26, sacrificeBoost: 85, squeeze: 1.50, checkBonus: 22, structure: 1.35, trapAffinity: 1.45 },
  tal:       { tropism: 2.35, safety: 2.10, space: 1.50, bishopBonus: 24, sacrificeBoost: 85, squeeze: 1.10, checkBonus: 22, structure: 1.30, trapAffinity: 1.50 },
  alphazero: { tropism: 2.05, safety: 2.25, space: 2.00, bishopBonus: 46, sacrificeBoost: 75, squeeze: 2.10, checkBonus: 18, structure: 1.75, trapAffinity: 1.15 },
  morphy:    { tropism: 2.30, safety: 2.10, space: 1.80, bishopBonus: 36, sacrificeBoost: 80, squeeze: 1.20, checkBonus: 22, structure: 1.25, trapAffinity: 1.35 },
  hikaru:    { tropism: 2.10, safety: 2.20, space: 1.70, bishopBonus: 30, sacrificeBoost: 70, squeeze: 1.65, checkBonus: 20, structure: 1.40, trapAffinity: 1.55 },
  kasparov:  { tropism: 2.00, safety: 2.20, space: 1.80, bishopBonus: 30, sacrificeBoost: 75, squeeze: 1.35, checkBonus: 18, structure: 1.45, trapAffinity: 1.25 },
  fischer:   { tropism: 1.75, safety: 2.30, space: 1.65, bishopBonus: 44, sacrificeBoost: 55, squeeze: 1.40, checkBonus: 16, structure: 1.55, trapAffinity: 1.00 },
  carlsen:   { tropism: 1.50, safety: 2.45, space: 1.55, bishopBonus: 28, sacrificeBoost: 40, squeeze: 1.90, checkBonus: 14, structure: 1.85, trapAffinity: 1.10 },
  solid:     { tropism: 1.05, safety: 2.65, space: 1.30, bishopBonus: 22, sacrificeBoost: 0,  squeeze: 2.40, checkBonus: 10, structure: 1.95, trapAffinity: 0.60 },
  botvinnik: { tropism: 1.30, safety: 2.50, space: 1.60, bishopBonus: 28, sacrificeBoost: 30, squeeze: 2.10, checkBonus: 12, structure: 2.15, trapAffinity: 0.75 },
  balanced:  { tropism: 1.60, safety: 2.35, space: 1.50, bishopBonus: 26, sacrificeBoost: 45, squeeze: 1.30, checkBonus: 15, structure: 1.60, trapAffinity: 1.00 }
};

let cloudRetryAfter = 0;
let lastServerSourceTag = "LOCAL CORE";
let lastServerPingMs = 12;

function computeWinDrawLossChances(scoreCpForUs, isOurMate = false, isEnemyMate = false) {
  if (isOurMate || scoreCpForUs >= 9000) {
    return { myWin: 99, draw: 1, enemyWin: 0 };
  }
  if (isEnemyMate || scoreCpForUs <= -9000) {
    return { myWin: 0, draw: 1, enemyWin: 99 };
  }
  const clamped = Math.max(-1000, Math.min(1000, scoreCpForUs));
  // Сигмоида Lichess Win% = 50 + 50 * (2 / (1 + exp(-0.00368208 * cp)) - 1)
  const expectedScore = 1 / (1 + Math.exp(-0.0038 * clamped));
  const absPawns = Math.abs(clamped) / 100;
  const drawProb = Math.max(4, Math.round(34 * Math.exp(-0.38 * absPawns * absPawns)));
  const remaining = 100 - drawProb;
  const myWin = Math.max(0, Math.min(99, Math.round(expectedScore * remaining)));
  const enemyWin = Math.max(0, 100 - drawProb - myWin);
  return { myWin, draw: drawProb, enemyWin };
}

function setBoundedCacheEntry(cache, key, value, maxEntries) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
}

function rememberNegativeCache(cache, key, ttlMs) {
  setBoundedCacheEntry(cache, key, Date.now() + ttlMs, NEGATIVE_CACHE_MAX_ENTRIES);
}

function hasFreshNegativeCache(cache, key) {
  const expiresAt = cache.get(key);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    cache.delete(key);
    return false;
  }
  return true;
}

function linkAnalysisAbort(signal, controller) {
  if (!signal) return () => {};
  if (signal.aborted) throw SEARCH_SUPERSEDED;
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

async function fetchLichessCloud3000(fen, pieceCount, signal = null) {
  if (pieceCount < 18) return null;
  if (cloudCache.has(fen)) {
    const cached = cloudCache.get(fen);
    const isExplorer = cached?.[0]?.source === "explorer";
    const isFreshExplorer = isExplorer && Date.now() - Number(cached[0].cachedAt || 0) < 30000;
    if (!isExplorer || isFreshExplorer) {
      if (cached) lastServerSourceTag = isExplorer ? "EXPLORER CACHE (0ms)" : "CLOUD CACHE (0ms)";
      return cached;
    }
    cloudCache.delete(fen);
  }
  if (hasFreshNegativeCache(cloudNegativeCache, fen)) return null;

  if (Date.now() >= cloudRetryAfter) {
    const t0 = Date.now();
    const controller = new AbortController();
    const unlink = linkAnalysisAbort(signal, controller);
    const timer = setTimeout(() => controller.abort(), 650);
    try {
      const url = `https://lichess.org/api/cloud-eval?fen=${encodeURIComponent(fen)}&multiPv=3`;
      const res = await fetch(url, { signal: controller.signal });

      if (res.ok) {
        lastServerPingMs = Date.now() - t0;
        lastServerSourceTag = `CLOUD 3000 (200 OK • ${lastServerPingMs}мс)`;
        const data = await res.json();
        if (data && Array.isArray(data.pvs) && data.pvs.length > 0) {
          const parsed = data.pvs.map((pv) => {
            const moves = (pv.moves || "").split(" ");
            const firstUci = moves[0] || "";
            return {
              uci: firstUci,
              from: firstUci.slice(0, 2),
              to: firstUci.slice(2, 4),
              promo: firstUci.length > 4 ? firstUci[4].toLowerCase() : null,
              cp: pv.cp !== undefined ? pv.cp : (pv.mate ? pv.mate * 3000 : 0),
              source: "cloud",
              depth: Number(data.depth) || 0,
              cachedAt: Date.now(),
              pvChain: moves.slice(0, 4).map(u => `${u.slice(0, 2)}→${u.slice(2, 4)}`).join(" ➔ ")
            };
          });
          cloudNegativeCache.delete(fen);
          setBoundedCacheEntry(cloudCache, fen, parsed, REMOTE_CACHE_MAX_ENTRIES);
          return parsed;
        }
      } else if (res.status === 429 || res.status >= 500) {
        const retrySeconds = Number(res.headers.get("retry-after")) || 30;
        cloudRetryAfter = Date.now() + Math.min(120, retrySeconds) * 1000;
      }
    } catch (e) {
      if (signal?.aborted) throw SEARCH_SUPERSEDED;
    } finally {
      clearTimeout(timer);
      unlink();
    }
  }

  if (pieceCount >= 22) {
    const t0 = Date.now();
    const expController = new AbortController();
    const unlink = linkAnalysisAbort(signal, expController);
    const expTimer = setTimeout(() => expController.abort(), 650);
    try {
      const expUrl = `https://explorer.lichess.ovh/masters?topGames=0&moves=6&fen=${encodeURIComponent(fen)}`;
      const expRes = await fetch(expUrl, { signal: expController.signal });

      if (expRes.ok) {
        lastServerPingMs = Date.now() - t0;
        lastServerSourceTag = `EXPLORER MASTERS (200 OK • ${lastServerPingMs}мс)`;
        const expData = await expRes.json();
        if (expData && Array.isArray(expData.moves) && expData.moves.length > 0) {
          const isWhiteTurn = fen.split(" ")[1] !== "b";
          const validMoves = expData.moves.filter(m => (m.white + m.draws + m.black) >= 8);

          if (validMoves.length > 0) {
            const parsedExplorer = validMoves.slice(0, 3).map((mv) => {
              const total = mv.white + mv.draws + mv.black;
              const ourWins = isWhiteTurn ? mv.white : mv.black;
              const enemyWins = isWhiteTurn ? mv.black : mv.white;
              const winDiffRatio = (ourWins - enemyWins) / total;
              const estimatedCp = Math.round(winDiffRatio * 250);
              const uci = mv.uci || "";
              return {
                uci,
                from: uci.slice(0, 2),
                to: uci.slice(2, 4),
                promo: uci.length > 4 ? uci[4].toLowerCase() : null,
                cp: estimatedCp,
                source: "explorer",
                depth: 0,
                cachedAt: Date.now(),
                pvChain: `${uci.slice(0, 2)}→${uci.slice(2, 4)} (${mv.san || "База Мастеров"} • ${total} парт.)`
              };
            });
            cloudNegativeCache.delete(fen);
            setBoundedCacheEntry(cloudCache, fen, parsedExplorer, REMOTE_CACHE_MAX_ENTRIES);
            return parsedExplorer;
          }
        }
      }
    } catch (e) {
      if (signal?.aborted) throw SEARCH_SUPERSEDED;
    } finally {
      clearTimeout(expTimer);
      unlink();
    }
  }

  rememberNegativeCache(cloudNegativeCache, fen, 15000);
  return null;
}

async function fetchSyzygyTablebase(fen, pieceCount, signal = null) {
  if (pieceCount > 7) return null;
  if (syzygyCache.has(fen)) {
    const cached = syzygyCache.get(fen);
    if (cached) lastServerSourceTag = "SYZYGY CACHE (0ms)";
    return cached;
  }
  if (hasFreshNegativeCache(syzygyNegativeCache, fen)) return null;

  const t0 = Date.now();
  const controller = new AbortController();
  const unlink = linkAnalysisAbort(signal, controller);
  const timer = setTimeout(() => controller.abort(), 650);
  try {
    const url = `https://tablebase.lichess.ovh/standard?fen=${encodeURIComponent(fen)}`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      rememberNegativeCache(syzygyNegativeCache, fen, res.status === 429 || res.status >= 500 ? 15000 : 60000);
      return null;
    }
    lastServerPingMs = Date.now() - t0;
    lastServerSourceTag = `SYZYGY БОГ (200 OK • ${lastServerPingMs}мс)`;
    const data = await res.json();
    if (data && Array.isArray(data.moves) && data.moves.length > 0) {
      const parsedMoves = data.moves.map((mv, idx) => {
        const uci = mv.uci || "";
        let ourOutcome = "draw";
        let syzygyScore = 0;
        if (mv.category === "loss" || mv.category === "blessed-loss") {
          ourOutcome = mv.category === "loss" ? "win" : "cursed-win";
          const dtmDist = mv.dtm ? Math.abs(mv.dtm) : (mv.dtz ? Math.abs(mv.dtz) : 20);
          syzygyScore = (mv.category === "loss" ? 1400 : 650) - Math.min(300, dtmDist * 4) - idx * 25 + (mv.zeroing ? 90 : 0);
        } else if (mv.category === "win" || mv.category === "cursed-win") {
          ourOutcome = mv.category === "win" ? "loss" : "blessed-loss";
          const dtmDist = mv.dtm ? Math.abs(mv.dtm) : (mv.dtz ? Math.abs(mv.dtz) : 20);
          syzygyScore = (mv.category === "win" ? -1400 : -650) + Math.min(300, dtmDist * 4) - idx * 15;
        } else {
          ourOutcome = "draw";
          syzygyScore = -idx * 10;
        }

        const dtzVal = mv.dtz !== null && mv.dtz !== undefined ? Math.abs(mv.dtz) : null;
        const dtmVal = mv.dtm !== null && mv.dtm !== undefined ? Math.abs(mv.dtm) : null;

        let badgeLabel = "ТАБЛИЦА SYZYGY: НИЧЬЯ (0.00)";
        if (ourOutcome === "win") {
          badgeLabel = dtmVal !== null
            ? `SYZYGY БОГ: ПОБЕДА (МАТ В ${Math.ceil(dtmVal / 2)} ХОДОВ • DTZ ${dtzVal ?? "-"})`
            : `SYZYGY БОГ: 100% ПОБЕДА (DTZ ${dtzVal ?? "-"})`;
        } else if (ourOutcome === "cursed-win") {
          badgeLabel = `SYZYGY: ПОБЕДА (DTZ ${dtzVal ?? "-"})`;
        } else if (ourOutcome === "loss") {
          badgeLabel = `SYZYGY: УПОРНАЯ ОБОРОНА (DTZ ${dtzVal ?? "-"})`;
        }

        return {
          uci,
          from: uci.slice(0, 2),
          to: uci.slice(2, 4),
          promo: uci.length > 4 ? uci[4].toLowerCase() : null,
          san: mv.san || `${uci.slice(0, 2)}→${uci.slice(2, 4)}`,
          ourOutcome,
          dtz: dtzVal,
          dtm: dtmVal,
          zeroing: Boolean(mv.zeroing),
          syzygyScore,
          badgeLabel,
          rankIndex: idx
        };
      });

      const resultObj = {
        rootCategory: data.category || "unknown",
        rootDtz: data.dtz,
        rootDtm: data.dtm,
        moves: parsedMoves
      };
      syzygyNegativeCache.delete(fen);
      setBoundedCacheEntry(syzygyCache, fen, resultObj, REMOTE_CACHE_MAX_ENTRIES);
      return resultObj;
    }
  } catch (e) {
    if (signal?.aborted) throw SEARCH_SUPERSEDED;
  } finally {
    clearTimeout(timer);
    unlink();
  }
  rememberNegativeCache(syzygyNegativeCache, fen, 30000);
  return null;
}

const OPENING_BOOK = {
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w": [
    { from: "e2", to: "e4", name: "Королевский дебют (1. e4)", bonus: 45 },
    { from: "d2", to: "d4", name: "Ферзевый дебют (1. d4)", bonus: 45 },
    { from: "c2", to: "c4", name: "Английское начало (1. c4)", bonus: 38 }
  ],
  "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b": [
    { from: "c7", to: "c5", name: "Сицилианская защита (1... c5)", bonus: 48 },
    { from: "e7", to: "e5", name: "Открытый дебют (1... e5)", bonus: 46 },
    { from: "c7", to: "c6", name: "Защита Каро-Канн (1... c6)", bonus: 42 },
    { from: "e7", to: "e6", name: "Французская защита (1... e6)", bonus: 40 }
  ],
  "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b": [
    { from: "g8", to: "f6", name: "Индийская защита (1... Nf6)", bonus: 48 },
    { from: "d7", to: "d5", name: "Классический ферзевый ответ (1... d5)", bonus: 46 }
  ],
  "rnbqkbnr/pp2pppp/2p5/3p4/3PP3/2N5/PPP2PPP/R1BQKBNR b": [
    { from: "d5", to: "e4", name: "Каро-Канн: Размен на e4 (3... dxe4)", bonus: 45 }
  ],
  "rnbqkbnr/pp2pppp/2p5/8/3PN3/8/PPP2PPP/R1BQKBNR b": [
    { from: "c8", to: "f5", name: "Каро-Канн: Классический вариант (4... Bf5)", bonus: 48 },
    { from: "g8", to: "f6", name: "Каро-Канн: Вариант Тартаковера (4... Nf6)", bonus: 44 }
  ],
  "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w": [
    { from: "e4", to: "d5", name: "Скандинавская защита (2. exd5!)", bonus: 50 }
  ],
  "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w": [
    { from: "g1", to: "f3", name: "Атака пешки e5 (2. Nf3)", bonus: 48 }
  ],
  "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b": [
    { from: "b8", to: "c6", name: "Классическая защита (2... Nc6)", bonus: 48 },
    { from: "g8", to: "f6", name: "Русская партия (2... Nf6)", bonus: 45 }
  ],
  "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w": [
    { from: "f1", to: "c4", name: "Итальянская партия (3. Bc4)", bonus: 48 },
    { from: "f1", to: "b5", name: "Испанская партия (3. Bb5)", bonus: 48 },
    { from: "d2", to: "d4", name: "Шотландская партия (3. d4)", bonus: 45 }
  ],
  "r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w": [
    { from: "c2", to: "c3", name: "Итальянский центр (4. c3)", bonus: 46 },
    { from: "b2", to: "b4", name: "Гамбит Эванса (4. b4)", bonus: 42 }
  ],
  "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w": [
    { from: "d2", to: "d3", name: "Тихая Итальянка (4. d3)", bonus: 46 },
    { from: "f3", to: "g5", name: "Атака Фегателло / Нападение на f7 (4. Ng5)", bonus: 44 }
  ],
  "r1bqkb1r/pppp1ppp/2n2n2/4p1N1/2B1P3/8/PPPP1PPP/RNBQK2R b": [
    { from: "d7", to: "d5", name: "Точный перехват инициативы по теории (4... d5!)", bonus: 95 }
  ]
};

const PST = {
  p: [
    [0,  0,  0,  0,  0,  0,  0,  0],
    [80, 80, 80, 80, 80, 80, 80, 80],
    [25, 25, 32, 42, 42, 32, 25, 25],
    [10, 10, 18, 34, 34, 18, 10, 10],
    [0,  0,  6, 36, 36,  6,  0,  0],
    [5, -5, -5, 10, 10, -5, -5,  5],
    [5, 10, 10,-25,-25, 10, 10,  5],
    [0,  0,  0,  0,  0,  0,  0,  0]
  ],
  n: [
    [-50,-40,-30,-30,-30,-30,-40,-50],
    [-40,-20,  0,  5,  5,  0,-20,-40],
    [-30,  6, 22, 28, 28, 22,  6,-30],
    [-30, 10, 26, 32, 32, 26, 10,-30],
    [-30,  6, 24, 28, 28, 24,  6,-30],
    [-30,  6, 18, 22, 22, 18,  6,-30],
    [-40,-20,  0,  5,  5,  0,-20,-40],
    [-50,-40,-30,-30,-30,-30,-40,-50]
  ],
  b: [
    [-20,-10,-10,-10,-10,-10,-10,-20],
    [-10,  2,  0,  0,  0,  0,  2,-10],
    [-10,  6, 16, 22, 22, 16,  6,-10],
    [-10, 14, 16, 22, 22, 16, 14,-10],
    [-10,  6, 24, 18, 18, 24,  6,-10],
    [-10, 16, 14, 16, 16, 14, 16,-10],
    [-10, 12,  0,  0,  0,  0, 12,-10],
    [-20,-10,-10,-10,-10,-10,-10,-20]
  ],
  r: [
    [  0,  0,  4,  8,  8,  4,  0,  0],
    [ 22, 28, 28, 28, 28, 28, 28, 22],
    [ -5,  0,  0,  2,  2,  0,  0, -5],
    [ -5,  0,  0,  2,  2,  0,  0, -5],
    [ -5,  0,  0,  2,  2,  0,  0, -5],
    [ -5,  0,  0,  0,  0,  0,  0, -5],
    [ -5,  0,  0,  0,  0,  0,  0, -5],
    [  0,  0,  8, 16, 16,  8,  0,  0]
  ],
  q: [
    [-20,-10,-10, -5, -5,-10,-10,-20],
    [-10,  0,  5,  5,  5,  5,  0,-10],
    [-10,  5, 10, 14, 14, 10,  5,-10],
    [ -5,  0, 10, 14, 14, 10,  0, -5],
    [  0,  0,  6, 10, 10,  6,  0, -5],
    [-10,  6,  6,  6,  6,  6,  0,-10],
    [-10,  0,  5,  0,  0,  0,  0,-10],
    [-20,-10,-10, -5, -5,-10,-10,-20]
  ],
  k: [
    [-40,-50,-50,-60,-60,-50,-50,-40],
    [-40,-50,-50,-60,-60,-50,-50,-40],
    [-40,-50,-50,-60,-60,-50,-50,-40],
    [-40,-50,-50,-60,-60,-50,-50,-40],
    [-30,-40,-40,-50,-50,-40,-40,-30],
    [-20,-30,-30,-40,-40,-30,-30,-20],
    [ 10, 15, -5,-15,-15, -5, 15, 10],
    [ 20, 35, 15, -5,  5, 10, 35, 20]
  ]
};

const ENDGAME_KING_PST = [
  [-25,-15, -5,  0,  0, -5,-15,-25],
  [-15,  5, 18, 25, 25, 18,  5,-15],
  [ -5, 18, 35, 45, 45, 35, 18, -5],
  [  0, 25, 45, 58, 58, 45, 25,  0],
  [  0, 25, 45, 58, 58, 45, 25,  0],
  [ -5, 18, 35, 45, 45, 35, 18, -5],
  [-15,  5, 18, 25, 25, 18,  5,-15],
  [-25,-15, -5,  0,  0, -5,-15,-25]
];

function parseFEN(fen) {
  const parts = (fen || "").trim().split(/\s+/);
  const rows = (parts[0] || "8/8/8/8/8/8/8/8").split("/");
  const turn = parts[1] || "w";
  const castling = parts[2] || "-";
  const epSquare = (parts[3] && parts[3] !== "-") ? parts[3] : null;
  const parsedHalfmove = Number(parts[4]);
  const parsedFullmove = Number(parts[5]);
  const halfmoveClock = Number.isSafeInteger(parsedHalfmove) && parsedHalfmove >= 0 ? parsedHalfmove : 0;
  const fullmoveNumber = Number.isSafeInteger(parsedFullmove) && parsedFullmove >= 1 ? parsedFullmove : 1;

  const board = [];
  let pieceCount = 0;
  for (let r = 0; r < 8; r++) {
    const row = [];
    for (const ch of (rows[r] || "8")) {
      if (!isNaN(ch)) {
        for (let i = 0; i < parseInt(ch, 10); i++) row.push(null);
      } else {
        row.push(ch);
        pieceCount++;
      }
    }
    board.push(row);
  }
  return {
    board,
    turn,
    castling,
    epSquare,
    halfmoveClock,
    fullmoveNumber,
    pieceCount,
    boardKey: `${parts[0]} ${turn} ${castling} ${epSquare || "-"}`
  };
}

function boardToFenPart(board) {
  const rows = [];
  for (let r = 0; r < 8; r++) {
    let s = "";
    let empty = 0;
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p) {
        empty++;
      } else {
        if (empty > 0) {
          s += empty;
          empty = 0;
        }
        s += p;
      }
    }
    if (empty > 0) s += empty;
    rows.push(s);
  }
  return rows.join("/");
}

function boardToHash(board, turn, castling = "-", epSquare = null, halfmoveClock = 0) {
  let s = `${turn}_${castling}_${epSquare || "-"}_${Math.max(0, Math.min(100, Number(halfmoveClock) || 0))}_`;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      s += board[r][c] || ".";
    }
  }
  return s;
}

function isColor(p, color) {
  if (!p) return false;
  return color === "w" ? p === p.toUpperCase() : p === p.toLowerCase();
}

function isCol(p, color) {
  return isColor(p, color);
}

function isSquareAttacked(board, r, c, byColor) {
  const isW = byColor === "w";
  const P = isW ? "P" : "p";
  const N = isW ? "N" : "n";
  const B = isW ? "B" : "b";
  const R = isW ? "R" : "r";
  const Q = isW ? "Q" : "q";
  const K = isW ? "K" : "k";

  const pawnRow = isW ? r + 1 : r - 1;
  if (pawnRow >= 0 && pawnRow <= 7) {
    if (c > 0 && board[pawnRow][c - 1] === P) return true;
    if (c < 7 && board[pawnRow][c + 1] === P) return true;
  }

  const knightSteps = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
  for (let i = 0; i < 8; i++) {
    const nr = r + knightSteps[i][0], nc = c + knightSteps[i][1];
    if (nr >= 0 && nr <= 7 && nc >= 0 && nc <= 7 && board[nr][nc] === N) return true;
  }

  const kingSteps = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
  for (let i = 0; i < 8; i++) {
    const nr = r + kingSteps[i][0], nc = c + kingSteps[i][1];
    if (nr >= 0 && nr <= 7 && nc >= 0 && nc <= 7 && board[nr][nc] === K) return true;
  }

  const diagDirs = [[-1,-1],[-1,1],[1,-1],[1,1]];
  for (let i = 0; i < 4; i++) {
    let nr = r + diagDirs[i][0], nc = c + diagDirs[i][1];
    while (nr >= 0 && nr <= 7 && nc >= 0 && nc <= 7) {
      const p = board[nr][nc];
      if (p) {
        if (p === B || p === Q) return true;
        break;
      }
      nr += diagDirs[i][0];
      nc += diagDirs[i][1];
    }
  }

  const orthoDirs = [[-1,0],[1,0],[0,-1],[0,1]];
  for (let i = 0; i < 4; i++) {
    let nr = r + orthoDirs[i][0], nc = c + orthoDirs[i][1];
    while (nr >= 0 && nr <= 7 && nc >= 0 && nc <= 7) {
      const p = board[nr][nc];
      if (p) {
        if (p === R || p === Q) return true;
        break;
      }
      nr += orthoDirs[i][0];
      nc += orthoDirs[i][1];
    }
  }
  return false;
}

function getAttackersOfSquare(board, r, c, byColor) {
  const isW = byColor === "w";
  const P = isW ? "P" : "p";
  const N = isW ? "N" : "n";
  const B = isW ? "B" : "b";
  const R = isW ? "R" : "r";
  const Q = isW ? "Q" : "q";
  const K = isW ? "K" : "k";
  const attackers = [];

  const pawnRow = isW ? r + 1 : r - 1;
  if (pawnRow >= 0 && pawnRow <= 7) {
    if (c > 0 && board[pawnRow][c - 1] === P) attackers.push(100);
    if (c < 7 && board[pawnRow][c + 1] === P) attackers.push(100);
  }

  const knightSteps = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
  for (let i = 0; i < 8; i++) {
    const nr = r + knightSteps[i][0], nc = c + knightSteps[i][1];
    if (nr >= 0 && nr <= 7 && nc >= 0 && nc <= 7 && board[nr][nc] === N) attackers.push(320);
  }

  const diagDirs = [[-1,-1],[-1,1],[1,-1],[1,1]];
  for (let i = 0; i < 4; i++) {
    let nr = r + diagDirs[i][0], nc = c + diagDirs[i][1];
    while (nr >= 0 && nr <= 7 && nc >= 0 && nc <= 7) {
      const p = board[nr][nc];
      if (p) {
        if (p === B) attackers.push(335);
        else if (p === Q) attackers.push(920);
        break;
      }
      nr += diagDirs[i][0];
      nc += diagDirs[i][1];
    }
  }

  const orthoDirs = [[-1,0],[1,0],[0,-1],[0,1]];
  for (let i = 0; i < 4; i++) {
    let nr = r + orthoDirs[i][0], nc = c + orthoDirs[i][1];
    while (nr >= 0 && nr <= 7 && nc >= 0 && nc <= 7) {
      const p = board[nr][nc];
      if (p) {
        if (p === R) attackers.push(500);
        else if (p === Q) attackers.push(920);
        break;
      }
      nr += orthoDirs[i][0];
      nc += orthoDirs[i][1];
    }
  }

  const kingSteps = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
  for (let i = 0; i < 8; i++) {
    const nr = r + kingSteps[i][0], nc = c + kingSteps[i][1];
    if (nr >= 0 && nr <= 7 && nc >= 0 && nc <= 7 && board[nr][nc] === K) attackers.push(20000);
  }

  attackers.sort((a, b) => a - b);
  return attackers;
}

function computeBoardControlHeatmap(board, myColor = "w", budget = null) {
  const enemyColor = myColor === "w" ? "b" : "w";
  const myKing = findKing(board, myColor);
  const cells = [];

  for (let r = 0; r < 8; r++) {
    checkSearchBudget(budget);
    for (let c = 0; c < 8; c++) {
      const myAtt = getAttackersOfSquare(board, r, c, myColor);
      const enAtt = getAttackersOfSquare(board, r, c, enemyColor);
      const myCount = myAtt.length;
      const enCount = enAtt.length;

      if (myCount === 0 && enCount === 0) continue;

      const isNearMyKing = Math.abs(r - myKing.r) <= 1 && Math.abs(c - myKing.c) <= 1;
      const sqName = `${FILES[c]}${8 - r}`;

      const myWeight = myAtt.reduce((acc, v) => acc + (v === 100 ? 1.35 : v <= 350 ? 1.15 : v <= 550 ? 1.0 : 0.85), 0);
      const enWeight = enAtt.reduce((acc, v) => acc + (v === 100 ? 1.35 : v <= 350 ? 1.15 : v <= 550 ? 1.0 : 0.85), 0);
      const netControl = myWeight - enWeight;

      if (isNearMyKing && enCount > 0 && enCount >= myCount) {
        cells.push({
          sq: sqName,
          r,
          c,
          zone: "king_danger",
          intensity: Math.min(1, 0.55 + (enCount - myCount + 1) * 0.2),
          myCount,
          enCount
        });
      } else if (netControl >= 0.45) {
        cells.push({
          sq: sqName,
          r,
          c,
          zone: "my",
          intensity: Math.min(0.95, 0.25 + netControl * 0.22),
          myCount,
          enCount
        });
      } else if (netControl <= -0.45) {
        cells.push({
          sq: sqName,
          r,
          c,
          zone: "enemy",
          intensity: Math.min(0.95, 0.25 + Math.abs(netControl) * 0.22),
          myCount,
          enCount
        });
      }
    }
  }
  return cells;
}

function seeExchangeScore(boardAfterMove, toR, toC, movedPieceType, capturedPieceType, moverColor) {
  const enemy = moverColor === "w" ? "b" : "w";
  const gain = capturedPieceType ? (PIECE_VALUES[capturedPieceType] || 100) : 0;
  const pieceOnSquareVal = PIECE_VALUES[movedPieceType] || 100;

  const enemyAttackers = getAttackersOfSquare(boardAfterMove, toR, toC, enemy);
  if (enemyAttackers.length === 0) return gain;

  const ourDefenders = getAttackersOfSquare(boardAfterMove, toR, toC, moverColor);
  if (ourDefenders.length === 0) {
    return gain - pieceOnSquareVal;
  }

  const swapList = [gain];
  let currentValOnSq = pieceOnSquareVal;
  let eIdx = 0;
  let oIdx = 0;
  let side = "enemy";

  while (true) {
    if (side === "enemy") {
      if (eIdx >= enemyAttackers.length) break;
      swapList.push(currentValOnSq - swapList[swapList.length - 1]);
      currentValOnSq = enemyAttackers[eIdx++];
      side = "our";
    } else {
      if (oIdx >= ourDefenders.length) break;
      swapList.push(currentValOnSq - swapList[swapList.length - 1]);
      currentValOnSq = ourDefenders[oIdx++];
      side = "enemy";
    }
  }

  for (let i = swapList.length - 1; i > 0; i--) {
    swapList[i - 1] = -Math.max(-swapList[i - 1], swapList[i]);
  }
  return swapList[0];
}

function findKing(board, kingColor) {
  const kChar = kingColor === "w" ? "K" : "k";
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (board[r][c] === kChar) return { r, c };
    }
  }
  return { r: kingColor === "w" ? 7 : 0, c: 4 };
}

function isKingInCheck(board, kingColor) {
  const enemy = kingColor === "w" ? "b" : "w";
  const k = findKing(board, kingColor);
  return isSquareAttacked(board, k.r, k.c, enemy);
}

function countNonPawnMaterial(board) {
  let mat = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p) continue;
      const t = p.toLowerCase();
      if (t !== "p" && t !== "k") mat += PIECE_VALUES[t] || 0;
    }
  }
  return mat;
}

function evaluateKingAttackAndShield(board, attackerColor) {
  const defenderColor = attackerColor === "w" ? "b" : "w";
  const enemyKing = findKing(board, defenderColor);
  let attackScore = 0;

  const shieldRow = defenderColor === "w" ? enemyKing.r - 1 : enemyKing.r + 1;
  const enemyPawnChar = defenderColor === "w" ? "P" : "p";
  if (shieldRow >= 0 && shieldRow <= 7) {
    for (let dc = -1; dc <= 1; dc++) {
      const sc = enemyKing.c + dc;
      if (sc >= 0 && sc <= 7 && board[shieldRow][sc] !== enemyPawnChar) {
        attackScore += 24;
      }
    }
  }

  let attackedKingZoneSquares = 0;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const kr = enemyKing.r + dr, kc = enemyKing.c + dc;
      if (kr >= 0 && kr <= 7 && kc >= 0 && kc <= 7) {
        if (isSquareAttacked(board, kr, kc, attackerColor)) {
          attackedKingZoneSquares++;
        }
      }
    }
  }
  attackScore += attackedKingZoneSquares * 20;
  return attackScore;
}

function evaluatePawnStructureAndEndgame(board, isEndgame, wKing, bKing, turn = "w") {
  const wPawnsPerCol = [0, 0, 0, 0, 0, 0, 0, 0];
  const bPawnsPerCol = [0, 0, 0, 0, 0, 0, 0, 0];
  const wRooks = [];
  const bRooks = [];
  const wPawns = [];
  const bPawns = [];

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p) continue;
      if (p === "P") {
        wPawnsPerCol[c]++;
        wPawns.push({ r, c });
      } else if (p === "p") {
        bPawnsPerCol[c]++;
        bPawns.push({ r, c });
      } else if (p === "R") wRooks.push({ r, c });
      else if (p === "r") bRooks.push({ r, c });
    }
  }

  let structScore = 0;

  for (let c = 0; c < 8; c++) {
    if (wPawnsPerCol[c] > 1) structScore -= (wPawnsPerCol[c] - 1) * 18;
    if (bPawnsPerCol[c] > 1) structScore += (bPawnsPerCol[c] - 1) * 18;

    const wHasNeighbor = (c > 0 && wPawnsPerCol[c - 1] > 0) || (c < 7 && wPawnsPerCol[c + 1] > 0);
    if (wPawnsPerCol[c] > 0 && !wHasNeighbor) structScore -= 15;

    const bHasNeighbor = (c > 0 && bPawnsPerCol[c - 1] > 0) || (c < 7 && bPawnsPerCol[c + 1] > 0);
    if (bPawnsPerCol[c] > 0 && !bHasNeighbor) structScore += 15;
  }

  const passedBonusByRank = isEndgame
    ? [0, 145, 95, 60, 35, 18, 8, 0]
    : [0, 78, 50, 32, 18, 10, 5, 0];

  for (const wp of wPawns) {
    const defendedByPawn =
      wp.r < 7 &&
      ((wp.c > 0 && board[wp.r + 1][wp.c - 1] === "P") ||
        (wp.c < 7 && board[wp.r + 1][wp.c + 1] === "P"));
    if (defendedByPawn) structScore += 12;

    let passed = true;
    for (let rr = 0; rr < wp.r && passed; rr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const cc = wp.c + dc;
        if (cc >= 0 && cc <= 7 && board[rr][cc] === "p") passed = false;
      }
    }
    if (passed) {
      structScore += passedBonusByRank[wp.r];
      if (isEndgame) {
        const ownKingDist = Math.max(Math.abs(wKing.r - wp.r), Math.abs(wKing.c - wp.c));
        const enemyKingDistToPawn = Math.max(Math.abs(bKing.r - wp.r), Math.abs(bKing.c - wp.c));
        const enemyKingDistToPromote = Math.max(bKing.r, Math.abs(bKing.c - wp.c));
        const canDoubleStep = wp.r === 6 && !board[5][wp.c] && !board[4][wp.c];
        const stepsToPromote = canDoubleStep ? 5 : wp.r;
        const turnTempo = turn === "w" ? 1 : 0;
        structScore += (7 - ownKingDist) * 10;
        structScore += enemyKingDistToPawn * 12;
        if (enemyKingDistToPromote > stepsToPromote + turnTempo) structScore += 180;
      }
    }

    if (isEndgame) {
      const attackedByEnemyKing = Math.abs(bKing.r - wp.r) <= 1 && Math.abs(bKing.c - wp.c) <= 1;
      const defendedByOwnKing = Math.abs(wKing.r - wp.r) <= 1 && Math.abs(wKing.c - wp.c) <= 1;
      if (attackedByEnemyKing && !defendedByPawn && !defendedByOwnKing) {
        structScore -= 55;
      }
    }
  }

  for (const bp of bPawns) {
    const defendedByPawn =
      bp.r > 0 &&
      ((bp.c > 0 && board[bp.r - 1][bp.c - 1] === "p") ||
        (bp.c < 7 && board[bp.r - 1][bp.c + 1] === "p"));
    if (defendedByPawn) structScore -= 12;

    let passed = true;
    for (let rr = bp.r + 1; rr <= 7 && passed; rr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const cc = bp.c + dc;
        if (cc >= 0 && cc <= 7 && board[rr][cc] === "P") passed = false;
      }
    }
    if (passed) {
      structScore -= passedBonusByRank[7 - bp.r];
      if (isEndgame) {
        const ownKingDist = Math.max(Math.abs(bKing.r - bp.r), Math.abs(bKing.c - bp.c));
        const enemyKingDistToPawn = Math.max(Math.abs(wKing.r - bp.r), Math.abs(wKing.c - bp.c));
        const enemyKingDistToPromote = Math.max(7 - wKing.r, Math.abs(wKing.c - bp.c));
        const canDoubleStep = bp.r === 1 && !board[2][bp.c] && !board[3][bp.c];
        const stepsToPromote = canDoubleStep ? 5 : (7 - bp.r);
        const turnTempo = turn === "b" ? 1 : 0;
        structScore -= (7 - ownKingDist) * 10;
        structScore -= enemyKingDistToPawn * 12;
        if (enemyKingDistToPromote > stepsToPromote + turnTempo) structScore -= 180;
      }
    }

    if (isEndgame) {
      const attackedByEnemyKing = Math.abs(wKing.r - bp.r) <= 1 && Math.abs(wKing.c - bp.c) <= 1;
      const defendedByOwnKing = Math.abs(bKing.r - bp.r) <= 1 && Math.abs(bKing.c - bp.c) <= 1;
      if (attackedByEnemyKing && !defendedByPawn && !defendedByOwnKing) {
        structScore += 55;
      }
    }
  }

  for (const wr of wRooks) {
    if (wPawnsPerCol[wr.c] === 0) {
      structScore += bPawnsPerCol[wr.c] === 0 ? 22 : 12;
    }
  }
  for (const br of bRooks) {
    if (bPawnsPerCol[br.c] === 0) {
      structScore -= wPawnsPerCol[br.c] === 0 ? 22 : 12;
    }
  }

  return structScore;
}

function evaluateBoard(board, side, style = "tal") {
  let score = 0;
  let wMaterial = 0;
  let bMaterial = 0;
  const wKing = findKing(board, "w");
  const bKing = findKing(board, "b");
  const profile = GM_STYLES[style] || GM_STYLES.balanced;

  let wBishops = 0, bBishops = 0;
  const nonPawnMaterial = countNonPawnMaterial(board);
  const isEndgame = nonPawnMaterial <= 2200;
  const egPhase = Math.max(0, Math.min(1, (3600 - nonPawnMaterial) / 2400));

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p) continue;
      const isW = p === p.toUpperCase();
      const type = p.toLowerCase();
      if (type === "b") {
        if (isW) wBishops++; else bBishops++;
      }

      const val = PIECE_VALUES[type] || 0;
      if (type !== "k") {
        if (isW) wMaterial += val;
        else bMaterial += val;
      }

      const pstR = isW ? r : 7 - r;

      let pstVal = 0;
      if (type === "k") {
        const mgK = PST.k[pstR][c];
        const egK = ENDGAME_KING_PST[pstR][c];
        pstVal = Math.round(mgK * (1 - egPhase) + egK * egPhase);
      } else {
        pstVal = (PST[type] && PST[type][pstR]) ? PST[type][pstR][c] : 0;
      }
      const pst = Math.round(pstVal * Math.min(1.6, profile.space));

      let kingAttackBonus = 0;
      if (type === "q" || type === "n" || type === "b" || type === "r") {
        const targetK = isW ? bKing : wKing;
        const dist = Math.abs(r - targetK.r) + Math.abs(c - targetK.c);
        const weight = type === "q" ? 6 : (type === "r" ? 4 : 3);
        kingAttackBonus = Math.round(Math.max(0, (8 - dist) * weight) * Math.min(2.0, profile.tropism));
      }

      if (isW) score += val + pst + kingAttackBonus;
      else score -= (val + pst + kingAttackBonus);
    }
  }

  if (wBishops >= 2) score += profile.bishopBonus;
  if (bBishops >= 2) score -= profile.bishopBonus;

  score += Math.round(evaluatePawnStructureAndEndgame(board, isEndgame, wKing, bKing, side) * (profile.structure || 1.3));

  const wAttack = evaluateKingAttackAndShield(board, "w");
  const bAttack = evaluateKingAttackAndShield(board, "b");
  score += Math.round((wAttack - bAttack) * (isEndgame ? 0.65 : 0.85));

  const matDiff = wMaterial - bMaterial;
  const kingsDist = Math.abs(wKing.r - bKing.r) + Math.abs(wKing.c - bKing.c);
  if (matDiff >= 350 && bMaterial <= 650) {
    const bKingCenterDist = Math.abs(bKing.r - 3.5) + Math.abs(bKing.c - 3.5);
    score += Math.round(bKingCenterDist * 48 + (14 - kingsDist) * 24);
  } else if (matDiff <= -350 && wMaterial <= 650) {
    const wKingCenterDist = Math.abs(wKing.r - 3.5) + Math.abs(wKing.c - 3.5);
    score -= Math.round(wKingCenterDist * 48 + (14 - kingsDist) * 24);
  }

  return side === "w" ? score : -score;
}

function generateMoves(board, turn, castling = "KQkq", epSquare = null) {
  const moves = [];
  const enemy = turn === "w" ? "b" : "w";
  const rookChar = turn === "w" ? "R" : "r";

  let epR = -1, epC = -1;
  if (epSquare && epSquare.length === 2) {
    epC = FILES.indexOf(epSquare[0]);
    epR = 8 - parseInt(epSquare[1], 10);
  }

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!isColor(p, turn)) continue;
      const type = p.toLowerCase();

      const push = (tr, tc, extra = {}) => {
        if (tr < 0 || tr > 7 || tc < 0 || tc > 7) return false;
        const target = board[tr][tc];
        if (isColor(target, turn)) return false;

        if (type === "p" && (tr === 0 || tr === 7)) {
          for (const promo of ["q", "r", "b", "n"]) {
            moves.push({
              fromR: r, fromC: c, toR: tr, toC: tc,
              piece: type,
              color: turn,
              captured: target ? target.toLowerCase() : null,
              promo
            });
          }
          return !target;
        }

        moves.push({
          fromR: r, fromC: c, toR: tr, toC: tc,
          piece: type,
          color: turn,
          captured: extra.isEnPassant ? "p" : (target ? target.toLowerCase() : null),
          isEnPassant: Boolean(extra.isEnPassant),
          promo: null
        });
        return !target;
      };

      if (type === "p") {
        const dir = turn === "w" ? -1 : 1;
        const startRow = turn === "w" ? 6 : 1;
        const epCaptureRow = turn === "w" ? 3 : 4;
        const enemyPawn = turn === "w" ? "p" : "P";
        if (r + dir >= 0 && r + dir <= 7 && !board[r + dir][c]) {
          push(r + dir, c);
          if (r === startRow && !board[r + dir * 2][c]) push(r + dir * 2, c);
        }
        for (const dc of [-1, 1]) {
          const nr = r + dir, nc = c + dc;
          if (nr >= 0 && nr <= 7 && nc >= 0 && nc <= 7) {
            if (isColor(board[nr][nc], enemy)) {
              push(nr, nc);
            } else if (
              r === epCaptureRow &&
              nr === epR &&
              nc === epC &&
              !board[nr][nc] &&
              board[r][nc] === enemyPawn
            ) {
              push(nr, nc, { isEnPassant: true });
            }
          }
        }
      } else if (type === "n") {
        for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) push(r + dr, c + dc);
      } else if (type === "k") {
        for (const [dr, dc] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]) push(r + dr, c + dc);

        const homeRow = turn === "w" ? 7 : 0;
        const canShort = turn === "w" ? castling.includes("K") : castling.includes("k");
        const canLong = turn === "w" ? castling.includes("Q") : castling.includes("q");

        if (r === homeRow && c === 4 && (canShort || canLong) && !isSquareAttacked(board, homeRow, 4, enemy)) {
          if (
            canShort &&
            board[homeRow][7] === rookChar &&
            !board[homeRow][5] &&
            !board[homeRow][6] &&
            !isSquareAttacked(board, homeRow, 5, enemy) &&
            !isSquareAttacked(board, homeRow, 6, enemy)
          ) {
            push(homeRow, 6);
          }
          if (
            canLong &&
            board[homeRow][0] === rookChar &&
            !board[homeRow][3] &&
            !board[homeRow][2] &&
            !board[homeRow][1] &&
            !isSquareAttacked(board, homeRow, 3, enemy) &&
            !isSquareAttacked(board, homeRow, 2, enemy)
          ) {
            push(homeRow, 2);
          }
        }
      } else {
        const dirs = [];
        if (type === "b" || type === "q") dirs.push([-1,-1],[-1,1],[1,-1],[1,1]);
        if (type === "r" || type === "q") dirs.push([-1,0],[1,0],[0,-1],[0,1]);
        for (const [dr, dc] of dirs) {
          let nr = r + dr, nc = c + dc;
          while (push(nr, nc)) { nr += dr; nc += dc; }
        }
      }
    }
  }
  return moves;
}

function makeMove(board, m) {
  const copy = board.map(r => r.slice());
  let p = copy[m.fromR][m.fromC];
  const isWhite = p === p.toUpperCase();

  if (m.piece === "p" && (m.toR === 0 || m.toR === 7)) {
    const promoChar = ["q", "r", "b", "n"].includes(m.promo) ? m.promo : "q";
    p = isWhite ? promoChar.toUpperCase() : promoChar;
  }

  if (m.isEnPassant) {
    copy[m.fromR][m.toC] = null;
  }

  if (m.piece === "k" && Math.abs(m.toC - m.fromC) === 2) {
    if (m.toC === 6) { copy[m.toR][5] = copy[m.toR][7]; copy[m.toR][7] = null; }
    if (m.toC === 2) { copy[m.toR][3] = copy[m.toR][0]; copy[m.toR][0] = null; }
  }

  copy[m.toR][m.toC] = p;
  copy[m.fromR][m.fromC] = null;
  return copy;
}

function updateCastlingAfterMove(castling, m) {
  if (!castling || castling === "-") return "-";
  let res = castling;
  if (m.piece === "k") {
    const color = m.color || (m.fromR >= 4 ? "w" : "b");
    res = color === "w" ? res.replace("K", "").replace("Q", "") : res.replace("k", "").replace("q", "");
  }
  if (m.fromR === 7 && m.fromC === 0) res = res.replace("Q", "");
  if (m.fromR === 7 && m.fromC === 7) res = res.replace("K", "");
  if (m.fromR === 0 && m.fromC === 0) res = res.replace("q", "");
  if (m.fromR === 0 && m.fromC === 7) res = res.replace("k", "");
  if (m.toR === 7 && m.toC === 0) res = res.replace("Q", "");
  if (m.toR === 7 && m.toC === 7) res = res.replace("K", "");
  if (m.toR === 0 && m.toC === 0) res = res.replace("q", "");
  if (m.toR === 0 && m.toC === 7) res = res.replace("k", "");
  return res || "-";
}

function getNextEpSquare(m) {
  if (m.piece === "p" && Math.abs(m.toR - m.fromR) === 2) {
    const midRow = (m.fromR + m.toR) / 2;
    return `${FILES[m.fromC]}${8 - midRow}`;
  }
  return null;
}

function moveKeyShort(m) {
  return `${m.fromR}${m.fromC}${m.toR}${m.toC}${m.promo || ""}`;
}

function generateLegalMoves(board, turn, castling = "KQkq", epSquare = null, ttMoveKey = null, ply = 0, budget = null) {
  checkSearchBudget(budget);
  const legal = generateMoves(board, turn, castling, epSquare).filter(
    m => {
      checkSearchBudget(budget);
      return !isKingInCheck(makeMove(board, m), turn);
    }
  );
  const killers = killerMoves[Math.min(15, ply)] || [null, null];

  legal.sort((a, b) => {
    const keyA = moveKeyShort(a);
    const keyB = moveKeyShort(b);
    if (ttMoveKey) {
      if (keyA === ttMoveKey) return -100000;
      if (keyB === ttMoveKey) return 100000;
    }
    const promoA = a.promo ? (a.promo === "q" ? 950 : 400) : 0;
    const promoB = b.promo ? (b.promo === "q" ? 950 : 400) : 0;
    const capA = a.captured ? PIECE_VALUES[a.captured] * 10 - PIECE_VALUES[a.piece] : 0;
    const capB = b.captured ? PIECE_VALUES[b.captured] * 10 - PIECE_VALUES[b.piece] : 0;
    const killerA = (keyA === killers[0] || keyA === killers[1]) ? 250 : 0;
    const killerB = (keyB === killers[0] || keyB === killers[1]) ? 250 : 0;
    const centerA = (a.toR >= 2 && a.toR <= 5 && a.toC >= 2 && a.toC <= 5) ? 15 : 0;
    const centerB = (b.toR >= 2 && b.toR <= 5 && b.toC >= 2 && b.toC <= 5) ? 15 : 0;
    return (promoB + capB + killerB + centerB) - (promoA + capA + killerA + centerA);
  });
  return legal;
}

function moveToText(m) {
  if (!m) return "";
  const pr = m.promo ? `=${m.promo.toUpperCase()}` : "";
  return `${FILES[m.fromC]}${8 - m.fromR}→${FILES[m.toC]}${8 - m.toR}${pr}`;
}

function quiescence(board, turn, alpha, beta, style, castling = "-", epSquare = null, qd = 0, maxQd = 4, ply = 0, halfmoveClock = 0, budget = null) {
  checkSearchBudget(budget);
  const inCheck = isKingInCheck(board, turn);
  const allMoves = generateMoves(board, turn, castling, epSquare);

  if (halfmoveClock >= 100) {
    const hasLegalMove = allMoves.some(move => {
      checkSearchBudget(budget);
      return !isKingInCheck(makeMove(board, move), turn);
    });
    if (!hasLegalMove) return inCheck ? -20000 + ply * 20 : 0;
    return 0;
  }

  let bestScore = -30000;
  if (!inCheck) {
    let hasAnyLegal = false;
    for (let i = 0; i < allMoves.length; i++) {
      checkSearchBudget(budget);
      if (!isKingInCheck(makeMove(board, allMoves[i]), turn)) {
        hasAnyLegal = true;
        break;
      }
    }
    if (!hasAnyLegal) return 0;

    const pat = evaluateBoard(board, turn, style);
    if (qd >= maxQd) return pat;
    if (pat >= beta) return pat;
    bestScore = pat;
    if (pat > alpha) alpha = pat;
  } else if (qd >= maxQd + 1) {
    return evaluateBoard(board, turn, style);
  }

  const enemy = turn === "w" ? "b" : "w";
  const candidates = inCheck
    ? allMoves
    : allMoves.filter(m => m.captured || m.promo);

  candidates.sort((a, b) => {
    const ca = a.captured ? PIECE_VALUES[a.captured] * 10 - PIECE_VALUES[a.piece] : 0;
    const cb = b.captured ? PIECE_VALUES[b.captured] * 10 - PIECE_VALUES[b.piece] : 0;
    return cb - ca;
  });

  let legalFound = 0;
  for (const m of candidates) {
    checkSearchBudget(budget);
    const nextB = makeMove(board, m);
    if (isKingInCheck(nextB, turn)) continue;
    legalFound++;

    if (!inCheck && !m.promo && m.captured && PIECE_VALUES[m.piece] > PIECE_VALUES[m.captured]) {
      const seeScore = seeExchangeScore(nextB, m.toR, m.toC, m.piece, m.captured, turn);
      if (seeScore < -80 && !isKingInCheck(nextB, enemy)) continue;
    }

    const nextCastling = updateCastlingAfterMove(castling, m);
    const nextEp = getNextEpSquare(m);
    const nextHalfmoveClock = m.piece === "p" || m.captured ? 0 : halfmoveClock + 1;
    const s = -quiescence(nextB, enemy, -beta, -alpha, style, nextCastling, nextEp, qd + 1, maxQd, ply + 1, nextHalfmoveClock, budget);
    if (s > bestScore) bestScore = s;
    if (s >= beta) return s;
    if (s > alpha) alpha = s;
  }

  if (inCheck && legalFound === 0) {
    return -20000 + ply * 20;
  }
  return bestScore;
}

function searchPV(
  board,
  turn,
  depth,
  alpha,
  beta,
  style,
  castling = "-",
  epSquare = null,
  extUsed = 0,
  dangerMode = false,
  ply = 0,
  halfmoveClock = 0,
  budget = null
) {
  checkSearchBudget(budget);
  if (depth <= 0) {
    return { score: quiescence(board, turn, alpha, beta, style, castling, epSquare, 0, dangerMode ? 5 : 4, ply, halfmoveClock, budget), pv: [] };
  }

  const baseHash = boardToHash(board, turn, castling, epSquare, halfmoveClock);
  const ttKey = `${baseHash}_${style}_${dangerMode ? 1 : 0}_${extUsed}`;
  const cached = transpositionTable.get(ttKey);
  if (cached && cached.depth >= depth && Math.abs(cached.res.score) < 18000) {
    if (cached.flag === "EXACT") return cached.res;
    if (cached.flag === "LOWER" && cached.res.score >= beta) return cached.res;
    if (cached.flag === "UPPER" && cached.res.score <= alpha) return cached.res;
  }

  const ttMoveKey = cached?.bestKey || null;

  const legal = generateLegalMoves(board, turn, castling, epSquare, ttMoveKey, ply, budget);
  if (legal.length === 0) {
    const mateScore = isKingInCheck(board, turn) ? -20000 + ply * 20 : 0;
    return { score: mateScore, pv: [] };
  }
  if (halfmoveClock >= 100) return { score: 0, pv: [] };

  const enemy = turn === "w" ? "b" : "w";
  let bestScore = -Infinity;
  let bestPV = [];
  let bestKey = null;
  const origAlpha = alpha;

  for (let i = 0; i < legal.length; i++) {
    checkSearchBudget(budget);
    const m = legal[i];
    const nextB = makeMove(board, m);
    const nextCastling = updateCastlingAfterMove(castling, m);
    const nextEp = getNextEpSquare(m);
    const nextHalfmoveClock = m.piece === "p" || m.captured ? 0 : halfmoveClock + 1;
    const givesChk = extUsed < 2 && isKingInCheck(nextB, enemy);

    let nextDepth = givesChk ? depth : depth - 1;
    if (!dangerMode && !givesChk && !m.captured && !m.promo && depth >= 3 && i >= 8) {
      nextDepth = depth - 2;
    }

    let child = searchPV(
      nextB,
      enemy,
      nextDepth,
      -beta,
      -alpha,
      style,
      nextCastling,
      nextEp,
      givesChk ? extUsed + 1 : extUsed,
      dangerMode,
      ply + 1,
      nextHalfmoveClock,
      budget
    );
    let score = -child.score;

    if (nextDepth < depth - 1 && score > alpha) {
      child = searchPV(
        nextB,
        enemy,
        depth - 1,
        -beta,
        -alpha,
        style,
        nextCastling,
        nextEp,
        extUsed,
        dangerMode,
        ply + 1,
        nextHalfmoveClock,
        budget
      );
      score = -child.score;
    }

    if (score > bestScore) {
      bestScore = score;
      bestPV = [moveToText(m), ...child.pv];
      bestKey = moveKeyShort(m);
    }
    if (score > alpha) alpha = score;
    if (alpha >= beta) {
      if (!m.captured && !m.promo && ply < 16) {
        const kKey = moveKeyShort(m);
        if (killerMoves[ply][0] !== kKey) {
          killerMoves[ply][1] = killerMoves[ply][0];
          killerMoves[ply][0] = kKey;
        }
      }
      break;
    }
  }

  const res = { score: bestScore, pv: bestPV };
  checkSearchBudget(budget);
  const flag = bestScore <= origAlpha ? "UPPER" : (bestScore >= beta ? "LOWER" : "EXACT");
  const tableLimit = globalThis.__CC_ENGINE_RUNTIME__ || globalThis.__CC_DEVICE_PROFILE__?.recommendation ? 12000 : TT_MAX_ENTRIES;
  if (transpositionTable.size >= tableLimit) transpositionTable.clear();
  if (!cached || depth >= cached.depth) {
    transpositionTable.set(ttKey, { depth, flag, res, bestKey });
  }
  return res;
}

function allowsEnemyMateInOne(boardAfterOurMove, ourColor, enemyColor, castling, epSquare, budget = null) {
  checkSearchBudget(budget);
  const enemyReplies = generateLegalMoves(boardAfterOurMove, enemyColor, castling, epSquare, null, 0, budget);
  for (const em of enemyReplies) {
    checkSearchBudget(budget);
    const afterEnemy = makeMove(boardAfterOurMove, em);
    if (isKingInCheck(afterEnemy, ourColor)) {
      const nextCast = updateCastlingAfterMove(castling, em);
      const nextEp = getNextEpSquare(em);
      const ourEscapes = generateLegalMoves(afterEnemy, ourColor, nextCast, nextEp, null, 0, budget);
      if (ourEscapes.length === 0) return true;
    }
  }
  return false;
}

function deliversForcedMateInTwo(boardAfterOurMove, ourColor, enemyColor, castling, epSquare, budget = null) {
  checkSearchBudget(budget);
  const enemyReplies = generateLegalMoves(boardAfterOurMove, enemyColor, castling, epSquare, null, 0, budget);
  if (enemyReplies.length === 0 || enemyReplies.length > 10) return false;

  for (const er of enemyReplies) {
    checkSearchBudget(budget);
    const afterEnemy = makeMove(boardAfterOurMove, er);
    const nextCast = updateCastlingAfterMove(castling, er);
    const nextEp = getNextEpSquare(er);
    if (!allowsEnemyMateInOne(afterEnemy, enemyColor, ourColor, nextCast, nextEp, budget)) {
      return false;
    }
  }
  return true;
}

function allowsEnemyForcedMateInTwo(boardAfterOurMove, ourColor, enemyColor, castling, epSquare, budget = null) {
  checkSearchBudget(budget);
  const enemyMoves = generateLegalMoves(boardAfterOurMove, enemyColor, castling, epSquare, null, 0, budget);
  const ourKing = findKing(boardAfterOurMove, ourColor);

  for (const em of enemyMoves) {
    checkSearchBudget(budget);
    const afterEnemy = makeMove(boardAfterOurMove, em);
    const givesChk = isKingInCheck(afterEnemy, ourColor);
    const nearOurKing = Math.abs(em.toR - ourKing.r) <= 2 && Math.abs(em.toC - ourKing.c) <= 2;

    if (!givesChk && !em.captured && !nearOurKing) continue;

    if (!givesChk) {
      const seeEnemy = seeExchangeScore(afterEnemy, em.toR, em.toC, em.piece, em.captured, enemyColor);
      if (seeEnemy < -250) continue;
    }

    const nextCast = updateCastlingAfterMove(castling, em);
    const nextEp = getNextEpSquare(em);
    const ourDefenses = generateLegalMoves(afterEnemy, ourColor, nextCast, nextEp, null, 0, budget);

    if (ourDefenses.length === 0) {
      if (givesChk) return true;
      continue;
    }

    if (ourDefenses.length <= 9) {
      let allResponsesGetMated = true;
      for (const def of ourDefenses) {
        checkSearchBudget(budget);
        const afterDef = makeMove(afterEnemy, def);
        const defCast = updateCastlingAfterMove(nextCast, def);
        const defEp = getNextEpSquare(def);
        if (!allowsEnemyMateInOne(afterDef, ourColor, enemyColor, defCast, defEp, budget)) {
          allResponsesGetMated = false;
          break;
        }
      }
      if (allResponsesGetMated) return true;
    }
  }
  return false;
}

function detectKingDangerState(board, ourColor, enemyColor, inCheckBefore, threatBefore, castling = "-", epSquare = null, budget = null) {
  if (inCheckBefore) return { isDanger: true, reason: "ШАХ НАШЕМУ КОРОЛЮ" };

  if (allowsEnemyMateInOne(board, ourColor, enemyColor, castling, epSquare, budget)) {
    return { isDanger: true, reason: "ПРЯМАЯ УГРОЗА МАТА В 1 ХОД ОТ СОПЕРНИКА" };
  }

  if (allowsEnemyForcedMateInTwo(board, ourColor, enemyColor, castling, epSquare, budget)) {
    return { isDanger: true, reason: "УГРОЗА ФОРСИРОВАННОГО МАТА В 2 ХОДА" };
  }

  const ourKing = findKing(board, ourColor);
  let attackedKingSquares = 0;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const kr = ourKing.r + dr, kc = ourKing.c + dc;
      if (kr >= 0 && kr <= 7 && kc >= 0 && kc <= 7) {
        if (isSquareAttacked(board, kr, kc, enemyColor)) {
          attackedKingSquares++;
        }
      }
    }
  }

  if (attackedKingSquares >= 2) {
    return { isDanger: true, reason: "ДАВЛЕНИЕ НА ЗОНУ НАШЕГО КОРОЛЯ" };
  }
  if (threatBefore >= 320 && attackedKingSquares >= 1) {
    return { isDanger: true, reason: "ТАКТИЧЕСКИЙ УДАР ПО ФИГУРЕ И КОРОЛЮ" };
  }

  return { isDanger: false, reason: "" };
}

function getHangingDetails(board, ourSide, budget = null) {
  let worstLoss = 0;
  let hangingSquare = null;

  for (let r = 0; r < 8; r++) {
    checkSearchBudget(budget);
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!isColor(p, ourSide)) continue;
      const pieceType = p.toLowerCase();
      if (pieceType === "k") continue;

      const netLoss = Math.max(0, -seeExchangeScore(board, r, c, pieceType, null, ourSide));

      if (netLoss > worstLoss) {
        worstLoss = netLoss;
        hangingSquare = `${FILES[c]}${8 - r}`;
      }
    }
  }
  return { worstLoss, hangingSquare };
}

function detectForkMotif(boardAfter, movedR, movedC, ourSide) {
  const enemy = ourSide === "w" ? "b" : "w";
  const ourPiece = boardAfter[movedR][movedC];
  if (!ourPiece) return false;
  const ourVal = PIECE_VALUES[ourPiece.toLowerCase()] || 100;

  if (seeExchangeScore(boardAfter, movedR, movedC, ourPiece.toLowerCase(), null, ourSide) < 0) {
    return false;
  }

  const nextAttacks = generateMoves(boardAfter, ourSide, "-", null).filter(
    m => m.fromR === movedR && m.fromC === movedC && m.captured
  );

  let valuableTargets = 0;
  for (const att of nextAttacks) {
    const targetVal = PIECE_VALUES[att.captured] || 0;
    const targetProtected = isSquareAttacked(boardAfter, att.toR, att.toC, enemy);
    if (targetVal > ourVal || (targetVal >= 300 && !targetProtected) || att.captured === "k") {
      valuableTargets++;
    }
  }
  return valuableTargets >= 2;
}

function detectPinMotif(boardAfter, movedR, movedC, ourSide) {
  const p = boardAfter[movedR][movedC];
  if (!p) return false;
  const type = p.toLowerCase();
  if (type !== "b" && type !== "r" && type !== "q") return false;

  const dirs = [];
  if (type === "b" || type === "q") dirs.push([-1,-1],[-1,1],[1,-1],[1,1]);
  if (type === "r" || type === "q") dirs.push([-1,0],[1,0],[0,-1],[0,1]);

  for (const [dr, dc] of dirs) {
    let nr = movedR + dr, nc = movedC + dc;
    let firstEnemy = null;
    while (nr >= 0 && nr <= 7 && nc >= 0 && nc <= 7) {
      const sqP = boardAfter[nr][nc];
      if (sqP) {
        if (isColor(sqP, ourSide)) break;
        if (!firstEnemy) {
          firstEnemy = sqP.toLowerCase();
        } else {
          const secondEnemy = sqP.toLowerCase();
          if (secondEnemy === "k" || (secondEnemy === "q" && firstEnemy !== "p")) {
            return true;
          }
          break;
        }
      }
      nr += dr;
      nc += dc;
    }
  }
  return false;
}

function computeTrapMetrics(boardAfterOurMove, ourMove, ourColor, enemyColor, castling, epSquare, style = "tal", budget = null) {
  checkSearchBudget(budget);
  const enemyReplies = generateLegalMoves(boardAfterOurMove, enemyColor, castling, epSquare, null, 0, budget);
  const totalReplies = enemyReplies.length;
  if (totalReplies < 5) {
    return { isTrap: false, trapChance: 0, badReplies: 0, totalReplies, complexityBranches: totalReplies };
  }

  let losingReplies = 0;
  let matePunishments = 0;
  let queenRookPunishments = 0;
  let savingMoves = [];
  let greedyBaitCapturesMove = false;

  for (const er of enemyReplies) {
    checkSearchBudget(budget);
    const afterEnemy = makeMove(boardAfterOurMove, er);
    const nextCast = updateCastlingAfterMove(castling, er);
    const nextEp = getNextEpSquare(er);

    const getsMatedInOne = allowsEnemyMateInOne(afterEnemy, enemyColor, ourColor, nextCast, nextEp, budget);
    if (getsMatedInOne) {
      losingReplies++;
      matePunishments++;
      if (er.toR === ourMove.toR && er.toC === ourMove.toC) greedyBaitCapturesMove = true;
      continue;
    }

    const { worstLoss: enemyHanging } = getHangingDetails(afterEnemy, enemyColor, budget);
    const enemySee = seeExchangeScore(afterEnemy, er.toR, er.toC, er.piece, er.captured, enemyColor);
    const staticOurScore = -evaluateBoard(afterEnemy, enemyColor, style);

    const netEnemyDisaster = enemyHanging >= 310 || enemySee <= -260 || staticOurScore >= 260;
    if (netEnemyDisaster) {
      losingReplies++;
      if (enemyHanging >= 480 || enemySee <= -450) queenRookPunishments++;
      if (er.toR === ourMove.toR && er.toC === ourMove.toC) greedyBaitCapturesMove = true;
    } else {
      savingMoves.push(er);
    }
  }

  const rawErrorRatio = losingReplies / totalReplies;
  const onlyFewSaves = savingMoves.length >= 1 && savingMoves.length <= 2;

  const baitBonus = greedyBaitCapturesMove ? 8 : 0;
  const trapChance = Math.min(98, Math.round(rawErrorRatio * 100) + baitBonus);

  const isTrap =
    onlyFewSaves &&
    trapChance >= 78 &&
    (matePunishments > 0 || queenRookPunishments > 0 || greedyBaitCapturesMove || losingReplies >= 6);

  let trapSubtitle = "";
  if (isTrap) {
    const saveMoveUci = savingMoves[0]
      ? `${FILES[savingMoves[0].fromC]}${8 - savingMoves[0].fromR}→${FILES[savingMoves[0].toC]}${8 - savingMoves[0].toR}`
      : "неочевиден";
    const punishDesc = matePunishments > 0
      ? "скрытому мату"
      : (queenRookPunishments > 0 ? "потере ферзя/ладьи" : "разгрому позиции");
    trapSubtitle = `Из ${totalReplies} ответов врага ${losingReplies} ведут к ${punishDesc}! Единственное спасение (${saveMoveUci}) крайне трудно найти.`;
  }

  return {
    isTrap,
    trapChance,
    badReplies: losingReplies,
    totalReplies,
    onlySaveMove: savingMoves[0] ? moveToText(savingMoves[0]) : null,
    trapSubtitle,
    complexityBranches: totalReplies
  };
}

function detectLastOpponentMove(prevBoard, currBoard, opponentColor) {
  if (!prevBoard || !currBoard) return null;
  let diffSquares = 0;
  let fromSq = null;
  let toSq = null;
  let movedPiece = "p";
  let fromRow = -1, toRow = -1, colIndex = -1;

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const pOld = prevBoard[r][c];
      const pNew = currBoard[r][c];
      if (pOld !== pNew) {
        diffSquares++;
        if (isColor(pOld, opponentColor) && !isColor(pNew, opponentColor)) {
          if (!fromSq || pOld.toLowerCase() === "k") {
            fromSq = `${FILES[c]}${8 - r}`;
            movedPiece = pOld.toLowerCase();
            fromRow = r;
            colIndex = c;
          }
        }
        if (isColor(pNew, opponentColor) && !isCol(pOld, opponentColor)) {
          if (!toSq || pNew.toLowerCase() === "k") {
            toSq = `${FILES[c]}${8 - r}`;
            movedPiece = pNew.toLowerCase();
            toRow = r;
          }
        }
      }
    }
  }

  if (diffSquares > 8 || diffSquares === 0) return null;
  if (fromSq && toSq) {
    const isDoublePawnPush = movedPiece === "p" && Math.abs(toRow - fromRow) === 2;
    const epTarget = isDoublePawnPush ? `${FILES[colIndex]}${8 - (fromRow + toRow) / 2}` : null;
    return { from: fromSq, to: toSq, piece: movedPiece, color: opponentColor, epTarget };
  }
  return null;
}

function computeSmartNextPremove(
  boardOnEnemyTurn,
  myColor,
  enemyColor,
  castling,
  epSquare,
  lastOurMove,
  style = "tal",
  recentPositions = [],
  clientPredictedEnemyUci = null,
  clientPredictionConfidence = 0,
  budget = createSearchBudget(40, 2000)
) {
  checkSearchBudget(budget);
  const enemyMoves = generateLegalMoves(boardOnEnemyTurn, enemyColor, castling, epSquare, null, 0, budget);
  if (enemyMoves.length === 0) return null;

  const recentSet = new Set(recentPositions.slice(-256));
  const wasBoardSeenRecently = (boardPart) => recentSet.has(boardPart) || [...recentSet].some(key => key.startsWith(`${boardPart} `));

  const enemyScored = enemyMoves.map((em) => {
    checkSearchBudget(budget);
    const nb = makeMove(boardOnEnemyTurn, em);
    const nextCast = updateCastlingAfterMove(castling, em);
    const nextEp = getNextEpSquare(em);
    const seeScore = seeExchangeScore(nb, em.toR, em.toC, em.piece, em.captured, enemyColor);
    const { worstLoss: enemyHangingLoss } = getHangingDetails(nb, enemyColor, budget);
    const { worstLoss: ourHangingAfterEnemy } = getHangingDetails(nb, myColor, budget);

    const givesCheck = isKingInCheck(nb, myColor);
    const isEnemyMateInOne = givesCheck && generateLegalMoves(nb, myColor, nextCast, nextEp, null, 0, budget).length === 0;
    if (isEnemyMateInOne) {
      return { em, nb, nextCast, nextEp, seeScore: 9999, ourHangingAfterEnemy: 9999, score: 50000 };
    }

    const blunderPenalty = seeScore < -50 ? seeScore * 3.2 : seeScore * 1.1;
    const hangingPenalty = enemyHangingLoss > 80 ? -enemyHangingLoss * 1.4 : 0;
    const attackOurPieceBonus = ourHangingAfterEnemy >= 150 && seeScore >= -30 ? ourHangingAfterEnemy * 0.65 : 0;
    const safeCheckBonus = (givesCheck && seeScore >= 0) ? 45 : 0;
    const enemyUci = `${FILES[em.fromC]}${8 - em.fromR}${FILES[em.toC]}${8 - em.toR}${em.promo || ""}`;
    const clientPredictionBonus = clientPredictedEnemyUci === enemyUci
      ? 70 + Math.min(150, Math.max(0, clientPredictionConfidence) * 1.5)
      : 0;

    const evalScore = evaluateBoard(nb, enemyColor, style) + blunderPenalty + hangingPenalty + attackOurPieceBonus + safeCheckBonus + clientPredictionBonus;
    return { em, nb, nextCast, nextEp, seeScore, ourHangingAfterEnemy, score: evalScore };
  });

  enemyScored.sort((a, b) => b.score - a.score);

  const topScore = enemyScored[0].score;
  const reasonableEnemyMoves = enemyScored.filter(
    (item, idx) =>
      idx === 0 ||
      (item.seeScore >= -80 && (topScore - item.score) <= 220) ||
      (item.seeScore >= -30 && item.ourHangingAfterEnemy >= 200)
  ).slice(0, 10);

  // A score gap is converted into a conservative probability instead of the old
  // fixed 87/95% labels. This keeps quiet positions from looking "forced".
  let likelihoodTotal = 0;
  for (const item of reasonableEnemyMoves) {
    checkSearchBudget(budget);
    item.likelihood = Math.exp(Math.max(-7, Math.min(0, (item.score - topScore) / 105)));
    likelihoodTotal += item.likelihood;
  }
  const topPredictionConfidence = enemyMoves.length === 1
    ? 99
    : Math.max(20, Math.min(97, Math.round((reasonableEnemyMoves[0].likelihood / Math.max(1, likelihoodTotal)) * 100)));

  // Validate against enough likely continuations, but keep instant-premoves fast.
  const dangerousOrReasonableEnemyMoves = reasonableEnemyMoves.slice(0, 6);

  const topEnemy = enemyScored[0];
  const secondEnemy = enemyScored[1] || null;
  const scoreGap = secondEnemy ? (topEnemy.score - secondEnemy.score) : 999;

  const enemyFrom = `${FILES[topEnemy.em.fromC]}${8 - topEnemy.em.fromR}`;
  const enemyTo = `${FILES[topEnemy.em.toC]}${8 - topEnemy.em.toR}`;

  const ourReplies = generateLegalMoves(topEnemy.nb, myColor, topEnemy.nextCast, topEnemy.nextEp, null, 0, budget);
  if (ourReplies.length === 0) return null;

  const validPremoveReplies = ourReplies.filter(
    (m) => isColor(boardOnEnemyTurn[m.fromR][m.fromC], myColor) && (!m.promo || m.promo === "q")
  );
  if (validPremoveReplies.length === 0) return null;

  const scoreReply = (branch, m) => {
    checkSearchBudget(budget);
    const afterOur = makeMove(branch.nb, m);
    const afterOurCast = updateCastlingAfterMove(branch.nextCast, m);
    const afterOurEp = getNextEpSquare(m);
    const givesCheck = isKingInCheck(afterOur, enemyColor);
    const enemyLegalAfterOur = generateLegalMoves(afterOur, enemyColor, afterOurCast, afterOurEp, null, 0, budget);

    const isMateIn1 = givesCheck && enemyLegalAfterOur.length === 0;
    const isStalemate = !givesCheck && enemyLegalAfterOur.length === 0;
    if (isStalemate) {
      return { m, score: -50000, ourSee: -9999, worstLoss: 9999, gained: 0, isRealRecapture: false, isStalemate: true, safe: false };
    }
    if (isMateIn1) {
      return { m, score: 100000, ourSee: 999, worstLoss: 0, gained: 999, isRealRecapture: false, isMateIn1: true, safe: true };
    }

    if (allowsEnemyMateInOne(afterOur, myColor, enemyColor, afterOurCast, afterOurEp, budget)) {
      return { m, score: -45000, ourSee: -9999, worstLoss: 9999, gained: 0, isRealRecapture: false, safe: false };
    }

    const ourSee = seeExchangeScore(afterOur, m.toR, m.toC, m.piece, m.captured, myColor);
    const { worstLoss } = getHangingDetails(afterOur, myColor, budget);
    const gained = m.captured ? (PIECE_VALUES[m.captured] || 100) : 0;

    const seePenalty = ourSee < -40 ? ourSee * 3.0 : ourSee;
    const hangingPen = worstLoss > gained + 25 ? -(worstLoss - gained) * 2.4 : 0;

    const boardPartAfter = boardToFenPart(afterOur);
    const ourFromSq = `${FILES[m.fromC]}${8 - m.fromR}`;
    const ourToSq = `${FILES[m.toC]}${8 - m.toR}`;
    const isBackAndForth = lastOurMove && ourFromSq === lastOurMove.to && ourToSq === lastOurMove.from && !m.captured;
    const repPen = (wasBoardSeenRecently(boardPartAfter) ? -1800 : 0) + (isBackAndForth ? -600 : 0);

    const isRealRecapture =
      m.toR === branch.em.toR &&
      m.toC === branch.em.toC &&
      m.captured &&
      branch.seeScore >= -50 &&
      ourSee >= -20 &&
      worstLoss <= gained + 50;

    const recapBonus = isRealRecapture ? 120 : 0;
    const cutEnemyKingMobilityBonus = Math.max(0, (12 - enemyLegalAfterOur.length) * 14);
    const s = evaluateBoard(afterOur, myColor, style) + seePenalty + hangingPen + recapBonus + repPen + cutEnemyKingMobilityBonus;
    const safe = s >= -3000 && ourSee >= -60 && worstLoss <= gained + 80;
    return { m, score: s, ourSee, worstLoss, gained, isRealRecapture, isStalemate: false, safe };
  };

  const scoredReplies = validPremoveReplies.map((m) => scoreReply(topEnemy, m));

  scoredReplies.sort((a, b) => b.score - a.score);
  const robustReplies = [];
  for (const topReply of scoredReplies.filter(item => item.safe).slice(0, 8)) {
    checkSearchBudget(budget);
    const outcomes = [topReply];
    let weightedScore = topReply.score * topEnemy.likelihood;
    let branchWeight = topEnemy.likelihood;
    let allBranchesSafe = true;

    for (let i = 1; i < dangerousOrReasonableEnemyMoves.length; i++) {
      checkSearchBudget(budget);
      const branch = dangerousOrReasonableEnemyMoves[i];
      const branchReplies = generateLegalMoves(branch.nb, myColor, branch.nextCast, branch.nextEp, null, 0, budget);
      const matchingMove = branchReplies.find((m) =>
        m.fromR === topReply.m.fromR && m.fromC === topReply.m.fromC &&
        m.toR === topReply.m.toR && m.toC === topReply.m.toC &&
        (m.promo || null) === (topReply.m.promo || null)
      );
      if (!matchingMove) {
        allBranchesSafe = false;
        break;
      }
      const outcome = scoreReply(branch, matchingMove);
      outcomes.push(outcome);
      if (!outcome.safe) {
        allBranchesSafe = false;
        break;
      }
      weightedScore += outcome.score * branch.likelihood;
      branchWeight += branch.likelihood;
    }

    if (allBranchesSafe) {
      const worstScore = Math.min(...outcomes.map(outcome => outcome.score));
      const expectedScore = weightedScore / Math.max(0.001, branchWeight);
      robustReplies.push({
        ...topReply,
        outcomes,
        robustScore: expectedScore + worstScore * 0.18,
        validatedBranches: outcomes.length
      });
    }
  }

  robustReplies.sort((a, b) => b.robustScore - a.robustScore);
  const bestReplyObj = robustReplies[0];
  if (!bestReplyObj) return { canPremove: false, predictionConfidence: topPredictionConfidence };

  const rm = bestReplyObj.m;
  const ourFrom = `${FILES[rm.fromC]}${8 - rm.fromR}`;
  const ourTo = `${FILES[rm.toC]}${8 - rm.toR}`;
  const safeAgainstTopBranches = bestReplyObj.validatedBranches === dangerousOrReasonableEnemyMoves.length;

  let confidence = 0;
  let predictionType = "pv_lookahead";
  let reasonText = `🔮 ПРЕМУВ НА 1-Ю ЛИНИЮ ВРАГА (${enemyFrom}→${enemyTo})`;

  if (bestReplyObj.isMateIn1 && safeAgainstTopBranches) {
    confidence = 99;
    predictionType = "mate_premove";
    reasonText = `👑 МАТОВЫЙ ПРЕМУВ В 1 ХОД (${ourFrom}→${ourTo}#)`;
  } else if (enemyMoves.length === 1 && safeAgainstTopBranches) {
    confidence = 99;
    predictionType = "forced_single";
    reasonText = `⚡ 100% ФОРСАЖ: У врага 1 легальный ход (${enemyFrom}→${enemyTo})`;
  } else if (bestReplyObj.isRealRecapture && topPredictionConfidence >= 72) {
    confidence = Math.min(96, topPredictionConfidence + 7);
    predictionType = "recapture";
    reasonText = `⚔ ПЕРЕБОЙ НА ${ourTo.toUpperCase()} (ПРОГНОЗ ${topPredictionConfidence}%: ${enemyFrom}→${enemyTo})`;
  } else if (bestReplyObj.isRealRecapture) {
    confidence = 82;
    predictionType = "safe_universal";
    reasonText = `🛡 ПЕРЕБОЙ БЕЗ РИСКА ПРОТИВ ${bestReplyObj.validatedBranches} ЛИНИЙ`;
  } else if (scoreGap >= 200 && topEnemy.seeScore >= 0 && safeAgainstTopBranches) {
    confidence = Math.max(82, Math.min(94, topPredictionConfidence + 5));
    predictionType = "forced_tactical";
    reasonText = `⚡ ФОРСИРОВАННЫЙ ПРОГНОЗ ${topPredictionConfidence}% (${enemyFrom}→${enemyTo})`;
  } else if (safeAgainstTopBranches && bestReplyObj.ourSee >= 0 && bestReplyObj.worstLoss <= 50) {
    confidence = Math.min(91, 78 + bestReplyObj.validatedBranches * 2);
    predictionType = "safe_universal";
    reasonText = `🛡 УНИВЕРСАЛЬНЫЙ ПРЕМУВ ПРОТИВ ${bestReplyObj.validatedBranches} ТОП-ЛИНИЙ`;
  } else {
    return { canPremove: false };
  }

  return {
    canPremove: true,
    confidence,
    predictionConfidence: topPredictionConfidence,
    validatedBranches: bestReplyObj.validatedBranches,
    predictionType,
    reasonText,
    forMoveUci: lastOurMove ? lastOurMove.uci : null,
    predictedEnemyMove: { from: enemyFrom, to: enemyTo, uci: `${enemyFrom}${enemyTo}` },
    premove: {
      from: ourFrom,
      to: ourTo,
      promo: rm.promo || null,
      uci: `${ourFrom}${ourTo}${rm.promo || ""}`,
      piece: rm.piece
    }
  };
}

async function analyzeAdaptiveMaster(
  fen,
  elo,
  style = "tal",
  pass = "fast",
  clientLastEnemyMove = null,
  bulletTurbo = false,
  calcAverage = true,
  calcWorst = true,
  myColor = "w",
  mySeconds = 999,
  enemySeconds = 999,
  trapRadarEnabled = true,
  recentPositions = [],
  lastOurMove = null,
  analysisContextKey = "default",
  uciHistory = [],
  historyTrusted = false,
  analysisMeta = null,
  signal = null
) {
  if (!validateEngineFen(fen)) throw new Error("Invalid analysis FEN");
  if (signal?.aborted || !isAnalysisGenerationCurrent(analysisMeta, analysisContextKey)) throw SEARCH_SUPERSEDED;
  const { board, turn, castling, epSquare: fenEp, halfmoveClock, pieceCount, boardKey } = parseFEN(fen);
  const enemy = turn === "w" ? "b" : "w";
  const lastAnalyzedState = analyzedStateByClient.get(analysisContextKey) || createAnalyzedState();

  let detectedOppMove = null;
  if (clientLastEnemyMove && clientLastEnemyMove.from && clientLastEnemyMove.to) {
    detectedOppMove = clientLastEnemyMove;
  } else if (lastAnalyzedState.board) {
    detectedOppMove = detectLastOpponentMove(lastAnalyzedState.board, board, enemy);
  }
  // FEN is authoritative. A client-side move detector may be stale after navigation,
  // reconnects, or takebacks and must never manufacture an en-passant right.
  const activeEpSquare = fenEp;

  let legal = generateLegalMoves(board, turn, castling, activeEpSquare);
  if (legal.length === 0) return { best: null, average: null, worst: null };
  if (halfmoveClock >= 100) {
    return { best: null, average: null, worst: null, drawReason: "fifty-move" };
  }

  const inCheckBefore = isKingInCheck(board, turn);
  const deviceProfile = globalThis.__CC_DEVICE_PROFILE__;
  const recommendation = deviceProfile?.recommendation || {};
  const mobile = Boolean(globalThis.__CC_ENGINE_RUNTIME__ || deviceProfile?.recommendation);
  const constrained = Boolean(deviceProfile?.power?.saveMode || deviceProfile?.power?.backgroundRestricted || Number(deviceProfile?.power?.thermalStatus) >= 2);
  const tier = constrained ? "LOW" : String(recommendation.tier || "BALANCED").toUpperCase();
  const annotationOnly = Boolean(mobile && pass === "deep" && analysisMeta?.annotationOnly === true &&
    ownedAnnotationCurrent(analysisMeta, fen, analysisContextKey));
  if (mobile && analysisMeta?.annotationOnly === true && !annotationOnly) throw SEARCH_SUPERSEDED;
  const rawTimeBudgetMs = pass === "fast" ? (bulletTurbo ? 26 : 48) : (inCheckBefore ? 340 : bulletTurbo ? 95 : 235);
  const phoneBudgetCap = annotationOnly ? 32 : pass === "fast" ? (tier === "LOW" ? 24 : tier === "HIGH" ? 40 : 32) : (tier === "LOW" ? 60 : tier === "HIGH" ? 120 : 90);
  const deviceMovetimeScale = Math.max(0.5, Math.min(mobile ? 1 : 1.5, Number(recommendation.movetimeScale) || 1));
  const timeBudgetMs = Math.max(18, Math.min(mobile ? phoneBudgetCap : 510, Math.round(rawTimeBudgetMs * deviceMovetimeScale)));
  const budget = createSearchBudget(timeBudgetMs, Math.min(mobile ? 6000 : 50000, timeBudgetMs * 100));
  budget.isCurrent = () => !signal?.aborted && isAnalysisGenerationCurrent(analysisMeta, analysisContextKey);
  let fallbackScore = 0;
  // Unwind incomplete proof/search frames before constructing a legal fallback.
  try {
  checkSearchBudget(budget);
  const nonPawnMaterial = countNonPawnMaterial(board);
  const isEndgame = nonPawnMaterial <= 2200;
  const isPawnEndgame = nonPawnMaterial <= 650;
  // Core search remains style-neutral; style bonuses are applied only after
  // objective tactical and draw safety has been established.
  const objectiveStyle = "balanced";
  const staticEvalBefore = evaluateBoard(board, turn, objectiveStyle);
  fallbackScore = Math.max(-1200, Math.min(1200, staticEvalBefore));

  const positionCounts = new Map();
  if (Array.isArray(recentPositions)) {
    for (const posHash of recentPositions.slice(-256)) {
      checkSearchBudget(budget);
      if (!posHash) continue;
      positionCounts.set(posHash, (positionCounts.get(posHash) || 0) + 1);
    }
  }

  const enemyKingPos = findKing(board, enemy);
  const enemyKingSquare = `${FILES[enemyKingPos.c]}${8 - enemyKingPos.r}`;

  const profile = GM_STYLES[style] || GM_STYLES.balanced;
  const { worstLoss: threatBefore, hangingSquare } = getHangingDetails(board, turn, budget);
  const legacyPositionKey = `${boardToFenPart(board)} ${turn}`;
  const combinedBook = new Map();
  for (const entry of [...(OPENING_BOOK[legacyPositionKey] || []), ...getLocalEcoBookMoves(uciHistory, historyTrusted)]) {
    const uci = `${entry.from}${entry.to}${entry.promo || ""}`;
    const previous = combinedBook.get(uci);
    if (!previous || Number(entry.bonus) > Number(previous.bonus)) combinedBook.set(uci, entry);
  }
  const bookMoves = [...combinedBook.values()];
  const learnedForPos = experienceDB[boardKey] || experienceDB[legacyPositionKey] || {};

  const dangerStatus = annotationOnly
    ? { isDanger: inCheckBefore, reason: "" }
    : detectKingDangerState(board, turn, enemy, inCheckBefore, threatBefore, castling, activeEpSquare, budget);
  let isDangerPosition = dangerStatus.isDanger;
  let dangerReason = dangerStatus.reason;

  let cloudLines = null;
  let syzygyData = null;
  const requestStartTime = Date.now();
  const networkStartedAt = searchNow();
  lastServerSourceTag = pass === "fast" ? "LOCAL FAST CORE" : "LOCAL DEEP CORE";

  if (annotationOnly) {
    syzygyData = syzygyCache.get(fen) || null;
    cloudLines = cloudCache.get(fen) || null;
  } else if (pieceCount <= 7) {
    if (pass === "fast") {
      syzygyData = syzygyCache.get(fen) || await fetchSyzygyTablebase(fen, pieceCount, signal);
    } else {
      syzygyData = await fetchSyzygyTablebase(fen, pieceCount, signal);
    }
  } else if (pass === "fast") {
    cloudLines = cloudCache.get(fen) || null;
    if (cloudLines) {
      lastServerSourceTag = cloudLines[0]?.source === "explorer" ? "EXPLORER CACHE (0мс)" : "CLOUD CACHE (0мс)";
    }
  } else if (elo >= 1800) {
    cloudLines = await fetchLichessCloud3000(fen, pieceCount, signal);
  }

  // Network latency must not consume the local search budget.
  const networkElapsedMs = searchNow() - networkStartedAt;
  budget.deadline += networkElapsedMs;
  budget.startedAt += networkElapsedMs;
  checkSearchBudget(budget);

  const singleBestOnlyMode = !calcAverage && !calcWorst;
  let maxTargetDepth = pass === "fast" ? 2 : (legal.length <= 26 ? 3 : 2);
  if (pass === "deep" && !bulletTurbo && (isDangerPosition || !cloudLines || singleBestOnlyMode) && legal.length <= 22) {
    maxTargetDepth = 4;
  }
  if (isPawnEndgame && legal.length <= 14 && !syzygyData) {
    maxTargetDepth = pass === "fast" ? 3 : (bulletTurbo ? 4 : 5);
  }
  if (annotationOnly) maxTargetDepth = 1;

  if (maxTargetDepth >= 3 && !syzygyData) {
    for (let d = 1; d < maxTargetDepth - 1; d++) {
      if (searchNow() - budget.startedAt > timeBudgetMs * 0.25) break;
      searchPV(board, turn, d, -30000, 30000, objectiveStyle, castling, activeEpSquare, 0, isDangerPosition, 0, halfmoveClock, budget);
    }
    const rootHash = `${boardToHash(board, turn, castling, activeEpSquare, halfmoveClock)}_${objectiveStyle}_${isDangerPosition ? 1 : 0}_0`;
    const rootTT = transpositionTable.get(rootHash);
    if (rootTT && rootTT.bestKey) {
      legal = generateLegalMoves(board, turn, castling, activeEpSquare, rootTT.bestKey, 0, budget);
    }
  }

  // Pick one root quality before scoring any candidate. If ordering/search warm-up
  // consumed the budget, lower every root move equally rather than only late moves.
  let uniformChildDepth = Math.max(1, maxTargetDepth - 1);
  const rootBudgetRemaining = budget.deadline - searchNow();
  if (
    uniformChildDepth > 1 &&
    (
      rootBudgetRemaining < timeBudgetMs * 0.45 ||
      (!isDangerPosition && legal.length > 16 && uniformChildDepth > 2)
    )
  ) {
    uniformChildDepth--;
  }

  const enemyMobilityBefore = generateMoves(board, enemy, "-", null).length;
  const isEnemyZeitnot = enemySeconds > 0 && enemySeconds <= 10.5;
  let mateThreatCount = 0;

  const rawEvaluated = legal.map((m) => {
    checkSearchBudget(budget);
    const nextB = makeMove(board, m);
    const nextCastling = updateCastlingAfterMove(castling, m);
    const nextEp = getNextEpSquare(m);
    const nextBoardPart = boardToFenPart(nextB);

    const gainedNow = m.captured ? (PIECE_VALUES[m.captured] || 0) : 0;
    const { worstLoss: rawThreatAfter } = getHangingDetails(nextB, turn, budget);
    const moveSeeScore = seeExchangeScore(nextB, m.toR, m.toC, m.piece, m.captured, turn);

    const givesCheck = isKingInCheck(nextB, enemy);
    const threatAfter = givesCheck ? Math.min(rawThreatAfter, Math.max(0, -moveSeeScore)) : rawThreatAfter;

    const enemyLegalAfter = generateLegalMoves(nextB, enemy, nextCastling, nextEp, null, 0, budget);
    const isMateInOne = givesCheck && enemyLegalAfter.length === 0;
    const isStalemate = !givesCheck && enemyLegalAfter.length === 0;
    const nextHalfmoveClock = m.piece === "p" || m.captured ? 0 : halfmoveClock + 1;
    const causesFiftyMoveDraw = !isMateInOne && !isStalemate && nextHalfmoveClock >= 100;

    const isForcedMateInTwo =
      !annotationOnly &&
      !isMateInOne &&
      !isStalemate &&
      !causesFiftyMoveDraw &&
      (givesCheck || staticEvalBefore >= 350 || pieceCount <= 10) &&
      enemyLegalAfter.length <= 8 &&
      deliversForcedMateInTwo(nextB, turn, enemy, nextCastling, nextEp, budget);

    const blundersMateInOne = !annotationOnly && !isMateInOne && !isStalemate && !causesFiftyMoveDraw && allowsEnemyMateInOne(nextB, turn, enemy, nextCastling, nextEp, budget);
    if (blundersMateInOne) {
      mateThreatCount++;
    }

    let blundersMateInTwo = false;
    if (!annotationOnly && !isMateInOne && !isStalemate && !causesFiftyMoveDraw && !isForcedMateInTwo && !blundersMateInOne) {
      blundersMateInTwo = allowsEnemyForcedMateInTwo(nextB, turn, enemy, nextCastling, nextEp, budget);
      if (blundersMateInTwo) {
        mateThreatCount++;
      }
    }

    const fromSq = `${FILES[m.fromC]}${8 - m.fromR}`;
    const toSq = `${FILES[m.toC]}${8 - m.toR}`;
    const promoSuffix = m.promo ? m.promo : "";
    const uci = fromSq + toSq + promoSuffix;

    const nextPositionKey = `${nextBoardPart} ${enemy} ${nextCastling} ${nextEp || "-"}`;
    const timesSeenBefore = positionCounts.get(nextPositionKey) || positionCounts.get(nextBoardPart) || 0;
    let allowsEnemyRepetition = false;
    if (timesSeenBefore === 0 && positionCounts.size > 0 && staticEvalBefore >= 120 && !m.captured && m.piece !== "p") {
      for (let ei = 0; ei < Math.min(8, enemyLegalAfter.length); ei++) {
        checkSearchBudget(budget);
        const eb = makeMove(nextB, enemyLegalAfter[ei]);
        const ePart = boardToFenPart(eb);
        const enemyMove = enemyLegalAfter[ei];
        const eCastling = updateCastlingAfterMove(nextCastling, enemyMove);
        const eEp = getNextEpSquare(enemyMove);
        const eKey = `${ePart} ${turn} ${eCastling} ${eEp || "-"}`;
        if ((positionCounts.get(eKey) || positionCounts.get(ePart) || 0) >= 2) {
          allowsEnemyRepetition = true;
          break;
        }
      }
    }

    const isBackAndForth = Boolean(
      lastOurMove &&
      fromSq === lastOurMove.to &&
      toSq === lastOurMove.from &&
      !m.captured &&
      !givesCheck
    );

    let syzygyEntry = null;
    if (syzygyData && Array.isArray(syzygyData.moves)) {
      syzygyEntry = syzygyData.moves.find(
        sm => sm.from === fromSq && sm.to === toSq && (sm.promo || null) === (m.promo || null)
      ) || null;
    }

    let searchScore = 0;
    let pvResult = { pv: [] };

    if (isMateInOne) {
      searchScore = 29900;
    } else if (isForcedMateInTwo) {
      searchScore = 29400;
    } else if (isStalemate) {
      searchScore = staticEvalBefore >= -300 ? -24000 : 0;
    } else if (causesFiftyMoveDraw) {
      searchScore = 0;
    } else if (blundersMateInOne) {
      searchScore = -29000;
    } else if (blundersMateInTwo) {
      searchScore = -26500;
    } else if (syzygyEntry) {
      searchScore = syzygyEntry.syzygyScore;
    } else if (annotationOnly) {
      searchScore = Math.max(-1200, Math.min(1200, -evaluateBoard(nextB, enemy, objectiveStyle)));
    } else {
      pvResult = searchPV(
        nextB,
        enemy,
        uniformChildDepth,
        -30000,
        30000,
        objectiveStyle,
        nextCastling,
        nextEp,
        givesCheck ? 1 : 0,
        isDangerPosition,
        1,
        nextHalfmoveClock,
        budget
      );
      searchScore = -pvResult.score;
    }

    return {
      m,
      nextB,
      nextCastling,
      nextEp,
      nextBoardPart,
      enemyLegalAfterCount: enemyLegalAfter.length,
      fromSq,
      toSq,
      uci,
      gainedNow,
      rawThreatAfter,
      threatAfter,
      moveSeeScore,
      givesCheck,
      isMateInOne,
      isForcedMateInTwo,
      isStalemate,
      causesFiftyMoveDraw,
      blundersMateInOne,
      blundersMateInTwo,
      timesSeenBefore,
      allowsEnemyRepetition,
      isBackAndForth,
      syzygyEntry,
      searchScore,
      pvResult
    };
  });

  let maxPureSafeScore = -30000;
  for (const item of rawEvaluated) {
    checkSearchBudget(budget);
    if (!item.blundersMateInOne && !item.blundersMateInTwo && !item.isStalemate && !item.causesFiftyMoveDraw && item.searchScore > maxPureSafeScore) {
      maxPureSafeScore = item.searchScore;
    }
  }

  const scored = rawEvaluated.map((item) => {
    checkSearchBudget(budget);
    const {
      m,
      nextB,
      nextCastling,
      nextEp,
      enemyLegalAfterCount,
      fromSq,
      toSq,
      uci,
      gainedNow,
      threatAfter,
      moveSeeScore,
      givesCheck,
      isMateInOne,
      isForcedMateInTwo,
      isStalemate,
      causesFiftyMoveDraw,
      blundersMateInOne,
      blundersMateInTwo,
      timesSeenBefore,
      allowsEnemyRepetition,
      isBackAndForth,
      syzygyEntry,
      searchScore,
      pvResult
    } = item;

    let cloudBonus = 0;
    let fromCloud = false;
    let fromExplorer = false;
    let cloudDepth = 0;
    let cloudPV = null;
    if (cloudLines && !isMateInOne && !isStalemate && !blundersMateInOne && !blundersMateInTwo) {
      const cIdx = cloudLines.findIndex(
        cl => cl.from === fromSq && cl.to === toSq && (cl.promo || null) === (m.promo || null)
      );
      if (cIdx === 0 && timesSeenBefore === 0) {
        fromCloud = cloudLines[0].source === "cloud";
        fromExplorer = cloudLines[0].source === "explorer";
        cloudDepth = Number(cloudLines[0].depth) || 0;
        cloudBonus = fromCloud ? (elo >= 2400 ? 320 : 180) : 65;
        cloudPV = cloudLines[0].pvChain;
      } else if (cIdx === 1 && timesSeenBefore === 0) {
        cloudBonus = cloudLines[1].source === "cloud" ? 90 : 25;
      }
    }

    const syzygyBonus = syzygyEntry
      ? (syzygyEntry.rankIndex === 0 ? 1500 : Math.max(-800, 600 - syzygyEntry.rankIndex * 180))
      : 0;

    let antiRepetitionPenalty = 0;
    const weAreNotLosing = maxPureSafeScore >= -80 || staticEvalBefore >= -80;
    if (weAreNotLosing && !isMateInOne && !isForcedMateInTwo) {
      if (causesFiftyMoveDraw) {
        antiRepetitionPenalty -= 15000;
      }
      if (timesSeenBefore >= 2) {
        antiRepetitionPenalty -= 15000;
      } else if (timesSeenBefore === 1) {
        antiRepetitionPenalty -= (maxPureSafeScore >= 200 ? 2200 : 950);
      }
      if (allowsEnemyRepetition) {
        antiRepetitionPenalty -= (maxPureSafeScore >= 200 ? 850 : 350);
      }
      if (isBackAndForth) {
        antiRepetitionPenalty -= (maxPureSafeScore >= 200 ? 600 : 280);
      }
    }

    let winningProgressBonus = 0;
    if (staticEvalBefore >= 350 && !isStalemate && !isMateInOne && timesSeenBefore === 0) {
      if (m.piece === "p") winningProgressBonus += 45;
      if (m.captured && moveSeeScore >= 0) winningProgressBonus += 40;
      if (enemyLegalAfterCount >= 1 && enemyLegalAfterCount <= 5) {
        winningProgressBonus += (6 - enemyLegalAfterCount) * 22;
      }
    }

    const isSoundTacticalSacrifice =
      !blundersMateInOne &&
      !blundersMateInTwo &&
      !isStalemate &&
      !causesFiftyMoveDraw &&
      threatAfter > gainedNow + 120 &&
      searchScore >= 240 &&
      (maxPureSafeScore - searchScore) <= 45;

    const gmSacrificeBoost = isSoundTacticalSacrifice
      ? Math.min(80, Math.round(profile.sacrificeBoost * 0.25))
      : 0;

    const safetyScale = Math.max(0.8, Math.min(1.3, Number(profile.safety || 2.35) / 2.2));
    const seePenalty = (!isSoundTacticalSacrifice && moveSeeScore < -35)
      ? Math.round(moveSeeScore * 0.85 * safetyScale)
      : 0;

    const unaddressedThreat = Math.max(0, threatAfter - gainedNow);
    const netTacticalPenalty = (!isSoundTacticalSacrifice && unaddressedThreat > 35)
      ? -Math.round(unaddressedThreat * 1.35 * safetyScale)
      : 0;

    const movedPieceSafe =
      !blundersMateInOne &&
      !blundersMateInTwo &&
      !isStalemate &&
      !causesFiftyMoveDraw &&
      moveSeeScore >= -25 &&
      unaddressedThreat <= 35 &&
      (!isSquareAttacked(nextB, m.toR, m.toC, enemy) || (threatAfter <= gainedNow));

    const objectiveSafetyBonus = movedPieceSafe
      ? Math.min(45, Math.round(Math.max(0, threatBefore - threatAfter) * 0.16 * safetyScale))
      : 0;

    const isObjectivelyCompetitive = !causesFiftyMoveDraw && (maxPureSafeScore - searchScore) <= 30 && timesSeenBefore === 0;

    let trapInfo = { isTrap: false, trapChance: 0, badReplies: 0, totalReplies: 0, trapSubtitle: "", complexityBranches: 0 };
    if (
      trapRadarEnabled &&
      !annotationOnly &&
      !isMateInOne &&
      !isForcedMateInTwo &&
      !isStalemate &&
      !blundersMateInOne &&
      !blundersMateInTwo &&
      !syzygyEntry &&
      movedPieceSafe &&
      (maxPureSafeScore - searchScore) <= 65
    ) {
      trapInfo = computeTrapMetrics(nextB, m, turn, enemy, nextCastling, nextEp, style, budget);
    }

    const trapBonus = (trapRadarEnabled && trapInfo.isTrap && movedPieceSafe && isObjectivelyCompetitive && (profile.trapAffinity || 1.0) >= 1.1)
      ? Math.round((trapInfo.trapChance - 70) * 1.5 * (profile.trapAffinity || 1.2))
      : 0;

    let zeitnotComplexityBonus = 0;
    const isComplexBranching = trapInfo.complexityBranches >= 18 || givesCheck || m.captured || trapInfo.isTrap;
    if (isEnemyZeitnot && movedPieceSafe && isObjectivelyCompetitive) {
      zeitnotComplexityBonus = Math.min(35, Math.round(trapInfo.complexityBranches * 0.9) + (givesCheck ? 15 : 0));
    }

    const bookEntry = bookMoves.find(b => b.from === fromSq && b.to === toSq);
    const allowDubiousGambits = (style === "tal" || style === "mogging") && elo < 1900;
    const bookBonus = (bookEntry && movedPieceSafe && (maxPureSafeScore - searchScore) <= 60)
      ? (bookEntry.bonus > 105 && !allowDubiousGambits ? 25 : bookEntry.bonus)
      : 0;

    const expEntry = learnedForPos[uci];
    const memoryBonus = (expEntry && movedPieceSafe && isObjectivelyCompetitive) ? Math.min(50, expEntry.bonus) : 0;

    let kingPenalty = 0;
    const isCastling = m.piece === "k" && Math.abs(m.fromC - m.toC) === 2;
    const hasCastlingRight = turn === "w" ? /[KQ]/.test(castling) : /[kq]/.test(castling);
    if (m.piece === "k") {
      if (!isEndgame && !inCheckBefore && !isCastling && hasCastlingRight) {
        kingPenalty = -220;
      } else if (isEndgame && movedPieceSafe) {
        const distCenterBefore = Math.abs(3.5 - m.fromR) + Math.abs(3.5 - m.fromC);
        const distCenterAfter = Math.abs(3.5 - m.toR) + Math.abs(3.5 - m.toC);
        if (distCenterAfter < distCenterBefore) {
          kingPenalty = 30;
        }
      }
    }
    const castlingBonus = (isCastling && movedPieceSafe) ? 65 : 0;

    let rawKickBonus = 0;
    if (m.piece === "p" && movedPieceSafe && isObjectivelyCompetitive) {
      const nextMoves = generateMoves(nextB, turn, "-", null).filter(
        nm => nm.fromR === m.toR && nm.fromC === m.toC && nm.captured
      );
      if (nextMoves.some(nm => PIECE_VALUES[nm.captured] >= 300)) {
        rawKickBonus = 32;
      }
    }

    let mobilitySqueezeBonus = 0;
    if (profile.squeeze >= 1.5 && movedPieceSafe && isObjectivelyCompetitive) {
      mobilitySqueezeBonus = Math.round((enemyMobilityBefore - enemyLegalAfterCount) * profile.squeeze * 1.2);
    }

    const savedHangingBonus = (
      threatBefore >= 75 &&
      threatAfter < 50 &&
      !blundersMateInOne &&
      !blundersMateInTwo &&
      !isStalemate &&
      (maxPureSafeScore - searchScore) <= 80
    ) ? 95 : 0;

    const isFork = detectForkMotif(nextB, m.toR, m.toC, turn);
    const isPin = detectPinMotif(nextB, m.toR, m.toC, turn);

    const safeKickBonus = movedPieceSafe ? rawKickBonus : 0;
    const safeForkBonus = (movedPieceSafe && isFork) ? 50 : 0;
    const safePinBonus = (movedPieceSafe && isPin) ? 35 : 0;
    const safeCheckBonus = (movedPieceSafe && givesCheck && isObjectivelyCompetitive) ? Math.min(22, profile.checkBonus) : 0;

    let finalScore = 0;
    if (isMateInOne) {
      finalScore = 50000;
    } else if (isForcedMateInTwo) {
      finalScore = 45000;
    } else {
      finalScore =
        searchScore +
        bookBonus +
        memoryBonus +
        kingPenalty +
        castlingBonus +
        safeKickBonus +
        mobilitySqueezeBonus +
        gmSacrificeBoost +
        savedHangingBonus +
        safeForkBonus +
        safePinBonus +
        safeCheckBonus +
        cloudBonus +
        syzygyBonus +
        trapBonus +
        zeitnotComplexityBonus +
        winningProgressBonus +
        antiRepetitionPenalty +
        seePenalty +
        netTacticalPenalty +
        objectiveSafetyBonus;
    }

    const movedPieceAttacked = isSquareAttacked(nextB, m.toR, m.toC, enemy);
    const putUnderAttack =
      !isMateInOne &&
      !isForcedMateInTwo &&
      (
        blundersMateInOne ||
        blundersMateInTwo ||
        (isStalemate && weAreNotLosing) ||
        moveSeeScore < -50 ||
        (!isSoundTacticalSacrifice && movedPieceAttacked && (threatAfter > gainedNow + 25))
      );

    const moveLabel = m.promo ? `${fromSq}→${toSq}=${m.promo.toUpperCase()}` : `${fromSq}→${toSq}`;
    let fullPV = "";
    if (isMateInOne) {
      fullPV = `${moveLabel}# (МАТ В 1 ХОД!)`;
    } else if (isForcedMateInTwo) {
      fullPV = `${moveLabel}+ (ФОРСИРОВАННЫЙ МАТ В 2 ХОДА!)`;
    } else if (isStalemate) {
      fullPV = `${moveLabel} (ОСТОРОЖНО: ПАТ / НИЧЬЯ!)`;
    } else if (syzygyEntry) {
      fullPV = `${moveLabel} • ${syzygyEntry.badgeLabel}`;
    } else {
      fullPV = cloudPV || [moveLabel, ...pvResult.pv.slice(0, 3)].join(" ➔ ");
    }

    let evalPawnsStr = (searchScore / 100).toFixed(2);
    if (isMateInOne) {
      evalPawnsStr = "МАТ #1";
    } else if (isForcedMateInTwo) {
      evalPawnsStr = "МАТ #2";
    } else if (isStalemate) {
      evalPawnsStr = "ПАТ 0.00";
    } else if (syzygyEntry && syzygyEntry.ourOutcome === "win") {
      evalPawnsStr = syzygyEntry.dtm
        ? `МАТ #${Math.ceil(syzygyEntry.dtm / 2)}`
        : `DTZ ${syzygyEntry.dtz ?? "WIN"}`;
    } else if (blundersMateInOne) {
      evalPawnsStr = "-МАТ #1";
    } else if (blundersMateInTwo) {
      evalPawnsStr = "-МАТ #2";
    }

    let whiteEvalStr = ((turn === "w" ? searchScore : -searchScore) / 100).toFixed(2);
    if (isMateInOne || isForcedMateInTwo) {
      whiteEvalStr = turn === "w" ? 10 : -10;
    } else if (isStalemate) {
      whiteEvalStr = "0.00";
    }

    return {
      rawMove: m,
      uci,
      from: fromSq,
      to: toSq,
      promo: m.promo || null,
      isEnPassant: Boolean(m.isEnPassant),
      piece: m.piece,
      stepDist: Math.abs(m.toR - m.fromR),
      isCastling,
      fromCloud,
      fromExplorer,
      cloudDepth,
      fromSyzygy: Boolean(syzygyEntry),
      syzygyBadge: syzygyEntry ? syzygyEntry.badgeLabel : null,
      syzygyOutcome: syzygyEntry ? syzygyEntry.ourOutcome : null,
      syzygyDtz: syzygyEntry ? syzygyEntry.dtz : null,
      syzygyDtm: syzygyEntry ? syzygyEntry.dtm : null,
      isTrap: Boolean(trapRadarEnabled && trapInfo.isTrap),
      trapChance: trapInfo.trapChance || 0,
      trapSubtitle: trapInfo.trapSubtitle || "",
      complexityBranches: trapInfo.complexityBranches || legal.length,
      isZeitnotBranched: Boolean(isEnemyZeitnot && isComplexBranching && isObjectivelyCompetitive),
      bookName: bookEntry ? bookEntry.name : null,
      memoryBonus,
      memoryGames: expEntry ? expEntry.games : 0,
      pvLine: fullPV,
      captured: m.captured,
      isMateInOne,
      isForcedMateInTwo,
      causesStalemate: Boolean(isStalemate && weAreNotLosing),
      isRepetitionDrawRisk: Boolean(
        !isMateInOne &&
        !isForcedMateInTwo &&
        weAreNotLosing &&
        (causesFiftyMoveDraw || timesSeenBefore >= 2 || allowsEnemyRepetition)
      ),
      causesFiftyMoveDraw,
      isCheckmate: isMateInOne || isForcedMateInTwo || searchScore > 15000 || (syzygyEntry && syzygyEntry.dtm !== null && syzygyEntry.dtm <= 4 && syzygyEntry.ourOutcome === "win"),
      blundersMate: blundersMateInOne || blundersMateInTwo,
      isSacrifice: isSoundTacticalSacrifice,
      isTalSacrifice: isSoundTacticalSacrifice && profile.sacrificeBoost >= 80,
      isFork: movedPieceSafe && isFork,
      isPin: movedPieceSafe && isPin,
      savedHangingPiece: threatBefore >= 75 && threatAfter < 50 && !blundersMateInOne && !blundersMateInTwo && !isStalemate,
      ignoredHangingPiece: !isMateInOne && !isForcedMateInTwo && !isSoundTacticalSacrifice && threatBefore >= 75 && threatAfter >= 75 && gainedNow < threatBefore,
      underDirectAttack: putUnderAttack,
      ruinedCastling: !isMateInOne && !isForcedMateInTwo && hasCastlingRight && kingPenalty < 0,
      kicksEnemyPiece: safeKickBonus > 0,
      givesCheck,
      pureSearchScore: searchScore,
      trueScore: finalScore,
      evalPawns: evalPawnsStr,
      whitePerspectiveEval: whiteEvalStr
    };
  });

  if (mateThreatCount >= 2 && !isDangerPosition) {
    isDangerPosition = true;
    dangerReason = "ОПАСНОСТЬ МАТОВОЙ ЛОВУШКИ";
  }

  scored.sort((a, b) => b.trueScore - a.trueScore);

  const isObjectivelySafeMove = (m) =>
    !m.blundersMate &&
    !m.causesStalemate &&
    !m.isRepetitionDrawRisk &&
    !m.ignoredHangingPiece &&
    !m.underDirectAttack &&
    !m.ruinedCastling;
  const objectivelySafeMoves = scored.filter(isObjectivelySafeMove);
  const safeTopScore = objectivelySafeMoves[0]?.trueScore ?? -Infinity;
  const solidMoves = objectivelySafeMoves.filter(m => safeTopScore - m.trueScore <= 120);
  const nonDrawNonMateMoves = scored.filter(m => !m.blundersMate && !m.causesStalemate && !m.isRepetitionDrawRisk);
  const safetyPenalty = (m) =>
    (m.blundersMate ? 1000000 : 0) +
    (m.causesStalemate ? 100000 : 0) +
    (m.isRepetitionDrawRisk ? 10000 : 0) +
    (m.ignoredHangingPiece ? 1000 : 0) +
    (m.underDirectAttack ? 500 : 0) +
    (m.ruinedCastling ? 100 : 0);
  const minimumFallbackPenalty = objectivelySafeMoves.length > 0
    ? 0
    : Math.min(...scored.map(safetyPenalty));
  const safestFallbackMoves = objectivelySafeMoves.length > 0
    ? objectivelySafeMoves
    : scored.filter(m => safetyPenalty(m) === minimumFallbackPenalty);
  const safePool = solidMoves.length > 0 ? solidMoves : safestFallbackMoves;

  const maxAllowedCpLoss =
    elo >= 2000 ? 0 :
    elo >= 1700 ? 25 :
    elo >= 1400 ? 55 :
    elo >= 1000 ? 110 : 220;

  let bestMove = safePool[0];
  if (!bestMove.isMateInOne && !bestMove.isForcedMateInTwo && !bestMove.fromSyzygy && !isDangerPosition && maxAllowedCpLoss > 0 && safePool.length > 1) {
    const bestPure = safePool[0].pureSearchScore;
    const humanCandidates = safePool.filter(
      m => (bestPure - m.pureSearchScore) <= maxAllowedCpLoss
    );
    if (humanCandidates.length > 1) {
      bestMove = humanCandidates[humanCandidates.length - 1];
    }
  }

  if (!annotationOnly && (!mobile || analysisMeta?.needPremove === true) && bestMove && bestMove.rawMove && !bestMove.isMateInOne && !isDangerPosition) {
    const boardAfterBest = makeMove(board, bestMove.rawMove);
    const nextCast = updateCastlingAfterMove(castling, bestMove.rawMove);
    const nextEpSq = getNextEpSquare(bestMove.rawMove);
    const boardAfterBestPart = boardToFenPart(boardAfterBest);
    const updatedRecent = [...recentPositions.slice(-256), `${boardAfterBestPart} ${enemy} ${nextCast} ${nextEpSq || "-"}`];
    try {
      bestMove.nextPremove = computeSmartNextPremove(
        boardAfterBest,
        turn,
        enemy,
        nextCast,
        nextEpSq,
        bestMove,
        style,
        updatedRecent,
        null,
        0,
        budget
      );
    } catch (error) {
      if (error !== SEARCH_INTERRUPTED) throw error;
      bestMove.nextPremove = null;
    }
  }

  let averageMove = null;
  if (calcAverage) {
    const avgCandidates = safePool.filter(
      m =>
        m.uci !== bestMove.uci &&
        !m.blundersMate &&
        !m.causesStalemate &&
        !m.isRepetitionDrawRisk &&
        !(m.from === bestMove.from && m.to === bestMove.to)
    );
    averageMove =
      avgCandidates[0] ||
      safestFallbackMoves.find(m =>
        m.uci !== bestMove.uci &&
        !(m.from === bestMove.from && m.to === bestMove.to)
      ) ||
      bestMove;
  }

  const worstMove = calcWorst ? scored[scored.length - 1] : null;

  const clampedPure = Math.max(-1200, Math.min(1200, scored[0].pureSearchScore));
  const currentPureWhiteScore = turn === "w" ? clampedPure : -clampedPure;
  const currentHash = boardToHash(board, turn);

  const isSameBoardAsLast = Boolean(lastAnalyzedState.board && lastAnalyzedState.boardHash === currentHash);

  const baselinePrevWhiteScore = isSameBoardAsLast
    ? lastAnalyzedState.prevTurnScoreForWhite
    : lastAnalyzedState.pureBestScoreForWhite;

  let opponentEvalDropPawns = isSameBoardAsLast ? (lastAnalyzedState.lastDropPawns || 0) : 0;

  if (!isSameBoardAsLast && detectedOppMove && lastAnalyzedState.board && baselinePrevWhiteScore !== undefined) {
    const rawDiff = turn === "w"
      ? (currentPureWhiteScore - baselinePrevWhiteScore)
      : (baselinePrevWhiteScore - currentPureWhiteScore);
    opponentEvalDropPawns = Math.max(0, rawDiff / 100).toFixed(2);
  }

  const latestMeta = latestAnalysisMetaByClient.get(analysisContextKey);
  const canCommitClientState = !analysisMeta || !latestMeta || (
    analysisMeta.sessionId === latestMeta.sessionId &&
    analysisMeta.positionId === latestMeta.positionId &&
    analysisMeta.analysisId === latestMeta.analysisId
  );
  if (canCommitClientState) {
    analyzedStateByClient.set(analysisContextKey, {
      board: board.map(r => r.slice()),
      boardHash: currentHash,
      turn,
      pureBestScoreForWhite: currentPureWhiteScore,
      prevTurnScoreForWhite: baselinePrevWhiteScore,
      lastDropPawns: opponentEvalDropPawns
    });
    if (analyzedStateByClient.size > 32) analyzedStateByClient.delete(analyzedStateByClient.keys().next().value);
  }

  let heatmap = [];
  if (!budget.interrupted) {
    try { heatmap = computeBoardControlHeatmap(board, myColor || turn, budget); } catch (error) {
      if (error !== SEARCH_INTERRUPTED) throw error;
    }
  }

  let timeAdvice = null;
  if (enemySeconds > 0 && enemySeconds < 10) {
    timeAdvice = {
      mode: "zeitnot_attack",
      badge: `⏱️ ЦЕЙТНОТ ВРАГА: ${enemySeconds.toFixed(1)}с`,
      text: `У соперника меньше 10 секунд! Движок выбирает самые разветвленные сильные продолжения (${bestMove.complexityBranches || legal.length} ответов) без риска ничьей.`
    };
  } else if (mySeconds > 0 && mySeconds < 12) {
    timeAdvice = {
      mode: "my_panic",
      badge: `⚡ НАШ ЦЕЙТНОТ: ${mySeconds.toFixed(1)}с`,
      text: `Мало времени на часах! Включен ускоренный турбо-расчет и безопасные SEE-премувы.`
    };
  } else if (enemySeconds < 30 && mySeconds > enemySeconds + 15) {
    timeAdvice = {
      mode: "tempo_advantage",
      badge: `🎯 ПЕРЕВЕС ПО ВРЕМЕНИ (+${Math.round(mySeconds - enemySeconds)}с)`,
      text: `Давите темпом: избегайте простых разменов, сохраняйте напряжение на доске.`
    };
  }

  const safeNonRepeatingUcis = (objectivelySafeMoves.length > 0 ? objectivelySafeMoves : safestFallbackMoves).map(m => m.uci);
  const legalUcis = legal.map(m => `${FILES[m.fromC]}${8 - m.fromR}${FILES[m.toC]}${8 - m.toR}${m.promo || ""}`);
  const hardRejectedUcis = scored.filter(m => m.blundersMate || m.causesStalemate).map(m => m.uci);

  // Сборка Живой телеметрии 24/7 (Шансы на победу, статус сервера, ближайшие ловушки/маты)
  const totalElapsedMs = Date.now() - requestStartTime;
  const ourPerspectiveScore = turn === myColor ? bestMove.pureSearchScore : -bestMove.pureSearchScore;
  const wdl = computeWinDrawLossChances(
    ourPerspectiveScore,
    turn === myColor && (bestMove.isMateInOne || bestMove.isForcedMateInTwo),
    turn !== myColor && (bestMove.isMateInOne || bestMove.isForcedMateInTwo)
  );

  let nearestThreatText = `Лучший план: ${bestMove.from}→${bestMove.to} (${bestMove.evalPawns})`;
  if (bestMove.isMateInOne) {
    nearestThreatText = `👑 МАТ В 1 ХОД: ${bestMove.from}→${bestMove.to}#`;
  } else if (bestMove.isForcedMateInTwo) {
    nearestThreatText = `👑 ФОРС. МАТ В 2 ХОДА: ${bestMove.from}→${bestMove.to}+`;
  } else if (bestMove.isTrap && bestMove.trapChance >= 75) {
    nearestThreatText = `🪤 ЛОВУШКА ${bestMove.from}→${bestMove.to} (Ошибка врага: ${bestMove.trapChance}%)`;
  } else if (isDangerPosition) {
    nearestThreatText = `🛡 УГРОЗА: ${dangerReason} (Защита: ${bestMove.from}→${bestMove.to})`;
  } else if (hangingSquare && threatBefore >= 75) {
    nearestThreatText = `⚠️ Поле ${hangingSquare.toUpperCase()} под боем! Спасение: ${bestMove.from}→${bestMove.to}`;
  } else if (bestMove.fromSyzygy) {
    nearestThreatText = `🔮 ${bestMove.syzygyBadge}`;
  }

  const telemetry = {
    serverSource: lastServerSourceTag,
    pingMs: totalElapsedMs,
    myWin: wdl.myWin,
    draw: wdl.draw,
    enemyWin: wdl.enemyWin,
    nearestThreatText
  };

  return {
    pass: annotationOnly ? "fast" : pass,
    requestedPass: pass,
    partial: annotationOnly,
    analysisIncomplete: annotationOnly,
    search: { ...searchStats(budget), annotationOnly },
    best: bestMove,
    average: averageMove,
    worst: worstMove,
    safeNonRepeatingUcis,
    legalUcis,
    hardRejectedUcis,
    isDangerPosition: isDangerPosition || annotationOnly,
    dangerReason: annotationOnly ? "Local annotations incomplete; waiting for Stockfish" : dangerReason,
    enemyKingSquare,
    hangingSquare: threatBefore >= 75 ? hangingSquare : null,
    lastOpponentMove: detectedOppMove,
    opponentEvalDropPawns,
    heatmap,
    timeAdvice,
    telemetry,
    syzygyActive: Boolean(syzygyData),
    pieceCount,
    boardKey,
    elo,
    style,
    totalLearnedGames,
    positionsCount: Object.keys(experienceDB).length
  };
  } catch (error) {
    if (error !== SEARCH_INTERRUPTED) throw error;
    const fallback = m => {
      const from = `${FILES[m.fromC]}${8 - m.fromR}`;
      const to = `${FILES[m.toC]}${8 - m.toR}`;
      return {
        rawMove: m, from, to, uci: `${from}${to}${m.promo || ""}`, promo: m.promo || null,
        piece: m.piece, captured: m.captured, isEnPassant: Boolean(m.isEnPassant),
        isCastling: m.piece === "k" && Math.abs(m.fromC - m.toC) === 2,
        stepDist: Math.abs(m.toR - m.fromR), trueScore: fallbackScore, pureSearchScore: fallbackScore,
        pvLine: moveToText(m), evalPawns: (fallbackScore / 100).toFixed(2),
        whitePerspectiveEval: ((turn === "w" ? fallbackScore : -fallbackScore) / 100).toFixed(2),
        isMateInOne: false, isForcedMateInTwo: false, isCheckmate: false, isTrap: false,
        blundersMate: false, analysisIncomplete: true
      };
    };
    const best = fallback(legal[0]);
    const wdl = computeWinDrawLossChances(turn === myColor ? fallbackScore : -fallbackScore);
    return {
      pass: "fast", requestedPass: pass, best,
      average: calcAverage ? fallback(legal[1] || legal[0]) : null,
      worst: calcWorst ? fallback(legal[legal.length - 1]) : null,
      partial: true, analysisIncomplete: true, search: { ...searchStats(budget), annotationOnly },
      legalUcis: legal.map(m => `${FILES[m.fromC]}${8 - m.fromR}${FILES[m.toC]}${8 - m.toR}${m.promo || ""}`),
      safeNonRepeatingUcis: [], hardRejectedUcis: [], heatmap: [],
      isDangerPosition: true, dangerReason: "Local analysis incomplete; waiting for Stockfish",
      boardKey, pieceCount, elo, style,
      telemetry: { serverSource: "LOCAL BOUNDED FALLBACK", pingMs: searchStats(budget).elapsedMs, ...wdl, nearestThreatText: best.pvLine }
    };
  }
}
