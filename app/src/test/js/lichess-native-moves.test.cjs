"use strict";

// Execute production helpers against a local DOM/native/engine fixture. No browser,
// account, generated assets or repository writes are involved.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const assets = path.resolve(__dirname, "../../main/assets");
const content = fs.readFileSync(path.join(assets, "content/content.js"), "utf8");

function productionFunction(name) {
  const match = new RegExp(`^  (?:async )?function ${name}\\(`, "m").exec(content);
  assert.ok(match, name);
  const tail = content.slice(match.index);
  const end = /\r?\n  }\r?\n/.exec(tail);
  assert.ok(end, `Closing boundary for ${name}`);
  return tail.slice(0, end.index + end[0].length);
}

function productionButton(id) {
  const start = content.indexOf(`    $("${id}").addEventListener("click", () => {`);
  assert.ok(start >= 0, id);
  const end = content.indexOf("\n    });", start);
  assert.ok(end > start, `Button boundary for ${id}`);
  return content.slice(start, end + "\n    });".length);
}

function events() {
  const listeners = new Map();
  return {
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    dispatchEvent(event) {
      for (const callback of Array.from(listeners.get(event.type) || [])) callback(event);
      return true;
    }
  };
}

function nodeListLike(items) {
  const list = {
    length: items.length,
    item: index => items[index] || null,
    forEach: (callback, thisArg) => items.forEach(callback, thisArg),
    [Symbol.iterator]: function* () { yield* items; }
  };
  items.forEach((item, index) => { list[index] = item; });
  Object.defineProperty(list, Symbol.toStringTag, { value: "NodeList" });
  return list;
}

async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve(); }

