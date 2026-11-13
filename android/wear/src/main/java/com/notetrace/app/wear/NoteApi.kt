package com.notetrace.app.wear

import android.content.Context
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject
import okhttp3.ConnectionSpec
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
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

    /** Local mode: the phone couldn't answer (out of reach, or its app closed). What was done waits. */
    class PhoneUnavailable(message: String) : IOException(message)

    /** Where Local mode asks the phone (WearPairingPlugin.API_PATH). */
    private const val PHONE_API = "/notetrace/api"

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
        val pinned: Boolean = false,
        /** Read Only (set on the phone): its items can be ticked, not added to. */
        val readOnly: Boolean = false,
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
    suspend fun notes(ctx: Context, cfg: Pairing.Config): Pair<List<Note>, Map<Long, List<Item>>> {
        val arr = asArray(get(ctx, cfg, "/api/notes?slim=1&watch=1"), "notes")
        val notes = mutableListOf<Note>()
        val items = mutableMapOf<Long, List<Item>>()
        for (i in 0 until arr.length()) {
            val n = arr.getJSONObject(i)
            val id = n.getLong("id")
            val list = itemsOf(n)
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
                pinned = n.optBoolean("pinned"),
                readOnly = n.optBoolean("read_only"),
            )
        }
        // Pinned first, as on the phone: on a watch, the top of the list is
        // nearly all the list.
        return notes.sortedByDescending { it.pinned } to items
    }

    /**
     * A new text note, from what the wearer said. A time heard in the sentence
     * becomes the note's reminder rather than part of its text.
     */
    suspend fun createNote(ctx: Context, cfg: Pairing.Config, text: String, reminderAt: String = "", tz: String = "") {
        val clean = text.trim()
        if (clean.isBlank()) return
        // The first line becomes the title, as it does everywhere else in NoteTrace.
        val firstBreak = clean.indexOf('\n')
        val title = (if (firstBreak > 0) clean.substring(0, firstBreak) else clean).take(80)
        val body = if (firstBreak > 0) clean.substring(firstBreak + 1).trim() else ""
        val payload = JSONObject().put("title", title).put("body_md", body).put("kind", "text")
        if (reminderAt.isNotBlank()) {
            payload.put("reminder_at", reminderAt)
            if (tz.isNotBlank()) payload.put("reminder_tz", tz)
        }
        send(ctx, cfg, "POST", "/api/notes", payload)
    }

    /**
     * Clear a note's reminder. A repeating one keeps its rule on the server, so
     * this is the same "done with this occurrence" the notification's Done does.
     */
    suspend fun clearReminder(ctx: Context, cfg: Pairing.Config, noteId: Long, made: String = "", seen: String = "") {
        val body = JSONObject().put("reminder_at", JSONObject.NULL)
        // The reminder the watch showed: in Local mode the phone keeps one moved since. A server ignores it.
        if (seen.isNotBlank()) body.put("reminder_seen", seen)
        send(ctx, cfg, "PATCH", "/api/notes/$noteId", madeAt(body, made))
    }

    /**
     * When a change was made (`made`, ISO 8601 UTC): the server keeps a change
     * made elsewhere after it, rather than letting one that waited for a
     * connection undo it. Servers from before ignore it.
     */
    private fun madeAt(body: JSONObject, made: String): JSONObject {
        if (made.isBlank()) return body
        return body.put("edited_at", made).put("client_now", java.time.Instant.now().toString())
    }

    /** A new item on a checklist, from what the wearer said. */
    suspend fun addItem(ctx: Context, cfg: Pairing.Config, noteId: Long, text: String) {
        val clean = text.trim()
        if (clean.isBlank()) return
        send(ctx, cfg, "POST", "/api/notes/$noteId/items", JSONObject().put("text", clean))
    }

    /** A new item on the CookTrace shopping list. */
    suspend fun addShopping(ctx: Context, cfg: Pairing.Config, text: String) {
        val clean = text.trim()
        if (clean.isBlank()) return
        send(ctx, cfg, "POST", "/api/integrations/cooktrace/shopping", JSONObject().put("items", org.json.JSONArray().put(clean)))
    }

    /** Tick an item off, or back on. */
    suspend fun setChecked(ctx: Context, cfg: Pairing.Config, noteId: Long, uuid: String, checked: Boolean, made: String = "") {
        send(ctx, cfg, "PATCH", "/api/notes/$noteId/items/$uuid", madeAt(JSONObject().put("checked", checked), made))
    }

    /** A slim note's checklist items. */
    private fun itemsOf(n: JSONObject): List<Item> {
        val raw = n.optJSONArray("items") ?: JSONArray()
        return (0 until raw.length()).map { j ->
            val it = raw.getJSONObject(j)
            Item(it.optString("uuid"), it.optString("text"), it.optBoolean("checked"))
        }
    }

    /**
     * Notes with a reminder, soonest first, and their checklists' items: a list
     * opened from Reminders may not be one kept on the watch, and would
     * otherwise open empty.
     */
    suspend fun reminders(ctx: Context, cfg: Pairing.Config): Pair<List<Note>, Map<Long, List<Item>>> {
        val arr = asArray(get(ctx, cfg, "/api/notes?view=reminders&slim=1"), "notes")
        val items = mutableMapOf<Long, List<Item>>()
        val notes = (0 until arr.length()).mapNotNull { i ->
            val n = arr.getJSONObject(i)
            val at = n.optString("reminder_at").takeIf { it.isNotBlank() && it != "null" } ?: return@mapNotNull null
            if (n.optString("kind") == "checklist") items[n.getLong("id")] = itemsOf(n)
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
                // A list opened from Reminders may not be one kept on the watch.
                readOnly = n.optBoolean("read_only"),
            )
        }
        return notes to items
    }

    /** The CookTrace shopping list, as the phone shows it. Empty when CookTrace isn't linked. */
    suspend fun shopping(ctx: Context, cfg: Pairing.Config): List<ShopItem> = try {
        val arr = asArray(get(ctx, cfg, "/api/integrations/cooktrace/shopping"), "items")
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

    suspend fun checkShopping(ctx: Context, cfg: Pairing.Config, id: Long, checked: Boolean) {
        send(ctx, cfg, "PATCH", "/api/integrations/cooktrace/shopping/$id", JSONObject().put("checked", checked))
    }

    // ── HTTP ─────────────────────────────────────────────────────────────

    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        // https:// with no cleartext at all: a redirect to http:// fails, as
        // it did before the watch allowed cleartext (TraceApps/nutritrace#194).
        .connectionSpecs(listOf(ConnectionSpec.MODERN_TLS))
        .build()

    // Plain http:// to the confirmed server only, never following a redirect.
    private val plainClient = client.newBuilder()
        .connectionSpecs(listOf(ConnectionSpec.CLEARTEXT))
        .followRedirects(false)
        .followSslRedirects(false)
        .build()

    private val JSON = "application/json; charset=utf-8".toMediaType()

    private fun asArray(body: String, key: String): JSONArray =
        if (body.trimStart().startsWith("[")) JSONArray(body) else JSONObject(body).optJSONArray(key) ?: JSONArray()

    private suspend fun get(ctx: Context, cfg: Pairing.Config, path: String): String = send(ctx, cfg, "GET", path, null)

    private suspend fun send(ctx: Context, cfg: Pairing.Config, method: String, path: String, body: JSONObject?): String =
        if (cfg.viaPhone) askPhone(ctx, method, path, body) else withContext(Dispatchers.IO) {
            // https:// as saved; plain http:// only to a server on your own
            // network that the phone confirmed (LocalAddress.workerBase).
            // Refused, it fails like no connection.
            // An https:// address goes as saved, as it always has, before the
            // parser below (which refuses international names) sees it.
            val base = (if (cfg.serverUrl.trim().startsWith("https://", ignoreCase = true)) cfg.serverUrl.trim() else null)
                ?: LocalAddress.workerBase(cfg.serverUrl, cfg.httpOk)
                ?: throw IOException("plain HTTP to this server isn't confirmed on the phone")
            val plain = base.startsWith("http:")
            val request = Request.Builder()
                .url(base.trimEnd('/') + path)
                .header("Authorization", "Bearer " + cfg.token)
                .header("Accept", "application/json")
                .method(method, body?.toString()?.toRequestBody(JSON))
                .build()
            (if (plain) plainClient else client).newCall(request).execute().use { res ->
                val text = res.body?.string().orEmpty()
                if (!res.isSuccessful) {
                    val message = runCatching { JSONObject(text).optString("error") }.getOrNull()
                    throw ApiError(message?.ifBlank { "Server error " + res.code } ?: ("Server error " + res.code), res.code)
                }
                text
            }
        }

    /**
     * Local mode: the same request, answered by the phone's app over the Wear
     * connection instead of by a server. A failure here is like no
     * connection: what was done waits, and the watch says why.
     */
    private suspend fun askPhone(ctx: Context, method: String, path: String, body: JSONObject?): String {
        val nodes = try {
            Wearable.getNodeClient(ctx).connectedNodes.await()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            throw PhoneUnavailable("Phone not nearby")
        }
        val phone = nodes.firstOrNull { it.isNearby } ?: nodes.firstOrNull() ?: throw PhoneUnavailable("Phone not nearby")
        val request = JSONObject().put("method", method).put("path", path).put("body", body?.toString() ?: JSONObject.NULL)
        val answer = try {
            withTimeout(25_000) {
                Wearable.getMessageClient(ctx).sendRequest(phone.id, PHONE_API, request.toString().toByteArray(Charsets.UTF_8)).await()
            }
        } catch (e: TimeoutCancellationException) {
            throw PhoneUnavailable("Open NoteTrace on your phone")
        } catch (e: CancellationException) {
            // The screen closed: nothing to say.
            throw e
        } catch (e: Exception) {
            // No one listening on the phone: its app isn't running.
            throw PhoneUnavailable("Open NoteTrace on your phone")
        }
        return readPhoneAnswer(answer)
    }

    /** The phone's reply ({status, body}, WearPairingPlugin.reply): the body, or why not. */
    fun readPhoneAnswer(answer: ByteArray): String {
        val reply = runCatching { JSONObject(String(answer, Charsets.UTF_8)) }.getOrNull()
            ?: throw PhoneUnavailable("Open NoteTrace on your phone")
        val status = reply.optInt("status", 500)
        val text = reply.optString("body", "")
        // The app not ready yet, or too slow: what was done waits, as offline.
        if (status == 503 || status == 504) throw PhoneUnavailable("Open NoteTrace on your phone")
        if (status !in 200..299) {
            val message = runCatching { JSONObject(text).optString("error") }.getOrNull()
            throw ApiError(message?.ifBlank { "Phone error $status" } ?: "Phone error $status", status)
        }
        return text
    }
}
