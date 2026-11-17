package com.chesscoach.app

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class RevisionedStorageRecordTest {
    private fun initial() = RevisionedStorageRecord.decode(JSONObject().put("lichess.autoMoveEnabled", true).put("lichess.premoveEnabled", true).put("chesscom.safeAntiBanGuard", false))

    @Test fun legacyItemsKeepExplicitBooleans() {
        val record = initial()
        assertEquals(0L, record.revision)
        assertTrue(record.items.getBoolean("lichess.premoveEnabled"))
        assertFalse(record.items.getBoolean("chesscom.safeAntiBanGuard"))
    }

    @Test fun transactionOnlyChangesItsKeysAndRoundTripsDurably() {
        val next = initial().patch(0, "preset-1", JSONObject().put("lichess.bulletTurboMode", true), listOf("chesscom.safeAntiBanGuard"), false)
        val restored = RevisionedStorageRecord.decode(next.encode())
        assertEquals(1L, restored.revision)
        assertTrue(restored.items.getBoolean("lichess.premoveEnabled"))
        assertTrue(restored.items.getBoolean("lichess.bulletTurboMode"))
        assertFalse(restored.items.has("chesscom.safeAntiBanGuard"))
    }

    @Test fun staleFullSnapshotCannotReplaceNewerUserIntent() {
        val first = initial().patch(0, "user-1", JSONObject().put("lichess.bulletTurboMode", true), emptyList(), false)
        try {
            first.patch(0, "old-view", JSONObject().put("lichess.premoveEnabled", false), emptyList(), false)
            fail("Expected revision conflict")
        } catch (error: StorageOperationException) { assertEquals("STORAGE_REVISION_CONFLICT", error.code) }
        assertTrue(first.items.getBoolean("lichess.premoveEnabled"))
        assertTrue(first.items.getBoolean("lichess.bulletTurboMode"))
    }

    @Test fun lostReplyRetryDoesNotApplyMutationTwiceEvenAfterAnotherChange() {
        val delta = JSONObject().put("lichess.bulletTurboMode", true)
        val first = initial().patch(0, "user-1", delta, emptyList(), false)
        val second = first.patch(1, "user-2", JSONObject().put("lichess.premoveEnabled", false), emptyList(), false)
        val restored = RevisionedStorageRecord.decode(second.encode())
        val retry = restored.patch(0, "user-1", delta, emptyList(), false)
        assertSame(restored, retry)
        assertEquals(2L, retry.revision)
        assertFalse(retry.items.getBoolean("lichess.premoveEnabled"))
    }

    @Test fun reusedMutationIdCannotChangeItsMeaning() {
        val first = initial().patch(0, "user-1", JSONObject().put("lichess.bulletTurboMode", true), emptyList(), false)
        try {
            first.patch(1, "user-1", JSONObject().put("lichess.bulletTurboMode", false), emptyList(), false)
            fail("Expected reused mutation error")
        } catch (error: StorageOperationException) { assertEquals("STORAGE_MUTATION_REUSED", error.code) }
    }

    @Test fun callerObjectsCannotMutateCommittedItems() {
        val nested = JSONObject().put("value", true)
        val record = initial().patch(0, "nested", JSONObject().put("custom", nested), emptyList(), false)
        nested.put("value", false)
        assertTrue(record.items.getJSONObject("custom").getBoolean("value"))
    }

    @Test fun explicitClearIsOneVersionedOperation() {
        val next = initial().patch(0, "clear-1", JSONObject().put("lichess.premoveEnabled", true), emptyList(), true)
        assertEquals(1, next.items.length())
        assertEquals(1L, next.revision)
    }

    @Test(expected = IllegalArgumentException::class) fun conflictingPatchKeysAreRejected() {
        initial().patch(0, "conflict", JSONObject().put("lichess.premoveEnabled", false), listOf("lichess.premoveEnabled"), false)
    }
}
