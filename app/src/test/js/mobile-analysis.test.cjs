"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { performance } = require("node:perf_hooks");
const { setImmediate: nextTask } = require("node:timers/promises");
const fixtureSource = fs.readFileSync(path.join(__dirname, "engine-performance.test.cjs"), "utf8");
const fixtureModule = { exports: {} };
vm.runInNewContext(fixtureSource.slice(0, fixtureSource.indexOf("\ntest(")) +
  "\nmodule.exports={profile,baseContext,load,ownedHost};", {
  require, module: fixtureModule, __dirname, console, queueMicrotask, URL, TextEncoder, AbortController, performance
}, { filename: "existing-engine-fixtures.cjs" });
const { profile, baseContext, load, ownedHost } = fixtureModule.exports;
const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function linkedHost({ automaticWorker = true } = {}) {
  const host = ownedHost(profile());
  const { context: main } = baseContext(profile());
  const stats = { roots: 0, pv: 0, cloud: 0, trap: 0, premove: 0, requests: [] };
  const nativeTimers = new Set();
  const fakeSetTimeout = host.context.setTimeout;
  const fakeClearTimeout = host.context.clearTimeout;
  host.context.setTimeout = (fn, ms) => {
    if (ms > 32) return fakeSetTimeout(fn, ms);
    const timer = setTimeout(() => { nativeTimers.delete(timer); fn(); }, ms);
    nativeTimers.add(timer);
    return timer;
  };
  host.context.clearTimeout = timer => { clearTimeout(timer); nativeTimers.delete(timer); fakeClearTimeout(timer); };
  // Deterministic node budgets; the full browser regression uses real clocks.
  host.context.performance = { now: () => host.timers.now };
  for (const [name, count] of [["analyzeAdaptiveMaster", "roots"], ["searchPV", "pv"],
    ["computeTrapMetrics", "trap"], ["computeSmartNextPremove", "premove"]]) {
    const original = host.context[name];
    host.context[name] = function (...args) { stats[count]++; return original.apply(this, args); };
  }
  host.context.fetchLichessCloud3000 = async () => { stats.cloud++; return null; };
  host.context.fetchSyzygyTablebase = async () => null;
  const workerPost = host.context.Worker.prototype.postMessage;
  host.context.Worker.prototype.postMessage = function (command) {
    workerPost.call(this, command);
    if (automaticWorker && String(command).startsWith("go ")) setImmediate(() => {
      if (!this.terminated) this.finish("e2e4", "d2d4");
    });
  };
  main.location = new URL("https://lichess.org/mobile-analysis-fixture");
  main.top = main;
  main.__CC_ANDROID_BOOTSTRAP__ = { v: 1, storage: {}, storageRevision: 0, storageReady: true,
    profile: { ...profile(), runtimeId: "chesscoach_android_v1", documentId: "android-0", clientInstanceId: "fixture" } };
  let heldType = null;
  const held = [];
  const forward = envelope => setImmediate(() => host.context.CCEngineHost.dispatchFromNative(envelope));
  main.CCNative = { onmessage: null, postMessage(text) {
    const envelope = JSON.parse(text);
    if (envelope.type !== "runtime.message") return;
    stats.requests.push(envelope.payload.message);
    if (envelope.payload.message.type === heldType) held.push(envelope);
    else forward(envelope);
  } };
  host.context.CCEngineNative.postMessage = text => {
    if (JSON.parse(text).type === "runtime.response") setImmediate(() => main.CCNative.onmessage?.({ data: text }));
  };
  load(main, "bridge/cc-android-polyfill.js");
  main.chrome = main.__CC_ANDROID_RUNTIME__.chrome;
  load(main, "lib/engine-client.js");
  const engine = main.ChessCoachEngine.create();
  const message = data => new Promise(resolve => main.chrome.runtime.sendMessage(data, resolve));
  const flush = async () => { for (let i = 0; i < 8; i++) await nextTask(); };
  return {
    host, main, engine, stats, message, flush,
    hold(type) { heldType = type; },
    resume() { heldType = null; for (const envelope of held.splice(0)) forward(envelope); },
    async close() {
      engine.terminate(); await flush(); main.__CC_ANDROID_RUNTIME__.cleanup();
      for (const timer of nativeTimers) clearTimeout(timer);
    }
  };
}

const meta = analysisId => ({ sessionId: "mobile-analysis", positionId: 0, analysisId, elo: 2000, needAverage: true });
const analysis = (pass, metadata) => ({ type: "ANALYZE_POSITION", fen: START, elo: 2000, style: "balanced",
  pass, calcAverage: true, calcWorst: false, trapRadarEnabled: false, meta: metadata });

test("ten native-task generations execute one JS root, not ten discarded roots", async () => {
  const h = linkedHost();
  try {
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => h.message(analysis("fast", meta(i)))));
    assert.equal(h.stats.roots, 1);
    assert.equal(results.filter(result => result.code === "SUPERSEDED").length, 9);
    assert.equal(results[9].status, "ok");
    assert.equal(results[9].meta.positionId, 0);
    assert.equal(results[9].meta.analysisId, 9);
    console.log(`Native burst: requests=10 actualRoots=${h.stats.roots} superseded=9`);
  } finally { await h.close(); }
});

