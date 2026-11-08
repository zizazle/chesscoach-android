(function () {
  if (window.__ccAndroidPolyfillLoaded) return;
  window.__ccAndroidPolyfillLoaded = true;

  console.log("[ChessCoach Android] Инициализация моста полифилла v15.3...");

  // 1. Эмуляция chrome.storage.local через AndroidBridge
  let memoryCache = {};
  try {
    if (window.CCAndroidBridge && typeof window.CCAndroidBridge.getStorageJson === "function") {
      const raw = window.CCAndroidBridge.getStorageJson();
      if (raw) memoryCache = JSON.parse(raw);
    }
  } catch (e) {
    console.error("[Polyfill] Ошибка чтения хранилища:", e);
  }

  function flushStorageToNative() {
    try {
      if (window.CCAndroidBridge && typeof window.CCAndroidBridge.saveStoragePatch === "function") {
        window.CCAndroidBridge.saveStoragePatch(JSON.stringify(memoryCache));
      }
    } catch (e) {}
  }

  if (typeof chrome === "undefined") {
    window.chrome = {};
  }

  window.chrome.storage = {
    local: {
      get(keys, callback) {
        setTimeout(() => {
          if (!keys) {
            if (callback) callback({ ...memoryCache });
            return;
          }
          const res = {};
          const list = Array.isArray(keys) ? keys : [keys];
          list.forEach((k) => {
            if (memoryCache[k] !== undefined) {
              res[k] = memoryCache[k];
            }
          });
          if (callback) callback(res);
        }, 1);
      },
      set(obj, callback) {
        setTimeout(() => {
          if (obj && typeof obj === "object") {
            Object.assign(memoryCache, obj);
            flushStorageToNative();
          }
          if (callback) callback();
        }, 1);
      },
      remove(keys, callback) {
        setTimeout(() => {
          const list = Array.isArray(keys) ? keys : [keys];
          list.forEach((k) => delete memoryCache[k]);
          flushStorageToNative();
          if (callback) callback();
        }, 1);
      },
      clear(callback) {
        setTimeout(() => {
          memoryCache = {};
          flushStorageToNative();
          if (callback) callback();
        }, 1);
      }
    }
  };

  // 2. Эмуляция chrome.runtime
  window.chrome.runtime = {
    id: "chesscoach_android_runtime",
    getURL(path) {
      return "https://appassets.androidplatform.net/assets/" + String(path || "").replace(/^\/+/, "");
    },
    sendMessage(payload, callback) {
      setTimeout(() => {
        try {
          if (payload && payload.type === "CHECK_PEER_BEACON") {
            if (callback) callback({ detected: false });
            return;
          }
          // Прямой вызов анализатора позиции из background.js в том же контексте
          if (payload && payload.type === "ANALYZE_POSITION") {
            if (typeof analyzeAdaptiveMaster === "function") {
              analyzeAdaptiveMaster(
                payload.fen,
                payload.elo || 2000,
                payload.style || "tal",
                payload.pass || "fast",
                payload.lastEnemyMove || null,
                Boolean(payload.bulletTurbo),
                payload.calcAverage !== false,
                payload.calcWorst !== false,
                payload.myColor || "w",
                payload.mySeconds ?? 999,
                payload.enemySeconds ?? 999,
                payload.trapRadarEnabled !== false,
                Array.isArray(payload.recentPositions) ? payload.recentPositions : [],
                payload.lastOurMove || null
              ).then((res) => {
                if (callback) callback(res);
              }).catch((err) => {
                if (callback) callback({ error: err.message });
              });
              return;
            }
          }
          // Остальные сообщения background.js
          if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
            let handled = false;
            const fakeSender = { id: window.chrome.runtime.id };
            const fakeSendResp = (resData) => {
              if (!handled) {
                handled = true;
                if (callback) callback(resData);
              }
            };
            // Имитируем слушатель из background.js
            // listeners регистрируются в background.js через chrome.runtime.onMessage.addListener
          }
        } catch (err) {
          if (callback) callback({ error: err.message });
        }
      }, 1);
    }
  };

  if (!window.chrome.runtime.onMessage) {
    let listeners = [];
    window.chrome.runtime.onMessage = {
      addListener(fn) { listeners.push(fn); },
      removeListener(fn) { listeners = listeners.filter(l => l !== fn); }
    };
  }

  // 3. Перехват скачивания файлов .chess, .json, текстур в Загрузки Android
  const origCreateElement = document.createElement.bind(document);
  document.createElement = function (tagName) {
    const el = origCreateElement(tagName);
    if (tagName && tagName.toLowerCase() === "a") {
      const origClick = el.click.bind(el);
      el.click = function () {
        const href = el.getAttribute("href") || "";
        const downloadName = el.getAttribute("download") || "export.chess";
        if (href.startsWith("blob:") || href.startsWith("data:")) {
          fetch(href)
            .then(res => res.blob())
            .then(blob => {
              const reader = new FileReader();
              reader.onload = function () {
                const dataUrl = String(reader.result || "");
                const commaIdx = dataUrl.indexOf(",");
                const base64Content = commaIdx !== -1 ? dataUrl.slice(commaIdx + 1) : dataUrl;
                if (window.CCAndroidBridge && typeof window.CCAndroidBridge.downloadFile === "function") {
                  window.CCAndroidBridge.downloadFile(downloadName, base64Content, true);
                }
              };
              reader.readAsDataURL(blob);
            })
            .catch(() => origClick());
          return;
        }
        origClick();
      };
    }
    return el;
  };

  // 4. Мобильная адаптация CSS (масштабирование элементов под экран телефона)
  const mobileStyle = document.createElement("style");
  mobileStyle.textContent = `
    @media (max-width: 650px) {
      #chesscoach-panel {
        width: 94vw !important;
        max-width: 420px !important;
        right: 3vw !important;
        top: 48px !important;
        min-height: 480px !important;
        max-height: 86vh !important;
        font-size: 13px !important;
      }
      #chesscoach-workspace {
        grid-template-columns: 104px 1fr !important;
      }
      .cc-style-grid {
        grid-template-columns: 1fr !important;
      }
      .cc-actions-bar {
        grid-template-columns: 1fr !important;
      }
    }
  `;
  document.head.appendChild(mobileStyle);

  console.log("[ChessCoach Android] Полифилл успешно применен.");
})();