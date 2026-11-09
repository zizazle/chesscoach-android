(function () {
  if (window.__ccMobileLauncherOrbInitialized) return;
  window.__ccMobileLauncherOrbInitialized = true;

  let mainHudShadow = null;
  let mainHudHost = null;
  let isSettingsHubOpen = false;
  const currentPlatform = location.hostname.includes("chess.com") ? "chesscom" : "lichess";

  // Читаем оригинальный content.css напрямую из памяти APK (100% обход блокировки CSP на Lichess/Chess.com)
  let rawContentCss = "";
  try {
    if (window.CCAndroidBridge && typeof window.CCAndroidBridge.readAssetText === "function") {
      rawContentCss = window.CCAndroidBridge.readAssetText("content/content.css") || "";
    }
  } catch (e) {}

  // Мобильная адаптация поверх content.css, чтобы окно настроек идеально ложилось на экран телефона
  const mobileOverrideCss = `
    #chesscoach-panel {
      position: fixed !important;
      top: 0 !important;
      left: 0 !important;
      right: 0 !important;
      bottom: 0 !important;
      width: 100vw !important;
      height: 100dvh !important;
      min-height: 100dvh !important;
      max-height: 100dvh !important;
      border-radius: 0 !important;
      border: none !important;
      margin: 0 !important;
      display: flex !important;
      flex-direction: column !important;
      overflow: hidden !important;
      z-index: 2147483646 !important;
      touch-action: pan-y !important;
    }
    #cc-neural-canvas, #cc-custom-bg-layer, #cc-custom-bg-dim {
      position: absolute !important;
      top: 0 !important;
      left: 0 !important;
      width: 100% !important;
      height: 100% !important;
      pointer-events: none !important;
      z-index: 0 !important;
    }
    #chesscoach-header {
      position: relative !important;
      z-index: 4 !important;
      height: 46px !important;
      padding: 0 12px !important;
      flex-shrink: 0 !important;
    }
    #cc-mobile-launcher-bar {
      position: relative !important;
      z-index: 4 !important;
      padding: 10px 12px !important;
      background: rgba(6, 9, 16, 0.94) !important;
      border-bottom: 1px solid rgba(0, 245, 212, 0.25) !important;
      display: flex !important;
      flex-direction: column !important;
      gap: 8px !important;
      flex-shrink: 0 !important;
    }
    .cc-launcher-title {
      font-size: 10px !important;
      font-weight: 900 !important;
      color: #94a3b8 !important;
      letter-spacing: 0.6px !important;
      text-transform: uppercase !important;
    }
    .cc-launcher-cards-row {
      display: grid !important;
      grid-template-columns: 1fr 1fr !important;
      gap: 8px !important;
    }
    .cc-platform-card {
      background: rgba(255, 255, 255, 0.06) !important;
      border: 1.5px solid rgba(255, 255, 255, 0.14) !important;
      border-radius: 12px !important;
      padding: 9px 10px !important;
      color: #cbd5e1 !important;
      cursor: pointer !important;
      display: flex !important;
      flex-direction: column !important;
      gap: 3px !important;
      text-align: left !important;
    }
    .cc-platform-card.active-lichess {
      background: linear-gradient(135deg, rgba(0, 245, 212, 0.25), rgba(0, 187, 249, 0.12)) !important;
      border-color: #00f5d4 !important;
      color: #ffffff !important;
      box-shadow: 0 0 16px rgba(0, 245, 212, 0.25) !important;
    }
    .cc-platform-card.active-chesscom {
      background: linear-gradient(135deg, rgba(56, 176, 0, 0.28), rgba(0, 245, 212, 0.12)) !important;
      border-color: #38b000 !important;
      color: #ffffff !important;
      box-shadow: 0 0 16px rgba(56, 176, 0, 0.25) !important;
    }
    .cc-platform-card-title {
      font-size: 11.5px !important;
      font-weight: 900 !important;
      display: flex !important;
      justify-content: space-between !important;
      align-items: center !important;
    }
    .cc-platform-card-sub {
      font-size: 9.5px !important;
      color: #94a3b8 !important;
      font-weight: 700 !important;
    }
    #cc-return-to-game-btn {
      width: 100% !important;
      padding: 11px 14px !important;
      border-radius: 11px !important;
      border: none !important;
      background: linear-gradient(135deg, #00f5d4, #00bbf9) !important;
      color: #04070e !important;
      font-size: 12px !important;
      font-weight: 900 !important;
      letter-spacing: 0.4px !important;
      cursor: pointer !important;
      box-shadow: 0 4px 15px rgba(0, 245, 212, 0.35) !important;
    }
    #cc-mode-switcher-bar {
      position: relative !important;
      z-index: 4 !important;
      padding: 7px 12px !important;
      flex-shrink: 0 !important;
    }
    #chesscoach-workspace {
      position: relative !important;
      z-index: 3 !important;
      display: flex !important;
      flex-direction: column !important;
      grid-template-columns: none !important;
      flex: 1 !important;
      min-height: 0 !important;
      overflow: hidden !important;
    }
    .cc-sidebar {
      width: 100% !important;
      border-right: none !important;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1) !important;
      padding: 6px 10px !important;
      background: rgba(5, 7, 13, 0.9) !important;
      flex-shrink: 0 !important;
    }
    .cc-nav-list {
      display: flex !important;
      flex-direction: row !important;
      overflow-x: auto !important;
      gap: 6px !important;
      scrollbar-width: none !important;
    }
    .cc-nav-list::-webkit-scrollbar {
      display: none !important;
    }
    .cc-tab-btn {
      white-space: nowrap !important;
      padding: 8px 12px !important;
      font-size: 11px !important;
      flex-shrink: 0 !important;
    }
    .cc-sidebar-footer {
      display: none !important;
    }
    .cc-main-view {
      flex: 1 !important;
      min-height: 0 !important;
      overflow-y: auto !important;
      padding: 12px !important;
      padding-bottom: 32px !important;
      -webkit-overflow-scrolling: touch !important;
    }
  `;

  function vibrate(ms = 12) {
    try {
      if (window.CCAndroidBridge && typeof window.CCAndroidBridge.vibrateTick === "function") {
        window.CCAndroidBridge.vibrateTick(ms);
      }
    } catch (e) {}
  }

  /**
   * Блокирует проваливание любых кликов и тапов сквозь элемент на шахматную доску под ним
   */
  function shieldElementFromSiteClicks(el) {
    if (!el) return;
    const stopAll = (e) => {
      e.stopPropagation();
    };
    ["touchstart", "touchmove", "touchend", "mousedown", "mousemove", "mouseup", "pointerdown", "pointerup", "click", "contextmenu"].forEach((ev) => {
      el.addEventListener(ev, stopAll, false);
    });
  }

  // Перехватываем создание закрытого ShadowRoot главного меню ДО того, как content.js/chesscom.js отрисует панель
  const origAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    const sr = origAttachShadow.call(this, init);
    if (this.id !== "cc-userscripts-host" && this.id !== "cc-floating-orb-host") {
      mainHudShadow = sr;
      mainHudHost = this;

      // 1. Сразу вшиваем полный content.css + мобильную верстку внутрь ShadowRoot
      const styleEl = document.createElement("style");
      styleEl.id = "cc-inline-master-css";
      styleEl.textContent = rawContentCss + "\n" + mobileOverrideCss;
      sr.appendChild(styleEl);

      // 2. Блокируем проваливание касаний сквозь открытое меню настроек на сайт под ним
      shieldElementFromSiteClicks(this);

      // 3. Как только content.js добавит #chesscoach-panel в ShadowRoot — встраиваем шапку выбора платформы
      const obs = new MutationObserver(() => {
        const panel = sr.getElementById("chesscoach-panel");
        if (panel && !sr.getElementById("cc-mobile-launcher-bar")) {
          injectPlatformSelectorIntoPanel(sr, panel);
        }
      });
      obs.observe(sr, { childList: true });
    }
    return sr;
  };

  function injectPlatformSelectorIntoPanel(sr, panel) {
    shieldElementFromSiteClicks(panel);

    const isChessCom = currentPlatform === "chesscom";
    const launcherBar = document.createElement("div");
    launcherBar.id = "cc-mobile-launcher-bar";
    launcherBar.innerHTML = `
      <div class="cc-launcher-title">🌐 ВЫБОР ПЛАТФОРМЫ (ОТКРЫВАЕТСЯ МГНОВЕННО):</div>
      <div class="cc-launcher-cards-row">
        <button type="button" class="cc-platform-card ${!isChessCom ? "active-lichess" : ""}" id="cc-select-lichess-btn">
          <div class="cc-platform-card-title">
            <span>♟️ LICHESS.ORG</span>
            <span style="font-size:9px; color:${!isChessCom ? "#00f5d4" : "#64748b"};">${!isChessCom ? "● ОТКРЫТ" : "ПЕРЕЙТИ"}</span>
          </div>
          <div class="cc-platform-card-sub">⚡ HvH Резня • Премувы • Legit</div>
        </button>

        <button type="button" class="cc-platform-card ${isChessCom ? "active-chesscom" : ""}" id="cc-select-chesscom-btn">
          <div class="cc-platform-card-title">
            <span>🛡️ CHESS.COM</span>
            <span style="font-size:9px; color:${isChessCom ? "#70e000" : "#64748b"};">${isChessCom ? "● ОТКРЫТ" : "ПЕРЕЙТИ"}</span>
          </div>
          <div class="cc-platform-card-sub">🎯 Безье • T1% Лимитер • Стелс</div>
        </button>
      </div>
      <button type="button" id="cc-return-to-game-btn">
        🎮 ПЕРЕЙТИ К ДОСКЕ ${isChessCom ? "CHESS.COM" : "LICHESS.ORG"} (СВЕРНУТЬ НАСТРОЙКИ)
      </button>
    `;

    const modeBar = sr.getElementById("cc-mode-switcher-bar");
    if (modeBar) {
      panel.insertBefore(launcherBar, modeBar);
    } else {
      panel.prepend(launcherBar);
    }

    const headerMinBtn = sr.getElementById("cc-toggle-btn");
    if (headerMinBtn) {
      headerMinBtn.textContent = "✕ ЗАКРЫТЬ";
      headerMinBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        vibrate(12);
        setSettingsHubVisible(false);
      }, true);
    }

    sr.getElementById("cc-return-to-game-btn")?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      vibrate(15);
      setSettingsHubVisible(false);
    });

    sr.getElementById("cc-select-lichess-btn")?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      vibrate(20);
      if (window.chrome && window.chrome.storage) {
        window.chrome.storage.local.set({ cc_mobile_platform: "lichess" });
      }
      if (!location.hostname.includes("lichess.org")) {
        if (window.CCAndroidBridge && typeof window.CCAndroidBridge.switchPlatformUrl === "function") {
          window.CCAndroidBridge.switchPlatformUrl("https://lichess.org/");
        } else {
          location.href = "https://lichess.org/";
        }
      } else {
        setSettingsHubVisible(false);
      }
    });

    sr.getElementById("cc-select-chesscom-btn")?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      vibrate(20);
      if (window.chrome && window.chrome.storage) {
        window.chrome.storage.local.set({ cc_mobile_platform: "chesscom" });
      }
      if (!location.hostname.includes("chess.com")) {
        if (window.CCAndroidBridge && typeof window.CCAndroidBridge.switchPlatformUrl === "function") {
          window.CCAndroidBridge.switchPlatformUrl("https://www.chess.com/play/online");
        } else {
          location.href = "https://www.chess.com/play/online";
        }
      } else {
        setSettingsHubVisible(false);
      }
    });

    // Если открыта главная страница — показываем Настройки, если уже идет партия — сворачиваем в кнопку в углу
    const isPlayingNow =
      location.pathname.length > 4 &&
      !location.pathname.endsWith("/online") &&
      location.pathname !== "/";
    setSettingsHubVisible(!isPlayingNow);
  }

  // СОЗДАНИЕ УГЛОВОЙ ПОЛУПРОЗРАЧНОЙ КНОПКИ (FLOATING CORNER ORB)
  const orbHost = document.createElement("div");
  orbHost.id = "cc-floating-orb-host";
  orbHost.style.cssText = "all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647; pointer-events: none;";
  document.documentElement.appendChild(orbHost);
  const orbShadow = origAttachShadow.call(orbHost, { mode: "open" });

  const orbWrapper = document.createElement("div");
  orbWrapper.id = "cc-orb-wrapper";
  orbShadow.innerHTML = `
    <style>
      #cc-orb-wrapper {
        position: fixed;
        top: 64px;
        right: 12px;
        display: flex;
        align-items: center;
        gap: 6px;
        pointer-events: auto;
        touch-action: none;
        user-select: none;
        -webkit-user-select: none;
        z-index: 2147483647;
        opacity: 0.78;
        transition: opacity 0.25s ease, transform 0.15s ease;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", Roboto, sans-serif;
      }
      #cc-orb-wrapper.cc-idle {
        opacity: 0.45;
      }
      #cc-orb-main-btn {
        min-width: 72px;
        height: 48px;
        padding: 5px 11px;
        border-radius: 15px;
        background: rgba(10, 14, 24, 0.85);
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
        border: 1.5px solid #00f5d4;
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.75), 0 0 12px rgba(0, 245, 212, 0.35);
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        color: #fff;
        cursor: pointer;
      }
      #cc-orb-main-btn.cc-auto-active {
        border-color: #38b000;
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.75), 0 0 14px rgba(56, 176, 0, 0.45);
      }
      .cc-orb-top {
        font-size: 9.5px;
        font-weight: 900;
        color: #00f5d4;
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .cc-orb-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #00f5d4;
      }
      #cc-orb-move-txt {
        font-family: monospace;
        font-size: 11px;
        font-weight: 900;
        color: #ffffff;
        margin-top: 1px;
      }
      #cc-orb-quick-x-btn {
        width: 44px;
        height: 48px;
        border-radius: 14px;
        background: rgba(0, 245, 212, 0.22);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border: 1.5px solid #00f5d4;
        color: #00f5d4;
        font-size: 13px;
        font-weight: 900;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.7);
        cursor: pointer;
      }
      #cc-orb-quick-x-btn small {
        font-size: 8.5px;
        color: #fff;
        font-family: monospace;
      }
    </style>
    <div id="cc-orb-quick-x-btn" title="Сделать одиночный ход [X]">
      <span>⚡</span>
      <small>ХОД</small>
    </div>
    <div id="cc-orb-main-btn" title="Открыть настройки ChessCoach">
      <div class="cc-orb-top">
        <span class="cc-orb-dot" id="cc-orb-dot"></span>
        <span id="cc-orb-label">НАСТРОЙКИ</span>
      </div>
      <div id="cc-orb-move-txt">♟️ МЕНЮ</div>
    </div>
  `;
  orbShadow.appendChild(orbWrapper);

  const orbMainBtn = orbShadow.getElementById("cc-orb-main-btn");
  const orbQuickXBtn = orbShadow.getElementById("cc-orb-quick-x-btn");
  const orbLabel = orbShadow.getElementById("cc-orb-label");
  const orbMoveTxt = orbShadow.getElementById("cc-orb-move-txt");
  const orbDot = orbShadow.getElementById("cc-orb-dot");

  let idleTimer = null;
  function wakeOrb() {
    orbWrapper.classList.remove("cc-idle");
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!isSettingsHubOpen) orbWrapper.classList.add("cc-idle");
    }, 3000);
  }

  // ЖЕСТКАЯ ЗАЩИТА УГЛОВОЙ КНОПКИ: ни одно касание или клик НЕ проходит на сайт Lichess / Chess.com!
  ["mousedown", "mousemove", "mouseup", "pointerdown", "pointermove", "pointerup", "click", "dblclick", "contextmenu"].forEach((evName) => {
    orbWrapper.addEventListener(evName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    }, { passive: false, capture: true });
  });

  // Перетаскивание кнопки пальцем и обработка нажатия без проваливания клика на доску
  let startX = 0;
  let startY = 0;
  let initLeft = 0;
  let initTop = 0;
  let moved = false;

  orbMainBtn.addEventListener("touchstart", (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    wakeOrb();
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;
    const r = orbWrapper.getBoundingClientRect();
    initLeft = r.left;
    initTop = r.top;
    moved = false;
  }, { passive: false });

  orbMainBtn.addEventListener("touchmove", (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    if (Math.hypot(dx, dy) > 10) {
      moved = true;
      const nx = Math.max(6, Math.min(window.innerWidth - 130, initLeft + dx));
      const ny = Math.max(12, Math.min(window.innerHeight - 64, initTop + dy));
      orbWrapper.style.left = nx + "px";
      orbWrapper.style.top = ny + "px";
      orbWrapper.style.right = "auto";
    }
  }, { passive: false });

  orbMainBtn.addEventListener("touchend", (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (!moved) {
      vibrate(14);
      setSettingsHubVisible(!isSettingsHubOpen);
    } else {
      const r = orbWrapper.getBoundingClientRect();
      if (r.left + r.width / 2 < window.innerWidth / 2) {
        orbWrapper.style.left = "10px";
        orbWrapper.style.right = "auto";
      } else {
        orbWrapper.style.right = "10px";
        orbWrapper.style.left = "auto";
      }
    }
    wakeOrb();
  }, { passive: false });

  // Обработка нажатия на кнопку быстрого хода ⚡ ХОД (также без проваливания на сайт)
  orbQuickXBtn.addEventListener("touchstart", (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    wakeOrb();
  }, { passive: false });

  orbQuickXBtn.addEventListener("touchend", (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    vibrate(18);
    if (mainHudShadow) {
      const playOnceBtn = mainHudShadow.getElementById("cc-play-once");
      if (playOnceBtn) playOnceBtn.click();
    }
  }, { passive: false });

  function setSettingsHubVisible(visible) {
    if (!mainHudShadow) return;
    const panel = mainHudShadow.getElementById("chesscoach-panel");
    if (!panel) return;

    isSettingsHubOpen = Boolean(visible);

    if (isSettingsHubOpen) {
      panel.classList.remove("cc-minimized");
      const workspace = mainHudShadow.getElementById("chesscoach-workspace");
      const modeBar = mainHudShadow.getElementById("cc-mode-switcher-bar");
      if (workspace) workspace.style.display = "flex";
      if (modeBar) modeBar.style.display = "grid";
      panel.style.display = "flex";

      // Скрываем плавающую кнопку, пока открыто полноэкранное меню настроек
      orbWrapper.style.display = "none";
    } else {
      panel.style.display = "none";
      orbWrapper.style.display = "flex";
      wakeOrb();
    }
  }

  window.__ccHandleAndroidBack = function () {
    if (isSettingsHubOpen) {
      setSettingsHubVisible(false);
      return true;
    }
    return false;
  };

  // Обновление подсказки лучшего хода на угловой кнопке каждые 250 мс
  setInterval(() => {
    if (!mainHudShadow) return;
    const panel = mainHudShadow.getElementById("chesscoach-panel");
    if (panel) {
      // Гарантируем, что внутренний таймер content.js не сбросит видимость панели
      if (isSettingsHubOpen && panel.style.display === "none") {
        panel.style.display = "flex";
      } else if (!isSettingsHubOpen && panel.style.display !== "none") {
        panel.style.display = "none";
      }
    }

    const bestDesc = mainHudShadow.getElementById("cc-best-desc")?.textContent || "";
    const bestEval = mainHudShadow.getElementById("cc-best-eval")?.textContent || "";
    const autoChk = mainHudShadow.getElementById("cc-auto-master-chk");
    const isAutoOn = Boolean(autoChk && autoChk.checked);

    orbMainBtn.classList.toggle("cc-auto-active", isAutoOn);
    orbLabel.textContent = isAutoOn ? "АВТО: ВКЛ" : "НАСТРОЙКИ";
    orbDot.style.background = isAutoOn ? "#38b000" : "#00f5d4";

    const m = bestDesc.match(/\b([a-h][1-8])\s*→\s*([a-h][1-8])/i);
    if (m) {
      const evalShort = bestEval && bestEval !== "--" ? ` (${bestEval})` : "";
      orbMoveTxt.textContent = `${m[1]}→${m[2]}${evalShort}`;
    } else {
      orbMoveTxt.textContent = "♟️ МЕНЮ";
    }
  }, 250);

  wakeOrb();
})();