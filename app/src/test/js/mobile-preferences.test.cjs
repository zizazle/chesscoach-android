"use strict";

// Production restore/save/preset handlers and full preference/storage modules.
// Rendering, analysis/input boundaries, clocks and native IO are fixtures, not WebView E2E.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ROOT = path.resolve(__dirname, "../../../..");
const ASSETS = path.join(ROOT, "app/src/main/assets");
const sources = Object.fromEntries([
  "bridge/cc-android-polyfill.js", "bridge/cc-mobile-preferences.js", "bridge/cc-mobile-launcher-orb.js",
  "content/content.js", "content/chesscom.js"
].map(name => [name, fs.readFileSync(path.join(ASSETS, name), "utf8")]));
const nativeSource = fs.readFileSync(path.join(ROOT, "app/src/main/java/com/chesscoach/app/MainActivity.kt"), "utf8");
const clone = value => JSON.parse(JSON.stringify(value));

function between(source, first, last) {
  const start = source.indexOf(first);
  const end = source.indexOf(last, start + first.length);
  assert.ok(start >= 0 && end > start, `${first} -> ${last}`);
  return source.slice(start, end);
}

function productionFunction(source, name) {
  const match = new RegExp(`^  (?:async )?function ${name}\\(`, "m").exec(source);
  assert.ok(match, name);
  const tail = source.slice(match.index);
  const end = /\r?\n  }\r?\n/.exec(tail);
  assert.ok(end, `Closing boundary for ${name}`);
  return tail.slice(0, end.index + end[0].length);
}

function productionHandler(source, id, event) {
  const start = source.indexOf(`    $("${id}").addEventListener("${event}", (e) => {`);
  if (start < 0) return "";
  const end = source.indexOf("\n    });", start);
  assert.ok(end > start, `${id}/${event}`);
  return source.slice(start, end + "\n    });".length);
}

function productionButtons(source, kind) {
  const start = source.indexOf(`    getShadow().querySelectorAll(".cc-${kind}-btn").forEach((btn) => {`, source.indexOf("  function ensurePanel()"));
  const end = source.indexOf("\n    });", start);
  assert.ok(start >= 0 && end > start, kind);
  return source.slice(start, end + "\n    });".length);
}

function events() {
  const listeners = new Map();
  return {
    addEventListener(type, callback, options) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push({ callback, once: options?.once });
    },
    removeEventListener(type, callback) {
      listeners.set(type, (listeners.get(type) || []).filter(item => item.callback !== callback));
    },
    dispatchEvent(event) {
      if (!event.target) event.target = this;
      for (const item of [...(listeners.get(event.type) || [])]) {
        item.callback(event);
        if (item.once) this.removeEventListener(event.type, item.callback);
      }
      return true;
    }
  };
}

class FakeEvent {
  constructor(type, options = {}) { this.type = type; Object.assign(this, options); this.isTrusted = false; }
  preventDefault() {} stopPropagation() {} stopImmediatePropagation() {}
}

function node(id = "", attrs = {}) {
  const classes = new Set((attrs.class || "").split(/\s+/).filter(Boolean));
  const element = {
    ...events(), id, type: attrs.type || "", tagName: attrs.tag || "DIV",
    dataset: {}, style: { setProperty(key, value) { this[key] = value; } },
    checked: false, disabled: false, isConnected: true, textContent: "", innerHTML: "", options: [],
    classList: {
      contains: key => classes.has(key),
      add: (...keys) => keys.forEach(key => classes.add(key)),
      remove: (...keys) => keys.forEach(key => classes.delete(key)),
      toggle(key, force) { const next = force === undefined ? !classes.has(key) : Boolean(force); if (next) classes.add(key); else classes.delete(key); return next; }
    },
    setAttribute(key, value) { attrs[key] = String(value); },
    getAttribute: key => attrs[key] ?? null,
    removeAttribute(key) { delete attrs[key]; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 120 }),
    click() {
      this.dispatchEvent(new FakeEvent("click"));
      if (this.type === "checkbox") { this.checked = !this.checked; this.dispatchEvent(new FakeEvent("change")); }
    },
    focus() {}, before() {}, remove() { this.isConnected = false; },
    querySelector() { return null; }, querySelectorAll() { return []; }
  };
  for (const [key, value] of Object.entries(attrs)) if (key.startsWith("data-")) element.dataset[key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  let value = String(attrs.value || "");
  Object.defineProperty(element, "value", {
    get: () => value,
    set(raw) {
      value = String(raw);
      if (element.type === "range") {
        const min = Number(attrs.min ?? 0), max = Number(attrs.max ?? 100);
        let number = Number(raw);
        if (!Number.isFinite(number)) number = (min + max) / 2;
        number = Math.max(min, Math.min(max, number));
        const step = Number(attrs.step || 1);
        if (step > 0) number = Math.max(min, Math.min(max, min + Math.round((number - min) / step) * step));
        value = String(number);
      }
    }
  });
  return element;
}

