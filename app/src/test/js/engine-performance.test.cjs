"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { performance } = require("node:perf_hooks");

const ASSETS = path.resolve(__dirname, "../../main/assets");
const APP_ORIGIN = "https://appassets.androidplatform.net";
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const FULL = "stockfish-19-full-single-wasm";
const LITE = "stockfish-19-lite-asm";

function profile(tier = "BALANCED", extra = {}) {
  return {
    memory: { totalBucketMiB: tier === "HIGH" ? 8192 : 4096 },
    cpu: { logicalCores: 8 },
    power: { saveMode: false, thermalStatus: 0, backgroundRestricted: false },
    recommendation: { tier, hashMiB: tier === "LOW" ? 16 : 32, movetimeScale: 1 },
    ...extra
  };
}

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatchEvent(event) {
      for (const listener of Array.from(listeners.get(event.type) || [])) listener(event);
      return true;
    }
  };
}

async function flush() {
  for (let index = 0; index < 40; index++) await Promise.resolve();
}

function timerHarness() {
  let sequence = 0;
  let now = 0;
  const pending = new Map();
  return {
    setTimeout(callback, delay = 0) {
      const id = ++sequence;
      pending.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout(id) { pending.delete(id); },
    async advance(delay) {
      const target = now + delay;
      for (let count = 0; count < 100; count++) {
        const next = Array.from(pending.entries()).filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) { now = target; return; }
        pending.delete(next[0]);
        now = next[1].at;
        next[1].callback();
        await flush();
      }
      throw new Error("Unexpected continuous timer work");
    },
    get size() { return pending.size; }
  };
}

function baseContext(deviceProfile, clock = performance) {
  const timers = timerHarness();
  const context = {
    ...eventTarget(),
    console: { error() {}, warn() {}, log() {} },
    URL, TextEncoder, AbortController, queueMicrotask,
    performance: clock,
    navigator: { userAgent: "Android ChessCoach", hardwareConcurrency: 8 },
    location: new URL(`${APP_ORIGIN}/assets/engine/engine-host.html`),
    document: { ...eventTarget(), currentScript: null, visibilityState: "visible" },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    __CC_DEVICE_PROFILE__: deviceProfile
  };
  context.window = context;
  context.self = context;
  vm.createContext(context);
  return { context, timers };
}

function load(context, asset) {
  context.document.currentScript = { src: `${APP_ORIGIN}/__cc_assets/${asset}` };
  vm.runInContext(fs.readFileSync(path.join(ASSETS, asset), "utf8"), context, { filename: asset, timeout: 2000 });
  context.document.currentScript = null;
}

function ownedHost(deviceProfile = profile()) {
  const { context, timers } = baseContext(deviceProfile);
  const workers = [];
  const envelopes = [];
  const storage = new Map();
  context.localStorage = {
    getItem: key => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key)
  };
  context.CCEngineNative = { postMessage: text => envelopes.push(JSON.parse(text)) };
  context.CHESSCOACH_ECO_BOOK = { positions: {} };
  context.Worker = class {
    constructor(url) { this.url = url; this.commands = []; this.terminated = false; workers.push(this); }
    postMessage(command) {
      assert.equal(this.terminated, false);
      this.commands.push(command);
      if (command === "uci") queueMicrotask(() => this.emit("uciok"));
      if (command === "isready") queueMicrotask(() => this.emit("readyok"));
    }
    emit(line) { this.onmessage?.({ data: line }); }
    terminate() { this.terminated = true; }
    finish(best = "e2e4", alternative = null) {
      this.emit(`info depth 8 multipv 1 score cp 30 nodes 1000 pv ${best}`);
      if (alternative) this.emit(`info depth 8 multipv 2 score cp 20 nodes 1000 pv ${alternative}`);
      this.emit(`bestmove ${best}`);
    }
  };
  load(context, "engine/engine-runtime.js");
  load(context, "background/background.js");
  load(context, "offscreen/offscreen.js");
  load(context, "engine/engine-host.js");
  let sequence = 0;
  const request = (type = "ENGINE_ANALYZE", extra = {}) => context.__CC_ENGINE_RUNTIME__.dispatch({
    type, target: "background-engine", requestId: `engine-test-${++sequence}`, clientInstanceId: "test-client-1",
    fen: START_FEN, movetimeMs: 10000, multiPv: 3, hashMb: 128, backend: FULL,
    meta: { sessionId: "test-session", positionId: 1, needAverage: true }, ...extra
  }, { url: "https://lichess.org/analysis", origin: "https://lichess.org", tabId: 1, frameId: 0 });
  return { context, timers, workers, envelopes, request };
}

