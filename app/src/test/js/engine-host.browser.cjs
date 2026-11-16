"use strict";

// Finite, dependency-free CDP regression. Only native envelopes/profile replies
// are stubbed. Worker, fetch, Stockfish, WASM, runtime and host remain real.
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
const skipHigh = process.argv.includes("--skip-high");
const FULL = "stockfish-19-full-single-wasm";
const LITE = "stockfish-19-lite-asm";
const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const TACTICAL = "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1";
const MATE = "6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1";
const assetNames = [
  "engine/engine-host.html", "engine/engine-runtime.js", "data/eco-book.js",
  "background/background.js", "offscreen/offscreen.js", "engine/engine-host.js",
  "lib/stockfish-local.js", "vendor/stockfish/stockfish-19-single.js",
  "vendor/stockfish/stockfish-19-single.wasm"
];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function profile(tier, constrained = false) {
  return {
    platform: "android", model: "Isolated real-Chrome engine regression",
    memory: { totalBucketMiB: tier === "HIGH" ? 8192 : 4096 },
    cpu: { logicalCores: 8 },
    power: { saveMode: constrained, backgroundRestricted: false, thermalStatus: constrained ? 3 : 0 },
    recommendation: {
      tier, threads: 1, hashMiB: tier === "LOW" || constrained ? 16 : 32,
      maxMovetimeMs: tier === "LOW" || constrained ? 180 : tier === "HIGH" ? 400 : 260,
      movetimeScale: 1, animations: false, visualEffects: false
    }
  };
}

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
  send(method, params = {}, sessionId, timeout = 15000) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeout}ms`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(handler);
  }
  close() { this.socket.close(); }
}

function installNativeTransport(initialProfile) {
  const harness = window.__engineBrowserHarness = {
    profile: initialProfile, trace: [], requests: [], envelopes: [], exceptions: [], cspViolations: [],
    sequence: 0, pending: new Map(), readyCount: 0
  };
  const native = window.CCEngineNative = {
    onmessage: null,
    postMessage(text) {
      const envelope = JSON.parse(text);
      harness.envelopes.push({ at: performance.now(), envelope });
      if (envelope.type === "device.profile.get") {
        queueMicrotask(() => native.onmessage?.({ data: JSON.stringify({
          v: 1, scope: "chesscoach.android", source: "native", target: "ENGINE",
          channel: "device", type: "device.profile.response", id: envelope.id,
          payload: { profile: harness.profile }
        }) }));
      } else if (envelope.type === "engine.ready") {
        harness.readyCount++;
      } else if (envelope.type === "runtime.response") {
        const pending = harness.pending.get(envelope.id);
        if (pending) {
          clearTimeout(pending.timer);
          pending.response = envelope;
          pending.resolve(envelope);
        }
      } else {
        throw new Error(`Unexpected native operation: ${envelope.type}`);
      }
    }
  };
  harness.begin = message => {
    const id = `real-browser-envelope-${++harness.sequence}`;
    const envelope = {
      v: 1, scope: "chesscoach.android", source: "native", target: "ENGINE",
      channel: "runtime", type: "runtime.message", id,
      payload: { message, sender: {
        id: "chesscoach-android", url: "https://lichess.org/analysis", origin: "https://lichess.org",
        tabId: 1, frameId: 0, documentId: "isolated-engine-regression-document"
      } }
    };
    const pending = { envelope, response: null, timer: null, resolve: null, promise: null };
    pending.promise = new Promise(resolve => { pending.resolve = resolve; });
    pending.timer = setTimeout(() => pending.resolve({
      id, type: "harness.timeout", payload: { ok: false, error: { code: "HARNESS_TIMEOUT", message: "No native response within 70s" } }
    }), 70000);
    harness.pending.set(id, pending);
    harness.requests.push({ at: performance.now(), envelope });
    window.CCEngineHost.dispatchFromNative({ data: JSON.stringify(envelope) });
    return id;
  };
  harness.wait = id => harness.pending.get(id).promise;
  window.addEventListener("error", event => harness.exceptions.push({ message: event.message, file: event.filename, line: event.lineno }));
  window.addEventListener("unhandledrejection", event => harness.exceptions.push({ message: String(event.reason?.stack || event.reason) }));
  document.addEventListener("securitypolicyviolation", event => harness.cspViolations.push({
    blockedURI: event.blockedURI, directive: event.effectiveDirective, policy: event.originalPolicy,
    file: event.sourceFile, line: event.lineNumber, sample: event.sample
  }));
}

// This uses the actual background's legal move generator, independently of
// Stockfish's PV parser. No engine or chess behavior is stubbed for validation.
function validatePv(fen, pv) {
  let parsed = parseFEN(fen);
  const steps = [];
  for (const uci of pv || []) {
    const legal = generateLegalMoves(parsed.board, parsed.turn, parsed.castling, parsed.epSquare);
    const text = move => `${"abcdefgh"[move.fromC]}${8 - move.fromR}${"abcdefgh"[move.toC]}${8 - move.toR}${move.promo || ""}`;
    const move = legal.find(candidate => text(candidate) === uci);
    if (!move) return { ok: false, uci, legal: legal.map(text), steps };
    parsed = {
      ...parsed, board: makeMove(parsed.board, move), turn: parsed.turn === "w" ? "b" : "w",
      castling: updateCastlingAfterMove(parsed.castling, move), epSquare: getNextEpSquare(move)
    };
    steps.push(uci);
  }
  return {
    ok: steps.length > 0, steps, inCheck: isKingInCheck(parsed.board, parsed.turn),
    replies: generateLegalMoves(parsed.board, parsed.turn, parsed.castling, parsed.epSquare).length
  };
}

async function run() {
  await fs.access(tempParent);
  await fs.access(chromePath);
  await fs.access(assetsDir);
  const outputDir = await fs.mkdtemp(path.join(tempParent, "cc-engine-browser-"));
  const profileDir = path.join(outputDir, "chrome-profile");
  const snapshot = new Map();
  const report = {
    startedAt: new Date().toISOString(), assetsDir, outputDir, skipHigh,
    coverage: "Actual packaged owned engine host, background/runtime/offscreen, Lite compiled JavaScript and full single-thread Stockfish WASM. Only native transport/profile/forwarding stubbed. CDP logpoints observe unchanged Worker traffic; Worker/fetch/Blob remain native. No remote page/site/account/game or native input. Desktop Chrome is not Android WebView or on-device thermal testing.",
    sources: [], checks: [], warnings: [], cases: [], analyses: [], requests: [], workerTargets: [], targetEvents: [],
    network: [], networkFailures: [], serverRequests: [], blockedRequests: [], blockedBackgroundRequests: [], console: [], exceptions: [], instrumentationErrors: []
  };
  for (const name of assetNames) {
    const bytes = await fs.readFile(path.join(assetsDir, name));
    snapshot.set(name, bytes);
    report.sources.push({ name, bytes: bytes.length, sha256: hash(bytes) });
  }
  const hostHtml = snapshot.get("engine/engine-host.html").toString("utf8");
  const csp = hostHtml.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
  report.csp = csp;
  const check = (name, passed, evidence, context) => {
    report.checks.push({ name, passed: Boolean(passed), context, evidence });
    if (!passed) console.log(`FAIL ${context || "global"} ${name}: ${JSON.stringify(evidence)}`);
  };
  let server;
  let browser;
  let cdp;
  let pageSession;
  let stopped = false;
  let exitPromise;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (cdp) {
      try { await cdp.send("Browser.close", {}, undefined, 4000); } catch (_) {}
      cdp.close();
    }
    if (browser && browser.exitCode === null && browser.signalCode === null) {
      await Promise.race([exitPromise, delay(2000)]);
      if (browser.exitCode === null && browser.signalCode === null) {
        if (process.platform === "win32") {
          const killer = spawn("taskkill", ["/PID", String(browser.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          await Promise.race([once(killer, "exit"), delay(4000)]);
        } else browser.kill("SIGKILL");
        await Promise.race([exitPromise, delay(2000)]);
      }
    }
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await fs.rm(profileDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(error => { report.profileCleanupError = error.message; });
    report.cleanup = {
      browserPid: browser?.pid, browserExited: !browser || browser.exitCode !== null || browser.signalCode !== null,
      serverClosed: !server?.listening, profileRemoved: !report.profileCleanupError,
      engineTargetsBeforeBrowserClose: report.engineTargetsBeforeBrowserClose
    };
  };
  const interrupted = () => { void stop().finally(() => process.exit(130)); };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  const deadline = setTimeout(() => { console.error("Harness exceeded finite 300s deadline"); interrupted(); }, 300000);
  try {
    server = http.createServer((request, response) => {
      const url = new URL(request.url, "http://127.0.0.1");
      const prefix = url.pathname.startsWith("/__cc_assets/") ? "/__cc_assets/" : url.pathname.startsWith("/assets/") ? "/assets/" : "";
      const name = prefix ? url.pathname.slice(prefix.length) : "";
      const bytes = snapshot.get(name);
      report.serverRequests.push({ at: Date.now(), method: request.method, url: url.pathname, host: request.headers.host, bytes: bytes?.length || 0 });
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      if (!bytes || !["GET", "HEAD"].includes(request.method)) {
        response.writeHead(404); response.end(); return;
      }
      const type = name.endsWith(".html") ? "text/html; charset=utf-8" : name.endsWith(".wasm") ? "application/wasm" : "application/javascript; charset=utf-8";
      response.writeHead(200, { "Content-Type": type, "Content-Length": bytes.length });
      response.end(request.method === "HEAD" ? undefined : bytes);
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const origin = `http://127.0.0.1:${port}`;
    report.origin = origin;
    report.serverPort = port;
    browser = spawn(chromePath, [
      "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
      "--disable-component-update", "--disable-sync", "--disable-extensions", "--no-proxy-server",
      "--remote-debugging-port=0", `--user-data-dir=${profileDir}`,
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost", "about:blank"
    ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    exitPromise = once(browser, "exit").catch(() => {});
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
    const protocol = await (await fetch(`http://${new URL(websocketUrl).host}/json/protocol`)).json();
    const blockCommand = protocol.domains.find(domain => domain.domain === "Network")?.commands?.find(command => command.name === "setBlockedURLs");
    if (!blockCommand?.parameters?.some(parameter => parameter.name === "urlPatterns")) throw new Error("Chrome lacks ordered Network.setBlockedURLs rules required for strict worker network isolation");
    const networkRules = { urls: [], urlPatterns: [
      { urlPattern: `${origin}/*`, block: false },
      { urlPattern: "http://*/*", block: true },
      { urlPattern: "https://*/*", block: true }
    ] };
    report.networkBlocking = { api: "Network.setBlockedURLs", rules: networkRules, workerSessions: [] };
    console.log(`BROWSER ${report.browser.product}; owned host ${origin}/assets/engine/engine-host.html`);
    console.log(`CSP ${csp}`);
    console.log(`SOURCES ${report.sources.map(source => `${source.name}=${source.sha256.slice(0, 12)}(${source.bytes})`).join(", ")}`);
    const sessions = new Set();
    const backgroundSessions = new Set();
    let browserContextId;
    const send = (method, params, timeout) => cdp.send(method, params, pageSession, timeout);
    const evaluate = async (fn, ...args) => {
      const expression = typeof fn === "string" ? fn : `(${fn.toString()})(${args.map(arg => JSON.stringify(arg)).join(",")})`;
      const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, allowUnsafeEvalBlockedByCSP: false }, 80000);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const waitFor = async (fn, timeout = 5000) => {
      const until = Date.now() + timeout;
      while (Date.now() < until) { if (await fn()) return; await delay(30); }
      throw new Error(`Condition timed out after ${timeout}ms`);
    };
    const workers = async () => (await cdp.send("Target.getTargets")).targetInfos.filter(info => ["worker", "shared_worker"].includes(info.type) && info.browserContextId === browserContextId);
    const waitNoWorkers = () => waitFor(async () => (await workers()).length === 0);
    cdp.on("Fetch.requestPaused", message => {
      if (!sessions.has(message.sessionId) && !backgroundSessions.has(message.sessionId)) return;
      const paused = message.params;
      const url = new URL(paused.request.url);
      const prefix = url.pathname.startsWith("/__cc_assets/") ? "/__cc_assets/" : url.pathname.startsWith("/assets/") ? "/assets/" : "";
      const allowed = url.origin === origin && url.protocol === "http:" && prefix && snapshot.has(url.pathname.slice(prefix.length));
      if (!allowed) (backgroundSessions.has(message.sessionId) ? report.blockedBackgroundRequests : report.blockedRequests).push({ url: url.href, type: paused.resourceType, sessionId: message.sessionId });
      void cdp.send(allowed ? "Fetch.continueRequest" : "Fetch.failRequest", allowed ? { requestId: paused.requestId } : { requestId: paused.requestId, errorReason: "BlockedByClient" }, message.sessionId).catch(() => {});
    });
    cdp.on("Network.requestWillBeSent", message => {
      if (sessions.has(message.sessionId)) report.network.push({ at: Date.now(), requestId: message.params.requestId, url: message.params.request.url, type: message.params.type, sessionId: message.sessionId });
    });
    cdp.on("Network.loadingFailed", message => {
      if (sessions.has(message.sessionId)) report.networkFailures.push({ sessionId: message.sessionId, ...message.params });
    });
    cdp.on("Runtime.consoleAPICalled", message => {
      if (sessions.has(message.sessionId)) report.console.push({ sessionId: message.sessionId, type: message.params.type, args: message.params.args.map(arg => arg.value ?? arg.description) });
    });
    cdp.on("Runtime.exceptionThrown", message => {
      if (sessions.has(message.sessionId)) report.exceptions.push({ sessionId: message.sessionId, details: message.params.exceptionDetails });
    });
    cdp.on("Target.targetDestroyed", message => report.targetEvents.push({ at: Date.now(), type: "destroyed", targetId: message.params.targetId }));
    cdp.on("Target.detachedFromTarget", message => report.targetEvents.push({ at: Date.now(), type: "detached", ...message.params }));
    cdp.on("Target.attachedToTarget", message => {
      if (!message.sessionId && message.params.targetInfo.type === "service_worker") {
        const child = message.params;
        backgroundSessions.add(child.sessionId);
        // Branded Chrome may load policy/component extension service workers
        // even with --disable-extensions. They are not app engine workers.
        void (async () => {
          await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "http://*" }, { urlPattern: "https://*" }] }, child.sessionId);
          await cdp.send("Runtime.runIfWaitingForDebugger", {}, child.sessionId);
        })().catch(error => report.instrumentationErrors.push({ target: child.targetInfo, error: error.message }));
        return;
      }
      if (!sessions.has(message.sessionId)) return;
      const child = message.params;
      sessions.add(child.sessionId);
      report.workerTargets.push({ at: Date.now(), sessionId: child.sessionId, waitingForDebugger: child.waitingForDebugger, ...child.targetInfo });
      void (async () => {
        await cdp.send("Runtime.enable", {}, child.sessionId);
        await cdp.send("Network.enable", {}, child.sessionId);
        await cdp.send("Network.setBlockedURLs", networkRules, child.sessionId);
        report.networkBlocking.workerSessions.push(child.sessionId);
        await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, child.sessionId);
        await cdp.send("Runtime.runIfWaitingForDebugger", {}, child.sessionId);
      })().catch(error => {
        report.instrumentationErrors.push({ target: child.targetInfo, error: error.message });
        void cdp.send("Runtime.runIfWaitingForDebugger", {}, child.sessionId).catch(() => {});
      });
    });
    await cdp.send("Target.setDiscoverTargets", { discover: true });
    await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: "service_worker" }, { exclude: true }] });
    browserContextId = (await cdp.send("Target.createBrowserContext", { disposeOnDetach: true })).browserContextId;
    report.browserContextId = browserContextId;
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", browserContextId });
    const attached = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    pageSession = attached.sessionId;
    sessions.add(pageSession);
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Network.enable");
    await send("Network.setBlockedURLs", networkRules);
    await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    await send("Page.addScriptToEvaluateOnNewDocument", { source: `(${installNativeTransport.toString()})(${JSON.stringify(profile("LOW"))})` });
    await send("Debugger.enable");
    const offscreenUrl = `${origin}/__cc_assets/offscreen/offscreen.js`;
    const logpoints = [];
    const lines = snapshot.get("offscreen/offscreen.js").toString("utf8").split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const command = lines[index].match(/\b(?:worker|currentWorker)\.postMessage\((.+?)\);/);
      const output = lines[index].includes('const line = String(rawLine || "").trim();');
      if (!command && !output) continue;
      const value = output ? "rawLine" : command[1];
      const condition = `(globalThis.__engineBrowserHarness.trace.push({at:performance.now(),generation,backend:configuredBackend,phase,direction:${JSON.stringify(output ? "fromWorker" : "toWorker")},data:${value}}),false)`;
      const point = await send("Debugger.setBreakpointByUrl", { url: offscreenUrl, lineNumber: index, condition });
      logpoints.push({ line: index + 1, value, breakpointId: point.breakpointId });
    }
    report.logpoints = logpoints;
    check("UCI logpoints installed without replacing Worker", logpoints.length >= 10, logpoints);
    await send("Page.navigate", { url: `${origin}/assets/engine/engine-host.html` });
    await waitFor(() => evaluate(() => Boolean(window.CCEngineHost?.isAlive() && window.__engineBrowserHarness.readyCount && window.__CC_DEVICE_PROFILE__?.recommendation?.tier === "LOW")));
    const environment = await evaluate(() => ({
      href: location.href, secureContext: isSecureContext, crossOriginIsolated,
      csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]').content,
      listeners: window.__CC_ENGINE_RUNTIME__.listenerCount,
      worker: Function.prototype.toString.call(Worker), postMessage: Function.prototype.toString.call(Worker.prototype.postMessage),
      terminate: Function.prototype.toString.call(Worker.prototype.terminate), fetch: Function.prototype.toString.call(fetch),
      blob: Function.prototype.toString.call(Blob), profile: window.__CC_DEVICE_PROFILE__
    }));
    report.environment = environment;
    check("actual host retains exact restrictive CSP", environment.csp === csp && csp.includes("worker-src 'self'") && !csp.includes("blob:") && !csp.includes("'unsafe-eval'"), environment);
    check("actual runtime listeners and native web APIs", environment.listeners === 2 && [environment.worker, environment.postMessage, environment.terminate, environment.fetch, environment.blob].every(text => text.includes("[native code]")), environment);

    let requestSequence = 0;
    const makeMessage = (type, extra = {}) => ({
      type, target: "background-engine", requestId: `real-engine-${++requestSequence}`, clientInstanceId: "browser-engine-client",
      fen: START, backend: FULL, hashMb: 128, movetimeMs: 10000, multiPv: 3, uciMoves: [], useStartposMoves: false,
      meta: { sessionId: "real-browser-host", positionId: requestSequence, elo: 3190, engineMax: true }, ...extra
    });
    const request = async (type, extra = {}) => {
      const message = makeMessage(type, extra);
      const started = performance.now();
      const id = await evaluate(message => window.__engineBrowserHarness.begin(message), message);
      const response = await evaluate(id => window.__engineBrowserHarness.wait(id), id);
      const record = { message, id, response, elapsedMs: Math.round(performance.now() - started) };
      report.requests.push(record);
      return record;
    };
    const trace = () => evaluate(() => window.__engineBrowserHarness.trace);
    const runCase = async (context, fn) => {
      const started = performance.now();
      const startChecks = report.checks.length;
      try { await fn(context); } catch (error) {
        check("case completes", false, { error: error.stack, csp, lastRequest: report.requests.at(-1), traceTail: (await trace().catch(() => [])).slice(-8) }, context);
      }
      const checks = report.checks.slice(startChecks);
      const summary = { context, elapsedMs: Math.round(performance.now() - started), passed: checks.filter(item => item.passed).length, failed: checks.filter(item => !item.passed).length };
      report.cases.push(summary);
      console.log(`CASE ${context}: ${summary.passed} passed, ${summary.failed} failed, ${summary.elapsedMs}ms`);
    };
    const init = async (context, tier) => {
      const start = (await trace()).length;
      const record = await request("ENGINE_INIT");
      const payload = record.response.payload;
      const status = payload?.result?.status;
      const expected = tier === "HIGH" ? FULL : LITE;
      check("native ENGINE_INIT returns real ready status", payload?.ok && payload.result?.ok && status?.ready && status.backend === expected, record, context);
      if (!status?.ready) throw new Error(`Actual ${tier} initialization failed: ${JSON.stringify(record.response)}`);
      const traffic = (await trace()).slice(start);
      check("actual uci -> uciok -> isready -> readyok startup barriers", traffic.findIndex(entry => entry.direction === "toWorker" && entry.data === "uci") >= 0 && traffic.findIndex(entry => entry.direction === "fromWorker" && entry.data === "uciok") > traffic.findIndex(entry => entry.direction === "toWorker" && entry.data === "uci") && traffic.findIndex(entry => entry.direction === "fromWorker" && entry.data === "readyok") > traffic.findIndex(entry => entry.direction === "toWorker" && entry.data === "isready"), traffic, context);
      const current = await workers();
      check("one actual owned packaged worker", current.length === 1 && current[0].url === `${origin}/__cc_assets/${tier === "HIGH" ? "vendor/stockfish/stockfish-19-single.js" : "lib/stockfish-local.js"}`, current, context);
      console.log(`INIT ${tier}: ready=${status.ready} backend=${status.backend} hash=${status.hashMb} elapsed=${record.elapsedMs}ms`);
    };
    const analyze = async (context, tier, name, fen, extra = {}) => {
      const start = (await trace()).length;
      const record = await request("ENGINE_ANALYZE", { fen, ...(name === "mate" ? { multiPv: 1 } : {}), ...extra });
      const payload = record.response.payload;
      const engineResponse = payload?.result;
      const result = engineResponse?.result;
      check("native ENGINE_ANALYZE completes successfully", payload?.ok && engineResponse?.ok && engineResponse.requestId === record.message.requestId, record, context);
      if (!result) throw new Error(`Actual analysis failed: ${JSON.stringify(record.response)}`);
      const traffic = (await trace()).slice(start);
      const rawBestmove = traffic.find(entry => entry.direction === "fromWorker" && String(entry.data).startsWith(`bestmove ${result.bestUci}`));
      const goIndex = traffic.findIndex(entry => entry.direction === "toWorker" && String(entry.data).startsWith("go movetime "));
      const readyIndex = traffic.findIndex(entry => entry.direction === "fromWorker" && entry.data === "readyok");
      const syncIndex = traffic.findIndex(entry => entry.direction === "toWorker" && entry.data === "isready");
      const cap = tier === "LOW" ? 180 : tier === "HIGH" ? 400 : 260;
      const hashCap = tier === "LOW" ? 16 : 32;
      const bestmoveConfirmed = Boolean(rawBestmove && goIndex >= 0 && rawBestmove.at >= traffic[goIndex].at);
      check("searchCompleted=true and matching actual bestmove receipt", result.searchCompleted === true && bestmoveConfirmed && result.primaryLine?.uci === result.bestUci && !result.cached, { searchCompleted: result.searchCompleted, bestmoveConfirmed, rawBestmove, bestUci: result.bestUci, primary: result.primaryLine?.uci, cached: result.cached }, context);
      check("real per-search isready/readyok precedes position/go", syncIndex >= 0 && readyIndex > syncIndex && goIndex > readyIndex && traffic.slice(readyIndex + 1, goIndex).some(entry => entry.direction === "toWorker" && entry.data === `position fen ${fen}`), traffic, context);
      check("mobile single-thread/hash/time/MultiPV caps", result.workers === 1 && result.coresUsed === 1 && result.hashMb <= hashCap && result.resources?.totalHashMb <= hashCap && Object.keys(result.lines || {}).length <= 2 && goIndex >= 0 && Number(String(traffic[goIndex].data).split(" ").at(-1)) <= cap, { workers: result.workers, coresUsed: result.coresUsed, hashMb: result.hashMb, resources: result.resources, go: traffic[goIndex], lines: Object.keys(result.lines || {}) }, context);
      const expected = tier === "HIGH" ? FULL : LITE;
      check("owned backend matches live profile", result.backend === expected && engineResponse.backend === expected && result.resources?.fullNnue === (tier === "HIGH"), result, context);
      const legality = [];
      for (const [index, line] of Object.entries(result.lines || {})) {
        const legal = await evaluate(validatePv, fen, line.pv);
        legality.push({ index, uci: line.uci, pv: line.pv, legal });
        check(`PV${index} is a legal, nonempty move chain`, legal.ok && line.pv?.[0] === line.uci, legal, context);
      }
      const completeInfo = result.primaryLine.depth > 0 && result.primaryLine.nodes > 0 && Object.keys(result.lines).length === Math.min(2, record.message.multiPv);
      const honestFallback = result.partial === true && bestmoveConfirmed && result.primaryLine.depth === 0 && result.primaryLine.nodes === 0 && result.primaryLine.pv.length === 1;
      check("real info/PVs or explicitly partial completed-bestmove fallback", (!result.partial && completeInfo) || (result.partial && (completeInfo || honestFallback)), { partial: result.partial, primaryLine: result.primaryLine, lines: Object.keys(result.lines) }, context);
      if (result.partial) report.warnings.push({
        context, name, requestId: record.message.requestId, bestUci: result.bestUci,
        reason: "Completed real bestmove, but exact scored PV/alternatives are unavailable; production explicitly reports partial instead of fabricating an evaluation.",
        boundedInfo: traffic.filter(entry => entry.direction === "fromWorker" && /\b(?:lowerbound|upperbound)\b/.test(entry.data)), result
      });
      if (name === "mate") {
        const primary = legality.find(item => item.index === "1");
        check("forced Rd8# is actually mate", result.bestUci === "d1d8" && result.primaryLine.isMate && result.primaryLine.mateIn === 1 && primary?.legal.inCheck && primary.legal.replies === 0, { best: result.bestUci, line: result.primaryLine, legal: primary?.legal }, context);
      }
      const evidence = { context, name, tier, fen, request: record.message, elapsedMs: record.elapsedMs, backend: result.backend, bestUci: result.bestUci, searchCompleted: result.searchCompleted, bestmoveConfirmed, rawBestmove, result, legality, traffic };
      report.analyses.push(evidence);
      console.log(`SEARCH ${tier} ${name}: best=${result.bestUci} PV=${result.primaryLine.pv.join(" ")} depth=${result.primaryLine.depth} nodes=${result.primaryLine.nodes} complete=${result.searchCompleted} bestmove-confirmed=${bestmoveConfirmed} partial=${result.partial} hash=${result.hashMb} elapsed=${record.elapsedMs}ms`);
      return evidence;
    };
    const refresh = newProfile => evaluate(newProfile => {
      window.__engineBrowserHarness.profile = newProfile;
      window.CCEngineHost.refreshDeviceProfileForApp(newProfile);
    }, newProfile);
    const changeDuringSearch = async (context, action, newProfile) => {
      const message = makeMessage("ENGINE_ANALYZE", { fen: TACTICAL, multiPv: 1, movetimeMs: 9876 });
      const result = await evaluate(async (message, action, newProfile) => {
        const harness = window.__engineBrowserHarness;
        const start = harness.trace.length;
        const id = harness.begin(message);
        const until = performance.now() + 8000;
        while (!harness.trace.slice(start).some(entry => entry.direction === "toWorker" && String(entry.data).startsWith("go movetime ")) && performance.now() < until && !harness.pending.get(id).response) {
          await new Promise(resolve => setTimeout(resolve, 1));
        }
        const activeAtChange = !harness.pending.get(id).response;
        if (action === "suspend") window.CCEngineHost.suspendForApp();
        else {
          harness.profile = newProfile;
          window.CCEngineHost.refreshDeviceProfileForApp(newProfile);
        }
        const response = await harness.wait(id);
        return { activeAtChange, response, traffic: harness.trace.slice(start), suspended: window.__CC_ENGINE_RUNTIME__.suspended, contexts: await chrome.runtime.getContexts() };
      }, message, action, newProfile);
      report.requests.push({ message, response: result.response, lifecycle: action });
      const code = result.response.payload?.error?.code || result.response.payload?.result?.code;
      check("lifecycle/profile change interrupts a real active search", result.activeAtChange && result.traffic.some(entry => entry.direction === "toWorker" && String(entry.data).startsWith("go movetime ")) && code === (action === "suspend" ? "ENGINE_SUSPENDED" : "PROFILE_CHANGED"), result, context);
      await waitNoWorkers();
      check("actual worker target disappears after change", (await workers()).length === 0, { workers: await workers(), result }, context);
      if (action === "suspend") check("suspend closes virtual offscreen context", result.suspended && result.contexts.length === 0, result, context);
      console.log(`INTERRUPT ${action}: code=${code} active=${result.activeAtChange} workers=0`);
    };

    await runCase("LOW startup + startpos/tactical/mate", async context => {
      await init(context, "LOW");
      const child = report.workerTargets.at(-1);
      const probeUrl = `http://127.0.0.2:${port}/__cc_network_isolation_probe__`;
      const probe = await cdp.send("Runtime.evaluate", {
        expression: `fetch(${JSON.stringify(probeUrl)}).then(() => ({rejected:false}), error => ({rejected:true,error:String(error)}))`,
        returnByValue: true, awaitPromise: true, allowUnsafeEvalBlockedByCSP: false
      }, child.sessionId);
      await waitFor(async () => report.networkFailures.some(failure => report.network.some(item => item.url === probeUrl && item.requestId === failure.requestId && item.sessionId === failure.sessionId)));
      const failed = report.networkFailures.find(failure => report.network.some(item => item.url === probeUrl && item.requestId === failure.requestId && item.sessionId === failure.sessionId));
      report.networkProbe = { url: probeUrl, result: probe.result?.value, failure: failed };
      check("actual worker fetch to alternate loopback is blocked by CDP before HTTP", probe.result?.value?.rejected && failed?.blockedReason === "inspector" && !report.serverRequests.some(item => item.url === "/__cc_network_isolation_probe__"), report.networkProbe, context);
      await analyze(context, "LOW", "startpos", START);
      await analyze(context, "LOW", "tactical", TACTICAL);
      await analyze(context, "LOW", "mate", MATE);
    });
    await runCase("ENGINE_RELEASE and actual cold restart", async context => {
      const previous = await workers();
      const released = await request("ENGINE_RELEASE");
      check("actual ENGINE_RELEASE acknowledges termination", released.response.payload?.result?.released === true, released, context);
      await waitNoWorkers();
      const status = await request("ENGINE_STATUS");
      check("release leaves no worker or ready engine", (await workers()).length === 0 && !status.response.payload?.result?.status?.ready, status, context);
      await analyze(context, "LOW", "release-restart", START);
      check("restart creates a different real worker target", (await workers()).length === 1 && (await workers())[0].targetId !== previous[0]?.targetId, { previous, current: await workers() }, context);
    });
    await runCase("BALANCED existing-session profile + legal searches", async context => {
      await refresh(profile("BALANCED"));
      await analyze(context, "BALANCED", "startpos", START);
      await analyze(context, "BALANCED", "tactical", TACTICAL);
      await analyze(context, "BALANCED", "mate", MATE);
    });
    await runCase("BALANCED to thermal LOW during actual search", async context => {
      await changeDuringSearch(context, "profile", profile("BALANCED", true));
      await analyze(context, "LOW", "thermal-restart", START);
    });
    await runCase("suspendForApp blocks, terminates, then lazy resume", async context => {
      await changeDuringSearch(context, "suspend", null);
      const blocked = await request("ENGINE_ANALYZE");
      check("new analysis is rejected while suspended", blocked.response.payload?.error?.code === "ENGINE_SUSPENDED" && (await workers()).length === 0, blocked, context);
      await evaluate(newProfile => {
        window.__engineBrowserHarness.profile = newProfile;
        window.CCEngineHost.resumeForApp(newProfile);
      }, profile("BALANCED"));
      check("resume stays cold until a new request", (await workers()).length === 0 && !await evaluate(() => window.__CC_ENGINE_RUNTIME__.suspended), await workers(), context);
      await analyze(context, "BALANCED", "resume-restart", START);
    });
    if (!skipHigh) {
      await runCase("HIGH actual full single-thread WASM", async context => {
        await refresh(profile("HIGH"));
        await init(context, "HIGH");
        await analyze(context, "HIGH", "startpos", START);
        await analyze(context, "HIGH", "tactical", TACTICAL);
        await analyze(context, "HIGH", "mate", MATE);
        check("actual full WASM fetched from same owned origin", report.serverRequests.some(item => item.url === "/__cc_assets/vendor/stockfish/stockfish-19-single.wasm" && item.bytes === snapshot.get("vendor/stockfish/stockfish-19-single.wasm").length), report.serverRequests.filter(item => item.url.includes(".wasm")), context);
      });
      await runCase("HIGH full worker to thermal LOW Lite", async context => {
        if ((await workers()).some(info => info.url.includes("stockfish-19-single.js"))) await changeDuringSearch(context, "profile", profile("HIGH", true));
        else await refresh(profile("HIGH", true));
        await analyze(context, "LOW", "full-thermal-restart", START);
      });
    }
    await runCase("final release + CSP/network/native API integrity", async context => {
      await request("ENGINE_RELEASE");
      await waitNoWorkers();
      const state = await evaluate(() => ({
        exceptions: window.__engineBrowserHarness.exceptions, cspViolations: window.__engineBrowserHarness.cspViolations,
        trace: window.__engineBrowserHarness.trace, envelopes: window.__engineBrowserHarness.envelopes,
        worker: Function.prototype.toString.call(Worker), postMessage: Function.prototype.toString.call(Worker.prototype.postMessage),
        terminate: Function.prototype.toString.call(Worker.prototype.terminate), fetch: Function.prototype.toString.call(fetch)
      }));
      report.pageState = state;
      check("Threads=1 is actually sent on every initialized worker", [...new Set(state.trace.filter(item => item.direction === "toWorker" && item.data === "uci").map(item => item.generation))].every(generation => state.trace.some(item => item.generation === generation && item.direction === "toWorker" && item.data === "setoption name Threads value 1")) && !state.trace.some(item => item.direction === "toWorker" && /^setoption name Threads value (?!1$)/.test(item.data)), state.trace.filter(item => /Threads/.test(item.data)), context);
      check("no remote HTTP or blob worker/request attempted", report.blockedRequests.every(item => (new URL(item.url).pathname === "/favicon.ico" && new URL(item.url).origin === origin) || (item.url === report.networkProbe?.url && report.networkProbe.failure?.blockedReason === "inspector")) && report.network.every(item => new URL(item.url).origin === origin || (item.url === report.networkProbe?.url && report.networkProbe.failure?.blockedReason === "inspector")) && report.workerTargets.every(info => info.url.startsWith(`${origin}/__cc_assets/`) && !info.url.startsWith("blob:")), { blocked: report.blockedRequests, network: report.network, targets: report.workerTargets, deliberateLoopbackProbe: report.networkProbe }, context);
      check("unchanged CSP has no runtime violations", state.cspViolations.length === 0, state.cspViolations, context);
      check("no actual page/worker exceptions or instrumentation failures", state.exceptions.length === 0 && report.exceptions.length === 0 && report.instrumentationErrors.length === 0, { page: state.exceptions, cdp: report.exceptions, instrumentation: report.instrumentationErrors }, context);
      check("nonloopback HTTP rules installed before every real worker starts", report.workerTargets.length > 0 && report.workerTargets.every(info => report.networkBlocking.workerSessions.includes(info.sessionId)), report.networkBlocking, context);
      check("Worker/fetch remain real native APIs after execution", [state.worker, state.postMessage, state.terminate, state.fetch].every(text => text.includes("[native code]")), state, context);
      report.engineTargetsBeforeBrowserClose = await workers();
      check("no engine worker survives final release", report.engineTargetsBeforeBrowserClose.length === 0, report.engineTargetsBeforeBrowserClose, context);
    });
  } catch (error) {
    report.fatalError = error.stack;
    console.error(error.stack);
  } finally {
    clearTimeout(deadline);
    await stop();
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
  }
  for (const source of report.sources) source.changedDuringRun = hash(await fs.readFile(path.join(assetsDir, source.name))) !== source.sha256;
  check("source snapshot still matches current production assets", report.sources.every(source => !source.changedDuringRun), report.sources);
  check("browser/server/profile cleaned", report.cleanup?.browserExited && report.cleanup?.serverClosed && report.cleanup?.profileRemoved, report.cleanup);
  report.finishedAt = new Date().toISOString();
  report.passed = report.checks.filter(item => item.passed).length;
  report.failed = report.checks.filter(item => !item.passed).length;
  const reportPath = path.join(outputDir, "report.json");
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(`RESULT ${report.passed} passed, ${report.failed} failed; cleanup=${JSON.stringify(report.cleanup)}`);
  console.log(`REPORT ${reportPath}`);
  for (const warning of report.warnings) console.log(`LIMITATION ${warning.context} ${warning.name}: ${warning.reason} best=${warning.bestUci}`);
  if (skipHigh) console.log("LIMITATION HIGH full WASM intentionally skipped by --skip-high");
  process.exitCode = report.fatalError || report.failed ? 1 : 0;
}

run().catch(error => { console.error(error.stack); process.exitCode = 1; });
