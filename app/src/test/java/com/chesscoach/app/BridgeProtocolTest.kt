package com.chesscoach.app

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class BridgeProtocolTest {
    @Test
    fun parsesValidRuntimeEnvelope() {
        val raw = JSONObject()
            .put("v", BridgeProtocol.VERSION)
            .put("scope", BridgeProtocol.SCOPE)
            .put("source", "remote")
            .put("target", "ENGINE")
            .put("channel", "runtime")
            .put("id", "request-1")
            .put("type", "runtime.message")
            .put("payload", JSONObject().put("message", JSONObject().put("type", "ENGINE_STATUS")))
            .toString()

        val parsed = BridgeProtocol.parse(raw)

        assertEquals("request-1", parsed.id)
        assertEquals("runtime.message", parsed.type)
    }

    @Test
    fun rejectsPrototypeKeysAtAnyDepth() {
        val raw = JSONObject()
            .put("v", BridgeProtocol.VERSION)
            .put("id", "request-2")
            .put("type", "runtime.message")
            .put("payload", JSONObject().put("message", JSONObject().put("__proto__", JSONObject())))
            .toString()

        assertThrows(IllegalArgumentException::class.java) {
            BridgeProtocol.parse(raw)
        }
    }

    @Test
    fun acceptsBoundedExperienceDatabase() {
        val database = JSONObject()
        repeat(2500) { index ->
            database.put("fen-$index", JSONObject().put("e2e4", JSONObject().put("games", 1)))
        }
        val raw = JSONObject()
            .put("v", BridgeProtocol.VERSION)
            .put("id", "request-3")
            .put("type", "runtime.response")
            .put("payload", JSONObject().put("response", JSONObject().put("database", database)))
            .toString()

        val parsed = BridgeProtocol.parse(raw)

        assertEquals(2500, parsed.payload.getJSONObject("response").getJSONObject("database").length())
    }

    @Test
    fun rejectsObjectBeyondFieldBudget() {
        val oversized = JSONObject()
        repeat(4097) { index -> oversized.put("key-$index", index) }
        val raw = JSONObject()
            .put("v", BridgeProtocol.VERSION)
            .put("id", "request-4")
            .put("type", "runtime.response")
            .put("payload", oversized)
            .toString()

        assertThrows(IllegalArgumentException::class.java) {
            BridgeProtocol.parse(raw)
        }
    }

    @Test
    fun acceptsValidTapEnvelope() {
        val raw = JSONObject()
            .put("v", BridgeProtocol.VERSION)
            .put("scope", BridgeProtocol.SCOPE)
            .put("source", "remote")
            .put("target", "NATIVE")
            .put("channel", "input")
            .put("id", "touch-1")
            .put("type", "input.gesture")
            .put("payload", touchPayload())
            .toString()

        val gesture = BridgeProtocol.validateTouchGesture(BridgeProtocol.parse(raw).payload)

        assertEquals("tap", gesture.action)
        assertEquals(80, gesture.durationMs)
        assertEquals(listOf(BridgeProtocol.TouchPoint(100.0, 200.0)), gesture.points)
    }

    @Test
    fun acceptsBoundedDrag() {
        val points = JSONArray()
        repeat(BridgeProtocol.MAX_TOUCH_POINTS) { index -> points.put(point(20 + index * 10, 100)) }
        val payload = touchPayload()
            .put("action", "drag")
            .put("durationMs", BridgeProtocol.MAX_TOUCH_DURATION_MS)
            .put("points", points)

        val gesture = BridgeProtocol.validateTouchGesture(payload)

        assertEquals(BridgeProtocol.MAX_TOUCH_POINTS, gesture.points.size)
        assertEquals("drag", gesture.action)
    }

    @Test
    fun mapsVisualViewportOffsetsToLocalPixelsWithoutDensityAssumptions() {
        val payload = touchPayload()
            .put("viewport", viewport().put("offsetLeft", 100).put("offsetTop", 50))
            .put("points", JSONArray().put(point(300, 450)))
        val gesture = BridgeProtocol.validateTouchGesture(payload)

        val mapped = BridgeProtocol.mapTouchPoints(gesture, gesture.viewport, 1080, 1920).single()

        assertEquals(540.0, mapped.x, 0.0001)
        assertEquals(1080.0, mapped.y, 0.0001)
    }

    @Test
    fun keyboardReducedViewportDoesNotStretchVerticalCoordinates() {
        val payload = touchPayload()
            .put("viewport", viewport().put("height", 500))
            .put("points", JSONArray().put(point(100, 300)))
        val gesture = BridgeProtocol.validateTouchGesture(payload)

        val mapped = BridgeProtocol.mapTouchPoints(gesture, gesture.viewport, 1080, 2160).single()

        assertEquals(270.0, mapped.x, 0.0001)
        assertEquals(810.0, mapped.y, 0.0001)
    }

    @Test
    fun landscapeCoordinatesUseTheSameScaleForBothAxes() {
        val payload = touchPayload()
            .put("viewport", viewport().put("width", 800).put("height", 360))
            .put("points", JSONArray().put(point(400, 180)))
        val gesture = BridgeProtocol.validateTouchGesture(payload)

        val mapped = BridgeProtocol.mapTouchPoints(gesture, gesture.viewport, 1600, 720).single()

        assertEquals(800.0, mapped.x, 0.0001)
        assertEquals(360.0, mapped.y, 0.0001)
    }

    @Test
    fun rejectsPointsProjectingOutsideActualViewBounds() {
        val gesture = BridgeProtocol.validateTouchGesture(
            touchPayload().put("points", JSONArray().put(point(100, 700)))
        )

        assertThrows(IllegalArgumentException::class.java) {
            BridgeProtocol.mapTouchPoints(gesture, gesture.viewport, 1080, 1000)
        }
    }

    @Test
    fun rejectsChangedActualViewport() {
        val gesture = BridgeProtocol.validateTouchGesture(touchPayload())

        assertThrows(IllegalArgumentException::class.java) {
            BridgeProtocol.mapTouchPoints(gesture, gesture.viewport.copy(width = 390.0), 1080, 1920)
        }
        assertThrows(IllegalArgumentException::class.java) {
            BridgeProtocol.mapTouchPoints(gesture, gesture.viewport, 0, 1920)
        }
    }

    @Test
    fun rejectsInvalidActionAndMalformedPoints() {
        for (action in listOf("click", "down", "TAP", "")) {
            assertThrows(IllegalArgumentException::class.java) {
                BridgeProtocol.validateTouchGesture(touchPayload().put("action", action))
            }
        }
        for (points in listOf(JSONArray(), JSONArray().put(3), JSONArray().put(point(1, 1)).put(point(2, 2)))) {
            assertThrows(IllegalArgumentException::class.java) {
                BridgeProtocol.validateTouchGesture(touchPayload().put("points", points))
            }
        }
    }

    @Test
    fun rejectsNonFiniteAndNonNumericCoordinates() {
        for (rawPoint in listOf(
            "{\"x\":NaN,\"y\":1}", "{\"x\":Infinity,\"y\":1}",
            "{\"x\":\"12\",\"y\":1}", "{\"x\":null,\"y\":1}", "{\"x\":1,\"y\":true}"
        )) {
            assertThrows(IllegalArgumentException::class.java) {
                BridgeProtocol.validateTouchGesture(touchPayload().put("points", JSONArray().put(JSONObject(rawPoint))))
            }
        }
    }

    @Test
    fun rejectsCoordinatesOutsideVisibleViewport() {
        for (invalid in listOf(point(-1, 1), point(400, 1), point(1, -1), point(1, 800))) {
            assertThrows(IllegalArgumentException::class.java) {
                BridgeProtocol.validateTouchGesture(touchPayload().put("points", JSONArray().put(invalid)))
            }
        }
        assertThrows(IllegalArgumentException::class.java) {
            BridgeProtocol.validateTouchGesture(touchPayload().put("viewport", viewport().put("offsetLeft", 101)))
        }
    }

    @Test
    fun rejectsExcessPointsZeroLengthDragAndDurationLimits() {
        val excess = JSONArray()
        repeat(BridgeProtocol.MAX_TOUCH_POINTS + 1) { index -> excess.put(point(10 + index, 100)) }
        for (points in listOf(excess, JSONArray().put(point(1, 1)), JSONArray().put(point(1, 1)).put(point(1, 1)))) {
            assertThrows(IllegalArgumentException::class.java) {
                BridgeProtocol.validateTouchGesture(touchPayload().put("action", "drag").put("points", points))
            }
        }
        for (duration in listOf(-1, 0, 39, 201, 801, 80.5, "80")) {
            assertThrows(IllegalArgumentException::class.java) {
                BridgeProtocol.validateTouchGesture(touchPayload().put("durationMs", duration))
            }
        }
        assertThrows(IllegalArgumentException::class.java) {
            BridgeProtocol.validateTouchGesture(
                touchPayload().put("action", "drag").put("durationMs", 801)
                    .put("points", JSONArray().put(point(1, 1)).put(point(2, 2)))
            )
        }
    }

    @Test
    fun rejectsInvalidViewportDocumentTokenAndUnexpectedFields() {
        for (invalidViewport in listOf(
            viewport().put("width", 0), viewport().put("height", 16385),
            viewport().put("offsetTop", -1), viewport().put("offsetLeft", "0"), viewport().put("scale", 1)
        )) {
            assertThrows(IllegalArgumentException::class.java) {
                BridgeProtocol.validateTouchGesture(touchPayload().put("viewport", invalidViewport))
            }
        }
        for (payload in listOf(
            touchPayload().put("documentToken", "bad token"), touchPayload().put("documentToken", JSONObject.NULL),
            touchPayload().put("extra", true),
            touchPayload().put("points", JSONArray().put(point(1, 1).put("time", 1)))
        )) {
            assertThrows(IllegalArgumentException::class.java) { BridgeProtocol.validateTouchGesture(payload) }
        }
    }

    private fun touchPayload(): JSONObject = JSONObject()
        .put("action", "tap")
        .put("durationMs", 80)
        .put("points", JSONArray().put(point(100, 200)))
        .put("viewport", viewport())
        .put("documentToken", "input-doc-test")
        .put("documentNonce", "native-doc-nonce")
        .put("targetId", "board-target")
        .put("snapshot", JSONObject().put("v", 1).put("boardId", "board-1").put("positionKey", "position-1")
            .put("orientation", "white").put("myColor", "w").put("turn", "w")
            .put("boardRect", inputRect()).put("targetId", "board-target").put("targetRect", inputRect())
            .put("hit", true).put("animating", false))

    @Test fun cancellationRequiresAnOriginalRequestIdAndNativeNonceForGestures() {
        assertThrows(IllegalArgumentException::class.java) {
            BridgeProtocol.validateTouchCancellation(JSONObject().put("documentToken", "input-doc-test"))
        }
        val cancel = BridgeProtocol.validateTouchCancellation(JSONObject().put("requestId", "gesture-old")
            .put("documentToken", "input-doc-test").put("documentNonce", "native-doc-nonce"))
        assertEquals("gesture-old", cancel.requestId)
        assertEquals("native-doc-nonce", cancel.documentNonce)
    }

    @Test fun rejectsMissingNativeBindingAndMalformedCoreSnapshot() {
        for (payload in listOf(touchPayload().put("documentNonce", JSONObject.NULL),
            touchPayload().put("snapshot", JSONObject.NULL),
            touchPayload().put("targetId", "different-target"))) {
            assertThrows(IllegalArgumentException::class.java) { BridgeProtocol.validateTouchGesture(payload) }
        }
        val invalid = touchPayload()
        invalid.getJSONObject("snapshot").put("hit", "true")
        assertThrows(IllegalArgumentException::class.java) { BridgeProtocol.validateTouchGesture(invalid) }
    }

    private fun inputRect(): JSONObject = JSONObject().put("left", 0).put("top", 0).put("width", 400).put("height", 800)

    private fun viewport(): JSONObject = JSONObject()
        .put("width", 400).put("height", 800).put("offsetLeft", 0).put("offsetTop", 0)

    private fun point(x: Int, y: Int): JSONObject = JSONObject().put("x", x).put("y", y)
}
