"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(path.resolve(__dirname, "../../main/assets/content/content.js"), "utf8");

function productionFunction(name) {
  const start = source.indexOf(`  function ${name}(`);
  assert.notEqual(start, -1, `Missing production function ${name}`);
  const end = source.slice(start + 1).search(/\n  (?:async )?function |\n  const [A-Za-z_$][\w$]* =|\n  let [A-Za-z_$][\w$]* =/);
  assert.notEqual(end, -1, `Missing boundary after ${name}`);
  return source.slice(start, start + 1 + end);
}

function clockHarness(extra = {}) {
  let now = 0, id = 0;
  const timers = new Map();
  const context = vm.createContext({
    setTimeout(callback, delay = 0) { const key = ++id; timers.set(key, { callback, at: now + delay }); return key; },
    clearTimeout(key) { timers.delete(key); },
    Date: class extends Date { static now() { return now; } },
    ...extra
  });
  async function advance(ms) {
    const target = now + ms;
    for (let count = 0; count < 1000; count++) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) { now = target; return; }
      timers.delete(next[0]); now = next[1].at; next[1].callback();
    }
    throw new Error("Unbounded fixture timers");
  }
  return { context, advance };
}

test("Lichess DOM animation batches produce one board invalidation after 120 ms of quiet", async () => {
  const calls = { dirty: 0, cycle: 0 };
  let observerCallback;
  const { context, advance } = clockHarness({
    MutationObserver: class { constructor(callback) { observerCallback = callback; } },
    markBoardDirty() { calls.dirty++; },
    triggerDebouncedCycle() { calls.cycle++; }
  });
  const start = source.indexOf("  const domObserver = new MutationObserver(");
  const end = source.indexOf("\n  const boardDiscoveryObserver", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(`let boardMutationTimer = null;${source.slice(start, end)}`, context);
  observerCallback([{}]); await advance(60);
  observerCallback([{}]); await advance(60);
  observerCallback([{}]); await advance(119);
  assert.deepEqual(calls, { dirty: 0, cycle: 0 });
  await advance(1);
  assert.deepEqual(calls, { dirty: 1, cycle: 1 });
});

test("mobile polling performs no full cycles while native input is latched", async () => {
  const calls = { observers: 0, cycles: 0 };
  const { context, advance } = clockHarness({
    extensionInvalidated: false,
    document: { hidden: false },
    mobileSession: { isReady: true },
    nativeMoveBlockedState: {},
    isExecutingMove: false,
    moveCooldownUntil: 0,
    ensureObserversAttached() { calls.observers++; },
    runCycle() { calls.cycles++; }
  });
  vm.runInContext(`let mobilePollTimer = null;${productionFunction("scheduleMobilePoll")}\nglobalThis.startPoll = scheduleMobilePoll;`, context);
  context.startPoll();
  await advance(10_000);
  assert.equal(calls.cycles, 0);
  assert.equal(calls.observers, 2);
  context.nativeMoveBlockedState = null;
  await advance(5_000);
  assert.equal(calls.cycles, 1);
});
