package com.chesscoach.app

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.Closeable
import java.io.File
import java.net.URI

/** Actual production serializer and snapshot in Node, actual controller in JVM. */
class NativeInputControllerTest {
    private class Javascript(url: String) : Closeable {
        private val script = listOf(File("app/src/test/js/native-input-fixture.cjs"), File("src/test/js/native-input-fixture.cjs"))
            .firstOrNull { it.isFile } ?: error("Run tests from the Android project or app directory")
        private val process = ProcessBuilder(System.getenv("CC_NODE_BINARY") ?: "node", script.absolutePath, "--ipc")
            .redirectError(ProcessBuilder.Redirect.INHERIT).start()
        private val input = process.outputStream.bufferedWriter()
        private val output = process.inputStream.bufferedReader()
        var latest = JSONObject()
            private set
        init { call(JSONObject().put("op", "init").put("url", url)) }
        fun call(command: JSONObject): JSONObject {
            input.write(command.toString()); input.newLine(); input.flush()
            val result = JSONObject(output.readLine() ?: error("Node input fixture exited (${process.exitValue()})"))
            check(!result.has("fixtureError")) { result.optString("fixtureError") }
            latest = result
            return result
        }
        override fun close() {
            try { input.write("{\"op\":\"shutdown\"}\n"); input.flush() } catch (_: Exception) {}
            input.close(); output.close()
            if (!process.waitFor(2, java.util.concurrent.TimeUnit.SECONDS)) process.destroyForcibly()
        }
    }

    private class Boundary(url: String = "https://lichess.org/native-input-fixture") : NativeInputController.Host, Closeable {
        private data class Scheduled(val runnable: Runnable, val at: Long, val sequence: Long)
        private data class Inspection(val script: String, val callback: (String?) -> Unit)
        val js = Javascript(url)
        val view = Any()
        val origin = URI(url).let { "${it.scheme}://${it.host}" }
        var clock = 1_000L
        var state = NativeInputController.ViewState(1, true, true, false, false, false, true, true, true, 1080, 2160, url = url)
        var autoInspect = true
        var failReply = false
        var throwInspection = false
        var rejectAction: Int? = null
        var throwAction: Int? = null
        private var sequence = 0L
        private val scheduled = mutableListOf<Scheduled>()
        private val inspections = mutableListOf<Inspection>()
        val events = mutableListOf<JSONObject>()
        val requests = mutableListOf<JSONObject>()
        val replies = mutableListOf<JSONObject>()
        val controller = NativeInputController(this)

