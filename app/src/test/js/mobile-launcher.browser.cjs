"use strict";

// Finite, dependency-free CDP checks. All chess/native operations are mocked;
// unchanged production assets run on reserved .test hosts mapped to loopback.
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { once } = require("node:events");

const assetsDir = process.env.CC_BROWSER_ASSETS || path.resolve(__dirname, "../../main/assets");
const chromePath = process.env.CC_BROWSER_CHROME || (process.platform === "win32" ? path.join(process.env.ProgramFiles || "C:\\Program Files", "Google/Chrome/Application/chrome.exe") : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");
const tempParent = process.env.CC_BROWSER_TEMP || os.tmpdir();
const takeScreenshots = process.argv.includes("--screenshots");
const viewports = [[320, 568], [360, 640], [390, 844], [412, 915], [640, 360], [768, 1024], [360, 300]];
const assetNames = ["content/content.css", "bridge/cc-mobile-preferences.js", "bridge/cc-mobile-launcher-orb.js", "content/content.js", "content/chesscom.js", "lib/openings.js", "lib/privacy-mask.js"];
const expectedLabels = ["\u041d\u0430\u0441\u0442\u0440\u043e\u0439\u043a\u0438", "\u0410\u043d\u0430\u043b\u0438\u0437", "\u0410\u0432\u0442\u043e\u0445\u043e\u0434", "\u0414\u0432\u0438\u0436\u043e\u043a", "\u0415\u0449\u0451"];
const searchTerm = "\u0437\u0430\u0434\u0435\u0440\u0436\u043a\u0430";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = source => crypto.createHash("sha256").update(source).digest("hex");

class CDP {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result || {});
      } else {
        for (const handler of this.listeners.get(message.method) || []) handler(message);
      }
    });
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("CDP socket closed"));
      }
      this.pending.clear();
    });
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP connection timed out")), 15000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP connection failed")); }, { once: true });
    });
    return new CDP(socket);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(handler);
    return () => this.listeners.get(method).delete(handler);
  }
  close() { this.socket.close(); }
}

function installMocks() {
  const harness = window.__browserHarness = {
    root: null, roots: [], store: {}, writes: [], nativeCalls: [], runtimeCalls: [],
    blockedPageRequests: [], boardTouches: 0, lifecycle: [], exceptions: [], changes: []
  };
  const prefix = location.hostname.includes("chess.com") ? "chesscom." : "lichess.";
  const scenario = new URL(location.href).searchParams.get("scenario") || "fresh";
  harness.store = {
    cc_mobile_ui_view_mode: "full", cc_mobile_ingame_submode: "mini",
    cc_mobile_settings_tab: "presets", [prefix + "autoMoveEnabled"]: false,
    [prefix + "phonkEditEnabled"]: false, [prefix + "audioRadarEnabled"]: false,
    ...(scenario === "saved" ? { cc_mobile_settings_tab: "automove" } : {})
  };
  window.__ChessCoachRegisterHudShadow = root => {
    harness.root = root;
    harness.roots.push(root);
    root.addEventListener("change", event => harness.changes.push({ id: event.target.id, trusted: event.isTrusted }));
  };
  window.addEventListener("error", event => harness.exceptions.push({ message: event.message, file: event.filename, line: event.lineno }));
  window.addEventListener("unhandledrejection", event => harness.exceptions.push({ message: String(event.reason?.stack || event.reason) }));
  window.addEventListener("cc-mobile-lifecycle", event => harness.lifecycle.push(event.detail));
  const storageListeners = new Set();
  const finish = (value, callback) => {
    const cloned = structuredClone(value);
    if (callback) queueMicrotask(() => callback(cloned));
    return Promise.resolve(cloned);
  };
  const local = {
    get(keys, callback) {
      let value;
      if (keys == null) value = harness.store;
      else if (typeof keys === "string") value = { [keys]: harness.store[keys] };
      else if (Array.isArray(keys)) value = Object.fromEntries(keys.filter(key => Object.hasOwn(harness.store, key)).map(key => [key, harness.store[key]]));
      else value = Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, harness.store[key] ?? fallback]));
      return finish(value, callback);
    },
    set(patch, callback) {
      const changes = Object.fromEntries(Object.entries(patch).filter(([key, value]) => JSON.stringify(harness.store[key]) !== JSON.stringify(value)).map(([key, value]) => [key, { oldValue: harness.store[key], newValue: value }]));
      Object.assign(harness.store, structuredClone(patch));
      harness.writes.push(structuredClone(patch));
      if (Object.keys(changes).length) queueMicrotask(() => { for (const listener of storageListeners) listener(changes, "local"); });
      return finish(undefined, callback);
    },
    remove(keys, callback) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete harness.store[key];
      return finish(undefined, callback);
    }
  };
  const runtime = {
    id: "isolated-android-browser-regression", lastError: null,
    getURL: name => `${location.origin}/assets/${name}`,
    sendMessage(payload, callback) {
      harness.runtimeCalls.push(structuredClone(payload));
      return finish({ status: "mocked", positionsCount: 0, experienceDB: {}, meta: payload.meta || null }, callback);
    },
    onMessage: { addListener() {}, removeListener() {} }
  };
  Object.defineProperty(window, "chrome", { configurable: true, value: {
    runtime, storage: { local, onChanged: { addListener: listener => storageListeners.add(listener), removeListener: listener => storageListeners.delete(listener) } }
  } });
  const profile = { platform: "android", tier: "BALANCED", model: "Browser fixture", recommendation: { tier: "BALANCED", movetimeScale: 1 } };
  window.__CC_DEVICE_PROFILE__ = profile;
  window.__CC_ANDROID_BOOTSTRAP__ = { profile };
  window.__CC_ANDROID_RUNTIME__ = {
    profile, chrome: window.chrome, ready: Promise.resolve(), disposed: false,
    refreshStorage: () => Promise.resolve(), flushStorage: () => Promise.resolve(),
    nativeRequest(method, params) {
      harness.nativeCalls.push({ method, params: structuredClone(params) });
      if (method.startsWith("input.")) return Promise.reject(new Error("Board gestures are disabled in this fixture"));
      if (method === "device.profile.get") return Promise.resolve(profile);
      return Promise.resolve({ mocked: true });
    }
  };
  window.ChessCoachEngine = {
    revive() {}, getPerformanceMode: () => "normal",
    create: () => ({ initWorker() {}, cancel() {}, terminate() {}, analyze: async () => null,
      getResourceProfile: () => ({ fullNnue: false, dualWorker: false, totalHashMb: 32 }) })
  };
  // No recognizable chessboard exists. This surface is only a hit-test witness.
  document.addEventListener("touchstart", event => {
    if (event.target.id === "fixture-board") harness.boardTouches++;
  });
  window.fetch = (...args) => {
    harness.blockedPageRequests.push({ api: "fetch", url: String(args[0]) });
    return Promise.reject(new Error("Network disabled in browser fixture"));
  };
  window.XMLHttpRequest = class {
    open(method, url) { this.url = url; }
    send() { harness.blockedPageRequests.push({ api: "xhr", url: String(this.url) }); throw new Error("Network disabled in browser fixture"); }
  };
  window.WebSocket = class { constructor(url) { harness.blockedPageRequests.push({ api: "websocket", url: String(url) }); throw new Error("Network disabled in browser fixture"); } };
  window.Worker = class { constructor(url) { harness.blockedPageRequests.push({ api: "worker", url: String(url) }); throw new Error("Workers disabled in browser fixture"); } };
  window.open = url => { harness.blockedPageRequests.push({ api: "window.open", url: String(url) }); return null; };
  navigator.sendBeacon = url => { harness.blockedPageRequests.push({ api: "beacon", url: String(url) }); return false; };
}

