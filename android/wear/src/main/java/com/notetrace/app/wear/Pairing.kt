package com.notetrace.app.wear

import android.content.Context
import android.content.SharedPreferences
import android.net.Uri
import android.util.Log
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.tasks.await
import org.json.JSONObject

/**
 * What the watch needs to reach the server, and the last lists it saw.
 *
 * The phone sends the address and a token once over the Wearable Data Layer
 * (PairingService picks them up). Nothing here is asked of the wearer: there is
 * no keyboard worth typing a server address on.
 *
 * The cache is what makes the watch usable in a shop with no signal: whatever
 * was last loaded is drawn immediately, and a tick made offline waits in the
 * outbox until the server can be reached.
 */
object Pairing {

    data class Config(val serverUrl: String, val token: String)

    private const val TAG = "NoteTraceWear"
    private const val PREFS = "notetrace.wear"
    private const val KEY_URL = "server_url"
    private const val KEY_TOKEN = "token"
    private const val KEY_CACHE = "cache"
    private const val KEY_CACHE_AT = "cache_at"
    private const val KEY_OUTBOX = "outbox"

    private fun prefs(ctx: Context): SharedPreferences =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** The saved link, or null when the phone hasn't paired yet. */
    fun config(ctx: Context): Config? {
        val p = prefs(ctx)
        val url = p.getString(KEY_URL, null)?.takeIf { it.isNotBlank() }
        val token = p.getString(KEY_TOKEN, null)?.takeIf { it.isNotBlank() }
        return if (url != null && token != null) Config(url, token) else null
    }

    /**
     * Read whatever the phone has already published, rather than only waiting
     * for onDataChanged. A listener only fires on a change, so an app opened
     * after the phone published would sit there saying "pair from your phone"
     * with the pairing sitting right there unread.
     */
    suspend fun pullFromPhone(ctx: Context): Config? {
        val existing = config(ctx)
        return try {
            // Everything the phone has published, filtered here: a URI query
            // needs an authority to match, and "any node" is easy to get wrong.
            val items = Wearable.getDataClient(ctx).getDataItems().await()
            Log.i(TAG, "data items: " + items.count)
            var found: Config? = null
            for (item in items) {
                val path = item.uri.path.orEmpty()
                Log.i(TAG, "item: " + path)
                if (!path.startsWith(PairingService.PATH)) continue
                val map = DataMapItem.fromDataItem(item).dataMap
                val url = map.getString("serverUrl").orEmpty()
                val token = map.getString("token").orEmpty()
                if (url.isNotBlank() && token.isNotBlank()) {
                    save(ctx, url, token)
                    found = Config(url.trimEnd('/'), token)
                }
            }
            items.release()
            found ?: existing
        } catch (e: Exception) {
            Log.w(TAG, "couldn't read the pairing: " + e.message)
            existing
        }
    }

    fun save(ctx: Context, serverUrl: String, token: String) {
        prefs(ctx).edit()
            .putString(KEY_URL, serverUrl.trim().trimEnd('/'))
            .putString(KEY_TOKEN, token.trim())
            .apply()
    }

    /** The phone says the account signed out, or the watch was unpaired. */
    fun clear(ctx: Context) {
        prefs(ctx).edit().remove(KEY_URL).remove(KEY_TOKEN).remove(KEY_CACHE).remove(KEY_OUTBOX).apply()
    }

    // ── The last lists the watch saw ─────────────────────────────────────

    fun cache(ctx: Context): JSONObject? =
        prefs(ctx).getString(KEY_CACHE, null)?.let { runCatching { JSONObject(it) }.getOrNull() }

    fun cachedAt(ctx: Context): Long = prefs(ctx).getLong(KEY_CACHE_AT, 0L)

    fun putCache(ctx: Context, snapshot: JSONObject) {
        prefs(ctx).edit()
            .putString(KEY_CACHE, snapshot.toString())
            .putLong(KEY_CACHE_AT, System.currentTimeMillis())
            .apply()
    }

    // ── Ticks made with no connection ────────────────────────────────────

    /** One waiting change: a ticked item, a ticked shopping item, or a spoken note. */
    data class Op(
        val kind: String,
        val noteId: Long,
        val uuid: String,
        val id: Long,
        val checked: Boolean,
        val text: String = "",
    ) {
        fun toJson(): JSONObject = JSONObject()
            .put("kind", kind).put("noteId", noteId).put("uuid", uuid)
            .put("id", id).put("checked", checked).put("text", text)

        companion object {
            fun from(o: JSONObject) = Op(
                kind = o.optString("kind"),
                noteId = o.optLong("noteId"),
                uuid = o.optString("uuid"),
                id = o.optLong("id"),
                checked = o.optBoolean("checked"),
                text = o.optString("text"),
            )

            fun item(noteId: Long, uuid: String, checked: Boolean) = Op("item", noteId, uuid, 0, checked)
            fun shopping(id: Long, checked: Boolean) = Op("shopping", 0, "", id, checked)
            /** Spoken with no connection: the note waits here rather than being lost. */
            fun note(text: String) = Op("note", 0, "", 0, false, text)
        }
    }

    fun outbox(ctx: Context): List<Op> {
        val raw = prefs(ctx).getString(KEY_OUTBOX, null) ?: return emptyList()
        val arr = runCatching { org.json.JSONArray(raw) }.getOrNull() ?: return emptyList()
        return (0 until arr.length()).map { Op.from(arr.getJSONObject(it)) }
    }

    fun queue(ctx: Context, op: Op) {
        // The last word on an item wins, so a double tap doesn't send twice.
        // Spoken notes always queue: two of them are two notes, not a correction.
        val kept = if (op.kind == "note") outbox(ctx) else outbox(ctx).filterNot {
            it.kind == op.kind && it.noteId == op.noteId && it.uuid == op.uuid && it.id == op.id
        }
        writeOutbox(ctx, kept + op)
    }

    fun writeOutbox(ctx: Context, ops: List<Op>) {
        val arr = org.json.JSONArray()
        ops.forEach { arr.put(it.toJson()) }
        prefs(ctx).edit().putString(KEY_OUTBOX, arr.toString()).apply()
    }
}