        override fun now(): Long = clock
        override fun state(view: Any): NativeInputController.ViewState = state.copy(main = state.main && view === this.view)
        override fun inspect(view: Any, script: String, callback: (String?) -> Unit) {
            if (throwInspection) throw IllegalStateException("Framework inspection failure")
            inspections.add(Inspection(script, callback))
            if (autoInspect) completeInspection()
        }
        fun completeInspection() {
            val inspection = inspections.removeAt(0)
            val result = js.call(JSONObject().put("op", "snapshot").put("script", inspection.script)).getJSONObject("snapshot")
            inspection.callback(result.toString())
        }
        override fun dispatch(view: Any, action: Int, point: BridgeProtocol.TouchPoint, downTime: Long): Boolean {
            events.add(JSONObject().put("action", action).put("x", point.x).put("y", point.y).put("at", clock).put("downTime", downTime))
            if (throwAction == action) throw IllegalStateException("Framework dispatch failure")
            return rejectAction != action && state.attached && state.shown && state.focused &&
                point.x >= 0 && point.x < state.width && point.y >= 0 && point.y < state.height
        }
        override fun schedule(runnable: Runnable, at: Long) { scheduled.add(Scheduled(runnable, at, ++sequence)) }
        override fun remove(runnable: Runnable) { scheduled.removeAll { it.runnable === runnable } }
        fun advance(ms: Long, jank: Boolean = false) {
            val target = clock + ms
            if (jank) clock = target
            while (true) {
                val next = scheduled.filter { it.at <= target }.minWithOrNull(compareBy<Scheduled> { it.at }.thenBy { it.sequence }) ?: break
                scheduled.remove(next)
                if (!jank) clock = maxOf(clock, next.at)
                next.runnable.run()
            }
            clock = target
        }
        fun accept(envelope: JSONObject) {
            requests.add(envelope)
            controller.handle(BridgeProtocol.parse(envelope.toString()), view, origin) { raw ->
                replies.add(JSONObject(raw))
                if (failReply) throw IllegalStateException("Reply document was invalidated")
                pump(js.call(JSONObject().put("op", "reply").put("envelope", JSONObject(raw))))
            }
        }
        fun pump(result: JSONObject) {
            val messages = result.getJSONArray("messages")
            for (index in 0 until messages.length()) {
                val message = messages.getJSONObject(index)
                if (message.getString("type").startsWith("input.")) accept(message)
            }
        }
        fun command(command: JSONObject): JSONObject = js.call(command).also(::pump)
        fun request(name: String, signal: String? = null, method: String = "input.gesture", params: JSONObject? = null) {
            val command = JSONObject().put("op", "request").put("name", name).put("method", method)
            if (signal != null) command.put("signal", signal)
            if (params != null) command.put("params", params)
            else if (method != "input.gesture") command.put("params", JSONObject())
            command(command)
        }
        fun bind() = request("binding", method = "input.context.get")
        fun outcome(name: String): JSONObject = js.latest.getJSONObject("results").getJSONObject(name)
        fun released() {
            assertFalse(controller.isBusy)
            assertTrue(scheduled.isEmpty())
        }
        fun gestureCount(): Int = requests.count { it.optString("type") == "input.gesture" }
        override fun close() = js.close()
    }

    @Test(timeout = 20_000) fun threeTurnPhasesUseProductionSerializerAndSnapshotOnBothOrigins() {
        for (url in listOf("https://lichess.org/native-input-fixture", "https://www.chess.com/game/live/native-input-fixture")) {
            Boundary(url).use { fixture ->
                val token = fixture.js.latest.getString("token")
                for (turn in 1..3) {
                    fixture.command(JSONObject().put("op", "patch").put("snapshot", JSONObject().put("positionKey", "position-$turn")))
                    for (tap in 1..2) { fixture.request("turn-$turn-$tap"); fixture.advance(80); assertEquals("ok", fixture.outcome("turn-$turn-$tap").getString("status")) }
                    fixture.advance(700)
                }
                assertEquals(6, fixture.gestureCount())
                assertEquals(listOf(0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1), fixture.events.map { it.getInt("action") })
                assertEquals(token, fixture.js.latest.getString("token"))
                assertEquals(1, fixture.requests.count { it.optString("type") == "input.context.get" })
                fixture.released()
            }
        }
    }

    @Test(timeout = 20_000) fun atomicLichessDragDispatchesOneOwnedDownMoveMoveUpSequence() = Boundary("https://lichess.org/native-input-fixture").use { fixture ->
        val params = JSONObject().put("action", "drag").put("durationMs", 180).put("targetId", "board-target")
            .put("points", JSONArray().put(JSONObject().put("x", 180).put("y", 300))
                .put(JSONObject().put("x", 220).put("y", 260)).put(JSONObject().put("x", 260).put("y", 220)))
        fixture.request("atomic-drag", params = params)
        fixture.advance(180)
        assertEquals("ok", fixture.outcome("atomic-drag").getString("status"))
        assertEquals(listOf(0, 2, 2, 1), fixture.events.map { it.getInt("action") })
        val xs = fixture.events.map { it.getDouble("x") }
        val ys = fixture.events.map { it.getDouble("y") }
        assertTrue(xs[0] < xs[1] && xs[1] < xs[2] && xs[2] == xs[3])
        assertTrue(ys[0] > ys[1] && ys[1] > ys[2] && ys[2] == ys[3])
        assertEquals(1, fixture.gestureCount())
        fixture.released()
    }

