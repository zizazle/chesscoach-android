(function () {
  "use strict";

  const INSTANCE_KEY = Symbol.for("cc.android.mobile-launcher.instance");
  const previousInstance = window[INSTANCE_KEY];
  if (previousInstance?.isAlive?.()) return;
  try { previousInstance?.cleanup?.("reinjection"); } catch (e) {}

  const currentPlatform = location.hostname.includes("chess.com") ? "chesscom" : "lichess";
  const preferences = window.__CC_MOBILE_PREFERENCES__;
  const calibrationKey = `cc_mobile_calibrated_${currentPlatform}`;

  let destroyed = false;
  let storageReady = false;
  let initialStorage = preferences?.getStorage() || {};
  let uiViewMode = "full";
  let lastInGameSubMode = "mini";
  let mainHudHost = null;
  let mainHudShadow = null;
  let mainPanel = null;
  let hudHost = null;
  let hudShadow = null;
  let welcomeSplash = null;
  let onboardingModal = null;
  let autoConfirmModal = null;
  let miniHudCard = null;
  let cornerPill = null;
  let presetStatus = null;
  let pendingAutomation = null;
  let applyingPreset = false;
  let welcomeSequenceStarted = false;
  let welcomeDismissedByBack = false;
  let rootSetupComplete = false;
  let pendingFullModeRequest = false;
  let hudRecoveryRetryScheduled = false;
  let overlayPassthrough = false;
  let miniUpdateRaf = 0;
  let dragState = null;
  let documentHudObserver = null;
  let rootPanelObserver = null;
  let hudDataObserver = null;
  let scriptsObserver = null;
  const previousHudRegistrar = window.__ChessCoachRegisterHudShadow;
  const timers = new Set();
  const listenerCleanups = [];

  window.__ccMobileLauncherOrbInitialized = true;
  window.__CC_ANDROID_DISABLE_USER_SCRIPTS__ = true;
  window[INSTANCE_KEY] = {
    isAlive: () => !destroyed,
    cleanup
  };

  async function saveGlobalPatch(patch) {
    try {
      if (!preferences) return false;
      await preferences.updateGlobal(patch);
      initialStorage = preferences.getStorage();
      return true;
    } catch (error) {
      console.warn("[ChessCoach Android] Mobile UI preferences were not saved", error);
      return false;
    }
  }

  async function loadInitialStorage() {
    if (!preferences) throw new Error("Mobile preference authority is unavailable");
    await preferences.ready;
    if (destroyed) return;
    initialStorage = preferences.getStorage();
    uiViewMode = ["full", "mini", "pill"].includes(initialStorage.cc_mobile_ui_view_mode)
      ? initialStorage.cc_mobile_ui_view_mode
      : "full";
    lastInGameSubMode = ["mini", "pill"].includes(initialStorage.cc_mobile_ingame_submode)
      ? initialStorage.cc_mobile_ingame_submode
      : "mini";
    storageReady = true;
    listenerCleanups.push(preferences.subscribe(currentPlatform, () => {
      initialStorage = preferences.getStorage();
      renderPreferenceStatus();
    }));
    renderPreferenceStatus();
  }

  function nativeRequest(method, params) {
    try {
      const request = window.__CC_ANDROID_RUNTIME__?.nativeRequest;
      if (typeof request !== "function") return Promise.reject(new Error("native runtime unavailable"));
      return Promise.resolve(request(method, params || {}));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function vibrate(durationMs = 12) {
    const safeDuration = Math.max(5, Math.min(80, Number(durationMs) || 12));
    try { navigator.vibrate?.(safeDuration); } catch (e) {}
  }

  function compactText(value, maxLength) {
    return String(value || "")
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxLength);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[char]);
  }

  const TIER_RECOMMENDATIONS = Object.freeze({
    LOW: Object.freeze({ maxElo: 1600, useStockfish: true, animations: false, visualEffects: false, delayMs: 700, premove: false }),
    BALANCED: Object.freeze({ maxElo: 2400, useStockfish: true, animations: true, visualEffects: true, delayMs: 440, premove: true }),
    HIGH: Object.freeze({ maxElo: 2900, useStockfish: true, animations: true, visualEffects: true, delayMs: 260, premove: true })
  });

  function readDeviceRecommendation() {
    const runtimeProfile = window.__CC_ANDROID_RUNTIME__?.profile || window.__CC_ANDROID_BOOTSTRAP__?.profile || {};
    const profile = runtimeProfile.recommendation ? runtimeProfile : window.__CC_DEVICE_PROFILE__ || runtimeProfile;
    const recommendation = profile.recommendation;
    const tierCandidate = typeof recommendation === "string"
      ? recommendation
      : recommendation?.tier || profile.tier || profile.performanceTier;
    const tier = String(tierCandidate || "BALANCED").toUpperCase();
    const safeTier = Object.prototype.hasOwnProperty.call(TIER_RECOMMENDATIONS, tier) ? tier : "BALANCED";
    const defaults = TIER_RECOMMENDATIONS[safeTier];
    const movetimeScale = typeof recommendation === "object" && Number.isFinite(Number(recommendation.movetimeScale))
      ? Math.max(0.65, Math.min(1.8, Number(recommendation.movetimeScale)))
      : 1;
    const model = compactText(
      profile.model || profile.deviceModel || profile.modelName || profile.device || "Android",
      28
    ) || "Android";
    return Object.freeze({
      tier: safeTier,
      model,
      ...defaults,
      animations: false,
      visualEffects: false,
      delayMs: Math.round(defaults.delayMs * movetimeScale)
    });
  }

  let deviceRecommendation = readDeviceRecommendation();

  function schedule(fn, delayMs) {
    const id = setTimeout(() => {
      timers.delete(id);
      if (!destroyed) fn();
    }, Math.max(0, delayMs));
    timers.add(id);
    return id;
  }

  function clearScheduledWork() {
    for (const id of timers) clearTimeout(id);
    timers.clear();
    if (miniUpdateRaf) {
      cancelAnimationFrame(miniUpdateRaf);
      miniUpdateRaf = 0;
    }
  }

  function listen(target, type, handler, options) {
    if (!target?.addEventListener) return;
    target.addEventListener(type, handler, options);
    listenerCleanups.push(() => {
      try { target.removeEventListener(type, handler, options); } catch (e) {}
    });
  }

  const mobileOverrideCss = `
    :host { color-scheme: dark; }
    #chesscoach-panel {
      --cc-accent:#62dfc2; --cc-accent-2:#80cce5;
      --cc-text-strong:#edf4f6; --cc-text-primary:#c9d4dd; --cc-text-secondary:#9eafbd;
      --cc-text-muted:#8293a4; --cc-border-soft:#26323e; --cc-border-strong:#354652;
      position:fixed !important; inset:auto !important; margin:0 !important;
      left:var(--cc-mobile-viewport-left,0px) !important;
      top:var(--cc-mobile-viewport-top,0px) !important;
      width:var(--cc-mobile-viewport-width,100vw) !important;
      height:var(--cc-mobile-viewport-height,100dvh) !important;
      min-height:0 !important; max-height:var(--cc-mobile-viewport-height,100dvh) !important;
      border-radius:0 !important; border:none !important; display:flex !important;
      flex-direction:column !important; z-index:2147483646 !important;
      box-shadow:none !important; background:#0c131c !important;
      backdrop-filter:none !important; -webkit-backdrop-filter:none !important;
      transform:none !important; overflow:hidden !important;
      font-family:Roboto,"Segoe UI",system-ui,sans-serif !important;
      font-size:14px !important; line-height:1.5 !important; color:var(--cc-text-primary) !important;
    }
    #chesscoach-panel.cc-mobile-hidden {
      display: none !important;
      visibility: hidden !important;
      pointer-events: none !important;
      opacity: 0 !important;
    }
    #chesscoach-panel.cc-core-executing { pointer-events: none !important; }
    #chesscoach-header { min-height:56px !important; height:56px !important; padding:0 16px !important; flex-shrink:0 !important; cursor:default !important; background:#101a25 !important; gap:12px !important; border-bottom:1px solid #26323e !important; }
    #chesscoach-panel .cc-brand { font-size:19px !important; font-weight:750 !important; letter-spacing:-.4px !important; min-width:0 !important; gap:9px !important; }
    #chesscoach-panel .cc-brand-dot { width:8px !important; height:8px !important; box-shadow:none !important; flex-shrink:0 !important; }
    #chesscoach-panel .cc-badge,#chesscoach-panel .cc-engine-power,#chesscoach-panel .cc-deep-status { display:none !important; }
    #chesscoach-panel .cc-header-controls { gap:6px !important; flex-shrink:0 !important; }
    #chesscoach-panel .cc-pill-btn { min-height:44px !important; padding:8px 10px !important; font-size:12px !important; font-weight:650 !important; border-radius:12px !important; background:#1b2936 !important; border-color:#354652 !important; }
    #cc-toggle-btn { color:#62dfc2 !important; }
    #cc-mobile-launcher-bar {
      position:relative !important; z-index:5 !important; display:flex !important;
      flex-direction:column !important; gap:7px !important; padding:9px 16px 10px !important;
      background:#101a25 !important; border-bottom:1px solid #26323e !important; flex-shrink:0 !important;
    }
    .cc-launcher-topline { display:flex; justify-content:space-between; align-items:center; gap:8px; font-size:10.5px; }
    .cc-device-chip { max-width:66%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#9ecfbe; font-weight:600; }
    .cc-launcher-note { color:#91a6b9; font-size:10px; text-align:right; }
    .cc-launcher-cards-row { display:grid !important; grid-template-columns:repeat(2,minmax(0,1fr)) !important; gap:6px !important; }
    #chesscoach-panel .cc-platform-card { min-height:44px !important; min-width:0 !important; padding:8px 11px !important; border-radius:11px !important; border:1px solid #354652 !important; background:#172431 !important; color:#c9d8e4 !important; text-align:left !important; display:flex !important; align-items:center !important; justify-content:space-between !important; gap:6px !important; }
    #chesscoach-panel .cc-platform-card[aria-current="page"] { border-color:#3c8d79 !important; background:#173332 !important; color:#9bebd3 !important; }
    .cc-platform-card-title { font-size:13px; font-weight:650; }
    .cc-platform-card-sub { color:#91a6b9; font-size:10px; font-weight:500; }
    #cc-mode-switcher-bar { display:grid !important; padding:0 !important; gap:6px !important; background:none !important; border:none !important; }
    #chesscoach-panel .cc-mode-btn { min-height:44px !important; padding:7px 6px !important; font-size:11px !important; letter-spacing:0 !important; box-shadow:none !important; }
    #chesscoach-workspace { position:relative !important; z-index:3 !important; display:grid !important; grid-template-columns:minmax(0,1fr) !important; grid-template-rows:minmax(0,1fr) auto !important; overflow:hidden !important; flex:1 !important; min-height:0 !important; }
    #chesscoach-panel .cc-sidebar { grid-row:2 !important; padding:5px 8px max(5px,env(safe-area-inset-bottom,0px)) !important; border-right:none !important; border-top:1px solid #26323e !important; border-bottom:none !important; background:#101a25 !important; min-height:0 !important; justify-content:flex-start !important; }
    #chesscoach-panel .cc-nav-list { display:grid !important; grid-template-columns:repeat(5,minmax(0,1fr)) !important; flex-direction:row !important; gap:3px !important; padding:0 !important; min-width:0 !important; }
    #chesscoach-panel .cc-tab-btn { min-width:0 !important; min-height:58px !important; padding:6px 2px !important; font-size:10.5px !important; font-weight:600 !important; text-align:center !important; white-space:nowrap !important; display:flex !important; flex-direction:column !important; justify-content:center !important; gap:3px !important; border-radius:12px !important; transform:none !important; box-shadow:none !important; color:#93a6b8 !important; }
    #chesscoach-panel .cc-tab-btn svg { width:21px; height:21px; fill:none; stroke:currentColor; stroke-width:1.7; stroke-linecap:round; stroke-linejoin:round; }
    #chesscoach-panel .cc-tab-btn.active { background:#1a3437 !important; color:#82ecd1 !important; border-color:transparent !important; }
    #chesscoach-panel .cc-tab-btn.cc-mobile-extra-tab,#chesscoach-panel .cc-sidebar-footer { display:none !important; }
    #chesscoach-panel .cc-main-view { grid-row:1 !important; min-height:0 !important; min-width:0 !important; padding:16px !important; overflow-x:hidden !important; overflow-y:auto !important; overscroll-behavior-y:contain !important; -webkit-overflow-scrolling:touch !important; gap:12px !important; }
    #chesscoach-panel .cc-tab-pane { flex:none !important; gap:12px !important; min-width:0 !important; }
    #chesscoach-panel .cc-glass-card { padding:14px !important; border-radius:16px !important; border-color:#2b3946 !important; background:#131f2b !important; box-shadow:none !important; min-width:0 !important; }
    #chesscoach-panel .cc-section-title { font-size:13px !important; font-weight:650 !important; letter-spacing:0 !important; line-height:1.45 !important; gap:8px !important; align-items:flex-start !important; flex-wrap:wrap !important; color:#bdd5df !important; }
    #chesscoach-panel .cc-control-row { gap:6px 10px !important; font-size:13px !important; flex-wrap:wrap !important; margin-bottom:0 !important; }
    #chesscoach-panel .cc-control-row > strong { color:#82ecd1 !important; font-size:13px !important; }
    #chesscoach-panel .cc-Switch-row { min-height:48px !important; padding:8px 0 !important; gap:12px !important; font-size:13px !important; line-height:1.45 !important; }
    #chesscoach-panel .cc-Switch-row > div,#chesscoach-panel .cc-Switch-row > span { min-width:0 !important; flex:1 !important; }
    #chesscoach-panel .cc-Switch-row span[style*="font-size"] { font-size:13px !important; }
    #chesscoach-panel .cc-Switch-row div[style*="font-size"] { font-size:12px !important; color:#97aabb !important; line-height:1.5 !important; }
    #chesscoach-panel .cc-Switch-row input[type="checkbox"] { width:48px !important; height:28px !important; min-width:48px !important; min-height:28px !important; padding:0 !important; border-radius:16px !important; background:#344455 !important; border:1px solid #4a5c6d !important; box-shadow:none !important; }
    #chesscoach-panel .cc-Switch-row input[type="checkbox"]::after { top:3px !important; left:3px !important; width:20px !important; height:20px !important; background:#b5c5d2 !important; }
    #chesscoach-panel .cc-Switch-row input[type="checkbox"]:checked { background:#62dfc2 !important; border-color:#62dfc2 !important; }
    #chesscoach-panel .cc-Switch-row input[type="checkbox"]:checked::after { transform:translateX(20px) !important; background:#102c2c !important; }
    #chesscoach-panel .cc-slider { height:44px !important; min-height:44px !important; margin:0 !important; padding:0 !important; }
    #chesscoach-panel .cc-select,#chesscoach-panel .cc-text-input { width:100% !important; max-width:100% !important; min-height:46px !important; font-size:14px !important; padding:10px 11px !important; border-radius:11px !important; background:#0d1722 !important; border-color:#354652 !important; }
    #chesscoach-panel .cc-btn,#chesscoach-panel .cc-style-btn { min-height:46px !important; font-size:13px !important; font-weight:650 !important; padding:10px 12px !important; border-radius:11px !important; box-shadow:none !important; }
    #chesscoach-panel .cc-btn-primary { background:#62dfc2 !important; color:#0b2825 !important; }
    #chesscoach-panel .cc-move-card { font-size:13px !important; padding:13px !important; background:#131f2b !important; border-radius:14px !important; box-shadow:none !important; }
    #chesscoach-panel .cc-move-header { font-size:13px !important; }
    #chesscoach-panel .cc-auto-status-box { font-size:12px !important; padding:12px !important; gap:8px !important; flex-direction:column !important; align-items:flex-start !important; background:#102e2c !important; border-color:#2b5a51 !important; }
    #chesscoach-panel .cc-auto-status-box strong { font-weight:600 !important; overflow-wrap:anywhere !important; }
    #chesscoach-panel .cc-tele-header,#chesscoach-panel .cc-tele-box-val { font-size:12px !important; }
    #chesscoach-panel .cc-tele-box-title,#chesscoach-panel .cc-mask-field { font-size:11px !important; }
    #chesscoach-panel .cc-style-grid { grid-template-columns:repeat(2,minmax(0,1fr)) !important; gap:8px !important; }
    #chesscoach-panel .cc-actions-bar { margin-top:0 !important; grid-template-columns:repeat(2,minmax(0,1fr)) !important; }
    #chesscoach-panel .cc-tele-gear-btn { min-height:44px !important; padding:8px !important; font-size:12px !important; }
    #chesscoach-panel .cc-tele-chk-label { min-height:44px !important; }
    #chesscoach-panel input[type="checkbox"] { accent-color:#62dfc2 !important; }
    #chesscoach-panel button,#chesscoach-panel label { touch-action:manipulation !important; -webkit-tap-highlight-color:transparent !important; }
    #chesscoach-panel :is(button,input,select):focus-visible { outline:2px solid #80e6ce !important; outline-offset:3px !important; }
    #chesscoach-panel :is(input,button,select):disabled { opacity:.45 !important; }
    #cc-welcome-card { display:none !important; }
    #chesscoach-panel *,#chesscoach-panel *::before,#chesscoach-panel *::after { animation:none !important; transition:none !important; backdrop-filter:none !important; -webkit-backdrop-filter:none !important; }
    #chesscoach-panel::before { height:2px !important; background:#62dfc2 !important; }
    #cc-neural-canvas { display:none !important; }
    .cc-preset-hero { padding:2px 0 4px; }
    .cc-preset-hero h2 { margin:0 0 5px; font-size:24px; line-height:1.25; font-weight:700; letter-spacing:-.5px; color:#edf4f6; }
    .cc-preset-lead { margin:0; color:#95a9bc; font-size:13px; line-height:1.55; }
    .cc-preset-grid { display:grid; grid-template-columns:minmax(0,1fr); gap:10px; }
    .cc-preset-card { min-height:88px; width:100%; border-radius:14px; padding:14px; text-align:left; border:1px solid #354652; background:#172431; color:#edf4f6; display:flex; flex-direction:column; justify-content:center; gap:5px; }
    .cc-preset-title { font-size:15px; font-weight:650; }
    .cc-preset-desc { font-size:12px; line-height:1.5; color:#9aafc0; }
    .cc-preset-meta { font-size:11px; font-weight:600; color:#82ecd1; }
    #cc-mobile-preset-status { color:#9cdbca; font-size:12px; line-height:1.5; }
    .cc-mobile-links { display:grid; gap:8px; }
    #chesscoach-panel .cc-mobile-link { width:100%; min-height:54px; padding:12px 14px; display:flex; align-items:center; justify-content:space-between; gap:12px; text-align:left; background:#172431; color:#d8e5ec; border:1px solid #354652; border-radius:12px; font:600 14px/1.4 Roboto,system-ui,sans-serif; cursor:pointer; }
    .cc-mobile-link small { display:block; color:#91a6b9; font-size:11px; font-weight:400; margin-top:2px; }
    .cc-mobile-chevron { font-size:22px; color:#62dfc2; }
    #cc-mobile-search-results { display:grid; gap:7px; margin-top:8px; }
    #cc-mobile-search-results:empty { display:none; }
    #chesscoach-panel .cc-mobile-search-hit { outline:2px solid #62dfc2; outline-offset:3px; }
    @media (min-width:720px) and (min-height:520px) {
      #chesscoach-panel { left:calc(var(--cc-mobile-viewport-left,0px) + 16px) !important; top:calc(var(--cc-mobile-viewport-top,0px) + 16px) !important; width:calc(var(--cc-mobile-viewport-width,100vw) - 32px) !important; height:calc(var(--cc-mobile-viewport-height,100dvh) - 32px) !important; max-width:960px !important; border:1px solid #354652 !important; border-radius:22px !important; }
      #chesscoach-workspace { grid-template-columns:132px minmax(0,1fr) !important; grid-template-rows:minmax(0,1fr) !important; }
      #chesscoach-panel .cc-sidebar { grid-row:1 !important; grid-column:1 !important; border-top:none !important; border-right:1px solid #26323e !important; padding:10px !important; }
      #chesscoach-panel .cc-nav-list { grid-template-columns:minmax(0,1fr) !important; gap:6px !important; }
      #chesscoach-panel .cc-tab-btn { flex-direction:row !important; justify-content:flex-start !important; padding:10px !important; font-size:12px !important; min-height:48px !important; gap:9px !important; }
      #chesscoach-panel .cc-main-view { grid-column:2 !important; padding:20px !important; }
      .cc-preset-grid { grid-template-columns:repeat(3,minmax(0,1fr)); }
      #cc-mobile-launcher-bar { flex-direction:row !important; align-items:center !important; justify-content:space-between !important; padding:10px 16px !important; }
      .cc-launcher-cards-row { width:330px; flex-shrink:0; }
    }
    @media (max-height:480px) {
      #chesscoach-header { min-height:48px !important; height:48px !important; }
      #cc-mobile-launcher-bar { padding:5px 12px !important; }
      .cc-launcher-topline { display:none; }
      #chesscoach-panel .cc-tab-btn { min-height:44px !important; flex-direction:row !important; gap:6px !important; }
      #chesscoach-panel .cc-tab-btn svg { width:18px; height:18px; }
      #chesscoach-panel .cc-main-view { padding:12px !important; }
    }
    @media (max-width:359px) {
      #chesscoach-header { padding:0 10px !important; gap:6px !important; }
      #chesscoach-panel .cc-brand { font-size:16px !important; }
      #chesscoach-panel .cc-pill-btn { padding:8px !important; font-size:11px !important; }
      #chesscoach-panel .cc-main-view { padding:12px !important; }
      #chesscoach-panel .cc-mask-editor-grid,#cc-tele-settings-drawer { grid-template-columns:minmax(0,1fr) !important; }
    }
  `;

  const floatingHudCss = `
    * { box-sizing: border-box; font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
    button { min-width: 44px; min-height: 44px; cursor: pointer; touch-action: manipulation; }
    button:focus-visible { outline: 3px solid #ffbe0b; outline-offset: 2px; }
    .cc-overlay {
      position: fixed; inset: 0; display: none; align-items: center; justify-content: center;
      padding: max(16px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right))
        max(16px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));
      background: rgba(5,8,15,.95); color: #f8fafc; pointer-events: auto; z-index: 2147483647;
    }
    .cc-modal-box {
      width: min(100%,420px); max-height: calc(100dvh - 32px); overflow-y: auto;
      overscroll-behavior: contain; background: rgba(12,16,28,.98); border: 1.5px solid rgba(0,245,212,.45);
      border-radius: 22px; padding: 20px 18px; box-shadow: 0 24px 60px rgba(0,0,0,.85);
      display: flex; flex-direction: column; gap: 13px;
    }
    #cc-daily-welcome-splash { flex-direction: column; text-align: center; }
    .cc-welcome-emblem { font-size: 42px; }
    .cc-welcome-title { color: #fff; font-size: 25px; font-weight: 900; }
    .cc-welcome-sub { color: #a7b4c6; font-size: 13px; line-height: 1.45; max-width: 320px; }
    .cc-welcome-progress { width: 210px; height: 5px; overflow: hidden; border-radius: 99px; background: rgba(255,255,255,.1); }
    .cc-welcome-progress::after { content: ""; display: block; height: 100%; background: linear-gradient(90deg,#00f5d4,#00bbf9,#c77dff); animation: cc-progress 1.8s linear forwards; }
    @keyframes cc-progress { from { width: 0; } to { width: 100%; } }
    .cc-step { align-self: flex-start; color: #04100e; background: #00f5d4; border-radius: 99px; padding: 5px 9px; font-size: 10px; font-weight: 900; }
    .cc-question { color: #fff; font-size: 18px; line-height: 1.3; font-weight: 900; }
    .cc-hint { color: #94a3b8; font-size: 11.5px; line-height: 1.4; }
    .cc-options { display: flex; flex-direction: column; gap: 9px; }
    .cc-option {
      width: 100%; min-height: 62px; padding: 11px 13px; border-radius: 14px; text-align: left;
      border: 1.5px solid rgba(255,255,255,.15); background: rgba(255,255,255,.05); color: #fff;
    }
    .cc-option strong, .cc-option span { display: block; }
    .cc-option strong { color: #00f5d4; font-size: 13px; }
    .cc-option span { margin-top: 3px; color: #cbd5e1; font-size: 11px; line-height: 1.35; }
    .cc-confirm-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
    .cc-confirm-actions button { border-radius: 12px; border: 1px solid rgba(255,255,255,.18); font-weight: 900; }
    #cc-auto-stay-off { background: rgba(255,255,255,.07); color: #f8fafc; }
    #cc-auto-enable { background: linear-gradient(135deg,#00f5d4,#00bbf9); color: #04100e; border: 0; }
    #cc-mini-hud-card {
      position: fixed; top: 54px; left: 10px; width: min(286px,calc(100vw - 16px));
      display: none; overflow: hidden; color: #f8fafc; background: rgba(8,12,20,.91);
      border: 1.5px solid rgba(0,245,212,.55); border-radius: 16px;
      box-shadow: 0 12px 32px rgba(0,0,0,.75); pointer-events: auto; touch-action: none; z-index: 2147483646;
    }
    .cc-mini-header { min-height: 52px; display: flex; justify-content: space-between; align-items: center; gap: 5px; padding: 4px 6px 4px 10px; background: rgba(4,7,13,.95); }
    .cc-mini-status { min-width: 0; color: #00f5d4; font-size: 9.5px; font-weight: 900; display: flex; align-items: center; gap: 5px; }
    .cc-mini-dot { width: 7px; height: 7px; border-radius: 50%; background: #00f5d4; box-shadow: 0 0 8px #00f5d4; flex: 0 0 auto; }
    .cc-mini-actions { display: flex; gap: 3px; }
    .cc-mini-btn { min-width: 44px; min-height: 44px; padding: 0 7px; border-radius: 9px; border: 1px solid rgba(255,255,255,.18); background: rgba(255,255,255,.08); color: #f1f5f9; font-size: 10px; font-weight: 900; }
    #cc-mini-play-btn { color: #00f5d4; border-color: rgba(0,245,212,.5); }
    #cc-mini-close-btn { color: #ff7bac; border-color: rgba(255,77,148,.45); }
    .cc-mini-body { padding: 9px 10px 11px; display: flex; flex-direction: column; gap: 5px; }
    .cc-mini-move-row { display: flex; justify-content: space-between; align-items: center; gap: 7px; }
    #cc-mini-move-main { color: #fff; font: 900 13px ui-monospace,monospace; }
    .cc-mini-badges { display: flex; gap: 4px; }
    .cc-mini-badge { padding: 3px 6px; border-radius: 6px; background: rgba(255,255,255,.07); color: #cbd5e1; font: 800 9px ui-monospace,monospace; }
    #cc-mini-eval-badge { color: #00f5d4; border: 1px solid rgba(0,245,212,.4); }
    #cc-mini-tech-reason { color: #e2e8f0; font-size: 10.5px; line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    #cc-mini-pv-line { color: #00bbf9; font: 9.5px ui-monospace,monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #cc-corner-pill { position: fixed; top: 62px; right: 10px; display: none; gap: 5px; pointer-events: auto; z-index: 2147483646; }
    .cc-corner-btn { min-height: 44px; border-radius: 13px; border: 1.5px solid #00f5d4; padding: 0 11px; background: rgba(8,12,20,.92); color: #fff; font-size: 10px; font-weight: 900; }
    .cc-passthrough { pointer-events: none !important; }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
    }
  `;

  function createFloatingHud() {
    if (destroyed || hudHost?.isConnected) return;
    const existing = document.getElementById("cc-mobile-launcher-host");
    if (existing) existing.remove();

    hudHost = document.createElement("div");
    hudHost.id = "cc-mobile-launcher-host";
    hudHost.style.cssText = "all:initial;position:fixed;inset:0;width:0;height:0;z-index:2147483647;pointer-events:none;";
    document.documentElement.appendChild(hudHost);
    hudShadow = hudHost.attachShadow({ mode: "open" });
    hudShadow.innerHTML = `
      <style>${floatingHudCss}</style>
      <div id="cc-daily-welcome-splash" class="cc-overlay" role="dialog" aria-modal="true" aria-label="Приветствие" aria-hidden="true" tabindex="-1">
        <div class="cc-welcome-emblem" aria-hidden="true">♟</div>
        <div class="cc-welcome-title">ChessCoach готов</div>
        <div class="cc-welcome-sub" id="cc-daily-welcome-sub"></div>
        <div class="cc-welcome-progress" aria-hidden="true"></div>
      </div>
      <div id="cc-onboarding-modal" class="cc-overlay" role="dialog" aria-modal="true" aria-labelledby="cc-survey-q-title" aria-hidden="true">
        <div class="cc-modal-box" role="document">
          <span class="cc-step" id="cc-survey-step-tag"></span>
          <div class="cc-question" id="cc-survey-q-title"></div>
          <div class="cc-hint" id="cc-survey-q-hint"></div>
          <div class="cc-options" id="cc-survey-opts-list"></div>
        </div>
      </div>
      <div id="cc-auto-confirm-modal" class="cc-overlay" role="dialog" aria-modal="true" aria-labelledby="cc-auto-confirm-title" aria-hidden="true">
        <div class="cc-modal-box" role="document">
          <span class="cc-step">ОТДЕЛЬНОЕ ПОДТВЕРЖДЕНИЕ</span>
          <div class="cc-question" id="cc-auto-confirm-title">Включить автоматические ходы?</div>
          <div class="cc-hint" id="cc-auto-confirm-text">
            Профиль уже применён, но автоход оставлен выключенным. Автоматизация может противоречить правилам игровой платформы.
          </div>
          <div class="cc-confirm-actions">
            <button type="button" id="cc-auto-stay-off">Оставить выкл.</button>
            <button type="button" id="cc-auto-enable">Включить явно</button>
          </div>
        </div>
      </div>
      <section id="cc-mini-hud-card" role="region" aria-label="Краткий анализ ChessCoach" aria-hidden="true">
        <div class="cc-mini-header" id="cc-mini-drag-handle">
          <div class="cc-mini-status" aria-live="polite">
            <span class="cc-mini-dot" id="cc-mini-dot" aria-hidden="true"></span>
            <span id="cc-mini-turn-txt">АНАЛИЗ ДОСКИ</span>
          </div>
          <div class="cc-mini-actions">
            <button type="button" class="cc-mini-btn" id="cc-mini-play-btn" aria-label="Сделать рекомендованный ход">ХОД</button>
            <button type="button" class="cc-mini-btn" id="cc-mini-settings-btn" aria-label="Открыть настройки">МЕНЮ</button>
            <button type="button" class="cc-mini-btn" id="cc-mini-close-btn" aria-label="Свернуть в кнопку">×</button>
          </div>
        </div>
        <div class="cc-mini-body">
          <div class="cc-mini-move-row">
            <span id="cc-mini-move-main">Ожидание...</span>
            <span class="cc-mini-badges"><span class="cc-mini-badge" id="cc-mini-wdl-pill">W 50%</span><span class="cc-mini-badge" id="cc-mini-eval-badge">0.00</span></span>
          </div>
          <div id="cc-mini-tech-reason">Откройте партию или сделайте ход для расчёта.</div>
          <div id="cc-mini-pv-line"></div>
        </div>
      </section>
      <div id="cc-corner-pill" role="group" aria-label="ChessCoach" aria-hidden="true">
        <button type="button" class="cc-corner-btn" id="cc-corner-restore-hud-btn" aria-label="Развернуть мини-анализ"><span id="cc-corner-move-short">АНАЛИЗ</span></button>
        <button type="button" class="cc-corner-btn" id="cc-corner-open-settings-btn" aria-label="Открыть настройки">МЕНЮ</button>
      </div>
    `;

    welcomeSplash = hudShadow.getElementById("cc-daily-welcome-splash");
    onboardingModal = hudShadow.getElementById("cc-onboarding-modal");
    autoConfirmModal = hudShadow.getElementById("cc-auto-confirm-modal");
    miniHudCard = hudShadow.getElementById("cc-mini-hud-card");
    cornerPill = hudShadow.getElementById("cc-corner-pill");

    for (const overlay of [welcomeSplash, onboardingModal, autoConfirmModal, miniHudCard, cornerPill]) {
      for (const eventName of ["pointerdown", "pointermove", "pointerup", "click", "dblclick", "contextmenu"]) {
        listen(overlay, eventName, (event) => {
          event.stopPropagation();
          if (eventName === "contextmenu") event.preventDefault();
        });
      }
    }

    listen(hudShadow.getElementById("cc-mini-play-btn"), "click", () => {
      vibrate(18);
      if (document.visibilityState !== "visible" || !mainHudShadow) return;
      const playButton = mainHudShadow.getElementById("cc-play-once");
      if (playButton && !playButton.disabled) playButton.click();
    });
    listen(hudShadow.getElementById("cc-mini-settings-btn"), "click", requestFullUi);
    listen(hudShadow.getElementById("cc-mini-close-btn"), "click", () => setUiViewMode("pill"));
    listen(hudShadow.getElementById("cc-corner-restore-hud-btn"), "click", () => setUiViewMode("mini"));
    listen(hudShadow.getElementById("cc-corner-open-settings-btn"), "click", requestFullUi);
    listen(hudShadow.getElementById("cc-auto-stay-off"), "click", () => {
      vibrate(10);
      pendingAutomation = null;
      hideOverlay(autoConfirmModal);
      setUiViewMode(lastInGameSubMode);
    });
    listen(hudShadow.getElementById("cc-auto-enable"), "click", () => {
      void confirmAutomationExplicitly();
    });

    installDragHandlers();
    installModalKeyboardHandling();
    applySavedMiniPosition();
    syncVisibilityStates();
  }

  function showOverlay(overlay, focusTarget) {
    if (!overlay || document.visibilityState !== "visible") return;
    overlay.style.display = "flex";
    overlay.setAttribute("aria-hidden", "false");
    schedule(() => {
      const target = focusTarget || overlay.querySelector("button,[href],input,select,[tabindex]:not([tabindex='-1'])") || overlay;
      try { target.focus({ preventScroll: true }); } catch (e) { target.focus?.(); }
    }, 0);
  }

  function hideOverlay(overlay) {
    if (!overlay) return;
    overlay.style.display = "none";
    overlay.setAttribute("aria-hidden", "true");
  }

  function isOverlayOpen(overlay) {
    return Boolean(overlay && overlay.getAttribute("aria-hidden") === "false" && overlay.style.display !== "none");
  }

  function installModalKeyboardHandling() {
    listen(hudShadow, "keydown", (event) => {
      const activeModal = [autoConfirmModal, onboardingModal, welcomeSplash].find(isOverlayOpen);
      if (!activeModal) return;
      if (event.key === "Escape") {
        event.preventDefault();
        handleAndroidBack();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(activeModal.querySelectorAll("button:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex='-1'])"));
      if (!focusable.length) {
        event.preventDefault();
        activeModal.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && hudShadow.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && hudShadow.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
  }

  function getVisualViewportBounds() {
    const viewport = window.visualViewport;
    const left = viewport ? viewport.offsetLeft : 0;
    const top = viewport ? viewport.offsetTop : 0;
    const width = viewport ? viewport.width : window.innerWidth;
    const height = viewport ? viewport.height : window.innerHeight;
    return { left, top, right: left + width, bottom: top + height, width, height };
  }

  function fitSettingsViewport() {
    if (!mainPanel) return;
    const viewport = getVisualViewportBounds();
    mainPanel.style.setProperty("--cc-mobile-viewport-left", `${viewport.left}px`);
    mainPanel.style.setProperty("--cc-mobile-viewport-top", `${viewport.top}px`);
    mainPanel.style.setProperty("--cc-mobile-viewport-width", `${viewport.width}px`);
    mainPanel.style.setProperty("--cc-mobile-viewport-height", `${viewport.height}px`);
  }

  function clampMiniHud(savePosition = false) {
    if (!miniHudCard) return;
    const viewport = getVisualViewportBounds();
    miniHudCard.style.maxWidth = `${Math.max(180, viewport.width - 8)}px`;
    const rect = miniHudCard.getBoundingClientRect();
    const width = rect.width || Math.min(286, Math.max(220, viewport.width - 16));
    const height = rect.height || 132;
    const currentLeft = Number.parseFloat(miniHudCard.style.left) || rect.left || viewport.left + 8;
    const currentTop = Number.parseFloat(miniHudCard.style.top) || rect.top || viewport.top + 54;
    const left = Math.max(viewport.left + 4, Math.min(viewport.right - width - 4, currentLeft));
    const top = Math.max(viewport.top + 4, Math.min(viewport.bottom - height - 4, currentTop));
    miniHudCard.style.left = `${left}px`;
    miniHudCard.style.top = `${top}px`;
    if (savePosition) {
      void saveGlobalPatch({ cc_mobile_mini_hud_pos: { left, top } });
    }
  }

  function applySavedMiniPosition() {
    if (!miniHudCard) return;
    const saved = initialStorage.cc_mobile_mini_hud_pos;
    if (saved && Number.isFinite(Number(saved.left)) && Number.isFinite(Number(saved.top))) {
      miniHudCard.style.left = `${Number(saved.left)}px`;
      miniHudCard.style.top = `${Number(saved.top)}px`;
    }
    clampMiniHud(false);
  }

  function installDragHandlers() {
    const handle = hudShadow.getElementById("cc-mini-drag-handle");
    listen(handle, "pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest("button")) return;
      const rect = miniHudCard.getBoundingClientRect();
      dragState = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
      try { handle.setPointerCapture(event.pointerId); } catch (e) {}
      event.preventDefault();
    });
    listen(handle, "pointermove", (event) => {
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      miniHudCard.style.left = `${dragState.left + event.clientX - dragState.x}px`;
      miniHudCard.style.top = `${dragState.top + event.clientY - dragState.y}px`;
      clampMiniHud(false);
      event.preventDefault();
    });
    const finishDrag = (event) => {
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      dragState = null;
      try { handle.releasePointerCapture(event.pointerId); } catch (e) {}
      clampMiniHud(true);
    };
    listen(handle, "pointerup", finishDrag);
    listen(handle, "pointercancel", finishDrag);
  }

  function showHudRecoveryStatus() {
    const message = "Ядро загружается. Если меню не появится, перезапустите страницу.";
    const reason = hudShadow?.getElementById("cc-mini-tech-reason");
    const corner = hudShadow?.getElementById("cc-corner-move-short");
    if (reason) reason.textContent = message;
    if (corner) corner.textContent = "ЯДРО...";
    for (const button of [
      hudShadow?.getElementById("cc-mini-settings-btn"),
      hudShadow?.getElementById("cc-corner-open-settings-btn")
    ]) {
      if (button) button.title = message;
    }
  }

  function clearHudRecoveryStatus() {
    const reason = hudShadow?.getElementById("cc-mini-tech-reason");
    const corner = hudShadow?.getElementById("cc-corner-move-short");
    if (reason?.textContent.startsWith("Ядро загружается")) {
      reason.textContent = "Откройте партию или сделайте ход для расчёта.";
    }
    if (corner?.textContent === "ЯДРО...") corner.textContent = "АНАЛИЗ";
    for (const button of [
      hudShadow?.getElementById("cc-mini-settings-btn"),
      hudShadow?.getElementById("cc-corner-open-settings-btn")
    ]) {
      if (button) button.removeAttribute("title");
    }
  }

  function resetDisconnectedHudRegistration() {
    if (!rootSetupComplete || mainPanel?.isConnected) return;
    rootSetupComplete = false;
    mainPanel = null;
    mainHudHost = null;
    mainHudShadow = null;
    hudDataObserver?.disconnect();
    scriptsObserver?.disconnect();
    hudDataObserver = null;
    scriptsObserver = null;
    stopHudDiscovery();
    if (window.__CC_ANDROID_HUD_ROOT__ && !window.__CC_ANDROID_HUD_ROOT__.host?.isConnected) {
      delete window.__CC_ANDROID_HUD_ROOT__;
    }
  }

  function retryHudDiscovery() {
    resetDisconnectedHudRegistration();
    startHudDiscovery();
    if (hudRecoveryRetryScheduled) return;
    hudRecoveryRetryScheduled = true;
    schedule(() => {
      hudRecoveryRetryScheduled = false;
      resetDisconnectedHudRegistration();
      startHudDiscovery();
    }, 750);
  }

  function requestFullUi() {
    if (mainPanel?.isConnected) {
      setUiViewMode("full");
      return;
    }
    pendingFullModeRequest = true;
    showHudRecoveryStatus();
    retryHudDiscovery();
    syncVisibilityStates();
  }

  function setUiViewMode(newMode) {
    if (!["full", "mini", "pill"].includes(newMode)) return;
    const modeChanged = uiViewMode !== newMode;
    vibrate(12);
    uiViewMode = newMode;
    const patch = { cc_mobile_ui_view_mode: newMode };
    if (newMode === "mini" || newMode === "pill") {
      lastInGameSubMode = newMode;
      patch.cc_mobile_ingame_submode = newMode;
    }
    void saveGlobalPatch(patch);
    syncVisibilityStates();
    if (modeChanged) {
      window.dispatchEvent(new CustomEvent("cc-mobile-lifecycle", {
        detail: { state: newMode === "full" ? "settings" : "active", cancelPendingMoves: newMode === "full" }
      }));
    }
  }

  function syncVisibilityStates() {
    const settingsVisible = uiViewMode === "full" && Boolean(mainPanel?.isConnected);
    const visibleMode = uiViewMode === "full" && !settingsVisible ? lastInGameSubMode : uiViewMode;
    window.__CC_ANDROID_SETTINGS_OPEN__ = settingsVisible;
    if (mainPanel) {
      mainPanel.classList.toggle("cc-mobile-hidden", uiViewMode !== "full");
      if (uiViewMode === "full") mainPanel.classList.remove("cc-minimized");
    }
    if (!miniHudCard || !cornerPill) return;
    const showMini = visibleMode === "mini" && document.visibilityState === "visible";
    const showPill = visibleMode === "pill" && document.visibilityState === "visible";
    miniHudCard.style.display = showMini ? "block" : "none";
    miniHudCard.setAttribute("aria-hidden", showMini ? "false" : "true");
    cornerPill.style.display = showPill ? "flex" : "none";
    cornerPill.setAttribute("aria-hidden", showPill ? "false" : "true");
    if (showMini) clampMiniHud(false);
  }

  function stopHudDiscovery() {
    documentHudObserver?.disconnect();
    rootPanelObserver?.disconnect();
    documentHudObserver = null;
    rootPanelObserver = null;
  }

  function registerProvidedHud(root) {
    if (destroyed || rootSetupComplete || !root || typeof root.getElementById !== "function") return false;
    const host = root.host;
    if (!host || !host.isConnected) return false;
    mainHudHost = host;
    mainHudShadow = root;
    Object.defineProperty(window, "__CC_ANDROID_HUD_ROOT__", {
      value: root, writable: true, configurable: true, enumerable: false
    });
    documentHudObserver?.disconnect();
    documentHudObserver = null;
    const panel = root.getElementById("chesscoach-panel");
    if (panel) {
      registerHudOnce(root, panel);
      return true;
    }
    rootPanelObserver?.disconnect();
    rootPanelObserver = new MutationObserver(() => {
      const candidate = root.getElementById("chesscoach-panel");
      if (candidate) registerHudOnce(root, candidate);
    });
    rootPanelObserver.observe(root, { childList: true, subtree: true });
    schedule(() => {
      rootPanelObserver?.disconnect();
      rootPanelObserver = null;
    }, 12000);
    return true;
  }

  function mobileHudRegistrar(root) {
    try { previousHudRegistrar?.(root); } catch (e) {}
    registerProvidedHud(root);
  }

  window.__ChessCoachRegisterHudShadow = mobileHudRegistrar;

  function tryRegisterExactHud() {
    if (destroyed || rootSetupComplete) return true;
    const retainedRoot = window.__CC_ANDROID_HUD_ROOT__;
    if (retainedRoot?.host?.isConnected) return registerProvidedHud(retainedRoot);
    const host = document.querySelector("#chesscoach-host");
    const root = host?.shadowRoot;
    if (!host || !root) return false;
    return registerProvidedHud(root);
  }

  function startHudDiscovery() {
    if (destroyed || rootSetupComplete || documentHudObserver) return;
    if (tryRegisterExactHud()) return;
    documentHudObserver = new MutationObserver(tryRegisterExactHud);
    documentHudObserver.observe(document.documentElement, { childList: true, subtree: true });
    schedule(() => {
      documentHudObserver?.disconnect();
      documentHudObserver = null;
    }, 12000);
  }

  function registerHudOnce(root, panel) {
    if (destroyed || rootSetupComplete || root !== mainHudShadow) return;
    rootSetupComplete = true;
    mainPanel = panel;
    clearHudRecoveryStatus();
    stopHudDiscovery();

    if (!root.getElementById("cc-mobile-override-style")) {
      const style = document.createElement("style");
      style.id = "cc-mobile-override-style";
      style.textContent = mobileOverrideCss;
      root.prepend(style);
    }
    panel.dataset.ccMobileLauncher = "1";
    fitSettingsViewport();
    applyDeviceClasses();
    setupMobileSettingsHub(root, panel);
    installHudDataSync(root);
    disableAndroidUserScripts(root);
    if (deviceRecommendation.tier === "LOW") enforceLowTierRestrictions();
    if (pendingFullModeRequest) {
      pendingFullModeRequest = false;
      setUiViewMode("full");
    } else {
      syncVisibilityStates();
    }
    maybeStartWelcomeSequence();
  }

  function applyDeviceClasses() {
    if (!mainPanel) return;
    mainPanel.classList.remove("cc-device-low", "cc-device-balanced", "cc-device-high", "cc-mobile-reduced-motion");
    mainPanel.classList.add(`cc-device-${deviceRecommendation.tier.toLowerCase()}`);
    if (!deviceRecommendation.animations || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      mainPanel.classList.add("cc-mobile-reduced-motion");
    }
    const chip = mainHudShadow?.getElementById("cc-mobile-device-chip");
    if (chip) chip.textContent = `${deviceRecommendation.tier} · ${deviceRecommendation.model}`;
    const recommendation = mainHudShadow?.getElementById("cc-mobile-recommendation-text");
    if (recommendation) recommendation.textContent = `${deviceRecommendation.model}. Один поток Stockfish, без постоянных анимаций. Рекомендуемый предел: ${deviceRecommendation.maxElo} ELO.`;
  }

  function setupMobileSettingsHub(root, panel) {
    if (root.getElementById("cc-mobile-launcher-bar")) return;
    const isChessCom = currentPlatform === "chesscom";
    const launcherBar = document.createElement("div");
    launcherBar.id = "cc-mobile-launcher-bar";
    launcherBar.innerHTML = `
      <div class="cc-launcher-topline">
        <span class="cc-device-chip" id="cc-mobile-device-chip">${deviceRecommendation.tier} · ${escapeHtml(deviceRecommendation.model)}</span>
        <span class="cc-launcher-note">Лёгкий интерфейс</span>
      </div>
      <div class="cc-launcher-cards-row" role="navigation" aria-label="Шахматная платформа">
        <button type="button" class="cc-platform-card" id="cc-select-lichess-btn" ${isChessCom ? "" : "aria-current=\"page\""}>
          <span class="cc-platform-card-title">Lichess</span><span class="cc-platform-card-sub">${isChessCom ? "Перейти" : "Открыт"}</span>
        </button>
        <button type="button" class="cc-platform-card" id="cc-select-chesscom-btn" ${isChessCom ? "aria-current=\"page\"" : ""}>
          <span class="cc-platform-card-title">Chess.com</span><span class="cc-platform-card-sub">${isChessCom ? "Открыт" : "Перейти"}</span>
        </button>
      </div>
    `;
    const modeBar = root.getElementById("cc-mode-switcher-bar");
    if (modeBar) panel.insertBefore(launcherBar, modeBar);
    else panel.prepend(launcherBar);

    addPresetPane(root);
    installMobileNavigation(root, modeBar);
    shieldPanelEvents(panel);

    listen(root.getElementById("cc-select-lichess-btn"), "click", () => {
      if (currentPlatform === "lichess") setUiViewMode(lastInGameSubMode);
      else void navigateToPlatform("lichess", root.getElementById("cc-select-lichess-btn"));
    });
    listen(root.getElementById("cc-select-chesscom-btn"), "click", () => {
      if (currentPlatform === "chesscom") setUiViewMode(lastInGameSubMode);
      else void navigateToPlatform("chesscom", root.getElementById("cc-select-chesscom-btn"));
    });

    const headerClose = root.getElementById("cc-toggle-btn");
    const brand = root.querySelector(".cc-brand > span:nth-child(2)");
    if (brand) brand.textContent = "ChessCoach";
    if (headerClose) {
      headerClose.textContent = "К доске";
      headerClose.setAttribute("aria-label", "Вернуться к доске");
      listen(headerClose, "click", (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        setUiViewMode(lastInGameSubMode);
      }, true);
    }
    root.querySelectorAll('.cc-Switch-row input[type="checkbox"]').forEach((input) => {
      const row = input.closest(".cc-Switch-row");
      input.setAttribute("aria-label", compactText(row.textContent, 180));
      listen(row, "click", (event) => {
        if (input.disabled || event.target.closest("input,button,select,a,label")) return;
        input.click();
      });
    });
    const autoPane = root.getElementById("cc-pane-automove");
    const autoCard = root.getElementById("cc-auto-master-chk")?.closest(".cc-glass-card");
    const autoStatus = autoPane?.querySelector(".cc-auto-status-box");
    if (autoCard && autoStatus) autoStatus.after(autoCard);
  }

  function shieldPanelEvents(panel) {
    for (const type of ["pointerdown", "pointermove", "pointerup", "click", "dblclick", "contextmenu"]) {
      listen(panel, type, (event) => {
        event.stopPropagation();
        if (type === "contextmenu") event.preventDefault();
      });
    }
  }

  function addPresetPane(root) {
    const nav = root.querySelector(".cc-nav-list");
    const mainView = root.querySelector(".cc-main-view");
    if (!nav || !mainView || root.getElementById("cc-pane-presets")) return;

    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "cc-tab-btn";
    tab.dataset.tab = "presets";
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", "cc-pane-presets");
    tab.textContent = "ПРЕСЕТЫ";
    nav.prepend(tab);

    const pane = document.createElement("div");
    pane.className = "cc-tab-pane";
    pane.id = "cc-pane-presets";
    pane.setAttribute("role", "tabpanel");
    pane.innerHTML = `
      <div class="cc-preset-hero">
        <h2>Настройте под себя</h2>
        <p class="cc-preset-lead">Готовый профиль в одно касание или точная настройка в разделах ниже.</p>
      </div>
      <div class="cc-glass-card">
        <label class="cc-preset-desc" for="cc-mobile-settings-search">Поиск по настройкам</label>
        <input type="search" class="cc-text-input" id="cc-mobile-settings-search" placeholder="Например: задержка, стрелки, цвет" autocomplete="off" style="margin-top:7px;">
        <div id="cc-mobile-search-results" aria-live="polite"></div>
      </div>
      <div class="cc-glass-card">
        <div class="cc-section-title"><span>Подобрано для телефона</span><span>${deviceRecommendation.tier}</span></div>
        <div class="cc-preset-desc" id="cc-mobile-recommendation-text">${escapeHtml(deviceRecommendation.model)}. Один поток Stockfish, без постоянных анимаций. Рекомендуемый предел: ${deviceRecommendation.maxElo} ELO.</div>
        <button type="button" class="cc-btn cc-btn-primary" id="cc-run-survey-again-btn" style="width:100%;margin-top:12px;">Подобрать профиль</button>
      </div>
      <div class="cc-preset-grid">
        <button type="button" class="cc-preset-card" id="cc-quick-preset-legit">
          <span class="cc-preset-title">Спокойный</span>
          <span class="cc-preset-desc">Без лишних эффектов, с увеличенной паузой перед ходом.</span>
          <span class="cc-preset-meta">Для вдумчивой игры</span>
        </button>
        <button type="button" class="cc-preset-card" id="cc-quick-preset-hvh">
          <span class="cc-preset-title">Быстрый</span>
          <span class="cc-preset-desc">Короткая задержка, простые отметки клеток, без тяжёлых эффектов.</span>
          <span class="cc-preset-meta">Для коротких партий</span>
        </button>
        <button type="button" class="cc-preset-card" id="cc-quick-preset-balance">
          <span class="cc-preset-title">Сбалансированный</span>
          <span class="cc-preset-desc">Умеренный темп, понятные подсказки и защита критических ходов.</span>
          <span class="cc-preset-meta">Для повседневной игры</span>
        </button>
      </div>
      <div id="cc-mobile-preset-status" role="status" aria-live="polite">Автоход по умолчанию выключен.</div>
    `;
    mainView.prepend(pane);
    presetStatus = pane.querySelector("#cc-mobile-preset-status");
    renderPreferenceStatus();

    const activatePresetTab = () => {
      root.querySelectorAll(".cc-tab-btn").forEach((button) => {
        const active = button === tab;
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", active ? "true" : "false");
      });
      root.querySelectorAll(".cc-tab-pane").forEach((candidate) => candidate.classList.toggle("active", candidate === pane));
    };
    listen(tab, "click", activatePresetTab);
    root.querySelectorAll(".cc-tab-btn").forEach((button) => {
      if (button === tab) return;
      listen(button, "click", () => {
        tab.classList.remove("active");
        tab.setAttribute("aria-selected", "false");
        pane.classList.remove("active");
      });
    });
    listen(pane.querySelector("#cc-run-survey-again-btn"), "click", () => openOnboardingSurveyModal(true));
    listen(pane.querySelector("#cc-quick-preset-legit"), "click", () => {
      void applySmartPresetConfig({ mode: "legit", speed: "blitz", arrows: "curved_neon" });
    });
    listen(pane.querySelector("#cc-quick-preset-hvh"), "click", () => {
      void applySmartPresetConfig({ mode: "hvh", speed: "bullet", arrows: "sq_cyber_frame" });
    });
    listen(pane.querySelector("#cc-quick-preset-balance"), "click", () => {
      void applySmartPresetConfig({ mode: "balance", speed: "blitz", arrows: "curved_neon" });
    });
    installSettingsSearch(root, pane);
    activatePresetTab();
  }

  function activateMobileTab(root, tabId) {
    const pane = root.getElementById(`cc-pane-${tabId}`);
    if (!pane) return;
    if (tabId !== "presets" && tabId !== "more") {
      root.querySelector(`.cc-tab-btn[data-tab="${tabId}"]`)?.click();
    }
    root.querySelectorAll(".cc-tab-pane").forEach((candidate) => candidate.classList.toggle("active", candidate === pane));
    root.querySelectorAll(".cc-tab-btn").forEach((button) => {
      const active = button.dataset.tab === tabId || (button.dataset.tab === "more" && ["visuals", "privacy", "misc"].includes(tabId));
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
    root.querySelector(".cc-main-view").scrollTop = 0;
    if (storageReady) void saveGlobalPatch({ cc_mobile_settings_tab: tabId });
  }

  function installMobileNavigation(root, modeBar) {
    const nav = root.querySelector(".cc-nav-list");
    const mainView = root.querySelector(".cc-main-view");
    if (!nav || !mainView) return;
    nav.setAttribute("role", "tablist");
    nav.setAttribute("aria-label", "Разделы настроек");
    const more = document.createElement("button");
    more.type = "button";
    more.className = "cc-tab-btn";
    more.dataset.tab = "more";
    nav.appendChild(more);
    const labels = { presets: "Настройки", analyzer: "Анализ", automove: "Автоход", rage: "Движок", more: "Ещё" };
    const icons = {
      presets: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
      analyzer: '<path d="M4 19V5m0 14h16M7 14l4-5 4 3 5-7"/>',
      automove: '<rect x="4" y="7" width="16" height="13" rx="4"/><path d="M12 3v4M8 12v2m8-2v2m-7 3h6"/>',
      rage: '<path d="m13 3-9 11h7l-1 7 10-12h-7z"/>',
      more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'
    };
    const extraPane = document.createElement("div");
    extraPane.id = "cc-pane-more";
    extraPane.className = "cc-tab-pane";
    extraPane.setAttribute("role", "tabpanel");
    extraPane.innerHTML = '<div class="cc-preset-hero"><h2>Дополнительные настройки</h2><p class="cc-preset-lead">Оформление, сохранённые позиции и расширенные параметры.</p></div><div class="cc-mobile-links"></div><div class="cc-glass-card" id="cc-mobile-modes-card"><div class="cc-section-title">Набор доступных функций</div><p class="cc-preset-desc">Переключатель меняет видимость расширенных настроек. Используйте автоматику только там, где это разрешено.</p></div>';
    mainView.appendChild(extraPane);
    if (modeBar) extraPane.querySelector("#cc-mobile-modes-card").appendChild(modeBar);
    const extras = { visuals: ["Оформление", "Стрелки, цвета и вид доски"], privacy: ["Запись и внешний вид", "Параметры отображения игроков"], misc: ["База и опыт", "Сохранённые позиции и настройки"] };
    nav.querySelectorAll(".cc-tab-btn").forEach((button) => {
      const id = button.dataset.tab;
      if (labels[id]) {
        button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[id]}</svg><span>${labels[id]}</span>`;
        button.setAttribute("role", "tab");
        button.setAttribute("aria-controls", `cc-pane-${id}`);
      } else {
        button.classList.add("cc-mobile-extra-tab");
        const [label, description] = extras[id] || [compactText(button.textContent, 50), "Расширенные параметры"];
        const link = document.createElement("button");
        link.type = "button";
        link.className = "cc-mobile-link";
        link.innerHTML = `<span>${escapeHtml(label)}<small>${escapeHtml(description)}</small></span><span class="cc-mobile-chevron" aria-hidden="true">›</span>`;
        listen(link, "click", () => activateMobileTab(root, id));
        extraPane.querySelector(".cc-mobile-links").appendChild(link);
      }
    });
    listen(more, "click", () => activateMobileTab(root, "more"));
    listen(nav, "click", (event) => {
      const button = event.target.closest(".cc-tab-btn");
      if (!button) return;
      schedule(() => {
        const pane = root.querySelector(".cc-tab-pane.active");
        const tabId = pane?.id.replace("cc-pane-", "") || button.dataset.tab;
        nav.querySelectorAll(".cc-tab-btn").forEach((candidate) => {
          const active = candidate.dataset.tab === tabId || (candidate === more && Boolean(extras[tabId]));
          candidate.classList.toggle("active", active);
          candidate.setAttribute("aria-selected", String(active));
        });
        mainView.scrollTop = 0;
        if (storageReady) void saveGlobalPatch({ cc_mobile_settings_tab: tabId });
      }, 0);
    });
    activateMobileTab(root, initialStorage.cc_mobile_settings_tab || "presets");
  }

  function installSettingsSearch(root, pane) {
    const search = pane.querySelector("#cc-mobile-settings-search");
    const results = pane.querySelector("#cc-mobile-search-results");
    listen(search, "input", () => {
      results.replaceChildren();
      const query = search.value.trim().toLocaleLowerCase("ru");
      if (query.length < 2) return;
      const seen = new Set();
      const labels = { analyzer: "Анализ", automove: "Автоход", rage: "Движок", visuals: "Оформление", privacy: "Запись", misc: "База и опыт" };
      for (const target of root.querySelectorAll(".cc-Switch-row,.cc-control-row,.cc-section-title")) {
        const targetPane = target.closest(".cc-tab-pane");
        const tabId = targetPane?.id.replace("cc-pane-", "");
        if (!labels[tabId]) continue;
        const text = compactText(target.textContent, 180);
        if (!text.toLocaleLowerCase("ru").includes(query) || seen.has(text)) continue;
        seen.add(text);
        const button = document.createElement("button");
        button.type = "button";
        button.className = "cc-mobile-link";
        button.innerHTML = `<span>${escapeHtml(text)}<small>${labels[tabId]}</small></span><span class="cc-mobile-chevron" aria-hidden="true">›</span>`;
        button.addEventListener("click", () => {
          search.blur();
          activateMobileTab(root, tabId);
          target.classList.add("cc-mobile-search-hit");
          schedule(() => target.scrollIntoView({ block: "center" }), 120);
          schedule(() => target.classList.remove("cc-mobile-search-hit"), 1800);
        });
        results.appendChild(button);
        if (seen.size === 8) break;
      }
      if (!seen.size) results.textContent = "Настройки не найдены. Попробуйте другое слово.";
    });
  }

  async function navigateToPlatform(platform, button) {
    if (destroyed || !["lichess", "chesscom"].includes(platform)) return;
    vibrate(20);
    const subtitle = button?.querySelector(".cc-platform-card-sub");
    if (button) button.disabled = true;
    if (subtitle) subtitle.textContent = "Загрузка...";
    try {
      if (!await saveGlobalPatch({ cc_mobile_platform: platform })) throw new Error("Storage is unavailable");
      await preferences.flush();
      await nativeRequest("platform.switch", { platform: platform === "lichess" ? "LICHESS" : "CHESS_COM" });
    } catch (e) {
      if (button) button.disabled = false;
      if (subtitle) subtitle.textContent = "Недоступно";
    }
  }

  function buildPresetConfig({ mode, speed, arrows }) {
    const mobilePresetId = mode === "hvh" || mode === "fast" ? "fast" : mode === "balance" || mode === "balanced" ? "balanced" : "calm";
    const isFast = mobilePresetId === "fast";
    const isBalanced = mobilePresetId === "balanced";
    const supported = preferences.capabilities(currentPlatform);
    const speedFactor = speed === "bullet" ? 0.7 : speed === "rapid" ? 1.45 : 1;
    const minimumDelay = deviceRecommendation.tier === "LOW" ? 620 : 140;
    const delay = Math.max(minimumDelay, Math.round(deviceRecommendation.delayMs * speedFactor));
    const jitter = Math.max(25, Math.round(delay * (isFast ? 0.16 : 0.32)));
    const desiredPremove = supported.premove && deviceRecommendation.premove && (isFast || (isBalanced && speed === "bullet"));
    return {
      mode,
      mobilePresetId,
      workMode: "all",
      elo: deviceRecommendation.maxElo,
      style: isFast ? "balanced" : isBalanced ? "hikaru" : "tal",
      useStockfishWasm: deviceRecommendation.useStockfish,
      engineMaxMode: false,
      autoMoveEnabled: false,
      ...(supported.premove ? { bulletTurboMode: false, premoveEnabled: false, showPremoveArrows: false, premoveRiskLevel: 3 } : {}),
      ...(currentPlatform === "chesscom" ? { humanHesitationEnabled: !isFast, autoT1LimiterEnabled: !isFast, maxSafeT1Percent: 66 } : {}),
      legitAutoTiming: !isFast,
      useAverageMoveSometimes: isBalanced,
      averageMoveFrequency: isBalanced ? 18 : 0,
      protectCriticalMoves: true,
      safeAntiBanGuard: false,
      autoMoveTriggerRate: isFast ? 100 : isBalanced ? 95 : 85,
      autoMoveDelayMs: delay,
      autoMoveJitterMs: jitter,
      arrowStyle: arrows,
      showArrows: true,
      showEvalBar: true,
      showAverageMove: isBalanced,
      showWorstMove: false,
      phonkEditEnabled: false,
      audioRadarEnabled: false,
      heatmapAlwaysOn: false,
      mobileAnimations: deviceRecommendation.animations,
      mobileVisualEffects: deviceRecommendation.visualEffects,
      desiredPremove,
      desiredTurbo: supported.bulletTurbo && isFast && speed === "bullet" && deviceRecommendation.tier !== "LOW"
    };
  }

  function persistablePresetConfig(config) {
    const { mode, desiredPremove, desiredTurbo, ...persisted } = config;
    return persisted;
  }

  async function applySmartPresetConfig(selection) {
    if (applyingPreset || destroyed) return false;
    applyingPreset = true;
    vibrate(22);
    setPresetStatus("Применение профиля...", "#ffbe0b");
    try {
      await preferences.ready;
      if (destroyed || document.visibilityState !== "visible") return false;
      const config = buildPresetConfig(selection);
      await preferences.update(currentPlatform, persistablePresetConfig(config), {
        source: "preset", presetId: config.mobilePresetId, recalculate: true, global: { [calibrationKey]: true }
      });
      setPresetStatus(`Профиль ${deviceRecommendation.tier} применён. Автоход выключен.`, "#70e000");
      pendingAutomation = {
        autoMoveEnabled: true,
        mobilePresetId: config.mobilePresetId,
        ...(preferences.capabilities(currentPlatform).premove ? {
          premoveEnabled: Boolean(config.desiredPremove), showPremoveArrows: Boolean(config.desiredPremove), bulletTurboMode: Boolean(config.desiredTurbo)
        } : {})
      };
      showAutoConfirmation();
      return true;
    } catch (error) {
      setPresetStatus("Профиль не сохранён: " + compactText(error?.message, 120), "#ff7b9f");
      return false;
    } finally {
      applyingPreset = false;
    }
  }

  function setPresetStatus(text, color) {
    if (!presetStatus) return;
    presetStatus.textContent = text;
    if (color) presetStatus.style.color = color;
  }

  function renderPreferenceStatus() {
    if (!preferences?.isReady || !presetStatus) return;
    const saved = preferences.get(currentPlatform);
    const names = { calm: "Спокойный", fast: "Быстрый", balanced: "Сбалансированный", custom: "Пользовательский" };
    setPresetStatus(`${names[saved.mobilePresetId]} профиль сохранён. Автоход ${saved.autoMoveEnabled ? "включён" : "выключен"}.`, saved.autoMoveEnabled ? "#ffbe0b" : "#70e000");
  }

  function showAutoConfirmation() {
    if (!pendingAutomation || !autoConfirmModal) return;
    const text = hudShadow.getElementById("cc-auto-confirm-text");
    if (text) {
      text.textContent = pendingAutomation.premoveEnabled
        ? "Профиль применён с выключенной автоматикой. Явное включение активирует автоход и премувы; это может противоречить правилам платформы."
        : "Профиль применён с выключенной автоматикой. Явное включение активирует только автоход; это может противоречить правилам платформы.";
    }
    showOverlay(autoConfirmModal, hudShadow.getElementById("cc-auto-stay-off"));
  }

  async function confirmAutomationExplicitly() {
    if (!pendingAutomation || document.visibilityState !== "visible" || !mainHudShadow) return;
    const requested = pendingAutomation;
    pendingAutomation = null;
    hideOverlay(autoConfirmModal);
    try {
      await preferences.update(currentPlatform, requested, { source: "confirmation", presetId: requested.mobilePresetId });
      setUiViewMode(lastInGameSubMode);
      setPresetStatus("Автоход включён после явного подтверждения.", "#ffbe0b");
      vibrate(24);
    } catch (error) {
      setPresetStatus("Автоматика не сохранена: " + compactText(error?.message, 120), "#ff7b9f");
    }
  }

  function enforceLowTierRestrictions() {
    if (!mainHudShadow) return;
    for (const id of ["cc-bullet-turbo-chk", "cc-premove-chk", "cc-premove-arrows-chk"]) {
      const control = mainHudShadow.getElementById(id);
      if (control?.dataset.ccLowDisabled !== "1") continue;
      control.disabled = false;
      control.removeAttribute("aria-disabled");
      control.removeAttribute("title");
      delete control.dataset.ccLowDisabled;
    }
    const ids = ["cc-vis-phonk-chk", "cc-audio-radar-chk", "cc-heatmap-always-chk"];
    if (deviceRecommendation.tier !== "LOW") {
      for (const id of ids) {
        const control = mainHudShadow.getElementById(id);
        if (control?.dataset.ccLowDisabled !== "1") continue;
        control.disabled = false;
        control.removeAttribute("aria-disabled");
        control.removeAttribute("title");
        delete control.dataset.ccLowDisabled;
      }
      return;
    }
    for (const id of ids) {
      const control = mainHudShadow.getElementById(id);
      if (!control) continue;
      if (!control.disabled) control.dataset.ccLowDisabled = "1";
      control.disabled = true;
      control.setAttribute("aria-disabled", "true");
      control.title = "Временно приостановлено профилем LOW. Ваш выбор сохранён.";
    }
  }

  const SURVEY_STEPS = Object.freeze([
    Object.freeze({
      tag: "ШАГ 1 ИЗ 3 · РЕЖИМ",
      question: "Какой темп помощи вам нужен?",
      hint: "Автоход останется выключенным до отдельного подтверждения.",
      key: "mode",
      options: Object.freeze([
        Object.freeze({ value: "legit", title: "Спокойный", text: "Плавный темп и увеличенная задержка." }),
        Object.freeze({ value: "hvh", title: "Быстрый", text: "Минимальная задержка в пределах профиля устройства." }),
        Object.freeze({ value: "balance", title: "Сбалансированный", text: "Средний темп и защита критических ходов." })
      ])
    }),
    Object.freeze({
      tag: "ШАГ 2 ИЗ 3 · ВРЕМЯ",
      question: "Какой контроль времени вы играете чаще?",
      hint: "Задержка будет рассчитана от рекомендации устройства.",
      key: "speed",
      options: Object.freeze([
        Object.freeze({ value: "bullet", title: "Пуля", text: "Короткая рекомендуемая задержка." }),
        Object.freeze({ value: "blitz", title: "Блиц", text: "Базовая задержка профиля устройства." }),
        Object.freeze({ value: "rapid", title: "Рапид", text: "Увеличенная пауза перед действием." })
      ])
    }),
    Object.freeze({
      tag: "ШАГ 3 ИЗ 3 · ПОДСКАЗКИ",
      question: "Как показывать подсказки?",
      hint: "На LOW тяжёлые эффекты и премувы отключены.",
      key: "arrows",
      options: Object.freeze([
        Object.freeze({ value: "curved_neon", title: "Дуги", text: "Плавные стрелки, если устройство разрешает анимации." }),
        Object.freeze({ value: "sq_cyber_frame", title: "Рамки", text: "Контрастные клетки без сложной траектории." }),
        Object.freeze({ value: "sq_minimal_dots", title: "Точки", text: "Самый лёгкий визуальный режим." })
      ])
    })
  ]);

  let surveyAnswers = { mode: "legit", speed: "blitz", arrows: "curved_neon" };

  function openOnboardingSurveyModal(forceOpen = false) {
    if (!onboardingModal || document.visibilityState !== "visible") return;
    if (!forceOpen && initialStorage[calibrationKey]) return;
    surveyAnswers = { mode: "legit", speed: "blitz", arrows: "curved_neon" };

    const tag = hudShadow.getElementById("cc-survey-step-tag");
    const title = hudShadow.getElementById("cc-survey-q-title");
    const hint = hudShadow.getElementById("cc-survey-q-hint");
    const options = hudShadow.getElementById("cc-survey-opts-list");
    const renderStep = (index) => {
      const step = SURVEY_STEPS[index];
      tag.textContent = step.tag;
      title.textContent = step.question;
      hint.textContent = step.hint;
      options.replaceChildren();
      for (const option of step.options) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "cc-option";
        const strong = document.createElement("strong");
        strong.textContent = option.title;
        const description = document.createElement("span");
        description.textContent = option.text;
        button.append(strong, description);
        button.addEventListener("click", () => {
          vibrate(12);
          surveyAnswers[step.key] = option.value;
          if (index + 1 < SURVEY_STEPS.length) {
            renderStep(index + 1);
            options.querySelector("button")?.focus();
          } else {
            hideOverlay(onboardingModal);
            void applySmartPresetConfig(surveyAnswers);
          }
        }, { once: true });
        options.appendChild(button);
      }
    };
    renderStep(0);
    showOverlay(onboardingModal, options.querySelector("button"));
  }

  function maybeStartWelcomeSequence() {
    if (!storageReady || !rootSetupComplete || !hudShadow || welcomeSequenceStarted || document.visibilityState !== "visible") return;
    welcomeSequenceStarted = true;
    if (!initialStorage[calibrationKey]) {
      setPresetStatus("Выберите готовый профиль или откройте нужный раздел. Автоход включается отдельно.");
    }
  }

  function installHudDataSync(root) {
    const ids = [
      "cc-best-desc", "cc-best-eval", "cc-best-pv", "cc-enemy-turn-standby",
      "cc-tele-threats-val", "cc-tele-wdl-val", "cc-auto-master-chk"
    ];
    hudDataObserver?.disconnect();
    hudDataObserver = new MutationObserver(scheduleMiniHudUpdate);
    for (const id of ids) {
      const node = root.getElementById(id);
      if (node) hudDataObserver.observe(node, { childList: true, subtree: true, characterData: true, attributes: true });
    }
    listen(root, "change", scheduleMiniHudUpdate, true);
    listen(root, "input", scheduleMiniHudUpdate, true);
    scheduleMiniHudUpdate();
  }

  function scheduleMiniHudUpdate() {
    if (destroyed || document.visibilityState !== "visible" || miniUpdateRaf) return;
    miniUpdateRaf = requestAnimationFrame(() => {
      miniUpdateRaf = 0;
      updateMiniHud();
    });
  }

  function updateMiniHud() {
    if (!mainHudShadow || !hudShadow) return;
    const bestDesc = (mainHudShadow.getElementById("cc-best-desc")?.textContent || "").trim();
    const bestEval = (mainHudShadow.getElementById("cc-best-eval")?.textContent || "0.00").trim();
    const bestPv = (mainHudShadow.getElementById("cc-best-pv")?.textContent || "").trim();
    const standby = mainHudShadow.getElementById("cc-enemy-turn-standby");
    const threats = (mainHudShadow.getElementById("cc-tele-threats-val")?.textContent || "").trim();
    const wdl = (mainHudShadow.getElementById("cc-tele-wdl-val")?.textContent || "").trim();
    const autoOn = Boolean(mainHudShadow.getElementById("cc-auto-master-chk")?.checked);
    const enemyTurn = Boolean(standby && getComputedStyle(standby).display !== "none");
    const turn = hudShadow.getElementById("cc-mini-turn-txt");
    const dot = hudShadow.getElementById("cc-mini-dot");
    const move = hudShadow.getElementById("cc-mini-move-main");
    const evaluation = hudShadow.getElementById("cc-mini-eval-badge");
    const wdlPill = hudShadow.getElementById("cc-mini-wdl-pill");
    const reason = hudShadow.getElementById("cc-mini-tech-reason");
    const pv = hudShadow.getElementById("cc-mini-pv-line");
    const corner = hudShadow.getElementById("cc-corner-move-short");

    turn.textContent = enemyTurn ? "ХОД СОПЕРНИКА" : autoOn ? "НАШ ХОД · АВТО" : "НАШ ХОД";
    const dotColor = enemyTurn ? "#ffbe0b" : autoOn ? "#70e000" : "#00f5d4";
    dot.style.background = dotColor;
    dot.style.boxShadow = `0 0 8px ${dotColor}`;

    const wdlMatch = wdl.match(/Поб:\s*(\d+%)/i);
    if (wdlMatch) wdlPill.textContent = `W ${wdlMatch[1]}`;
    if (bestEval && bestEval !== "--") {
      evaluation.textContent = bestEval;
      evaluation.style.color = bestEval.startsWith("-") ? "#ff7bac" : "#00f5d4";
    }
    const moveMatch = bestDesc.match(/\b([a-h][1-8])\s*→\s*([a-h][1-8](?:=[QNBR])?)/i);
    if (moveMatch) {
      move.textContent = `${moveMatch[1]} → ${moveMatch[2]}`;
      corner.textContent = `${moveMatch[1]}→${moveMatch[2]}`;
    }
    if (enemyTurn) reason.textContent = threats || "Ожидание ответа соперника.";
    else if (bestDesc) reason.textContent = bestDesc.includes("—") ? bestDesc.slice(bestDesc.indexOf("—") + 1).trim() : bestDesc;
    pv.textContent = bestPv || `${deviceRecommendation.tier} · ${deviceRecommendation.maxElo} ELO`;
  }

  function disableAndroidUserScripts(root) {
    window.__CC_ANDROID_DISABLE_USER_SCRIPTS__ = true;
    disablePublicScriptApi();
    const disableUi = () => {
      const picker = root.getElementById("cc-script-file-picker");
      const add = root.getElementById("cc-add-script-file-btn");
      const reset = root.getElementById("cc-reset-script-files-btn");
      const status = root.getElementById("cc-script-loader-status");
      const unsupportedIds = [
        "cc-bg-file-input", "cc-upload-bg-btn",
        "cc-export-cfg-btn", "cc-import-cfg-btn", "cc-import-cfg-input",
        "cc-export-db", "cc-import-db", "cc-import-file-input"
      ];
      const unsupported = unsupportedIds.map(id => root.getElementById(id)).filter(Boolean);
      if (!picker && !add && !status && unsupported.length === 0) return false;
      for (const input of [picker, ...unsupported.filter(node => node.tagName === "INPUT")]) {
        if (!input) continue;
        input.disabled = true;
        input.value = "";
        input.setAttribute("aria-disabled", "true");
        if (input.dataset.ccAndroidDisabled !== "1") {
          input.dataset.ccAndroidDisabled = "1";
          listen(input, "change", (event) => {
            event.preventDefault();
            event.stopImmediatePropagation();
            input.value = "";
          }, true);
        }
      }
      for (const button of [add, reset, ...unsupported.filter(node => node.tagName === "BUTTON")]) {
        if (!button) continue;
        button.disabled = true;
        button.setAttribute("aria-disabled", "true");
        button.title = "Недоступно в защищённой Android-сборке";
        button.style.opacity = "0.55";
        if (button.dataset.ccAndroidDisabled !== "1") {
          button.dataset.ccAndroidDisabled = "1";
          listen(button, "click", event => {
            event.preventDefault();
            event.stopImmediatePropagation();
          }, true);
        }
      }
      if (status) {
        status.textContent = "ОТКЛЮЧЕНО НА ANDROID";
        status.style.color = "#ffbe0b";
      }
      return true;
    };
    if (disableUi()) return;
    scriptsObserver?.disconnect();
    scriptsObserver = new MutationObserver(() => {
      if (disableUi()) {
        scriptsObserver?.disconnect();
        scriptsObserver = null;
      }
    });
    scriptsObserver.observe(root, { childList: true, subtree: true });
    schedule(() => {
      scriptsObserver?.disconnect();
      scriptsObserver = null;
    }, 12000);
  }

  function setOverlayPassthrough(enabled) {
    overlayPassthrough = Boolean(enabled && document.visibilityState === "visible" && !isOverlayOpen(onboardingModal) && !isOverlayOpen(autoConfirmModal) && !isOverlayOpen(welcomeSplash));
    miniHudCard?.classList.toggle("cc-passthrough", overlayPassthrough);
    cornerPill?.classList.toggle("cc-passthrough", overlayPassthrough);
    mainPanel?.classList.toggle("cc-core-executing", overlayPassthrough);
  }

  function handleCoreExecutionState(event) {
    const detail = event?.detail;
    if (!detail || detail.source !== "chesscoach-core" || typeof detail.executing !== "boolean") return;
    const canPassThrough = detail.allowOverlayPassthrough === true && !isOverlayOpen(onboardingModal) && !isOverlayOpen(autoConfirmModal) && !isOverlayOpen(welcomeSplash);
    if (detail.executing && canPassThrough && uiViewMode === "full") {
      setUiViewMode(lastInGameSubMode);
    }
    setOverlayPassthrough(detail.executing && detail.allowOverlayPassthrough === true);
  }

  function suspendAutomation(reason) {
    pendingAutomation = null;
    setOverlayPassthrough(false);
    window.dispatchEvent(new CustomEvent("cc-mobile-lifecycle", {
      detail: { state: reason, cancelPendingMoves: true }
    }));
  }

  function handleVisibilityChange() {
    if (document.visibilityState !== "visible") {
      suspendAutomation("hidden");
      clearScheduledWork();
      stopHudDiscovery();
      scriptsObserver?.disconnect();
      scriptsObserver = null;
      welcomeSequenceStarted = false;
      hideOverlay(welcomeSplash);
      hideOverlay(onboardingModal);
      hideOverlay(autoConfirmModal);
      syncVisibilityStates();
      return;
    }
    startHudDiscovery();
    fitSettingsViewport();
    syncVisibilityStates();
    clampMiniHud(false);
    scheduleMiniHudUpdate();
    if (rootSetupComplete && mainHudShadow) disableAndroidUserScripts(mainHudShadow);
    maybeStartWelcomeSequence();
  }

  function handleAndroidBack() {
    if (isOverlayOpen(autoConfirmModal)) {
      pendingAutomation = null;
      hideOverlay(autoConfirmModal);
      return true;
    }
    if (isOverlayOpen(onboardingModal)) {
      hideOverlay(onboardingModal);
      return true;
    }
    if (isOverlayOpen(welcomeSplash)) {
      welcomeDismissedByBack = true;
      hideOverlay(welcomeSplash);
      return true;
    }
    if (uiViewMode === "full") {
      setUiViewMode(lastInGameSubMode);
      return true;
    }
    return false;
  }

  window.__ccHandleAndroidBack = handleAndroidBack;

  function removeInjectedSettingsUi() {
    if (!mainHudShadow) return;
    const modeBar = mainHudShadow.getElementById("cc-mode-switcher-bar");
    const workspace = mainHudShadow.getElementById("chesscoach-workspace");
    if (modeBar && workspace) workspace.before(modeBar);
    mainHudShadow.getElementById("cc-mobile-launcher-bar")?.remove();
    mainHudShadow.getElementById("cc-pane-presets")?.remove();
    mainHudShadow.getElementById("cc-pane-more")?.remove();
    mainHudShadow.querySelector('.cc-tab-btn[data-tab="presets"]')?.remove();
    mainHudShadow.querySelector('.cc-tab-btn[data-tab="more"]')?.remove();
    mainHudShadow.querySelectorAll(".cc-mobile-extra-tab").forEach((tab) => tab.classList.remove("cc-mobile-extra-tab"));
    mainHudShadow.getElementById("cc-mobile-override-style")?.remove();
    if (mainPanel) {
      mainPanel.classList.remove("cc-mobile-hidden", "cc-core-executing", "cc-device-low", "cc-device-balanced", "cc-device-high", "cc-mobile-reduced-motion");
      delete mainPanel.dataset.ccMobileLauncher;
    }
  }

  function cleanup(reason = "cleanup") {
    if (destroyed) return true;
    destroyed = true;
    suspendAutomation(reason);
    clearScheduledWork();
    stopHudDiscovery();
    hudDataObserver?.disconnect();
    scriptsObserver?.disconnect();
    hudDataObserver = null;
    scriptsObserver = null;
    for (const removeListener of listenerCleanups.splice(0)) removeListener();
    removeInjectedSettingsUi();
    window.__CC_ANDROID_SETTINGS_OPEN__ = false;
    if (window.__CC_ANDROID_HUD_ROOT__ && !window.__CC_ANDROID_HUD_ROOT__.host?.isConnected) {
      delete window.__CC_ANDROID_HUD_ROOT__;
    }
    hudHost?.remove();
    hudHost = null;
    hudShadow = null;
    if (window.__ccHandleAndroidBack === handleAndroidBack) {
      try { delete window.__ccHandleAndroidBack; } catch (e) { window.__ccHandleAndroidBack = null; }
    }
    if (window.__ChessCoachRegisterHudShadow === mobileHudRegistrar) {
      window.__ChessCoachRegisterHudShadow = previousHudRegistrar;
    }
    if (window[INSTANCE_KEY]?.cleanup === cleanup) {
      try { delete window[INSTANCE_KEY]; } catch (e) { window[INSTANCE_KEY] = null; }
    }
    window.__ccMobileLauncherOrbInitialized = false;
    return true;
  }

  function disablePublicScriptApi() {
    if (window.CC && typeof window.CC.loadScriptFile === "function") {
      window.CC.loadScriptFile = async () => false;
    }
  }

  createFloatingHud();
  if (typeof queueMicrotask === "function") queueMicrotask(disablePublicScriptApi);
  else Promise.resolve().then(disablePublicScriptApi);
  schedule(disablePublicScriptApi, 0);
  startHudDiscovery();
  listen(document, "visibilitychange", handleVisibilityChange);
  listen(window, "pagehide", event => {
    if (!event.persisted) cleanup("pagehide");
    else { suspendAutomation("pagehide"); clearScheduledWork(); stopHudDiscovery(); }
  });
  listen(window, "pageshow", event => { if (event.persisted) handleVisibilityChange(); });
  listen(window, "orientationchange", () => { fitSettingsViewport(); clampMiniHud(true); });
  listen(window, "resize", () => { fitSettingsViewport(); clampMiniHud(false); });
  listen(window.visualViewport, "resize", () => { fitSettingsViewport(); clampMiniHud(false); });
  listen(window.visualViewport, "scroll", () => { fitSettingsViewport(); clampMiniHud(false); });
  listen(window, "cc-core-state", handleCoreExecutionState);
  listen(window, "cc:core-state", handleCoreExecutionState);
  listen(window, "cc-device-profile-ready", () => {
    deviceRecommendation = readDeviceRecommendation();
    applyDeviceClasses();
    enforceLowTierRestrictions();
  });

  void loadInitialStorage().then(() => {
    if (destroyed) return;
    applySavedMiniPosition();
    syncVisibilityStates();
    if (rootSetupComplete && mainHudShadow) activateMobileTab(mainHudShadow, initialStorage.cc_mobile_settings_tab || "presets");
    if (rootSetupComplete && deviceRecommendation.tier === "LOW") enforceLowTierRestrictions();
    maybeStartWelcomeSequence();
  }).catch(error => setPresetStatus("Настройки не восстановлены: " + compactText(error?.message, 120), "#ff7b9f"));
})();
