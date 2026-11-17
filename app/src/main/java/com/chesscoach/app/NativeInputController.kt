package com.chesscoach.app

import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.security.MessageDigest
import java.util.ArrayDeque
import java.util.UUID
import kotlin.math.abs

/** All methods and host callbacks run on the main thread. One owner releases input. */
internal class NativeInputController(private val host: Host) {
    interface Host {
        fun now(): Long
        fun rateNow(): Long = now()
        fun state(view: Any): ViewState
        fun inspect(view: Any, script: String, callback: (String?) -> Unit)
        fun dispatch(view: Any, action: Int, point: BridgeProtocol.TouchPoint, downTime: Long): Boolean
        fun schedule(runnable: Runnable, at: Long)
        fun remove(runnable: Runnable)
    }

    data class ViewState(
        val generation: Long,
        val main: Boolean,
        val resumed: Boolean,
        val destroyed: Boolean,
        val navigating: Boolean,
        val popup: Boolean,
        val attached: Boolean,
        val shown: Boolean,
        val focused: Boolean,
        val width: Int,
        val height: Int,
        val paddingLeft: Int = 0,
        val paddingTop: Int = 0,
        val paddingRight: Int = 0,
        val paddingBottom: Int = 0,
        val url: String = ""
    )

    private data class Document(
        val view: Any, val generation: Long, val token: String, val nonce: String,
        val origin: String, var href: String, var routeRevision: Long = 0
    )

    private class Pending(
        val id: String, val view: Any, val generation: Long, val origin: String,
        val token: String, val nonce: String?, val gesture: BridgeProtocol.TouchGesture?,
        val reply: (String) -> Unit, val started: Long, var deadline: Long
    ) {
        var phase = "inspect"
        var points = emptyList<BridgeProtocol.TouchPoint>()
        var geometry: ViewState? = null
        var downTime = 0L
        var downSent = false
        var hadDown = false
        var lastPoint = BridgeProtocol.TouchPoint(0.0, 0.0)
        var step: Runnable? = null
        var timeout: Runnable? = null
    }

    private var document: Document? = null
    private var pending: Pending? = null
    private var lastView: Any? = null
    private val touchTimes = ArrayDeque<Long>()
    private val contextTimes = ArrayDeque<Long>()
    private val trace = ArrayDeque<JSONObject>()
    val isBusy: Boolean get() = pending != null
    fun tryBrowserAction(): Boolean = acquire(touchTimes, 12)

    fun handle(message: BridgeProtocol.Message, view: Any, origin: String, reply: (String) -> Unit) {
        lastView = view
        try {
            require(message.envelope.opt("scope") == BridgeProtocol.SCOPE &&
                message.envelope.opt("source") == "remote" && message.envelope.opt("target") == "NATIVE" &&
                message.envelope.opt("channel") == "input") { "Invalid input route" }
            when (message.type) {
                "input.cancel" -> {
                    val cancel = BridgeProtocol.validateTouchCancellation(message.payload)
                    val current = pending
                    val matches = current != null && current.view === view && current.origin == origin &&
                        current.id == cancel.requestId && current.token == cancel.documentToken && current.nonce == cancel.documentNonce
                    if (matches) finish(current!!, "INPUT_CANCELLED", "The input request was cancelled")
                    record(message.id, origin, "cancel", if (matches) "matched" else "not-current", view)
                    send(reply, BridgeProtocol.response(message.id, "input.cancel.response", "input",
                        JSONObject().put("ok", true).put("cancelled", matches).put("requestId", cancel.requestId)), message.id, origin, view)
                }
                "input.context.get", "input.gesture" -> {
                    val gesture = if (message.type == "input.gesture") BridgeProtocol.validateTouchGesture(message.payload) else null
                    val token = gesture?.documentToken ?: BridgeProtocol.validateInputContextRequest(message.payload)
                    if (pending != null) {
                        reject(message.id, origin, view, reply, "INPUT_BUSY", "Another input request is pending", "accept")
                        return
                    }
                    val state = host.state(view)
                    val unavailable = unavailable(state)
                    if (unavailable != null) {
                        reject(message.id, origin, view, reply, unavailable, "The game view is unavailable", "accept")
                        return
                    }
                    if (!acquire(if (gesture == null) contextTimes else touchTimes, if (gesture == null) 4 else 12)) {
                        reject(message.id, origin, view, reply, "INPUT_RATE_LIMITED", "Native input rate exceeded", "accept")
                        return
                    }
                    if (gesture != null) {
                        val binding = document
                        if (binding == null || binding.view !== view || binding.generation != state.generation ||
                            binding.token != token || binding.nonce != gesture.documentNonce || binding.origin != origin) {
                            reject(message.id, origin, view, reply, "INPUT_DOCUMENT_CHANGED", "The native document binding changed", "accept")
                            return
                        }
                    }
                    val current = Pending(message.id, view, state.generation, origin, token, gesture?.documentNonce,
                        gesture, reply, host.now(), host.now() + if (gesture == null) CONTEXT_TIMEOUT_MS else REQUEST_TIMEOUT_MS)
                    pending = current
                    armTimeout(current)
                    record(current.id, origin, current.phase, "accepted", view)
                    inspect(current)
                }
                else -> reject(message.id, origin, view, reply, "UNSUPPORTED_TYPE", "Unsupported input request", "accept")
            }
        } catch (_: Exception) {
            reject(message.id, origin, view, reply, "INPUT_INVALID", "Invalid input payload", "validate")
        }
    }