    @Test(timeout = 20_000) fun staleNativeUrlAcrossSpaRouteDoesNotRejectSecondAutoOrManual() {
        for (url in listOf("https://lichess.org/native-input-fixture", "https://www.chess.com/play/online")) {
            Boundary(url).use { fixture ->
                fixture.request("first"); fixture.advance(80)
                val nonce = fixture.js.latest.getString("nonce")
                fixture.command(JSONObject().put("op", "patch").put("url", "$url/next-game?private=not-logged#reply"))
                assertEquals(url, fixture.state.url)
                for (name in listOf("second-auto", "second-manual")) {
                    fixture.request(name); fixture.advance(80)
                    assertEquals("ok", fixture.outcome(name).getString("status"))
                }
                assertEquals(nonce, fixture.js.latest.getString("nonce"))
                assertTrue(fixture.controller.diagnostics().contains("\"browserUrlMatches\":false"))
                assertFalse(fixture.controller.diagnostics().contains("not-logged"))
                fixture.released()
            }
        }
    }

    @Test(timeout = 20_000) fun delayedOldCancelCannotAbortNewSameDocumentAction() = Boundary().use { fixture ->
        fixture.request("old", "old-signal")
        val delayed = fixture.js.call(JSONObject().put("op", "abort").put("signal", "old-signal")).getJSONArray("messages").getJSONObject(0)
        fixture.advance(80)
        fixture.request("new", "new-signal")
        assertTrue(fixture.controller.isBusy)
        fixture.accept(delayed)
        assertFalse(fixture.replies.last().getJSONObject("payload").getBoolean("cancelled"))
        assertTrue(fixture.controller.isBusy)
        fixture.advance(80)
        assertEquals("ok", fixture.outcome("new").getString("status"))
        assertEquals(listOf(0, 1, 0, 1), fixture.events.map { it.getInt("action") })
        fixture.released()
    }

    @Test(timeout = 20_000) fun abortOfSettledSignalCannotCancelReplacement() = Boundary().use { fixture ->
        fixture.request("old", "old-signal"); fixture.advance(80)
        fixture.request("new", "new-signal")
        assertEquals(0, fixture.command(JSONObject().put("op", "abort").put("signal", "old-signal")).getJSONArray("messages").length())
        assertTrue(fixture.controller.isBusy)
        fixture.advance(80)
        assertEquals("ok", fixture.outcome("new").getString("status"))
        fixture.released()
    }

    @Test(timeout = 20_000) fun abortCurrentActionCancelsDownAndHasOneTerminalOwner() = Boundary().use { fixture ->
        fixture.request("move", "signal")
        fixture.command(JSONObject().put("op", "abort").put("signal", "signal"))
        fixture.advance(100)
        assertEquals(listOf(0, 3), fixture.events.map { it.getInt("action") })
        assertEquals("INPUT_CANCELLED", fixture.outcome("move").getString("code"))
        val error = fixture.replies.first { it.optString("type") == "error" }.getJSONObject("payload").getJSONObject("error")
        assertTrue(error.getBoolean("hadDown"))
        assertEquals("down", error.getString("phase"))
        fixture.released()
    }

    @Test(timeout = 20_000) fun resizeBetweenSerializationAndDownRejectsWithoutReplay() = Boundary().use { fixture ->
        fixture.bind(); fixture.autoInspect = false
        fixture.request("stale")
        fixture.command(JSONObject().put("op", "patch").put("viewport", JSONObject().put("height", 680)))
        fixture.state = fixture.state.copy(height = 1836)
        fixture.completeInspection()
        assertEquals("INPUT_VIEWPORT_CHANGED", fixture.outcome("stale").getString("code"))
        assertTrue(fixture.events.isEmpty())
        fixture.released()
        fixture.autoInspect = true
        fixture.request("explicit-fresh"); fixture.advance(80)
        assertEquals("ok", fixture.outcome("explicit-fresh").getString("status"))
        assertEquals(2, fixture.gestureCount())
        fixture.released()
    }