function rootFromHtml(source) {
  const nodes = new Map();
  for (const match of source.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
    const attrs = { tag: match[1].toUpperCase() };
    for (const pair of match[2].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[pair[1]] = pair[2];
    const element = node(match[3], attrs);
    if (match[1].toLowerCase() === "select") {
      const tail = source.slice(match.index, source.indexOf("</select>", match.index));
      element.options = [...tail.matchAll(/<option[^>]*value="([^"]*)"/g)].map(item => ({ value: item[1] }));
    }
    nodes.set(element.id, element);
  }
  const root = {
    ...events(), nodes, host: node("fixture-host"),
    getElementById: id => nodes.get(id) || null,
    querySelectorAll(selector) {
      return [...nodes.values()].filter(element => {
        if (!element.isConnected) return false;
        const cls = /\.([\w-]+)/.exec(selector)?.[1];
        if (cls && !element.classList.contains(cls)) return false;
        const attribute = /\[data-(mode|style|tab)="([^"]+)"\]/.exec(selector);
        if (attribute && element.dataset[attribute[1]] !== attribute[2]) return false;
        if (selector.includes(".active") && !element.classList.contains("active")) return false;
        return Boolean(cls);
      });
    },
    querySelector(selector) { if (selector.startsWith("#")) return this.getElementById(selector.slice(1)); return this.querySelectorAll(selector)[0] || null; }
  };
  for (const match of source.matchAll(/<button\b([^>]*class="cc-mode-btn[^>]*|[^>]*class="cc-tab-btn[^>]*)>/g)) {
    const attrs = {};
    for (const pair of match[1].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[pair[1]] = pair[2];
    const key = `fixture-${attrs["data-mode"] || attrs["data-tab"]}`;
    nodes.set(key, node(key, attrs));
  }
  for (const style of ["mogging", "tal", "alphazero", "morphy", "hikaru", "kasparov", "fischer", "carlsen", "solid", "botvinnik", "balanced"]) {
    nodes.set(`fixture-style-${style}`, node(`fixture-style-${style}`, { class: "cc-style-btn", "data-style": style }));
  }
  return root;
}

async function microtasks() { for (let i = 0; i < 100; i++) await Promise.resolve(); }

function harness(platform = "lichess", stored = {}, options = {}) {
  const source = sources[`content/${platform === "lichess" ? "content.js" : "chesscom.js"}`];
  const orb = sources["bridge/cc-mobile-launcher-orb.js"];
  const coreRoot = rootFromHtml(source);
  const floatingRoot = rootFromHtml(orb);
  coreRoot.nodes.set("chesscoach-panel",node("chesscoach-panel"));
  for (const id of ["cc-mobile-preset-status", "cc-mobile-device-chip", "cc-mobile-recommendation-text"]) coreRoot.nodes.set(id, node(id));
  const trace = { messages: [], warnings: [], cycles: [], storageChanges: [], lifecycle: [], io: [], panelStarts: 0 };
  let now = 1000, sequence = 0;
  const timers = new Map();
  const setTimeout = (callback, ms = 0) => { const id = ++sequence; timers.set(id, { callback, at: now + ms }); return id; };
  const clearTimeout = id => timers.delete(id);
  const native = {
    disk: clone(options.disk || stored), registered: clone(stored), generation: 1, revision: options.revision || 0,
    queue: [], mutations: new Map(), onmessage: null, holdGet: Boolean(options.holdGet), holdAcks: false,
    postMessage(raw) {
      const envelope = JSON.parse(raw);
      trace.messages.push(envelope);
      assert.ok(["storage.get", "storage.patch"].includes(envelope.type), "No network, engine, input or account operations are permitted");
      const request = { envelope, generation: this.generation, ioDone: false };
      this.queue.push(request);
      if (envelope.type !== "storage.get" || !this.holdGet) queueMicrotask(() => { this.runIO(request); if (!this.holdAcks) this.complete(request); });
    },
    runIO(request) {
      if (request.ioDone) return;
      request.ioDone = true;
      if (request.envelope.type === "storage.get") {
        request.response = options.readError ? { ok: false, error: { code: "STORAGE_READ_FAILED", message: "Storage read failed" } }
          : { ok: true, items: clone(this.disk), revision: this.revision };
        return;
      }
      const payload = request.envelope.payload;
      assert.deepEqual(Object.keys(payload).sort(), ["baseRevision", "clear", "items", "keys", "mutationId"]);
      assert.ok(Object.keys(payload.items).length + payload.keys.length <= 64);
      const signature = JSON.stringify({ items: payload.items, keys: payload.keys, clear: payload.clear });
      const prior = this.mutations.get(payload.mutationId);
      if (prior && prior !== signature) request.response = { ok: false, error: { code: "STORAGE_MUTATION_REUSED", message: "Mutation reused" } };
      else if (prior) request.response = { ok: true, items: clone(this.disk), revision: this.revision };
      else if (payload.baseRevision !== this.revision) request.response = { ok: false, error: { code: "STORAGE_REVISION_CONFLICT", message: "Storage revision changed" } };
      else {
        const next = payload.clear ? {} : clone(this.disk);
        for (const key of payload.keys) delete next[key];
        Object.assign(next, payload.items);
        this.disk = next; this.revision++; this.registered = clone(next);
        this.mutations.set(payload.mutationId, signature);
        trace.io.push({ mutationId: payload.mutationId, items: clone(payload.items), keys: clone(payload.keys), disk: clone(next) });
        request.response = { ok: true, items: clone(next), revision: this.revision };
      }
    },
    complete(request) {
      if (request.generation !== this.generation) return false;
      this.onmessage?.({ data: JSON.stringify({ v: 1, scope: "chesscoach.android", source: "native", target: "REMOTE", channel: "storage", type: "storage.response", id: request.envelope.id, payload: request.response }) });
      return true;
    },
    releaseGet() { this.holdGet = false; for (const request of this.queue.filter(item => !item.ioDone)) { this.runIO(request); this.complete(request); } }
  };
  const document = { ...events(), visibilityState: "visible", hidden: false, querySelector: () => null, querySelectorAll: () => [], getElementById: () => null };
  const profile = { runtimeId: "chesscoach-android", documentId: "android-1", recommendation: { tier: options.tier || "BALANCED", movetimeScale: 1 } };
  const context = vm.createContext({
    ...events(), document, location: new URL(platform === "lichess" ? "https://lichess.org/fixture123" : "https://www.chess.com/game/live/fixture123"),
    navigator: {}, TextEncoder, URL, AbortController, queueMicrotask, Event: FakeEvent,
    CustomEvent: class extends FakeEvent { constructor(type, opts) { super(type, opts); } },
    Date: class extends Date { static now() { return now; } },
    setTimeout, clearTimeout, requestAnimationFrame: callback => setTimeout(callback, 16), cancelAnimationFrame: clearTimeout,
    innerWidth: 390, innerHeight: 844, matchMedia: () => ({ matches: true }),
    getComputedStyle: element => ({ display: element.style.display || "block" }),
    console: { log() {}, warn: (...args) => trace.warnings.push(args.map(String).join(" ")), error: (...args) => trace.warnings.push(args.map(String).join(" ")) },
    trace, coreRoot, floatingRoot, CCNative: native,
    __CC_ANDROID_BOOTSTRAP__: { storage: clone(stored), storageRevision: 0, profile }
  });
  context.window = context; context.top = context;
  vm.runInContext(sources["bridge/cc-android-polyfill.js"], context, { filename: "production/cc-android-polyfill.js" });
  vm.runInContext(sources["bridge/cc-mobile-preferences.js"], context, { filename: "production/cc-mobile-preferences.js" });
  const coreFunctions = ["isContextValid", "saveSetting", "setSelectSafe", "applyWorkModePreset", "loadSettings", "updateUIValues", "buildCurrentConfigPayload", "applyImportedChessConfig", "switchTab", "applyPersistentPanelGeometry", "applyCustomBackgroundToPanel"];
  if (platform === "chesscom") coreFunctions.push("handleAsyncStorageError", "handleStorageChanges");
  const checkboxes = ["cc-premove-chk", "cc-premove-arrows-chk", "cc-legit-timing-chk", "cc-sf-wasm-chk", "cc-engine-max-chk", "cc-auto-avg-chk", "cc-auto-protect-chk", "cc-rage-antiban-chk", "cc-vis-phonk-chk", "cc-audio-radar-chk", "cc-heatmap-always-chk", "cc-vis-arrows-chk", "cc-vis-eval-chk", "cc-hesitation-chk", "cc-t1-limiter-chk"];
  const inputs = ["cc-auto-delay-slider", "cc-auto-jitter-slider", "cc-auto-avg-freq-slider", "cc-premove-risk-slider"];
  const eloBinding = between(source, '    const slider = $("cc-elo-slider");', '    getShadow().querySelectorAll(".cc-style-btn")');
  vm.runInContext(`(function(){
    const chrome = window.__CC_ANDROID_RUNTIME__.chrome;
    function normalizeVisualMask(value) { return JSON.parse(JSON.stringify(value)); }
    ${between(source, "  const ALL_STYLE_NAMES", "  const StockfishWasmEngine =")}
    const StockfishWasmEngine = {initWorker(){},cancel(){},terminate(){},getResourceProfile(){return {totalHashMb:32};}};
    function $(id){return coreRoot.getElementById(id);} function getShadow(){return coreRoot;}
    function ensurePanel(){trace.panelStarts++;} function applySafeBoardDepth(){} function getDynamicGreetingText(){return "fixture";}
    function updateLiveTelemetryUI(){} function updateLegitAntiBanMeterUI(){} function updatePrivacyMaskStatus(){}
    function ensurePrivacyMaskManager(){} function renderLiveEvalGraph(){} function updateEvalMoodAndEngineBadge(){}
    function shutdownOrphanedScript(){extensionInvalidated=true;}
    function setAutoStatusText(text){trace.status=text;}
    function forceRecalculate(){trace.cycles.push(true);} function resetTurnDecision(){} function cancelNativeMove(){}
    function resetTrackedGame(){} function triggerDebouncedCycle(){}
    function scheduleAutoMoveIfNeeded(){} function getObservedPlyIndex(){return 0;} function captureBoardState(){return null;} function renderArrowsOverlay(){}
    function resetLegitHistoryStats(){}
    function countDifferencesFromInitialGrid(){return 0;} function randomizePrivacyOpponent(){}
    ${coreFunctions.map(name => productionFunction(source, name)).join("\n")}
    ${between(source, "    const toggleAutoMoveMaster =", '    $("cc-legit-timing-chk").addEventListener')}
    ${checkboxes.map(id => productionHandler(source, id, "change")).join("\n")}
    ${inputs.map(id => productionHandler(source, id, "input")).join("\n")}
    ${eloBinding}
    ${productionButtons(source, "mode")}
    ${productionButtons(source, "style")}
    core = {load:loadSettings,mode:applyWorkModePreset,refresh:updateUIValues,import:applyImportedChessConfig,
      snapshot:()=>buildCurrentConfigPayload("fixture").settings,keys:SETTINGS_KEYS,
      register(){${platform === "chesscom" ? 'chrome.storage.onChanged.addListener(handleStorageChanges);' : ""}}
    };
  })();`, context, { filename: `production/${platform}-settings-fragments.js` });
  const launcherFunctions = ["saveGlobalPatch", "loadInitialStorage", "vibrate", "compactText", "readDeviceRecommendation", "listen", "clearScheduledWork", "stopHudDiscovery", "setUiViewMode", "syncVisibilityStates", "buildPresetConfig", "persistablePresetConfig", "applySmartPresetConfig", "setPresetStatus", "renderPreferenceStatus", "showAutoConfirmation", "confirmAutomationExplicitly", "enforceLowTierRestrictions", "suspendAutomation", "handleVisibilityChange", "cleanup", "removeInjectedSettingsUi", "isOverlayOpen", "handleAndroidBack", "hideOverlay", "maybeStartWelcomeSequence", "getVisualViewportBounds", "fitSettingsViewport", "applyDeviceClasses", "setOverlayPassthrough"];
  vm.runInContext(`(function(){
    const chrome = window.__CC_ANDROID_RUNTIME__.chrome;
    const INSTANCE_KEY=Symbol.for("cc.android.mobile-launcher.instance");
    ${between(orb, "  const currentPlatform", "  window.__ccMobileLauncherOrbInitialized")}
    ${between(orb, "  const TIER_RECOMMENDATIONS", "  function readDeviceRecommendation")}
    ${launcherFunctions.map(name => productionFunction(orb, name)).join("\n")}
    let deviceRecommendation=readDeviceRecommendation();
    function startHudDiscovery(){} function clampMiniHud(){} function scheduleMiniHudUpdate(){} function mobileHudRegistrar(){}
    function disableAndroidUserScripts(){} function showOverlay(overlay){if(overlay)overlay.style.display="flex";}
    mainHudShadow=coreRoot;mainPanel=coreRoot.getElementById("chesscoach-panel");rootSetupComplete=true;
    hudShadow=floatingRoot;autoConfirmModal=floatingRoot.getElementById("cc-auto-confirm-modal");
    presetStatus=coreRoot.getElementById("cc-mobile-preset-status");
    window[INSTANCE_KEY]={cleanup};
    listen(document,"visibilitychange",handleVisibilityChange);
    ${between(orb, '  listen(window, "pagehide",', '  listen(window, "orientationchange",')}
    ${between(orb, '  listen(window, "cc-device-profile-ready",', "\n\n  void loadInitialStorage")}
    launcher={
      load:loadInitialStorage,low:enforceLowTierRestrictions,
      mode:setUiViewMode,suspend:suspendAutomation,cleanup,preset:applySmartPresetConfig,
      build:buildPresetConfig,persistable:persistablePresetConfig,confirm:confirmAutomationExplicitly,
      saveGlobal:saveGlobalPatch,
      inspect:()=>({destroyed,storageReady,initialStorage,pendingAutomation,deviceRecommendation}),
      start(){return loadInitialStorage().then(()=>{if(deviceRecommendation.tier==="LOW")enforceLowTierRestrictions();});}
    };
  })();`, context, { filename: "production/launcher-settings-fragments.js" });
  context.core.register();
  context.__CC_ANDROID_RUNTIME__.chrome.storage.onChanged.addListener((changes, area) => trace.storageChanges.push({ changes: clone(changes), area }));
  context.addEventListener("cc-mobile-lifecycle", event => trace.lifecycle.push(clone(event.detail)));
  const result = {
    context, native, trace, coreRoot,
    async advance(ms) {
      const target = now + ms;
      for (let count = 0; count < 2000; count++) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) { now = target; await microtasks(); return; }
        timers.delete(next[0]); now = next[1].at; next[1].callback(); await microtasks();
      }
      throw new Error("Unexpected continuous timer work");
    },
    async boot() { const loading = context.launcher.start(); const coreLoading=context.core.load(); await microtasks(); await this.advance(1000); await Promise.all([loading,coreLoading]); await microtasks(); return this; },
    async settle() { await microtasks(); await this.advance(1000); await microtasks(); },
    state: () => clone(context.core.snapshot()),
    preferences: () => clone(context.__CC_MOBILE_PREFERENCES__.get(platform)),
    effective: () => clone(context.__CC_MOBILE_PREFERENCES__.getEffective(platform)),
    patches: () => trace.messages.filter(message => message.type === "storage.patch"),
    async local() { return clone(await context.__CC_ANDROID_RUNTIME__.chrome.storage.local.get(null)); },
    change(id, checked) { const control = coreRoot.getElementById(id); assert.ok(control,id);control.checked=checked;control.dispatchEvent(new FakeEvent("change")); },
    async hide() { document.hidden=true;document.visibilityState="hidden";document.dispatchEvent(new FakeEvent("visibilitychange"));await microtasks(); },
    async show() { document.hidden=false;document.visibilityState="visible";document.dispatchEvent(new FakeEvent("visibilitychange"));await microtasks(); },
    async pagehide(persisted=false) {context.dispatchEvent(new FakeEvent("pagehide",{persisted}));await microtasks();},
    async pageshow() {context.dispatchEvent(new FakeEvent("pageshow",{persisted:true}));await microtasks();},
    dispose() {context.__CC_ANDROID_RUNTIME__.cleanup();}
  };
  return result;
}

