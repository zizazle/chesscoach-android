"use strict";

// Production JS and a real packaged Lite Worker. The site and Android delivery
// host are fixtures; this is not a physical Android/WebView test.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const https = require("node:https");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const ASSETS = path.resolve(__dirname, "../../main/assets");
const TEMP = process.env.CC_BROWSER_TEMP || path.join(os.tmpdir(), "kilo");
const CHROME = process.env.CC_CHROME_BINARY || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const PROFILE = { platform: "android", memory: { totalBucketMiB: 4096 }, cpu: { logicalCores: 8 },
  power: { saveMode: false, thermalStatus: 0, backgroundRestricted: false },
  recommendation: { tier: "BALANCED", threads: 1, hashMiB: 32, maxMovetimeMs: 260, movetimeScale: 1, animations: false, visualEffects: false } };

function fixtureTls() {
  const der = (tag, ...parts) => {
    const value = Buffer.concat(parts);
    const length = value.length < 128 ? [value.length] : [...Buffer.from(value.length.toString(16).padStart(value.length > 255 ? 4 : 2, "0"), "hex")];
    return Buffer.concat([Buffer.from([tag, ...(value.length < 128 ? length : [128 + length.length, ...length])]), value]);
  };
  const pair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const algorithm = der(48, der(6, Buffer.from("2a864886f70d01010b", "hex")), der(5, Buffer.alloc(0)));
  const name = der(48, der(49, der(48, der(6, Buffer.from("550403", "hex")), der(12, Buffer.from("ChessCoach isolated fixture")))));
  const serial = crypto.randomBytes(8); serial[0] = (serial[0] & 127) || 1;
  const tbs = der(48, der(160, der(2, Buffer.from([2]))), der(2, serial), algorithm, name,
    der(48, der(23, Buffer.from("200101000000Z")), der(23, Buffer.from("490101000000Z"))), name,
    pair.publicKey.export({ type: "spki", format: "der" }));
  const certificate = der(48, tbs, algorithm, der(3, Buffer.concat([Buffer.from([0]), crypto.sign("sha256", tbs, pair.privateKey)])));
  return { key: pair.privateKey.export({ type: "pkcs8", format: "pem" }),
    cert: `-----BEGIN CERTIFICATE-----\n${certificate.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END CERTIFICATE-----\n` };
}

function installEngine(profile) {
  window.__engineProof = { commands: [], errors: [] };
  const post = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (command, ...rest) {
    window.__engineProof.commands.push(String(command));
    return post.call(this, command, ...rest);
  };
  window.addEventListener("error", event => window.__engineProof.errors.push(event.message));
  window.CCEngineNative = { onmessage: null, postMessage(text) {
    const envelope = JSON.parse(text);
    if (envelope.type === "device.profile.get") queueMicrotask(() => window.CCEngineNative.onmessage?.({ data: JSON.stringify({
      v: 1, scope: "chesscoach.android", source: "native", target: "ENGINE", channel: "device",
      type: "device.profile.response", id: envelope.id, payload: { ok: true, profile }
    }) }));
    else window.__ccNativeBinding(text);
  } };
}

