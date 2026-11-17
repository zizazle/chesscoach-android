"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const readline = require("node:readline");
const polyfill = fs.readFileSync(path.resolve(__dirname, "../../main/assets/bridge/cc-android-polyfill.js"), "utf8");
const mainActivity = fs.readFileSync(path.resolve(__dirname, "../../main/java/com/chesscoach/app/MainActivity.kt"), "utf8");
const bootstrapTemplate = /private fun buildDocumentStartScript\([\s\S]*?return """([\s\S]*?)"""\.trimIndent\(\)/.exec(mainActivity)?.[1];
if (!bootstrapTemplate) throw new Error("Production native bootstrap was not found");

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    dispatchEvent(event) { for (const fn of [...(listeners.get(event.type) || [])]) fn(event); return true; }
  };
}

function createFixture(url = "https://lichess.org/native-input-fixture", initialNow = 1000) {
  let now = initialNow, sequence = 0;
  const timers = new Map(), messages = [], results = {}, controllers = new Map();
  const scene = { v: 1, boardId: "board-1", positionKey: "fixture-position-1", orientation: "white", myColor: "w", turn: "w",
    boardRect: { left: 0, top: 0, width: 400, height: 800 }, targetRect: { left: 0, top: 0, width: 400, height: 800 }, hit: true, animating: false };
  const native = { onmessage: null, postMessage(raw) { messages.push(JSON.parse(raw)); } };
  const document = { ...eventTarget(), visibilityState: "visible", hidden: false };
  const context = vm.createContext({ ...eventTarget(), document, CCNative: native, location: new URL(url), TextEncoder, URL, AbortController,
    Date: class extends Date { static now() { return now; } },
    crypto: { getRandomValues(values) { for (let i = 0; i < values.length; i++) values[i] = ++sequence; return values; } },
    setTimeout(fn, ms) { const id = ++sequence; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); }, queueMicrotask,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    visualViewport: { width: 400, height: 800, offsetLeft: 0, offsetTop: 0 }, innerWidth: 400, innerHeight: 800,
    console: { log() {}, warn() {}, error() {} }
  });
  context.window = context; context.top = context;
  const bootstrap = { v: 1, storage: {}, storageRevision: 0,
    profile: { runtimeId: "chesscoach_android_v1", documentId: "android-0", clientInstanceId: "fixture-client" } };
  const bootstrapScript = bootstrapTemplate.replace(/\$quotedBootstrap/g, JSON.stringify(JSON.stringify(bootstrap)))
    .replace(/\$polyfill/g, () => polyfill).replace(/\$privacyBootstrap/g, "");
  vm.runInContext(bootstrapScript, context, { filename: "production/native-document-start.js" });
  const runtime = context.__CC_ANDROID_RUNTIME__;
  if (!context.__CC_ANDROID_BOOTSTRAP_READY__ || !runtime) throw new Error("Production bootstrap did not create the runtime");
  // Only the DOM/core-adapter boundary is controlled. Neither the production
  // serializer nor the JVM controller/snapshot script is replaced by a mock.
  const provider = ({ points, targetId }) => ({ ...scene, boardRect: { ...scene.boardRect }, targetRect: { ...scene.targetRect }, targetId,
    hit: scene.hit && points.every(point => point.x >= scene.targetRect.left && point.x < scene.targetRect.left + scene.targetRect.width &&
      point.y >= scene.targetRect.top && point.y < scene.targetRect.top + scene.targetRect.height) });
  let unregister = runtime.registerInputSnapshotProvider(provider);
  const drain = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const output = extra => ({ messages: messages.splice(0), results: { ...results }, token: runtime.inputDocumentToken,
    nonce: runtime.inputDocumentNonce, ...extra });

  async function command(op) {
    let extra = {};
    switch (op.op) {
      case "request": {
        const name = op.name || `request-${sequence}`;
        const params = op.params || { action: "tap", points: [{ x: 180, y: 300 }], durationMs: 80, targetId: "board-target" };
        const options = {};
        if (op.signal) {
          if (!controllers.has(op.signal)) controllers.set(op.signal, new AbortController());
          options.signal = controllers.get(op.signal).signal;
        }
        results[name] = { status: "pending" };
        runtime.nativeRequest(op.method || "input.gesture", params, options).then(
          value => { results[name] = { status: "ok", value }; },
          error => { results[name] = { status: "error", code: error.code, phase: error.phase, hadDown: error.hadDown,
            requestId: error.requestId, deliveryUnknown: error.deliveryUnknown, message: error.message }; });
        break;
      }
      case "reply": native.onmessage?.({ data: JSON.stringify(op.envelope) }); break;
      case "snapshot": extra.snapshot = vm.runInContext(op.script, context, { filename: "production/native-input-snapshot.js" }); break;
      case "patch":
        if (op.url) context.location = new URL(op.url);
        if (op.viewport) Object.assign(context.visualViewport, op.viewport);
        if (op.snapshot) Object.assign(scene, op.snapshot);
        if (op.hidden !== undefined) {
          document.hidden = op.hidden; document.visibilityState = op.hidden ? "hidden" : "visible";
          if (op.notify) document.dispatchEvent({ type: "visibilitychange" });
        }
        break;
      case "provider":
        if (op.enabled === false) { unregister(); unregister = () => {}; }
        else unregister = runtime.registerInputSnapshotProvider(provider);
        break;
      case "abort":
        if (!controllers.has(op.signal)) controllers.set(op.signal, new AbortController());
        controllers.get(op.signal).abort(); break;
      case "advance": {
        const target = now + op.ms;
        while (true) {
          const due = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
          if (!due) break;
          timers.delete(due[0]); now = due[1].at; due[1].fn();
        }
        now = target; break;
      }
      case "pagehide": context.dispatchEvent({ type: "pagehide", persisted: Boolean(op.persisted) }); break;
      case "cleanup": runtime.cleanup(); break;
      case "inspect": extra.disposed = runtime.disposed; extra.profileDocumentId = runtime.profile.documentId; break;
      default: throw new Error(`Unknown fixture command: ${op.op}`);
    }
    await drain();
    return output(extra);
  }
  return { command, context, runtime, scene, drain };
}

module.exports = { createFixture };

if (require.main === module && process.argv.includes("--ipc")) {
  (async () => {
    let fixture = createFixture();
    for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
      try {
        const op = JSON.parse(line);
        if (op.op === "init") {
          fixture = createFixture(op.url, op.now || 1000);
          process.stdout.write(JSON.stringify(await fixture.command({ op: "inspect" })) + "\n");
        } else if (op.op === "shutdown") break;
        else process.stdout.write(JSON.stringify(await fixture.command(op)) + "\n");
      } catch (error) { process.stdout.write(JSON.stringify({ fixtureError: error.stack }) + "\n"); }
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