    fun cancelCurrent(code: String, message: String) {
        pending?.let { finish(it, code, message) }
    }

    fun invalidateDocument(code: String, message: String) {
        cancelCurrent(code, message)
        document = null
    }

    private fun inspect(current: Pending) {
        try {
            host.inspect(current.view, snapshotScript(current.gesture?.points ?: emptyList(), current.gesture?.targetId)) { raw ->
                if (pending !== current) return@inspect
                try {
                    val state = host.state(current.view)
                    val unavailable = unavailable(state, current)
                    if (unavailable != null) {
                        finish(current, unavailable, "The input view changed during inspection")
                        return@inspect
                    }
                    if (host.now() >= current.deadline) {
                        finish(current, "INPUT_DELIVERY_LATE", "Input inspection exceeded its deadline")
                        return@inspect
                    }
                    val actual = JSONObject(raw ?: "null")
                    if (actual.opt("visible") != true) {
                        finish(current, "INPUT_DOCUMENT_HIDDEN", "The game document is hidden")
                        return@inspect
                    }
                    val href = actual.optString("href")
                    if (actual.opt("origin") != current.origin || trustedOrigin(href) != current.origin) {
                        finish(current, "INPUT_ORIGIN_CHANGED", "The inspected document origin changed")
                        return@inspect
                    }
                    if (actual.opt("documentToken") != current.token) {
                        finish(current, "INPUT_DOCUMENT_CHANGED", "The inspected document token changed")
                        return@inspect
                    }
                    record(current.id, current.origin, "inspect", "snapshot", current.view,
                        JSONObject().put("elapsedMs", host.now() - current.started).put("browserUrlMatches", state.url == href))
                    val gesture = current.gesture
                    if (gesture == null) {
                        val old = document
                        val binding = if (old != null && old.view === current.view && old.generation == current.generation &&
                            old.token == current.token && old.origin == current.origin) old else
                            Document(current.view, current.generation, current.token, UUID.randomUUID().toString(), current.origin, href)
                        if (!actual.isNull("documentNonce") && old === binding && actual.opt("documentNonce") != binding.nonce) {
                            finish(current, "INPUT_DOCUMENT_CHANGED", "The inspected native nonce changed")
                            return@inspect
                        }
                        updateRoute(binding, href)
                        document = binding
                        finish(current, payload = JSONObject().put("ok", true).put("documentToken", binding.token)
                            .put("documentNonce", binding.nonce).put("documentGeneration", binding.generation).put("origin", binding.origin))
                        return@inspect
                    }
                    if (actual.opt("documentNonce") != gesture.documentNonce) {
                        finish(current, "INPUT_DOCUMENT_CHANGED", "The inspected native nonce changed")
                        return@inspect
                    }
                    if (actual.opt("snapshotError") == true || actual.optJSONObject("snapshot") == null) {
                        finish(current, "INPUT_SNAPSHOT_UNAVAILABLE", "The mobile core snapshot is unavailable")
                        return@inspect
                    }
                    val snapshot = BridgeProtocol.validateInputSnapshot(actual.getJSONObject("snapshot"))
                    val mismatch = compareSnapshots(gesture.snapshot, snapshot)
                    if (mismatch != null) {
                        finish(current, mismatch, "The board position or input target changed")
                        return@inspect
                    }
                    val viewport = BridgeProtocol.validateTouchViewport(actual.getJSONObject("viewport"))
                    if (!sameViewport(gesture.viewport, viewport)) {
                        finish(current, "INPUT_VIEWPORT_CHANGED", "The visual viewport changed before touch down")
                        return@inspect
                    }
                    current.points = try {
                        BridgeProtocol.mapTouchPoints(gesture, viewport, state.width - state.paddingLeft - state.paddingRight,
                            state.height - state.paddingTop - state.paddingBottom).map {
                            BridgeProtocol.TouchPoint(it.x + state.paddingLeft, it.y + state.paddingTop)
                        }
                    } catch (_: Exception) {
                        finish(current, "INPUT_VIEW_BOUNDS", "The input point is outside the current WebView")
                        return@inspect
                    }
                    if (host.now() + gesture.durationMs >= current.deadline) {
                        finish(current, "INPUT_DELIVERY_LATE", "There is no safe time remaining for input")
                        return@inspect
                    }
                    updateRoute(document!!, href)
                    current.geometry = state
                    current.downTime = host.now()
                    current.deadline = minOf(current.deadline, current.downTime + DELIVERY_TIMEOUT_MS)
                    armTimeout(current)
                    current.phase = "down"
                    current.downSent = true
                    current.hadDown = true
                    val delivered = try { dispatch(current, ACTION_DOWN, current.points.first()) }
                    catch (_: Exception) {
                        finish(current, "INPUT_DISPATCH_FAILED", "Native touch down dispatch failed")
                        return@inspect
                    }
                    if (!delivered) {
                        finish(current, "INPUT_REJECTED", "WebView rejected touch down")
                        return@inspect
                    }
                    scheduleStep(current, 1)
                } catch (_: Exception) {
                    finish(current, "INPUT_SNAPSHOT_INVALID", "The inspected input snapshot is invalid")
                }
            }
        } catch (_: Exception) {
            finish(current, "INPUT_INSPECTION_FAILED", "Could not inspect the game document")
        }
    }