function installSite() {
  const platform = location.hostname.includes("chess.com") ? "chesscom" : "lichess";
  const h = window.__fullFlow = { platform, root: null, registrations: 0, own: 0, ply: 0, moves: [],
    down: 0, up: 0, selected: null, errors: [], events: [], boardLoaded: false };
  window.__ChessCoachRegisterHudShadow = root => { h.root = root; h.registrations++; };
  window.addEventListener("error", event => h.errors.push({ message: event.message, file: event.filename, line: event.lineno }));
  window.addEventListener("unhandledrejection", event => h.errors.push({ message: String(event.reason?.stack || event.reason) }));
  for (const type of ["pagehide", "pageshow", "cc-core-state"]) window.addEventListener(type, event => h.events.push({ type, persisted: event.persisted, detail: event.detail || null }));
  window.CCNative = { onmessage: null, postMessage(text) {
    window.__ccNativeBinding(JSON.stringify({ envelope: JSON.parse(text), documentToken: window.__CC_ANDROID_RUNTIME__?.inputDocumentToken || null }));
  } };
  h.startBoard = () => {
    h.board = document.getElementById("fixture-board");
    h.reset = () => {
      h.grid = ["rnbqkbnr", "pppppppp", "........", "........", "........", "........", "PPPPPPPP", "RNBQKBNR"].map(row => [...row].map(piece => piece === "." ? null : piece));
      h.ply = 0; h.moves = []; h.selected = null; h.draw();
    };
    h.draw = () => {
      const roles = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
      h.board.replaceChildren();
      for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) {
        const piece = h.grid[row][col]; if (!piece) continue;
        const white = piece === piece.toUpperCase();
        const node = document.createElement(platform === "lichess" ? "piece" : "div");
        node.className = platform === "lichess" ? `${white ? "white" : "black"} ${roles[piece.toLowerCase()]}` : `piece ${white ? "w" : "b"}${piece.toLowerCase()} square-${col + 1}${8 - row}`;
        node.style.cssText = `position:absolute;left:${col * 12.5}%;top:${row * 12.5}%;width:12.5%;height:12.5%;font:26px/40px monospace;text-align:center;pointer-events:none;color:${white ? "white" : "#102030"}`;
        node.textContent = piece; h.board.appendChild(node);
      }
      const whiteTurn = h.ply % 2 === 0;
      document.getElementById("fixture-bottom-clock").className = platform === "lichess" ? `rclock-bottom ${whiteTurn ? "running" : ""}` : `clock-bottom ${whiteTurn ? "clock-player-turn" : ""}`;
      document.getElementById("fixture-top-clock").className = platform === "lichess" ? `rclock-top ${whiteTurn ? "" : "running"}` : `clock-top ${whiteTurn ? "" : "clock-player-turn"}`;
      document.getElementById("fixture-prev").dataset.ply = String(h.ply - 1);
      document.getElementById("fixture-next").dataset.ply = String(h.ply + 1);
      h.board.dataset.turn = whiteTurn ? "white" : "black";
      h.boardLoaded = true;
    };
    h.apply = (uci, own = false) => {
      const fromRow = 8 - Number(uci[1]), fromCol = "abcdefgh".indexOf(uci[0]);
      const toRow = 8 - Number(uci[3]), toCol = "abcdefgh".indexOf(uci[2]);
      const piece = h.grid[fromRow]?.[fromCol];
      if (!piece) throw new Error("Fixture move has no source piece: " + uci);
      h.grid[toRow][toCol] = piece; h.grid[fromRow][fromCol] = null;
      h.ply++; h.moves.push(uci); if (own) h.own++;
      h.selected = null; h.draw();
    };
    const squareAt = event => {
      const rect = h.board.getBoundingClientRect();
      return "abcdefgh"[Math.floor((event.clientX - rect.left) / (rect.width / 8))] + (8 - Math.floor((event.clientY - rect.top) / (rect.height / 8)));
    };
    h.board.addEventListener("pointerdown", event => { h.down++; h.dragStart = squareAt(event); });
    h.board.addEventListener("pointercancel", () => { h.selected = null; h.dragStart = null; });
    h.board.addEventListener("pointerup", event => {
      h.up++;
      const square = squareAt(event);
      const dragStart = h.dragStart;
      h.dragStart = null;
      if (dragStart && dragStart !== square) h.apply(dragStart + square, true);
      else if (h.selected && h.selected !== square) h.apply(h.selected + square, true);
      else h.selected = h.selected === square ? null : square;
    });
    // A real empty board is present during bootstrap, then pieces/clock/ply load.
    setTimeout(h.reset, 350);
  };
}

function state() {
  const h = window.__fullFlow, root = h?.root, svg = root?.getElementById("chesscoach-screen-svg");
  return { url: location.href, title: document.title, platform: h?.platform, own: h?.own, moves: h?.moves, down: h?.down, up: h?.up,
    ready: window.__CC_ANDROID_GAME_SESSION__?.isReady, session: window.__CC_ANDROID_GAME_SESSION__?.snapshot(),
    preferences: window.__CC_MOBILE_PREFERENCES__?.get(h?.platform), registrations: h?.registrations,
    boardLoaded: h?.boardLoaded, settingsOpen: window.__CC_ANDROID_SETTINGS_OPEN__, errors: h?.errors,
    status: root?.getElementById("cc-auto-live-status")?.textContent, best: root?.getElementById("cc-best-desc")?.textContent,
    arrows: Boolean(svg?.querySelector("path") && getComputedStyle(svg).display !== "none"),
    animations: svg?.getAnimations({ subtree: true }).filter(animation => animation.playState === "running").length || 0,
    launcher: Boolean(document.getElementById("cc-mobile-launcher-host")), events: h?.events };
}