function enabled(platform = "lichess", extra = {}) {
  return { cc_mobile_settings_schema: 2, ...Object.fromEntries(Object.entries({ workMode: "all", autoMoveEnabled: true, engineMaxMode: false,
    safeAntiBanGuard: false, mobilePresetId: "custom", autoMoveDelayMs: 45, autoMoveJitterMs: 15,
    ...(platform === "lichess" ? { bulletTurboMode: true, premoveEnabled: true, showPremoveArrows: true, premoveRiskLevel: 3 } : {}),
    ...extra }).map(([key, value]) => [`${platform}.${key}`,value])) };
}

test("source snapshot and actual Android load order", () => {
  const preferences=nativeSource.indexOf('paths += "bridge/cc-mobile-preferences.js"');
  const launcher=nativeSource.indexOf('paths += "bridge/cc-mobile-launcher-orb.js"');
  assert.ok(preferences>=0&&preferences<launcher);
  assert.ok(nativeSource.indexOf('paths += "bridge/cc-mobile-launcher-orb.js"') < nativeSource.indexOf('paths += if (platform == Platform.CHESS_COM) "content/chesscom.js"'));
});

test("normal scoped restore preserves turbo/premove and explicit FALSE guard without auto-applying presets", async () => {
  const h = await harness("lichess",enabled()).boot();
  assert.equal(h.state().bulletTurboMode,true);assert.equal(h.state().premoveEnabled,true);assert.equal(h.state().safeAntiBanGuard,false);
  assert.equal(h.state().autoMoveDelayMs,45);assert.equal(h.state().workMode,"all");
  assert.equal(h.patches().length,0,"schema2 restoration does not persist defaults");assert.equal(h.trace.messages[0].type,"storage.get");
  h.dispose();
});

