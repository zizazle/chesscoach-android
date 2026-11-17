"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createFixture } = require("./native-input-fixture.cjs");
const params = () => ({ action: "tap", points: [{ x: 180, y: 300 }], durationMs: 80, targetId: "board-target" });
const reply = (request, payload, type = request.type === "input.context.get" ? "input.context.response" : `${request.type}.response`) => ({
  v: 1, scope: "chesscoach.android", source: "native", target: "REMOTE", channel: "input", id: request.id, type, payload
});
async function bind(h, request) {
  return h.command({ op: "reply", envelope: reply(request, { ok: true, documentToken: request.payload.documentToken,
    documentNonce: "unit-native-nonce", documentGeneration: 1, origin: h.context.location.origin }) });
}
async function bound() {
  const h = createFixture();
  const request = await h.command({ op: "request", name: "binding", method: "input.context.get", params: {} });
  await bind(h, request.messages[0]);
  return h;
}

test("production gesture serializer acquires one stable native document binding", async () => {
  const h = createFixture(), first = await h.command({ op: "request", name: "first" });
  assert.equal(first.messages[0].type, "input.context.get");
  const ready = await bind(h, first.messages[0]), gesture = ready.messages[0];
  assert.equal(gesture.type, "input.gesture");
  assert.equal(gesture.payload.documentNonce, "unit-native-nonce");
  assert.equal(gesture.payload.snapshot.positionKey, "fixture-position-1");
  await h.command({ op: "reply", envelope: reply(gesture, { ok: true, dispatched: true }) });
  await h.command({ op: "patch", snapshot: { positionKey: "fixture-position-2" }, url: "https://lichess.org/new-route#next-turn" });
  const second = await h.command({ op: "request", name: "second" });
  assert.equal(second.messages.length, 1);
  assert.equal(second.messages[0].type, "input.gesture");
  assert.equal(second.messages[0].payload.documentToken, gesture.payload.documentToken);
  assert.equal(second.messages[0].payload.documentNonce, gesture.payload.documentNonce);
  assert.notEqual(second.messages[0].id, gesture.id);
  assert.equal(second.messages[0].payload.snapshot.positionKey, "fixture-position-2");
});

test("production serializer rejects document-wide cancellation and forged gesture context fields", async () => {
  const h = createFixture();
  await assert.rejects(h.runtime.nativeRequest("input.cancel", {}), error => error.code === "INVALID_INPUT");
  for (const key of ["documentToken", "documentNonce", "url", "documentId", "positionId"]) {
    await assert.rejects(h.runtime.nativeRequest("input.gesture", { ...params(), [key]: "forged" }), error => error.code === "INVALID_INPUT");
  }
  assert.equal((await h.command({ op: "inspect" })).messages.length, 0);
});

test("verified snapshot provider is required, immutable, and unregisters only its owner", async () => {
  const h = createFixture();
  const snapshot = h.runtime.captureInputSnapshot({ points: params().points, targetId: "board-target" });
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.boardRect), true);
  assert.throws(() => h.runtime.registerInputSnapshotProvider(() => snapshot), error => error.code === "INPUT_PROVIDER_EXISTS");
  await h.command({ op: "provider", enabled: false });
  await assert.rejects(h.runtime.nativeRequest("input.gesture", params()), error => error.code === "INPUT_SNAPSHOT_UNAVAILABLE");
});

test("snapshot geometry and flags are validated before native posting", async () => {
  const h = createFixture();
  const valid = h.runtime.captureInputSnapshot({ points: params().points, targetId: "board-target" });
  for (const snapshot of [{ ...valid, hit: "true" }, { ...valid, orientation: "flipped" },
    { ...valid, boardRect: { left: 0, top: 0, width: Infinity, height: 100 } }, { ...valid, cookie: "secret" }]) {
    await assert.rejects(h.runtime.nativeRequest("input.gesture", { ...params(), snapshot }), error => error.code === "INPUT_SNAPSHOT_INVALID");
  }
  assert.equal((await h.command({ op: "inspect" })).messages.length, 0);
});

test("context responses retain strict native source, channel, origin and token validation", async () => {
  const h = createFixture(), pending = await h.command({ op: "request", name: "ctx", method: "input.context.get", params: {} });
  const request = pending.messages[0];
  const valid = reply(request, { ok: true, documentToken: request.payload.documentToken, documentNonce: "unit-native-nonce",
    documentGeneration: 1, origin: h.context.location.origin });
  for (const bad of [{ ...valid, source: "engine" }, { ...valid, channel: "native" }]) {
    const result = await h.command({ op: "reply", envelope: bad });
    assert.equal(result.results.ctx.status, "pending");
    assert.equal(result.nonce, null);
  }
  const invalid = await h.command({ op: "reply", envelope: { ...valid, payload: { ...valid.payload, origin: "https://example.org" } } });
  assert.equal(invalid.results.ctx.code, "INPUT_CONTEXT_INVALID");
  assert.equal(invalid.nonce, null);
});

