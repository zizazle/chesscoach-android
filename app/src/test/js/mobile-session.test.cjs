"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const assets = path.resolve(__dirname, "../../main/assets");
const startKey = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -";

function events() {
  const listeners = new Map();
  return {
    addEventListener(name, callback) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(callback);
    },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
    dispatchEvent(event) { for (const callback of [...(listeners.get(event.type) || [])]) callback(event); return true; }
  };
}

function fixture(platform = "lichess") {
  const calls = { capture: 0, cancel: [], suspend: [], resume: 0, writes: [] };
  const rect = { left: 20, top: 80, width: 320, height: 320 };
  const board = { isConnected: true, getBoundingClientRect: () => ({ ...rect }) };
  const state = { boardElement: board, boardRect: rect, positionKey: startKey, boardKey: startKey,
    positionId: 0, myColor: "w", actualTurn: "w", isBlackOrientation: false, animating: false };
  const document = { ...events(), hidden: false, visibilityState: "visible",
    elementFromPoint: () => state.hitTarget || state.boardElement,
    createElement: () => ({ id: "", textContent: "" }) };
  let storage = {}, revision = 0, storageRequest;
  const native = {
    postMessage(raw) {
      const envelope = JSON.parse(raw);
      if (envelope.type === "storage.get") { storageRequest = envelope; return; }
      if (envelope.type === "storage.patch") {
        if (envelope.payload.clear) storage = {};
        Object.assign(storage, envelope.payload.items);
        for (const key of envelope.payload.keys) delete storage[key];
        revision++;
        calls.writes.push(envelope.payload);
        respond(envelope, { ok: true, items: storage, revision }, "storage.response");
      } else throw new Error(`Unexpected request ${envelope.type}`);
    }
  };
  const context = vm.createContext({
    ...events(), document, CCNative: native, location: new URL(platform === "lichess" ? "https://lichess.org/fixture" : "https://www.chess.com/game/live/fixture"),
    TextEncoder, URL, AbortController, queueMicrotask, console,
    setTimeout, clearTimeout, navigator: {},
    visualViewport: { width: 400, height: 800, offsetLeft: 0, offsetTop: 0 },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    __CC_ANDROID_BOOTSTRAP__: { storageReady: false, storage: {}, storageRevision: 0,
      profile: { runtimeId: "chesscoach-android", documentId: "fixture-doc", performanceTier: "HIGH", recommendedTier: "HIGH",
        recommendation: { recommendedTier: "HIGH", animations: true }, engine: { fullSupported: true }, power: {} } }
  });
  context.window = context;
  context.top = context;
  function respond(envelope, payload, type) {
    queueMicrotask(() => native.onmessage({ data: JSON.stringify({ v: 1, scope: "chesscoach.android", source: "native",
      target: "REMOTE", channel: envelope.channel, type, id: envelope.id, payload }) }));
  }
  for (const file of ["bridge/cc-android-polyfill.js", "bridge/cc-mobile-preferences.js", "bridge/cc-mobile-session.js"]) {
    vm.runInContext(fs.readFileSync(path.join(assets, file), "utf8"), context, { filename: file });
  }
  const session = context.__CC_ANDROID_GAME_SESSION__;
  const preferences = context.__CC_MOBILE_PREFERENCES__;
  const adapter = {
    captureState() { calls.capture++; return { ...state, boardRect: { ...state.boardRect } }; },
    isAnimating: () => state.animating,
    viewState: () => ({ executing: false }),
    cancelSearch(reason) { calls.cancel.push(reason); },
    suspend(reason, release) { calls.suspend.push({ reason, release }); },
    resume() { calls.resume++; }
  };
  return { context, state, calls, session, preferences, adapter,
    async hydrate(items = {}) {
      storage = { ...items };
      respond(storageRequest, { ok: true, items: storage, revision }, "storage.response");
      await session.ready;
      session.registerCore(platform, adapter);
      await preferences.flush();
    },
    event(name, detail) { context.dispatchEvent(new context.CustomEvent(name, { detail })); },
    profile(power) { native.onmessage({ data: JSON.stringify({ v: 1, scope: "chesscoach.android", type: "profile.update",
      payload: { profile: { ...context.__CC_ANDROID_RUNTIME__.profile, power } } }) }); },
    rawStorage: () => structuredClone(storage)
  };
}