test("returning to board and opening More/settings pause without changing automation preferences", async () => {
  const h = await harness("lichess",enabled()).boot();
  h.context.launcher.mode("mini");await h.settle();h.context.launcher.mode("full");await h.settle();
  assert.equal(h.state().bulletTurboMode,true);assert.equal(h.native.disk["lichess.autoMoveEnabled"],true);
  assert.equal(h.native.disk["lichess.premoveEnabled"],true);assert.equal(h.context.__CC_ANDROID_SETTINGS_OPEN__,true);
  assert.equal(h.trace.lifecycle.at(-1).state,"settings");h.dispose();
});

test("hidden -> pagehide -> game/reload preserves enabled auto/turbo/premove/arrows", async () => {
  const h = await harness("lichess",enabled()).boot();
  await h.hide();
  const local = await h.local();
  assert.equal(local["lichess.autoMoveEnabled"],true);assert.equal(local["lichess.bulletTurboMode"],true);
  assert.equal(local["lichess.premoveEnabled"],true);assert.equal(local["lichess.showPremoveArrows"],true);
  assert.equal(h.state().showPremoveArrows,true);assert.equal(h.effective().premoveEnabled,false);
  assert.equal(local["lichess.autoMoveDelayMs"],45);
  await h.pagehide();
  assert.equal(h.native.disk["lichess.autoMoveEnabled"],true);assert.equal(h.native.disk["lichess.bulletTurboMode"],true);
  const reloaded = await harness("lichess",h.native.registered).boot();
  assert.equal(reloaded.state().bulletTurboMode,true);assert.equal(reloaded.state().premoveEnabled,true);assert.equal(reloaded.state().showPremoveArrows,true);
  reloaded.dispose();
});