test("AbortSignal posts only the original request ID and original native nonce", async () => {
  const h = await bound(), started = await h.command({ op: "request", name: "move", signal: "move" });
  const request = started.messages[0], aborted = await h.command({ op: "abort", signal: "move" });
  const cancel = aborted.messages[0];
  assert.equal(cancel.type, "input.cancel");
  assert.deepEqual(cancel.payload, { requestId: request.id, documentToken: request.payload.documentToken, documentNonce: request.payload.documentNonce });
  assert.equal(aborted.results.move.code, "INPUT_CANCELLED");
  assert.notEqual(cancel.id, request.id);
});

test("abort after successful settlement cannot cancel a replacement request", async () => {
  const h = await bound(), first = await h.command({ op: "request", name: "first", signal: "old" });
  await h.command({ op: "reply", envelope: reply(first.messages[0], { ok: true, dispatched: true }) });
  const second = await h.command({ op: "request", name: "second", signal: "new" });
  const oldAbort = await h.command({ op: "abort", signal: "old" });
  assert.deepEqual(oldAbort.messages, []);
  assert.equal(oldAbort.results.second.status, "pending");
  const result = await h.command({ op: "reply", envelope: reply(second.messages[0], { ok: true, dispatched: true }) });
  assert.equal(result.results.second.status, "ok");
});

test("abort while awaiting shared context never posts gesture or cancels another waiter", async () => {
  const h = createFixture(), first = await h.command({ op: "request", name: "first", signal: "old" });
  const aborted = await h.command({ op: "abort", signal: "old" });
  assert.deepEqual(aborted.messages, []);
  assert.equal(aborted.results.first.code, "INPUT_CANCELLED");
  await h.command({ op: "request", name: "second", signal: "new" });
  const ready = await bind(h, first.messages[0]);
  assert.equal(ready.messages.length, 1);
  assert.equal(ready.messages[0].type, "input.gesture");
  assert.equal(ready.results.first.code, "INPUT_CANCELLED");
});

test("reply timeout is delivery-unknown and cancels the original request without replay", async () => {
  const h = await bound(), request = await h.command({ op: "request", name: "lost" });
  const result = await h.command({ op: "advance", ms: 5500 });
  assert.equal(result.results.lost.code, "TIMEOUT");
  assert.equal(result.results.lost.phase, "reply");
  assert.equal(result.results.lost.deliveryUnknown, true);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].type, "input.cancel");
  assert.equal(result.messages[0].payload.requestId, request.messages[0].id);
});

test("only verified document-change errors invalidate the lease, never the JS document token", async () => {
  const h = await bound(), token = h.runtime.inputDocumentToken;
  for (const code of ["INPUT_FOCUS_LOST", "INPUT_DOCUMENT_CHANGED"]) {
    const request = await h.command({ op: "request", name: code });
    const result = await h.command({ op: "reply", envelope: { ...reply(request.messages[0], { ok: false, error: { code, message: "native error", phase: "inspect", hadDown: false, elapsedMs: 4 } }, "error"), channel: "native" } });
    assert.equal(result.results[code].code, code);
    assert.equal(result.results[code].phase, "inspect");
    assert.equal(result.results[code].hadDown, false);
    assert.equal(h.runtime.inputDocumentToken, token);
    assert.equal(h.runtime.inputDocumentNonce, code === "INPUT_DOCUMENT_CHANGED" ? null : "unit-native-nonce");
  }
  const next = await h.command({ op: "request", name: "rebind" });
  assert.equal(next.messages[0].type, "input.context.get");
});

test("persisted pagehide cancels exact pending input but preserves provider and document identity", async () => {
  const h = await bound(), started = await h.command({ op: "request", name: "move" });
  const hidden = await h.command({ op: "pagehide", persisted: true });
  assert.equal(hidden.messages.find(message => message.type === "input.cancel").payload.requestId, started.messages[0].id);
  assert.equal(h.runtime.disposed, false);
  assert.equal(h.runtime.captureInputSnapshot({ points: params().points, targetId: "board-target" }).boardId, "board-1");
});

test("cleanup detaches cancellation and rejects pending input instead of leaving it busy", async () => {
  const h = await bound(), request = await h.command({ op: "request", name: "move", signal: "old" });
  const closed = await h.command({ op: "cleanup" });
  assert.equal(closed.results.move.code, "CONTEXT_INVALIDATED");
  assert.equal(closed.messages.find(message => message.type === "input.cancel").payload.requestId, request.messages[0].id);
  assert.deepEqual((await h.command({ op: "abort", signal: "old" })).messages, []);
  await assert.rejects(h.runtime.nativeRequest("input.gesture", params()), error => error.code === "CONTEXT_INVALIDATED");
});

test("legacy native callback signature and runtime/storage request defaults remain compatible", async () => {
  const h = createFixture();
  let value;
  assert.equal(h.runtime.nativeRequest("project.open", {}, result => { value = result; }), undefined);
  const sent = await h.command({ op: "inspect" });
  await h.command({ op: "reply", envelope: { ...reply(sent.messages[0], { ok: true }), channel: "project" } });
  assert.equal(value.ok, true);
  await assert.rejects(h.runtime.nativeRequest("project.open", {}, { forceFocus: true }), error => error.code === "INVALID_ARGUMENT");
});
