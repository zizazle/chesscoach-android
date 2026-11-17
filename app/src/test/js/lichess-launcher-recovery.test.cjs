"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const launcher = fs.readFileSync(path.resolve(__dirname, "../../main/assets/bridge/cc-mobile-launcher-orb.js"), "utf8");

function productionFunction(name) {
  const match = new RegExp(`^  function ${name}\\(`, "m").exec(launcher);
  assert.ok(match, name);
  const tail = launcher.slice(match.index);
  const end = /\r?\n  }\r?\n/.exec(tail);
  assert.ok(end, `Closing boundary for ${name}`);
  return tail.slice(0, end.index + end[0].length);
}

function classList(initial = []) {
  const classes = new Set(initial);
  return {
    add: (...names) => names.forEach(name => classes.add(name)),
    remove: (...names) => names.forEach(name => classes.delete(name)),
    contains: name => classes.has(name),
    toggle(name, force) {
      const enabled = force === undefined ? !classes.has(name) : Boolean(force);
      if (enabled) classes.add(name); else classes.delete(name);
      return enabled;
    }
  };
}

function element({ connected = true, classes = [] } = {}) {
  const attributes = new Map();
  return {
    isConnected: connected,
    classList: classList(classes),
    style: {},
    textContent: "",
    title: "",
    dataset: {},
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    removeAttribute(name) { attributes.delete(name); if (name === "title") this.title = ""; }
  };
}

function harness({ connected, mode = "mini", platform = "lichess" }) {
  const trace = { saves: [], lifecycle: [], discoveries: 0, schedules: 0, stops: 0, clamps: 0 };
  const mini = element();
  const pill = element();
  const reason = element();
  const cornerText = element();
  const miniMenu = element();
  const pillMenu = element();
  const elements = {
    "cc-mini-tech-reason": reason,
    "cc-corner-move-short": cornerText,
    "cc-mini-settings-btn": miniMenu,
    "cc-corner-open-settings-btn": pillMenu
  };
  const panel = element({ connected, classes: ["cc-mobile-hidden", "cc-minimized"] });
  const host = { isConnected: connected };
  const coreRoot = { host };
  const hudShadow = { getElementById: id => elements[id] || null };
  const observer = { disconnect() {} };
  const context = vm.createContext({
    trace,
    fixture: { mini, pill, panel, host, coreRoot, hudShadow, observer },
    document: { visibilityState: "visible" },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    Promise,
    console
  });
  context.window = context;
  context.dispatchEvent = event => { trace.lifecycle.push(event.detail); return true; };

  vm.runInContext(`
    const currentPlatform = ${JSON.stringify(platform)};
    let destroyed = false;
    let uiViewMode = ${JSON.stringify(mode)};
    let lastInGameSubMode = "mini";
    let mainHudHost = fixture.host;
    let mainHudShadow = fixture.coreRoot;
    let mainPanel = fixture.panel;
    let hudShadow = fixture.hudShadow;
    let miniHudCard = fixture.mini;
    let cornerPill = fixture.pill;
    let rootSetupComplete = true;
    let pendingFullModeRequest = false;
    let hudRecoveryRetryScheduled = false;
    let hudDataObserver = fixture.observer;
    let scriptsObserver = fixture.observer;
    window.__CC_ANDROID_HUD_ROOT__ = fixture.coreRoot;
    function vibrate() {}
    function saveGlobalPatch(patch) { trace.saves.push({...patch}); return Promise.resolve(true); }
    function clampMiniHud() { trace.clamps++; }
    function stopHudDiscovery() { trace.stops++; }
    function startHudDiscovery() { trace.discoveries++; }
    function schedule(callback) { trace.schedules++; callback(); }
    ${productionFunction("showHudRecoveryStatus")}
    ${productionFunction("clearHudRecoveryStatus")}
    ${productionFunction("resetDisconnectedHudRegistration")}
    ${productionFunction("retryHudDiscovery")}
    ${productionFunction("requestFullUi")}
    ${productionFunction("setUiViewMode")}
    ${productionFunction("syncVisibilityStates")}
    globalThis.api = {
      requestFullUi,
      syncVisibilityStates,
      state: () => ({
        uiViewMode, pendingFullModeRequest, rootSetupComplete,
        settingsOpen: window.__CC_ANDROID_SETTINGS_OPEN__,
        miniDisplay: miniHudCard.style.display,
        pillDisplay: cornerPill.style.display,
        panelHidden: mainPanel?.classList.contains("cc-mobile-hidden"),
        reason: fixture.hudShadow.getElementById("cc-mini-tech-reason").textContent,
        corner: fixture.hudShadow.getElementById("cc-corner-move-short").textContent,
        retainedRoot: Boolean(window.__CC_ANDROID_HUD_ROOT__)
      })
    };
  `, context, { filename: "production/lichess-launcher-recovery.js" });
  return { api: context.api, trace };
}

test("connected Chess.com-like Menu path still opens the full panel", () => {
  const h = harness({ connected: true, platform: "chesscom" });
  h.api.requestFullUi();
  const state = h.api.state();

  assert.equal(state.uiViewMode, "full");
  assert.equal(state.settingsOpen, true);
  assert.equal(state.panelHidden, false);
  assert.equal(state.miniDisplay, "none");
  assert.equal(JSON.stringify(h.trace.saves), JSON.stringify([{ cc_mobile_ui_view_mode: "full" }]));
  assert.equal(JSON.stringify(h.trace.lifecycle), JSON.stringify([{ state: "settings", cancelPendingMoves: true }]));
  assert.equal(h.trace.discoveries, 0);
});

test("disconnected Lichess panel keeps Menu visible and retries discovery", () => {
  for (const mode of ["mini", "pill"]) {
    const h = harness({ connected: false, mode, platform: "lichess" });
    h.api.syncVisibilityStates();
    assert.equal(h.api.state()[mode === "mini" ? "miniDisplay" : "pillDisplay"], mode === "mini" ? "block" : "flex");

    h.api.requestFullUi();
    const state = h.api.state();

    assert.equal(state.uiViewMode, mode);
    assert.equal(state.settingsOpen, false);
    assert.equal(state.miniDisplay, mode === "mini" ? "block" : "none");
    assert.equal(state.pillDisplay, mode === "pill" ? "flex" : "none");
    assert.match(state.reason, /Ядро загружается.*перезапустите страницу/);
    assert.equal(state.corner, "ЯДРО...");
    assert.equal(state.pendingFullModeRequest, true);
    assert.equal(state.rootSetupComplete, false);
    assert.equal(state.retainedRoot, false);
    assert.equal(h.trace.saves.length, 0);
    assert.equal(h.trace.lifecycle.length, 0);
    assert.ok(h.trace.discoveries >= 1);
    assert.ok(h.trace.schedules >= 1);
  }
});

test("both floating Menu controls use the guarded full-mode request", () => {
  assert.match(launcher, /cc-mini-settings-btn"\), "click", requestFullUi/);
  assert.match(launcher, /cc-corner-open-settings-btn"\), "click", requestFullUi/);
});
