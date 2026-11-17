(function () {
  "use strict";

  const KEY = "__CC_MOBILE_PREFERENCES__";
  const runtime = window.__CC_ANDROID_RUNTIME__;
  if (!runtime || window[KEY]) return;
  const storage = runtime.chrome.storage.local;
  const SCHEMA = 2;
  const SCHEMA_KEY = "cc_mobile_settings_schema";
  const PLATFORMS = ["lichess", "chesscom"];
  const PRESETS = new Set(["calm", "fast", "balanced", "custom"]);
  const PREMOVE_KEYS = new Set(["bulletTurboMode", "premoveEnabled", "premoveRiskLevel", "premoveOpeningMode", "showPremoveArrows"]);
  const UI_KEYS = new Set(["activeTabId", "panelLeft", "panelTop", "panelMinimized", "panelHidden", "welcomeBannerHidden"]);
  const COMMON = Object.freeze({
    workMode: "all", activeTabId: "analyzer", panelLeft: null, panelTop: null, panelMinimized: false, panelHidden: false,
    customBgDataUrl: "", customBgDim: 0.72, customBgBlur: 4,
    liveTelemetryEnabled: true, teleShowClocks: true, teleShowEngine: true, teleShowWdl: true, teleShowThreats: true,
    elo: 2000, style: "tal", showArrows: true, showEvalBar: true, showAverageMove: true, showWorstMove: true,
    turnMode: "my", forcedMyColor: "auto", useStockfishWasm: true, engineMaxMode: false,
    trapRadarEnabled: true, audioRadarEnabled: true, heatmapAlwaysOn: false,
    uiTheme: "cyberpunk", arrowStyle: "curved_neon", arrowScale: 1, arrowOpacity: 0.88,
    phonkEditEnabled: false, mateStyle: "phonk_skull", roflMode: true, safeAntiBanGuard: false, welcomeBannerHidden: false,
    autoMoveEnabled: false, legitAutoTiming: true, autoMoveDelayMs: 180, autoMoveJitterMs: 60, autoMoveTriggerRate: 100,
    useAverageMoveSometimes: false, averageMoveFrequency: 20, protectCriticalMoves: true,
    mobileAnimations: false, mobileVisualEffects: false, mobilePresetId: "custom"
  });
  const DEFAULTS = Object.freeze({
    lichess: Object.freeze({ ...COMMON, autoClickMethod: "twoclick", enable3DPiecesShadow: true,
      bulletTurboMode: false, premoveEnabled: false, premoveRiskLevel: 3, premoveOpeningMode: "auto", showPremoveArrows: false }),
    chesscom: Object.freeze({ ...COMMON, workMode: "legit", elo: 2400, showWorstMove: false, autoClickMethod: "bezier_click",
      humanHesitationEnabled: true, autoT1LimiterEnabled: true, maxSafeT1Percent: 66,
      autoMoveDelayMs: 540, autoMoveJitterMs: 260, autoMoveTriggerRate: 85, useAverageMoveSometimes: true, averageMoveFrequency: 30 })
  });
  const GLOBALS = Object.freeze({
    cc_mobile_ui_view_mode: "full", cc_mobile_ingame_submode: "mini", cc_mobile_last_welcome_date: "",
    cc_mobile_platform: /(^|\.)chess\.com$/i.test(location.hostname) ? "chesscom" : "lichess",
    cc_mobile_mini_hud_pos: null, cc_mobile_settings_tab: "presets",
    cc_mobile_calibrated_lichess: false, cc_mobile_calibrated_chesscom: false
  });
  const LEGACY_GLOBALS = Object.freeze({
    cc_ui_view_mode: "cc_mobile_ui_view_mode", cc_ingame_submode: "cc_mobile_ingame_submode",
    cc_last_welcome_date: "cc_mobile_last_welcome_date", cc_platform: "cc_mobile_platform",
    cc_mini_hud_pos: "cc_mobile_mini_hud_pos", cc_settings_tab: "cc_mobile_settings_tab"
  });
  const ENUMS = Object.freeze({
    workMode: ["all", "legit", "hvh"], turnMode: ["my", "auto", "w", "b"], forcedMyColor: ["auto", "w", "b"],
    style: ["mogging", "tal", "alphazero", "morphy", "hikaru", "kasparov", "fischer", "carlsen", "solid", "botvinnik", "balanced"],
    mobilePresetId: [...PRESETS]
  });
  const RANGES = Object.freeze({
    elo: [400, 3000, 100], customBgDim: [0, 0.95, 0.05], customBgBlur: [0, 30, 1],
    arrowScale: [0.5, 3, 0.05], arrowOpacity: [0.1, 1, 0.05], autoMoveTriggerRate: [0, 100, 1],
    premoveRiskLevel: [1, 4, 1], maxSafeT1Percent: [1, 100, 1]
  });
  let record = {};
  let hydrated = false;
  let hydrationError = null;
  let suspended = document.hidden === true;
  let hydrating = false;
  const buffered = [];
  const writes = new Set();
  const listeners = new Map(PLATFORMS.map(platform => [platform, new Set()]));
  const copy = value => JSON.parse(JSON.stringify(value));
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  function requirePlatform(platform) {
    if (!PLATFORMS.includes(platform)) throw new TypeError("Unknown mobile preference platform");
    return platform;
  }

  function capabilities(platform) {
    requirePlatform(platform);
    return Object.freeze({ premove: platform === "lichess", bulletTurbo: platform === "lichess" });
  }

  function rangeFor(platform, key) {
    if (key === "autoMoveDelayMs") return [platform === "chesscom" ? 220 : 20, 2500, 20];
    if (key === "autoMoveJitterMs") return [platform === "chesscom" ? 60 : 0, 1000, 20];
    if (key === "averageMoveFrequency") return platform === "chesscom" ? [10, 75, 5] : [0, 100, 5];
    return RANGES[key];
  }

  function normalizeValue(platform, key, value, quantize) {
    if (key === "chesscomVisualMaskV1" && platform === "chesscom") {
      return value && typeof value === "object" && !Array.isArray(value) ? copy(value) : undefined;
    }
    if (!Object.hasOwn(DEFAULTS[platform], key)) return undefined;
    const fallback = DEFAULTS[platform][key];
    if (key === "panelLeft" || key === "panelTop") return value === null || (typeof value === "number" && Number.isFinite(value)) ? value : undefined;
    if (typeof fallback === "boolean") return typeof value === "boolean" ? value : undefined;
    if (typeof fallback === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
      const range = rangeFor(platform, key);
      if (!range) return value;
      const [min, max, step] = range;
      let number = Math.max(min, Math.min(max, value));
      if (quantize) number = Math.max(min, Math.min(max, min + Math.round((number - min) / step) * step));
      return Number(number.toFixed(8));
    }
    if (typeof value !== "string") return undefined;
    if (ENUMS[key] && !ENUMS[key].includes(value)) return undefined;
    if (key === "autoClickMethod") {
      if (platform === "lichess" && value === "hybrid") return "twoclick";
      if (!(platform === "lichess" ? ["twoclick", "drag"] : ["bezier_click", "bezier_drag"]).includes(value)) return undefined;
    }
    if (key === "premoveOpeningMode" && !/^(?:auto|off|db_\d+)$/.test(value)) return undefined;
    return value;
  }

  function get(platform) {
    requirePlatform(platform);
    const result = { ...DEFAULTS[platform] };
    for (const key of [...Object.keys(result), ...(platform === "chesscom" ? ["chesscomVisualMaskV1"] : [])]) {
      const value = normalizeValue(platform, key, record[`${platform}.${key}`], false);
      if (value !== undefined) result[key] = value;
    }
    return copy(result);
  }

  function getEffective(platform) {
    const result = get(platform);
    const low = runtime.profile?.recommendation?.tier === "LOW";
    const paused = !hydrated || suspended || document.hidden || window.__CC_ANDROID_SETTINGS_OPEN__ === true;
    if (paused) result.autoMoveEnabled = false;
    if (platform === "lichess" && paused) {
      result.bulletTurboMode = false;
      result.premoveEnabled = false;
      result.showPremoveArrows = false;
    }
    if (low) {
      result.phonkEditEnabled = false;
      result.audioRadarEnabled = false;
      result.heatmapAlwaysOn = false;
      result.mobileAnimations = false;
      result.mobileVisualEffects = false;
    }
    return { ...result, ready: hydrated, paused, lowTier: low };
  }

  function notify(platform, meta) {
    for (const listener of [...listeners.get(platform)]) {
      try { listener(get(platform), Object.freeze({ ...meta })); }
      catch (error) { console.warn("[ChessCoach Android] Preference adapter failed", error); }
    }
  }

  function applyUpdate(platform, patch, options = {}) {
    requirePlatform(platform);
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new TypeError("Preference patch must be an object");
    const normalized = {};
    for (const [key, raw] of Object.entries(patch)) {
      if (platform === "chesscom" && PREMOVE_KEYS.has(key)) throw new TypeError("Chess.com premoves/turbo are not supported");
      const value = normalizeValue(platform, key, raw, true);
      if (value === undefined) throw new TypeError(`Invalid mobile preference: ${key}`);
      normalized[key] = value;
    }
    // The explicit action wins. Restoration never silently clamps saved intent.
    if (normalized.bulletTurboMode === true || normalized.premoveEnabled === true) normalized.engineMaxMode = false;
    if (normalized.useStockfishWasm === false) normalized.engineMaxMode = false;
    if (normalized.engineMaxMode === true) {
      Object.assign(normalized, { useStockfishWasm: true, elo: 3000, style: "balanced", showAverageMove: false, showWorstMove: false,
        useAverageMoveSometimes: false, legitAutoTiming: false, autoMoveTriggerRate: 100 });
      if (platform === "lichess") Object.assign(normalized, { bulletTurboMode: false, premoveEnabled: false });
      else Object.assign(normalized, { humanHesitationEnabled: false, autoT1LimiterEnabled: false });
    }
    if (options.presetId !== undefined) {
      if (!PRESETS.has(options.presetId)) throw new TypeError("Invalid mobile preset ID");
      normalized.mobilePresetId = options.presetId;
    } else if (Object.keys(normalized).some(key => !UI_KEYS.has(key) && key !== "workMode" && key !== "mobilePresetId")) {
      normalized.mobilePresetId = "custom";
    }
    const delta = {};
    for (const [key, value] of Object.entries(normalized)) {
      const scoped = `${platform}.${key}`;
      if (!equal(record[scoped], value)) delta[scoped] = value;
    }
    for (const [key, value] of Object.entries(options.global || {})) {
      if (!key.startsWith("cc_mobile_") || key === SCHEMA_KEY) throw new TypeError("Invalid global mobile preference");
      if (!equal(record[key], value)) delta[key] = copy(value);
    }
    if (options.source === "core" && Object.keys(normalized).some(key => !UI_KEYS.has(key) && key !== "workMode" && key !== "mobilePresetId")) {
      const calibrationKey = `cc_mobile_calibrated_${platform}`;
      if (record[calibrationKey] !== true) delta[calibrationKey] = true;
    }
    Object.assign(record, delta);
    return delta;
  }

  function persist(delta) {
    if (!Object.keys(delta).length) return Promise.resolve();
    const write = storage.set(delta);
    writes.add(write);
    write.then(() => writes.delete(write), () => writes.delete(write));
    return write;
  }

  function update(platform, patch, options = {}) {
    try {
      requirePlatform(platform);
      if (runtime.disposed) throw new Error("Android preference context is disposed");
      if (hydrationError) throw hydrationError;
      if (!hydrated) {
        return new Promise((resolve, reject) => buffered.push({ platform, patch: copy(patch), options: copy(options), resolve, reject }));
      }
      const delta = applyUpdate(platform, patch, options);
      if (Object.keys(delta).length) notify(platform, { source: options.source || "core", recalculate: options.recalculate === true, keys: Object.keys(delta) });
      return persist(delta).then(() => get(platform));
    } catch (error) { return Promise.reject(error); }
  }

  async function updateGlobal(patch) {
    await ready;
    if (runtime.disposed) throw new Error("Android preference context is disposed");
    const delta = {};
    for (const [key, value] of Object.entries(patch || {})) {
      if (!key.startsWith("cc_mobile_") || key === SCHEMA_KEY) throw new TypeError("Invalid global mobile preference");
      if (!equal(record[key], value)) delta[key] = copy(value);
    }
    Object.assign(record, delta);
    await persist(delta);
    return getStorage();
  }

  function getStorage() { return copy({ ...GLOBALS, ...record }); }

  function migrate(raw) {
    const delta = {};
    if (raw[SCHEMA_KEY] === SCHEMA) return delta;
    for (const platform of PLATFORMS) {
      for (const key of [...Object.keys(DEFAULTS[platform]), ...(platform === "chesscom" ? ["chesscomVisualMaskV1"] : [])]) {
        const scoped = `${platform}.${key}`;
        if (!Object.hasOwn(raw, scoped) && Object.hasOwn(raw, key)) {
          const value = normalizeValue(platform, key, raw[key], false);
          if (value !== undefined) delta[scoped] = value;
        }
      }
      const migrated = { ...raw, ...delta };
      const maxKey = `${platform}.engineMaxMode`;
      if (platform === "lichess" && !Object.hasOwn(migrated, maxKey) && migrated[`${platform}.workMode`] === "hvh") delta[maxKey] = true;
      if (platform === "lichess" && (migrated[`${platform}.bulletTurboMode`] === true || migrated[`${platform}.premoveEnabled`] === true)) delta[maxKey] = false;
      delta[`${platform}.safeAntiBanGuard`] = false;
      const preset = raw[`${platform}.mobilePresetId`];
      delta[`${platform}.mobilePresetId`] = PRESETS.has(preset) ? preset : "custom";
      if (raw.cc_onboarding_done === true && !Object.hasOwn(raw, `cc_mobile_calibrated_${platform}`)) delta[`cc_mobile_calibrated_${platform}`] = true;
    }
    for (const [legacy, key] of Object.entries(LEGACY_GLOBALS)) {
      if (!Object.hasOwn(raw, key) && Object.hasOwn(raw, legacy)) delta[key] = raw[legacy];
    }
    delta[SCHEMA_KEY] = SCHEMA;
    return delta;
  }

  async function hydrate() {
    hydrating = true;
    const completed = [];
    try {
      await runtime.ready;
      const raw = await storage.get(null);
      record = copy(raw);
      const migration = migrate(raw);
      Object.assign(record, migration);
      let delta = migration;
      do {
        for (const request of buffered.splice(0)) {
          Object.assign(delta, applyUpdate(request.platform, request.patch, request.options));
          completed.push(request);
        }
        await persist(delta);
        delta = {};
      } while (buffered.length);
      hydrated = true;
      for (const request of completed) request.resolve(get(request.platform));
      return getStorage();
    } catch (error) {
      hydrationError = error;
      for (const request of [...completed, ...buffered.splice(0)]) request.reject(error);
      throw error;
    } finally { hydrating = false; }
  }

  async function refresh() {
    await ready;
    await runtime.refreshStorage();
    const next = await storage.get(null);
    const previous = record;
    record = copy(next);
    for (const platform of PLATFORMS) {
      if (!equal(Object.fromEntries(Object.entries(previous).filter(([key]) => key.startsWith(`${platform}.`))),
        Object.fromEntries(Object.entries(record).filter(([key]) => key.startsWith(`${platform}.`))))) notify(platform, { source: "refresh", recalculate: true });
    }
    return getStorage();
  }

  runtime.chrome.storage.onChanged.addListener((changes, area) => {
    if (!hydrated || hydrating || area !== "local") return;
    const affected = new Set();
    for (const [key, change] of Object.entries(changes)) {
      const next = Object.hasOwn(change, "newValue") ? change.newValue : undefined;
      if (equal(record[key], next)) continue;
      if (next === undefined) delete record[key]; else record[key] = copy(next);
      for (const platform of PLATFORMS) if (key.startsWith(`${platform}.`)) affected.add(platform);
    }
    for (const platform of affected) notify(platform, { source: "storage", recalculate: true });
  });
  document.addEventListener("visibilitychange", () => { suspended = document.hidden === true; });
  window.addEventListener("pagehide", () => { suspended = true; });
  window.addEventListener("pageshow", () => { suspended = document.hidden === true; });

  const ready = Promise.resolve().then(hydrate);
  ready.catch(error => console.warn("[ChessCoach Android] Preferences were not restored", error));
  const api = Object.freeze({
    version: SCHEMA, ready, get, getEffective, getStorage, capabilities, update, updateGlobal, refresh,
    get isReady() { return hydrated; },
    get error() { return hydrationError?.message || null; },
    subscribe(platform, listener) {
      requirePlatform(platform);
      if (typeof listener !== "function") throw new TypeError("Preference listener must be a function");
      listeners.get(platform).add(listener);
      return () => listeners.get(platform).delete(listener);
    },
    async flush() { await ready; await Promise.all([...writes]); return runtime.flushStorage(); }
  });
  Object.defineProperty(window, KEY, { value: api, configurable: false, writable: false });
})();