    @Test(timeout = 20_000) fun changedPositionOrTurnBeforeDownIsRejected() {
        for (change in listOf(JSONObject().put("positionKey", "after-opponent"), JSONObject().put("turn", "b"))) {
            Boundary().use { fixture ->
                fixture.bind(); fixture.autoInspect = false; fixture.request("stale")
                fixture.command(JSONObject().put("op", "patch").put("snapshot", change)); fixture.completeInspection()
                assertEquals("INPUT_POSITION_CHANGED", fixture.outcome("stale").getString("code"))
                assertTrue(fixture.events.isEmpty()); fixture.released()
            }
        }
    }

    @Test(timeout = 20_000) fun boardReplacementTargetMovementAndBlockedTargetAreDistinguished() {
        val cases = listOf(JSONObject().put("boardId", "board-2") to "INPUT_BOARD_REPLACED",
            JSONObject().put("targetRect", JSONObject().put("left", 20).put("top", 0).put("width", 400).put("height", 800)) to "INPUT_TARGET_MOVED",
            JSONObject().put("hit", false) to "INPUT_TARGET_BLOCKED", JSONObject().put("animating", true) to "INPUT_POSITION_ANIMATING")
        for ((change, code) in cases) Boundary().use { fixture ->
            fixture.bind(); fixture.autoInspect = false; fixture.request("stale")
            fixture.command(JSONObject().put("op", "patch").put("snapshot", change)); fixture.completeInspection()
            assertEquals(code, fixture.outcome("stale").getString("code"))
            assertTrue(fixture.events.isEmpty()); fixture.released()
        }
    }

    @Test(timeout = 20_000) fun inspectedOriginAndDocumentTokenRemainStrictDespiteUrlLagAllowance() = Boundary().use { fixture ->
        fixture.bind(); fixture.autoInspect = false; fixture.request("stale")
        fixture.command(JSONObject().put("op", "patch").put("url", "https://example.org/no-input")); fixture.completeInspection()
        assertEquals("INPUT_ORIGIN_CHANGED", fixture.outcome("stale").getString("code"))
        assertTrue(fixture.events.isEmpty()); fixture.released()
    }

    @Test(timeout = 20_000) fun missingLiveProviderFailsBeforeDown() = Boundary().use { fixture ->
        fixture.bind(); fixture.autoInspect = false; fixture.request("stale")
        fixture.command(JSONObject().put("op", "provider").put("enabled", false)); fixture.completeInspection()
        assertEquals("INPUT_SNAPSHOT_UNAVAILABLE", fixture.outcome("stale").getString("code"))
        assertTrue(fixture.events.isEmpty()); fixture.released()
    }

    @Test(timeout = 20_000) fun focusPopupPauseAndNavigationHaveDistinctFailures() {
        val cases = listOf("INPUT_FOCUS_LOST", "INPUT_POPUP_OPEN", "INPUT_APP_PAUSED", "INPUT_NAVIGATING", "INPUT_VIEW_DETACHED", "INPUT_VIEW_HIDDEN")
        for (code in cases) Boundary().use { fixture ->
            fixture.bind()
            fixture.state = when (code) {
                "INPUT_FOCUS_LOST" -> fixture.state.copy(focused = false)
                "INPUT_POPUP_OPEN" -> fixture.state.copy(popup = true)
                "INPUT_APP_PAUSED" -> fixture.state.copy(resumed = false)
                "INPUT_NAVIGATING" -> fixture.state.copy(navigating = true)
                "INPUT_VIEW_DETACHED" -> fixture.state.copy(attached = false)
                else -> fixture.state.copy(shown = false)
            }
            fixture.request("blocked")
            assertEquals(code, fixture.outcome("blocked").getString("code"))
            assertTrue(fixture.events.isEmpty()); fixture.released()
        }
    }