function backgroundContext(deviceProfile = profile(), clock = performance) {
  const result = baseContext(deviceProfile, clock);
  result.context.chrome = {
    runtime: { onMessage: { addListener() {} }, getURL: asset => `${APP_ORIGIN}/__cc_assets/${asset}` },
    storage: { local: { get: (keys, callback) => callback({}) } }
  };
  load(result.context, "background/background.js");
  result.context.fetchLichessCloud3000 = async () => null;
  result.context.fetchSyzygyTablebase = async () => null;
  return result;
}

function clientContext(initial = profile(), completed = true) {
  const { context, timers } = baseContext(initial);
  const messages = [];
  let liveProfile = initial;
  let workerStarts = 0;
  let fetches = 0;
  let frames = 0;
  context.__CC_ANDROID_RUNTIME__ = { version: 1, disposed: false, get profile() { return liveProfile; } };
  context.fetch = () => { fetches++; throw new Error("Remote fetch must not run"); };
  context.Worker = class { constructor() { workerStarts++; throw new Error("Remote Worker must not run"); } };
  context.requestAnimationFrame = () => { frames++; return frames; };
  context.chrome = { runtime: {
    sendMessage(message, callback) {
      messages.push(message);
      const line = { uci: "e2e4", from: "e2", to: "e4", pv: ["e2e4"], scoreCp: 30 };
      callback({ ok: true, backend: message.backend, result: { bestUci: "e2e4", primaryLine: line, lines: { 1: line }, searchCompleted: completed } });
    }
  } };
  load(context, "lib/engine-client.js");
  return {
    context, timers, messages,
    updateProfile: value => { liveProfile = value; },
    counts: () => ({ workerStarts, fetches, frames })
  };
}

test("Android LOW/BALANCED always use the owned ENGINE bridge, not remote Blob/Worker/fetch", async () => {
  for (const tier of ["LOW", "BALANCED"]) {
    const harness = clientContext(profile(tier));
    const engine = harness.context.ChessCoachEngine.create();
    assert.equal(await engine.initWorker(), true);
    const result = await engine.analyze(START_FEN, 10000, 3, [], false, { elo: 1600, needAverage: true });
    assert.equal(result.bestUci, "e2e4");
    const message = harness.messages.find(value => value.type === "ENGINE_ANALYZE");
    assert.equal(message.target, "background-engine");
    assert.equal(message.backend, LITE);
    assert.equal(message.multiPv, 2);
    assert.equal(message.hashMb, tier === "LOW" ? 16 : 32);
    assert.equal(message.movetimeMs, tier === "LOW" ? 180 : 260);
    assert.deepEqual(harness.counts(), { workerStarts: 0, fetches: 0, frames: 0 });
    engine.terminate();
    await flush();
    assert.equal(harness.messages.at(-1).type, "ENGINE_RELEASE");
    assert.equal((await engine.analyze(START_FEN)).bestUci, "e2e4", "release must allow later lazy restart");
  }
});