function measure() {
  const root = window.__browserHarness.root;
  if (!root) return { missingRoot: true };
  const rect = element => {
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
  };
  const visible = element => {
    const r = element.getBoundingClientRect();
    const css = getComputedStyle(element);
    return r.width > 0 && r.height > 0 && css.visibility !== "hidden" && css.display !== "none";
  };
  const panel = root.getElementById("chesscoach-panel");
  const main = root.querySelector(".cc-main-view");
  const nav = root.querySelector(".cc-nav-list");
  const buttons = [...nav.querySelectorAll(".cc-tab-btn")].filter(visible);
  const panes = [...root.querySelectorAll(".cc-tab-pane")].filter(pane => pane.classList.contains("active"));
  const selected = buttons.filter(button => button.getAttribute("aria-selected") === "true");
  const floating = document.getElementById("cc-mobile-launcher-host")?.shadowRoot;
  const mini = floating?.getElementById("cc-mini-hud-card");
  const overflowing = [...root.querySelectorAll(".cc-tab-pane.active *")].filter(visible).filter(element => {
    const r = element.getBoundingClientRect();
    const p = main.getBoundingClientRect();
    return r.right > p.right + 1 || r.left < p.left - 1;
  }).slice(0, 8).map(element => ({ id: element.id, tag: element.tagName, class: element.className, rect: rect(element), text: element.textContent.trim().slice(0, 80) }));
  return {
    viewport: { width: innerWidth, height: innerHeight, visualWidth: visualViewport.width, visualHeight: visualViewport.height, offsetLeft: visualViewport.offsetLeft, offsetTop: visualViewport.offsetTop },
    panel: rect(panel), header: rect(root.getElementById("chesscoach-header")), launcher: rect(root.getElementById("cc-mobile-launcher-bar")),
    workspace: rect(root.getElementById("chesscoach-workspace")), sidebar: rect(root.querySelector(".cc-sidebar")), nav: rect(nav),
    navCss: { display: getComputedStyle(nav).display, columns: getComputedStyle(nav).gridTemplateColumns },
    main: { ...rect(main), clientHeight: main.clientHeight, scrollHeight: main.scrollHeight, scrollTop: main.scrollTop, clientWidth: main.clientWidth, scrollWidth: main.scrollWidth, overflowY: getComputedStyle(main).overflowY },
    document: { clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth },
    buttons: buttons.map(button => ({ tab: button.dataset.tab, label: button.textContent.trim(), active: button.classList.contains("active"), aria: button.getAttribute("aria-selected"), controls: button.getAttribute("aria-controls"), rect: rect(button) })),
    activePanes: panes.map(pane => ({ id: pane.id, display: getComputedStyle(pane).display, rect: rect(pane) })),
    selected: selected.map(button => button.dataset.tab), settingsOpen: window.__CC_ANDROID_SETTINGS_OPEN__, panelDisplay: getComputedStyle(panel).display,
    mini: mini ? { display: getComputedStyle(mini).display, pointerEvents: getComputedStyle(mini).pointerEvents, ariaHidden: mini.getAttribute("aria-hidden"), rect: rect(mini) } : null,
    overlays: floating ? [...floating.querySelectorAll(".cc-overlay")].filter(visible).map(element => ({ id: element.id, pointerEvents: getComputedStyle(element).pointerEvents, ariaHidden: element.getAttribute("aria-hidden") })) : [],
    overflowing, exceptions: window.__browserHarness.exceptions,
    platformCurrent: [...root.querySelectorAll(".cc-platform-card[aria-current='page']")].map(element => element.id)
  };
}