    @Test(timeout = 20_000) fun nativeGeometryChangeAfterDownCancelsAndReleases() = Boundary().use { fixture ->
        fixture.request("move"); fixture.state = fixture.state.copy(width = 1050); fixture.advance(80)
        assertEquals("INPUT_VIEW_RESIZED", fixture.outcome("move").getString("code"))
        assertEquals(listOf(0, 3), fixture.events.map { it.getInt("action") }); fixture.released()
    }

    @Test(timeout = 20_000) fun moderateUiJankNoLongerRejectsOtherwiseCurrentTap() = Boundary().use { fixture ->
        fixture.request("move"); fixture.advance(340, jank = true)
        assertEquals("ok", fixture.outcome("move").getString("status"))
        assertEquals(340, fixture.events.last().getLong("at") - fixture.events.last().getLong("downTime"))
        assertEquals(listOf(0, 1), fixture.events.map { it.getInt("action") }); fixture.released()
    }

    @Test(timeout = 20_000) fun totalDeliveryDeadlineStillCancelsAndNeverReplaysDown() = Boundary().use { fixture ->
        fixture.request("move"); fixture.advance(1600, jank = true)
        assertEquals("INPUT_DELIVERY_LATE", fixture.outcome("move").getString("code"))
        assertEquals(listOf(0, 3), fixture.events.map { it.getInt("action") })
        assertEquals(1, fixture.gestureCount()); fixture.released()
    }

    @Test(timeout = 20_000) fun inspectionTimeoutClearsBusyAndLateCallbackIsInert() = Boundary().use { fixture ->
        fixture.bind(); fixture.autoInspect = false; fixture.request("stale"); fixture.advance(4500)
        assertEquals("INPUT_TIMEOUT", fixture.outcome("stale").getString("code"))
        fixture.released(); fixture.completeInspection(); assertTrue(fixture.events.isEmpty())
        fixture.autoInspect = true; fixture.request("new"); fixture.advance(80)
        assertEquals("ok", fixture.outcome("new").getString("status")); fixture.released()
    }

    @Test(timeout = 20_000) fun dispatchFailuresAndInspectionExceptionsAlwaysRelease() {
        for (action in listOf(0, 1)) for (throws in listOf(false, true)) Boundary().use { fixture ->
            fixture.bind()
            if (throws) fixture.throwAction = action else fixture.rejectAction = action
            fixture.request("move"); fixture.advance(80)
            assertEquals(if (throws) "INPUT_DISPATCH_FAILED" else "INPUT_REJECTED", fixture.outcome("move").getString("code"))
            fixture.released()
        }
        Boundary().use { fixture ->
            fixture.bind(); fixture.throwInspection = true; fixture.request("move")
            assertEquals("INPUT_INSPECTION_FAILED", fixture.outcome("move").getString("code")); fixture.released()
        }
    }

    @Test(timeout = 20_000) fun lostReplyIsTracedAndDoesNotLatchNativeOrReplay() = Boundary().use { fixture ->
        fixture.bind(); fixture.failReply = true; fixture.request("lost"); fixture.advance(80)
        fixture.released(); assertTrue(fixture.controller.diagnostics().contains("delivery-failed"))
        fixture.command(JSONObject().put("op", "advance").put("ms", 5500))
        assertEquals("TIMEOUT", fixture.outcome("lost").getString("code"))
        assertTrue(fixture.outcome("lost").getBoolean("deliveryUnknown"))
        assertEquals(1, fixture.gestureCount())
        fixture.failReply = false; fixture.request("new"); fixture.advance(80)
        assertEquals("ok", fixture.outcome("new").getString("status")); fixture.released()
    }

