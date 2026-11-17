package com.chesscoach.app

import org.json.JSONArray
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.security.MessageDigest

internal class StorageOperationException(val code: String, message: String) : IllegalArgumentException(message)

internal class RevisionedStorageRecord private constructor(
    val items: JSONObject,
    val revision: Long,
    private val mutations: JSONArray
) {
    fun response(): JSONObject = JSONObject().put("ok", true)
        .put("items", JSONObject(items.toString())).put("revision", revision)

    fun encode(): JSONObject = JSONObject().put("_format", FORMAT).put("revision", revision)
        .put("items", JSONObject(items.toString())).put("mutations", JSONArray(mutations.toString()))

    fun replacing(next: JSONObject): RevisionedStorageRecord {
        require(revision < MAX_REVISION) { "Storage revision exhausted" }
        return RevisionedStorageRecord(JSONObject(next.toString()), revision + 1, JSONArray(mutations.toString()))
    }

    fun patch(baseRevision: Long, mutationId: String, delta: JSONObject, removed: List<String>, clear: Boolean): RevisionedStorageRecord {
        require(baseRevision in 0..MAX_REVISION) { "Invalid base revision" }
        require(MUTATION_ID.matches(mutationId)) { "Invalid mutation id" }
        require(removed.toSet().size == removed.size && removed.none(delta::has)) { "Conflicting storage mutation keys" }
        val operation = JSONObject().put("items", delta).put("keys", JSONArray(removed.sorted())).put("clear", clear)
        val digest = MessageDigest.getInstance("SHA-256").digest(canonical(operation).toByteArray(StandardCharsets.UTF_8))
            .joinToString("") { "%02x".format(it.toInt() and 0xff) }
        for (index in 0 until mutations.length()) {
            val previous = mutations.getJSONObject(index)
            if (previous.getString("id") != mutationId) continue
            if (previous.getString("digest") != digest) throw StorageOperationException("STORAGE_MUTATION_REUSED", "Mutation id already belongs to another change")
            return this
        }
        if (baseRevision != revision) throw StorageOperationException("STORAGE_REVISION_CONFLICT", "Storage changed; refresh and rebase the explicit delta")
        val next = if (clear) JSONObject() else JSONObject(items.toString())
        removed.forEach(next::remove)
        delta.keys().forEach { key -> next.put(key, delta.get(key)) }
        val result = replacing(next)
        val history = JSONArray()
        for (index in maxOf(0, mutations.length() - HISTORY_LIMIT + 1) until mutations.length()) history.put(mutations.get(index))
        history.put(JSONObject().put("id", mutationId).put("digest", digest).put("revision", result.revision))
        return RevisionedStorageRecord(result.items, result.revision, history)
    }

    companion object {
        private const val FORMAT = "chesscoach.storage.v2"
        private const val HISTORY_LIMIT = 32
        private const val MAX_REVISION = 9_007_199_254_740_991L
        private val MUTATION_ID = Regex("[A-Za-z0-9._:-]{1,128}")

        fun decode(value: JSONObject): RevisionedStorageRecord {
            if (value.optString("_format") != FORMAT) return RevisionedStorageRecord(JSONObject(value.toString()), 0L, JSONArray())
            val number = value.get("revision") as? Number ?: throw IllegalArgumentException("Invalid storage revision")
            val revision = number.toLong()
            require(revision in 0..MAX_REVISION && revision.toDouble() == number.toDouble()) { "Invalid storage revision" }
            val history = value.getJSONArray("mutations")
            require(history.length() <= HISTORY_LIMIT) { "Storage mutation history exceeds limit" }
            for (index in 0 until history.length()) {
                val mutation = history.getJSONObject(index)
                require(MUTATION_ID.matches(mutation.getString("id")) && Regex("[0-9a-f]{64}").matches(mutation.getString("digest"))) { "Invalid mutation history" }
                require(mutation.getLong("revision") in 1..revision) { "Invalid mutation revision" }
            }
            return RevisionedStorageRecord(JSONObject(value.getJSONObject("items").toString()), revision, JSONArray(history.toString()))
        }

        private fun canonical(value: Any?): String = when (value) {
            is JSONObject -> value.keys().asSequence().toList().sorted().joinToString(",", "{", "}") { "${JSONObject.quote(it)}:${canonical(value.get(it))}" }
            is JSONArray -> (0 until value.length()).joinToString(",", "[", "]") { canonical(value.get(it)) }
            is String -> JSONObject.quote(value)
            null, JSONObject.NULL -> "null"
            else -> value.toString()
        }
    }
}