test("pagehide ONLY preserves intent and rejects every storage operation after disposal", async () => {
  const h = await harness("lichess",enabled()).boot();
  await h.pagehide();
  assert.equal(h.context.__CC_ANDROID_RUNTIME__.disposed,true);assert.equal(h.state().autoMoveEnabled,true);
  const api=h.context.__CC_ANDROID_RUNTIME__.chrome.storage.local;
  for(const call of [()=>api.get(null),()=>api.set({cc_mobile_settings_tab:"more"}),()=>api.remove("x"),()=>api.clear(),()=>h.context.__CC_ANDROID_RUNTIME__.flushStorage()]) await assert.rejects(call,{code:"CONTEXT_INVALIDATED"});
  assert.equal(h.native.disk["lichess.autoMoveEnabled"],true);assert.equal(h.patches().length,0);
  const reload = await harness("lichess",h.native.registered).boot();assert.equal(reload.state().bulletTurboMode,true);reload.dispose();
});

test("BFCache pagehide/resume retains launcher and selected automation without storage writes", async () => {
  const h = await harness("lichess",enabled()).boot();h.context.launcher.mode("mini");await h.settle();const patches=h.patches().length;
  await h.pagehide(true);await h.settle();
  assert.equal(h.context.__CC_ANDROID_RUNTIME__.disposed,false);assert.equal(h.context.launcher.inspect().destroyed,false);
  assert.equal(h.native.disk["lichess.bulletTurboMode"],true);assert.equal(h.effective().paused,true);
  await h.pageshow();assert.equal(h.effective().paused,false);assert.equal(h.effective().premoveEnabled,true);
  assert.equal(h.native.disk["lichess.premoveEnabled"],true);assert.equal(h.patches().length,patches);h.dispose();
});

