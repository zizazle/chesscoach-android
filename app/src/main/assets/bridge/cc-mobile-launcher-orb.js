(function () {
  if (window.__ccMobileLauncherOrbInitialized) return;
  window.__ccMobileLauncherOrbInitialized = true;

  let mainHudShadow = null;
  const currentPlatform = location.hostname.includes("chess.com") ? "chesscom" : "lichess";

  // 1. СИНХРОННОЕ ЧТЕНИЕ ПАМЯТИ ANDROID (чтобы при новой партии меню не прыгало ни на миллисекунду)
  let initialStorage = {};
  try {
    if (window.CCAndroidBridge && typeof window.CCAndroidBridge.getStorageJson === "function") {
      const raw = window.CCAndroidBridge.getStorageJson();
      if (raw) initialStorage = JSON.parse(raw);
    }
  } catch (e) {}

  // Режимы отображения: "full" (большое меню), "mini" (перетягиваемое мини-окно), "pill" (маленькая кнопка в углу)
  let uiViewMode = initialStorage.cc_ui_view_mode || "full";
  let lastInGameSubMode = initialStorage.cc_ingame_submode || "mini";

  function saveStatePatch(obj) {
    Object.assign(initialStorage, obj);
    if (window.chrome && window.chrome.storage && window.chrome.storage.local) {
      window.chrome.storage.local.set(obj);
    } else if (window.CCAndroidBridge && typeof window.CCAndroidBridge.saveStoragePatch === "function") {
      window.CCAndroidBridge.saveStoragePatch(JSON.stringify(obj));
    }
  }

  function setUiViewMode(newMode) {
    uiViewMode = newMode;
    if (newMode === "mini" || newMode === "pill") {
      lastInGameSubMode = newMode;
      saveStatePatch({ cc_ui_view_mode: newMode, cc_ingame_submode: newMode });
    } else {
      saveStatePatch({ cc_ui_view_mode: "full" });
    }
    syncVisibilityStates();
  }

  function vibrate(ms = 12) {
    try {
      if (window.CCAndroidBridge && typeof window.CCAndroidBridge.vibrateTick === "function") {
        window.CCAndroidBridge.vibrateTick(ms);
      }
    } catch (e) {}
  }

  // 2. Читаем базовый content.css из APK
  let rawContentCss = "";
  try {
    if (window.CCAndroidBridge && typeof window.CCAndroidBridge.readAssetText === "function") {
      rawContentCss = window.CCAndroidBridge.readAssetText("content/content.css") || "";
    }
  } catch (e) {}

  // 3. Просторный и разгруженный мобильный дизайн для окна настроек
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
    #chesscoach-panel.cc-mobile-hidden {
      display: none !important;
      visibility: hidden !important;
      pointer-events: none !important;
      opacity: 0 !important;
    }
    /* Убираем вкладку АНАЛИЗ из настроек — она вынесена в перетягиваемое мини-окно на доске */
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
      height: 50px !important;
      padding: 0 14px !important;
      flex-shrink: 0 !important;
    }
    #cc-mobile-launcher-bar {
      position: relative !important;
      z-index: 4 !important;
      padding: 12px 14px !important;
      background: rgba(6, 9, 16, 0.95) !important;
      border-bottom: 1px solid rgba(0, 245, 212, 0.22) !important;
      display: flex !important;
      flex-direction: column !important;
      gap: 9px !important;
      flex-shrink: 0 !important;
    }
    .cc-launcher-cards-row {
      display: grid !important;
      grid-template-columns: 1fr 1fr !important;
      gap: 10px !important;
    }
    .cc-platform-card {
      background: rgba(255, 255, 255, 0.05) !important;
      border: 1.5px solid rgba(255, 255, 255, 0.14) !important;
      border-radius: 14px !important;
      padding: 11px 12px !important;
      color: #cbd5e1 !important;
      cursor: pointer !important;
      display: flex !important;
      flex-direction: column !important;
      gap: 4px !important;
      text-align: left !important;
      transition: transform 0.15s ease !important;
    }
    .cc-platform-card:active {
      transform: scale(0.97) !important;
    }
    .cc-platform-card.active-lichess {
      background: linear-gradient(135deg, rgba(0, 245, 212, 0.24), rgba(0, 187, 249, 0.10)) !important;
      border-color: #00f5d4 !important;
      color: #ffffff !important;
      box-shadow: 0 4px 18px rgba(0, 245, 212, 0.22) !important;
    }
    .cc-platform-card.active-chesscom {
      background: linear-gradient(135deg, rgba(56, 176, 0, 0.26), rgba(0, 245, 212, 0.10)) !important;
      border-color: #38b000 !important;
      color: #ffffff !important;
      box-shadow: 0 4px 18px rgba(56, 176, 0, 0.24) !important;
    }
    .cc-platform-card-title {
      font-size: 12px !important;
      font-weight: 900 !important;
      display: flex !important;
      justify-content: space-between !important;
      align-items: center !important;
      pointer-events: none !important;
    }
    .cc-platform-card-sub {
      font-size: 10px !important;
      color: #94a3b8 !important;
      font-weight: 600 !important;
      pointer-events: none !important;
    }
    #cc-return-to-game-btn {
      width: 100% !important;
      padding: 12px 14px !important;
      border-radius: 12px !important;
      border: none !important;
      background: linear-gradient(135deg, #00f5d4, #00bbf9) !important;
      color: #04070e !important;
      font-size: 12.5px !important;
      font-weight: 900 !important;
      letter-spacing: 0.4px !important;
      cursor: pointer !important;
      box-shadow: 0 4px 16px rgba(0, 245, 212, 0.32) !important;
    }
    #cc-mode-switcher-bar {
      position: relative !important;
      z-index: 4 !important;
      padding: 8px 14px !important;
      gap: 8px !important;
      flex-shrink: 0 !important;
    }
    .cc-mode-btn {
      padding: 8px !important;
      font-size: 11px !important;
      border-radius: 10px !important;
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
      padding: 8px 12px !important;
      background: rgba(5, 7, 13, 0.94) !important;
      flex-shrink: 0 !important;
    }
    .cc-nav-list {
      display: flex !important;
      flex-direction: row !important;
      overflow-x: auto !important;
      gap: 8px !important;
      scrollbar-width: none !important;
    }
    .cc-nav-list::-webkit-scrollbar {
      display: none !important;
    }
    .cc-tab-btn {
      white-space: nowrap !important;
      padding: 9px 14px !important;
      font-size: 11.5px !important;
      border-radius: 12px !important;
      flex-shrink: 0 !important;
    }
    .cc-sidebar-footer {
      display: none !important;
    }
    /* Просторный вид внутри вкладок («не как в самолете») */
    .cc-main-view {
      flex: 1 !important;
      min-height: 0 !important;
      overflow-y: auto !important;
      padding: 16px 14px 44px 14px !important;
      gap: 12px !important;
      -webkit-overflow-scrolling: touch !important;
    }
    .cc-tab-pane {
      gap: 12px !important;
    }
    .cc-glass-card {
      padding: 14px !important;
      border-radius: 16px !important;
    }
    .cc-Switch-row {
      padding: 9px 0 !important;
      font-size: 12px !important;
    }
    .cc-control-row {
      font-size: 12px !important;
      margin-bottom: 6px !important;
    }
    .cc-btn {
      padding: 11px 12px !important;
      font-size: 12px !important;
      border-radius: 11px !important;
    }
    /* Аккуратные спойлеры для второстепенных ползунков */
    details.cc-clean-drawer {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.10);
      border-radius: 14px;
      padding: 11px 14px;
      transition: all 0.2s ease;
    }
    details.cc-clean-drawer[open] {
      background: rgba(10, 14, 24, 0.75);
      border-color: rgba(0, 245, 212, 0.32);
    }
    details.cc-clean-drawer summary {
      font-size: 12px;
      font-weight: 800;
      color: #cbd5e1;
      cursor: pointer;
      list-style: none;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    details.cc-clean-drawer summary::-webkit-details-marker {
      display: none;
    }
    details.cc-clean-drawer summary::after {
      content: "Развернуть ▼";
      font-size: 10px;
      color: var(--cc-accent);
      background: rgba(0, 245, 212, 0.12);
      padding: 3px 8px;
      border-radius: 999px;
    }
    details.cc-clean-drawer[open] summary::after {
      content: "Свернуть ▲";
    }
    .cc-drawer-body {
      margin-top: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    /* Карточки быстрых пресетов во вкладке ПРЕСЕТЫ */
    .cc-preset-big-card {
      background: linear-gradient(145deg, rgba(255, 255, 255, 0.07), rgba(255, 255, 255, 0.02));
      border: 1.5px solid rgba(255, 255, 255, 0.14);
      border-radius: 16px;
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      cursor: pointer;
      transition: all 0.2s ease;
    }
    .cc-preset-big-card:active {
      transform: scale(0.98);
    }
    .cc-preset-big-title {
      font-size: 13.5px;
      font-weight: 900;
      color: #ffffff;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .cc-preset-big-desc {
      font-size: 11.5px;
      color: #cbd5e1;
      line-height: 1.4;
    }
  `;

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
    saveStatePatch({ cc_mobile_platform: platformKey });

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

  // 4. ПРИМЕНЕНИЕ ПРЕСЕТА ИЗ ОПРОСА ИЛИ КАРТОЧКИ (С ФИКСИРОВАННЫМИ 3000 ELO)
  function applySmartPresetConfig({ mode = "legit", speed = "blitz", arrows = "curved_neon" }) {
    vibrate(25);
    const isHvh = mode === "hvh";
    const isBalanced = mode === "balance";

    const delayBySpeed = speed === "bullet" ? (isHvh ? 38 : 220) : (speed === "rapid" ? 680 : 440);
    const jitterBySpeed = speed === "bullet" ? (isHvh ? 15 : 90) : (speed === "rapid" ? 320 : 210);

    const patch = {
      elo: 3000,
      useStockfishWasm: true,
      workMode: isHvh ? "hvh" : (isBalanced ? "all" : "legit"),
      style: isHvh ? "balanced" : (isBalanced ? "hikaru" : "tal"),
      autoMoveEnabled: true,
      bulletTurboMode: Boolean(isHvh && speed === "bullet"),
      legitAutoTiming: !isHvh,
      premoveEnabled: isHvh || (isBalanced && speed === "bullet"),
      showPremoveArrows: isHvh || isBalanced,
      useAverageMoveSometimes: !isHvh,
      averageMoveFrequency: isBalanced ? 18 : 28,
      protectCriticalMoves: true,
      autoMoveDelayMs: delayBySpeed,
      autoMoveJitterMs: jitterBySpeed,
      arrowStyle: arrows,
      showArrows: true,
      showEvalBar: true
    };

    saveStatePatch(patch);

    // Мгновенно синхронизируем ползунки и кнопки внутри открытого меню без перезагрузки
    if (mainHudShadow) {
      const targetMode = currentPlatform === "chesscom" && isHvh ? "legit" : patch.workMode;
      const modeBtn = mainHudShadow.querySelector(`.cc-mode-btn[data-mode="${targetMode}"]`);
      if (modeBtn) modeBtn.click();

      const eloSlider = mainHudShadow.getElementById("cc-elo-slider");
      if (eloSlider) {
        eloSlider.value = "3000";
        eloSlider.dispatchEvent(new Event("input"));
        eloSlider.dispatchEvent(new Event("change"));
      }

      const styleBtn = mainHudShadow.querySelector(`.cc-style-btn[data-style="${patch.style}"]`);
      if (styleBtn) styleBtn.click();

      const arrowSel = mainHudShadow.getElementById("cc-vis-arrow-style");
      if (arrowSel) {
        arrowSel.value = arrows;
        arrowSel.dispatchEvent(new Event("change"));
      }

      const delaySlider = mainHudShadow.getElementById("cc-auto-delay-slider");
      if (delaySlider) {
        delaySlider.value = String(delayBySpeed);
        delaySlider.dispatchEvent(new Event("input"));
      }

      const jitterSlider = mainHudShadow.getElementById("cc-auto-jitter-slider");
      if (jitterSlider) {
        jitterSlider.value = String(jitterBySpeed);
        jitterSlider.dispatchEvent(new Event("input"));
      }
    }
  }

  // 5. ПЕРЕХВАТ SHADOW ROOT И РЕОРГАНИЗАЦИЯ МЕНЮ НА ПРОСТОРНЫЕ ВКЛАДКИ
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
          // Сразу применяем сохраненный режим видимости, чтобы ничего не моргнуло
          if (uiViewMode !== "full") {
            panel.classList.add("cc-mobile-hidden");
          }
          setupMobileSettingsHub(sr, panel);
        }
      });
      obs.observe(sr, { childList: true });
    }
    return sr;
  };

  function declutterAndReorganizeTabs(sr) {
    const navList = sr.querySelector(".cc-nav-list");
    const mainView = sr.querySelector(".cc-main-view");
    if (!navList || !mainView || sr.getElementById("cc-pane-presets")) return;

    // Переименовываем старые вкладки покороче и понятнее
    const tabLabels = {
      automove: '<span class="cc-tab-icon">🤖</span> АВТОХОД',
      rage: '<span class="cc-tab-icon">⚡</span> СТИЛЬ & ELO',
      visuals: '<span class="cc-tab-icon">✦</span> СТРЕЛКИ',
      misc: '<span class="cc-tab-icon">❖</span> КОНФИГИ'
    };
    Object.entries(tabLabels).forEach(([tabId, html]) => {
      const btn = navList.querySelector(`.cc-tab-btn[data-tab="${tabId}"]`);
      if (btn) btn.innerHTML = html;
    });

    // 5.1. Создаем новую первую вкладку «🎯 ПРЕСЕТЫ» (Быстрые профили + кнопка Опроса)
    const presetsTabBtn = document.createElement("button");
    presetsTabBtn.type = "button";
    presetsTabBtn.className = "cc-tab-btn";
    presetsTabBtn.dataset.tab = "presets";
    presetsTabBtn.innerHTML = '<span class="cc-tab-icon">🎯</span> ПРЕСЕТЫ';
    navList.prepend(presetsTabBtn);

    const presetsPane = document.createElement("div");
    presetsPane.className = "cc-tab-pane";
    presetsPane.id = "cc-pane-presets";
    presetsPane.innerHTML = `
      <div class="cc-glass-card" style="border-left: 4px solid #00f5d4; background: linear-gradient(135deg, rgba(0,245,212,0.14), rgba(0,187,249,0.06));">
        <div class="cc-section-title">
          <span>🧭 АВТО-КАЛИБРОВКА ПОД ВАШ СТИЛЬ (3000 ELO)</span>
        </div>
        <div style="font-size:11.5px; color:#cbd5e1; line-height:1.42; margin-bottom:10px;">
          Ответьте на 3 быстрых вопроса — и приложение само выставит идеальные тайминги, режим и визуал под вашу игру:
        </div>
        <button type="button" class="cc-btn cc-btn-primary" id="cc-run-survey-again-btn" style="width:100%;">
          ✨ ЗАПУСТИТЬ ОПРОС-НАСТРОЙКУ
        </button>
      </div>

      <div class="cc-preset-big-card" id="cc-quick-preset-legit" style="border-color: rgba(56, 176, 0, 0.55);">
        <div class="cc-preset-big-title">
          <span style="color:#70e000;">🛡 ПРЕСЕТ: LEGIT STEALTH (3000 ELO)</span>
          <span class="cc-badge" style="background:#38b000; color:#fff;">БЕЗ БАНА</span>
        </div>
        <div class="cc-preset-big-desc">
          Стиль Михаила Таля, плавные кривые Безье, живые паузы под часы и подмешивание 2-й линии для обхода античита.
        </div>
      </div>

      <div class="cc-preset-big-card" id="cc-quick-preset-hvh" style="border-color: rgba(255, 42, 133, 0.55);">
        <div class="cc-preset-big-title">
          <span style="color:#ff4d94;">⚡ ПРЕСЕТ: HvH РЕЗНЯ 1+0 (3000 ELO)</span>
          <span class="cc-badge" style="background:#ff2a85; color:#fff;">ТУРБО</span>
        </div>
        <div class="cc-preset-big-desc">
          Чистый Stockfish 3000 + таблицы Syzygy, мгновенный автоход 38 мс и умные SEE-премувы без потери времени.
        </div>
      </div>

      <div class="cc-preset-big-card" id="cc-quick-preset-balance" style="border-color: rgba(0, 245, 212, 0.55);">
        <div class="cc-preset-big-title">
          <span style="color:#00f5d4;">⚖️ ПРЕСЕТ: БАЛАНС LEGIT + HVH (3000 ELO)</span>
          <span class="cc-badge">УНИВЕРСАЛ</span>
        </div>
        <div class="cc-preset-big-desc">
          Стиль Хикару Накамуры для блица: быстрые человеческие ходы + страховка в критических позициях и цейтноте.
        </div>
      </div>
    `;
    mainView.prepend(presetsPane);

    // 5.2. Создаем отдельную вкладку «🖼️ ОБОИ» и переносим туда карточки фона и темы из перегруженной вкладки Визуал
    const wallTabBtn = document.createElement("button");
    wallTabBtn.type = "button";
    wallTabBtn.className = "cc-tab-btn";
    wallTabBtn.dataset.tab = "wallpaper";
    wallTabBtn.innerHTML = '<span class="cc-tab-icon">🖼️</span> ОБОИ & ТЕМЫ';

    const visualsBtn = navList.querySelector('.cc-tab-btn[data-tab="visuals"]');
    if (visualsBtn && visualsBtn.nextSibling) {
      navList.insertBefore(wallTabBtn, visualsBtn.nextSibling);
    } else {
      navList.appendChild(wallTabBtn);
    }

    const wallPane = document.createElement("div");
    wallPane.className = "cc-tab-pane";
    wallPane.id = "cc-pane-wallpaper";
    mainView.appendChild(wallPane);

    const uploadBgBtn = sr.getElementById("cc-upload-bg-btn");
    if (uploadBgBtn) {
      const bgCard = uploadBgBtn.closest(".cc-glass-card");
      if (bgCard) wallPane.appendChild(bgCard);
    }
    const themeSelect = sr.getElementById("cc-vis-theme");
    if (themeSelect) {
      const themeCard = themeSelect.closest(".cc-glass-card");
      if (themeCard) wallPane.appendChild(themeCard);
    }

    // 5.3. Прячем сложные ползунки во вкладке АВТОХОД в аккуратный спойлер «Тонкая настройка»
    const autoPane = sr.getElementById("cc-pane-automove");
    if (autoPane) {
      const delaySlider = sr.getElementById("cc-auto-delay-slider");
      const avgChk = sr.getElementById("cc-auto-avg-chk");
      if (delaySlider && avgChk) {
        const cardA = delaySlider.closest(".cc-glass-card");
        const cardB = avgChk.closest(".cc-glass-card");
        if (cardA && cardB && cardA !== cardB) {
          const drawer = document.createElement("details");
          drawer.className = "cc-clean-drawer";
          drawer.innerHTML = `<summary>🎛 Тонкая настройка задержек и 2-й линии</summary><div class="cc-drawer-body"></div>`;
          const body = drawer.querySelector(".cc-drawer-body");
          cardA.parentNode.insertBefore(drawer, cardB);
          body.appendChild(cardB);
        }
      }
    }

    // 5.4. Прячем второстепенные технические галочки во вкладке СТИЛЬ & ELO в спойлер
    const ragePane = sr.getElementById("cc-pane-rage");
    if (ragePane) {
      const wasmChk = sr.getElementById("cc-sf-wasm-chk");
      const turnSel = sr.getElementById("cc-turn-select");
      if (wasmChk && turnSel) {
        const wasmCard = wasmChk.closest(".cc-glass-card");
        const turnCard = turnSel.closest(".cc-glass-card");
        if (wasmCard && turnCard) {
          const drawer = document.createElement("details");
          drawer.className = "cc-clean-drawer";
          drawer.innerHTML = `<summary>📡 Доп. модули (WASM, Звук, Анти-Бан)</summary><div class="cc-drawer-body"></div>`;
          const body = drawer.querySelector(".cc-drawer-body");
          ragePane.appendChild(drawer);
          body.appendChild(wasmCard);
          body.appendChild(turnCard);
          const avgCard = sr.getElementById("cc-show-avg-chk")?.closest(".cc-glass-card");
          if (avgCard) body.appendChild(avgCard);
        }
      }
    }

    // Привязываем переключение для новых вкладок
    const activateCustomTab = (targetBtn, targetPane) => {
      sr.querySelectorAll(".cc-tab-btn").forEach((b) => b.classList.toggle("active", b === targetBtn));
      sr.querySelectorAll(".cc-tab-pane").forEach((p) => p.classList.toggle("active", p === targetPane));
    };

    presetsTabBtn.addEventListener("click", () => activateCustomTab(presetsTabBtn, presetsPane));
    wallTabBtn.addEventListener("click", () => activateCustomTab(wallTabBtn, wallPane));

    sr.querySelectorAll(".cc-tab-btn").forEach((btn) => {
      if (btn !== presetsTabBtn && btn !== wallTabBtn) {
        btn.addEventListener("click", () => {
          presetsTabBtn.classList.remove("active");
          presetsPane.classList.remove("active");
          wallTabBtn.classList.remove("active");
          wallPane.classList.remove("active");
        });
      }
    });

    // Обработчики карточек во вкладке «🎯 ПРЕСЕТЫ»
    bindReliableMobileTap(presetsPane.querySelector("#cc-run-survey-again-btn"), () => {
      openOnboardingSurveyModal(true);
    });
    bindReliableMobileTap(presetsPane.querySelector("#cc-quick-preset-legit"), () => {
      applySmartPresetConfig({ mode: "legit", speed: "blitz", arrows: "curved_neon" });
      setUiViewMode(lastInGameSubMode);
    });
    bindReliableMobileTap(presetsPane.querySelector("#cc-quick-preset-hvh"), () => {
      applySmartPresetConfig({ mode: "hvh", speed: "bullet", arrows: "sq_cyber_frame" });
      setUiViewMode(lastInGameSubMode);
    });
    bindReliableMobileTap(presetsPane.querySelector("#cc-quick-preset-balance"), () => {
      applySmartPresetConfig({ mode: "balance", speed: "blitz", arrows: "curved_neon" });
      setUiViewMode(lastInGameSubMode);
    });
  }

  function ensureNonAnalyzerTabSelected(sr) {
    if (!sr) return;
    const activeBtn = sr.querySelector(".cc-tab-btn.active");
    if (!activeBtn || activeBtn.dataset.tab === "analyzer") {
      const presetsBtn = sr.querySelector('.cc-tab-btn[data-tab="presets"]') || sr.querySelector('.cc-tab-btn[data-tab="automove"]');
      if (presetsBtn) presetsBtn.click();
    }
  }

  function setupMobileSettingsHub(sr, panel) {
    shieldFromBoardBleedThrough(panel);
    declutterAndReorganizeTabs(sr);

    const isChessCom = currentPlatform === "chesscom";
    const launcherBar = document.createElement("div");
    launcherBar.id = "cc-mobile-launcher-bar";
    launcherBar.innerHTML = `
      <div class="cc-launcher-cards-row">
        <button type="button" class="cc-platform-card ${!isChessCom ? "active-lichess" : ""}" id="cc-select-lichess-btn">
          <div class="cc-platform-card-title">
            <span>♟️ LICHESS.ORG</span>
            <span style="font-size:9px; color:${!isChessCom ? "#00f5d4" : "#94a3b8"};">${!isChessCom ? "● ОТКРЫТ" : "ПЕРЕЙТИ ➔"}</span>
          </div>
          <div class="cc-platform-card-sub">⚡ HvH • Премувы • Legit</div>
        </button>

        <button type="button" class="cc-platform-card ${isChessCom ? "active-chesscom" : ""}" id="cc-select-chesscom-btn">
          <div class="cc-platform-card-title">
            <span>🛡️ CHESS.COM</span>
            <span style="font-size:9px; color:${isChessCom ? "#70e000" : "#94a3b8"};">${isChessCom ? "● ОТКРЫТ" : "ПЕРЕЙТИ ➔"}</span>
          </div>
          <div class="cc-platform-card-sub">🎯 Безье • T1% Лимитер</div>
        </button>
      </div>
      <button type="button" id="cc-return-to-game-btn">
        🎮 ВЕРНУТЬСЯ К ДОСКЕ ${isChessCom ? "CHESS.COM" : "LICHESS.ORG"}
      </button>
    `;

    const modeBar = sr.getElementById("cc-mode-switcher-bar");
    if (modeBar) {
      panel.insertBefore(launcherBar, modeBar);
    } else {
      panel.prepend(launcherBar);
    }

    const headerCloseBtn = sr.getElementById("cc-toggle-btn");
    if (headerCloseBtn) {
      headerCloseBtn.textContent = "✕ К ДОСКЕ";
      bindReliableMobileTap(headerCloseBtn, () => {
        vibrate(14);
        setUiViewMode(lastInGameSubMode);
      });
    }

    bindReliableMobileTap(sr.getElementById("cc-return-to-game-btn"), () => {
      vibrate(14);
      setUiViewMode(lastInGameSubMode);
    });

    const lichessBtn = sr.getElementById("cc-select-lichess-btn");
    bindReliableMobileTap(lichessBtn, () => {
      if (!location.hostname.includes("lichess.org")) {
        navigateToPlatform("lichess", "https://lichess.org/", lichessBtn);
      } else {
        vibrate(14);
        setUiViewMode(lastInGameSubMode);
      }
    });

    const chesscomBtn = sr.getElementById("cc-select-chesscom-btn");
    bindReliableMobileTap(chesscomBtn, () => {
      if (!location.hostname.includes("chess.com")) {
        navigateToPlatform("chesscom", "https://www.chess.com/play/online", chesscomBtn);
      } else {
        vibrate(14);
        setUiViewMode(lastInGameSubMode);
      }
    });

    setTimeout(() => ensureNonAnalyzerTabSelected(sr), 20);
    syncVisibilityStates();
  }

  // 6. MINIHUD + УГЛОВАЯ КНОПКА + СПЛЭШ «ДОБРО ПОЖАЛОВАТЬ!» + ОПРОС-КАЛИБРОВКА
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
      @keyframes cc-welcome-bar-anim {
        0% { width: 0%; }
        100% { width: 100%; }
      }
      @keyframes cc-float-logo {
        0%, 100% { transform: translateY(0px) scale(1); }
        50% { transform: translateY(-6px) scale(1.04); }
      }

      /* 1. ЕЖЕДНЕВНЫЙ ЭКРАН «ДОБРО ПОЖАЛОВАТЬ!» (1 РАЗ В ДЕНЬ НА 2.4 СЕК) */
      #cc-daily-welcome-splash {
        position: fixed;
        inset: 0;
        background: radial-gradient(circle at 50% 35%, #11192e 0%, #06080f 75%);
        display: none;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 28px;
        text-align: center;
        pointer-events: auto;
        z-index: 2147483647;
        opacity: 1;
        transition: opacity 0.45s cubic-bezier(0.16, 1, 0.3, 1), transform 0.45s cubic-bezier(0.16, 1, 0.3, 1);
      }
      #cc-daily-welcome-splash.cc-fade-out {
        opacity: 0;
        transform: scale(1.05);
        pointer-events: none;
      }
      .cc-welcome-emblem {
        width: 78px;
        height: 78px;
        border-radius: 24px;
        background: linear-gradient(135deg, rgba(0, 245, 212, 0.22), rgba(199, 125, 255, 0.22));
        border: 2px solid #00f5d4;
        box-shadow: 0 0 40px rgba(0, 245, 212, 0.45);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 38px;
        margin-bottom: 18px;
        animation: cc-float-logo 2.2s ease-in-out infinite;
      }
      .cc-welcome-h1 {
        font-size: 26px;
        font-weight: 900;
        color: #ffffff;
        letter-spacing: 0.5px;
        margin-bottom: 6px;
        background: linear-gradient(90deg, #ffffff, #00f5d4, #c77dff);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
      }
      .cc-welcome-subtext {
        font-size: 13px;
        color: #94a3b8;
        font-weight: 600;
        max-width: 280px;
        line-height: 1.4;
        margin-bottom: 24px;
      }
      .cc-welcome-progress-track {
        width: 200px;
        height: 5px;
        background: rgba(255, 255, 255, 0.1);
        border-radius: 999px;
        overflow: hidden;
      }
      .cc-welcome-progress-fill {
        height: 100%;
        background: linear-gradient(90deg, #00f5d4, #00bbf9, #c77dff);
        animation: cc-welcome-bar-anim 2.2s cubic-bezier(0.22, 1, 0.36, 1) forwards;
      }

      /* 2. ОДНОРАЗОВЫЙ ОПРОС-КАЛИБРОВКА ПОСЛЕ УСТАНОВКИ (3000 ELO FIXED) */
      #cc-onboarding-modal {
        position: fixed;
        inset: 0;
        background: rgba(5, 8, 15, 0.94);
        backdrop-filter: blur(22px);
        -webkit-backdrop-filter: blur(22px);
        display: none;
        flex-direction: column;
        justify-content: center;
        padding: 20px;
        pointer-events: auto;
        z-index: 2147483647;
      }
      .cc-survey-box {
        width: 100%;
        max-width: 400px;
        margin: 0 auto;
        background: rgba(12, 16, 28, 0.96);
        border: 1.5px solid rgba(0, 245, 212, 0.45);
        border-radius: 22px;
        padding: 20px 18px;
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.85), 0 0 30px rgba(0, 245, 212, 0.18);
        display: flex;
        flex-direction: column;
        gap: 14px;
      }
      .cc-survey-step-badge {
        align-self: flex-start;
        font-size: 10px;
        font-weight: 900;
        color: #05070c;
        background: linear-gradient(135deg, #00f5d4, #00bbf9);
        padding: 3px 10px;
        border-radius: 999px;
      }
      .cc-survey-question {
        font-size: 18px;
        font-weight: 900;
        color: #ffffff;
        line-height: 1.25;
      }
      .cc-survey-hint {
        font-size: 11.5px;
        color: #94a3b8;
        margin-top: -6px;
      }
      .cc-survey-options {
        display: flex;
        flex-direction: column;
        gap: 9px;
      }
      .cc-survey-opt-btn {
        background: rgba(255, 255, 255, 0.05);
        border: 1.5px solid rgba(255, 255, 255, 0.14);
        border-radius: 14px;
        padding: 12px 14px;
        color: #f8fafc;
        text-align: left;
        cursor: pointer;
        display: flex;
        flex-direction: column;
        gap: 3px;
        transition: all 0.15s ease;
      }
      .cc-survey-opt-btn:active {
        transform: scale(0.98);
        border-color: #00f5d4;
        background: rgba(0, 245, 212, 0.15);
      }
      .cc-survey-opt-title {
        font-size: 13px;
        font-weight: 900;
        color: #00f5d4;
      }
      .cc-survey-opt-sub {
        font-size: 11px;
        color: #cbd5e1;
        line-height: 1.35;
      }

      /* 3. ПЕРЕТЯГИВАЕМОЕ МИНИ-ОКНО ЛУЧШЕГО ХОДА И ОБОСНОВАНИЯ */
      #cc-mini-hud-card {
        position: fixed;
        top: 54px;
        left: 10px;
        width: 274px;
        background: rgba(8, 12, 20, 0.86);
        backdrop-filter: blur(16px) saturate(180%);
        -webkit-backdrop-filter: blur(16px) saturate(180%);
        border: 1.5px solid rgba(0, 245, 212, 0.55);
        border-radius: 15px;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.8), 0 0 16px rgba(0, 245, 212, 0.2);
        color: #f8fafc;
        pointer-events: auto;
        touch-action: none;
        z-index: 2147483646;
        overflow: hidden;
        display: none;
      }
      .cc-mini-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 6px 9px;
        background: rgba(4, 7, 13, 0.92);
        border-bottom: 1px solid rgba(255, 255, 255, 0.09);
      }
      .cc-mini-status {
        display: flex;
        align-items: center;
        gap: 5px;
        font-size: 9.5px;
        font-weight: 900;
        color: #00f5d4;
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
        gap: 5px;
      }
      .cc-mini-btn {
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.18);
        color: #f1f5f9;
        border-radius: 7px;
        height: 24px;
        padding: 0 8px;
        font-size: 10px;
        font-weight: 900;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
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
        padding: 8px 10px;
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
        line-height: 1.34;
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
      }

      /* 4. МАЛЕНЬКАЯ ПОЛУПРОЗРАЧНАЯ КНОПКА В УГЛУ (РЕЖИМ PILL) */
      #cc-corner-pill {
        position: fixed;
        top: 62px;
        right: 10px;
        display: none;
        align-items: center;
        gap: 5px;
        pointer-events: auto;
        touch-action: none;
        z-index: 2147483646;
        opacity: 0.72;
      }
      .cc-corner-btn {
        height: 40px;
        padding: 0 11px;
        border-radius: 13px;
        background: rgba(8, 12, 20, 0.88);
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

    <!-- Ежедневный экран приветствия (1 раз в сутки) -->
    <div id="cc-daily-welcome-splash">
      <div class="cc-welcome-emblem">♟️</div>
      <div class="cc-welcome-h1">Добро пожаловать!</div>
      <div class="cc-welcome-subtext" id="cc-daily-welcome-sub">
        Инициализация тактического ядра ChessCoach 3000 ELO...
      </div>
      <div class="cc-welcome-progress-track">
        <div class="cc-welcome-progress-fill"></div>
      </div>
    </div>

    <!-- Одноразовый опрос-калибровка (1 раз после скачивания) -->
    <div id="cc-onboarding-modal">
      <div class="cc-survey-box">
        <span class="cc-survey-step-badge" id="cc-survey-step-tag">ШАГ 1 ИЗ 3 • КАЛИБРОВКА 3000 ELO</span>
        <div class="cc-survey-question" id="cc-survey-q-title">Как вы предпочитаете играть?</div>
        <div class="cc-survey-hint" id="cc-survey-q-hint">На основе ваших ответов софт сам настроит тайминги и защиту (настройки всегда можно поменять).</div>
        <div class="cc-survey-options" id="cc-survey-opts-list"></div>
      </div>
    </div>

    <!-- Перетягиваемое мини-окно анализа -->
    <div id="cc-mini-hud-card">
      <div class="cc-mini-header">
        <div class="cc-mini-status">
          <span class="cc-mini-dot" id="cc-mini-dot"></span>
          <span id="cc-mini-turn-txt">АНАЛИЗ ДОСКИ</span>
        </div>
        <div class="cc-mini-actions">
          <button type="button" class="cc-mini-btn cc-mini-btn-play" id="cc-mini-play-btn">⚡ ХОД</button>
          <button type="button" class="cc-mini-btn" id="cc-mini-settings-btn">⚙️ МЕНЮ</button>
          <button type="button" class="cc-mini-btn cc-mini-btn-close" id="cc-mini-close-btn">✕</button>
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
        <div id="cc-mini-tech-reason">Откройте партию или сделайте ход для мгновенного расчета.</div>
        <div id="cc-mini-pv-line">◈ 3000 ELO • Готов</div>
      </div>
    </div>

    <!-- Свернутая угловая кнопка -->
    <div id="cc-corner-pill">
      <button type="button" class="cc-corner-btn" id="cc-corner-restore-hud-btn">
        <span>👁️</span>
        <span id="cc-corner-move-short">АНАЛИЗ</span>
      </button>
      <button type="button" class="cc-corner-btn" id="cc-corner-open-settings-btn" style="border-color:#c77dff; color:#c77dff;">
        <span>⚙️</span>
      </button>
    </div>
  `;
  hudShadow.appendChild(container);

  const welcomeSplash = hudShadow.getElementById("cc-daily-welcome-splash");
  const onboardingModal = hudShadow.getElementById("cc-onboarding-modal");
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

  // Защита от проваливания кликов сквозь все наши оверлеи на шахматный сайт
  [welcomeSplash, onboardingModal, miniHudCard, cornerPill].forEach((node) => {
    ["mousedown", "mousemove", "mouseup", "pointerdown", "pointermove", "pointerup", "click", "dblclick", "contextmenu"].forEach((evName) => {
      node.addEventListener(evName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      }, { passive: false });
    });
  });

  // 7. ЛОГИКА ЕЖЕДНЕВНОГО ПРИВЕТСТВИЯ (1 РАЗ В СУТКИ НА 2.4 СЕКУНДЫ)
  function checkAndRunDailyWelcome() {
    const now = new Date();
    const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const lastDate = initialStorage.cc_last_welcome_date || "";

    if (lastDate === todayKey) {
      checkAndRunFirstTimeSurvey();
      return;
    }

    // Сразу записываем сегодняшнюю дату, чтобы в течение дня приветствие больше не появлялось
    saveStatePatch({ cc_last_welcome_date: todayKey });

    const hour = now.getHours();
    const timeGreeting =
      hour >= 5 && hour < 12 ? "Доброе утро! Ядро 3000 ELO заряжено на победы." :
      hour >= 12 && hour < 18 ? "Продуктивного дня! Тактический радар готов к работе." :
      hour >= 18 && hour < 23 ? "Добрый вечер! Все системы работают на максимуме." :
      "Ночная сессия! Стелс-модули и Stockfish WASM активны.";

    const subEl = hudShadow.getElementById("cc-daily-welcome-sub");
    if (subEl) subEl.textContent = timeGreeting;

    welcomeSplash.style.display = "flex";
    vibrate(18);

    setTimeout(() => {
      welcomeSplash.classList.add("cc-fade-out");
      setTimeout(() => {
        welcomeSplash.style.display = "none";
        welcomeSplash.classList.remove("cc-fade-out");
        checkAndRunFirstTimeSurvey();
      }, 450);
    }, 2350);
  }

  // 8. ЛОГИКА ОДНОРАЗОВОГО ОПРОСА-КАЛИБРОВКИ (ТОЛЬКО 1 РАЗ ПОСЛЕ СКАЧИВАНИЯ)
  const SURVEY_STEPS = [
    {
      stepTag: "ШАГ 1 ИЗ 3 • ВЫБОР РЕЖИМА (3000 ELO)",
      question: "Как вы предпочитаете играть?",
      hint: "Сила движка фиксирована на максимуме (3000 ELO). Выберите характер работы автохода:",
      key: "mode",
      options: [
        {
          value: "legit",
          title: "🛡 Легитно (Стелс без бана)",
          sub: "Плавные кривые Безье, живые человеческие паузы и защита от детекта T1%."
        },
        {
          value: "hvh",
          title: "⚡ HvH (Резня на максималках)",
          sub: "Мгновенный ход за 38 мс, умные SEE-премувы и тотальное доминирование."
        },
        {
          value: "balance",
          title: "⚖️ Баланс (Переключение Legit / HvH)",
          sub: "Универсальная настройка: легитный ритм + турбо-ускорение в цейтноте."
        }
      ]
    },
    {
      stepTag: "ШАГ 2 ИЗ 3 • ТАЙМИНГИ ЧАСОВ",
      question: "Какой контроль времени вы играете чаще?",
      hint: "Подстроим скорость реакции и разброс времени руки:",
      key: "speed",
      options: [
        {
          value: "bullet",
          title: "🚀 Пуля (1+0 / 2+1)",
          sub: "Молниеносный отклик и активная помощь премувами."
        },
        {
          value: "blitz",
          title: "⚡ Блиц (3+0 / 3+2 / 5+0)",
          sub: "Естественный темп сильного игрока с радаром ловушек."
        },
        {
          value: "rapid",
          title: "🕰 Рапид (10+0 и дольше)",
          sub: "Вдумчивые паузы на сложных тактических позициях."
        }
      ]
    },
    {
      stepTag: "ШАГ 3 ИЗ 3 • ВИЗУАЛ НА ДОСКЕ",
      question: "Как отображать подсказки на доске?",
      hint: "Выберите самый удобный визуальный стиль:",
      key: "arrows",
      options: [
        {
          value: "curved_neon",
          title: "🌈 Неоновые дуги",
          sub: "Красивые плавные векторные стрелки с анимацией потока."
        },
        {
          value: "sq_cyber_frame",
          title: "🔲 Рамки клеток (Без стрелок)",
          sub: "Четкая подсветка квадратов ОТКУДА ➔ КУДА, не перекрывающая фигуры."
        },
        {
          value: "sq_minimal_dots",
          title: "⚫ Минималистичные стелс-точки",
          sub: "Аккуратные точки на целевых клетках без лишнего шума."
        }
      ]
    }
  ];

  let surveyAnswers = { mode: "legit", speed: "blitz", arrows: "curved_neon" };

  function openOnboardingSurveyModal(forceOpen = false) {
    if (!forceOpen && initialStorage.cc_onboarding_done) return;
    let currentStepIdx = 0;

    const stepTagEl = hudShadow.getElementById("cc-survey-step-tag");
    const qTitleEl = hudShadow.getElementById("cc-survey-q-title");
    const qHintEl = hudShadow.getElementById("cc-survey-q-hint");
    const optsListEl = hudShadow.getElementById("cc-survey-opts-list");

    const renderStep = (idx) => {
      const stepObj = SURVEY_STEPS[idx];
      stepTagEl.textContent = stepObj.stepTag;
      qTitleEl.textContent = stepObj.question;
      qHintEl.textContent = stepObj.hint;
      optsListEl.innerHTML = "";

      stepObj.options.forEach((opt) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "cc-survey-opt-btn";
        btn.innerHTML = `
          <div class="cc-survey-opt-title">${opt.title}</div>
          <div class="cc-survey-opt-sub">${opt.sub}</div>
        `;
        bindReliableMobileTap(btn, () => {
          vibrate(15);
          surveyAnswers[stepObj.key] = opt.value;
          if (idx + 1 < SURVEY_STEPS.length) {
            renderStep(idx + 1);
          } else {
            onboardingModal.style.display = "none";
            saveStatePatch({ cc_onboarding_done: true });
            applySmartPresetConfig(surveyAnswers);
          }
        });
        optsListEl.appendChild(btn);
      });
    };

    onboardingModal.style.display = "flex";
    renderStep(0);
  }

  function checkAndRunFirstTimeSurvey() {
    if (!initialStorage.cc_onboarding_done) {
      openOnboardingSurveyModal(false);
    }
  }

  // 9. ПЕРЕТЯГИВАНИЕ МИНИ-ОКНА И СОХРАНЕНИЕ ЕГО КООРДИНАТ
  if (initialStorage.cc_mini_hud_pos) {
    const x = Math.max(6, Math.min(window.innerWidth - 280, Number(initialStorage.cc_mini_hud_pos.left) || 10));
    const y = Math.max(24, Math.min(window.innerHeight - 110, Number(initialStorage.cc_mini_hud_pos.top) || 54));
    miniHudCard.style.left = x + "px";
    miniHudCard.style.top = y + "px";
  }

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
      saveStatePatch({
        cc_mini_hud_pos: { left: rect.left, top: rect.top }
      });
    }
  }, { passive: true });

  // Кнопки переключения между 3 состояниями ("full" <-> "mini" <-> "pill") с запоминанием в память
  bindReliableMobileTap(miniPlayBtn, () => {
    vibrate(18);
    if (mainHudShadow) {
      const playOnceBtn = mainHudShadow.getElementById("cc-play-once");
      if (playOnceBtn) playOnceBtn.click();
    }
  });

  bindReliableMobileTap(miniSettingsBtn, () => {
    vibrate(14);
    setUiViewMode("full");
  });

  bindReliableMobileTap(miniCloseBtn, () => {
    vibrate(12);
    setUiViewMode("pill");
  });

  bindReliableMobileTap(cornerRestoreBtn, () => {
    vibrate(14);
    setUiViewMode("mini");
  });

  bindReliableMobileTap(cornerSettingsBtn, () => {
    vibrate(14);
    setUiViewMode("full");
  });

  function syncVisibilityStates() {
    if (!mainHudShadow) return;
    const panel = mainHudShadow.getElementById("chesscoach-panel");
    if (!panel) return;

    if (uiViewMode === "full") {
      panel.classList.remove("cc-mobile-hidden");
      panel.classList.remove("cc-minimized");
      ensureNonAnalyzerTabSelected(mainHudShadow);
      miniHudCard.style.display = "none";
      cornerPill.style.display = "none";
    } else if (uiViewMode === "mini") {
      panel.classList.add("cc-mobile-hidden");
      miniHudCard.style.display = "block";
      cornerPill.style.display = "none";
    } else {
      // Режим "pill" (максимально скрыто до маленькой угловой кнопки)
      panel.classList.add("cc-mobile-hidden");
      miniHudCard.style.display = "none";
      cornerPill.style.display = "flex";
    }
  }

  window.__ccHandleAndroidBack = function () {
    if (uiViewMode === "full") {
      setUiViewMode(lastInGameSubMode);
      return true;
    }
    return false;
  };

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

  // 10. СИНХРОНИЗАЦИЯ ДАННЫХ МИНИ-ОКНА И СОХРАНЕННОГО ВИДА КАЖДЫЕ 200 МС
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

    const wMatch = wdlText.match(/Поб:\s*(\d+%)/i);
    if (wMatch) {
      miniWdlPill.textContent = "Поб " + wMatch[1];
    }

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

  // Запускаем проверку ежедневного приветствия и одноразового опроса
  checkAndRunDailyWelcome();
})();