test("live Android thermal/power profiles override immutable bootstrap and HIGH never exceeds ceilings", async () => {
  const harness = clientContext(profile("HIGH"));
  const engine = harness.context.ChessCoachEngine.create();
  await engine.analyze(START_FEN, 10000, 3);
  assert.equal(harness.messages.at(-1).backend, FULL);
  assert.equal(harness.messages.at(-1).movetimeMs, 400);
  assert.equal(harness.messages.at(-1).hashMb, 32);
  harness.updateProfile(profile("HIGH", { power: { saveMode: true, thermalStatus: 3 } }));
  await engine.analyze(START_FEN, 10000, 3);
  assert.equal(harness.messages.at(-1).backend, LITE);
  assert.equal(harness.messages.at(-1).movetimeMs, 180);
  assert.equal(harness.messages.at(-1).hashMb, 16);
  assert.equal(engine.getResourceProfile().fullNnue, false);
});

test("a timeout-only PV is not completed readiness and full failure falls back only in owned context", async () => {
  const harness = clientContext(profile("HIGH"), false);
  const engine = harness.context.ChessCoachEngine.create();
  assert.equal(await engine.analyze(START_FEN), null);
  assert.equal(await engine.analyze(START_FEN), null);
  assert.equal(harness.messages.filter(value => value.type === "ENGINE_ANALYZE").at(-1).backend, LITE);
  assert.deepEqual(harness.counts(), { workerStarts: 0, fetches: 0, frames: 0 });
});

test("remote hidden/pagehide releases once and later visible analysis restarts without a frame loop", async () => {
  const harness = clientContext();
  const engine = harness.context.ChessCoachEngine.create();
  await engine.analyze(START_FEN);
  harness.context.document.visibilityState = "hidden";
  harness.context.document.dispatchEvent({ type: "visibilitychange" });
  harness.context.dispatchEvent({ type: "pagehide", persisted: true });
  assert.equal(harness.messages.filter(value => value.type === "ENGINE_RELEASE").length, 1);
  assert.equal(await engine.analyze(START_FEN), null);
  assert.equal(engine.isReady(), false);
  harness.context.document.visibilityState = "visible";
  assert.equal((await engine.analyze(START_FEN)).bestUci, "e2e4");
  assert.deepEqual(harness.counts(), { workerStarts: 0, fetches: 0, frames: 0 });
});

test("owned Lite runs from app asset origin with Threads=1, modest Hash, capped time and one alternative", async () => {
  const harness = ownedHost();
  const pending = harness.request();
  await flush();
  const worker = harness.workers[0];
  assert.equal(worker.url, `${APP_ORIGIN}/__cc_assets/lib/stockfish-local.js`);
  assert.ok(worker.commands.includes("setoption name Threads value 1"));
  assert.ok(worker.commands.includes("setoption name Hash value 32"));
  assert.ok(worker.commands.includes("setoption name MultiPV value 2"));
  assert.ok(worker.commands.includes("go movetime 260"));
  worker.finish("e2e4", "d2d4");
  const response = await pending;
  assert.equal(response.backend, LITE);
  assert.equal(response.result.resources.fullNnue, false);
  assert.equal(response.result.searchCompleted, true);
  assert.equal(response.result.lines[2].uci, "d2d4");
  assert.equal(response.result.workers, 1);
  const invalid = await harness.request("ENGINE_INIT", { backend: "blob:untrusted-worker" });
  assert.equal(invalid.code, "INVALID_BACKEND");
  assert.equal(harness.workers.length, 1);
});

