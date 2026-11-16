(function () {
  "use strict";

  const RUNTIME_KEY = "__CC_ANDROID_RUNTIME__";
  const BOOTSTRAP_KEY = "__CC_ANDROID_BOOTSTRAP__";
  const PROTOCOL_VERSION = 1;
  const PROTOCOL_SCOPE = "chesscoach.android";
  const RUNTIME_TIMEOUT_MS = 65000;
  const NATIVE_TIMEOUT_MS = 65000;
  const STORAGE_FLUSH_MS = 220;
  const MAX_RUNTIME_BYTES = 4 * 1024 * 1024;
  const MAX_STORAGE_BYTES = 256 * 1024;
  const MAX_BRIDGE_BYTES = 4 * 1024 * 1024;
  const MAX_DOWNLOAD_BYTES = 320 * 1024;
  const MAX_STORAGE_KEYS = 256;
  const MAX_STORAGE_MUTATION_KEYS = 64;
  const MAX_STORAGE_DEPTH = 8;
  const MAX_STORAGE_NODES = 4096;
  const MAX_STORAGE_OBJECT_KEYS = 128;
  const MAX_STORAGE_ARRAY_ITEMS = 256;
  const MAX_STORAGE_STRING_BYTES = 32 * 1024;
  const MAX_TOUCH_POINTS = 16;
  const INPUT_TIMEOUT_MS = 3000;
  const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
  const NO_RECEIVER_MESSAGE = "Could not establish connection. Receiving end does not exist.";

  const existingRuntime = window[RUNTIME_KEY];
  if (existingRuntime && existingRuntime.version === PROTOCOL_VERSION) return;

  function byteLength(value) {
    const text = String(value || "");
    if (typeof TextEncoder === "function") return new TextEncoder().encode(text).byteLength;
    return text.length * 2;
  }

  function isPlainObject(value) {
    if (!value || Object.prototype.toString.call(value) !== "[object Object]") return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === null || (
      Object.prototype.hasOwnProperty.call(prototype, "constructor") &&
      typeof prototype.constructor === "function" &&
      prototype.constructor.name === "Object"
    );
  }

  function createError(message, code) {
    const error = new Error(String(message || "Android bridge error"));
    if (code) error.code = code;
    return error;
  }

  function serializeJson(value, maxBytes, label) {
    let json;
    try {
      json = JSON.stringify(value);
    } catch (error) {
      throw createError(`${label || "Value"} is not JSON-serializable`, "INVALID_JSON");
    }
    if (typeof json !== "string") {
      throw createError(`${label || "Value"} is not JSON-serializable`, "INVALID_JSON");
    }
    if (byteLength(json) > maxBytes) {
      throw createError(`${label || "Value"} exceeds the allowed size`, "MESSAGE_TOO_LARGE");
    }
    return json;
  }

  function cloneJson(value, maxBytes, label) {
    return JSON.parse(serializeJson(value, maxBytes, label));
  }

  function cloneForPublic(value) {
    if (value === undefined) return undefined;
    return cloneJson(value, MAX_BRIDGE_BYTES, "Bridge value");
  }

  function validateStorageKey(key) {
    if (
      typeof key !== "string" ||
      !/^[a-z0-9][a-z0-9._:-]{0,95}$/i.test(key) ||
      FORBIDDEN_KEYS.has(key) ||
      /[\0-\x1F\x7F]/.test(key)
    ) {
      throw createError("Invalid storage key", "INVALID_STORAGE_KEY");
    }
    return key;
  }

  function validateStorageValue(value, depth = 0, budget = { nodes: 0 }) {
    if (depth > MAX_STORAGE_DEPTH) throw createError("Storage nesting is too deep", "INVALID_STORAGE_VALUE");
    budget.nodes++;
    if (budget.nodes > MAX_STORAGE_NODES) throw createError("Storage value is too complex", "INVALID_STORAGE_VALUE");
    if (value === null || typeof value === "boolean") return;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw createError("Storage number must be finite", "INVALID_STORAGE_VALUE");
      return;
    }
    if (typeof value === "string") {
      if (byteLength(value) > MAX_STORAGE_STRING_BYTES) throw createError("Storage string exceeds the allowed size", "INVALID_STORAGE_VALUE");
      return;
    }
    if (Array.isArray(value)) {
      if (value.length > MAX_STORAGE_ARRAY_ITEMS) throw createError("Storage array has too many items", "INVALID_STORAGE_VALUE");
      for (const child of value) validateStorageValue(child, depth + 1, budget);
      return;
    }
    if (isPlainObject(value)) {
      const entries = Object.entries(value);
      if (entries.length > MAX_STORAGE_OBJECT_KEYS) throw createError("Storage object has too many keys", "INVALID_STORAGE_VALUE");
      for (const [key, child] of entries) {
        validateStorageKey(key);
        validateStorageValue(child, depth + 1, budget);
      }
      return;
    }
    throw createError("Unsupported storage value", "INVALID_STORAGE_VALUE");
  }

  function copyStorageRecord(raw) {
    const result = Object.create(null);
    if (!isPlainObject(raw)) return result;
    const entries = Object.entries(raw);
    if (entries.length > MAX_STORAGE_KEYS) {
      throw createError("Storage contains too many keys", "STORAGE_QUOTA_EXCEEDED");
    }
    for (const [key, value] of entries) {
      validateStorageKey(key);
      validateStorageValue(value);
      result[key] = cloneJson(value, MAX_STORAGE_BYTES, `Storage value for ${key}`);
    }
    serializeJson(result, MAX_STORAGE_BYTES, "Storage");
    return result;
  }

  function parseBootstrap() {
    const raw = window[BOOTSTRAP_KEY];
    if (raw === undefined || raw === null) return {};
    try {
      if (typeof raw === "string") {
        if (byteLength(raw) > MAX_BRIDGE_BYTES) return {};
        const parsed = JSON.parse(raw);
        return isPlainObject(parsed) ? parsed : {};
      }
      return isPlainObject(raw) ? cloneJson(raw, MAX_BRIDGE_BYTES, "Android bootstrap") : {};
    } catch (error) {
      console.warn("[ChessCoach Android] Ignoring invalid bootstrap payload");
      return {};
    } finally {
      try { delete window[BOOTSTRAP_KEY]; } catch (error) {}
    }
  }

  function freezeJson(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) freezeJson(child);
    return Object.freeze(value);
  }

  function createEvent() {
    const listeners = new Set();
    const event = Object.freeze({
      addListener(listener) {
        if (typeof listener !== "function") throw new TypeError("Listener must be a function");
        listeners.add(listener);
      },
      removeListener(listener) {
        listeners.delete(listener);
      },
      hasListener(listener) {
        return listeners.has(listener);
      },
      hasListeners() {
        return listeners.size > 0;
      }
    });
    return {
      event,
      emit(createArgs) {
        for (const listener of Array.from(listeners)) {
          try {
            const args = typeof createArgs === "function" ? createArgs() : createArgs;
            listener.apply(undefined, Array.isArray(args) ? args : [args]);
          } catch (error) {
            console.error("[ChessCoach Android] Event listener failed", error);
          }
        }
      },
      clear() {
        listeners.clear();
      }
    };
  }

  function scheduleTask(callback) {
    if (typeof queueMicrotask === "function") queueMicrotask(callback);
    else Promise.resolve().then(callback);
  }

  const bootstrap = parseBootstrap();
  let storageState;
  try {
    storageState = copyStorageRecord(bootstrap.storage || bootstrap.storageLocal || {});
  } catch (error) {
    console.warn("[ChessCoach Android] Ignoring invalid storage bootstrap", error);
    storageState = Object.create(null);
  }

  const defaultPlatform = /(^|\.)chess\.com$/i.test(location.hostname) ? "chesscom" : "lichess";
  let profileState = freezeJson(isPlainObject(bootstrap.profile)
    ? cloneJson(bootstrap.profile, 128 * 1024, "Android profile")
    : { platform: defaultPlatform });
  let storageRevision = Number.isSafeInteger(bootstrap.storageRevision) && bootstrap.storageRevision >= 0
    ? bootstrap.storageRevision
    : 0;
  let currentLastError;
  let disposed = false;
  let requestSequence = 0;
  let storageFlushTimer = null;
  let pendingStoragePatch = null;
  let storageFlushFailures = 0;
  let storageFlushInFlight = false;
  let storageDirty = false;
  const pendingRequests = new Map();
  const storageChanged = createEvent();
  const nativeEvents = createEvent();
  const inputDocumentToken = nextRequestId("input-doc");

  function runtimeId() {
    const candidate = profileState && profileState.runtimeId;
    return typeof candidate === "string" && /^[a-z0-9._-]{3,64}$/i.test(candidate)
      ? candidate
      : "chesscoach-android";
  }

  function getNativeBridge() {
    const bridge = window.CCNative;
    return bridge && typeof bridge.postMessage === "function" ? bridge : null;
  }

  function nextRequestId(prefix) {
    requestSequence = (requestSequence + 1) % Number.MAX_SAFE_INTEGER;
    let random = "";
    try {
      const bytes = new Uint32Array(2);
      crypto.getRandomValues(bytes);
      random = `${bytes[0].toString(36)}${bytes[1].toString(36)}`;
    } catch (error) {
      random = Math.random().toString(36).slice(2, 12);
    }
    return `${prefix}-${Date.now().toString(36)}-${requestSequence.toString(36)}-${random}`;
  }

  function postEnvelope(envelope) {
    if (disposed) throw createError("Android runtime is disposed", "CONTEXT_INVALIDATED");
    const bridge = getNativeBridge();
    if (!bridge) throw createError("Android native bridge is unavailable", "NATIVE_BRIDGE_UNAVAILABLE");
    const json = serializeJson(envelope, MAX_BRIDGE_BYTES, "Native message");
    bridge.postMessage(json);
  }

  function invokeCallback(callback, value, error) {
    scheduleTask(() => {
      currentLastError = error
        ? Object.freeze({ message: String(error.message || error), code: error.code || undefined })
        : undefined;
      try {
        callback(value);
      } catch (callbackError) {
        console.error("[ChessCoach Android] API callback failed", callbackError);
      } finally {
        currentLastError = undefined;
      }
    });
  }

  function callbackOrPromise(callback, operation) {
    if (typeof callback === "function") {
      scheduleTask(() => {
        try {
          operation(
            value => invokeCallback(callback, value, null),
            error => invokeCallback(callback, undefined, error)
          );
        } catch (error) {
          invokeCallback(callback, undefined, error);
        }
      });
      return undefined;
    }
    return new Promise((resolve, reject) => {
      scheduleTask(() => {
        try { operation(resolve, reject); } catch (error) { reject(error); }
      });
    });
  }

  function createPublicRecord(entries) {
    const result = {};
    for (const [key, value] of entries) {
      Object.defineProperty(result, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
    return result;
  }

  function resolveGet(keys) {
    if (keys === undefined || keys === null) {
      return createPublicRecord(Object.entries(storageState).map(([key, value]) => [key, cloneForPublic(value)]));
    }

    if (typeof keys === "string") {
      validateStorageKey(keys);
      return Object.prototype.hasOwnProperty.call(storageState, keys)
        ? createPublicRecord([[keys, cloneForPublic(storageState[keys])]])
        : {};
    }

    if (Array.isArray(keys)) {
      const unique = new Set();
      for (const key of keys) unique.add(validateStorageKey(key));
      const entries = [];
      for (const key of unique) {
        if (Object.prototype.hasOwnProperty.call(storageState, key)) {
          entries.push([key, cloneForPublic(storageState[key])]);
        }
      }
      return createPublicRecord(entries);
    }

    if (isPlainObject(keys)) {
      const entries = [];
      for (const [key, defaultValue] of Object.entries(keys)) {
        validateStorageKey(key);
        const value = Object.prototype.hasOwnProperty.call(storageState, key)
          ? storageState[key]
          : defaultValue;
        entries.push([key, cloneForPublic(value)]);
      }
      return createPublicRecord(entries);
    }

    throw createError("storage.local.get keys must be null, a string, an array, or an object", "INVALID_ARGUMENT");
  }

  function verifyStorageCandidate(candidate) {
    const keys = Object.keys(candidate);
    if (keys.length > MAX_STORAGE_KEYS) {
      throw createError("Storage quota exceeded", "STORAGE_QUOTA_EXCEEDED");
    }
    serializeJson(candidate, MAX_STORAGE_BYTES, "Storage");
  }

  function emitStorageChanges(changes) {
    if (!Object.keys(changes).length) return;
    scheduleTask(() => {
      storageChanged.emit(() => [cloneForPublic(changes), "local"]);
    });
  }

  function mergeStoragePatch(clear, setValues, removedKeys, changes, resolve, reject) {
    storageDirty = true;
    const baseRevision = storageRevision;
    storageRevision++;
    if (!pendingStoragePatch) {
      pendingStoragePatch = {
        baseRevision,
        revision: storageRevision,
        clear: false,
        set: Object.create(null),
        remove: new Set(),
        waiters: [],
        events: []
      };
    }
    pendingStoragePatch.waiters.push({ resolve, reject });
    pendingStoragePatch.events.push(cloneForPublic(changes));
    pendingStoragePatch.revision = storageRevision;
    if (clear) {
      pendingStoragePatch.clear = true;
      pendingStoragePatch.set = Object.create(null);
      pendingStoragePatch.remove.clear();
    }
    for (const [key, value] of Object.entries(setValues || {})) {
      pendingStoragePatch.set[key] = cloneForPublic(value);
      pendingStoragePatch.remove.delete(key);
    }
    for (const key of removedKeys || []) {
      delete pendingStoragePatch.set[key];
      if (!pendingStoragePatch.clear) pendingStoragePatch.remove.add(key);
    }
    scheduleStorageFlush();
  }

  function scheduleStorageFlush(delay = STORAGE_FLUSH_MS) {
    if (disposed || storageFlushInFlight || storageFlushTimer !== null || !pendingStoragePatch) return;
    storageFlushTimer = setTimeout(() => {
      storageFlushTimer = null;
      flushStoragePatch();
    }, delay);
  }

  function chunkEntries(entries, size) {
    const chunks = [];
    for (let index = 0; index < entries.length; index += size) chunks.push(entries.slice(index, index + size));
    return chunks;
  }

  function sendStorageOperation(type, payload) {
    return beginRequest(
      "storage",
      type,
      "storage.response",
      payload,
      NATIVE_TIMEOUT_MS,
      undefined,
      "NATIVE"
    );
  }

  function postStorageOperationUntracked(type, payload) {
    postEnvelope({
      v: PROTOCOL_VERSION,
      scope: PROTOCOL_SCOPE,
      source: "remote",
      target: "NATIVE",
      channel: "storage",
      type,
      id: nextRequestId("storage"),
      payload
    });
  }

  function flushStorageSnapshotBeforeUnload() {
    if (disposed || !storageDirty || !getNativeBridge()) return false;
    try {
      postStorageOperationUntracked("storage.replace", { items: copyStorageRecord(storageState) });
      storageDirty = false;
      return true;
    } catch (error) {
      nativeEvents.emit(() => [{ name: "bridge.error", data: { channel: "storage", message: error.message } }]);
      return false;
    }
  }

  function storageOperationsForPatch(patch) {
    return [["storage.replace", { items: copyStorageRecord(storageState) }]];
  }

  function requeueStorageSnapshot(patch, error) {
    storageFlushInFlight = false;
    storageFlushFailures++;
    nativeEvents.emit(() => [{ name: "bridge.error", data: { channel: "storage", message: error.message } }]);
    if (disposed || storageFlushFailures > 5) {
      for (const waiter of patch.waiters) waiter.reject(error);
      if (pendingStoragePatch) {
        for (const waiter of pendingStoragePatch.waiters) waiter.reject(error);
        pendingStoragePatch = null;
      }
      storageFlushFailures = 0;
      return;
    }

    const existing = pendingStoragePatch;
    pendingStoragePatch = {
      baseRevision: patch.baseRevision,
      revision: storageRevision,
      clear: true,
      set: copyStorageRecord(storageState),
      remove: new Set(),
      waiters: [...patch.waiters, ...(existing?.waiters || [])],
      events: [...patch.events, ...(existing?.events || [])]
    };
    scheduleStorageFlush(Math.min(1000, STORAGE_FLUSH_MS * (2 ** storageFlushFailures)));
  }

  function flushStoragePatch() {
    if (disposed || storageFlushInFlight || !pendingStoragePatch) return false;
    if (storageFlushTimer !== null) {
      clearTimeout(storageFlushTimer);
      storageFlushTimer = null;
    }
    const patch = pendingStoragePatch;
    pendingStoragePatch = null;
    storageFlushInFlight = true;
    let sequence = Promise.resolve();
    for (const [type, payload] of storageOperationsForPatch(patch)) {
      sequence = sequence.then(() => sendStorageOperation(type, payload));
    }
    sequence.then(() => {
      storageFlushInFlight = false;
      storageFlushFailures = 0;
      for (const changes of patch.events) emitStorageChanges(changes);
      for (const waiter of patch.waiters) waiter.resolve();
      if (!pendingStoragePatch) storageDirty = false;
      scheduleStorageFlush();
    }, error => requeueStorageSnapshot(patch, error));
    return true;
  }

  const storageLocal = Object.freeze({
    QUOTA_BYTES: MAX_STORAGE_BYTES,
    get(keys, callback) {
      if (typeof keys === "function") {
        callback = keys;
        keys = null;
      }
      return callbackOrPromise(callback, resolve => resolve(resolveGet(keys)));
    },
    set(items, callback) {
      return callbackOrPromise(callback, (resolve, reject) => {
        if (!isPlainObject(items)) throw createError("storage.local.set requires an object", "INVALID_ARGUMENT");
        if (!getNativeBridge()) throw createError("Android native bridge is unavailable", "NATIVE_BRIDGE_UNAVAILABLE");
        const candidate = copyStorageRecord(storageState);
        const changes = {};
        const patch = Object.create(null);
        for (const [key, rawValue] of Object.entries(items)) {
          validateStorageKey(key);
          validateStorageValue(rawValue);
          const value = cloneJson(rawValue, MAX_STORAGE_BYTES, `Storage value for ${key}`);
          const hadOldValue = Object.prototype.hasOwnProperty.call(candidate, key);
          const oldValue = hadOldValue ? candidate[key] : undefined;
          if (hadOldValue && serializeJson(oldValue, MAX_STORAGE_BYTES) === serializeJson(value, MAX_STORAGE_BYTES)) continue;
          candidate[key] = value;
          patch[key] = value;
          changes[key] = hadOldValue
            ? { oldValue: cloneForPublic(oldValue), newValue: cloneForPublic(value) }
            : { newValue: cloneForPublic(value) };
        }
        verifyStorageCandidate(candidate);
        storageState = candidate;
        if (Object.keys(changes).length) {
          mergeStoragePatch(false, patch, [], changes, resolve, reject);
        } else {
          resolve();
        }
      });
    },
    remove(keys, callback) {
      return callbackOrPromise(callback, (resolve, reject) => {
        if (!getNativeBridge()) throw createError("Android native bridge is unavailable", "NATIVE_BRIDGE_UNAVAILABLE");
        const list = typeof keys === "string" ? [keys] : keys;
        if (!Array.isArray(list)) throw createError("storage.local.remove requires a string or array", "INVALID_ARGUMENT");
        const unique = new Set(list.map(validateStorageKey));
        const candidate = copyStorageRecord(storageState);
        const changes = {};
        const removed = [];
        for (const key of unique) {
          if (!Object.prototype.hasOwnProperty.call(candidate, key)) continue;
          changes[key] = { oldValue: cloneForPublic(candidate[key]) };
          delete candidate[key];
          removed.push(key);
        }
        verifyStorageCandidate(candidate);
        storageState = candidate;
        if (removed.length) {
          mergeStoragePatch(false, {}, removed, changes, resolve, reject);
        } else {
          resolve();
        }
      });
    },
    clear(callback) {
      return callbackOrPromise(callback, (resolve, reject) => {
        if (!getNativeBridge()) throw createError("Android native bridge is unavailable", "NATIVE_BRIDGE_UNAVAILABLE");
        const changes = {};
        for (const [key, value] of Object.entries(storageState)) {
          changes[key] = { oldValue: cloneForPublic(value) };
        }
        storageState = Object.create(null);
        if (Object.keys(changes).length) {
          mergeStoragePatch(true, {}, [], changes, resolve, reject);
        } else {
          resolve();
        }
      });
    }
  });

  function sanitizeAssetPath(rawPath) {
    const raw = String(rawPath || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (raw.includes("?") || raw.includes("#") || raw.includes("\0")) {
      throw createError("Invalid asset path", "INVALID_ASSET_PATH");
    }
    const segments = [];
    for (const encodedSegment of raw.split("/")) {
      if (!encodedSegment || encodedSegment === ".") continue;
      let segment;
      try { segment = decodeURIComponent(encodedSegment); } catch (error) {
        throw createError("Invalid asset path encoding", "INVALID_ASSET_PATH");
      }
      if (
        segment === ".." ||
        segment.includes("/") ||
        segment.includes("\\") ||
        !/^[a-z0-9._~@+-]+$/i.test(segment)
      ) {
        throw createError("Invalid asset path", "INVALID_ASSET_PATH");
      }
      segments.push(encodeURIComponent(segment).replace(/%40/gi, "@").replace(/%2B/gi, "+"));
    }
    return segments.join("/");
  }

  function getAssetUrl(path) {
    const cleanPath = sanitizeAssetPath(path);
    return `${location.origin}/__cc_assets/${cleanPath}`;
  }

  function normalizeBridgeError(payload, fallbackCode) {
    const raw = isPlainObject(payload?.error) ? payload.error : payload;
    const code = String(raw?.code || fallbackCode || "NATIVE_REQUEST_FAILED").slice(0, 64);
    const noReceiver = code === "NO_RECEIVER" || payload?.noReceiver === true;
    const message = noReceiver
      ? NO_RECEIVER_MESSAGE
      : String(raw?.message || payload?.message || "Android native request failed").slice(0, 1024);
    return createError(message, noReceiver ? "NO_RECEIVER" : code);
  }

  function beginRequest(channel, type, responseType, payload, timeoutMs, callback, target) {
    const id = nextRequestId(channel === "runtime" ? "rt" : "native");
    const createEnvelope = () => ({
      v: PROTOCOL_VERSION,
      scope: PROTOCOL_SCOPE,
      source: "remote",
      target,
      channel,
      type,
      id,
      payload
    });

    if (typeof callback === "function") {
      const timer = setTimeout(() => {
        const pending = pendingRequests.get(id);
        if (!pending) return;
        pendingRequests.delete(id);
        invokeCallback(callback, undefined, createError(`Android ${channel} request timed out after ${timeoutMs} ms`, "TIMEOUT"));
      }, timeoutMs);
      pendingRequests.set(id, { channel, responseType, callback, timer });
      try {
        postEnvelope(createEnvelope());
      } catch (error) {
        clearTimeout(timer);
        pendingRequests.delete(id);
        invokeCallback(callback, undefined, error);
      }
      return undefined;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pendingRequests.has(id)) return;
        pendingRequests.delete(id);
        reject(createError(`Android ${channel} request timed out after ${timeoutMs} ms`, "TIMEOUT"));
      }, timeoutMs);
      pendingRequests.set(id, { channel, responseType, resolve, reject, timer });
      try {
        postEnvelope(createEnvelope());
      } catch (error) {
        clearTimeout(timer);
        pendingRequests.delete(id);
        reject(error);
      }
    });
  }

  function sendRuntimeMessage(message, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = undefined;
    }
    if (options !== undefined && !isPlainObject(options)) {
      const error = createError("runtime.sendMessage options must be an object", "INVALID_ARGUMENT");
      if (typeof callback === "function") {
        invokeCallback(callback, undefined, error);
        return undefined;
      }
      return Promise.reject(error);
    }
    let safeMessage;
    try {
      safeMessage = cloneJson(message, MAX_RUNTIME_BYTES, "Runtime message");
    } catch (error) {
      if (typeof callback === "function") {
        invokeCallback(callback, undefined, error);
        return undefined;
      }
      return Promise.reject(error);
    }
    return beginRequest(
      "runtime",
      "runtime.message",
      "runtime.response",
      {
        message: safeMessage,
        sender: {
          id: runtimeId(),
          url: String(location.href).slice(0, 4096),
          origin: location.origin,
          frameId: 0,
          documentId: typeof profileState?.documentId === "string" ? profileState.documentId.slice(0, 128) : undefined,
          clientInstanceId: typeof profileState?.clientInstanceId === "string"
            ? profileState.clientInstanceId.slice(0, 128)
            : undefined
        }
      },
      RUNTIME_TIMEOUT_MS,
      callback,
      "ENGINE"
    );
  }

  function normalizeNativeRequest(method, rawParams) {
    const params = rawParams === undefined ? {} : rawParams;
    if (!isPlainObject(params)) throw createError("Native request params must be an object", "INVALID_ARGUMENT");
    if (method === "project.open") {
      if (Object.keys(params).length) throw createError("Project page takes no params", "INVALID_ARGUMENT");
      return { channel: "project", type: "project.open", responseType: "project.open.response", payload: {} };
    }
    if (method === "input.cancel") {
      if (Object.keys(params).length) throw createError("Input cancellation takes no params", "INVALID_INPUT");
      return {
        channel: "input", type: "input.cancel", responseType: "input.cancel.response", timeoutMs: INPUT_TIMEOUT_MS,
        payload: { documentToken: inputDocumentToken }
      };
    }
    if (method === "input.gesture") {
      if (window !== window.top || document.visibilityState !== "visible") {
        throw createError("Native input requires the visible main game document", "INPUT_UNAVAILABLE");
      }
      if (Object.keys(params).some(key => !["action", "points", "durationMs", "viewport"].includes(key))) {
        throw createError("Unexpected input field", "INVALID_INPUT");
      }
      const action = params.action;
      if (action !== "tap" && action !== "drag") throw createError("Input action must be tap or drag", "INVALID_INPUT");
      const visual = window.visualViewport;
      const viewport = params.viewport === undefined ? {
        width: visual ? visual.width : window.innerWidth,
        height: visual ? visual.height : window.innerHeight,
        offsetLeft: visual ? visual.offsetLeft : 0,
        offsetTop: visual ? visual.offsetTop : 0
      } : params.viewport;
      if (!isPlainObject(viewport) || Object.keys(viewport).some(key => !["width", "height", "offsetLeft", "offsetTop"].includes(key)) ||
          ![viewport.width, viewport.height, viewport.offsetLeft, viewport.offsetTop].every(value => typeof value === "number" && Number.isFinite(value)) ||
          viewport.width < 1 || viewport.width > 16384 || viewport.height < 1 || viewport.height > 16384 ||
          viewport.offsetLeft < 0 || viewport.offsetLeft > 16384 || viewport.offsetTop < 0 || viewport.offsetTop > 16384) {
        throw createError("Invalid input viewport", "INVALID_INPUT");
      }
      const durationMs = params.durationMs === undefined ? (action === "tap" ? 80 : 180) : params.durationMs;
      if (!Number.isInteger(durationMs) || durationMs < (action === "tap" ? 40 : 80) || durationMs > (action === "tap" ? 200 : 800)) {
        throw createError("Invalid input duration", "INVALID_INPUT");
      }
      if (!Array.isArray(params.points) || (action === "tap" ? params.points.length !== 1 : params.points.length < 2 || params.points.length > MAX_TOUCH_POINTS)) {
        throw createError("Invalid number of input points", "INVALID_INPUT");
      }
      const points = params.points.map(point => {
        if (!isPlainObject(point) || Object.keys(point).some(key => key !== "x" && key !== "y") ||
            typeof point.x !== "number" || typeof point.y !== "number" || !Number.isFinite(point.x) || !Number.isFinite(point.y) ||
            point.x < viewport.offsetLeft || point.x >= viewport.offsetLeft + viewport.width ||
            point.y < viewport.offsetTop || point.y >= viewport.offsetTop + viewport.height) {
          throw createError("Input point is outside the visible viewport", "INVALID_INPUT");
        }
        return { x: point.x, y: point.y };
      });
      if (action === "drag" && points[0].x === points[points.length - 1].x && points[0].y === points[points.length - 1].y) {
        throw createError("Drag endpoints must differ", "INVALID_INPUT");
      }
      return {
        channel: "input", type: "input.gesture", responseType: "input.gesture.response", timeoutMs: INPUT_TIMEOUT_MS,
        payload: { action, points, durationMs, viewport: { ...viewport }, documentToken: inputDocumentToken }
      };
    }
    if (method === "platform" || method === "platform.switch") {
      const platform = params.platform || params.value;
      const wirePlatform = platform === "lichess" || platform === "LICHESS"
        ? "LICHESS"
        : platform === "chesscom" || platform === "CHESS_COM"
          ? "CHESS_COM"
          : null;
      if (!wirePlatform) {
        throw createError("Platform must be lichess or chesscom", "INVALID_PLATFORM");
      }
      return {
        channel: "platform",
        type: "platform.switch",
        responseType: "platform.switch.response",
        payload: { platform: wirePlatform }
      };
    }
    if (method === "haptic" || method === "haptic.perform") {
      const durationMs = Math.round(Number(params.durationMs ?? params.duration ?? 12));
      if (!Number.isFinite(durationMs) || durationMs < 5 || durationMs > 100) {
        throw createError("Haptic duration must be between 5 and 100 ms", "INVALID_HAPTIC");
      }
      return {
        channel: "native",
        type: "haptic.perform",
        responseType: "haptic.response",
        payload: { durationMs }
      };
    }
    if (method === "download" || method === "download.save") {
      const fileName = String(params.fileName || params.filename || "");
      const mimeType = String(params.mimeType || "application/octet-stream");
      const encoding = params.encoding === "utf8" ? "utf8" : "base64";
      const content = String(params.content || "");
      if (!/^[a-z0-9][a-z0-9._ ()+-]{0,127}$/i.test(fileName) || fileName.includes("..")) {
        throw createError("Invalid download file name", "INVALID_DOWNLOAD");
      }
      if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mimeType)) {
        throw createError("Invalid download MIME type", "INVALID_DOWNLOAD");
      }
      const contentBytes = encoding === "base64"
        ? Math.ceil(content.length * 0.75)
        : byteLength(content);
      if (contentBytes > MAX_DOWNLOAD_BYTES) {
        throw createError("Download exceeds the allowed size", "DOWNLOAD_TOO_LARGE");
      }
      if (encoding === "base64" && content && !/^[a-z0-9+/]*={0,2}$/i.test(content)) {
        throw createError("Invalid base64 download", "INVALID_DOWNLOAD");
      }
      return {
        channel: "native",
        type: "download.save",
        responseType: "download.response",
        payload: { fileName, mimeType, encoding, content }
      };
    }
    if (method === "device" || method === "device.profile.get") {
      return {
        channel: "device",
        type: "device.profile.get",
        responseType: "device.profile.response",
        payload: {}
      };
    }
    throw createError("Unsupported native request", "UNSUPPORTED_NATIVE_REQUEST");
  }

  function nativeRequest(method, params, callback) {
    if (typeof params === "function") {
      callback = params;
      params = undefined;
    }
    try {
      const request = normalizeNativeRequest(method, params);
      return beginRequest(
        request.channel,
        request.type,
        request.responseType,
        request.payload,
        request.timeoutMs || NATIVE_TIMEOUT_MS,
        callback,
        "NATIVE"
      );
    } catch (error) {
      if (typeof callback === "function") {
        invokeCallback(callback, undefined, error);
        return undefined;
      }
      return Promise.reject(error);
    }
  }

  const chromeRuntime = {};
  Object.defineProperties(chromeRuntime, {
    id: { enumerable: true, get: runtimeId },
    lastError: { enumerable: true, get: () => currentLastError },
    getURL: { enumerable: true, value: getAssetUrl },
    sendMessage: { enumerable: true, value: sendRuntimeMessage }
  });
  Object.freeze(chromeRuntime);

  const chromeApi = Object.freeze({
    runtime: chromeRuntime,
    storage: Object.freeze({
      local: storageLocal,
      onChanged: storageChanged.event
    })
  });

  function parseIncoming(raw) {
    const data = raw && typeof raw === "object" && Object.prototype.hasOwnProperty.call(raw, "data")
      ? raw.data
      : raw;
    if (typeof data === "string") {
      if (byteLength(data) > MAX_BRIDGE_BYTES) throw createError("Native message is too large", "MESSAGE_TOO_LARGE");
      return JSON.parse(data);
    }
    if (!isPlainObject(data)) throw createError("Invalid native message", "INVALID_MESSAGE");
    return cloneJson(data, MAX_BRIDGE_BYTES, "Native message");
  }

  function settleIncomingResponse(envelope) {
    const id = String(envelope.id || "");
    const pending = pendingRequests.get(id);
    if (!pending || (
      envelope.type !== pending.responseType &&
      envelope.type !== "native.response" &&
      envelope.type !== "error"
    )) return false;
    if (pending.channel === "input" && (
      envelope.source !== "native" || envelope.target !== "REMOTE" ||
      (envelope.type !== pending.responseType && envelope.type !== "error") ||
      envelope.channel !== (envelope.type === "error" ? "native" : "input")
    )) return false;
    pendingRequests.delete(id);
    clearTimeout(pending.timer);
    const ok = envelope.ok !== false && envelope.payload?.ok !== false && !envelope.error &&
      (pending.channel !== "input" || (envelope.type === pending.responseType && envelope.payload?.ok === true &&
        (pending.responseType === "input.cancel.response" || envelope.payload?.dispatched === true)));
    const responsePayload = Object.prototype.hasOwnProperty.call(envelope, "result")
      ? envelope.result
      : Object.prototype.hasOwnProperty.call(envelope.payload || {}, "result")
        ? envelope.payload.result
        : envelope.payload;
    if (ok) {
      const value = responsePayload === undefined ? undefined : cloneJson(responsePayload, MAX_RUNTIME_BYTES, "Native response");
      if (pending.callback) invokeCallback(pending.callback, value, null);
      else pending.resolve(value);
    } else {
      const error = normalizeBridgeError(envelope.payload || envelope, envelope.code);
      if (pending.callback) invokeCallback(pending.callback, undefined, error);
      else pending.reject(error);
    }
    return true;
  }

  function applyNativeStorageSnapshot(payload) {
    if (!isPlainObject(payload?.storage)) return;
    if (Number.isSafeInteger(payload.revision) && payload.revision < storageRevision) return;
    const next = copyStorageRecord(payload.storage);
    const changes = {};
    const keys = new Set([...Object.keys(storageState), ...Object.keys(next)]);
    for (const key of keys) {
      const hadOld = Object.prototype.hasOwnProperty.call(storageState, key);
      const hasNew = Object.prototype.hasOwnProperty.call(next, key);
      if (hadOld && hasNew && serializeJson(storageState[key], MAX_STORAGE_BYTES) === serializeJson(next[key], MAX_STORAGE_BYTES)) continue;
      changes[key] = {};
      if (hadOld) changes[key].oldValue = cloneForPublic(storageState[key]);
      if (hasNew) changes[key].newValue = cloneForPublic(next[key]);
    }
    storageState = next;
    if (Number.isSafeInteger(payload.revision) && payload.revision >= storageRevision) {
      storageRevision = payload.revision;
    }
    emitStorageChanges(changes);
  }

  function handleNativeMessage(raw) {
    if (disposed) return;
    try {
      const envelope = parseIncoming(raw);
      if (
        !isPlainObject(envelope) ||
        envelope.v !== PROTOCOL_VERSION ||
        envelope.scope !== PROTOCOL_SCOPE ||
        typeof envelope.type !== "string"
      ) return;
      if (
        envelope.type === "runtime.response" ||
        envelope.type === "storage.response" ||
        envelope.type === "platform.switch.response" ||
        envelope.type === "project.open.response" ||
        envelope.type === "device.profile.response" ||
        envelope.type === "haptic.response" ||
        envelope.type === "download.response" ||
        envelope.type === "input.gesture.response" ||
        envelope.type === "input.cancel.response" ||
        envelope.type === "native.response" ||
        envelope.type === "error"
      ) {
        settleIncomingResponse(envelope);
        return;
      }
      if (envelope.type === "storage.snapshot") {
        applyNativeStorageSnapshot(envelope.payload || {});
        return;
      }
      if (envelope.type === "profile.update" && isPlainObject(envelope.payload?.profile)) {
        profileState = freezeJson(cloneJson(envelope.payload.profile, 128 * 1024, "Android profile"));
      }
      if (envelope.type === "native.event" || envelope.type === "profile.update" || envelope.type === "engine.ready") {
        const name = envelope.type === "native.event"
          ? String(envelope.payload?.name || "native.event").slice(0, 128)
          : envelope.type;
        const data = envelope.type === "native.event" ? envelope.payload?.data : envelope.payload;
        nativeEvents.emit(() => [{ name, data: data === undefined ? null : cloneForPublic(data) }]);
      }
    } catch (error) {
      console.warn("[ChessCoach Android] Ignoring invalid native message", error);
    }
  }

  const bridgeAtInstall = getNativeBridge();
  const previousNativeHandler = bridgeAtInstall ? bridgeAtInstall.onmessage : null;
  if (bridgeAtInstall) bridgeAtInstall.onmessage = handleNativeMessage;

  const downloadBypass = new WeakSet();

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      if (!(blob instanceof Blob) || blob.size > MAX_DOWNLOAD_BYTES) {
        reject(createError("Download exceeds the allowed size", "DOWNLOAD_TOO_LARGE"));
        return;
      }
      const reader = new FileReader();
      reader.onerror = () => reject(createError("Could not read download", "DOWNLOAD_READ_FAILED"));
      reader.onload = () => {
        const result = String(reader.result || "");
        const separator = result.indexOf(",");
        resolve(separator >= 0 ? result.slice(separator + 1) : result);
      };
      reader.readAsDataURL(blob);
    });
  }

  function handleDownloadClick(event) {
    const anchor = event.target?.closest?.("a[download]");
    if (!anchor || downloadBypass.has(anchor)) return;
    const fileName = String(anchor.download || "");
    const href = String(anchor.href || "");
    if (!/^chesscoach(?:[-_. ]|$)/i.test(fileName) || (!href.startsWith("blob:") && !href.startsWith("data:"))) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    fetch(href)
      .then(response => {
        if (!response.ok) throw createError("Could not read download", "DOWNLOAD_READ_FAILED");
        return response.blob();
      })
      .then(blob => Promise.all([blobToBase64(blob), blob.type || "application/octet-stream"]))
      .then(([content, mimeType]) => nativeRequest("download", { fileName, mimeType, encoding: "base64", content }))
      .catch(error => {
        console.warn("[ChessCoach Android] Native download failed", error);
        downloadBypass.add(anchor);
        try { anchor.click(); } finally { downloadBypass.delete(anchor); }
      });
  }

  function handleVisibilityChange() {
    if (document.visibilityState === "hidden") flushStoragePatch();
  }

  function handlePageHide(event) {
    if (event.persisted) flushStoragePatch();
    else {
      flushStorageSnapshotBeforeUnload();
      cleanup();
    }
  }

  function cleanup() {
    if (disposed) return;
    flushStorageSnapshotBeforeUnload();
    disposed = true;
    if (storageFlushTimer !== null) clearTimeout(storageFlushTimer);
    storageFlushTimer = null;
    for (const pending of pendingRequests.values()) {
      clearTimeout(pending.timer);
      const error = createError("Android context was invalidated", "CONTEXT_INVALIDATED");
      if (pending.callback) invokeCallback(pending.callback, undefined, error);
      else pending.reject(error);
    }
    pendingRequests.clear();
    storageChanged.clear();
    nativeEvents.clear();
    document.removeEventListener("click", handleDownloadClick, true);
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    window.removeEventListener("pagehide", handlePageHide);
    const bridge = getNativeBridge();
    if (bridge && bridge.onmessage === handleNativeMessage) bridge.onmessage = previousNativeHandler || null;
  }

  document.addEventListener("click", handleDownloadClick, true);
  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("pagehide", handlePageHide);

  const publicRuntime = {};
  Object.defineProperties(publicRuntime, {
    version: { value: PROTOCOL_VERSION, enumerable: true },
    chrome: { value: chromeApi, enumerable: true },
    nativeRequest: { value: nativeRequest, enumerable: true },
    inputDocumentToken: { value: inputDocumentToken, enumerable: false },
    nativeEvents: { value: nativeEvents.event, enumerable: true },
    onNativeEvent: { value: nativeEvents.event, enumerable: true },
    profile: { enumerable: true, get: () => cloneForPublic(profileState) },
    disposed: { enumerable: true, get: () => disposed },
    flushStorage: { value: flushStoragePatch, enumerable: false },
    cleanup: { value: cleanup, enumerable: false }
  });
  Object.preventExtensions(publicRuntime);

  try {
    Object.defineProperty(window, RUNTIME_KEY, {
      value: publicRuntime,
      enumerable: false,
      configurable: false,
      writable: false
    });
  } catch (error) {
    cleanup();
    throw error;
  }
})();
