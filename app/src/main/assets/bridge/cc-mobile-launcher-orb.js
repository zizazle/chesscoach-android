(function () {
  if (window.__ccMobileLauncherOrbInitialized) return;
  window.__ccMobileLauncherOrbInitialized = true;

  let mainHudShadow = null;
  let isSettingsHubOpen = false;
  let isMiniHudMinimized = false;
  const currentPlatform = location.hostname.includes("chess.com") ? "chesscom" : "lichess";

  // 1. Читаем оригинальный content.css напрямую из APK
  let rawContentCss = "";
  try {
    if (window.CCAndroidBridge && typeof window.CCAndroidBridge.readAssetText === "function") {
      rawContentCss = window.CCAndroidBridge.readAssetText("content/content.css") || "";
    }
  } catch (e) {}

  // 2. Мобильные стили для полноэкранного окна Настроек (БЕЗ вкладки Анализ и с рабочим скрытием .cc-mobile-hidden)
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
      display: flex;
      flex-direction: column !important;
      overflow: hidden !important;
      z-index: 2147483646 !important;
      touch-action: pan-y !important;
    }
    /* Жесткое скрытие окна настроек во время игры */
    #chesscoach-panel.cc-mobile-hidden {
      display: none !important;
      visibility: hidden !important;
      pointer-events: none !important;
      opacity: 0 !important;
    }
    /* Скрываем вкладку АНАЛИЗ внутри меню настроек (расчеты продолжают идти в фоне для мини-окна) */
    .cc-tab-btn[data-tab="analyzer"],
    #cc-pane-analyzer {
      display: none !important;
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
      height: 48px !important;
      padding: 0 12px !important;
      flex-shrink: 0 !important;
    }
    #cc-mobile-launcher-bar {
      position: relative !important;
      z-index: 4 !important;
      padding: 10px 12px !important;
      background: rgba(6, 9, 16, 0.96) !important;
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
      border: 1.5px solid rgba(255, 255, 255, 0.15) !important;
      border-radius: 12px !important;
      padding: 10px !important;
      color: #cbd5e1 !important;
      cursor: pointer !important;
      display: flex !important;
      flex-direction: column !important;
      gap: 3px !important;
      text-align: left !important;
      user-select: none !important;
    }
    .cc-platform-card:active {
      transform: scale(0.97) !important;
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
      pointer-events: none !important;
    }
    .cc-platform-card-sub {
      font-size: 9.5px !important;
      color: #94a3b8 !important;
      font-weight: 700 !important;
      pointer-events: none !important;
    }
    #cc-return-to-game-btn {
      width: 100% !important;
      padding: 12px 14px !important;
      border-radius: 11px !important;
      border: none !important;
      background: linear-gradient(135deg, #00f5d4, #00bbf9) !important;
      color: #04070e !important;
      font-size: 12.5px !important;
      font-weight: 900 !important;
      letter-spacing: 0.4px !important;
      cursor: pointer !important;
      box-shadow: 0 4px 15px rgba(0, 245, 212, 0.35) !important;
    }
    #cc-return-to-game-btn:active {
      transform: scale(0.98) !important;
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
      background: rgba(5, 7, 13, 0.92) !important;
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
      padding: 8px 13px !important;
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
      padding-bottom: 36px !important;
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
   * Надежный обработчик нажатия для мобильного WebView (срабатывает и от тапа пальцем, и от клика,
   * не блокируется скроллом и не проваливается сквозь кнопку на шахматную доску)
   */
  function bindReliableMobileTap(el, handler) {
    if (!el) return;
    let lastFire = 0;
    let startX = 0;
    let startY = 0;

    el.addEventListener("touchstart", (e) => {
      e.stopPropagation();
      if (e.touches && e.touches.length === 1) {
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
      }
    }, { passive: true });

    el.addEventListener("touchend", (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (e.changedTouches && e.changedTouches.length === 1) {
        const dx = Math.abs(e.changedTouches[0].clientX - startX);
        const dy = Math.abs(e.changedTouches[0].clientY - startY);
        if (dx > 18 || dy > 18) return;
      }
      const now = Date.now();
      if (now - lastFire < 280) return;
      lastFire = now;
      handler(e);
    }, { passive: false });

    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      const now = Date.now();
      if (now - lastFire < 280) return;
      lastFire = now;
      handler(e);
    }, true);
  }

  function shieldFromBoardBleedThrough(el) {
    if (!el) return;
    ["touchstart", "touchmove", "touchend", "mousedown", "mousemove", "mouseup", "pointerdown", "pointerup", "click", "contextmenu"].forEach((ev) => {
      el.addEventListener(ev, (e) => {
        e.stopPropagation();
      }, false);
    });
  }

  function navigateToPlatform(platformKey, targetUrl, btnEl) {
    vibrate(22);
    if (btnEl) {
      const sub = btnEl.querySelector(".cc-platform-card-sub");
      if (sub) {
        sub.textContent = "⏳ ЗАГРУЗКА ПЛАТФОРМЫ...";
        sub.style.color = "#00f5d4";
      }
    }

    if (window.chrome && window.chrome.storage) {
      window.chrome.storage.local.set({ cc_mobile_platform: platformKey });
    }

    // Снимаем защиту Lichess/Chess.com от ухода со страницы во время начатой партии
    try {
      window.onbeforeunload = null;
      window.addEventListener("beforeunload", (ev) => {
        ev.stopImmediatePropagation();
      }, true);
    } catch (e) {}

    try {
      if (window.CCAndroidBridge && typeof window.CCAndroidBridge.switchPlatformUrl === "function") {
        window.CCAndroidBridge.switchPlatformUrl(targetUrl);
      }
    } catch (e) {}

    setTimeout(() => {
      window.location.replace(targetUrl);
    }, 40);
  }

  // 3. Перехват закрытого ShadowRoot главной панели (#chesscoach-panel)
  const origAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    const sr = origAttachShadow.call(this, init);
    if (this.id !== "cc-userscripts-host" && this.id !== "cc-floating-orb-host") {
      mainHudShadow = sr;

      const styleEl = document.createElement("style");
      styleEl.id = "cc-inline-master-css";
      styleEl.textContent = rawContentCss + "\n" + mobileOverrideCss;
      sr.appendChild(styleEl);

      const obs = new MutationObserver(() => {
        const panel = sr.getElementById("chesscoach-panel");
        if (panel && !sr.getElementById("cc-mobile-launcher-bar")) {
          setupMobileSettingsHub(sr, panel);
        }
      });
      obs.observe(sr, { childList: true });
    }
    return sr;
  };

  function ensureNonAnalyzerTabSelected(sr) {
    if (!sr) return;
    const activeBtn = sr.querySelector(".cc-tab-btn.active");
    if (!activeBtn || activeBtn.dataset.tab === "analyzer") {
      const autoTabBtn = sr.querySelector('.cc-tab-btn[data-tab="automove"]') || sr.querySelector('.cc-tab-btn[data-tab="rage"]');
      if (autoTabBtn) autoTabBtn.click();
    }
  }

  function setupMobileSettingsHub(sr, panel) {
    shieldFromBoardBleedThrough(panel);

    const isChessCom = currentPlatform === "chesscom";
    const launcherBar = document.createElement("div");
    launcherBar.id = "cc-mobile-launcher-bar";
    launcherBar.innerHTML = `
      <div class="cc-launcher-title">🌐 ВЫБОР ПЛАТФОРМЫ (ОТКРЫВАЕТСЯ МГНОВЕННО):</div>
      <div class="cc-launcher-cards-row">
        <button type="button" class="cc-platform-card ${!isChessCom ? "active-lichess" : ""}" id="cc-select-lichess-btn">
          <div class="cc-platform-card-title">
            <span>♟️ LICHESS.ORG</span>
            <span style="font-size:9px; color:${!isChessCom ? "#00f5d4" : "#94a3b8"};">${!isChessCom ? "● АКТИВЕН" : "ОТКРЫТЬ ➔"}</span>
          </div>
          <div class="cc-platform-card-sub">⚡ HvH Резня • Премувы • Legit</div>
        </button>

        <button type="button" class="cc-platform-card ${isChessCom ? "active-chesscom" : ""}" id="cc-select-chesscom-btn">
          <div class="cc-platform-card-title">
            <span>🛡️ CHESS.COM</span>
            <span style="font-size:9px; color:${isChessCom ? "#70e000" : "#94a3b8"};">${isChessCom ? "● АКТИВЕН" : "ОТКРЫТЬ ➔"}</span>
          </div>
          <div class="cc-platform-card-sub">🎯 Безье • T1% Лимитер • Стелс</div>
        </button>
      </div>
      <button type="button" id="cc-return-to-game-btn">
        🎮 ВЕРНУТЬСЯ К ДОСКЕ ${isChessCom ? "CHESS.COM" : "LICHESS.ORG"} (СВЕРНУТЬ НАСТРОЙКИ)
      </button>
    `;

    const modeBar = sr.getElementById("cc-mode-switcher-bar");
    if (modeBar) {
      panel.insertBefore(launcherBar, modeBar);
    } else {
      panel.prepend(launcherBar);
    }

    // Кнопка закрытия в правом верхнем углу шапки
    const headerCloseBtn = sr.getElementById("cc-toggle-btn");
    if (headerCloseBtn) {
      headerCloseBtn.textContent = "✕ К ДОСКЕ";
      bindReliableMobileTap(headerCloseBtn, () => {
        vibrate(14);
        setSettingsHubVisible(false);
      });
    }

    // Большая бирюзовая кнопка «ВЕРНУТЬСЯ К ДОСКЕ»
    bindReliableMobileTap(sr.getElementById("cc-return-to-game-btn"), () => {
      vibrate(14);
      setSettingsHubVisible(false);
    });

    // Переключение на Lichess.org
    const lichessBtn = sr.getElementById("cc-select-lichess-btn");
    bindReliableMobileTap(lichessBtn, () => {
      if (!location.hostname.includes("lichess.org")) {
        navigateToPlatform("lichess", "https://lichess.org/", lichessBtn);
      } else {
        vibrate(14);
        setSettingsHubVisible(false);
      }
    });

    // Переключение на Chess.com
    const chesscomBtn = sr.getElementById("cc-select-chesscom-btn");
    bindReliableMobileTap(chesscomBtn, () => {
      if (!location.hostname.includes("chess.com")) {
        navigateToPlatform("chesscom", "https://www.chess.com/play/online", chesscomBtn);
      } else {
        vibrate(14);
        setSettingsHubVisible(false);
      }
    });

    // Сразу переключаем настройки со скрытой вкладки «Анализ» на «Автоход v2»
    setTimeout(() => ensureNonAnalyzerTabSelected(sr), 20);

    // Если уже идет партия — сразу сворачиваем меню настроек, чтобы не мешать играть
    const isPlayingNow =
      location.pathname.length > 4 &&
      !location.pathname.endsWith("/online") &&
      location.pathname !== "/";
    setSettingsHubVisible(!isPlayingNow);
  }

  // 4. СОЗДАНИЕ ПЕРЕТЯГИВАЕМОГО МАЛЕНЬКОГО ОКНА ЛУЧШЕГО ХОДА И ТЕХ. ОБОСНОВАНИЯ + УГЛОВОЙ КНОПКИ
  const hudHost = document.createElement("div");
  hudHost.id = "cc-floating-orb-host";
  hudHost.style.cssText = "all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647; pointer-events: none;";
  document.documentElement.appendChild(hudHost);
  const hudShadow = origAttachShadow.call(hudHost, { mode: "open" });

  const container = document.createElement("div");
  container.id = "cc-ingame-layer";
  hudShadow.innerHTML = `
    <style>
      * {
        box-sizing: border-box;
        user-select: none;
        -webkit-user-select: none;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Inter", Roboto, sans-serif;
      }
      /* Перетягиваемое компактное окно лучшего хода и технического обоснования */
      #cc-mini-hud-card {
        position: fixed;
        top: 54px;
        left: 10px;
        width: 274px;
        background: rgba(8, 12, 20, 0.84);
        backdrop-filter: blur(16px) saturate(180%);
        -webkit-backdrop-filter: blur(16px) saturate(180%);
        border: 1.5px solid rgba(0, 245, 212, 0.55);
        border-radius: 15px;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.8), 0 0 16px rgba(0, 245, 212, 0.2);
        color: #f8fafc;
        pointer-events: auto;
        touch-action: none;
        z-index: 2147483647;
        overflow: hidden;
        transition: opacity 0.25s ease, border-color 0.2s ease;
      }
      #cc-mini-hud-card.cc-danger-border {
        border-color: #ff2a85;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.85), 0 0 18px rgba(255, 42, 133, 0.35);
      }
      .cc-mini-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 5px 8px;
        background: rgba(4, 7, 13, 0.9);
        border-bottom: 1px solid rgba(255, 255, 255, 0.09);
        cursor: grab;
      }
      .cc-mini-status {
        display: flex;
        align-items: center;
        gap: 5px;
        font-size: 9.5px;
        font-weight: 900;
        color: #00f5d4;
        letter-spacing: 0.3px;
      }
      .cc-mini-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #00f5d4;
        box-shadow: 0 0 8px #00f5d4;
      }
      .cc-mini-actions {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .cc-mini-btn {
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.18);
        color: #f1f5f9;
        border-radius: 7px;
        height: 23px;
        padding: 0 7px;
        font-size: 10px;
        font-weight: 900;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
      }
      .cc-mini-btn:active {
        transform: scale(0.92);
      }
      .cc-mini-btn-play {
        background: rgba(0, 245, 212, 0.22);
        border-color: #00f5d4;
        color: #00f5d4;
      }
      .cc-mini-btn-close {
        color: #ff4d94;
        border-color: rgba(255, 77, 148, 0.4);
      }
      .cc-mini-body {
        padding: 7px 10px;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .cc-mini-move-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 6px;
      }
      #cc-mini-move-main {
        font-family: monospace;
        font-size: 13.5px;
        font-weight: 900;
        color: #ffffff;
        letter-spacing: 0.3px;
      }
      .cc-mini-badges {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      #cc-mini-eval-badge {
        font-family: monospace;
        font-size: 11px;
        font-weight: 900;
        padding: 1.5px 6px;
        border-radius: 6px;
        background: rgba(0, 245, 212, 0.16);
        border: 1px solid rgba(0, 245, 212, 0.45);
        color: #00f5d4;
      }
      #cc-mini-wdl-pill {
        font-family: monospace;
        font-size: 9px;
        font-weight: 800;
        color: #cbd5e1;
        background: rgba(255, 255, 255, 0.06);
        padding: 2px 5px;
        border-radius: 5px;
      }
      #cc-mini-tech-reason {
        font-size: 10.5px;
        line-height: 1.32;
        color: #e2e8f0;
        font-weight: 600;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      #cc-mini-pv-line {
        font-family: monospace;
        font-size: 9.5px;
        color: #00bbf9;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        opacity: 0.92;
      }

      /* Угловая полупрозрачная кнопка (показывается, когда мини-окно закрыто крестиком) */
      #cc-corner-pill {
        position: fixed;
        top: 62px;
        right: 10px;
        display: none;
        align-items: center;
        gap: 5px;
        pointer-events: auto;
        touch-action: none;
        z-index: 2147483647;
        opacity: 0.68;
      }
      .cc-corner-btn {
        height: 40px;
        padding: 0 11px;
        border-radius: 13px;
        background: rgba(8, 12, 20, 0.85);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border: 1.5px solid #00f5d4;
        color: #ffffff;
        font-size: 10.5px;
        font-weight: 900;
        display: flex;
        align-items: center;
        gap: 5px;
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.75);
        cursor: pointer;
      }
    </style>

    <!-- Компактное перетягиваемое окно лучшего хода и технического обоснования -->
    <div id="cc-mini-hud-card">
      <div class="cc-mini-header" id="cc-mini-drag-handle">
        <div class="cc-mini-status">
          <span class="cc-mini-dot" id="cc-mini-dot"></span>
          <span id="cc-mini-turn-txt">АНАЛИЗ ДОСКИ</span>
        </div>
        <div class="cc-mini-actions">
          <button type="button" class="cc-mini-btn cc-mini-btn-play" id="cc-mini-play-btn" title="Сделать ход">⚡ ХОД</button>
          <button type="button" class="cc-mini-btn" id="cc-mini-settings-btn" title="Открыть настройки">⚙️ МЕНЮ</button>
          <button type="button" class="cc-mini-btn cc-mini-btn-close" id="cc-mini-close-btn" title="Скрыть окно">✕</button>
        </div>
      </div>
      <div class="cc-mini-body">
        <div class="cc-mini-move-row">
          <span id="cc-mini-move-main">♟️ Ожидание...</span>
          <div class="cc-mini-badges">
            <span id="cc-mini-wdl-pill">W:50%</span>
            <span id="cc-mini-eval-badge">0.00</span>
          </div>
        </div>
        <div id="cc-mini-tech-reason">Сделайте ход или откройте партию для расчета лучшего продолжения.</div>
        <div id="cc-mini-pv-line">◈ Готов к анализу</div>
      </div>
    </div>

    <!-- Маленькая угловая кнопка, когда мини-окно скрыто крестиком -->
    <div id="cc-corner-pill">
      <button type="button" class="cc-corner-btn" id="cc-corner-restore-hud-btn" title="Показать мини-окно анализа">
        <span>👁️</span>
        <span id="cc-corner-move-short">АНАЛИЗ</span>
      </button>
      <button type="button" class="cc-corner-btn" id="cc-corner-open-settings-btn" style="border-color:#c77dff; color:#c77dff;" title="Открыть настройки">
        <span>⚙️</span>
      </button>
    </div>
  `;
  hudShadow.appendChild(container);

  const miniHudCard = hudShadow.getElementById("cc-mini-hud-card");
  const cornerPill = hudShadow.getElementById("cc-corner-pill");
  const miniPlayBtn = hudShadow.getElementById("cc-mini-play-btn");
  const miniSettingsBtn = hudShadow.getElementById("cc-mini-settings-btn");
  const miniCloseBtn = hudShadow.getElementById("cc-mini-close-btn");
  const cornerRestoreBtn = hudShadow.getElementById("cc-corner-restore-hud-btn");
  const cornerSettingsBtn = hudShadow.getElementById("cc-corner-open-settings-btn");

  const miniDot = hudShadow.getElementById("cc-mini-dot");
  const miniTurnTxt = hudShadow.getElementById("cc-mini-turn-txt");
  const miniMoveMain = hudShadow.getElementById("cc-mini-move-main");
  const miniEvalBadge = hudShadow.getElementById("cc-mini-eval-badge");
  const miniWdlPill = hudShadow.getElementById("cc-mini-wdl-pill");
  const miniTechReason = hudShadow.getElementById("cc-mini-tech-reason");
  const miniPvLine = hudShadow.getElementById("cc-mini-pv-line");
  const cornerMoveShort = hudShadow.getElementById("cc-corner-move-short");

  // Полная защита от проваливания касаний сквозь мини-окно и угловую кнопку на шахматную доску
  [miniHudCard, cornerPill].forEach((node) => {
    ["mousedown", "mousemove", "mouseup", "pointerdown", "pointermove", "pointerup", "click", "dblclick", "contextmenu"].forEach((evName) => {
      node.addEventListener(evName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      }, { passive: false });
    });
  });

  // Восстановление позиции перетягиваемого мини-окна
  if (window.chrome && window.chrome.storage) {
    window.chrome.storage.local.get(["cc_mini_hud_pos"], (res) => {
      if (res && res.cc_mini_hud_pos) {
        const x = Math.max(6, Math.min(window.innerWidth - 280, Number(res.cc_mini_hud_pos.left) || 10));
        const y = Math.max(24, Math.min(window.innerHeight - 110, Number(res.cc_mini_hud_pos.top) || 54));
        miniHudCard.style.left = x + "px";
        miniHudCard.style.top = y + "px";
      }
    });
  }

  // Перетягивание мини-окна пальцем за любую точку карточки (кроме кнопок)
  let draggingHud = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let cardStartLeft = 0;
  let cardStartTop = 0;

  miniHudCard.addEventListener("touchstart", (e) => {
    e.stopPropagation();
    const targetTag = (e.target && e.target.tagName) ? e.target.tagName.toUpperCase() : "";
    if (targetTag === "BUTTON" || (e.target && e.target.closest("button"))) return;
    if (e.touches.length !== 1) return;

    draggingHud = true;
    dragStartX = e.touches[0].clientX;
    dragStartY = e.touches[0].clientY;
    const rect = miniHudCard.getBoundingClientRect();
    cardStartLeft = rect.left;
    cardStartTop = rect.top;
  }, { passive: true });

  miniHudCard.addEventListener("touchmove", (e) => {
    if (!draggingHud || e.touches.length !== 1) return;
    e.preventDefault();
    e.stopPropagation();
    const dx = e.touches[0].clientX - dragStartX;
    const dy = e.touches[0].clientY - dragStartY;
    const nx = Math.max(4, Math.min(window.innerWidth - miniHudCard.offsetWidth - 4, cardStartLeft + dx));
    const ny = Math.max(12, Math.min(window.innerHeight - miniHudCard.offsetHeight - 12, cardStartTop + dy));
    miniHudCard.style.left = nx + "px";
    miniHudCard.style.top = ny + "px";
  }, { passive: false });

  miniHudCard.addEventListener("touchend", (e) => {
    e.stopPropagation();
    if (draggingHud) {
      draggingHud = false;
      const rect = miniHudCard.getBoundingClientRect();
      if (window.chrome && window.chrome.storage) {
        window.chrome.storage.local.set({
          cc_mini_hud_pos: { left: rect.left, top: rect.top }
        });
      }
    }
  }, { passive: true });

  // Кнопки управления на мини-окне и угловой пилюле
  bindReliableMobileTap(miniPlayBtn, () => {
    vibrate(18);
    if (mainHudShadow) {
      const playOnceBtn = mainHudShadow.getElementById("cc-play-once");
      if (playOnceBtn) playOnceBtn.click();
    }
  });

  bindReliableMobileTap(miniSettingsBtn, () => {
    vibrate(14);
    setSettingsHubVisible(true);
  });

  bindReliableMobileTap(miniCloseBtn, () => {
    vibrate(12);
    isMiniHudMinimized = true;
    syncVisibilityStates();
  });

  bindReliableMobileTap(cornerRestoreBtn, () => {
    vibrate(14);
    isMiniHudMinimized = false;
    syncVisibilityStates();
  });

  bindReliableMobileTap(cornerSettingsBtn, () => {
    vibrate(14);
    setSettingsHubVisible(true);
  });

  function syncVisibilityStates() {
    if (!mainHudShadow) return;
    const panel = mainHudShadow.getElementById("chesscoach-panel");
    if (!panel) return;

    if (isSettingsHubOpen) {
      panel.classList.remove("cc-mobile-hidden");
      panel.classList.remove("cc-minimized");
      ensureNonAnalyzerTabSelected(mainHudShadow);
      miniHudCard.style.display = "none";
      cornerPill.style.display = "none";
    } else {
      panel.classList.add("cc-mobile-hidden");
      if (isMiniHudMinimized) {
        miniHudCard.style.display = "none";
        cornerPill.style.display = "flex";
      } else {
        miniHudCard.style.display = "block";
        cornerPill.style.display = "none";
      }
    }
  }

  function setSettingsHubVisible(visible) {
    isSettingsHubOpen = Boolean(visible);
    syncVisibilityStates();
  }

  // Системная кнопка «Назад» на телефоне закрывает настройки и возвращает к доске
  window.__ccHandleAndroidBack = function () {
    if (isSettingsHubOpen) {
      setSettingsHubVisible(false);
      return true;
    }
    return false;
  };

  // Загрузка пользовательских .JS скриптов с телефона во вкладке «📜 СКРИПТЫ»
  function patchMobileScriptFilePicker() {
    if (!mainHudShadow) return;
    const picker = mainHudShadow.getElementById("cc-script-file-picker");
    const statusEl = mainHudShadow.getElementById("cc-script-loader-status");
    if (!picker || picker.dataset.androidPatched === "1") return;

    picker.dataset.androidPatched = "1";
    picker.addEventListener("change", (e) => {
      e.stopImmediatePropagation();
      const files = Array.from(e.target.files || []);
      files.forEach((file) => {
        const reader = new FileReader();
        reader.onload = () => {
          const code = String(reader.result || "");
          if (!code.trim()) return;
          try {
            if (window.CCAndroidBridge && typeof window.CCAndroidBridge.saveUserScriptFile === "function") {
              window.CCAndroidBridge.saveUserScriptFile(file.name, code);
            }
            const scriptTag = document.createElement("script");
            scriptTag.textContent = code;
            document.head.appendChild(scriptTag);
            scriptTag.remove();
            if (statusEl) {
              statusEl.textContent = "✅ ЗАГРУЖЕН: " + file.name;
              statusEl.style.color = "#38b000";
            }
          } catch (err) {}
        };
        reader.readAsText(file);
      });
    }, true);
  }

  // 5. Синхронизация данных мини-окна с расчетами движка каждые 200 мс
  setInterval(() => {
    if (!mainHudShadow) return;

    syncVisibilityStates();
    patchMobileScriptFilePicker();

    const bestDesc = (mainHudShadow.getElementById("cc-best-desc")?.textContent || "").trim();
    const bestEval = (mainHudShadow.getElementById("cc-best-eval")?.textContent || "0.00").trim();
    const bestPv = (mainHudShadow.getElementById("cc-best-pv")?.textContent || "").trim();
    const standbyBox = mainHudShadow.getElementById("cc-enemy-turn-standby");
    const isEnemyTurn = Boolean(standbyBox && standbyBox.style.display !== "none");
    const threatsText = (mainHudShadow.getElementById("cc-tele-threats-val")?.textContent || "").trim();
    const wdlText = (mainHudShadow.getElementById("cc-tele-wdl-val")?.textContent || "").trim();
    const autoChk = mainHudShadow.getElementById("cc-auto-master-chk");
    const isAutoOn = Boolean(autoChk && autoChk.checked);

    // WDL процент побед
    const wMatch = wdlText.match(/Поб:\s*(\d+%)/i);
    if (wMatch) {
      miniWdlPill.textContent = "Поб " + wMatch[1];
    }

    // Оценка позиции
    if (bestEval && bestEval !== "--") {
      miniEvalBadge.textContent = bestEval;
      const isNeg = bestEval.startsWith("-");
      miniEvalBadge.style.color = isNeg ? "#ff4d94" : "#00f5d4";
      miniEvalBadge.style.borderColor = isNeg ? "rgba(255, 77, 148, 0.45)" : "rgba(0, 245, 212, 0.45)";
      miniEvalBadge.style.background = isNeg ? "rgba(255, 77, 148, 0.15)" : "rgba(0, 245, 212, 0.16)";
    }

    if (isEnemyTurn) {
      miniTurnTxt.textContent = isAutoOn ? "⏳ ВРАГ (АВТО ВКЛ)" : "⏳ ХОД СОПЕРНИКА";
      miniDot.style.background = "#ffbe0b";
      miniDot.style.boxShadow = "0 0 8px #ffbe0b";
      miniTechReason.textContent = threatsText || "Ожидание ответа соперника, контроль угроз и премува...";
    } else {
      miniTurnTxt.textContent = isAutoOn ? "🤖 НАШ ХОД (АВТО)" : "🟢 НАШ ХОД";
      miniDot.style.background = isAutoOn ? "#38b000" : "#00f5d4";
      miniDot.style.boxShadow = isAutoOn ? "0 0 8px #38b000" : "0 0 8px #00f5d4";

      // Парсим сам ход и техническое обоснование из строки объяснения
      const moveMatch = bestDesc.match(/([А-Яа-яA-Za-z]+\s+[a-h][1-8]\s*→\s*[a-h][1-8](?:=[QNBR])?)/);
      const shortMatch = bestDesc.match(/\b([a-h][1-8])\s*→\s*([a-h][1-8])/i);

      if (moveMatch) {
        miniMoveMain.textContent = "✦ " + moveMatch[1];
      } else if (shortMatch) {
        miniMoveMain.textContent = `✦ ${shortMatch[1]} → ${shortMatch[2]}`;
      }

      if (shortMatch) {
        cornerMoveShort.textContent = `${shortMatch[1]}→${shortMatch[2]} (${bestEval})`;
      }

      // Отделяем чистое техническое обоснование после тире "—"
      const dashIdx = bestDesc.indexOf("—");
      if (dashIdx !== -1) {
        miniTechReason.textContent = bestDesc.slice(dashIdx + 1).trim();
      } else if (bestDesc) {
        miniTechReason.textContent = bestDesc;
      }

      if (bestPv) {
        miniPvLine.textContent = bestPv;
      }
    }
  }, 200);
})();