    @Test(timeout = 20_000) fun globalPauseCancelsCurrentWithoutRotatingDocumentToken() = Boundary().use { fixture ->
        fixture.request("move"); val token = fixture.js.latest.getString("token"); val nonce = fixture.js.latest.getString("nonce")
        fixture.state = fixture.state.copy(resumed = false)
        fixture.controller.cancelCurrent("INPUT_APP_PAUSED", "Activity paused"); fixture.released()
        fixture.state = fixture.state.copy(resumed = true); fixture.request("new"); fixture.advance(80)
        assertEquals("ok", fixture.outcome("new").getString("status"))
        assertEquals(token, fixture.js.latest.getString("token")); assertEquals(nonce, fixture.js.latest.getString("nonce"))
        fixture.released()
    }

    @Test(timeout = 20_000) fun documentReplacementRequiresNewNativeBindingAndRejectsOldCancel() = Boundary().use { fixture ->
        fixture.request("old", "old")
        val old = fixture.requests.last { it.optString("type") == "input.gesture" }
        fixture.controller.invalidateDocument("INPUT_DOCUMENT_CHANGED", "Document replaced")
        fixture.state = fixture.state.copy(generation = 2)
        fixture.command(JSONObject().put("op", "init").put("now", 5000).put("url", fixture.state.url))
        fixture.request("new")
        val current = fixture.requests.last { it.optString("type") == "input.gesture" }
        assertNotEquals(old.getJSONObject("payload").getString("documentToken"), current.getJSONObject("payload").getString("documentToken"))
        assertNotEquals(old.getJSONObject("payload").getString("documentNonce"), current.getJSONObject("payload").getString("documentNonce"))
        val cancel = JSONObject().put("v", 1).put("scope", BridgeProtocol.SCOPE).put("source", "remote").put("target", "NATIVE")
            .put("channel", "input").put("type", "input.cancel").put("id", "old-document-cancel").put("payload", JSONObject()
                .put("requestId", old.getString("id")).put("documentToken", old.getJSONObject("payload").getString("documentToken"))
                .put("documentNonce", old.getJSONObject("payload").getString("documentNonce")))
        fixture.accept(cancel); assertTrue(fixture.controller.isBusy)
        fixture.advance(80); assertEquals("ok", fixture.outcome("new").getString("status")); fixture.released()
    }

    @Test(timeout = 20_000) fun browserAndTouchRateBudgetRemainsSharedAndRecovers() = Boundary().use { fixture ->
        fixture.bind(); repeat(11) { assertTrue(fixture.controller.tryBrowserAction()) }
        fixture.request("last"); fixture.advance(80); assertEquals("ok", fixture.outcome("last").getString("status"))
        fixture.request("limited"); assertEquals("INPUT_RATE_LIMITED", fixture.outcome("limited").getString("code"))
        fixture.released(); fixture.advance(5000); fixture.request("new"); fixture.advance(80)
        assertEquals("ok", fixture.outcome("new").getString("status")); fixture.released()
    }

    @Test(timeout = 20_000) fun traceIsBoundedAndNeverContainsAccountUrlOrPositionText() = Boundary("https://lichess.org/secret-game?password=private-value&cookie=other-value").use { fixture ->
        fixture.command(JSONObject().put("op", "patch").put("snapshot", JSONObject().put("positionKey", "private-position-value")))
        fixture.request("first"); fixture.advance(80)
        repeat(90) { fixture.request("rate-$it"); fixture.advance(80) }
        val diagnostics = fixture.controller.diagnostics()
        assertFalse(diagnostics.contains("private-value")); assertFalse(diagnostics.contains("other-value"))
        assertFalse(diagnostics.contains("secret-game")); assertFalse(diagnostics.contains("private-position-value"))
        assertEquals(NativeInputController.MAX_TRACE_ENTRIES, diagnostics.lines().count { it.startsWith("{") })
        assertTrue(diagnostics.contains("https://lichess.org")); fixture.released()
    }
}