function harness(options = {}) {
  const { confirmation = false, orientation = "white", navigation = "mobile", realRound = true } = options;
  let now = 1000, sequence = 0, nativePending = null;
  const timers = new Map();
  const setTimeout = (callback, ms = 0) => {
    const id = ++sequence;
    timers.set(id, { callback, at: now + ms });
    return id;
  };
  const clearTimeout = id => timers.delete(id);
  const trace = { gestures: [], runtime: [], statuses: [], states: [], replayCollections: [], arrowRenders: 0, shutdowns: 0, confirmRequests: 0, submissions: [], cancelled: 0, touches: [] };
  const game = {
    grid: ["rnbqkbnr", "pppppppp", "........", "........", "........", "........", "PPPPPPPP", "RNBQKBNR"].map(row => [...row].map(p => p === "." ? null : p)),
    moves: [], serverPly: 0, selected: null, highlights: [], pendingSubmit: null, promotion: null,
    questionAfter: 0, buttonHidden: false, buttonDetached: false, buttonDisabled: false, buttonForeign: false,
    questionHidden: false, overlay: false, animation: false, premove: false, premoveSet: false,
    questionType: "confirm", confirmBehavior: "accept", ...options
  };
  const files = "abcdefgh";
  const coords = square => [8 - Number(square[1]), files.indexOf(square[0])];
  const classList = classes => ({ contains: cls => classes.includes(cls), toggle() {}, add() {}, remove() {} });
  const rect = square => {
    const [row, col] = coords(square);
    return { left: (orientation === "black" ? 7 - col : col) * 40, top: 100 + (orientation === "black" ? 7 - row : row) * 40, width: 40, height: 40 };
  };
  const squareNode = (square, classes = []) => ({ classList: classList(classes), getBoundingClientRect: () => rect(square) });
  const confirmRect = { left: 330, top: 500, width: 50, height: 40 };
  const promotionRect = { left: 340, top: 200, width: 40, height: 40 };
  const confirmButton = {
    get isConnected() { return !game.buttonDetached; },
    contains: node => node === confirmButton,
    getBoundingClientRect: () => confirmRect,
    matches: () => game.buttonDisabled,
    closest: () => game.questionHidden ? question : null
  };
  const question = {
    isConnected: true,
    querySelector: selector => selector === "p" ? { textContent: game.questionType === "confirm" ? "Confirm move" : "Your opponent offers a draw" } : selector === "a.yes" ? confirmButton : null
  };
  const promotionButton = { isConnected: true, contains: node => node === promotionButton, getBoundingClientRect: () => promotionRect };
  const hasQuestion = () => Boolean(game.pendingSubmit && now >= game.questionAfter && !game.questionRemoved);
  const navButton = (ply, disabled = false) => ({ disabled, getAttribute: () => String(ply) });
  const round = {
    isConnected: true,
    contains: node => node === board || node === question || (node === confirmButton && !game.buttonForeign),
    querySelector(selector) {
      if (selector === ".rcontrols .question") return hasQuestion() ? question : null;
      const bottomTurn = (game.serverPly % 2 === 0 ? "white" : "black") === orientation;
      const activeClock = game.clocks !== false && (game.clockMode !== "turn" || selector.includes("rclock-turn__text"));
      if (selector.includes("rclock-bottom")) return activeClock && bottomTurn ? {} : null;
      if (selector.includes("rclock-top")) return activeClock && !bottomTurn ? {} : null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === ".col1-moves > button.fbt[data-ply]") {
        return nodeListLike(navigation === "mobile" ? [navButton(game.serverPly - 1), navButton(game.serverPly + 1)] : []);
      }
      if (selector === "button.fbt.repeatable[data-ply]") {
        const controls = nodeListLike(navigation === "desktop" ? [navButton("-", true), navButton(game.serverPly ? game.serverPly - 1 : "-", !game.serverPly), navButton("-", true), navButton("-", true)] : []);
        trace.replayCollections.push({ length: controls.length, every: typeof controls.every, allDisabled: Array.from(controls).every(button => button.disabled) });
        return controls;
      }
      return nodeListLike([]);
    }
  };
  confirmButton.parentElement = question;
  question.parentElement = round;
  const board = {
    isConnected: true,
    closest: selector => selector === "main.round .round__app" ? realRound ? round : null : { classList: classList([`orientation-${orientation}`]), querySelector: () => null },
    contains: element => element === board,
    getBoundingClientRect: () => ({ left: 0, top: 100, width: 320, height: 320 }),
    querySelector(selector) {
      if (selector.includes("piece.anim") || selector.includes("piece.dragging")) return game.animation ? {} : null;
      if (selector.includes("square.current-premove")) return game.premoveSet ? {} : null;
      if (selector.includes("square.selected")) return game.selected ? squareNode(game.selected, ["selected"]) : null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "square.last-move") return game.highlights.map(square => squareNode(square, ["last-move"]));
      if (selector !== "piece") return [];
      const roles = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
      return game.grid.flatMap((row, r) => row.flatMap((piece, c) => piece ? [{
        classList: classList([piece === piece.toUpperCase() ? "white" : "black", roles[piece.toLowerCase()]]),
        getBoundingClientRect: () => rect(`${files[c]}${8 - r}`)
      }] : []));
    }
  };
  const document = {
    ...events(), visibilityState: "visible", hidden: false,
    querySelector(selector) {
      if (selector.includes("cg-board")) return board;
      if (selector.includes("promotion-choice")) return game.promotion ? { querySelector: () => promotionButton } : null;
      return null;
    },
    querySelectorAll: selector => selector.includes("kwdb") ? game.moves.map(() => ({ closest: () => null, classList: classList([]) })) : [],
    elementFromPoint(x, y) {
      if (game.overlay) return {};
      if (x >= confirmRect.left && y >= confirmRect.top) return confirmButton;
      if (x >= promotionRect.left && y >= promotionRect.top && y < promotionRect.top + 40) return promotionButton;
      return board;
    }
  };
  const planned = options.planned || ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6", "d2d3", "d7d6"];
  const move = uci => ({ uci, from: uci.slice(0, 2), to: uci.slice(2, 4), promo: uci[4], piece: "p", evalPawns: "0.30", whitePerspectiveEval: "0.30", pvLine: uci });
  const acceptMove = uci => {
    game.serverPly++;
    trace.submissions.push(uci);
    game.pendingSubmit = null;
    game.questionRemoved = false;
  };
  const applyMove = (uci, stage = false) => {
    const [r1, c1] = coords(uci.slice(0, 2)), [r2, c2] = coords(uci.slice(2, 4));
    const piece = game.grid[r1][c1];
    game.grid[r2][c2] = uci[4] ? piece === piece.toUpperCase() ? uci[4].toUpperCase() : uci[4] : piece;
    game.grid[r1][c1] = null;
    game.highlights = [uci.slice(0, 2), uci.slice(2, 4)];
    game.selected = null;
    game.moves.push(uci);
    if (piece?.toLowerCase() === "p" && /[18]$/.test(uci.slice(2, 4)) && !uci[4]) game.promotion = { uci, stage };
    else if (stage) { game.pendingSubmit = { uci }; game.questionAfter = now + (game.questionDelay || 0); }
    else acceptMove(uci);
  };
  const atPoint = point => {
    let col = Math.floor(point.x / 40), row = Math.floor((point.y - 100) / 40);
    if (orientation === "black") { col = 7 - col; row = 7 - row; }
    return `${files[col]}${8 - row}`;
  };
  const native = {
    onmessage: null,
    postMessage(raw) {
      const envelope = JSON.parse(raw);
      const reply = (payload, type, error = false) => native.onmessage({ data: JSON.stringify({
        v: 1, scope: "chesscoach.android", source: error || envelope.channel !== "runtime" ? "native" : "engine",
        target: "REMOTE", channel: error ? "native" : envelope.channel,
        type: error ? "error" : type, id: envelope.id, payload
      }) });
      const error = code => reply({ ok: false, error: { code, message: `Fixture ${code}` } }, "error", true);
      if (envelope.type === "runtime.message") {
        const message = envelope.payload.message;
        const uci = game.pendingSubmit ? orientation === "white" ? "g1f3" : "b8c6" : planned[game.moves.length];
        trace.runtime.push(message);
        setTimeout(() => reply(message.type === "ANALYZE_POSITION" ? {
          best: move(uci), legalUcis: [uci], boardKey: message.fen.split(" ").slice(0, 4).join(" "),
          meta: message.meta, pass: message.pass, engineMeta: message.pass === "deep" ? { depth: 16 } : undefined
        } : { canPremove: false }, "runtime.response"), 1);
      } else if (envelope.type === "input.context.get") {
        reply({ ok: true, documentToken: envelope.payload.documentToken, documentNonce: "fixture-document", documentGeneration: 1, origin: context.location.origin }, "input.context.response");
      } else if (envelope.type === "storage.get") {
        reply({ ok: true, items: {}, revision: 0 }, "storage.response");
      } else if (envelope.type === "input.gesture") {
        trace.gestures.push(envelope);
        const { action, points, durationMs } = envelope.payload;
        const confirm = points[0].x >= confirmRect.left && points[0].y >= confirmRect.top;
        const promote = points[0].x >= promotionRect.left && points[0].y >= promotionRect.top && points[0].y < promotionRect.top + 40;
        if (confirm) trace.confirmRequests++;
        if (confirm ? game.confirmError : game.inputError) { error(confirm ? game.confirmError : game.inputError); return; }
        const dispatchMove = () => { if (!confirm && !promote && !game.pendingSubmit) {
          const uci = action === "drag" ? atPoint(points[0]) + atPoint(points.at(-1)) : game.selected && game.selected !== atPoint(points[0]) ? game.selected + atPoint(points[0]) : null;
          if (uci) {
            if (game.premove) game.premoveSet = true;
            else {
              applyMove(game.stageReplacement || uci, confirmation || game.visualOnly);
              if (game.visualOnly) game.questionRemoved = true;
              if (game.instantReply && !confirmation && !game.visualOnly) applyMove(planned[game.moves.length]);
            }
          } else {
            game.selected = game.selected === atPoint(points[0]) ? null : atPoint(points[0]);
            if (game.lingerSelection) {
              game.animation = true;
              setTimeout(() => { game.animation = false; }, 17);
            }
          }
        } };
        const down = setTimeout(() => {
          const actual = context.__CC_ANDROID_RUNTIME__.captureInputSnapshot({ points, targetId: envelope.payload.targetId });
          if (JSON.stringify(actual) !== JSON.stringify(envelope.payload.snapshot) || !actual.hit || actual.animating) {
            clearTimeout(timer); nativePending = null; error("INPUT_POSITION_CHANGED"); return;
          }
          trace.touches.push({ phase: "DOWN", id: envelope.id, at: now });
        }, 16);
        const timer = setTimeout(() => {
          nativePending = null;
          trace.touches.push({ phase: "UP", id: envelope.id, at: now });
          dispatchMove();
          if (confirm && game.pendingSubmit) {
            const pending = game.pendingSubmit;
            if (game.confirmBehavior === "disappear") game.questionRemoved = true;
            if (game.confirmBehavior === "accept") setTimeout(() => {
              if (game.pendingSubmit !== pending) return;
              acceptMove(pending.uci);
              if (game.instantReply) applyMove(planned[game.moves.length]);
            }, game.submitDelay ?? 120);
          }
          if (promote && game.promotion) {
            const { uci, stage } = game.promotion;
            const [r, c] = coords(uci.slice(2, 4));
            const piece = game.grid[r][c];
            game.grid[r][c] = piece === piece.toUpperCase() ? "Q" : "q";
            game.moves[game.moves.length - 1] = `${uci}q`;
            game.promotion = null;
            if (stage) { game.pendingSubmit = { uci: `${uci}q` }; game.questionAfter = now; }
            else acceptMove(`${uci}q`);
          }
          reply({ ok: true, dispatched: true, action }, "input.gesture.response");
        }, durationMs);
        nativePending = { timer, down, error, id: envelope.id };
      } else if (envelope.type === "input.cancel") {
        if (nativePending?.id === envelope.payload.requestId) {
          clearTimeout(nativePending.timer); clearTimeout(nativePending.down); nativePending.error("INPUT_CANCELLED"); nativePending = null;
        }
        reply({ ok: true, cancelled: true }, "input.cancel.response");
      } else throw new Error(`Unexpected fixture request ${envelope.type}`);
    }
  };
  const context = vm.createContext({
    ...events(), document, CCNative: native, location: new URL("https://lichess.org/fixture12345"),
    navigator: {}, TextEncoder, URL, AbortController, queueMicrotask, i18n: { site: { confirmMove: "Confirm move" } },
    Date: class extends Date { static now() { return now; } },
    setTimeout, clearTimeout, requestAnimationFrame: cb => setTimeout(cb, 16), cancelAnimationFrame: clearTimeout,
    getComputedStyle: node => ({ display: "block", visibility: node === confirmButton && game.buttonHidden ? "hidden" : "visible", opacity: node === question && game.questionOpacity ? "0" : "1" }),
    visualViewport: { width: 400, height: 800, offsetLeft: 0, offsetTop: 0 },
    CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = opts?.detail; } },
    console, trace, __CC_ANDROID_BOOTSTRAP__: { profile: { runtimeId: "chesscoach-android", documentId: "android-1" } }
  });
  context.window = context;
  context.top = context;
  vm.runInContext(fs.readFileSync(path.join(assets, "bridge/cc-android-polyfill.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(assets, "lib/openings.js"), "utf8"), context);
  const names = [
    "getMobileAnalysisConfig", "finishCurrentAnalysis", "scheduleEngineRecovery",
    "isOrphanedContextError", "handleMessageCallbackFailure", "invokeMessageCallback", "safeSendMessage",
    "isContextValid", "setMoveExecutionState", "cancelNativeMove", "isNativeAutoBlocked", "handleMobileMoveLifecycle",
    "clearAnalysisRetry", "scheduleAnalysisRetry", "resetTurnDecision", "clearPositionPresentation",
    "markBoardDirty", "adoptPositionState", "createAnalysisMeta", "isCurrentAnalysisMeta", "isCachedAnalysisCurrent",
    "forceRecalculate", "flushDeferredRecalculate", "releaseEngineForNativeBlock",
    "hasMyPieceOnSquare", "hasFinalAutoAnalysis", "scheduleAutoMoveIfNeeded",
    "executeAndroidMoveOnBoard", "executeMoveOnBoard", "detectBlackOrientation", "detectActualTurnOnBoard", "getLichessRoundPly",
    "getObservedPlyIndex", "detectRealMoveBetweenGrids", "isPlausibleDetectedMove", "disableStartposHistory",
    "updateCastlingEpAndRealHistory", "getCastlingString", "captureBoardState", "getStockfishMoveTimeMs", "runCycle",
    "applyAnalysisResult", "isStrictBrilliantMove", "getComparableMoveScoreCp", "getStructuredMateIn", "explainWithModule",
    "isDestinationBlockedByOwnPiece", "isDubiousGambitOpening", "getOpeningBookPremovePlan", "computeLocalInstantPremovePlan",
    "choosePremovePlan", "applyPremovePlanOnEnemyTurn", "maybePonderPredictedReply", "handleEnemyTurnInstantPremove", "triggerDebouncedCycle"
  ];
  vm.runInContext(`
    const chrome = window.__CC_ANDROID_RUNTIME__.chrome, FILES = "abcdefgh";
    let mobileSession = null, mobileAnalysisLease = null, cycleWakeTimer = null, engineRecoveryTimer = null;
    let boardMutationTimer = null, deferredRecalculate = false, nativeBlockEngineReleasedKey = "";
    let extensionInvalidated = false, positionId = 0, positionAnalysisId = 0, analysisRequestId = 0, positionRequestId = 0;
    let currentPositionKey = "", analysisSessionId = "fixture-session", boardDirty = true;
    let committedBoardKey = "", committedEnemyBoardKey = "", activeEngineBoardKey = "";
    let analysisRetryCount = 0, finalEngineRetryCount = 0, pendingAnalysisRetry = null;
    let autoMoveTimer = null, premoveTimer = null, animRetryTimer = null, isExecutingMove = false, activeNativeMove = null;
    let nativeMoveFailureKey = "", nativeMoveFailures = 0, nativeMoveBlockedKey = "", nativeMoveBlockedState = null, moveCooldownUntil = 0;
    let cachedMoves = {}, currentTurnDecision = {}, preparedLookahead = null, lastOurExecutedMove = null;
    let lastRealEnemyMove = null, lastPremoveSentBoardKey = "", prevGridState = null, prevBoardPartForHistory = "";
    let castlingRights = {K:true,Q:true,k:true,q:true}, currentEpSquare = "-", halfmoveClock = 0, fullmoveNumber = 1;
    let lastPathname = location.pathname, uciHistoryList = [], recentPositionHistory = [], sessionMoveHistory = [];
    let gameStartedFromInitial = false, lastObservedPly = null, openingBookDeviated = false;
    let evalGraphHistory = [], lastRecordedGraphBoardKey = "", lastTelemetryData = null, gameResultRecorded = false;
    let peerExtensionDetected = false, suspectEngineStreak = 0, lastBeaconCheckTime = 0;
    let autoMoveEnabled = true, premoveEnabled = false, bulletTurboMode = false, safeAntiBanGuard = false;
    let currentElo = 2000, engineMaxMode = false, useStockfishWasm = true, currentStyle = "balanced", workMode = "all";
    let showAverageMove = true, showWorstMove = false, useAverageMoveSometimes = false, trapRadarEnabled = false;
    let turnMode = "my", forcedMyColor = "auto", autoMoveTriggerRate = 100, legitAutoTiming = false;
    let autoMoveDelayMs = 60, autoMoveJitterMs = 0, autoClickMethod = "twoclick";
    let premoveOpeningMode = "auto", premoveReqId = 0, ponderRequestId = 0, premoveRiskLevel = 3;
    let audioRadarEnabled = false, phonkEditEnabled = false, roflMode = false, currentRoast = null;
    let showPremoveArrows = false, isAltPressed = false, heatmapAlwaysOn = false, rafPending = false;
    let showArrows = true, showEvalBar = true;
    const DUBIOUS_GAMBIT_KEYWORDS = [], ALL_STYLE_NAMES = {balanced:"balanced"}, premoveStepTimers = new Set(), nodes = new Map();
    function $(id) {
      if (!nodes.has(id)) nodes.set(id, {
        style:{}, classList:{toggle(){}}, textContent:"", handlers:{},
        addEventListener(type, handler) {this.handlers[type] = handler;}, click() {this.handlers.click?.();}
      });
      return nodes.get(id);
    }
    function setAutoStatusText(text) { trace.statuses.push(text); }
    function shutdownOrphanedScript() { trace.shutdowns++; extensionInvalidated = true; }
    function hideArrows() {} function renderEvalBar() {} function renderArrowsOverlay() { trace.arrowRenders++; }
    function updateLiveTelemetryUI() {} function updateEvalMoodAndEngineBadge() {} function renderLiveEvalGraph() {}
    function updateTimeSniperBanner() {} function recordEvalPoint() {} function renderPremovePreviewOverlay() {}
    function ensurePanel() {} function checkGameEndAndLearn() {} function checkOpponentExtensionBeacon() {}
    function isRatedGameAgainstHuman() { return false; }
    function getMyRemainingSeconds() { return 120; } function getEnemyRemainingSeconds() { return 120; }
    function chooseAutoMoveOnce(res) { return {move:res.best, typeLabel:"fixture", choiceKind:"best"}; }
    function mergeWasmAnalysisIntoResult(res) { return {...res,engineMeta:{depth:16}}; }
    const StockfishWasmEngine = { cancel() {trace.cancelled++;}, terminate() {trace.releases = (trace.releases || 0) + 1;}, initWorker:async () => true,
      analyze:async () => ({fixture:true}), whenDispatched:async () => ({requestId:"fixture-owned"}) };
    ${names.map(productionFunction).join("\n")}
    ${productionButton("cc-play-once")}
    ${productionButton("cc-auto-test-best")}
    window.addEventListener("cc-core-state", e => trace.states.push(e.detail));
    window.addEventListener("cc-mobile-lifecycle", handleMobileMoveLifecycle);
    globalThis.api = {
      cycle:runCycle, dirty:markBoardDirty, capture:captureBoardState,
      manual(id = "cc-play-once") { $(id).click(); }, auto(value) { autoMoveEnabled = value; },
      cancel() { cancelNativeMove("fixture-cancel", true); }, force:forceRecalculate, flush:flushDeferredRecalculate,
      premove(move) { premoveEnabled = true; mobileSession.ready.then(() => { const state = captureBoardState(false); adoptPositionState(state); executeAndroidMoveOnBoard(move,state,true,null,true); }); },
      snapshot() {return {positionId,boardDirty,isExecutingMove,active:!!activeNativeMove,nativeMoveFailures,lastOurExecutedMove,cachedMoves,uciHistoryList,extensionInvalidated,deferredRecalculate,nativeBlocked:!!nativeMoveBlockedState,nativeBlockEngineReleasedKey};}
    };
    window.__CC_MOBILE_PREFERENCES__ = { isReady: true, ready: Promise.resolve(),
      getEffective: () => ({ready:true,paused:false,lowTier:false,autoMoveEnabled,premoveEnabled,bulletTurboMode,
        showPremoveArrows,showArrows,showEvalBar,turnMode,audioRadarEnabled:false,mobileVisualEffects:false}) };
  `, context, { filename: "production/lichess-functions.js" });
  vm.runInContext(fs.readFileSync(path.join(assets, "bridge/cc-mobile-session.js"), "utf8"), context);
  vm.runInContext(`mobileSession = window.__CC_ANDROID_GAME_SESSION__;
    mobileSession.ready.then(() => {
      mobileSession.registerCore("lichess", {
        captureState: () => captureBoardState(true), isAnimating: board => Boolean(board.querySelector("piece.anim")),
        viewState: () => ({executing:isExecutingMove}),
        cancelSearch() {analysisRequestId++;positionAnalysisId++;activeEngineBoardKey="";},
        suspend() {resetTurnDecision();cancelNativeMove("fixture-pause");}, resume:triggerDebouncedCycle
      });
      runCycle(false);
    });`, context);
  const advance = async ms => {
    await flush();
    const target = now + ms;
    for (let i = 0; i < 1000; i++) {
      const next = [...timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) { now = target; await flush(); return; }
      timers.delete(next[0]); now = next[1].at; next[1].callback(); await flush();
    }
    throw new Error("Unbounded fixture timers");
  };
  return { context, api: context.api, game, trace, advance, applyMove, board };
}

function assertFailed(h) {
  assert.equal(h.api.snapshot().lastOurExecutedMove, null);
  assert.equal(h.api.snapshot().isExecutingMove, false);
  assert.equal(h.api.snapshot().active, false);
  assert.equal(h.trace.states.filter(s => s.reason === "confirmed").length, 0);
  assert.equal(h.game.serverPly, 0);
}

for (const orientation of ["white", "black"]) for (const confirmation of [false, true]) for (const navigation of ["mobile", "desktop"]) {
  test(`${orientation}/${navigation}, confirmation ${confirmation}: 2 own auto turns and later manual best actually submit`, async () => {
    const h = harness({ orientation, confirmation, navigation });
    if (orientation === "black") h.applyMove("e2e4");
    const listener = h.context.CCNative.onmessage;
    h.api.cycle(); await h.advance(850); h.api.cycle(); await h.advance(250);
    assert.equal(h.game.serverPly, orientation === "black" ? 2 : 1);
    const firstId = h.api.snapshot().positionId;
    h.context.location.hash = "#same-document";
    h.applyMove(orientation === "black" ? "g1f3" : "e7e5");
    h.api.dirty("MOVE"); h.api.cycle(); await h.advance(850); h.api.cycle(); await h.advance(250);
    assert.equal(h.game.serverPly, orientation === "black" ? 4 : 3);
    assert.ok(h.api.snapshot().positionId > firstId);
    h.api.auto(false); h.applyMove(orientation === "black" ? "f1c4" : "b8c6");
    h.api.dirty("MOVE"); h.api.cycle(); await h.advance(30);
    h.context.__CC_ANDROID_SETTINGS_OPEN__ = true;
    h.api.manual(orientation === "black" ? "cc-auto-test-best" : "cc-play-once"); await h.advance(850);
    assert.equal(h.game.serverPly, orientation === "black" ? 6 : 5);
    assert.equal(h.game.pendingSubmit, null);
    assert.equal(h.trace.confirmRequests, confirmation ? 3 : 0);
    assert.equal(h.trace.states.filter(s => s.reason === "confirmed").length, 3);
    assert.equal(h.api.snapshot().lastOurExecutedMove.uci, orientation === "black" ? "g8f6" : "f1c4");
    assert.equal(h.api.snapshot().isExecutingMove, false);
    assert.equal(h.context.CCNative.onmessage, listener);
    assert.equal(new Set(h.trace.gestures.map(e => e.payload.documentToken)).size, 1);
    assert.equal(new Set(h.trace.gestures.map(e => e.id)).size, h.trace.gestures.length);
    assert.equal(h.context.__CC_ANDROID_RUNTIME__.disposed, false);
  });
}

test("desktop replay NodeList survives initial auto analysis and a later own action", async () => {
  const h = harness({ navigation: "desktop" });
  h.api.cycle();
  await h.advance(850);

  const initialReplay = h.trace.replayCollections.find(collection => collection.length === 4 && collection.allDisabled);
  assert.ok(initialReplay, "initial four-button replay controls were observed");
  assert.equal(initialReplay.every, "undefined");
  assert.equal(h.trace.shutdowns, 0);
  assert.ok(h.trace.arrowRenders > 0, "analysis rendered arrows before auto input");
  assert.equal(h.game.serverPly, 1);

  h.api.auto(false);
  h.applyMove("e7e5");
  h.api.dirty("MOVE");
  h.api.cycle();
  await h.advance(30);
  h.api.manual();
  await h.advance(850);

  assert.equal(h.trace.shutdowns, 0);
  assert.equal(h.game.serverPly, 3);
  assert.equal(h.api.snapshot().lastOurExecutedMove.uci, "g1f3");
});

test("a normal Lichess move is one atomic drag even when tap selection redraw would linger", async () => {
  const h = harness({ lingerSelection: true });
  h.api.auto(true); h.api.cycle(); await h.advance(700);
  assert.deepEqual(h.game.moves, ["e2e4"]);
  const boardGestures = h.trace.gestures.filter(envelope => envelope.payload.action === "drag");
  assert.equal(boardGestures.length, 1);
  assert.equal(boardGestures[0].payload.action, "drag");
  assert.equal(boardGestures[0].payload.points.length, 3);
  assert.equal(h.game.animation, false);
});

test("an unrelated selected square cannot introduce a preliminary tap before the move", async () => {
  const h = harness();
  h.game.selected = "a2";
  h.api.auto(true); h.api.cycle(); await h.advance(700);
  assert.deepEqual(h.game.moves, ["e2e4"]);
  const boardGestures = h.trace.gestures.filter(envelope => envelope.payload.action === "drag");
  assert.deepEqual(boardGestures.map(envelope => envelope.payload.action), ["drag"]);
});

test("visual staging does not complete or enter move history before server submission", async () => {
  const h = harness({ confirmation: true, submitDelay: 500 });
  h.api.cycle(); await h.advance(320);
  assert.deepEqual(h.game.moves, ["e2e4"]);
  assert.equal(h.game.serverPly, 0);
  assert.equal(h.api.capture(true).actualTurn, "w");
  assert.equal(h.api.snapshot().lastOurExecutedMove, null);
  assert.equal(h.trace.states.filter(s => s.reason === "confirmed").length, 0);
  h.api.cycle();
  assert.equal(h.api.snapshot().lastOurExecutedMove, null);
  assert.equal(h.api.snapshot().uciHistoryList.length, 0);
  await h.advance(1000);
  assert.equal(h.game.serverPly, 1);
  assert.equal(h.trace.confirmRequests, 1);
  assert.equal(h.trace.states.filter(s => s.reason === "confirmed").length, 1);
});

for (const confirmBehavior of ["retain", "disappear"]) test(`failed submit (${confirmBehavior}) is not success and is never tapped twice`, async () => {
  const h = harness({ confirmation: true, confirmBehavior });
  h.api.cycle(); await h.advance(3500);
  assertFailed(h);
  assert.equal(h.trace.confirmRequests, 1);
  assert.ok(h.trace.statuses.some(s => s.includes("MOVE_CONFIRMATION_TIMEOUT")));
  for (let i = 0; i < 4; i++) { h.api.cycle(); await h.advance(500); }
  h.api.manual(); await h.advance(2000);
  assert.equal(h.trace.confirmRequests, 1);
  assertFailed(h);
});

test("cancellation while waiting for the pending question never taps a later control", async () => {
  const h = harness({ confirmation: true, questionDelay: 400 });
  h.api.cycle(); await h.advance(320); h.api.cancel(); await h.advance(1500);
  assert.equal(h.trace.confirmRequests, 0);
  assertFailed(h);
});

test("cancellation during the native confirmation touch prevents submit and success", async () => {
  const h = harness({ confirmation: true });
  h.api.cycle(); await h.advance(300);
  assert.equal(h.trace.confirmRequests, 1);
  h.api.cancel(); await h.advance(1500);
  assert.equal(h.trace.confirmRequests, 1);
  assertFailed(h);
});

for (const flag of ["buttonHidden", "buttonDetached", "buttonDisabled", "buttonForeign", "questionHidden", "questionOpacity"]) test(`${flag}: no confirmation gesture or false success`, async () => {
  const h = harness({ confirmation: true, [flag]: true });
  h.api.cycle(); await h.advance(2500);
  assert.equal(h.trace.confirmRequests, 0);
  assert.ok(h.trace.statuses.some(s => s.includes("MOVE_CONFIRMATION_UNAVAILABLE")));
  assertFailed(h);
});

test("a draw question's generic yes button is never treated as move confirmation", async () => {
  const h = harness({ confirmation: true, questionType: "draw" });
  h.api.cycle(); await h.advance(3500);
  assert.equal(h.trace.confirmRequests, 0);
  assertFailed(h);
});

test("a different manually staged move is not confirmed", async () => {
  const h = harness({ confirmation: true, stageReplacement: "d2d4" });
  h.api.cycle(); await h.advance(2500);
  assert.equal(h.game.pendingSubmit.uci, "d2d4");
  assert.equal(h.trace.confirmRequests, 0);
  assert.ok(h.trace.statuses.some(s => s.includes("MOVE_CONFIRMATION_CHANGED")));
  assertFailed(h);
});

test("a confirmation already present before this action is left untouched", async () => {
  const h = harness({ confirmation: true });
  h.applyMove("e2e4", true); h.api.cycle(); await h.advance(850);
  assert.equal(h.trace.gestures.length, 0);
  assert.ok(h.trace.statuses.some(s => s.includes("MOVE_CONFIRMATION_PENDING")));
  assertFailed(h);
});

for (const errorTarget of ["inputError", "confirmError"]) test(`${errorTarget}: native error code survives and failure state is not reset`, async () => {
  const h = harness({ confirmation: true, [errorTarget]: "INPUT_UNAVAILABLE" });
  h.api.cycle(); await h.advance(2500);
  assert.ok(h.trace.statuses.some(s => s.includes("INPUT_UNAVAILABLE")));
  assert.ok(h.api.snapshot().nativeMoveFailures > 0);
  assert.equal(h.trace.confirmRequests, errorTarget === "confirmError" ? 1 : 0);
  assertFailed(h);
});

for (const confirmation of [false, true]) for (const navigation of ["mobile", "desktop"]) test(`instant opponent reply (${navigation}, confirmation ${confirmation}) still confirms the submitted own move`, async () => {
  const h = harness({ confirmation, navigation, instantReply: true });
  h.api.cycle(); await h.advance(850);
  assert.ok(h.game.serverPly >= 2 && h.game.serverPly % 2 === 0);
  assert.equal(h.api.capture(true).actualTurn, "w");
  assert.ok(h.trace.states.some(s => s.reason === "confirmed"));
  assert.deepEqual(h.trace.submissions.slice(0, 2), ["e2e4", "e7e5"]);
});

test("absent confirmation UI is not sufficient when trustworthy server ply has not advanced", async () => {
  const h = harness({ visualOnly: true });
  h.api.cycle(); await h.advance(3500);
  assert.deepEqual(h.game.moves, ["e2e4"]);
  assert.equal(h.trace.confirmRequests, 0);
  assertFailed(h);
});

test("a different move submitted after the confirmation touch cannot complete this action", async () => {
  const h = harness({ confirmation: true });
  const initialGrid = h.game.grid.map(row => row.slice());
  h.api.cycle(); await h.advance(380);
  assert.equal(h.trace.confirmRequests, 1);
  h.game.grid = initialGrid; h.game.pendingSubmit = null; h.game.moves = [];
  h.applyMove("d2d4"); await h.advance(2000);
  assert.equal(h.game.serverPly, 1);
  assert.equal(h.trace.states.filter(s => s.reason === "confirmed").length, 0);
  assert.notEqual(h.api.snapshot().lastOurExecutedMove?.uci, "e2e4");
  assert.equal(h.api.snapshot().isExecutingMove, false);
  assert.equal(h.trace.confirmRequests, 1);
});

for (const orientation of ["white", "black"]) for (const navigation of ["mobile", "none"]) test(`${orientation}/${navigation}: real replies with stale own highlights and animation lag retain auto and manual`, async () => {
  const h = harness({ orientation, navigation });
  if (orientation === "black") h.applyMove("e2e4");
  h.api.cycle(); await h.advance(850); h.api.cycle(); await h.advance(250);
  const ownHighlights = h.game.highlights.slice();
  h.applyMove(orientation === "black" ? "g1f3" : "e7e5");
  h.game.highlights = ownHighlights;
  h.game.animation = true;
  h.api.dirty("MOVE"); h.api.cycle(); await h.advance(150);
  assert.equal(h.game.serverPly, orientation === "black" ? 3 : 2);
  h.game.animation = false;
  h.api.cycle(); await h.advance(850); h.api.cycle(); await h.advance(250);
  assert.equal(h.game.serverPly, orientation === "black" ? 4 : 3);
  const nextOwnHighlights = h.game.highlights.slice();
  h.api.auto(false); h.applyMove(orientation === "black" ? "f1c4" : "b8c6");
  h.game.highlights = nextOwnHighlights;
  h.api.dirty("MOVE"); h.api.cycle(); await h.advance(30);
  h.api.manual(); await h.advance(850);
  assert.equal(h.game.serverPly, orientation === "black" ? 6 : 5);
  assert.equal(h.trace.states.filter(s => s.reason === "confirmed").length, 3);
  assert.equal(h.api.snapshot().isExecutingMove, false);
});

test("server navigation and real running/turn-text clocks outrank optimistic highlights, but analysis boards retain fallback", () => {
  for (const orientation of ["white", "black"]) for (const navigation of ["mobile", "desktop", "none"]) {
    const h = harness({ orientation, navigation });
    assert.equal(h.api.capture(true).actualTurn, "w");
    h.applyMove("e2e4"); h.game.highlights = ["e7"];
    assert.equal(h.api.capture(true).actualTurn, "b");
  }
  const correspondence = harness({ navigation: "none", clockMode: "turn" });
  correspondence.applyMove("e2e4"); correspondence.game.highlights = ["e7"];
  assert.equal(correspondence.api.capture(true).actualTurn, "b");
  const analysis = harness({ realRound: false });
  analysis.applyMove("e2e4");
  assert.equal(analysis.api.capture(true).actualTurn, "b");
});

for (const confirmation of [false, true]) test(`promotion chooser preserves native target override with confirmation ${confirmation}`, async () => {
  const h = harness({ confirmation, planned: ["a7a8q", "h8g8"] });
  h.game.grid = [".......k", "P.......", "........", "........", "........", "........", "........", ".......K"].map(row => [...row].map(p => p === "." ? null : p));
  h.api.cycle(); await h.advance(1000);
  assert.equal(h.game.grid[0][0], "Q");
  assert.equal(h.game.serverPly, 1);
  assert.equal(h.trace.confirmRequests, confirmation ? 1 : 0);
  assert.equal(h.trace.states.filter(s => s.reason === "confirmed").length, 1);
  assert.equal(h.api.snapshot().lastOurExecutedMove.uci, "a7a8q");
});

test("native premove remains a queued board gesture, not a submission or confirmation", async () => {
  const h = harness({ confirmation: true });
  h.applyMove("e2e4"); h.api.auto(false); h.game.premove = true;
  h.api.premove({ from: "g1", to: "f3", uci: "g1f3" }); await h.advance(600);
  assert.equal(h.game.premoveSet, true);
  assert.equal(h.game.serverPly, 1);
  assert.equal(h.trace.confirmRequests, 0);
  assert.equal(h.api.snapshot().lastOurExecutedMove, null);
  assert.equal(h.api.snapshot().isExecutingMove, false);
  assert.equal(h.trace.states.filter(s => s.reason === "confirmed").length, 1);
});

test("the native fixture moves DOM at UP, with a fresh v1 snapshot immediately before DOWN", async () => {
  const h = harness();
  h.api.cycle(); await h.advance(200);
  assert.equal(h.game.moves.length, 0);
  assert.ok(h.trace.touches.some(touch => touch.phase === "DOWN"));
  await h.advance(150);
  assert.deepEqual(h.game.moves, ["e2e4"]);
  for (const gesture of h.trace.gestures) {
    assert.equal(gesture.payload.snapshot.v, 1);
    assert.equal(gesture.payload.snapshot.targetId, gesture.payload.targetId);
    assert.equal(gesture.payload.documentNonce, "fixture-document");
    const down = h.trace.touches.find(touch => touch.phase === "DOWN" && touch.id === gesture.id);
    const up = h.trace.touches.find(touch => touch.phase === "UP" && touch.id === gesture.id);
    assert.ok(down && up && up.at > down.at);
  }
});

test("an obscured pre-DOWN target fails once without auto replay, and an explicit later manual action can recover", async () => {
  const h = harness();
  h.api.cycle(); await h.advance(100);
  h.game.overlay = true;
  await h.advance(200);
  assert.equal(h.game.moves.length, 0);
  assert.equal(h.api.snapshot().isExecutingMove, false);
  assert.ok(h.trace.statuses.some(status => status.includes("INPUT_POSITION_CHANGED")));
  const attempts = h.trace.gestures.length;
  h.game.overlay = false;
  for (let i = 0; i < 4; i++) { h.api.cycle(); await h.advance(500); }
  assert.equal(h.trace.gestures.length, attempts);
  h.api.manual(); await h.advance(500);
  assert.deepEqual(h.game.moves, ["e2e4"]);
});

test("a blocked native position releases Stockfish once and forced recalculation stays deferred", async () => {
  const h = harness({ inputError: "INPUT_REJECTED" });
  h.api.auto(true); h.api.cycle(); await h.advance(850);
  assert.equal(h.api.snapshot().nativeBlocked, true);
  assert.equal(h.trace.releases, 1);
  const messages = h.trace.runtime.length;
  h.api.force(); h.api.force();
  await h.advance(5000);
  assert.equal(h.api.snapshot().deferredRecalculate, true);
  assert.equal(h.trace.runtime.length, messages);
  assert.equal(h.trace.releases, 1);
});