(async () => {
  await fs.access(TEMP); await fs.access(CHROME);
  const directory = await fs.mkdtemp(path.join(TEMP, "cc-mobile-full-flow-"));
  const oldRunner = await fs.readFile(path.join(__dirname, "mobile-launcher.browser.cjs"), "utf8");
  const CDP = vm.runInThisContext("(() => {" + oldRunner.slice(oldRunner.indexOf("class CDP {"), oldRunner.indexOf("function installMocks()")) + "; return CDP;})()");
  const nativeSource = await fs.readFile(path.resolve(__dirname, "../../main/java/com/chesscoach/app/MainActivity.kt"), "utf8");
  const bootstrapTemplate = /private fun buildDocumentStartScript\([\s\S]*?return """([\s\S]*?)"""\.trimIndent\(\)/.exec(nativeSource)?.[1];
  assert.ok(bootstrapTemplate, "Production native bootstrap must be used");
  const names = ["engine/engine-host.html", "engine/engine-runtime.js", "data/eco-book.js", "background/background.js", "offscreen/offscreen.js", "engine/engine-host.js", "lib/stockfish-local.js", "lib/openings.js", "lib/explainer.js", "lib/phonk-fx.js", "lib/privacy-mask.js", "lib/engine-client.js", "bridge/cc-android-polyfill.js", "bridge/cc-mobile-preferences.js", "bridge/cc-mobile-session.js", "bridge/cc-mobile-launcher-orb.js", "content/content.js", "content/chesscom.js", "content/content.css"];
  const sources = new Map(await Promise.all(names.map(async name => [name, await fs.readFile(path.join(ASSETS, name))])));
  const storage = { cc_mobile_settings_schema: 2, cc_mobile_ui_view_mode: "mini", cc_mobile_ingame_submode: "mini",
    cc_mobile_last_welcome_date: new Date().toISOString().slice(0, 10), cc_mobile_calibrated_lichess: true, cc_mobile_calibrated_chesscom: true };
  for (const platform of ["lichess", "chesscom"]) for (const [key, value] of Object.entries({ workMode: "all", elo: 2000, style: "balanced", showArrows: true,
    showAverageMove: true, showWorstMove: false, autoMoveEnabled: false, autoMoveTriggerRate: 100,
    legitAutoTiming: false, autoMoveDelayMs: platform === "lichess" ? 120 : 220, autoMoveJitterMs: platform === "lichess" ? 0 : 60,
    useAverageMoveSometimes: false, humanHesitationEnabled: false, autoT1LimiterEnabled: false,
    useStockfishWasm: true, phonkEditEnabled: false, audioRadarEnabled: false, roflMode: false, welcomeBannerHidden: true })) {
    if (platform === "lichess" && ["humanHesitationEnabled", "autoT1LimiterEnabled"].includes(key)) continue;
    storage[`${platform}.${key}`] = value;
  }
  let revision = 0, nonceSequence = 0;
  const mutations = new Map(), nonces = new Map(), actions = new Map(), owners = new Map();
  const requests = [], deliveries = [], rows = [], protocolErrors = [];
  const bundles = {};
  for (const platform of ["lichess", "chesscom"]) {
    const order = ["lib/openings.js", "lib/explainer.js", "lib/phonk-fx.js", ...(platform === "chesscom" ? ["lib/privacy-mask.js"] : []), "lib/engine-client.js",
      "bridge/cc-mobile-preferences.js", "bridge/cc-mobile-session.js", "bridge/cc-mobile-launcher-orb.js", `content/${platform === "chesscom" ? "chesscom.js" : "content.js"}`];
    bundles[platform] = `(function(){"use strict";if(window.__ccAndroidBundleState==="ready")return "ready";if(window.__ccAndroidBundleState==="loading")return "loading";window.__ccAndroidBundleState="loading";try{if(window.__CC_ANDROID_BOOTSTRAP_READY__!==true)throw new Error("Native bootstrap unavailable");const chrome=window.__CC_ANDROID_RUNTIME__&&window.__CC_ANDROID_RUNTIME__.chrome;if(!chrome)throw new Error("Android runtime unavailable");\n${order.map(name => sources.get(name).toString() + "\n;\n").join("")}\nwindow.__ccAndroidBundleState="ready";Object.defineProperty(window,"__ccAndroidBundleReady",{value:true,configurable:false});window.dispatchEvent(new CustomEvent("cc-android-ready"));return "ready";}catch(error){window.__ccAndroidBundleState="failed";console.error(error);return "failed";}})();`;
  }
  let server, browser, cdp, engineSession, engineReady = false;
  const live = new Set();
  const stop = async () => {
    if (cdp) { try { await cdp.send("Browser.close"); } catch (_) {} cdp.close(); }
    if (browser && browser.exitCode === null && browser.signalCode === null) {
      await Promise.race([once(browser, "exit"), delay(1200)]);
      if (browser.exitCode === null && browser.signalCode === null) browser.kill();
    }
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  };
  const deadline = setTimeout(() => { console.error("Full-flow deadline exceeded"); void stop().finally(() => process.exit(2)); }, 180000);
  try {
    // Official hostnames keep production platform detection intact, including HSTS.
    server = https.createServer(fixtureTls(), (request, response) => {
      const url = new URL(request.url, "http://localhost");
      if (url.pathname.startsWith("/__cc_assets/")) {
        const name = url.pathname.slice(13), bytes = sources.get(name);
        response.writeHead(bytes ? 200 : 404, { "Content-Type": name.endsWith(".css") ? "text/css" : "application/javascript" }); response.end(bytes || "");
      } else if (url.pathname === "/engine/engine-host.html") {
        response.writeHead(200, { "Content-Type": "text/html" }); response.end(sources.get("engine/engine-host.html"));
      } else if (url.pathname === "/main-bundle.js") {
        response.writeHead(200, { "Content-Type": "application/javascript" }); response.end(bundles[request.headers.host.includes("chess.com") ? "chesscom" : "lichess"]);
      } else if (url.pathname === "/fixture-site.js") {
        response.writeHead(200, { "Content-Type": "application/javascript" }); response.end("window.__fullFlow.startBoard();");
      } else if (url.pathname === "/computer/fixture") {
        const chess = request.headers.host.includes("chess.com");
        response.writeHead(200, { "Content-Type": "text/html", "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; worker-src 'none'" });
        response.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;background:#203040;color:white}#fixture-board{position:fixed;left:20px;top:300px;width:320px;height:320px;touch-action:none;background:repeating-conic-gradient(#718472 0% 25%,#d6dfc9 0% 50%) 0 0/80px 80px}#fixture-bottom-clock{position:fixed;left:260px;top:640px}#fixture-top-clock{position:fixed;left:260px;top:260px}.col1-moves{position:fixed;left:310px;top:100px}</style></head><body><main class="round"><div class="round__app"><div class="main-board"><div class="cg-wrap orientation-white">${chess ? '<wc-chess-board id="fixture-board" orientation="white" data-rated="false"></wc-chess-board>' : '<cg-board id="fixture-board"></cg-board>'}</div></div><div id="fixture-bottom-clock"><span class="clock-time-monospace">2:00</span></div><div id="fixture-top-clock"><span class="clock-time-monospace">2:00</span></div><div class="col1-moves"><button class="fbt" id="fixture-prev" data-ply="-1">Prev</button><button class="fbt" id="fixture-next" data-ply="1">Next</button></div><div class="round__app__table"><l4x></l4x></div></div></main><script src="/fixture-site.js"></script><script src="/main-bundle.js"></script></body></html>`);
      } else { response.writeHead(404); response.end(); }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    browser = spawn(CHROME, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-extensions", "--no-proxy-server", "--ignore-certificate-errors", "--remote-debugging-port=0", `--user-data-dir=${directory}`,
      "--host-resolver-rules=MAP lichess.org 127.0.0.1, MAP www.chess.com 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost", "about:blank"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let startup = "";
    const websocket = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Chrome startup timeout " + startup)), 15000);
      browser.once("error", error => { clearTimeout(timer); reject(error); });
      browser.stderr.on("data", bytes => { startup = (startup + bytes).slice(-8000); const match = startup.match(/DevTools listening on (ws:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
    });
    cdp = await CDP.connect(websocket);
    const rawSend = cdp.send.bind(cdp);
    cdp.send = async (method, parameters, session) => {
      try { return await rawSend(method, parameters, session); }
      catch (error) { throw new Error(`${method}: ${error.message}`); }
    };
    const evaluate = async (session, fn, ...args) => {
      const result = await cdp.send("Runtime.evaluate", { expression: typeof fn === "string" ? fn : `(${fn.toString()})(${args.map(value => JSON.stringify(value)).join(",")})`, returnByValue: true, awaitPromise: true }, session);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const waitFor = async (session, predicate, ms = 12000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { const value = await evaluate(session, predicate); if (value) return value; await delay(60); }
      throw new Error("Full-flow condition timed out: " + predicate + " state=" + JSON.stringify(await evaluate(session, state)));
    };
    const page = async () => {
      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", newWindow: true });
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      await cdp.send("Page.enable", {}, sessionId); await cdp.send("Runtime.enable", {}, sessionId);
      await cdp.send("Runtime.addBinding", { name: "__ccNativeBinding" }, sessionId);
      await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sessionId);
      return { targetId, sessionId };
    };
    const send = (session, token, envelope) => evaluate(session, (expected, data) => {
      if (expected && window.__CC_ANDROID_RUNTIME__?.inputDocumentToken !== expected) return;
      window.CCNative.onmessage?.({ data: JSON.stringify(data) });
    }, token, envelope);
    const reply = (session, token, envelope, payload, type = envelope.type === "input.context.get" ? "input.context.response" : `${envelope.type}.response`) => send(session, token, {
      v: 1, scope: "chesscoach.android", source: "native", target: "REMOTE", channel: envelope.channel, type, id: envelope.id, payload
    });
    cdp.on("Fetch.requestPaused", event => {
      const url = new URL(event.params.request.url);
      const allowed = url.protocol === "https:" && ["127.0.0.1", "lichess.org", "www.chess.com"].includes(url.hostname) && url.port === String(port);
      void cdp.send(allowed ? "Fetch.continueRequest" : "Fetch.failRequest", allowed ? { requestId: event.params.requestId } : { requestId: event.params.requestId, errorReason: "BlockedByClient" }, event.sessionId).catch(() => {});
    });
    async function native(event) {
      const packet = JSON.parse(event.params.payload), envelope = packet.envelope || packet, token = packet.documentToken;
      const session = event.sessionId;
      if (session === engineSession) {
        if (envelope.type === "engine.ready") engineReady = true;
        if (envelope.type === "runtime.response") {
          const owner = owners.get(envelope.id); owners.delete(envelope.id);
          if (owner && live.has(owner.session)) await send(owner.session, owner.token, envelope);
        }
        return;
      }
      if (!live.has(session)) return;
      if (envelope.type === "runtime.message") {
        requests.push(envelope.payload.message); owners.set(envelope.id, { session, token });
        const url = new URL(envelope.payload.sender.url);
        envelope.payload.sender = { id: "chesscoach_android_v1", url: `https://${url.hostname}${url.pathname}${url.search}`, origin: `https://${url.hostname}`, frameId: 0 };
        assert.equal(engineReady, true);
        await evaluate(engineSession, value => window.CCEngineHost.dispatchFromNative(value), envelope);
      } else if (envelope.type === "storage.get") {
        await delay(100);
        await reply(session, token, envelope, { ok: true, items: storage, revision }, "storage.response");
      } else if (envelope.type === "storage.patch") {
        const p = envelope.payload;
        if (!mutations.has(p.mutationId)) {
          if (p.baseRevision !== revision) { await reply(session, token, envelope, { ok: false, code: "STORAGE_CONFLICT", items: storage, revision }, "storage.response"); return; }
          if (p.clear) for (const key of Object.keys(storage)) delete storage[key];
          for (const key of p.keys || []) delete storage[key];
          Object.assign(storage, p.items || {}); revision++; mutations.set(p.mutationId, revision);
        }
        await reply(session, token, envelope, { ok: true, items: storage, revision, mutationId: p.mutationId }, "storage.response");
      } else if (envelope.type === "input.context.get") {
        const nonce = `fixture-native-nonce-${++nonceSequence}`;
        nonces.set(envelope.payload.documentToken, nonce);
        const origin = await evaluate(session, () => location.origin);
        await reply(session, token, envelope, { ok: true, documentToken: envelope.payload.documentToken, documentNonce: nonce, documentGeneration: nonceSequence, origin });
      } else if (envelope.type === "input.cancel") {
        assert.ok(envelope.payload.requestId, "Document-wide input cancellation is forbidden");
        const action = actions.get(envelope.payload.requestId);
        if (action && action.token === envelope.payload.documentToken && action.nonce === envelope.payload.documentNonce) action.cancelled = true;
        await reply(session, token, envelope, { ok: true, cancelled: Boolean(action) }, "input.cancel.response");
      } else if (envelope.type === "input.gesture") {
        const p = envelope.payload, action = { token: p.documentToken, nonce: p.documentNonce, cancelled: false };
        actions.set(envelope.id, action);
        try {
          assert.equal(nonces.get(p.documentToken), p.documentNonce);
          const current = await evaluate(session, value => window.__CC_ANDROID_RUNTIME__.captureInputSnapshot({ points: value.points, targetId: value.targetId }), p);
          assert.equal(current.v, 1); assert.equal(current.hit, true); assert.equal(current.animating, false);
          for (const key of ["boardId", "positionKey", "orientation", "myColor", "turn", "targetId"]) assert.equal(current[key], p.snapshot[key]);
          assert.deepEqual(current.boardRect, p.snapshot.boardRect); assert.deepEqual(current.targetRect, p.snapshot.targetRect);
          const inputPlatform = await evaluate(session, () => window.__fullFlow.platform);
          const before = await evaluate(session, () => window.__fullFlow.own);
          if (action.cancelled) throw new Error("Cancelled before DOWN");
          const start = p.points[0];
          await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: start.x, y: start.y, id: 1 }] }, session);
          const atDown = await evaluate(session, () => window.__fullFlow.own);
          assert.equal(atDown, before, "Posting/DOWN must not commit a move");
          if (p.action === "drag") {
            for (let index = 1; index < p.points.length; index++) {
              await delay(Math.max(1, Math.round(p.durationMs / p.points.length)));
              const point = p.points[index];
              await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: point.x, y: point.y, id: 1 }] }, session);
            }
            await delay(Math.max(0, p.durationMs - Math.round(p.durationMs / p.points.length) * (p.points.length - 1)));
          } else await delay(p.durationMs);
          const beforeUp = await evaluate(session, () => window.__fullFlow.own);
          assert.equal(beforeUp, before, "A move must not precede real UP");
          if (action.cancelled) { await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] }, session); throw new Error("Cancelled after DOWN"); }
          await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, session);
          deliveries.push({ id: envelope.id, platform: inputPlatform, action: p.action, before, atDown, beforeUp, after: await evaluate(session, () => window.__fullFlow.own) });
          await reply(session, token, envelope, { ok: true, dispatched: true, action: p.action, phase: "up", hadDown: true });
        } catch (error) {
          if (!action.cancelled) protocolErrors.push(error.message);
          await reply(session, token, envelope, { ok: false, code: action.cancelled ? "INPUT_CANCELLED" : "INPUT_SNAPSHOT_STALE", error: error.message, phase: "prepare" });
        } finally { actions.delete(envelope.id); }
      } else if (envelope.type === "device.profile.get") await reply(session, token, envelope, { ok: true, profile: PROFILE }, "device.profile.response");
      else throw new Error("Unhandled production bridge message " + envelope.type);
    }
    cdp.on("Runtime.bindingCalled", event => { void native(event).catch(error => protocolErrors.push(error.stack || error.message)); });
    const engine = await page(); engineSession = engine.sessionId;
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${installEngine.toString()})(${JSON.stringify(PROFILE)});` }, engineSession);
    await cdp.send("Page.navigate", { url: `https://127.0.0.1:${port}/engine/engine-host.html` }, engineSession);
    await waitFor(engineSession, () => window.CCEngineHost?.isAlive?.());
    for (const platform of ["lichess", "chesscom"]) {
      const main = await page(), session = main.sessionId; live.add(session);
      const host = platform === "lichess" ? "lichess.org" : "www.chess.com";
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, session);
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 }, session);
      const boot = { v: 1, storage: {}, storageRevision: 0, storageReady: false, profile: { ...PROFILE, runtimeId: "chesscoach_android_v1", documentId: "android-0" } };
      const bootstrap = bootstrapTemplate.replace(/\$quotedBootstrap/g, JSON.stringify(JSON.stringify(boot)))
        .replace(/\$polyfill/g, () => sources.get("bridge/cc-android-polyfill.js").toString()).replace(/\$privacyBootstrap/g, "");
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `if(location.protocol==="https:"&&["lichess.org","www.chess.com"].includes(location.hostname)){(${installSite.toString()})();${bootstrap}}` }, session);
      const row = { platform }; rows.push(row);
      try {
        const navigation = await cdp.send("Page.navigate", { url: `https://${host}:${port}/computer/fixture` }, session);
        assert.ok(!navigation.errorText, navigation.errorText);
        await waitFor(session, () => window.__CC_ANDROID_GAME_SESSION__?.isReady && window.__fullFlow.boardLoaded);
        await waitFor(session, () => { const h = window.__fullFlow, svg = h.root?.getElementById("chesscoach-screen-svg"); return svg?.querySelector("path") && getComputedStyle(svg).display !== "none"; });
        row.initial = await evaluate(session, state);
        assert.equal(row.initial.preferences.safeAntiBanGuard, false);
        assert.equal(row.initial.own, 0); assert.equal(row.initial.session.myColor, "w"); assert.equal(row.initial.animations, 0);
        const token = row.initial.session.documentToken;
        assert.ok(token); assert.equal(row.initial.session.pendingInput, false);
        await evaluate(session, () => { const box = window.__fullFlow.root.getElementById("cc-auto-master-chk"); box.checked = true; box.dispatchEvent(new Event("change", { bubbles: true })); });
        await waitFor(session, () => window.__fullFlow.own >= 1); await delay(400);
        await evaluate(session, () => window.__fullFlow.apply("e7e5"));
        await waitFor(session, () => window.__fullFlow.own >= 2); await delay(400);
        row.twoAuto = await evaluate(session, state);
        assert.equal(row.twoAuto.own, 2);
        assert.equal(row.twoAuto.session.pendingInput, false);
        assert.ok(row.twoAuto.moves.includes("e7e5"));
        await evaluate(session, () => window.dispatchEvent(new CustomEvent("cc-mobile-lifecycle", { detail: { state: "hidden", cancelPendingMoves: true } })));
        await evaluate(engineSession, () => window.CCEngineHost.suspendForApp());
        assert.equal((await evaluate(session, state)).preferences.autoMoveEnabled, true);
        await evaluate(engineSession, profile => window.CCEngineHost.resumeForApp(profile), PROFILE);
        await evaluate(session, () => window.dispatchEvent(new CustomEvent("cc-mobile-lifecycle", { detail: { state: "active" } })));
        await evaluate(session, async () => { const prefs = window.__CC_MOBILE_PREFERENCES__; await prefs.update(window.__fullFlow.platform, { autoMoveEnabled: false }); window.__fullFlow.apply("b8c6"); });
        await waitFor(session, () => { const svg = window.__fullFlow.root.getElementById("chesscoach-screen-svg"); return svg?.querySelector("path") && getComputedStyle(svg).display !== "none"; });
        await evaluate(session, () => window.__fullFlow.root.getElementById("cc-auto-test-best").click());
        await waitFor(session, () => window.__fullFlow.own >= 3); await delay(400);
        row.manual = await evaluate(session, state);
        assert.equal(row.manual.own, 3);
        assert.equal(row.manual.session.pendingInput, false);
        console.log(`PASS ${platform}: real Lite startup white arrows, 2 own auto turns with opponent reply, later manual move; own=${row.manual.own}`);
        if (platform === "lichess") await evaluate(session, () => window.__CC_MOBILE_PREFERENCES__.update("lichess", { bulletTurboMode: true, premoveEnabled: true }));
        await evaluate(session, () => { history.replaceState(null, "", location.pathname + "?game=2"); window.__fullFlow.reset(); });
        await waitFor(session, () => { const s = window.__CC_ANDROID_GAME_SESSION__.snapshot(); return s.turn === "w" && s.analysis === "complete"; });
        row.newGame = await evaluate(session, state);
        assert.equal(row.newGame.arrows, true);
        await evaluate(session, () => window.__CC_MOBILE_PREFERENCES__.flush());
        await cdp.send("Page.navigate", { url: "about:blank" }, session);
        await delay(150);
        await cdp.send("Page.getNavigationHistory", {}, session).then(history => cdp.send("Page.navigateToHistoryEntry", { entryId: history.entries[history.currentIndex - 1].id }, session));
        await waitFor(session, () => window.__CC_ANDROID_GAME_SESSION__?.isReady && window.__fullFlow?.boardLoaded);
        row.actualBFCache = await evaluate(session, () => window.__fullFlow.events.some(event => event.type === "pageshow" && event.persisted));
        // Always exercise the persisted handlers even if Chrome declines BFCache.
        await evaluate(session, () => { window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })); window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })); });
        await waitFor(session, () => window.__CC_ANDROID_GAME_SESSION__.snapshot().foreground && document.getElementById("cc-mobile-launcher-host"));
        row.restored = await evaluate(session, state);
        assert.equal(row.restored.launcher, true); assert.equal(row.restored.session.pendingInput, false);
        if (platform === "lichess") assert.equal(row.restored.preferences.bulletTurboMode && row.restored.preferences.premoveEnabled, true);
        const oldToken = row.restored.session.documentToken;
        await evaluate(session, () => window.__CC_MOBILE_PREFERENCES__.flush());
        await cdp.send("Page.reload", { ignoreCache: true }, session);
        await waitFor(session, () => window.__CC_ANDROID_GAME_SESSION__?.isReady && window.__fullFlow.boardLoaded);
        await waitFor(session, () => { const svg = window.__fullFlow.root?.getElementById("chesscoach-screen-svg"); return svg?.querySelector("path") && getComputedStyle(svg).display !== "none"; });
        row.reload = await evaluate(session, state);
        assert.notEqual(row.reload.session.documentToken, oldToken);
        assert.equal(row.reload.registrations, 1);
        if (platform === "lichess") assert.equal(row.reload.preferences.bulletTurboMode && row.reload.preferences.premoveEnabled, true);
        await evaluate(session, () => window.__fullFlow.root.getElementById("cc-auto-test-best").click());
        await waitFor(session, () => window.__fullFlow.own >= 1); await delay(400);
        assert.equal((await evaluate(session, state)).session.pendingInput, false);
        row.afterReloadManual = await evaluate(session, state);
        assert.equal(row.afterReloadManual.own, 1);
        assert.deepEqual(row.initial.errors, []); assert.deepEqual(row.afterReloadManual.errors, []);
        console.log(`PASS ${platform}: initial white arrows, 2 auto + opponent replies + manual, hide/restore, new game, persisted handlers, reload + manual; BFCache=${row.actualBFCache}`);
      } catch (error) { row.failure = error.message; console.log("FAILED_STATE " + JSON.stringify({ completed: Object.keys(row), current: await evaluate(session, state) })); throw error; }
      finally { live.delete(session); await cdp.send("Target.closeTarget", { targetId: main.targetId }); }
    }
    const engineProof = await evaluate(engineSession, () => window.__engineProof);
    assert.ok(engineProof.commands.some(command => command.startsWith("go ")), "Real packaged Lite Worker must run");
    assert.deepEqual(protocolErrors, []);
    const lichessDeliveries = deliveries.filter(delivery => delivery.platform === "lichess");
    const chesscomDeliveries = deliveries.filter(delivery => delivery.platform === "chesscom");
    assert.ok(lichessDeliveries.length >= 4);
    assert.ok(chesscomDeliveries.length >= 8);
    assert.ok(lichessDeliveries.every(delivery => delivery.action === "drag"));
    for (const delivery of deliveries) assert.equal(delivery.beforeUp, delivery.before);
    const deepRequests = requests.filter(request => request.pass === "deep");
    assert.ok(deepRequests.length >= 6);
    for (const deep of deepRequests) {
      assert.equal(deep.meta?.annotationOnly, true);
      const primaryIndex = requests.findIndex(request => request.type === "ENGINE_ANALYZE" && request.requestId === deep.meta.ownedEngineRequestId);
      assert.ok(primaryIndex >= 0 && primaryIndex < requests.indexOf(deep), "Owned dispatch must precede every deep annotation");
    }
    console.log("FULL_FLOW_PROOF " + JSON.stringify({ sites: rows.map(row => ({ platform: row.platform, autoOwn: row.twoAuto.own, manualOwn: row.manual.own,
      whiteArrows: row.initial.arrows, animations: row.initial.animations, actualBFCache: row.actualBFCache, reloadOwn: row.afterReloadManual.own,
      intent: { turbo: row.reload.preferences.bulletTurboMode, premove: row.reload.preferences.premoveEnabled } })),
      realWorkerSearches: engineProof.commands.filter(command => command.startsWith("go ")).length, nativeDownUpDeliveries: deliveries.length,
      orderedDeep: requests.filter(request => request.pass === "deep").every(request => request.meta?.annotationOnly === true && request.meta.ownedEngineRequestId),
      nativeAndroidMocked: true, sourceHashes: [...sources].map(([name, bytes]) => [name, crypto.createHash("sha256").update(bytes).digest("hex")]) }));
  } finally { clearTimeout(deadline); await stop(); }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