for (const platform of ["lichess", "chesscom"]) {
  test(`${platform}: hydrate first, accept initial ID zero, and keep one actual current-position lease`, { timeout: 5000 }, async () => {
    const h = fixture(platform);
    assert.equal(h.session.isReady, false);
    assert.throws(() => h.session.registerCore(platform, h.adapter), /hydrate/);
    assert.equal(h.session.beginAnalysis(h.state, "config-1"), null);
    await h.hydrate();
    const lease = h.session.beginAnalysis(h.state, "config-1");
    assert.ok(lease);
    assert.equal(h.session.snapshot().positionId, 0);
    for (let i = 0; i < 10; i++) assert.equal(h.session.beginAnalysis(h.state, "config-1"), null);
    h.session.finishAnalysis(lease);
    assert.equal(h.session.beginAnalysis(h.state, "config-1"), null);
    const next = h.session.beginAnalysis(h.state, "config-2");
    assert.ok(next && next.epoch > lease.epoch);
    h.session.finishAnalysis(lease);
    assert.equal(h.session.snapshot().analysis, "pending");
  });

  test(`${platform}: hidden, BFCache, route and board changes drain old work without changing saved intent`, { timeout: 5000 }, async () => {
    const h = fixture(platform);
    await h.hydrate();
    await h.preferences.update(platform, { autoMoveEnabled: true });
    await h.preferences.flush();
    const saved = h.rawStorage();
    const lease = h.session.beginAnalysis(h.state, "config");
    h.context.document.hidden = true;
    h.context.document.visibilityState = "hidden";
    h.context.document.dispatchEvent({ type: "visibilitychange" });
    assert.equal(lease.controller.signal.aborted, true);
    assert.equal(h.session.effective().autoMoveEnabled, false);
    assert.equal(h.preferences.get(platform).autoMoveEnabled, true);
    h.context.document.hidden = false;
    h.context.document.visibilityState = "visible";
    h.context.document.dispatchEvent({ type: "visibilitychange" });
    assert.equal(h.session.effective().autoMoveEnabled, true);
    const resumed = h.session.beginAnalysis(h.state, "config");
    h.context.dispatchEvent({ type: "pagehide", persisted: true });
    assert.equal(resumed.controller.signal.aborted, true);
    h.context.dispatchEvent({ type: "pageshow", persisted: true });
    assert.equal(h.context.__CC_ANDROID_RUNTIME__.disposed, false);
    assert.equal(h.session.isReady, true);
    const returned = h.session.beginAnalysis(h.state, "config");
    assert.ok(returned && returned.epoch > resumed.epoch);
    h.session.finishAnalysis(resumed);
    assert.equal(h.session.snapshot().analysis, "pending");
    h.context.location.pathname += "/new";
    const newGame = h.session.beginAnalysis(h.state, "config");
    assert.ok(newGame && returned.controller.signal.aborted);
    const oldBoardId = h.session.snapshot().boardId;
    h.state.boardElement = { ...h.state.boardElement };
    assert.ok(h.session.beginAnalysis(h.state, "config"));
    assert.notEqual(h.session.snapshot().boardId, oldBoardId);
    assert.deepEqual(h.rawStorage(), saved);
  });

  test(`${platform}: a fresh coherent native snapshot uses the stable board or explicit promotion target`, { timeout: 5000 }, async () => {
    const h = fixture(platform);
    await h.hydrate();
    h.session.observe(h.state, "config");
    const runtime = h.context.__CC_ANDROID_RUNTIME__;
    const targetId = h.session.registerTarget(h.state.boardElement);
    const request = vm.runInContext(`({points:[{x:40,y:100}],targetId:${JSON.stringify(targetId)}})`, h.context);
    const before = h.calls.capture;
    const snapshot = runtime.captureInputSnapshot(request);
    assert.equal(h.calls.capture - before, 1);
    assert.equal(snapshot.v, 1);
    assert.equal(snapshot.positionKey, startKey);
    assert.equal(snapshot.hit, true);
    assert.equal(snapshot.animating, false);
    assert.equal(Object.isFrozen(snapshot.boardRect), true);
    h.state.positionKey = startKey.replace(" w ", " b ");
    assert.notEqual(runtime.captureInputSnapshot(request).positionKey, snapshot.positionKey);
    const promotion = { isConnected: true, getBoundingClientRect: () => ({left:350,top:180,width:30,height:30}) };
    const promotionId = h.session.registerTarget(promotion);
    h.state.hitTarget = promotion;
    const promotionRequest = vm.runInContext(`({points:[{x:360,y:190}],targetId:${JSON.stringify(promotionId)}})`, h.context);
    const selected = runtime.captureInputSnapshot(promotionRequest);
    assert.equal(selected.boardId, snapshot.boardId);
    assert.equal(selected.targetRect.left, 350);
    assert.equal(selected.hit, true);
    h.state.hitTarget = {};
    assert.equal(runtime.captureInputSnapshot(promotionRequest).hit, false);
    h.state.animating = true;
    assert.equal(runtime.captureInputSnapshot(promotionRequest).animating, true);
  });
}

