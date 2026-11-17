(function () {
  "use strict";

  const runtime = window.__CC_ANDROID_RUNTIME__;
  if (!runtime || window.__CC_ANDROID_GAME_SESSION__) return;
  const preferences = window.__CC_MOBILE_PREFERENCES__;
  const platform = /(^|\.)chess\.com$/i.test(location.hostname) ? "chesscom" : "lichess";
  const boardIds = new WeakMap();
  const targetIds = new WeakMap();
  const targets = new Map();
  const listeners = new Set();
  let nextBoardId = 0;
  let nextTargetId = 0;
  let epoch = 0;
  let hydrated = false;
  let suspended = document.hidden === true;
  let core = null;
  let current = null;
  let analysis = null;
  let lastError = null;
  let lastLifecycleState = "";
  let thermalPaused = false;

  function effective() {
    const settings = preferences?.getEffective(platform) || { ready: false, paused: true };
    const power = runtime.profile?.power || {};
    const low = settings.lowTier || power.saveMode || power.backgroundRestricted || Number(power.thermalStatus) >= 2;
    const thermalPause = Number(power.thermalStatus) >= 3;
    const paused = !hydrated || suspended || document.hidden || runtime.disposed || window.__CC_ANDROID_SETTINGS_OPEN__ === true;
    const result = { ...settings, ready: hydrated && Boolean(core), paused, lowTier: Boolean(low) };
    if (paused || thermalPause) result.autoMoveEnabled = false;
    if (paused || thermalPause) {
      result.bulletTurboMode = false;
      result.premoveEnabled = false;
      result.showPremoveArrows = false;
    }
    if (low) {
      result.mobileAnimations = false;
      result.mobileVisualEffects = false;
      result.phonkEditEnabled = false;
      result.audioRadarEnabled = false;
      result.heatmapAlwaysOn = false;
    }
    return { ...result, thermalPause };
  }

  function boardId(element) {
    if (!element) return "";
    if (!boardIds.has(element)) boardIds.set(element, `board-${++nextBoardId}`);
    return boardIds.get(element);
  }

  function snapshot() {
    const settings = effective();
    const view = core?.viewState?.() || {};
    const visual = window.visualViewport;
    return Object.freeze({
      v: 1, platform, epoch, ready: settings.ready, paused: settings.paused,
      foreground: !suspended && !document.hidden, lowTier: settings.lowTier,
      boardId: current?.boardId || "", positionKey: current?.positionKey || "",
      positionId: current?.positionId ?? null, orientation: current?.orientation || null,
      myColor: current?.myColor || null, turn: current?.turn || null,
      boardRect: current?.boardRect ? Object.freeze({ ...current.boardRect }) : null, analysis: analysis?.phase || "idle",
      viewport: Object.freeze({ width: visual?.width ?? window.innerWidth, height: visual?.height ?? window.innerHeight,
        offsetLeft: visual?.offsetLeft || 0, offsetTop: visual?.offsetTop || 0 }),
      documentToken: runtime.inputDocumentToken, documentNonce: runtime.inputDocumentNonce,
      pendingInput: Boolean(view.executing), lastError, ...view
    });
  }

  function publish() {
    const value = snapshot();
    for (const listener of [...listeners]) {
      try { listener(value); } catch (e) {}
    }
    window.dispatchEvent(new CustomEvent("cc-game-session-state", { detail: value }));
  }

  function invalidate(reason = "invalidated") {
    epoch++;
    if (analysis?.phase === "pending") analysis.controller.abort();
    analysis = null;
    core?.cancelSearch?.(reason);
  }

  function rectValue(rect) {
    if (!rect || ![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return null;
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }

  function observe(state, configKey) {
    if (!state?.positionKey || state.animating || !state.boardElement) return;
    const id = boardId(state.boardElement);
    const key = `${location.pathname}|${id}|${state.positionKey}|${state.boardKey}|${configKey}`;
    if (current?.key !== key) invalidate("position-or-config");
    current = {
      key, boardId: id, positionKey: state.positionKey, positionId: state.positionId,
      orientation: state.isBlackOrientation ? "black" : "white", myColor: state.myColor,
      turn: state.actualTurn, boardRect: rectValue(state.boardRect), configKey
    };
    publish();
  }

  function hasAnalysis(positionKey, configKey) {
    return Boolean(analysis && current?.positionKey === positionKey && current.configKey === configKey);
  }

  function beginAnalysis(state, configKey) {
    observe(state, configKey);
    const settings = effective();
    if (!settings.ready || settings.thermalPause || suspended || document.hidden || runtime.disposed || !current || analysis) return null;
    const lease = { epoch, key: current.key, phase: "pending", controller: new AbortController() };
    analysis = lease;
    lastError = null;
    publish();
    return lease;
  }

  function finishAnalysis(lease, phase = "complete") {
    if (analysis !== lease || lease.epoch !== epoch || lease.phase !== "pending") return;
    lease.phase = phase;
    publish();
  }

  function retryAnalysis() {
    if (analysis?.phase === "pending") analysis.controller.abort();
    analysis = null;
  }

  function canAnalyze(state, forced = false) {
    const settings = effective();
    if (!settings.ready || settings.thermalPause || suspended || document.hidden || runtime.disposed) return false;
    if (window.__CC_ANDROID_SETTINGS_OPEN__ === true && !settings.showArrows && !settings.showEvalBar) return false;
    return forced || settings.turnMode !== "my" || state.actualTurn === state.myColor;
  }

  function registerTarget(element) {
    if (!element?.isConnected) throw new Error("Input target is detached");
    if (!targetIds.has(element)) targetIds.set(element, `target-${++nextTargetId}`);
    const id = targetIds.get(element);
    targets.delete(id);
    targets.set(id, element);
    while (targets.size > 64) targets.delete(targets.keys().next().value);
    return id;
  }

  function captureInputSnapshot({ points, targetId } = {}) {
    if (!effective().ready || suspended || document.hidden || runtime.disposed) return null;
    const target = targets.get(targetId);
    const state = core?.captureState?.();
    if (!target?.isConnected || !state?.positionKey || !state.boardElement?.isConnected) return null;
    const boardRect = rectValue(state.boardRect);
    const targetRect = target === state.boardElement ? boardRect : rectValue(target.getBoundingClientRect());
    if (!boardRect || !targetRect || !Array.isArray(points) || !points.length) return null;
    const hit = points.every(point => {
      if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return false;
      let node = document.elementFromPoint(point.x, point.y);
      const seen = new Set();
      while (node?.shadowRoot?.elementFromPoint && !seen.has(node)) {
        seen.add(node);
        const inner = node.shadowRoot.elementFromPoint(point.x, point.y);
        if (!inner || inner === node) break;
        node = inner;
      }
      for (; node; node = node.parentElement || node.getRootNode?.()?.host) if (node === target) return true;
      return false;
    });
    return {
      v: 1, boardId: boardId(state.boardElement), positionKey: state.positionKey,
      orientation: state.isBlackOrientation ? "black" : "white", myColor: state.myColor,
      turn: state.actualTurn, boardRect, targetId, targetRect, hit,
      animating: Boolean(state.animating || core.isAnimating?.(state.boardElement))
    };
  }

  function applyVisualPolicy(root) {
    if (!root) return;
    let style = root.getElementById("cc-mobile-motion-policy");
    if (!style) {
      style = document.createElement("style");
      style.id = "cc-mobile-motion-policy";
      root.appendChild(style);
    }
    const settings = effective();
    const enabled = settings.mobileAnimations === true && runtime.profile?.recommendation?.animations !== false && !settings.lowTier;
    const css = enabled ? "" : "#chesscoach-screen-svg, #chesscoach-screen-svg *, #chesscoach-live-eval, #chesscoach-live-eval * { animation: none !important; transition: none !important; }";
    if (style.textContent !== css) style.textContent = css;
  }

  function suspend(reason) {
    if (lastLifecycleState === reason) return;
    lastLifecycleState = reason;
    if (reason !== "settings") suspended = true;
    const settings = effective();
    const releaseSearch = reason !== "settings" || (!settings.showArrows && !settings.showEvalBar);
    if (releaseSearch) invalidate(reason);
    core?.suspend?.(reason, releaseSearch);
    publish();
  }

  function revive() {
    if (runtime.disposed || document.hidden) return;
    const wasSuspended = suspended;
    suspended = false;
    lastLifecycleState = "active";
    if (wasSuspended) invalidate("resume");
    core?.resume?.();
    publish();
  }

  document.addEventListener("visibilitychange", () => document.hidden ? suspend("hidden") : revive());
  window.addEventListener("pagehide", () => suspend("pagehide"));
  window.addEventListener("pageshow", revive);
  window.addEventListener("cc-mobile-lifecycle", event => {
    if (event.detail?.state === "active") revive();
    else if (event.detail?.cancelPendingMoves || event.detail?.state === "settings") suspend(event.detail.state || "paused");
  });
  function refreshProfile() {
    const blocked = effective().thermalPause;
    if (blocked && !thermalPaused) {
      thermalPaused = true;
      invalidate("thermal");
      core?.suspend?.("thermal", true);
    } else if (!blocked && thermalPaused) {
      thermalPaused = false;
      core?.resume?.();
    }
    core?.refreshVisuals?.();
    publish();
  }
  window.addEventListener("cc-device-profile-ready", refreshProfile);
  runtime.nativeEvents?.addListener(event => {
    if (event?.name === "profile.update") refreshProfile();
    if (event?.name === "engine.ready" && analysis?.phase === "failed" && !suspended && !document.hidden) {
      retryAnalysis();
      core?.resume?.();
    }
  });

  const ready = Promise.all([runtime.ready, preferences?.ready]).then(() => {
    hydrated = Boolean(preferences?.isReady);
    return hydrated;
  });
  ready.catch(error => { lastError = String(error?.message || error); publish(); });
  const api = Object.freeze({
    version: 1, ready, effective, observe, beginAnalysis, finishAnalysis, retryAnalysis,
    hasAnalysis, canAnalyze, invalidate, registerTarget, captureInputSnapshot, applyVisualPolicy, revive,
    get epoch() { return epoch; },
    get isReady() { return hydrated && Boolean(core); },
    registerCore(site, adapter) {
      if (site !== platform || !hydrated || typeof adapter?.captureState !== "function") throw new Error("Core must register after preferences hydrate");
      if (core && core !== adapter) core.suspend?.("replaced", true);
      core = adapter;
      const unregisterInput = runtime.registerInputSnapshotProvider(captureInputSnapshot);
      publish();
      return () => {
        if (core !== adapter) return;
        invalidate("shutdown");
        core = null;
        targets.clear();
        if (typeof unregisterInput === "function") unregisterInput();
      };
    },
    snapshot,
    diagnostics: () => snapshot(),
    reportError(error) { lastError = String(error?.code || error?.message || error); publish(); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  });
  Object.defineProperty(window, "__CC_ANDROID_GAME_SESSION__", { value: api, configurable: false, writable: false });
})();