    private fun scheduleStep(current: Pending, index: Int) {
        val gesture = current.gesture ?: return
        val moving = gesture.action == "drag" && index < current.points.size
        val elapsed = if (moving) gesture.durationMs.toLong() * index / current.points.size else gesture.durationMs.toLong()
        val step = Runnable {
            if (pending !== current) return@Runnable
            val unavailable = unavailable(host.state(current.view), current)
            if (unavailable != null || host.now() >= current.deadline) {
                finish(current, unavailable ?: "INPUT_DELIVERY_LATE", "Native input became unavailable or exceeded its deadline")
                return@Runnable
            }
            current.phase = if (moving) "move" else "up"
            try {
                if (!dispatch(current, if (moving) ACTION_MOVE else ACTION_UP, if (moving) current.points[index] else current.points.last())) {
                    finish(current, "INPUT_REJECTED", "WebView rejected native input")
                } else if (moving) scheduleStep(current, index + 1)
                else {
                    current.downSent = false
                    finish(current, payload = JSONObject().put("ok", true).put("dispatched", true).put("action", gesture.action))
                }
            } catch (_: Exception) {
                finish(current, "INPUT_DISPATCH_FAILED", "Native input dispatch failed")
            }
        }
        current.step = step
        host.schedule(step, current.downTime + elapsed)
    }

    private fun dispatch(current: Pending, action: Int, point: BridgeProtocol.TouchPoint): Boolean {
        current.lastPoint = point
        record(current.id, current.origin, current.phase, "dispatch", current.view,
            JSONObject().put("elapsedMs", host.now() - current.started).put("downElapsedMs", host.now() - current.downTime))
        return host.dispatch(current.view, action, point, current.downTime)
    }

    private fun armTimeout(current: Pending) {
        current.timeout?.let(host::remove)
        current.timeout = Runnable {
            if (pending === current) finish(current, if (current.hadDown) "INPUT_DELIVERY_LATE" else "INPUT_TIMEOUT", "Native input deadline expired")
        }.also { host.schedule(it, current.deadline) }
    }