async function run() {
  await fs.access(tempParent);
  await fs.access(chromePath);
  const outputDir = await fs.mkdtemp(path.join(tempParent, "cc-mobile-browser-"));
  const profileDir = path.join(outputDir, "chrome-profile");
  const snapshot = new Map();
  const report = { startedAt: new Date().toISOString(), assetsDir, outputDir, coverage: "Unchanged full core scripts, actual CSS/launcher/openings/privacy library; Android/chrome/engine mocked. Core execution events are dispatched at the launcher boundary, not generated by a real board move. No live board, account, chess requests, or native gestures.", sources: [], cases: [], checks: [], blockedRequests: [], screenshots: [] };
  for (const name of assetNames) {
    const source = await fs.readFile(path.join(assetsDir, name), "utf8");
    snapshot.set(name, source);
    report.sources.push({ name, sha256: hash(source), bytes: Buffer.byteLength(source) });
  }
  const check = (name, passed, evidence, context) => {
    report.checks.push({ name, passed: Boolean(passed), ...(context ? { context } : {}), evidence });
    if (!passed) console.log(`FAIL ${context || ""} ${name}: ${JSON.stringify(evidence)}`);
  };
  let server;
  let browser;
  let cdp;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (cdp) {
      try { await cdp.send("Browser.close"); } catch (_) {}
      cdp.close();
    }
    if (browser && browser.exitCode === null && browser.signalCode === null) {
      await Promise.race([once(browser, "exit"), delay(2000)]);
      if (browser.exitCode === null && browser.signalCode === null) {
        if (process.platform === "win32") {
          const killer = spawn("taskkill", ["/PID", String(browser.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          await Promise.race([once(killer, "exit"), delay(3000)]);
        } else browser.kill("SIGKILL");
      }
    }
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await fs.rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(error => { report.profileCleanupError = error.message; });
    report.cleanup = { browserExited: !browser || browser.exitCode !== null || browser.signalCode !== null, serverClosed: !server?.listening };
  };
  const interrupted = () => { void stop().finally(() => process.exit(130)); };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  const deadline = setTimeout(() => { console.error("Harness exceeded finite 180s deadline"); interrupted(); }, 180000);
  try {
    server = http.createServer((request, response) => {
      const url = new URL(request.url, "http://localhost");
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; worker-src 'none'; font-src 'none'");
      if (url.pathname.startsWith("/assets/")) {
        const name = url.pathname.slice(8);
        const source = snapshot.get(name);
        response.writeHead(source === undefined ? 404 : 200, { "Content-Type": name.endsWith(".css") ? "text/css; charset=utf-8" : "application/javascript; charset=utf-8" });
        response.end(source || "");
      } else if (url.pathname === "/fixture") {
        const chesscom = request.headers.host.startsWith("chess.com.test:");
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Isolated mobile menu regression</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#202c35}#fixture-board{position:fixed;inset:0;background:repeating-conic-gradient(#718472 0% 25%,#d6dfc9 0% 50%) 0 0/80px 80px}</style></head><body><div id="fixture-board"></div><script src="/assets/lib/openings.js"></script>${chesscom ? '<script src="/assets/lib/privacy-mask.js"></script>' : ""}<script src="/assets/bridge/cc-mobile-preferences.js"></script><script src="/assets/bridge/cc-mobile-launcher-orb.js"></script><script src="/assets/content/${chesscom ? "chesscom.js" : "content.js"}"></script></body></html>`);
      } else {
        response.writeHead(404); response.end();
      }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    browser = spawn(chromePath, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-extensions", "--no-proxy-server", "--remote-debugging-port=0", `--user-data-dir=${profileDir}`, "--host-resolver-rules=MAP lichess.test 127.0.0.1, MAP chess.com.test 127.0.0.1, MAP * ~NOTFOUND", "about:blank"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let browserLog = "";
    const websocketUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Chrome startup timed out: ${browserLog}`)), 20000);
      browser.once("error", error => { clearTimeout(timer); reject(error); });
      browser.once("exit", code => { clearTimeout(timer); reject(new Error(`Chrome exited ${code}: ${browserLog}`)); });
      browser.stderr.on("data", chunk => {
        browserLog = (browserLog + chunk).slice(-12000);
        const match = browserLog.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    cdp = await CDP.connect(websocketUrl);
    report.browser = await cdp.send("Browser.getVersion");
    console.log(`Browser: ${report.browser.product}; assets snapshot: ${report.sources.map(source => `${source.name}=${source.sha256.slice(0, 12)}`).join(", ")}`);
    for (const platform of ["lichess", "chesscom"]) {
      const host = platform === "lichess" ? "lichess.test" : "chess.com.test";
      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      const send = (method, params) => cdp.send(method, params, sessionId);
      const evaluate = async (fn, ...args) => {
        const expression = typeof fn === "string" ? fn : `(${fn.toString()})(${args.map(arg => JSON.stringify(arg)).join(",")})`;
        const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        return result.result.value;
      };
      const waitFor = async (fn, timeout = 5000) => {
        const until = Date.now() + timeout;
        while (Date.now() < until) { if (await evaluate(fn)) return; await delay(40); }
        throw new Error(`Page condition timed out: ${fn}`);
      };
      const removeFetchHandler = cdp.on("Fetch.requestPaused", message => {
        if (message.sessionId !== sessionId) return;
        const request = message.params;
        const url = new URL(request.request.url);
        const allowed = url.protocol === "http:" && url.hostname === host && url.port === String(port) && (url.pathname === "/fixture" || (url.pathname.startsWith("/assets/") && snapshot.has(url.pathname.slice(8))));
        if (!allowed) report.blockedRequests.push({ platform, url: url.href, type: request.resourceType });
        void send(allowed ? "Fetch.continueRequest" : "Fetch.failRequest", allowed ? { requestId: request.requestId } : { requestId: request.requestId, errorReason: "BlockedByClient" }).catch(() => {});
      });
      await send("Page.enable");
      await send("Runtime.enable");
      await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
      await send("Page.addScriptToEvaluateOnNewDocument", { source: `(${installMocks.toString()})()` });
      await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
      const tap = async (selector, floating = false, label = false) => {
        const point = await evaluate(async (selector, floating, label) => {
          const root = floating ? document.getElementById("cc-mobile-launcher-host")?.shadowRoot : window.__browserHarness.root;
          let element = root?.querySelector(selector);
          if (!element) throw new Error(`Missing tap target ${selector}`);
          if (label) element = element.closest(".cc-Switch-row").querySelector("span,div");
          element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const r = element.getBoundingClientRect();
          const css = getComputedStyle(element);
          const main = root.querySelector(".cc-main-view");
          const clip = !floating && element.closest(".cc-main-view") ? main.getBoundingClientRect() : { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
          const left = Math.max(r.left, clip.left, 0), right = Math.min(r.right, clip.right, innerWidth);
          const top = Math.max(r.top, clip.top, 0), bottom = Math.min(r.bottom, clip.bottom, innerHeight);
          if (right <= left || bottom <= top || css.visibility === "hidden" || css.display === "none") throw new Error(`Tap target clipped/hidden ${selector}: ${JSON.stringify({ x: r.x, y: r.y, width: r.width, height: r.height })}`);
          return { x: (left + right) / 2, y: (top + bottom) / 2 };
        }, selector, floating, label);
        await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...point, radiusX: 3, radiusY: 3, force: 1, id: 1 }] });
        await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await delay(50);
        return point;
      };
      const navTap = tab => tap(`.cc-nav-list .cc-tab-btn[data-tab='${tab}']`);
      const current = () => evaluate(measure);
      for (const [width, height] of viewports) {
        const context = `${platform} ${width}x${height}`;
        const startChecks = report.checks.length;
        let geometry;
        try {
          await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: true });
          await send("Page.navigate", { url: `http://${host}:${port}/fixture` });
          await waitFor(() => Boolean(window.__CC_MOBILE_PREFERENCES__?.isReady && window.__browserHarness?.root?.getElementById("cc-pane-more") && window.__browserHarness.root.querySelector("link")?.sheet));
          await delay(90);
          geometry = await current();
          check("five primary labels", JSON.stringify(geometry.buttons.map(button => button.label)) === JSON.stringify(expectedLabels), geometry.buttons, context);
          check("compact navigation geometry", width >= 720 ? geometry.nav.width < 150 : geometry.nav.height <= (height <= 480 ? 52 : 68) && Math.max(...geometry.buttons.map(button => button.rect.y)) - Math.min(...geometry.buttons.map(button => button.rect.y)) < 1, { nav: geometry.nav, sidebar: geometry.sidebar, css: geometry.navCss }, context);
          check("positive scrollable content", geometry.main.clientHeight > 0 && geometry.main.overflowY === "auto" && geometry.main.scrollHeight >= geometry.main.clientHeight, geometry.main, context);
          check("no horizontal overflow", geometry.main.scrollWidth <= geometry.main.clientWidth + 1 && geometry.document.scrollWidth <= geometry.document.clientWidth + 1 && geometry.overflowing.length === 0, { main: geometry.main, document: geometry.document, descendants: geometry.overflowing }, context);
          check("unobstructed fresh settings", geometry.overlays.length === 0 && geometry.activePanes.length === 1 && geometry.activePanes[0].id === "cc-pane-presets" && geometry.settingsOpen, geometry, context);
          check("platform ARIA current", JSON.stringify(geometry.platformCurrent) === JSON.stringify([platform === "lichess" ? "cc-select-lichess-btn" : "cc-select-chesscom-btn"]), geometry.platformCurrent, context);
          check("primary tabs have valid ARIA targets and touch sizes", geometry.buttons.every(button => button.rect.width >= 44 && button.rect.height >= 44 && button.controls === `cc-pane-${button.tab}`), geometry.buttons, context);
          for (const tab of ["presets", "analyzer", "automove", "rage", "more"]) {
            await navTap(tab);
            const state = await current();
            check(`primary ${tab} active/ARIA/accessibility`, state.activePanes.length === 1 && state.activePanes[0].id === `cc-pane-${tab}` && state.activePanes[0].display !== "none" && JSON.stringify(state.selected) === JSON.stringify([tab]) && state.buttons.every(button => button.active === (button.aria === "true")) && state.main.clientHeight > 0 && state.main.scrollWidth <= state.main.clientWidth + 1 && state.overflowing.length === 0, { pane: state.activePanes, selected: state.selected, main: state.main, overflowing: state.overflowing }, context);
          }
          const extraIds = await evaluate(() => [...window.__browserHarness.root.querySelectorAll(".cc-mobile-extra-tab")].map(button => button.dataset.tab));
          const linkCount = await evaluate(() => window.__browserHarness.root.querySelectorAll("#cc-pane-more .cc-mobile-links > button").length);
          check("More exposes all original extra tabs", linkCount === extraIds.length && linkCount >= 2, { extraIds, linkCount }, context);
          for (let index = 0; index < extraIds.length; index++) {
            await navTap("more");
            await tap(`#cc-pane-more .cc-mobile-links > button:nth-child(${index + 1})`);
            const state = await current();
            check(`More link ${extraIds[index]} active/ARIA/accessibility`, state.activePanes.length === 1 && state.activePanes[0].id === `cc-pane-${extraIds[index]}` && JSON.stringify(state.selected) === JSON.stringify(["more"]) && state.main.clientHeight > 0 && state.main.scrollWidth <= state.main.clientWidth + 1 && state.overflowing.length === 0, { pane: state.activePanes, selected: state.selected, main: state.main, overflowing: state.overflowing }, context);
          }
          await navTap("automove");
          const beforeSwitch = await evaluate(() => window.__browserHarness.root.getElementById("cc-auto-master-chk").checked);
          await tap("#cc-auto-master-chk", false, true);
          await waitFor(() => {
            const activePlatform = location.hostname.includes("chess.com") ? "chesscom" : "lichess";
            return window.__browserHarness.store[`${activePlatform}.autoMoveEnabled`] === window.__browserHarness.root.getElementById("cc-auto-master-chk").checked;
          });
          const afterSwitch = await evaluate(() => ({ checked: window.__browserHarness.root.getElementById("cc-auto-master-chk").checked, aria: window.__browserHarness.root.getElementById("cc-auto-master-chk").getAttribute("aria-label"), store: window.__browserHarness.store, changes: window.__browserHarness.changes.slice(-3) }));
          check("touching switch label toggles and invokes core binding", afterSwitch.checked !== beforeSwitch && afterSwitch.store[`${platform}.autoMoveEnabled`] === afterSwitch.checked && Boolean(afterSwitch.aria), afterSwitch, context);
          await tap("#cc-toggle-btn");
          const atBoard = await current();
          check("return-to-board clears settings-open flag", !atBoard.settingsOpen && atBoard.panelDisplay === "none" && atBoard.mini.display === "block", { settingsOpen: atBoard.settingsOpen, panelDisplay: atBoard.panelDisplay, mini: atBoard.mini }, context);
          await tap("#cc-mini-settings-btn", true);
          const paused = await evaluate(platform => ({ settingsOpen: window.__CC_ANDROID_SETTINGS_OPEN__,
            enabled: window.__browserHarness.root.getElementById("cc-auto-master-chk").checked,
            storedEnabled: window.__browserHarness.store[`${platform}.autoMoveEnabled`],
            status: window.__browserHarness.root.getElementById("cc-auto-live-status").textContent,
            lifecycle: window.__browserHarness.lifecycle.slice(-2) }), platform);
          check("opening settings pauses without persisting automation off", paused.settingsOpen && paused.enabled && paused.storedEnabled && paused.status.includes("\u043d\u0430 \u043f\u0430\u0443\u0437\u0435") && paused.lifecycle.at(-1)?.state === "settings" && paused.lifecycle.at(-1)?.cancelPendingMoves === true, paused, context);
          await tap("#cc-auto-master-chk", false, true);
          await navTap("presets");
          await tap("#cc-mobile-settings-search");
          await send("Input.insertText", { text: searchTerm });
          const searchResults = await evaluate(() => [...window.__browserHarness.root.querySelectorAll("#cc-mobile-search-results button")].map(button => button.textContent.trim()));
          check("search finds delay", searchResults.length > 0, searchResults, context);
          if (searchResults.length) {
            await tap("#cc-mobile-search-results button");
            await delay(170);
            const searchState = await current();
            const hit = await evaluate(() => {
              const root = window.__browserHarness.root, target = root.querySelector(".cc-mobile-search-hit");
              const r = target?.getBoundingClientRect(), main = root.querySelector(".cc-main-view").getBoundingClientRect();
              return target ? { text: target.textContent.trim(), top: r.top, bottom: r.bottom, visible: r.top >= main.top && r.bottom <= main.bottom, pane: target.closest(".cc-tab-pane").id } : null;
            });
            check("search navigates and scrolls to visible hit", hit?.visible && hit.pane === "cc-pane-automove" && searchState.activePanes[0]?.id === hit.pane && searchState.selected[0] === "automove", { hit, main: searchState.main }, context);
            await navTap("presets");
            await tap("#cc-mobile-search-results button");
            await delay(150);
            const repeatState = await current();
            check("existing search result works a second time", repeatState.activePanes[0]?.id === "cc-pane-automove", { activePanes: repeatState.activePanes, selected: repeatState.selected }, context);
          }
          await evaluate(() => window.dispatchEvent(new CustomEvent("cc-core-state", { detail: { source: "chesscoach-core", executing: true, allowOverlayPassthrough: true } })));
          const executing = await current();
          check("execution start hides menu and passes through mini", executing.panelDisplay === "none" && !executing.settingsOpen && executing.mini?.display === "block" && executing.mini.pointerEvents === "none" && executing.mini.ariaHidden === "false", executing, context);
          const witnessPoint = { x: Math.min(width - 2, executing.mini.rect.x + 25), y: Math.min(height - 2, executing.mini.rect.y + 25) };
          const beforeTouches = await evaluate(() => window.__browserHarness.boardTouches);
          await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...witnessPoint, id: 1 }] });
          await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          check("real touch reaches witness through mini", await evaluate(() => window.__browserHarness.boardTouches) === beforeTouches + 1, witnessPoint, context);
          await evaluate(() => window.dispatchEvent(new CustomEvent("cc-core-state", { detail: { source: "chesscoach-core", executing: false, allowOverlayPassthrough: false } })));
          const ended = await current();
          check("execution end restores mini interactivity", ended.mini?.pointerEvents === "auto" && ended.mini.display === "block", ended.mini, context);
          await tap("#cc-mini-settings-btn", true);
          await navTap("presets");
          await tap("#cc-run-survey-again-btn");
          await evaluate(() => window.dispatchEvent(new CustomEvent("cc-core-state", { detail: { source: "chesscoach-core", executing: true, allowOverlayPassthrough: true } })));
          const modal = await current();
          check("modal blocks execution passthrough", modal.panelDisplay !== "none" && modal.settingsOpen && modal.overlays.some(overlay => overlay.id === "cc-onboarding-modal" && overlay.pointerEvents === "auto") && modal.mini.pointerEvents === "auto", { overlays: modal.overlays, mainDisplay: modal.panelDisplay, settingsOpen: modal.settingsOpen, mini: modal.mini }, context);
          const modalTouches = await evaluate(() => window.__browserHarness.boardTouches);
          await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 2, y: 2, id: 1 }] });
          await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          check("modal intercepts real touch outside its card", await evaluate(() => window.__browserHarness.boardTouches) === modalTouches, { point: { x: 2, y: 2 } }, context);
          await evaluate(() => window.__ccHandleAndroidBack());
          await evaluate(() => window.dispatchEvent(new CustomEvent("cc-core-state", { detail: { source: "chesscoach-core", executing: false, allowOverlayPassthrough: false } })));
          if (width === 390 || (width === 360 && height === 300)) {
            for (const preset of ["legit", "hvh", "balance"]) {
              await navTap("presets");
              await tap(`#cc-quick-preset-${preset}`);
              const presetState = await evaluate(() => {
                const root = window.__browserHarness.root, floating = document.getElementById("cc-mobile-launcher-host").shadowRoot;
                return { status: root.getElementById("cc-mobile-preset-status").textContent,
                  delay: root.getElementById("cc-auto-delay-slider").value, jitter: root.getElementById("cc-auto-jitter-slider").value,
                  elo: root.getElementById("cc-elo-slider").value,
                  modalOpen: floating.getElementById("cc-auto-confirm-modal").getAttribute("aria-hidden") === "false" };
              });
              check(`quick preset ${preset} applies through core and opens confirmation`, presetState.modalOpen, presetState, context);
              if (presetState.modalOpen) {
                await evaluate(() => window.dispatchEvent(new CustomEvent("cc-core-state", { detail: { source: "chesscoach-core", executing: true, allowOverlayPassthrough: true } })));
                const confirmation = await current();
                check(`confirmation for ${preset} blocks passthrough`, confirmation.panelDisplay !== "none" && confirmation.overlays.some(overlay => overlay.id === "cc-auto-confirm-modal") && confirmation.mini.pointerEvents === "auto", { mainDisplay: confirmation.panelDisplay, overlays: confirmation.overlays, mini: confirmation.mini }, context);
                await evaluate(() => window.__ccHandleAndroidBack());
                await evaluate(() => window.dispatchEvent(new CustomEvent("cc-core-state", { detail: { source: "chesscoach-core", executing: false, allowOverlayPassthrough: false } })));
              }
            }
            await navTap("more");
            await tap("#cc-mode-switcher-bar .cc-mode-btn[data-mode='all']");
            check("original mode bar binding remains usable in More", await evaluate(() => window.__browserHarness.root.getElementById("chesscoach-panel").dataset.workMode === "all" && window.__browserHarness.root.querySelector(".cc-mode-btn[data-mode='all']").classList.contains("active")), await evaluate(() => window.__browserHarness.root.getElementById("cc-mode-switcher-bar").textContent.trim()), context);
            const tabs = ["automove", "rage", ...extraIds];
            for (const tab of tabs) {
              if (extraIds.includes(tab)) {
                await navTap("more");
                await tap(`#cc-pane-more .cc-mobile-links > button:nth-child(${extraIds.indexOf(tab) + 1})`);
              } else await navTap(tab);
              const switches = await evaluate(tab => [...window.__browserHarness.root.querySelectorAll(`#cc-pane-${tab} .cc-Switch-row input[type='checkbox']`)].filter(input => !input.disabled && input.getBoundingClientRect().width > 0).map(input => input.id), tab);
              for (const id of switches) {
                const before = await evaluate(id => ({ checked: window.__browserHarness.root.getElementById(id).checked, changes: window.__browserHarness.changes.length }), id);
                await tap(`#${id}`, false, true);
                const after = await evaluate(id => ({ checked: window.__browserHarness.root.getElementById(id).checked, label: window.__browserHarness.root.getElementById(id).getAttribute("aria-label"), changes: window.__browserHarness.changes.slice(-2) }), id);
                check(`touch label toggles ${id}`, before.checked !== after.checked && Boolean(after.label), { before, after }, context);
                await tap(`#${id}`, false, true);
              }
            }
          }
          const safety = await evaluate(() => ({ native: window.__browserHarness.nativeCalls, runtime: window.__browserHarness.runtimeCalls.map(call => call.type), blockedPageRequests: window.__browserHarness.blockedPageRequests }));
          check("viewport has no native gestures or chess requests", safety.native.every(call => !call.method.startsWith("input.")) && safety.runtime.every(type => !/ANALYZE|TRAIN_MOVE|IMPORT_MEMORY|CLEAR_MEMORY/.test(type)), safety, context);
          check("no page exceptions", (await current()).exceptions.length === 0, (await current()).exceptions, context);
          if (takeScreenshots && report.screenshots.length < 2 && ((platform === "lichess" && width === 320) || (platform === "chesscom" && height === 300))) {
            await navTap(platform === "lichess" ? "presets" : "automove");
            const screenshot = await send("Page.captureScreenshot", { format: "png" });
            const filename = path.join(outputDir, `${platform}-${width}x${height}.png`);
            await fs.writeFile(filename, Buffer.from(screenshot.data, "base64"));
            report.screenshots.push(filename);
          }
        } catch (error) {
          check("case completes", false, { error: error.stack, state: await current().catch(() => null) }, context);
        }
        const checks = report.checks.slice(startChecks);
        report.cases.push({ platform, width, height, passed: checks.filter(item => item.passed).length, failed: checks.filter(item => !item.passed).length, initialGeometry: geometry });
        console.log(`CASE ${context}: ${checks.filter(item => item.passed).length} passed, ${checks.filter(item => !item.passed).length} failed; content=${geometry?.main?.clientHeight}px nav=${geometry?.nav?.height}px`);
      }
      const context = `${platform} lifecycle`;
      await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      await send("Page.navigate", { url: `http://${host}:${port}/fixture?scenario=saved` });
      await waitFor(() => Boolean(window.__browserHarness?.root?.getElementById("cc-pane-more")));
      await delay(100);
      check("saved mobile tab restored", (await current()).activePanes[0]?.id === "cc-pane-automove", (await current()).activePanes, context);
      await evaluate(snapshot.get("bridge/cc-mobile-launcher-orb.js"));
      const aliveCounts = await evaluate(() => ({ hosts: document.querySelectorAll("#cc-mobile-launcher-host").length, bars: window.__browserHarness.root.querySelectorAll("#cc-mobile-launcher-bar").length, more: window.__browserHarness.root.querySelectorAll("#cc-pane-more").length, modes: window.__browserHarness.root.querySelectorAll("#cc-mode-switcher-bar").length }));
      check("live reinjection remains idempotent", Object.values(aliveCounts).every(count => count === 1), aliveCounts, context);
      await evaluate(() => { window.__originalModeBar = window.__browserHarness.root.getElementById("cc-mode-switcher-bar"); window[Symbol.for("cc.android.mobile-launcher.instance")].cleanup("regression"); });
      const cleaned = await evaluate(() => ({ originalModeBarPreserved: window.__browserHarness.root.getElementById("cc-mode-switcher-bar") === window.__originalModeBar, modes: window.__browserHarness.root.querySelectorAll("#cc-mode-switcher-bar").length, modeParent: window.__originalModeBar.parentElement.id, bars: window.__browserHarness.root.querySelectorAll("#cc-mobile-launcher-bar").length, more: window.__browserHarness.root.querySelectorAll("#cc-pane-more").length, hosts: document.querySelectorAll("#cc-mobile-launcher-host").length, settingsOpen: window.__CC_ANDROID_SETTINGS_OPEN__ }));
      check("cleanup preserves original mode bar and removes injected nodes", cleaned.originalModeBarPreserved && cleaned.modes === 1 && cleaned.modeParent === "chesscoach-panel" && cleaned.bars === 0 && cleaned.more === 0 && cleaned.hosts === 0, cleaned, context);
      check("cleanup clears settings-open pause flag", cleaned.settingsOpen !== true, cleaned, context);
      await evaluate(snapshot.get("bridge/cc-mobile-launcher-orb.js"));
      await evaluate(snapshot.get(platform === "lichess" ? "content/content.js" : "content/chesscom.js"));
      await delay(150);
      const reinjected = await evaluate(() => ({ modes: window.__browserHarness.root.querySelectorAll("#cc-mode-switcher-bar").length, bars: window.__browserHarness.root.querySelectorAll("#cc-mobile-launcher-bar").length, more: window.__browserHarness.root.querySelectorAll("#cc-pane-more").length, styles: window.__browserHarness.root.querySelectorAll("#cc-mobile-override-style").length, hosts: document.querySelectorAll("#cc-mobile-launcher-host").length }));
      check("launcher-only cleanup/reinjection recovers existing closed core HUD", Object.values(reinjected).every(count => count === 1), reinjected, context);
      await evaluate(platform => {
        window[Symbol.for("cc.android.mobile-launcher.instance")]?.cleanup("regression-full");
        window[Symbol.for(`cc.${platform}.content.instance`)]?.shutdown();
      }, platform);
      await evaluate(snapshot.get("bridge/cc-mobile-launcher-orb.js"));
      await evaluate(snapshot.get(platform === "lichess" ? "content/content.js" : "content/chesscom.js"));
      await waitFor(() => Boolean(window.__browserHarness.root?.getElementById("cc-pane-more")));
      const recovered = await evaluate(() => ({ modes: window.__browserHarness.root.querySelectorAll("#cc-mode-switcher-bar").length, bars: window.__browserHarness.root.querySelectorAll("#cc-mobile-launcher-bar").length, more: window.__browserHarness.root.querySelectorAll("#cc-pane-more").length, styles: window.__browserHarness.root.querySelectorAll("#cc-mobile-override-style").length, hosts: document.querySelectorAll("#cc-mobile-launcher-host").length, connectedRoots: window.__browserHarness.roots.filter(root => root.host.isConnected).length }));
      check("full cleanup/reinjection has no duplicate nodes", Object.values(recovered).every(count => count === 1), recovered, context);
      const safety = await evaluate(() => ({ native: window.__browserHarness.nativeCalls, runtime: window.__browserHarness.runtimeCalls.map(call => call.type), blockedPageRequests: window.__browserHarness.blockedPageRequests }));
      check("no native gestures or chess requests", safety.native.every(call => !call.method.startsWith("input.")) && safety.runtime.every(type => !/ANALYZE|TRAIN_MOVE|IMPORT_MEMORY|CLEAR_MEMORY/.test(type)), safety, context);
      removeFetchHandler();
      await cdp.send("Target.closeTarget", { targetId });
    }
  } catch (error) {
    report.fatalError = error.stack;
    console.error(error.stack);
  } finally {
    clearTimeout(deadline);
    await stop();
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
  }
  for (const source of report.sources) source.changedDuringRun = hash(await fs.readFile(path.join(assetsDir, source.name), "utf8")) !== source.sha256;
  report.finishedAt = new Date().toISOString();
  report.passed = report.checks.filter(item => item.passed).length;
  report.failed = report.checks.filter(item => !item.passed).length;
  const reportPath = path.join(outputDir, "report.json");
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(`RESULT ${report.passed} passed, ${report.failed} failed; cleanup=${JSON.stringify(report.cleanup)}`);
  console.log(`REPORT ${reportPath}`);
  for (const filename of report.screenshots) console.log(`SCREENSHOT ${filename}`);
  if (report.sources.some(source => source.changedDuringRun)) console.log(`SOURCE CHANGED: ${report.sources.filter(source => source.changedDuringRun).map(source => source.name).join(", ")}; rerun against latest assets.`);
  process.exitCode = report.fatalError || report.failed || !report.cleanup?.browserExited || !report.cleanup?.serverClosed ? 1 : 0;
}

run().catch(error => { console.error(error.stack); process.exitCode = 1; });