test("Chess.com hidden/reload preserves auto and never writes unsupported premove fields", async () => {
  const h = await harness("chesscom",enabled("chesscom")).boot();await h.hide();await h.pagehide();
  assert.equal(h.native.disk["chesscom.autoMoveEnabled"],true);assert.equal(h.native.disk["chesscom.premoveEnabled"],undefined);
  assert.equal(h.native.disk["chesscom.showPremoveArrows"],undefined);assert.equal(h.state().safeAntiBanGuard,false);
  assert.equal(h.coreRoot.getElementById("cc-premove-chk"),null);assert.equal(h.state().premoveEnabled,undefined);
});

test("explicit Engine MAX versus turbo/premove resolves immediately and remains consistent on reload", async () => {
  const h = await harness("lichess",enabled()).boot();h.context.core.mode("hvh");await h.settle();
  assert.equal(h.state().engineMaxMode,false,"More changes visibility, not Engine MAX");
  h.change("cc-engine-max-chk",true);await h.settle();assert.equal(h.state().engineMaxMode,true);
  h.change("cc-bullet-turbo-chk",true);await h.settle();
  assert.equal(h.state().engineMaxMode,false);assert.equal(h.state().bulletTurboMode,true);assert.equal(h.native.disk["lichess.bulletTurboMode"],true);
  const reload = await harness("lichess",h.native.disk).boot();
  assert.equal(reload.state().engineMaxMode,false);assert.equal(reload.state().bulletTurboMode,true);assert.equal(reload.state().premoveEnabled,true);
  assert.equal(reload.native.disk["lichess.engineMaxMode"],false);
  assert.equal(reload.state().elo,3000);assert.equal(reload.state().style,"balanced");
  h.change("cc-engine-max-chk",true);await h.settle();h.change("cc-premove-chk",true);await h.settle();assert.equal(h.state().engineMaxMode,false);
  h.dispose();reload.dispose();
});

test("legacy HvH inference happens once; explicit FALSE and saved turbo intent win", async () => {
  const store=enabled("lichess",{workMode:"hvh"});delete store["lichess.engineMaxMode"];
  delete store.cc_mobile_settings_schema;store["lichess.bulletTurboMode"]=false;store["lichess.premoveEnabled"]=false;
  const inferred=await harness("lichess",store).boot();assert.equal(inferred.state().engineMaxMode,true);assert.equal(inferred.state().premoveEnabled,false);
  const explicit=await harness("lichess",{...store,"lichess.engineMaxMode":false}).boot();assert.equal(explicit.state().engineMaxMode,false);assert.equal(explicit.state().bulletTurboMode,false);
  const restored=await harness("lichess",{...store,"lichess.bulletTurboMode":true,"lichess.premoveEnabled":true}).boot();assert.equal(restored.state().engineMaxMode,false);assert.equal(restored.state().bulletTurboMode,true);restored.dispose();
  inferred.dispose();explicit.dispose();
});

test("restoring or choosing More visibility mode does not reapply a preset or overwrite timing/flags", async () => {
  const h=await harness("lichess",enabled("lichess",{workMode:"legit"})).boot();
  assert.equal(h.state().bulletTurboMode,true);assert.equal(h.state().premoveEnabled,true);
  h.context.core.mode("legit");await h.settle();assert.equal(h.state().bulletTurboMode,true);assert.equal(h.native.disk["lichess.premoveEnabled"],true);
  assert.equal(h.state().autoMoveDelayMs,45);assert.equal(h.state().elo,2000);h.dispose();
});

test("fresh Android guard defaults FALSE and both guard migrations share one atomic schema transaction", async () => {
  for (const platform of ["lichess","chesscom"]) {
    const h=await harness(platform,{}).boot();assert.equal(h.state().safeAntiBanGuard,false);
    assert.equal(h.native.disk["lichess.safeAntiBanGuard"],false);assert.equal(h.native.disk["chesscom.safeAntiBanGuard"],false);
    assert.equal(h.preferences().autoMoveEnabled,false);assert.equal(h.native.disk[`${platform}.autoMoveEnabled`],undefined);
    assert.equal(h.patches().length,1);assert.equal(h.patches()[0].payload.items.cc_mobile_settings_schema,2);
    h.dispose();
  }
});