    // The only terminal path. Clear ownership before callbacks or a best-effort CANCEL.
    private fun finish(current: Pending, code: String? = null, message: String = "", payload: JSONObject? = null) {
        if (pending !== current) return
        pending = null
        current.step?.let(host::remove)
        current.timeout?.let(host::remove)
        if (current.downSent) {
            current.downSent = false
            try { host.dispatch(current.view, ACTION_CANCEL, current.lastPoint, current.downTime) } catch (_: Exception) {}
        }
        record(current.id, current.origin, current.phase, code ?: "completed", current.view,
            JSONObject().put("elapsedMs", host.now() - current.started).put("hadDown", current.hadDown))
        val response = if (code == null) BridgeProtocol.response(current.id,
            if (current.gesture == null) "input.context.response" else "input.gesture.response", "input", payload!!)
        else error(current.id, code, message, current.phase, host.now() - current.started, current.hadDown)
        send(current.reply, response, current.id, current.origin, current.view)
    }

    private fun reject(id: String, origin: String, view: Any, reply: (String) -> Unit, code: String, message: String, phase: String) {
        record(id, origin, phase, code, view)
        send(reply, error(id, code, message, phase, 0, false), id, origin, view)
    }

    private fun error(id: String, code: String, message: String, phase: String, elapsed: Long, hadDown: Boolean): String =
        BridgeProtocol.response(id, "error", "native", JSONObject().put("ok", false).put("error", JSONObject()
            .put("code", code).put("message", message).put("phase", phase).put("elapsedMs", elapsed).put("hadDown", hadDown)))

    private fun send(reply: (String) -> Unit, response: String, id: String, origin: String, view: Any) {
        try { reply(response) } catch (_: Exception) { record(id, origin, "reply", "delivery-failed", view) }
    }

    private fun unavailable(state: ViewState, current: Pending? = null): String? = when {
        state.destroyed || !state.main -> "INPUT_VIEW_REPLACED"
        !state.resumed -> "INPUT_APP_PAUSED"
        state.navigating -> "INPUT_NAVIGATING"
        current != null && state.generation != current.generation -> "INPUT_DOCUMENT_CHANGED"
        state.popup -> "INPUT_POPUP_OPEN"
        !state.attached -> "INPUT_VIEW_DETACHED"
        !state.shown -> "INPUT_VIEW_HIDDEN"
        !state.focused -> "INPUT_FOCUS_LOST"
        state.width <= 0 || state.height <= 0 -> "INPUT_VIEW_BOUNDS"
        current?.geometry != null && !sameGeometry(current.geometry!!, state) -> "INPUT_VIEW_RESIZED"
        else -> null
    }

    private fun sameGeometry(a: ViewState, b: ViewState): Boolean = a.width == b.width && a.height == b.height &&
        a.paddingLeft == b.paddingLeft && a.paddingRight == b.paddingRight && a.paddingTop == b.paddingTop && a.paddingBottom == b.paddingBottom

    private fun compareSnapshots(expected: BridgeProtocol.InputSnapshot, actual: BridgeProtocol.InputSnapshot): String? = when {
        actual.boardId != expected.boardId -> "INPUT_BOARD_REPLACED"
        actual.positionKey != expected.positionKey || actual.orientation != expected.orientation ||
            actual.myColor != expected.myColor || actual.turn != expected.turn -> "INPUT_POSITION_CHANGED"
        actual.targetId != expected.targetId || !actual.hit || !expected.hit -> "INPUT_TARGET_BLOCKED"
        actual.animating || expected.animating -> "INPUT_POSITION_ANIMATING"
        !sameRect(actual.boardRect, expected.boardRect) || !sameRect(actual.targetRect, expected.targetRect) -> "INPUT_TARGET_MOVED"
        else -> null
    }

    private fun sameRect(a: BridgeProtocol.InputRect, b: BridgeProtocol.InputRect): Boolean =
        abs(a.left - b.left) <= 2 && abs(a.top - b.top) <= 2 && abs(a.width - b.width) <= 2 && abs(a.height - b.height) <= 2

    private fun sameViewport(a: BridgeProtocol.TouchViewport, b: BridgeProtocol.TouchViewport): Boolean =
        abs(a.width - b.width) <= 2 && abs(a.height - b.height) <= 2 && abs(a.offsetLeft - b.offsetLeft) <= 2 && abs(a.offsetTop - b.offsetTop) <= 2

