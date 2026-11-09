(function () {
  if (window.__ccAndroidPolyfillLoaded) return;
  window.__ccAndroidPolyfillLoaded = true;

  let memoryCache = {};
  try {
    if (window.CCAndroidBridge && typeof window.CCAndroidBridge.getStorageJson === "function") {
      const raw = window.CCAndroidBridge.getStorageJson();
      if (raw) memoryCache = JSON.parse(raw);
    }
  } catch (e) {}

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
        try {
          if (window.CCAndroidBridge && typeof window.CCAndroidBridge.getStorageJson === "function") {
            const raw = window.CCAndroidBridge.getStorageJson();
            if (raw) memoryCache = JSON.parse(raw);
          }
        } catch (e) {}

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
        }, 0);
      },
      set(obj, callback) {
        if (obj && typeof obj === "object") {
          Object.assign(memoryCache, obj);
          flushStorageToNative();
        }
        if (callback) setTimeout(callback, 0);
      },
      remove(keys, callback) {
        const list = Array.isArray(keys) ? keys : [keys];
        list.forEach((k) => delete memoryCache[k]);
        flushStorageToNative();
        if (callback) setTimeout(callback, 0);
      },
      clear(callback) {
        memoryCache = {};
        flushStorageToNative();
        if (callback) setTimeout(callback, 0);
      }
    }
  };

  // Полный роутер сообщений между content.js / chesscom.js и background.js
  const bgListeners = [];
  window.chrome.runtime = {
    id: "chesscoach_android_v15",
    lastError: null,
    getURL(path) {
      return "https://appassets.androidplatform.net/assets/" + String(path || "").replace(/^\/+/, "");
    },
    onMessage: {
      addListener(fn) {
        if (typeof fn === "function") bgListeners.push(fn);
      },
      removeListener(fn) {
        const idx = bgListeners.indexOf(fn);
        if (idx !== -1) bgListeners.splice(idx, 1);
      }
    },
    sendMessage(payload, callback) {
      setTimeout(() => {
        let responded = false;
        const sendResponse = (res) => {
          if (responded) return;
          responded = true;
          if (typeof callback === "function") callback(res);
        };

        for (let i = 0; i < bgListeners.length; i++) {
          try {
            bgListeners[i](payload, { id: "chesscoach_android_v15" }, sendResponse);
          } catch (err) {
            console.error("[BG Listener Error]:", err);
          }
        }
      }, 0);
    }
  };

  // Обход CSP Lichess/Chess.com для fetch() локальных файлов (например, lib/stockfish-local.js)
  const origFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const urlStr = typeof input === "string" ? input : (input && input.url ? input.url : "");
    const prefix = "https://appassets.androidplatform.net/assets/";
    if (urlStr.startsWith(prefix) && window.CCAndroidBridge && typeof window.CCAndroidBridge.readAssetText === "function") {
      const relPath = urlStr.slice(prefix.length).split("?")[0];
      const textContent = window.CCAndroidBridge.readAssetText(relPath);
      if (textContent) {
        return new Response(textContent, {
          status: 200,
          headers: { "Content-Type": relPath.endsWith(".css") ? "text/css" : "application/javascript" }
        });
      }
    }
    return origFetch(input, init);
  };

  // Перехват скачивания файлов .chess и .json в папку Загрузки/ChessCoach на телефоне
  const origCreateElement = document.createElement.bind(document);
  document.createElement = function (tagName) {
    const el = origCreateElement(tagName);
    if (tagName && tagName.toLowerCase() === "a") {
      const origClick = el.click.bind(el);
      el.click = function () {
        const href = el.getAttribute("href") || "";
        const downloadName = el.getAttribute("download") || "config.chess";
        if (href.startsWith("blob:") || href.startsWith("data:")) {
          origFetch(href)
            .then((res) => res.blob())
            .then((blob) => {
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
})();