test("LOW throttles visuals and severe thermal pauses work without erasing automation intent", { timeout: 5000 }, async () => {
  const h = fixture();
  await h.hydrate();
  await h.preferences.update("lichess", { autoMoveEnabled: true, bulletTurboMode: true, premoveEnabled: true, mobileAnimations: true, mobileVisualEffects: true });
  await h.preferences.flush();
  assert.equal(h.preferences.get("lichess").bulletTurboMode, true);
  const saved = h.rawStorage();
  h.profile({ thermalStatus: 2 });
  assert.equal(h.session.effective().autoMoveEnabled, true);
  assert.equal(h.session.effective().lowTier, true);
  assert.equal(h.session.effective().bulletTurboMode, true);
  assert.equal(h.session.effective().premoveEnabled, true);
  assert.equal(h.session.effective().mobileAnimations, false);
  const thermalLease = h.session.beginAnalysis(h.state, "thermal-config");
  assert.ok(thermalLease);
  h.profile({ thermalStatus: 3 });
  assert.equal(h.session.effective().autoMoveEnabled, false);
  assert.equal(h.session.effective().thermalPause, true);
  assert.equal(h.session.effective().bulletTurboMode, false);
  assert.equal(h.session.effective().premoveEnabled, false);
  assert.equal(h.session.canAnalyze(h.state), false);
  assert.equal(thermalLease.controller.signal.aborted, true);
  assert.equal(h.calls.suspend.at(-1).reason, "thermal");
  h.profile({ thermalStatus: 0 });
  assert.equal(h.session.effective().thermalPause, false);
  assert.equal(h.session.canAnalyze(h.state), true);
  assert.equal(h.session.effective().bulletTurboMode, true);
  assert.equal(h.session.effective().premoveEnabled, true);
  assert.equal(h.session.effective().mobileAnimations, true);
  assert.equal(h.preferences.get("lichess").premoveEnabled, true);
  assert.deepEqual(h.rawStorage(), saved);
  h.context.__CC_ANDROID_SETTINGS_OPEN__ = true;
  h.event("cc-mobile-lifecycle", { state: "settings", cancelPendingMoves: true });
  assert.equal(h.calls.suspend.at(-1).release, false);
  assert.equal(h.session.canAnalyze(h.state), true);
  h.state.actualTurn = "b";
  assert.equal(h.session.canAnalyze(h.state), false);
  await h.preferences.update("lichess", { showArrows: false, showEvalBar: false });
  h.event("cc-mobile-lifecycle", { state: "active" });
  h.event("cc-mobile-lifecycle", { state: "settings", cancelPendingMoves: true });
  assert.equal(h.calls.suspend.at(-1).release, true);
  assert.equal(h.session.canAnalyze(h.state), false);
  h.profile({ thermalStatus: 2 });
  const elements = new Map();
  const root = { getElementById: id => elements.get(id), appendChild: node => elements.set(node.id, node) };
  h.session.applyVisualPolicy(root);
  assert.match(elements.get("cc-mobile-motion-policy").textContent, /chesscoach-screen-svg \*/);
  assert.match(elements.get("cc-mobile-motion-policy").textContent, /animation: none !important/);
  const snapshot = h.session.snapshot();
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.boardRect), true);
  assert.equal(Object.isFrozen(snapshot.viewport), true);
});