    private fun updateRoute(binding: Document, href: String) {
        if (binding.href != href) { binding.href = href; binding.routeRevision++ }
    }

    private fun acquire(times: ArrayDeque<Long>, capacity: Int): Boolean {
        while (times.isNotEmpty() && host.rateNow() - times.first >= 5_000) times.removeFirst()
        if (times.size >= capacity) return false
        times.addLast(host.rateNow())
        return true
    }

    private fun record(id: String, origin: String, phase: String, result: String, view: Any, details: JSONObject = JSONObject()) {
        val state = host.state(view)
        val correlation = MessageDigest.getInstance("SHA-256").digest(id.toByteArray(Charsets.UTF_8)).take(6).joinToString("") { "%02x".format(it) }
        details.put("ms", host.now()).put("request", correlation).put("origin", trustedOrigin(origin) ?: "untrusted")
            .put("phase", phase).put("result", result).put("generation", state.generation).put("route", document?.routeRevision ?: 0)
            .put("main", state.main).put("resumed", state.resumed).put("navigating", state.navigating).put("popup", state.popup)
            .put("attached", state.attached).put("shown", state.shown).put("focus", state.focused).put("width", state.width).put("height", state.height)
        if (trace.size == MAX_TRACE_ENTRIES) trace.removeFirst()
        trace.addLast(details)
    }

    fun diagnostics(): String {
        val state = lastView?.let(host::state)
        return buildString {
            append("Native input v2\nPending: ").append(pending?.phase ?: "idle")
            append("\nDocument: ").append(document?.generation ?: "unbound")
            append(" / route: ").append(document?.routeRevision ?: 0)
            if (state != null) append("\nResumed: ").append(state.resumed).append(" Focus: ").append(state.focused)
                .append(" Popup: ").append(state.popup).append(" Navigating: ").append(state.navigating)
            append("\nLocal trace only; no account URLs, cookies or position text.\n\n")
            trace.forEach { append(it.toString()).append('\n') }
        }
    }

    companion object {
        const val ACTION_DOWN = 0
        const val ACTION_UP = 1
        const val ACTION_MOVE = 2
        const val ACTION_CANCEL = 3
        const val CONTEXT_TIMEOUT_MS = 3_000L
        const val REQUEST_TIMEOUT_MS = 4_500L
        const val DELIVERY_TIMEOUT_MS = 1_500L
        const val MAX_TRACE_ENTRIES = 80

        fun snapshotScript(points: List<BridgeProtocol.TouchPoint>, targetId: String?): String {
            val request = JSONObject().put("points", JSONArray(points.map { JSONObject().put("x", it.x).put("y", it.y) }))
                .put("targetId", targetId ?: JSONObject.NULL).toString()
            return """
                (function() {
                  const runtime = window.__CC_ANDROID_RUNTIME__;
                  const viewport = window.visualViewport;
                  let snapshot = null, snapshotError = false;
                  if (${targetId != null}) {
                    try { snapshot = runtime.captureInputSnapshot($request); }
                    catch (_) { snapshotError = true; }
                  }
                  return {
                    href: String(location.href), origin: String(location.origin),
                    visible: document.visibilityState === "visible" && window === window.top,
                    documentToken: runtime && runtime.inputDocumentToken,
                    documentNonce: runtime && runtime.inputDocumentNonce || null,
                    viewport: {
                      width: viewport ? viewport.width : window.innerWidth,
                      height: viewport ? viewport.height : window.innerHeight,
                      offsetLeft: viewport ? viewport.offsetLeft : 0,
                      offsetTop: viewport ? viewport.offsetTop : 0
                    },
                    snapshot: snapshot, snapshotError: snapshotError
                  };
                })();
            """.trimIndent()
        }

        private fun trustedOrigin(text: String): String? = try {
            val uri = URI(text)
            val host = uri.host?.lowercase()
            if (uri.isOpaque || !uri.scheme.equals("https", true) || uri.rawUserInfo != null ||
                (uri.port != -1 && uri.port != 443) || host !in setOf("lichess.org", "www.chess.com") ||
                uri.rawAuthority?.lowercase() !in setOf(host, "$host:443")) null else "https://$host"
        } catch (_: Exception) { null }
    }
}