test("ordinary supersession drains bestmove, ignores readyok/stale info and reuses the worker", async () => {
  const harness = ownedHost();
  const first = harness.request();
  await flush();
  const worker = harness.workers[0];
  const second = harness.request("ENGINE_ANALYZE", { fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2" });
  await flush();
  assert.equal((await first).code, "SUPERSEDED");
  assert.equal(worker.terminated, false);
  assert.equal(worker.commands.filter(command => command.startsWith("go ")).length, 1);
  assert.ok(worker.commands.includes("stop"));
  worker.emit("readyok");
  worker.emit("info depth 99 score mate 1 pv e2e4");
  await flush();
  assert.equal(worker.commands.filter(command => command.startsWith("go ")).length, 1);
  worker.emit("bestmove e2e4");
  await flush();
  assert.equal(worker.commands.filter(command => command.startsWith("go ")).length, 2);
  worker.finish("d2d4", "g1f3");
  const response = await second;
  assert.equal(response.result.bestUci, "d2d4");
  assert.equal(response.result.primaryLine.isMate, false);
  assert.equal(harness.workers.length, 1);
});

test("release terminates actual Stockfish, clears cached work and supports restart", async () => {
  const harness = ownedHost();
  const active = harness.request();
  await flush();
  assert.equal((await harness.request("ENGINE_RELEASE")).released, true);
  assert.equal((await active).code, "RELEASED");
  assert.equal(harness.workers[0].terminated, true);
  const restarted = harness.request();
  await flush();
  assert.equal(harness.workers.length, 2);
  harness.workers[0].emit("bestmove a1a8");
  harness.workers[1].finish("e2e4", "d2d4");
  assert.equal((await restarted).result.bestUci, "e2e4");
});

test("release-before-create and rapid suspend/resume cannot start an orphaned old search", async () => {
  const harness = ownedHost();
  const init = harness.request("ENGINE_INIT");
  const release = harness.request("ENGINE_RELEASE");
  assert.equal((await init).code, "RELEASED");
  assert.equal((await release).ok, true);
  await flush();
  assert.equal(harness.workers.length, 0);
  const stale = harness.request();
  const rejected = assert.rejects(stale, error => error.code === "ENGINE_SUSPENDED");
  harness.context.CCEngineHost.suspendForApp();
  harness.context.CCEngineHost.resumeForApp(profile());
  await rejected;
  await flush();
  assert.equal(harness.workers.length, 0);
  const current = harness.request();
  await flush();
  assert.equal(harness.workers.length, 1);
  harness.workers[0].finish("e2e4", "d2d4");
  assert.equal((await current).result.searchCompleted, true);
});

test("changing owned backend waits for old bestmove drain rather than blindly terminating a search", async () => {
  const harness = ownedHost(profile("HIGH"));
  const first = harness.request("ENGINE_ANALYZE", { backend: LITE });
  await flush();
  const lite = harness.workers[0];
  const second = harness.request("ENGINE_ANALYZE", { backend: FULL });
  await flush();
  assert.equal((await first).code, "SUPERSEDED");
  assert.equal(lite.terminated, false);
  assert.equal(harness.workers.length, 1);
  lite.emit("bestmove e2e4");
  await flush();
  assert.equal(lite.terminated, true);
  assert.equal(harness.workers.length, 2);
  assert.equal(harness.workers[1].url, `${APP_ORIGIN}/__cc_assets/vendor/stockfish/stockfish-19-single.js`);
  harness.workers[1].finish("d2d4", "e2e4");
  assert.equal((await second).result.resources.fullNnue, true);
});

test("owned timeout PV is incomplete, never cached and still drains before the next search", async () => {
  const harness = ownedHost();
  const first = harness.request();
  await flush();
  const worker = harness.workers[0];
  worker.emit("info depth 8 score cp 30 pv e2e4");
  await harness.timers.advance(2760);
  const timeout = await first;
  assert.equal(timeout.result.partial, true);
  assert.equal(timeout.result.searchCompleted, false);
  const second = harness.request();
  await flush();
  assert.equal(worker.commands.filter(command => command.startsWith("go ")).length, 1);
  worker.emit("bestmove e2e4");
  await flush();
  assert.equal(worker.commands.filter(command => command.startsWith("go ")).length, 2);
  worker.finish("d2d4", "e2e4");
  const complete = await second;
  assert.equal(complete.result.bestUci, "d2d4");
  assert.equal(complete.result.searchCompleted, true);
  assert.notEqual(complete.result.cached, true);
});

test("owned suspend/visibility/bfcache stop workers, block new work and resume without eager init", async () => {
  const harness = ownedHost();
  const pending = harness.request();
  const rejected = assert.rejects(pending, error => error.code === "ENGINE_SUSPENDED");
  await flush();
  harness.context.CCEngineHost.suspendForApp();
  await rejected;
  assert.equal(harness.workers[0].terminated, true);
  assert.equal((await harness.context.chrome.runtime.getContexts()).length, 0);
  await assert.rejects(harness.request(), error => error.code === "ENGINE_SUSPENDED");
  harness.context.CCEngineHost.resumeForApp(profile("LOW"));
  assert.equal(harness.workers.length, 1, "resume must leave engine cold");
  const restarted = harness.request();
  await flush();
  assert.equal(harness.workers.length, 2);
  assert.ok(harness.workers[1].commands.includes("setoption name Hash value 16"));
  assert.ok(harness.workers[1].commands.includes("go movetime 180"));
  harness.workers[1].finish("e2e4", "d2d4");
  await restarted;
  harness.context.document.visibilityState = "hidden";
  harness.context.document.dispatchEvent({ type: "visibilitychange" });
  assert.equal(harness.workers[1].terminated, true);
  harness.context.document.visibilityState = "visible";
  harness.context.document.dispatchEvent({ type: "visibilitychange" });
  assert.equal(harness.workers.length, 2);
  harness.context.dispatchEvent({ type: "pagehide", persisted: true });
  assert.equal(harness.context.__CC_ENGINE_RUNTIME__.suspended, true);
  harness.context.dispatchEvent({ type: "pageshow", persisted: true });
  assert.equal(harness.context.__CC_ENGINE_RUNTIME__.suspended, false);
});

test("profile downgrade terminates too-costly owned full worker and restarts Lite", async () => {
  const harness = ownedHost(profile("HIGH"));
  const pending = harness.request();
  await flush();
  assert.equal(harness.workers[0].url, `${APP_ORIGIN}/__cc_assets/vendor/stockfish/stockfish-19-single.js`);
  assert.ok(harness.workers[0].commands.includes("go movetime 400"));
  harness.context.CCEngineHost.refreshDeviceProfileForApp(profile("LOW"));
  assert.equal(harness.workers[0].terminated, true);
  assert.equal((await pending).code, "PROFILE_CHANGED");
  const restarted = harness.request();
  await flush();
  assert.equal(harness.workers[1].url, `${APP_ORIGIN}/__cc_assets/lib/stockfish-local.js`);
  harness.workers[1].finish("e2e4", "d2d4");
  assert.equal((await restarted).backend, LITE);
});

test("long idle and virtual offscreen close really free Stockfish, then createDocument restarts", async () => {
  const harness = ownedHost();
  const pending = harness.request();
  await flush();
  harness.workers[0].finish("e2e4", "d2d4");
  await pending;
  assert.equal((await harness.context.chrome.runtime.getContexts()).length, 1);
  await harness.timers.advance(30000);
  assert.equal(harness.workers[0].terminated, true);
  assert.equal((await harness.context.chrome.runtime.getContexts()).length, 0);
  assert.equal(harness.timers.size, 0, "no idle polling should remain after teardown");
  const restarted = harness.request();
  await flush();
  assert.equal(harness.workers.length, 2);
  harness.workers[1].finish("e2e4", "d2d4");
  await restarted;
  await harness.context.chrome.offscreen.closeDocument();
  assert.equal(harness.workers[1].terminated, true);
});

test("owned host still rejects unapproved forwarded origins and packaged Lite needs no unsafe eval", () => {
  const harness = ownedHost();
  harness.context.CCEngineHost.dispatchFromNative({
    v: 1, scope: "chesscoach.android", channel: "runtime", source: "remote", target: "ENGINE",
    type: "runtime.message", id: "untrusted-request-1",
    payload: { message: { target: "background-engine", type: "ENGINE_INIT" }, sender: { url: "https://evil.example/" } }
  });
  assert.equal(harness.workers.length, 0);
  const lite = fs.readFileSync(path.join(ASSETS, "lib/stockfish-local.js"), "utf8");
  assert.equal(/\beval\s*\(|\bnew\s+Function\s*\(/.test(lite), false);
  const hostHtml = fs.readFileSync(path.join(ASSETS, "engine/engine-host.html"), "utf8");
  assert.ok(hostHtml.includes("worker-src 'self'"));
  assert.equal(hostHtml.includes("'unsafe-eval'"), false);
  assert.equal(hostHtml.includes("blob:"), false);
});

test("recursive PV/quiescence are node-bounded and never cache an interrupted root as exact", () => {
  const { context } = backgroundContext(profile(), { now: () => 0 });
  const parsed = context.parseFEN(START_FEN);
  const budget = context.createSearchBudget(1000, 40);
  const interrupted = vm.runInContext("SEARCH_INTERRUPTED", context);
  assert.throws(() => context.searchPV(parsed.board, "w", 6, -30000, 30000, "balanced", "KQkq", null, 0, true, 0, 0, budget), error => error === interrupted);
  assert.equal(budget.nodes, 40);
  assert.equal(budget.interrupted, true);
  const key = `${context.boardToHash(parsed.board, "w", "KQkq", null, 0)}_balanced_1_0`;
  assert.equal(vm.runInContext("transpositionTable", context).has(key), false);
  const complete = context.searchPV(parsed.board, "w", 1, -30000, 30000, "balanced", "KQkq", null, 0, false, 0, 0, context.createSearchBudget(1000, 50000));
  assert.ok(Number.isFinite(complete.score));
  assert.ok(context.generateLegalMoves(parsed.board, "w", "KQkq").some(move => context.moveToText(move) === complete.pv[0]));
});

test("monotonic deadline interrupts quiescence even if wall time moves backwards", () => {
  let now = 0;
  const { context } = backgroundContext(profile(), { now: () => ++now });
  vm.runInContext("Date.now = () => -100000", context);
  const parsed = context.parseFEN(START_FEN);
  const budget = context.createSearchBudget(2, 50000);
  assert.throws(() => context.quiescence(parsed.board, "w", -30000, 30000, "balanced", "KQkq", null, 0, 10, 0, 0, budget), error => error === vm.runInContext("SEARCH_INTERRUPTED", context));
  assert.equal(budget.interrupted, true);
  assert.ok(budget.nodes < 10);
});

test("mate/trap/premove nested work shares the same bound, with no vacuous forced-mate result", () => {
  const { context } = backgroundContext(profile(), { now: () => 0 });
  const parsed = context.parseFEN(START_FEN);
  const move = context.generateLegalMoves(parsed.board, "w", "KQkq")[0];
  const after = context.makeMove(parsed.board, move);
  const interrupted = vm.runInContext("SEARCH_INTERRUPTED", context);
  const calls = [
    budget => context.allowsEnemyMateInOne(after, "w", "b", "KQkq", null, budget),
    budget => context.deliversForcedMateInTwo(after, "w", "b", "KQkq", null, budget),
    budget => context.allowsEnemyForcedMateInTwo(after, "w", "b", "KQkq", null, budget),
    budget => context.computeTrapMetrics(after, move, "w", "b", "KQkq", null, "balanced", budget),
    budget => context.computeSmartNextPremove(after, "w", "b", "KQkq", null, move, "balanced", [], null, 0, budget)
  ];
  for (const call of calls) {
    const budget = context.createSearchBudget(1000, 3);
    assert.throws(() => call(budget), error => error === interrupted);
    assert.equal(budget.nodes, 3);
  }
  const mate = context.parseFEN("7k/6Q1/6K1/8/8/8/8/8 b - - 0 1");
  assert.equal(context.searchPV(mate.board, "b", 3, -30000, 30000, "balanced", "-", null, 0, false, 0, 0, context.createSearchBudget(1000, 50000)).score, -20000);
  const replies = context.generateLegalMoves(after, "b", "KQkq").slice(0, 2);
  let provenReplies = 0;
  context.generateLegalMoves = () => replies;
  context.allowsEnemyMateInOne = (...args) => {
    context.checkSearchBudget(args.at(-1));
    provenReplies++;
    return true;
  };
  assert.throws(() => context.deliversForcedMateInTwo(after, "w", "b", "KQkq", null, context.createSearchBudget(1000, 3)), error => error === interrupted);
  assert.equal(provenReplies, 1, "one proven branch cannot establish mate against every reply");
});

test("interrupted ELO2500 root analysis preserves every legal UCI, requested alternatives and coherent non-mate PV", async () => {
  let now = 0;
  const { context } = backgroundContext(profile(), { now: () => ++now });
  const result = await context.analyzeAdaptiveMaster(START_FEN, 2500, "balanced", "fast");
  const legal = context.generateLegalMoves(context.parseFEN(START_FEN).board, "w", "KQkq");
  assert.equal(result.partial, true);
  assert.equal(result.analysisIncomplete, true);
  assert.equal(result.search.interrupted, true);
  assert.ok(result.search.nodes <= result.search.nodeLimit);
  assert.equal(result.legalUcis.length, legal.length);
  assert.ok(result.legalUcis.includes(result.best.uci));
  assert.ok(result.legalUcis.includes(result.average.uci));
  assert.equal(result.best.pvLine, context.moveToText(result.best.rawMove));
  assert.equal(result.best.isForcedMateInTwo, false);
  assert.equal(result.best.isMateInOne, false);
  assert.equal(result.best.isCheckmate, false);
  assert.equal(result.hardRejectedUcis.length, 0);
});

test("same-position Stockfish makes mobile deep JS annotation-only, without duplicate PV/traps/network/premove", async () => {
  const harness = ownedHost();
  const { context } = harness;
  const meta = { sessionId: "owned-session", positionId: 2, analysisId: 3, annotationOnly: true, ownedEngineRequestId: "annotation-owner" };
  const primary = harness.request("ENGINE_ANALYZE", { requestId: "annotation-owner", meta });
  await flush();
  let extraSearches = 0;
  for (const name of ["searchPV", "computeTrapMetrics", "computeSmartNextPremove", "fetchLichessCloud3000", "fetchSyzygyTablebase"]) {
    context[name] = () => { extraSearches++; throw new Error(`Unnecessary ${name}`); };
  }
  const result = await context.analyzeAdaptiveMaster(START_FEN, 2500, "balanced", "deep", null, false, true, true, "w", 999, 999, true, [], null, "1:0:owned-session", [], false, meta);
  harness.workers[0].finish("e2e4", "d2d4");
  assert.equal((await primary).ok, true);
  assert.equal(extraSearches, 0);
  assert.equal(result.search.annotationOnly, true);
  assert.equal(result.legalUcis.length, 20);
  assert.equal(result.analysisIncomplete, true);
  assert.equal(result.pass, "fast");
  assert.equal(result.isDangerPosition, true, "existing auto gate must await final Stockfish if annotation-only search fails");
  assert.ok(result.search.nodes <= result.search.nodeLimit);
});

test("real-clock mobile fast/deep work stays within modest ceilings on high-mobility and pawn endings", async () => {
  const fens = [START_FEN, "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", "8/8/8/4k3/4P3/4K3/8/8 w - - 0 1"];
  const { context } = backgroundContext(profile("HIGH"));
  for (const fen of fens) {
    for (const pass of ["fast", "deep"]) {
      const started = performance.now();
      const result = await context.analyzeAdaptiveMaster(fen, 2500, "balanced", pass);
      assert.ok(result.best);
      assert.ok(result.legalUcis.includes(result.best.uci));
      assert.ok(result.search.nodes <= result.search.nodeLimit);
      assert.ok(result.search.timeBudgetMs <= (pass === "fast" ? 40 : 120));
      assert.ok(performance.now() - started < 500, "cooperative work must not run arbitrarily long");
    }
  }
});
