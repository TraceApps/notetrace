package com.notetrace.app.wear

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/**
 * The NoteTrace server, from the watch.
 *
 * The watch talks to the server itself, with the address and token the phone
 * handed over at pairing (Pairing.kt), so it keeps working on Wi-Fi or LTE with
 * the phone out of range. Only what the wrist needs: checklists, their items,
 * ticking an item off, and the CookTrace shopping list.
 */
object NoteApi {

    class ApiError(message: String, val status: Int = 0) : Exception(message)

    data class Note(
        val id: Long,
        val title: String,
        val kind: String,
        val excerpt: String,
        val open: Int,
        val done: Int,
        /** ISO time of the note's reminder, or empty. Repeating ones carry a rule too. */
        val reminderAt: String = "",
        val repeats: Boolean = false,
    ) {
        val isChecklist: Boolean get() = kind == "checklist"
    }
    data class Item(val uuid: String, val text: String, val checked: Boolean)
    data class ShopItem(val id: Long, val name: String, val amount: String, val aisle: String?, val checked: Boolean)

    /**
     * Checklists and their items in one slim request: `slim=1` leaves out note
     * bodies, attachments, labels and previews, which are most of the payload
     * and none of them fit on a watch. Opening a list then needs no second
     * request at all.
     */
    suspend fun notes(cfg: Pairing.Config): Pair<List<Note>, Map<Long, List<Item>>> {
        val arr = asArray(get(cfg, "/api/notes?slim=1"), "notes")
        val notes = mutableListOf<Note>()
        val items = mutableMapOf<Long, List<Item>>()
        for (i in 0 until arr.length()) {
            val n = arr.getJSONObject(i)
            val id = n.getLong("id")
            val raw = n.optJSONArray("items") ?: JSONArray()
            val list = (0 until raw.length()).map { j ->
                val it = raw.getJSONObject(j)
                Item(it.optString("uuid"), it.optString("text"), it.optBoolean("checked"))
            }
            items[id] = list
            val excerpt = n.optString("excerpt")
            val title = n.optString("title").ifBlank {
                // An untitled note shows its first line, the way a card does.
                excerpt.lineSequence().firstOrNull()?.trim().orEmpty().ifBlank { "Untitled" }
            }
            notes += Note(
                id = id,
                title = title,
                kind = n.optString("kind").ifBlank { "text" },
                excerpt = excerpt,
                open = list.count { !it.checked },
                done = list.count { it.checked },
                reminderAt = n.optString("reminder_at").takeIf { it.isNotBlank() && it != "null" }.orEmpty(),
                repeats = n.optString("reminder_rrule").let { it.isNotBlank() && it != "null" },
            )
        }
        return notes to items
    }

    /** A new text note, from what the wearer said. */
    suspend fun createNote(cfg: Pairing.Config, text: String) {
        val clean = text.trim()
        if (clean.isBlank()) return
        // The first line becomes the title, as it does everywhere else in NoteTrace.
        val firstBreak = clean.indexOf('\n')
        val title = (if (firstBreak > 0) clean.substring(0, firstBreak) else clean).take(80)
        val body = if (firstBreak > 0) clean.substring(firstBreak + 1).trim() else ""
        send(cfg, "POST", "/api/notes", JSONObject().put("title", title).put("body_md", body).put("kind", "text"))
    }

    /**
     * Clear a note's reminder. A repeating one keeps its rule on the server, so
     * this is the same "done with this occurrence" the notification's Done does.
     */
    suspend fun clearReminder(cfg: Pairing.Config, noteId: Long) {
        send(cfg, "PATCH", "/api/notes/$noteId", JSONObject().put("reminder_at", JSONObject.NULL))
    }

    /** A new item on a checklist, from what the wearer said. */
    suspend fun addItem(cfg: Pairing.Config, noteId: Long, text: String) {
        val clean = text.trim()
        if (clean.isBlank()) return
        send(cfg, "POST", "/api/notes/$noteId/items", JSONObject().put("text", clean))
    }

