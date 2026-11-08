(function () {
  if (window.__ccMobileLauncherOrbInitialized) return;
  window.__ccMobileLauncherOrbInitialized = true;

  console.log("[ChessCoach Android] Запуск Лаунчера и Плавающей кнопки v15.3...");

  let mainHudShadow = null;
  let isSettingsHubOpen = false;
  let currentPlatform = location.hostname.includes("chess.com") ? "chesscom" : "lichess";

  // 1. Доработка моста сообщений для мгновенных премувов, тепловой карты и базы опыта (Experience DB)
  if (window.chrome && window.chrome.runtime) {
    const prevSendMessage = window.chrome.runtime.sendMessage;
    window.chrome.runtime.sendMessage = function (payload, callback) {
      if (!payload || typeof payload !== "object") return;

      if (payload.type === "GET_BOARD_HEATMAP" && typeof parseFEN === "function" && typeof computeBoardControlHeatmap === "function") {
        setTimeout(() => {
          try {
            const { board } = parseFEN(payload.fen);
            const heatmap = computeBoardControlHeatmap(board, payload.myColor || "w");
            if (callback) callback({ ok: true, heatmap });
          } catch (e) {
            if (callback) callback({ ok: false });
          }
        }, 1);
        return;
      }

      if (payload.type === "GET_INSTANT_PREMOVE" && typeof parseFEN === "function" && typeof computeSmartNextPremove === "function") {
        setTimeout(() => {
          try {
            const { board, castling, epSquare, pieceCount } = parseFEN(payload.fen);
            const myColor = payload.myColor || "w";
            const enemyColor = myColor === "w" ? "b" : "w";
            const plan = computeSmartNextPremove(
              board,
              myColor,
              enemyColor,
              castling,
              epSquare,
              payload.lastOurMove || null,
              payload.style || "tal",
              Array.isArray(payload.recentPositions) ? payload.recentPositions : []
            );
            const staticMyEval = typeof evaluateBoard === "function" ? evaluateBoard(board, myColor, payload.style || "tal") : 0;
            const wdl = typeof computeWinDrawLossChances === "function"
              ? computeWinDrawLossChances(staticMyEval, false, false)
              : { myWin: 50, draw: 30, enemyWin: 20 };
            const heatmap = typeof computeBoardControlHeatmap === "function" ? computeBoardControlHeatmap(board, myColor) : [];
            if (callback) {
              callback({
                ...(plan || { canPremove: false }),
                heatmap,
                telemetry: {
                  serverSource: pieceCount <= 7 ? "SYZYGY READY" : "PREMOVE RADAR",
                  pingMs: 1,
                  myWin: wdl.myWin,
                  draw: wdl.draw,
                  enemyWin: wdl.enemyWin,
                  evalCp: staticMyEval,
                  nearestThreatText: plan && plan.canPremove
                    ? `Готов премув ${plan.premove.from}→${plan.premove.to} (${plan.confidence}%)`
                    : "Ожидание хода соперника (контроль угроз)"
                }
              });
            }
          } catch (e) {
            if (callback) callback({ canPremove: false });
          }
        }, 1);
        return;
      }

      if (prevSendMessage) {
        prevSendMessage(payload, callback);
      }
    };
  }

  // 2. Перехват закрытого ShadowRoot главной панели (#chesscoach-panel)
  const origAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    const sr = origAttachShadow.call(this, init);
    if (this.id !== "cc-userscripts-host" && this.id !== "cc-floating-orb-host") {
      mainHudShadow = sr;
      setTimeout(() => enhanceMainHudForMobile(sr), 30);
    }
    return sr;
  };

  function vibrate(ms = 12) {
    try {
      if (window.CCAndroidBridge && typeof window.CCAndroidBridge.vibrateTick === "function") {
        window.CCAndroidBridge.vibrateTick(ms);
      }
    } catch (e) {}
  }

  // 3. Создание полупрозрачной плавающей кнопки (Floating Glass Orb) поверх игры
  const orbHost = document.createElement("div");
  orbHost.id = "cc-floating-orb-host";
  orbHost.style.cssText = "all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647; pointer-events: none;";
  document.documentElement.appendChild(orbHost);
  const orbShadow = origAttachShadow.call(orbHost, { mode: "open" });

  const orbContainer = document.createElement("div");
  orbContainer.id = "cc-orb-wrapper";
  orbShadow.innerHTML = `
    <style>
      @keyframes cc-orb-glow {
        0%, 100% { box-shadow: 0 8px 28px rgba(0, 0, 0, 0.75), 0 0 16px rgba(0, 245, 212, 0.42), inset 0 1px 1px rgba(255, 255, 255, 0.28); }
        50% { box-shadow: 0 8px 32px rgba(0, 0, 0, 0.85), 0 0 24px rgba(199, 125, 255, 0.60), inset 0 1px 1px rgba(255, 255, 255, 0.38); }
      }
      #cc-orb-wrapper {
        position: fixed;
        right: 12px;
        top: 38%;
        display: flex;
        align-items: center;
        gap: 6px;
        pointer-events: auto;
        touch-action: none;
        user-select: none;
        -webkit-user-select: none;
        z-index: 2147483647;
        transition: opacity 0.35s ease, transform 0.18s cubic-bezier(0.16, 1, 0.3, 1);
        opacity: 0.86;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Inter", Roboto, sans-serif;
      }
      #cc-orb-wrapper.cc-idle-dim {
        opacity: 0.48;
      }
      #cc-orb-wrapper:active {
        opacity: 1 !important;
        transform: scale(0.96);
      }
      #cc-orb-main-btn {
        min-width: 64px;
        height: 56px;
        padding: 6px 11px;
        border-radius: 18px;
        background: rgba(10, 14, 24, 0.62);
        backdrop-filter: blur(18px) saturate(190%);
        -webkit-backdrop-filter: blur(18px) saturate(190%);
        border: 1.5px solid rgba(0, 245, 212, 0.68);
        animation: cc-orb-glow 3s ease-in-out infinite;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 2px;
        color: #ffffff;
        cursor: pointer;
      }
      #cc-orb-main-btn.cc-auto-on {
        border-color: #38b000;
        background: rgba(10, 24, 16, 0.68);
      }
      #cc-orb-main-btn.cc-hub-open {
        border-color: #ff2a85;
        background: rgba(26, 10, 20, 0.85);
      }
      .cc-orb-top-row {
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 10px;
        font-weight: 900;
        letter-spacing: 0.4px;
        color: #00f5d4;
      }
      .cc-orb-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #00f5d4;
        box-shadow: 0 0 8px #00f5d4;
      }
      #cc-orb-move-pill {
        font-family: monospace;
        font-size: 11px;
        font-weight: 900;
        color: #f8fafc;
        white-space: nowrap;
        text-shadow: 0 1px 3px rgba(0, 0, 0, 0.9);
      }
      #cc-orb-eval-pill {
        font-family: monospace;
        font-size: 9.5px;
        font-weight: 800;
        color: #ffbe0b;
      }
      /* Боковая полупрозрачная кнопка быстрого хода [X] */
      #cc-orb-quick-move-btn {
        width: 42px;
        height: 42px;
        border-radius: 14px;
        background: rgba(0, 245, 212, 0.22);
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
        border: 1.5px solid rgba(0, 245, 212, 0.75);
        color: #00f5d4;
        font-size: 15px;
        font-weight: 900;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.65);
        cursor: pointer;
      }
      #cc-orb-quick-move-btn small {
        font-size: 8px;
        color: #ffffff;
        font-family: monospace;
        margin-top: -2px;
      }
      #cc-orb-quick-move-btn:active {
        background: rgba(0, 245, 212, 0.55);
        color: #05070c;
      }
    </style>
    <button id="cc-orb-quick-move-btn" title="Сделать одиночный ход [X]">
      <span>⚡</span>
      <small>ХОД</small>
    </button>
    <div id="cc-orb-main-btn" title="Тап — Настройки / Зажатие — Автоход">
      <div class="cc-orb-top-row">
        <span class="cc-orb-dot" id="cc-orb-status-dot"></span>
        <span id="cc-orb-title-txt">МЕНЮ</span>
      </div>
      <div id="cc-orb-move-pill">♟️ ГОТОВ</div>
      <div id="cc-orb-eval-pill">v15.3</div>
    </div>
  `;
  orbShadow.appendChild(orbContainer);

  const orbWrapper = orbShadow.getElementById("cc-orb-wrapper");
  const orbMainBtn = orbShadow.getElementById("cc-orb-main-btn");
  const orbQuickMoveBtn = orbShadow.getElementById("cc-orb-quick-move-btn");
  const orbTitleTxt = orbShadow.getElementById("cc-orb-title-txt");
  const orbMovePill = orbShadow.getElementById("cc-orb-move-pill");
  const orbEvalPill = orbShadow.getElementById("cc-orb-eval-pill");
  const orbStatusDot = orbShadow.getElementById("cc-orb-status-dot");

  let idleDimTimer = null;
  function pokeOrbActivity() {
    orbWrapper.classList.remove("cc-idle-dim");
    if (idleDimTimer) clearTimeout(idleDimTimer);
    if (!isSettingsHubOpen) {
      idleDimTimer = setTimeout(() => {
        orbWrapper.classList.add("cc-idle-dim");
      }, 3200);
    }
  }

  // Восстановление сохраненной позиции плавающей кнопки
  if (window.chrome && window.chrome.storage) {
    window.chrome.storage.local.get(["cc_orb_pos", "cc_hub_seen_session"], (res) => {
      if (res && res.cc_orb_pos) {
        const y = Math.max(48, Math.min(window.innerHeight - 80, Number(res.cc_orb_pos.top) || 240));
        orbWrapper.style.top = y + "px";
        if (res.cc_orb_pos.side === "left") {
          orbWrapper.style.left = "10px";
          orbWrapper.style.right = "auto";
          orbWrapper.style.flexDirection = "row-reverse";
        } else {
          orbWrapper.style.right = "10px";
          orbWrapper.style.left = "auto";
          orbWrapper.style.flexDirection = "row";
        }
      }
    });
  }

  // Физика перетаскивания кнопки пальцем + магнитная привязка к краям экрана + долгое зажатие
  let touchStartX = 0;
  let touchStartY = 0;
  let orbInitialLeft = 0;
  let orbInitialTop = 0;
  let isDraggingOrb = false;
  let longPressTimer = null;
  let longPressTriggered = false;

  orbMainBtn.addEventListener("touchstart", (e) => {
    pokeOrbActivity();
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    touchStartX = t.clientX;
    touchStartY = t.clientY;
    const rect = orbWrapper.getBoundingClientRect();
    orbInitialLeft = rect.left;
    orbInitialTop = rect.top;
    isDraggingOrb = false;
    longPressTriggered = false;

    longPressTimer = setTimeout(() => {
      if (!isDraggingOrb && mainHudShadow) {
        longPressTriggered = true;
        vibrate(45);
        const autoBtn = mainHudShadow.getElementById("cc-toggle-auto");
        if (autoBtn) autoBtn.click();
        syncOrbWithHudState();
      }
    }, 460);
  }, { passive: true });

  orbMainBtn.addEventListener("touchmove", (e) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    const dx = t.clientX - touchStartX;
    const dy = t.clientY - touchStartY;

    if (Math.hypot(dx, dy) > 10) {
      isDraggingOrb = true;
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
      const newLeft = Math.max(6, Math.min(window.innerWidth - 110, orbInitialLeft + dx));
      const newTop = Math.max(36, Math.min(window.innerHeight - 76, orbInitialTop + dy));
      orbWrapper.style.left = newLeft + "px";
      orbWrapper.style.top = newTop + "px";
      orbWrapper.style.right = "auto";
    }
  }, { passive: true });

  orbMainBtn.addEventListener("touchend", () => {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }

    if (isDraggingOrb) {
      const rect = orbWrapper.getBoundingClientRect();
      const snapSide = (rect.left + rect.width / 2) < (window.innerWidth / 2) ? "left" : "right";
      if (snapSide === "left") {
        orbWrapper.style.left = "10px";
        orbWrapper.style.right = "auto";
        orbWrapper.style.flexDirection = "row-reverse";
      } else {
        orbWrapper.style.right = "10px";
        orbWrapper.style.left = "auto";
        orbWrapper.style.flexDirection = "row";
      }
      if (window.chrome && window.chrome.storage) {
        window.chrome.storage.local.set({
          cc_orb_pos: { top: rect.top, side: snapSide }
        });
      }
      pokeOrbActivity();
      return;
    }

    if (!longPressTriggered) {
      vibrate(14);
      toggleSettingsHub(!isSettingsHubOpen);
    }
  });

  // Fallback клик мышью (для тестирования в эмуляторе)
  orbMainBtn.addEventListener("click", (e) => {
    if ("ontouchstart" in window) return;
    toggleSettingsHub(!isSettingsHubOpen);
  });

  // Кнопка мгновенного хода ⚡ [X] прямо с плавающего орба
  orbQuickMoveBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    vibrate(18);
    pokeOrbActivity();
    if (!mainHudShadow) return;
    const playOnceBtn = mainHudShadow.getElementById("cc-play-once");
    if (playOnceBtn) {
      playOnceBtn.click();
    }
  });

  // 4. Переключение между Полноэкранным Хабом Настроек и Чистой Доской
  function toggleSettingsHub(openState) {
    if (!mainHudShadow) return;
    const panel = mainHudShadow.getElementById("chesscoach-panel");
    const backdrop = mainHudShadow.getElementById("cc-mobile-hub-backdrop");
    if (!panel) return;

    isSettingsHubOpen = Boolean(openState);

    if (isSettingsHubOpen) {
      panel.classList.remove("cc-minimized");
      const workspace = mainHudShadow.getElementById("chesscoach-workspace");
      const modeBar = mainHudShadow.getElementById("cc-mode-switcher-bar");
      if (workspace) workspace.style.display = "flex";
      if (modeBar) modeBar.style.display = "grid";

      panel.style.display = "flex";
      if (backdrop) backdrop.style.display = "block";

      orbMainBtn.classList.add("cc-hub-open");
      orbTitleTxt.textContent = "ЗАКРЫТЬ";
      orbQuickMoveBtn.style.display = "none";
      orbWrapper.classList.remove("cc-idle-dim");
    } else {
      panel.style.display = "none";
      if (backdrop) backdrop.style.display = "none";

      orbMainBtn.classList.remove("cc-hub-open");
      orbQuickMoveBtn.style.display = "flex";
      syncOrbWithHudState();
      pokeOrbActivity();
    }
  }

  // Обработка системной кнопки «Назад» на Android: если открыты настройки — сворачивает их в игру
  window.__ccHandleAndroidBack = function () {
    if (isSettingsHubOpen) {
      toggleSettingsHub(false);
      return true;
    }
    return false;
  };

  // 5. Модернизация главного окна (#chesscoach-panel) в Мобильный Лаунчер + Хаб Настроек
  function enhanceMainHudForMobile(sr) {
    const panel = sr.getElementById("chesscoach-panel");
    if (!panel || sr.getElementById("cc-mobile-launcher-bar")) return;

    // 5.1. Задний затемняющий фон при открытом меню настроек
    const backdrop = document.createElement("div");
    backdrop.id = "cc-mobile-hub-backdrop";
    backdrop.style.cssText = `
      position: fixed; inset: 0;
      background: rgba(4, 6, 12, 0.72);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      z-index: 2147483645;
      display: none;
    `;
    backdrop.addEventListener("click", () => toggleSettingsHub(false));
    sr.insertBefore(backdrop, panel);

    // 5.2. Мобильные стили для полноэкранного Хаба и горизонтальной ленты вкладок
    const mobileHubStyle = document.createElement("style");
    mobileHubStyle.textContent = `
      #chesscoach-panel {
        position: fixed !important;
        top: 10px !important;
        left: 10px !important;
        right: 10px !important;
        bottom: 10px !important;
        width: calc(100vw - 20px) !important;
        height: calc(100vh - 20px) !important;
        max-height: calc(100vh - 20px) !important;
        min-height: 0 !important;
        border-radius: 22px !important;
        z-index: 2147483646 !important;
      }
      #cc-mobile-launcher-bar {
        position: relative;
        z-index: 3;
        padding: 10px 12px;
        background: linear-gradient(180deg, rgba(8, 12, 22, 0.95), rgba(6, 9, 16, 0.85));
        border-bottom: 1px solid rgba(0, 245, 212, 0.22);
        display: flex;
        flex-direction: column;
        gap: 8px;
        flex-shrink: 0;
      }
      .cc-launcher-cards-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }
      .cc-platform-card {
        background: rgba(255, 255, 255, 0.05);
        border: 1.5px solid rgba(255, 255, 255, 0.14);
        border-radius: 12px;
        padding: 8px 10px;
        color: #cbd5e1;
        cursor: pointer;
        display: flex;
        flex-direction: column;
        gap: 2px;
        text-align: left;
        transition: all 0.2s ease;
      }
      .cc-platform-card.active-lichess {
        background: linear-gradient(135deg, rgba(0, 245, 212, 0.22), rgba(0, 187, 249, 0.12));
        border-color: #00f5d4;
        color: #ffffff;
        box-shadow: 0 0 18px rgba(0, 245, 212, 0.25);
      }
      .cc-platform-card.active-chesscom {
        background: linear-gradient(135deg, rgba(56, 176, 0, 0.26), rgba(0, 245, 212, 0.12));
        border-color: #38b000;
        color: #ffffff;
        box-shadow: 0 0 18px rgba(56, 176, 0, 0.28);
      }
      .cc-platform-card-title {
        font-size: 12px;
        font-weight: 900;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .cc-platform-card-sub {
        font-size: 9.5px;
        color: #94a3b8;
        font-weight: 700;
      }
      #cc-return-to-game-btn {
        width: 100%;
        padding: 10px 14px;
        border-radius: 11px;
        border: none;
        background: linear-gradient(135deg, #00f5d4, #00bbf9);
        color: #04070e;
        font-size: 12px;
        font-weight: 900;
        letter-spacing: 0.5px;
        cursor: pointer;
        box-shadow: 0 4px 16px rgba(0, 245, 212, 0.35);
      }
      #chesscoach-workspace {
        display: flex !important;
        flex-direction: column !important;
        flex: 1 !important;
        overflow: hidden !important;
      }
      .cc-sidebar {
        border-right: none !important;
        border-bottom: 1px solid rgba(255, 255, 255, 0.09) !important;
        padding: 6px 10px !important;
        flex-shrink: 0 !important;
      }
      .cc-nav-list {
        display: flex !important;
        flex-direction: row !important;
        overflow-x: auto !important;
        gap: 6px !important;
        padding-bottom: 2px !important;
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
        overflow-y: auto !important;
        padding: 12px !important;
        -webkit-overflow-scrolling: touch !important;
      }
    `;
    sr.appendChild(mobileHubStyle);

    // 5.3. Блок выбора Lichess.org / Chess.com в верхней части Лаунчера
    const launcherBar = document.createElement("div");
    launcherBar.id = "cc-mobile-launcher-bar";
    const isChessCom = currentPlatform === "chesscom";

    launcherBar.innerHTML = `
      <div class="cc-launcher-cards-row">
        <button class="cc-platform-card ${!isChessCom ? "active-lichess" : ""}" id="cc-select-lichess-btn">
          <div class="cc-platform-card-title">
            <span>♟️ LICHESS.ORG</span>
            <span style="font-size:9px; color:${!isChessCom ? "#00f5d4" : "#64748b"};">${!isChessCom ? "● АКТИВЕН" : "ВЫБРАТЬ"}</span>
          </div>
          <div class="cc-platform-card-sub">⚡ HvH Резня • Премувы • Legit</div>
        </button>

        <button class="cc-platform-card ${isChessCom ? "active-chesscom" : ""}" id="cc-select-chesscom-btn">
          <div class="cc-platform-card-title">
            <span>🛡️ CHESS.COM</span>
            <span style="font-size:9px; color:${isChessCom ? "#70e000" : "#64748b"};">${isChessCom ? "● АКТИВЕН" : "ВЫБРАТЬ"}</span>
          </div>
          <div class="cc-platform-card-sub">🎯 Безье • T1% Лимитер • Стелс</div>
        </button>
      </div>
      <button id="cc-return-to-game-btn">🎮 ИГРАТЬ НА ${isChessCom ? "CHESS.COM" : "LICHESS.ORG"} (СВЕРНУТЬ В КНОПКУ)</button>
    `;

    const modeBar = sr.getElementById("cc-mode-switcher-bar");
    if (modeBar) {
      panel.insertBefore(launcherBar, modeBar);
    } else {
      panel.prepend(launcherBar);
    }

    // Перехватываем кнопку сворачивания "—" в шапке, чтобы она тоже сворачивала Хаб в полупрозрачную кнопку
    const headerMinBtn = sr.getElementById("cc-toggle-btn");
    if (headerMinBtn) {
      headerMinBtn.textContent = "✕";
      headerMinBtn.title = "Свернуть настройки в плавающую кнопку";
      headerMinBtn.addEventListener("click", (e) => {
        e.stopImmediatePropagation();
        vibrate(12);
        toggleSettingsHub(false);
      }, true);
    }

    sr.getElementById("cc-return-to-game-btn")?.addEventListener("click", () => {
      vibrate(15);
      toggleSettingsHub(false);
    });

    sr.getElementById("cc-select-lichess-btn")?.addEventListener("click", () => {
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
        toggleSettingsHub(false);
      }
    });

    sr.getElementById("cc-select-chesscom-btn")?.addEventListener("click", () => {
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
        toggleSettingsHub(false);
      }
    });

    // На главной странице открываем Лаунчер настроек, а если уже открыта партия — сразу сворачиваем в полупрозрачную кнопку
    const isGameActiveUrl =
      location.pathname.length > 4 &&
      !location.pathname.endsWith("/online") &&
      location.pathname !== "/";
    toggleSettingsHub(!isGameActiveUrl);
  }

  // 6. Прямая загрузка любых .JS скриптов с телефона во вкладке «📜 СКРИПТЫ»
  function patchMobileScriptFilePicker() {
    if (!mainHudShadow) return;
    const picker = mainHudShadow.getElementById("cc-script-file-picker");
    const statusEl = mainHudShadow.getElementById("cc-script-loader-status");
    if (!picker || picker.dataset.androidPatched === "1") return;

    picker.dataset.androidPatched = "1";
    picker.addEventListener("change", (e) => {
      e.stopImmediatePropagation();
      const files = Array.from(e.target.files || []);
      if (files.length === 0) return;

      let loaded = 0;
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
            loaded++;
            if (statusEl) {
              statusEl.textContent = "✅ ЗАГРУЖЕН В ПАМЯТЬ APK: " + file.name;
              statusEl.style.color = "#38b000";
            }
          } catch (err) {
            console.error("[Android Script Loader Error]:", err);
          }
        };
        reader.readAsText(file);
      });
    }, true);
  }

  // 7. Поддержка Touch-перетаскивания для вторых окон пользовательских скриптов (sample.js и др.)
  function enableTouchDragForScriptWindows() {
    const scriptsHost = document.getElementById("cc-userscripts-host");
    if (!scriptsHost || !scriptsHost.shadowRoot) return;
    const sRoot = scriptsHost.shadowRoot;

    sRoot.querySelectorAll(".cc-script-win").forEach((win) => {
      if (win.dataset.touchReady === "1") return;
      win.dataset.touchReady = "1";

      // Адаптируем ширину окна скрипта под экран смартфона
      if (window.innerWidth < 420) {
        win.style.width = Math.min(330, window.innerWidth - 24) + "px";
        win.style.left = "12px";
      }

      const header = win.querySelector(".cc-script-win-header");
      if (!header) return;

      let dragging = false;
      let ox = 0;
      let oy = 0;

      header.addEventListener("touchstart", (e) => {
        if (e.target.tagName === "BUTTON" || e.touches.length !== 1) return;
        dragging = true;
        ox = e.touches[0].clientX - win.offsetLeft;
        oy = e.touches[0].clientY - win.offsetTop;
      }, { passive: true });

      window.addEventListener("touchmove", (e) => {
        if (!dragging || e.touches.length !== 1) return;
        const nx = Math.max(4, Math.min(window.innerWidth - 100, e.touches[0].clientX - ox));
        const ny = Math.max(24, Math.min(window.innerHeight - 60, e.touches[0].clientY - oy));
        win.style.left = nx + "px";
        win.style.top = ny + "px";
      }, { passive: true });

      window.addEventListener("touchend", () => {
        dragging = false;
      });
    });
  }

  // 8. Синхронизация мини-индикатора на плавающей кнопке с данными движка 24/7
  let lastMoveTextOnOrb = "";
  function syncOrbWithHudState() {
    if (!mainHudShadow) return;

    patchMobileScriptFilePicker();
    enableTouchDragForScriptWindows();

    const bestDesc = mainHudShadow.getElementById("cc-best-desc")?.textContent || "";
    const bestEval = mainHudShadow.getElementById("cc-best-eval")?.textContent || "--";
    const autoChk = mainHudShadow.getElementById("cc-auto-master-chk");
    const isAutoOn = Boolean(autoChk && autoChk.checked);

    orbMainBtn.classList.toggle("cc-auto-on", isAutoOn && !isSettingsHubOpen);
    if (!isSettingsHubOpen) {
      orbTitleTxt.textContent = isAutoOn ? "🤖 АВТО" : "⚙️ МЕНЮ";
      orbStatusDot.style.background = isAutoOn ? "#38b000" : "#00f5d4";
      orbStatusDot.style.boxShadow = isAutoOn ? "0 0 8px #38b000" : "0 0 8px #00f5d4";
    }

    const moveMatch = bestDesc.match(/\b([a-h][1-8])\s*→\s*([a-h][1-8])/i);
    if (moveMatch) {
      const mStr = `${moveMatch[1]}→${moveMatch[2]}`;
      if (mStr !== lastMoveTextOnOrb) {
        lastMoveTextOnOrb = mStr;
        pokeOrbActivity();
      }
      orbMovePill.textContent = mStr;
    } else {
      orbMovePill.textContent = currentPlatform === "chesscom" ? "🛡 STEALTH" : "♟️ LICHESS";
    }

    if (bestEval && bestEval !== "--") {
      orbEvalPill.textContent = bestEval;
      orbEvalPill.style.color = bestEval.startsWith("-") ? "#ff4d94" : "#00f5d4";
    }
  }

  setInterval(syncOrbWithHudState, 250);
  pokeOrbActivity();
})();