test("all quick presets persist stable identity and FALSE guard with one adapter notification/recalc/delta", async () => {
  for (const platform of ["lichess","chesscom"]) for (const mode of ["legit","hvh","balance"]) {
    const h=await harness(platform,enabled(platform)).boot();
    let notifications=0;h.context.__CC_MOBILE_PREFERENCES__.subscribe(platform,()=>notifications++);const cycles=h.trace.cycles.length;const patches=h.patches().length;
    const applying=h.context.launcher.preset({mode,speed:mode==="hvh"?"bullet":"blitz",arrows:"curved_neon"});await h.settle();assert.equal(await applying,true,`${platform}/${mode}`);
    assert.equal(h.native.disk[`${platform}.safeAntiBanGuard`],false);assert.equal(h.state().safeAntiBanGuard,false);
    assert.equal(h.native.disk[`${platform}.workMode`],"all");assert.equal(h.native.disk[`${platform}.bulletTurboMode`],platform==="lichess"?false:undefined);
    assert.equal(h.native.disk[`${platform}.premoveEnabled`],platform==="lichess"?false:undefined);assert.equal(h.native.disk[`${platform}.autoMoveEnabled`],false);
    assert.equal(h.preferences().mobilePresetId,{legit:"calm",hvh:"fast",balance:"balanced"}[mode]);
    assert.equal(notifications,1);assert.equal(h.trace.cycles.length-cycles,1);assert.equal(h.patches().length-patches,1);
    assert.equal(h.native.disk[`${platform}.mode`],undefined);assert.equal(h.native.disk[`${platform}.desiredPremove`],undefined);
    assert.equal(h.native.disk[`${platform}.presetId`],undefined);
    assert.equal(h.native.disk[`${platform}.mobileAnimations`],false);assert.equal(h.context.core.keys.includes("mobileAnimations"),false);
    h.dispose();
  }
});

test("Chess.com confirmation enables supported auto only and rejects phantom premove settings", async () => {
  const h=await harness("chesscom",enabled("chesscom")).boot();
  const applying=h.context.launcher.preset({mode:"hvh",speed:"bullet",arrows:"sq_minimal_dots"});await h.settle();assert.equal(await applying,true);
  const confirming=h.context.launcher.confirm();await h.settle();await confirming;
  assert.equal(h.native.disk["chesscom.autoMoveEnabled"],true);assert.equal(h.native.disk["chesscom.premoveEnabled"],undefined);
  await assert.rejects(()=>h.context.__CC_MOBILE_PREFERENCES__.update("chesscom",{premoveEnabled:true}),/not supported/);
  assert.equal(h.state().premoveEnabled,undefined);assert.equal(h.coreRoot.getElementById("cc-premove-chk"),null);h.dispose();
});

test("preset persistence uses site-specific DOM range normalization, not just buildPresetConfig values", async () => {
  for (const platform of ["lichess","chesscom"]) {
    const h=await harness(platform,enabled(platform),{tier:"HIGH"}).boot();
    const selection={mode:"hvh",speed:"bullet",arrows:"sq_minimal_dots"};
    const raw=clone(h.context.launcher.build(selection));assert.equal(raw.autoMoveDelayMs,182);assert.equal(raw.autoMoveJitterMs,29);
    const startCycles=h.trace.cycles.length;
    const applying=h.context.launcher.preset(selection);await h.settle();assert.equal(await applying,true);
    assert.equal(h.native.disk[`${platform}.autoMoveDelayMs`],platform==="lichess"?180:220);
    assert.equal(h.native.disk[`${platform}.autoMoveJitterMs`],platform==="lichess"?20:60);
    assert.equal(h.native.disk[`${platform}.averageMoveFrequency`],platform==="lichess"?0:10);
    const balanced=h.context.launcher.preset({mode:"balance",speed:"blitz",arrows:"curved_neon"});await h.settle();assert.equal(await balanced,true);
    assert.equal(h.native.disk[`${platform}.averageMoveFrequency`],20,"requested 18 is rounded to the UI step of 5");
    assert.equal(h.trace.cycles.length-startCycles,2);
    h.dispose();
  }
});

test("Balanced preset restores intended arrows/risk/T1/hesitation instead of inheriting stale MAX profile", async () => {
  for (const platform of ["lichess","chesscom"]) {
    const h=await harness(platform,enabled(platform,platform==="lichess"?{premoveRiskLevel:1}:{})).boot();
    h.change("cc-engine-max-chk",true);
    await h.settle();
    const applying=h.context.launcher.preset({mode:"balance",speed:"blitz",arrows:"curved_neon"});await h.settle();assert.equal(await applying,true);
    assert.equal(h.state().engineMaxMode,false);assert.equal(h.state().showAverageMove,true);assert.equal(h.state().useAverageMoveSometimes,true);
    if(platform==="lichess")assert.equal(h.state().premoveRiskLevel,3);
    else {assert.equal(h.state().autoT1LimiterEnabled,true);assert.equal(h.state().humanHesitationEnabled,true);}
    h.dispose();
  }
});

test("LOW to HIGH restricts only effective costly capabilities and retains checked/saved premove intent", async () => {
  const h=await harness("lichess",enabled()).boot();
  h.context.CCNative.onmessage({data:JSON.stringify({v:1,scope:"chesscoach.android",type:"profile.update",payload:{profile:{runtimeId:"chesscoach-android",recommendation:{tier:"LOW",movetimeScale:0.65}}}})});
  h.context.dispatchEvent(new FakeEvent("cc-device-profile-ready"));await h.settle();
  assert.equal(h.native.disk["lichess.premoveEnabled"],true);assert.equal(h.coreRoot.getElementById("cc-premove-chk").disabled,false);
  assert.equal(h.coreRoot.getElementById("cc-premove-chk").checked,true);assert.equal(h.effective().premoveEnabled,true);
  assert.equal(h.effective().bulletTurboMode,true);
  h.context.CCNative.onmessage({data:JSON.stringify({v:1,scope:"chesscoach.android",type:"profile.update",payload:{profile:{runtimeId:"chesscoach-android",recommendation:{tier:"HIGH",movetimeScale:1}}}})});
  h.context.dispatchEvent(new FakeEvent("cc-device-profile-ready"));await h.settle();
  assert.equal(h.coreRoot.getElementById("cc-premove-chk").disabled,false);assert.equal(h.state().premoveEnabled,true);assert.equal(h.effective().premoveEnabled,true);assert.equal(h.patches().length,0);h.dispose();
});