    /** A new item on the CookTrace shopping list. */
    suspend fun addShopping(cfg: Pairing.Config, text: String) {
        val clean = text.trim()
        if (clean.isBlank()) return
        send(cfg, "POST", "/api/integrations/cooktrace/shopping", JSONObject().put("items", org.json.JSONArray().put(clean)))
    }

    /** Tick an item off, or back on. */
    suspend fun setChecked(cfg: Pairing.Config, noteId: Long, uuid: String, checked: Boolean) {
        send(cfg, "PATCH", "/api/notes/$noteId/items/$uuid", JSONObject().put("checked", checked))
    }

    /** Notes with a reminder, soonest first. */
    suspend fun reminders(cfg: Pairing.Config): List<Note> {
        val arr = asArray(get(cfg, "/api/notes?view=reminders&slim=1"), "notes")
        return (0 until arr.length()).mapNotNull { i ->
            val n = arr.getJSONObject(i)
            val at = n.optString("reminder_at").takeIf { it.isNotBlank() && it != "null" } ?: return@mapNotNull null
            val excerpt = n.optString("excerpt")
            Note(
                id = n.getLong("id"),
                title = n.optString("title").ifBlank {
                    excerpt.lineSequence().firstOrNull()?.trim().orEmpty().ifBlank { "Untitled" }
                },
                kind = n.optString("kind").ifBlank { "text" },
                excerpt = excerpt,
                open = 0,
                done = 0,
                reminderAt = at,
                repeats = n.optString("reminder_rrule").let { it.isNotBlank() && it != "null" },
            )
        }
    }

    /** The CookTrace shopping list, as the phone shows it. Empty when CookTrace isn't linked. */
    suspend fun shopping(cfg: Pairing.Config): List<ShopItem> = try {
        val arr = asArray(get(cfg, "/api/integrations/cooktrace/shopping"), "items")
        (0 until arr.length()).map { i ->
            val it = arr.getJSONObject(i)
            val qty = it.opt("quantity")?.takeIf { q -> q != JSONObject.NULL }?.toString().orEmpty()
            val unit = it.optString("unit").takeIf { u -> u != "null" }.orEmpty()
            ShopItem(
                id = it.getLong("id"),
                name = it.optString("name"),
                amount = listOf(qty, unit).filter { s -> s.isNotBlank() }.joinToString(" "),
                aisle = it.optString("aisle").takeIf { a -> a.isNotBlank() && a != "null" },
                checked = it.optBoolean("checked"),
            )
        }
    } catch (e: ApiError) {
        // 409 is "CookTrace isn't linked", which is a normal state, not a failure.
        if (e.status == 409) emptyList() else throw e
    }

    suspend fun checkShopping(cfg: Pairing.Config, id: Long, checked: Boolean) {
        send(cfg, "PATCH", "/api/integrations/cooktrace/shopping/$id", JSONObject().put("checked", checked))
    }

    // ── HTTP ─────────────────────────────────────────────────────────────

    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    private val JSON = "application/json; charset=utf-8".toMediaType()

    private fun asArray(body: String, key: String): JSONArray =
        if (body.trimStart().startsWith("[")) JSONArray(body) else JSONObject(body).optJSONArray(key) ?: JSONArray()

    private suspend fun get(cfg: Pairing.Config, path: String): String = send(cfg, "GET", path, null)

    private suspend fun send(cfg: Pairing.Config, method: String, path: String, body: JSONObject?): String =
        withContext(Dispatchers.IO) {
            val request = Request.Builder()
                .url(cfg.serverUrl.trimEnd('/') + path)
                .header("Authorization", "Bearer " + cfg.token)
                .header("Accept", "application/json")
                .method(method, body?.toString()?.toRequestBody(JSON))
                .build()
            client.newCall(request).execute().use { res ->
                val text = res.body?.string().orEmpty()
                if (!res.isSuccessful) {
                    val message = runCatching { JSONObject(text).optString("error") }.getOrNull()
                    throw ApiError(message?.ifBlank { "Server error " + res.code } ?: ("Server error " + res.code), res.code)
                }
                text
            }
        }
}
