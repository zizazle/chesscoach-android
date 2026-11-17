"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const initialKey = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -";

function createHarness(file) {
  const source = fs.readFileSync(path.resolve(__dirname, "../../main/assets/content", file), "utf8");
  const names = ["markBoardDirty", "adoptPositionState", "isCurrentAnalysisMeta", "initNeuralCanvasBackground"];
  const functions = names.map(name => {
    const start = source.indexOf(`  function ${name}(`);
    assert.notEqual(start, -1, `Missing ${name}`);
    const next = source.slice(start + 1).search(/\n  function /);
    assert.notEqual(next, -1, `Missing function boundary after ${name}`);
    return source.slice(start, start + 1 + next);
  }).join("\n");
  const context = vm.createContext({ initialKey, structuredClone });
  vm.runInContext(`
    const calls = { cancel:0, clear:0, hide:0, render:0, capture:0, retry:0, canvas:0 };
    const window = { __CC_ANDROID_RUNTIME__:{}, __CHESSCOACH_BOARD_STATE__:{} };
    const mobileSession = null;
    const StockfishWasmEngine = { cancel() { calls.cancel++; } };
    let boardDirty = false, positionId = 4, positionAnalysisId = 7, analysisRequestId = 9;
    let currentPositionKey = initialKey, analysisSessionId = "session";
    let committedBoardKey = initialKey, activeEngineBoardKey = initialKey;
    let analysisRetryCount = 2, finalEngineRetryCount = 1;
    let cachedMoves = { best:{uci:"e2e4"}, boardKey:initialKey, positionId:4 };
    let fresh = { positionKey:initialKey, boardKey:initialKey, animating:false };
    function clearAnalysisRetry() { calls.retry++; }
    function hideArrows() { calls.hide++; }
    function renderArrowsOverlay() { calls.render++; }
    function clearPositionPresentation() {
      calls.clear++; cachedMoves = {best:null,boardKey:"",positionId:-1};
      committedBoardKey = ""; activeEngineBoardKey = "";
    }
    function captureBoardState() { calls.capture++; return fresh && {...fresh}; }
    function $(id) { calls.canvas++; throw new Error("Android canvas must not initialize: " + id); }
    ${functions}
    globalThis.api = {
      dirty:markBoardDirty, adopt:adoptPositionState, valid:isCurrentAnalysisMeta,
      canvas:initNeuralCanvasBackground,
      meta() { return {sessionId:analysisSessionId,positionId,analysisId:positionAnalysisId,positionKey:currentPositionKey}; },
      fresh(value) { fresh = value; },
      snapshot() { return structuredClone({calls,boardDirty,positionId,positionAnalysisId,analysisRequestId,currentPositionKey,committedBoardKey,activeEngineBoardKey,cachedMoves,analysisRetryCount,finalEngineRetryCount}); }
    };
  `, context, { filename: file });
  return context.api;
}

for (const file of ["content.js", "chesscom.js"]) {
  test(`${file}: repeated non-positional changes preserve completed analysis`, () => {
    const api = createHarness(file);
    const meta = api.meta();
    for (let i = 0; i < 100; i++) {
      api.dirty("MOVE");
      assert.equal(api.valid(meta), true);
    }
    const state = api.snapshot();
    assert.equal(state.committedBoardKey, initialKey);
    assert.equal(state.activeEngineBoardKey, initialKey);
    assert.equal(state.positionId, 4);
    assert.equal(state.positionAnalysisId, 7);
    assert.equal(state.analysisRequestId, 9);
    assert.equal(state.calls.cancel, 0);
    assert.equal(state.calls.clear, 0);
    assert.equal(state.calls.render, 100);
    assert.equal(state.cachedMoves.best.uci, "e2e4");
  });

  test(`${file}: a real move invalidates old callbacks and retries`, () => {
    const api = createHarness(file);
    const meta = api.meta();
    const movedKey = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3";
    api.dirty("MOVE");
    api.fresh({ positionKey:movedKey, boardKey:movedKey, animating:false });
    assert.equal(api.valid(meta), false);
    const state = api.snapshot();
    assert.equal(state.positionId, 5);
    assert.equal(state.positionAnalysisId, 8);
    assert.equal(state.analysisRequestId, 10);
    assert.equal(state.currentPositionKey, movedKey);
    assert.equal(state.calls.cancel, 1);
    assert.equal(state.calls.clear, 1);
    assert.equal(state.calls.retry, 1);
    assert.equal(state.analysisRetryCount, 0);
    assert.equal(state.finalEngineRetryCount, 0);
    assert.equal(state.committedBoardKey, "");
    assert.equal(state.cachedMoves.best, null);
  });

  test(`${file}: castling, en-passant, turn and takeback changes invalidate`, () => {
    for (const key of [
      initialKey.replace("KQkq", "KQ"),
      initialKey.replace(/-$/, "e3"),
      initialKey.replace(" w ", " b "),
      "8/8/8/8/8/8/4K3/7k w - -"
    ]) {
      const api = createHarness(file);
      const meta = api.meta();
      api.dirty("MOVE");
      api.fresh({ positionKey:key, boardKey:key, animating:false });
      assert.equal(api.valid(meta), false);
      assert.equal(api.snapshot().calls.cancel, 1);
    }
  });

  test(`${file}: replacing a same-position board still cancels old work`, () => {
    const api = createHarness(file);
    const meta = api.meta();
    api.dirty("MOVE");
    api.dirty("BOARD_REPLACED");
    api.adopt({ positionKey:initialKey, boardKey:initialKey });
    assert.equal(api.valid(meta), false);
    const state = api.snapshot();
    assert.equal(state.calls.cancel, 1);
    assert.equal(state.calls.clear, 1);
    assert.equal(state.committedBoardKey, "");
  });

  test(`${file}: an animation-time response cannot strand the committed position`, () => {
    const api = createHarness(file);
    const meta = api.meta();
    api.dirty("MOVE");
    api.fresh({ positionKey:initialKey, boardKey:initialKey, animating:true });
    assert.equal(api.valid(meta), false);
    assert.equal(api.snapshot().committedBoardKey, "");
    assert.equal(api.snapshot().activeEngineBoardKey, "");
    api.adopt({ positionKey:initialKey, boardKey:initialKey, animating:false });
    assert.equal(api.snapshot().boardDirty, false);
  });

  test(`${file}: an obsolete result does not recapture or unlock the new search`, () => {
    const api = createHarness(file);
    const meta = api.meta();
    api.dirty("MOVE");
    assert.equal(api.valid({ ...meta, analysisId:meta.analysisId - 1 }), false);
    const state = api.snapshot();
    assert.equal(state.calls.capture, 0);
    assert.equal(state.committedBoardKey, initialKey);
  });

  test(`${file}: Android never creates a decorative canvas loop`, () => {
    const api = createHarness(file);
    api.canvas({});
    assert.equal(api.snapshot().calls.canvas, 0);
  });
}