test("explicit edits during hydration overlay native/migration state and cannot be reset by missing-auto defaults", async () => {
  const h=harness("lichess",{});const boot=h.context.launcher.start();const core=h.context.core.load();await microtasks();
  assert.equal(h.context.launcher.inspect().storageReady,false);
  assert.equal(h.trace.panelStarts,0);h.change("cc-bullet-turbo-chk",true);await microtasks();
  await h.advance(1000);await Promise.all([boot,core]);await h.settle();
  assert.equal(h.state().bulletTurboMode,true);assert.equal(h.native.disk["lichess.bulletTurboMode"],true);
  assert.equal(h.native.disk["lichess.autoMoveEnabled"],true);h.dispose();
});

test("legacy migration preserves enabled automation and scoped FALSE wins unscoped TRUE", async () => {
  const h=await harness("lichess",{workMode:"all",autoMoveEnabled:true,bulletTurboMode:true,premoveEnabled:true,showPremoveArrows:true,safeAntiBanGuard:false}).boot();
  assert.equal(h.native.disk.autoMoveEnabled,true,"legacy source keys remain");assert.equal(h.native.disk["lichess.autoMoveEnabled"],true);
  assert.equal(h.native.disk["lichess.bulletTurboMode"],true);assert.equal(h.native.disk["lichess.premoveEnabled"],true);
  const scoped=await harness("lichess",{autoMoveEnabled:true,"lichess.autoMoveEnabled":false}).boot();assert.equal(scoped.state().autoMoveEnabled,false);scoped.dispose();
  assert.equal(h.state().safeAntiBanGuard,false);h.dispose();
});

test("launcher derives its UI snapshot from the preference authority after ordinary core saves", async () => {
  const h=await harness("lichess",{"lichess.autoMoveEnabled":false}).boot();h.change("cc-bullet-turbo-chk",true);await h.settle();
  assert.equal(h.native.disk["lichess.autoMoveEnabled"],true);
  assert.equal(h.context.launcher.inspect().initialStorage["lichess.autoMoveEnabled"],true);h.dispose();
});

test("same-document new-game entry and repeated restore preserve preferences without duplicate adapters", async () => {
  for (const platform of ["lichess","chesscom"]) {
    const h=await harness(platform,enabled(platform)).boot();const before=h.state();
    h.context.location.pathname="/new-game";h.context.dispatchEvent(new FakeEvent("popstate"));await h.context.core.load();
    assert.deepEqual(h.state(),before);assert.equal(h.patches().length,0);
    const cycles=h.trace.cycles.length;const update=h.context.__CC_MOBILE_PREFERENCES__.update(platform,{style:"hikaru"},{recalculate:true});await h.settle();await update;
    assert.equal(h.trace.cycles.length-cycles,1);h.dispose();
  }
});

test("stale document-start snapshot is refreshed from native; a UI delta cannot erase newer preferences", async () => {
  const old=enabled("lichess",{autoMoveEnabled:false,bulletTurboMode:false,premoveEnabled:false});
  const origin=await harness("lichess",old).boot();origin.native.holdAcks=true;origin.change("cc-bullet-turbo-chk",true);await origin.settle();
  const pending=origin.native.queue.at(-1);origin.native.runIO(pending);origin.native.generation++;
  assert.equal(origin.native.complete(pending),false);assert.equal(origin.native.disk["lichess.bulletTurboMode"],true);assert.equal(origin.native.registered["lichess.bulletTurboMode"],true);
  const entered=await harness("lichess",old,{disk:origin.native.disk,revision:origin.native.revision}).boot();
  assert.equal(entered.state().bulletTurboMode,true);assert.equal(entered.native.disk["lichess.bulletTurboMode"],true);
  const save=entered.context.launcher.saveGlobal({cc_mobile_settings_tab:"more"});await entered.settle();await save;
  assert.equal(entered.native.disk["lichess.bulletTurboMode"],true);
  assert.equal(entered.trace.messages.at(-1).type,"storage.patch");assert.deepEqual(Object.keys(entered.trace.messages.at(-1).payload.items),["cc_mobile_settings_tab"]);
  origin.dispose();entered.dispose();
});

test("schema2 explicit TRUE guard survives; platform settings are independent and unsupported keys are not consumed", async () => {
  const h=await harness("chesscom",{cc_mobile_settings_schema:2,"lichess.safeAntiBanGuard":false,"chesscom.autoMoveEnabled":false,"chesscom.safeAntiBanGuard":true,"chesscom.bulletTurboMode":true,"chesscom.premoveEnabled":true}).boot();
  assert.equal(h.state().safeAntiBanGuard,true);assert.equal(h.state().bulletTurboMode,undefined);assert.equal(h.state().premoveEnabled,undefined);
  const names=h.context.core.keys;assert.equal(names.includes("bulletTurboMode"),false);assert.equal(names.includes("premoveEnabled"),false);h.dispose();
});