test("actual owned dispatch precedes deep annotation at initial position zero", async () => {
  const h = linkedHost();
  try {
    const primary = h.engine.analyze(START, 300, 2, [], false, meta(0));
    const dispatch = await h.engine.whenDispatched();
    assert.ok(dispatch?.requestId);
    const deep = await h.message(analysis("deep", { ...meta(0), annotationOnly: true, ownedEngineRequestId: dispatch.requestId }));
    assert.equal((await primary).searchCompleted, true);
    assert.equal(deep.search.annotationOnly, true);
    assert.deepEqual(h.stats.requests.slice(0, 2).map(request => request.type), ["ENGINE_ANALYZE", "ANALYZE_POSITION"]);
    assert.equal(h.stats.pv, 0);
    assert.equal(h.stats.cloud, 0);
    assert.equal(h.stats.trap, 0);
    assert.equal(h.stats.premove, 0);
    const roots = h.stats.roots;
    const nextPrimary = h.engine.analyze(START, 300, 2, [], false, meta(1));
    const nextDispatch = await h.engine.whenDispatched();
    const repeated = await h.message(analysis("deep", { ...meta(1), annotationOnly: true, ownedEngineRequestId: nextDispatch.requestId }));
    assert.equal((await nextPrimary).cached, true);
    assert.equal(repeated.search.cached, true);
    assert.equal(repeated.meta.analysisId, 1);
    assert.equal(h.stats.roots, roots);
    assert.equal(h.host.workers[0].commands.filter(command => command.startsWith("go ")).length, 1);
  } finally { await h.close(); }
});

test("a forged or cancelled owned marker never falls back to a full root", async () => {
  const h = linkedHost();
  try {
    const result = await h.message(analysis("deep", { ...meta(0), annotationOnly: true, ownedEngineRequestId: "missing" }));
    assert.equal(result.code, "SUPERSEDED");
    assert.equal(h.stats.roots, 0);
    const primary = h.engine.analyze(START, 300, 2, [], false, meta(1));
    const dispatch = await h.engine.whenDispatched();
    await primary;
    h.engine.cancel(); await h.flush();
    const cancelled = await h.message(analysis("deep", { ...meta(1), annotationOnly: true, ownedEngineRequestId: dispatch.requestId }));
    assert.equal(cancelled.code, "SUPERSEDED");
    assert.equal(h.stats.roots, 0);
  } finally { await h.close(); }
});

test("identical active owned requests share one search and retag only the current response", async () => {
  const h = linkedHost({ automaticWorker: false });
  try {
    const first = h.engine.analyze(START, 300, 2, [], false, meta(0));
    await h.flush();
    const second = h.engine.analyze(START, 300, 2, [], false, meta(1));
    await h.flush();
    const worker = h.host.workers[0];
    assert.equal(worker.commands.filter(command => command.startsWith("go ")).length, 1);
    assert.equal(worker.commands.includes("stop"), false);
    worker.finish("e2e4", "d2d4");
    assert.equal(await first, null);
    assert.equal((await second).meta.analysisId, 1);
  } finally { await h.close(); }
});

test("cancellation behind a pending release settles dispatch without starting an orphan", async () => {
  const h = linkedHost();
  try {
    await h.engine.analyze(START, 300, 2, [], false, meta(0));
    h.hold("ENGINE_RELEASE"); h.engine.terminate(); await h.flush();
    const pending = h.engine.analyze(START, 300, 2, [], false, meta(1));
    const dispatch = h.engine.whenDispatched();
    h.engine.cancel();
    assert.equal(await dispatch, null);
    h.resume();
    assert.equal(await pending, null);
    assert.equal(h.stats.requests.filter(request => request.type === "ENGINE_ANALYZE").length, 1);
  } finally { h.resume(); await h.close(); }
});

test("a setup exception also settles whenDispatched and never sends an engine request", async () => {
  const h = linkedHost();
  try {
    const poisoned = Object.defineProperty({}, "elo", { enumerable: true, get() { throw new Error("metadata failure"); } });
    const pending = h.engine.analyze(START, 300, 2, [], false, poisoned);
    assert.equal(await h.engine.whenDispatched(), null);
    assert.equal(await pending, null);
    assert.equal(h.stats.requests.length, 0);
  } finally { await h.close(); }
});

test("late cancelled generations stay rejected while a new generation can recover", async () => {
  const h = linkedHost({ automaticWorker: false });
  try {
    const queued = h.message(analysis("fast", meta(0)));
    const primary = h.engine.analyze(START, 300, 2, [], false, meta(0));
    await h.engine.whenDispatched(); h.engine.cancel();
    assert.equal(await primary, null);
    assert.ok(["CANCELLED", "SUPERSEDED"].includes((await queued).code));
    assert.equal(h.stats.roots, 0);
    const late = await h.message(analysis("fast", meta(0)));
    assert.equal(late.code, "SUPERSEDED"); assert.equal(h.stats.roots, 0);
    assert.equal((await h.message(analysis("fast", meta(1)))).status, "ok");
    assert.equal(h.stats.roots, 1);
  } finally { await h.close(); }
});
