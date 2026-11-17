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
  const INPUT_TIMEOUT_MS = 5500;
  const INPUT_CONTEXT_TIMEOUT_MS = 4500;
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
  let storageHydrated = false;
  let storageReadyPromise = null;
  let storageRefreshPromise = null;
  let activeStoragePatch = null;
  const storageFlushWaiters = [];
  const pendingRequests = new Map();
  const storageChanged = createEvent();
  const nativeEvents = createEvent();
  const inputDocumentToken = nextRequestId("input-doc");
  let inputDocumentNonce = null;
  let inputContext = null;
  let inputContextRequest = null;
  let inputSnapshotProvider = null;

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
    if (!pendingStoragePatch) {
      pendingStoragePatch = {
        clear: false,
        set: Object.create(null),
        remove: new Set(),
        waiters: [],
        events: [],
        operations: null,
        index: 0,
        settled: false
      };
    }
    pendingStoragePatch.waiters.push({ resolve, reject });
    pendingStoragePatch.events.push(cloneForPublic(changes));
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
    if (disposed || storageFlushInFlight || storageFlushTimer !== null || (!activeStoragePatch && !pendingStoragePatch)) return;
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
      let revision = storageRevision;
      let posted = false;
      for (const patch of [activeStoragePatch, pendingStoragePatch]) {
        if (!patch) continue;
        for (const operation of storageOperationsForPatch(patch).slice(patch.index)) {
          const baseRevision = operation.sentRevision ?? revision;
          if (!operation.unloadPosted) {
            postStorageOperationUntracked("storage.patch", storageOperationPayload(operation, baseRevision));
            operation.unloadPosted = true;
            posted = true;
          }
          revision = Math.max(revision, baseRevision) + 1;
        }
      }
      return posted;
    } catch (error) {
      nativeEvents.emit(() => [{ name: "bridge.error", data: { channel: "storage", message: error.message } }]);
      return false;
    }
  }

  function storageOperationsForPatch(patch) {
    if (patch.operations) return patch.operations;
    const criticalKeys = Object.hasOwn(patch.set, "cc_mobile_settings_schema")
      ? new Set(["cc_mobile_settings_schema", "lichess.safeAntiBanGuard", "chesscom.safeAntiBanGuard", "lichess.mobilePresetId", "chesscom.mobilePresetId"])
      : new Set();
    const critical = [];
    const entries = [];
    for (const [key, value] of Object.entries(patch.set)) {
      (criticalKeys.has(key) ? critical : entries).push({ key, value, remove: false });
    }
    for (const key of patch.remove) entries.push({ key, remove: true });
    const chunks = chunkEntries(entries, MAX_STORAGE_MUTATION_KEYS);
    if (critical.length) {
      if (chunks.length && chunks[chunks.length - 1].length + critical.length <= MAX_STORAGE_MUTATION_KEYS) chunks[chunks.length - 1].push(...critical);
      else chunks.push(critical);
    }
    if (!chunks.length) chunks.push([]);
    patch.operations = chunks.map((chunk, index) => ({
      mutationId: nextRequestId("storage-mutation"), clear: patch.clear && index === 0,
      items: createPublicRecord(chunk.filter(item => !item.remove).map(item => [item.key, item.value])),
      keys: chunk.filter(item => item.remove).map(item => item.key), sentRevision: null, unloadPosted: false
    }));
    return patch.operations;
  }

  function storageOperationPayload(operation, baseRevision) {
    return { baseRevision, mutationId: operation.mutationId, items: operation.items, keys: operation.keys, clear: operation.clear };
  }

  function settleStoragePatch(patch, error) {
    if (!patch || patch.settled) return;
    patch.settled = true;
    for (const waiter of patch.waiters) {
      if (error) waiter.reject(error); else waiter.resolve();
    }
  }

  function settleStorageFlush(error) {
    if (!error && (activeStoragePatch || pendingStoragePatch)) return;
    for (const waiter of storageFlushWaiters.splice(0)) {
      if (error) waiter.reject(error); else waiter.resolve(resolveGet(null));
    }
  }

  function disposeStorage(error) {
    if (storageFlushTimer !== null) clearTimeout(storageFlushTimer);
    storageFlushTimer = null;
    settleStoragePatch(activeStoragePatch, error);
    settleStoragePatch(pendingStoragePatch, error);
    activeStoragePatch = null;
    pendingStoragePatch = null;
    settleStorageFlush(error);
  }

  function mergeStorageEvents(events) {
    const result = {};
    for (const changes of events) {
      for (const [key, change] of Object.entries(changes)) {
        if (!Object.hasOwn(result, key)) result[key] = Object.hasOwn(change, "oldValue") ? { oldValue: change.oldValue } : {};
        if (Object.hasOwn(change, "newValue")) result[key].newValue = change.newValue;
        else delete result[key].newValue;
      }
    }
    for (const [key, change] of Object.entries(result)) {
      if (Object.hasOwn(change, "oldValue") === Object.hasOwn(change, "newValue") &&
        JSON.stringify(change.oldValue) === JSON.stringify(change.newValue)) delete result[key];
    }
    return result;
  }

  function requeueStoragePatch(patch, error) {
    storageFlushInFlight = false;
    storageFlushFailures++;
    nativeEvents.emit(() => [{ name: "bridge.error", data: { channel: "storage", message: error.message } }]);
    if (disposed || storageFlushFailures > 5) {
      disposeStorage(error);
      storageFlushFailures = 0;
      return;
    }
    const retry = () => scheduleStorageFlush(Math.min(1000, STORAGE_FLUSH_MS * (2 ** storageFlushFailures)));
    if (error.code === "STORAGE_REVISION_CONFLICT") refreshStorage().then(retry, refreshError => requeueStoragePatch(patch, refreshError));
    else retry();
  }

  function flushStoragePatch() {
    if (disposed || storageFlushInFlight || (!activeStoragePatch && !pendingStoragePatch)) return false;
    if (storageFlushTimer !== null) {
      clearTimeout(storageFlushTimer);
      storageFlushTimer = null;
    }
    const patch = activeStoragePatch || pendingStoragePatch;
    if (!activeStoragePatch) pendingStoragePatch = null;
    activeStoragePatch = patch;
    storageFlushInFlight = true;
    const sequence = (async () => {
      const operations = storageOperationsForPatch(patch);
      while (patch.index < operations.length) {
        const operation = operations[patch.index];
        operation.sentRevision = storageRevision;
        const response = await sendStorageOperation("storage.patch", storageOperationPayload(operation, storageRevision));
        applyNativeStorageSnapshot(response);
        patch.index++;
      }
    })();
    sequence.then(() => {
      storageFlushInFlight = false;
      storageFlushFailures = 0;
      if (disposed) return;
      activeStoragePatch = null;
      emitStorageChanges(mergeStorageEvents(patch.events));
      settleStoragePatch(patch);
      if (!pendingStoragePatch) storageDirty = false;
      settleStorageFlush();
      scheduleStorageFlush(storageFlushWaiters.length ? 0 : STORAGE_FLUSH_MS);
    }, error => requeueStoragePatch(patch, error));
    return true;
  }

  function refreshStorage() {
    if (disposed) return Promise.reject(createError("Android runtime is disposed", "CONTEXT_INVALIDATED"));
    if (!storageRefreshPromise) {
      storageRefreshPromise = sendStorageOperation("storage.get", {}).then(response => {
        if (disposed) throw createError("Android runtime is disposed", "CONTEXT_INVALIDATED");
        applyNativeStorageSnapshot(response);
        storageHydrated = true;
        return resolveGet(null);
      }).finally(() => { storageRefreshPromise = null; });
    }
    return storageRefreshPromise;
  }

  function ensureStorageReady() {
    if (disposed) return Promise.reject(createError("Android runtime is disposed", "CONTEXT_INVALIDATED"));
    if (storageHydrated) return Promise.resolve(resolveGet(null));
    if (!storageReadyPromise) {
      storageReadyPromise = refreshStorage();
      storageReadyPromise.catch(() => { storageReadyPromise = null; });
    }
    return storageReadyPromise;
  }

  function storageCall(callback, operation) {
    return callbackOrPromise(callback, (resolve, reject) => {
      ensureStorageReady().then(() => {
        if (disposed) throw createError("Android runtime is disposed", "CONTEXT_INVALIDATED");
        operation(resolve, reject);
      }).catch(reject);
    });
  }

  async function flushStorage() {
    await ensureStorageReady();
    if (!activeStoragePatch && !pendingStoragePatch) return resolveGet(null);
    const result = new Promise((resolve, reject) => storageFlushWaiters.push({ resolve, reject }));
    flushStoragePatch();
    return result;
  }

  const storageLocal = Object.freeze({
    QUOTA_BYTES: MAX_STORAGE_BYTES,
    get(keys, callback) {
      if (typeof keys === "function") {
        callback = keys;
        keys = null;
      }
      return storageCall(callback, resolve => resolve(resolveGet(keys)));
    },
    set(items, callback) {
      return storageCall(callback, (resolve, reject) => {
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
      return storageCall(callback, (resolve, reject) => {
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
      return storageCall(callback, (resolve, reject) => {
        if (!getNativeBridge()) throw createError("Android native bridge is unavailable", "NATIVE_BRIDGE_UNAVAILABLE");
        const changes = {};
        for (const [key, value] of Object.entries(storageState)) {
          changes[key] = { oldValue: cloneForPublic(value) };
        }
        storageState = Object.create(null);
        mergeStoragePatch(true, {}, [], changes, resolve, reject);
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
    const error = createError(message, noReceiver ? "NO_RECEIVER" : code);
    if (typeof raw?.phase === "string" && /^[a-z-]{1,32}$/.test(raw.phase)) error.phase = raw.phase;
    if (Number.isFinite(raw?.elapsedMs) && raw.elapsedMs >= 0 && raw.elapsedMs <= 120000) error.elapsedMs = raw.elapsedMs;
    if (typeof raw?.hadDown === "boolean") error.hadDown = raw.hadDown;
    return error;
  }

  function postScopedInputCancel(id, pending) {
    if (pending.cancelSent || !pending.posted || pending.channel !== "input" ||
        !["input.gesture", "input.context.get"].includes(pending.type)) return;
    pending.cancelSent = true;
    try {
      postEnvelope({
        v: PROTOCOL_VERSION, scope: PROTOCOL_SCOPE, source: "remote", target: "NATIVE", channel: "input",
        type: "input.cancel", id: nextRequestId("cancel"),
        payload: { requestId: id, documentToken: pending.payload.documentToken, documentNonce: pending.payload.documentNonce || null }
      });
    } catch (_) {}
  }

  function finishPendingRequest(id, error, value) {
    const pending = pendingRequests.get(id);
    if (!pending) return;
    pendingRequests.delete(id);
    clearTimeout(pending.timer);
    if (pending.abortCleanup) { try { pending.abortCleanup(); } catch (_) {} }
    if (error) {
      error.requestId = id;
      if (pending.channel === "input" && error.code === "INPUT_DOCUMENT_CHANGED") {
        inputContext = null;
        inputDocumentNonce = null;
      }
    }
    if (pending.callback) invokeCallback(pending.callback, value, error);
    else if (error) pending.reject(error);
    else pending.resolve(value);
  }

  function beginRequest(channel, type, responseType, payload, timeoutMs, callback, target, options = {}) {
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

    const start = (resolve, reject) => {
      const pending = { channel, type, responseType, payload, callback, resolve, reject, posted: false, cancelSent: false };
      const timer = setTimeout(() => {
        if (pendingRequests.get(id) !== pending) return;
        postScopedInputCancel(id, pending);
        const error = createError(`Android ${channel} request timed out after ${timeoutMs} ms`, "TIMEOUT");
        if (channel === "input") { error.phase = "reply"; error.deliveryUnknown = type === "input.gesture" && pending.posted; }
        finishPendingRequest(id, error);
      }, timeoutMs);
      pending.timer = timer;
      pendingRequests.set(id, pending);
      if (options.signal) {
        const abort = () => {
          if (pendingRequests.get(id) !== pending) return;
          postScopedInputCancel(id, pending);
          const error = createError("The native request was aborted", channel === "input" ? "INPUT_CANCELLED" : "REQUEST_ABORTED");
          error.name = "AbortError";
          finishPendingRequest(id, error);
        };
        pending.abortCleanup = () => options.signal.removeEventListener("abort", abort);
        try { options.signal.addEventListener("abort", abort, { once: true }); }
        catch (_) { finishPendingRequest(id, createError("Could not attach request cancellation", "INVALID_ARGUMENT")); return; }
        if (options.signal.aborted) { abort(); return; }
      }
      try {
        pending.posted = true;
        postEnvelope(createEnvelope());
      } catch (error) {
        finishPendingRequest(id, error);
      }
    };
    if (typeof callback === "function") {
      start();
      return undefined;
    }
    return new Promise(start);
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

  function validateInputId(value) {
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value)) {
      throw createError("Invalid input identity", "INVALID_INPUT");
    }
    return value;
  }

  function normalizeInputSnapshot(raw) {
    const fields = ["v", "boardId", "positionKey", "orientation", "myColor", "turn", "boardRect", "targetId", "targetRect", "hit", "animating"];
    if (!isPlainObject(raw) || Object.keys(raw).some(key => !fields.includes(key)) || raw.v !== 1 ||
        typeof raw.positionKey !== "string" || raw.positionKey.length < 1 || raw.positionKey.length > 1024 || /[\0-\x1F\x7F]/.test(raw.positionKey) ||
        !["white", "black"].includes(raw.orientation) || !["w", "b"].includes(raw.myColor) || !["w", "b"].includes(raw.turn) ||
        typeof raw.hit !== "boolean" || typeof raw.animating !== "boolean") {
      throw createError("Invalid mobile input snapshot", "INPUT_SNAPSHOT_INVALID");
    }
    const rect = value => {
      if (!isPlainObject(value) || Object.keys(value).some(key => !["left", "top", "width", "height"].includes(key)) ||
          ![value.left, value.top, value.width, value.height].every(number => typeof number === "number" && Number.isFinite(number)) ||
          Math.abs(value.left) > 16384 || Math.abs(value.top) > 16384 || value.width < 1 || value.width > 16384 || value.height < 1 || value.height > 16384) {
        throw createError("Invalid mobile input rectangle", "INPUT_SNAPSHOT_INVALID");
      }
      return { left: value.left, top: value.top, width: value.width, height: value.height };
    };
    return { v: 1, boardId: validateInputId(raw.boardId), positionKey: raw.positionKey, orientation: raw.orientation,
      myColor: raw.myColor, turn: raw.turn, boardRect: rect(raw.boardRect), targetId: validateInputId(raw.targetId),
      targetRect: rect(raw.targetRect), hit: raw.hit, animating: raw.animating };
  }

  function registerInputSnapshotProvider(provider) {
    if (disposed) throw createError("Android runtime is disposed", "CONTEXT_INVALIDATED");
    if (typeof provider !== "function") throw createError("Input snapshot provider must be a function", "INVALID_INPUT");
    if (inputSnapshotProvider && inputSnapshotProvider !== provider) throw createError("An input snapshot provider is already registered", "INPUT_PROVIDER_EXISTS");
    inputSnapshotProvider = provider;
    return () => { if (inputSnapshotProvider === provider) inputSnapshotProvider = null; };
  }

  function captureInputSnapshot(request) {
    if (disposed) throw createError("Android runtime is disposed", "CONTEXT_INVALIDATED");
    if (!inputSnapshotProvider) throw createError("The mobile core input snapshot is unavailable", "INPUT_SNAPSHOT_UNAVAILABLE");
    if (!isPlainObject(request) || Object.keys(request).some(key => !["points", "targetId"].includes(key)) ||
        !Array.isArray(request.points) || request.points.length < 1 || request.points.length > MAX_TOUCH_POINTS) {
      throw createError("Invalid input snapshot request", "INVALID_INPUT");
    }
    const targetId = validateInputId(request.targetId);
    const points = request.points.map(point => {
      if (!isPlainObject(point) || Object.keys(point).some(key => !["x", "y"].includes(key)) ||
          ![point.x, point.y].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 32768)) {
        throw createError("Invalid input snapshot point", "INVALID_INPUT");
      }
      return { x: point.x, y: point.y };
    });
    let raw;
    try { raw = inputSnapshotProvider({ points, targetId }); }
    catch (_) { throw createError("The live mobile input snapshot could not be captured", "INPUT_SNAPSHOT_UNAVAILABLE"); }
    const snapshot = normalizeInputSnapshot(raw);
    if (snapshot.targetId !== targetId) throw createError("Input snapshot target differs", "INPUT_SNAPSHOT_INVALID");
    return freezeJson(snapshot);
  }

  function ensureInputContext(signal) {
    if (!inputContextRequest && !inputContext) {
      inputContextRequest = beginRequest("input", "input.context.get", "input.context.response", { documentToken: inputDocumentToken },
        INPUT_CONTEXT_TIMEOUT_MS, undefined, "NATIVE").finally(() => { inputContextRequest = null; });
    }
    const ready = inputContext ? Promise.resolve(inputContext) : inputContextRequest;
    if (!signal) return ready;
    return new Promise((resolve, reject) => {
      const abort = () => {
        signal.removeEventListener("abort", abort);
        const error = createError("The input action was aborted before dispatch", "INPUT_CANCELLED");
        error.name = "AbortError";
        reject(error);
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      ready.then(value => { signal.removeEventListener("abort", abort); if (!signal.aborted) resolve(value); },
        error => { signal.removeEventListener("abort", abort); reject(error); });
    });
  }

  function normalizeNativeRequest(method, rawParams) {
    const params = rawParams === undefined ? {} : rawParams;
    if (!isPlainObject(params)) throw createError("Native request params must be an object", "INVALID_ARGUMENT");
    if (method === "project.open") {
      if (Object.keys(params).length) throw createError("Project page takes no params", "INVALID_ARGUMENT");
      return { channel: "project", type: "project.open", responseType: "project.open.response", payload: {} };
    }
    if (method === "input.context.get") {
      if (Object.keys(params).length || window !== window.top || document.visibilityState !== "visible") {
        throw createError("Input context requires the visible main document and no params", "INVALID_INPUT");
      }
      return { channel: "input", type: method, responseType: "input.context.response", timeoutMs: INPUT_CONTEXT_TIMEOUT_MS,
        payload: { documentToken: inputDocumentToken } };
    }
    if (method === "input.cancel") {
      if (Object.keys(params).some(key => !["requestId", "documentNonce"].includes(key))) throw createError("Unexpected input cancellation field", "INVALID_INPUT");
      return {
        channel: "input", type: "input.cancel", responseType: "input.cancel.response", timeoutMs: INPUT_TIMEOUT_MS,
        payload: { requestId: validateInputId(params.requestId), documentToken: inputDocumentToken, documentNonce: validateInputId(params.documentNonce) }
      };
    }
    if (method === "input.gesture") {
      if (window !== window.top || document.visibilityState !== "visible") {
        throw createError("Native input requires the visible main game document", "INPUT_UNAVAILABLE");
      }
      if (Object.keys(params).some(key => !["action", "points", "durationMs", "viewport", "targetId", "snapshot"].includes(key))) {
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
      const targetId = validateInputId(params.targetId);
      const snapshot = params.snapshot === undefined ? captureInputSnapshot({ points, targetId }) : normalizeInputSnapshot(params.snapshot);
      if (snapshot.targetId !== targetId) throw createError("Input snapshot target differs", "INPUT_SNAPSHOT_INVALID");
      return {
        channel: "input", type: "input.gesture", responseType: "input.gesture.response", timeoutMs: INPUT_TIMEOUT_MS,
        payload: { action, points, durationMs, viewport: { ...viewport }, documentToken: inputDocumentToken,
          documentNonce: inputDocumentNonce, targetId, snapshot }
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

  function nativeRequest(method, params, options, callback) {
    if (typeof params === "function") {
      callback = params;
      params = undefined;
      options = undefined;
    }
    if (typeof options === "function") { callback = options; options = undefined; }
    try {
      const requestOptions = options === undefined ? {} : options;
      if (!isPlainObject(requestOptions) || Object.keys(requestOptions).some(key => key !== "signal") ||
          (requestOptions.signal !== undefined && (!requestOptions.signal || typeof requestOptions.signal.aborted !== "boolean" ||
            typeof requestOptions.signal.addEventListener !== "function" || typeof requestOptions.signal.removeEventListener !== "function"))) {
        throw createError("Native request options must contain a valid AbortSignal", "INVALID_ARGUMENT");
      }
      if (disposed) throw createError("Android runtime is disposed", "CONTEXT_INVALIDATED");
      if (requestOptions.signal?.aborted) throw createError("The native request was aborted", "INPUT_CANCELLED");
      const request = normalizeNativeRequest(method, params);
      const perform = async () => {
        if (request.type === "input.gesture") {
          const context = await ensureInputContext(requestOptions.signal);
          request.payload.documentNonce = context.documentNonce;
        }
        return beginRequest(request.channel, request.type, request.responseType, request.payload,
          request.timeoutMs || NATIVE_TIMEOUT_MS, undefined, "NATIVE", requestOptions);
      };
      const promise = perform();
      if (typeof callback === "function") {
        promise.then(value => invokeCallback(callback, value, null), error => invokeCallback(callback, undefined, error));
        return undefined;
      }
      return promise;
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
    const ok = envelope.ok !== false && envelope.payload?.ok !== false && !envelope.error &&
      (pending.channel !== "input" || (envelope.type === pending.responseType && envelope.payload?.ok === true &&
        (["input.cancel.response", "input.context.response"].includes(pending.responseType) || envelope.payload?.dispatched === true)));
    const responsePayload = Object.prototype.hasOwnProperty.call(envelope, "result")
      ? envelope.result
      : Object.prototype.hasOwnProperty.call(envelope.payload || {}, "result")
        ? envelope.payload.result
        : envelope.payload;
    if (ok) {
      try {
        const value = responsePayload === undefined ? undefined : cloneJson(responsePayload,
          pending.channel === "storage" ? MAX_BRIDGE_BYTES : MAX_RUNTIME_BYTES, "Native response");
        if (pending.responseType === "input.context.response") {
          if (!isPlainObject(value) || value.documentToken !== inputDocumentToken ||
              typeof value.documentNonce !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value.documentNonce) ||
              !Number.isSafeInteger(value.documentGeneration) || value.documentGeneration < 0 || value.origin !== location.origin) {
            throw createError("Native document context is invalid", "INPUT_CONTEXT_INVALID");
          }
          inputContext = freezeJson(value);
          inputDocumentNonce = value.documentNonce;
        }
        finishPendingRequest(id, null, value);
      } catch (error) { finishPendingRequest(id, error); }
    } else {
      const error = normalizeBridgeError(envelope.payload || envelope, envelope.code);
      finishPendingRequest(id, error);
    }
    return true;
  }

  function applyNativeStorageSnapshot(payload) {
    const items = payload?.items ?? payload?.storage;
    if (!isPlainObject(items) || !Number.isSafeInteger(payload.revision) || payload.revision < 0) {
      throw createError("Native storage snapshot is invalid", "INVALID_STORAGE_SNAPSHOT");
    }
    if (payload.revision < storageRevision) return;
    let next = copyStorageRecord(items);
    // A native refresh must not undo explicit edits still awaiting durable IO.
    for (const patch of [activeStoragePatch, pendingStoragePatch]) {
      if (!patch) continue;
      if (patch.clear) next = Object.create(null);
      Object.assign(next, copyStorageRecord(patch.set));
      for (const key of patch.remove) delete next[key];
    }
    verifyStorageCandidate(next);
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
    storageRevision = payload.revision;
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
        envelope.type === "input.context.response" ||
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

  function cancelInputRequests(code) {
    for (const [id, pending] of Array.from(pendingRequests)) {
      if (pending.channel !== "input") continue;
      postScopedInputCancel(id, pending);
      finishPendingRequest(id, createError("The input document became inactive", code));
    }
  }

  function handleVisibilityChange() {
    if (document.visibilityState === "hidden") {
      cancelInputRequests("INPUT_DOCUMENT_HIDDEN");
      flushStoragePatch();
    }
  }

  function handlePageHide(event) {
    cancelInputRequests("CONTEXT_INVALIDATED");
    if (event.persisted) flushStoragePatch();
    else {
      flushStorageSnapshotBeforeUnload();
      cleanup();
    }
  }

  function cleanup() {
    if (disposed) return;
    flushStorageSnapshotBeforeUnload();
    cancelInputRequests("CONTEXT_INVALIDATED");
    inputSnapshotProvider = null;
    disposed = true;
    disposeStorage(createError("Android context was invalidated", "CONTEXT_INVALIDATED"));
    for (const pending of pendingRequests.values()) {
      clearTimeout(pending.timer);
      if (pending.abortCleanup) { try { pending.abortCleanup(); } catch (_) {} }
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
    inputDocumentNonce: { enumerable: false, get: () => inputDocumentNonce },
    registerInputSnapshotProvider: { value: registerInputSnapshotProvider, enumerable: false },
    captureInputSnapshot: { value: captureInputSnapshot, enumerable: false },
    nativeEvents: { value: nativeEvents.event, enumerable: true },
    onNativeEvent: { value: nativeEvents.event, enumerable: true },
    profile: { enumerable: true, get: () => cloneForPublic(profileState) },
    disposed: { enumerable: true, get: () => disposed },
    ready: { enumerable: true, get: ensureStorageReady },
    refreshStorage: { value: refreshStorage, enumerable: false },
    storageRevision: { enumerable: false, get: () => storageRevision },
    flushStorage: { value: flushStorage, enumerable: false },
    flushStorageBeforeUnload: { value: flushStorageSnapshotBeforeUnload, enumerable: false },
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
