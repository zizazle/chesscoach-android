"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(path.resolve(__dirname, "../../main/assets/content/content.js"), "utf8");
const start = source.indexOf("  function isOrphanedContextError(");
const end = source.indexOf("\n  function getShadow()", start);
assert.ok(start >= 0 && end > start, "Lichess callback safety block is missing");
const safetyBlock = source.slice(start, end);

function harness() {
  const calls = { shutdown: 0, errors: [], statuses: [], finish: [] };
  const context = vm.createContext({
    console: { error(...args) { calls.errors.push(args); } },
    window: { __CC_ANDROID_RUNTIME__: { disposed: false } },
    chrome: { runtime: { lastError: null, sendMessage(_payload, callback) { queueMicrotask(() => callback({ ok: true })); } } },
    queueMicrotask,
    extensionInvalidated: false,
    mobileAnalysisLease: { id: "analysis-1" },
    activeEngineBoardKey: "active",
    committedBoardKey: "committed",
    isContextValid: () => true,
    shutdownOrphanedScript() { calls.shutdown++; },
    mobileSession: {
      reportError(error) { calls.reported = error; },
      finishAnalysis(lease, phase) { calls.finish.push({ lease, phase }); }
    },
    setAutoStatusText(text, color) { calls.statuses.push({ text, color }); }
  });
  vm.runInContext(`${safetyBlock}\nglobalThis.safe = safeSendMessage; globalThis.invoke = invokeMessageCallback;`, context, { filename: "content.js" });
  return { context, calls };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test("an asynchronous Lichess callback bug is reported without destroying the core", async () => {
  const { context, calls } = harness();
  vm.runInContext("safe({type:'fixture'}, async () => { throw new TypeError('NodeList.every is not a function'); });", context);
  await settle();
  assert.equal(calls.shutdown, 0);
  assert.equal(calls.finish.length, 1);
  assert.equal(calls.finish[0].phase, "failed");
  assert.match(String(calls.reported), /NodeList\.every/);
  assert.match(calls.statuses.at(-1).text, /Ошибка Lichess/);
});

test("a synchronous application callback bug also keeps the Lichess core alive", async () => {
  const { context, calls } = harness();
  vm.runInContext("safe({type:'fixture'}, () => { throw new TypeError('render failed'); });", context);
  await settle();
  assert.equal(calls.shutdown, 0);
  assert.equal(calls.finish.length, 1);
  assert.match(String(calls.reported), /render failed/);
});

test("a genuinely disposed Android context still shuts down the orphaned core", async () => {
  const { context, calls } = harness();
  context.window.__CC_ANDROID_RUNTIME__.disposed = true;
  vm.runInContext("safe({type:'fixture'}, () => { throw new TypeError('late callback'); });", context);
  await settle();
  assert.equal(calls.shutdown, 1);
  assert.equal(calls.finish.length, 0);
});
