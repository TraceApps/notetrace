package com.notetrace.app.wear

import android.content.Context
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.json.JSONArray
import org.json.JSONObject

/**
 * What the watch shows, and how it gets there.
 *
 * Every screen reads this one state. Loading draws the last snapshot first so
 * the watch is useful the instant it wakes, then replaces it with the server's
 * answer. A tick shows immediately and goes up straight away, or waits in the
 * outbox when there's no connection.
 */
class WearStore(private val ctx: Context) {

    data class State(
        val paired: Boolean = false,
        val loading: Boolean = false,
        val offline: Boolean = false,
        val error: String? = null,
        val pending: Int = 0,
        /** A word about what just happened, shown for a moment. */
        val flash: String? = null,
        val checklists: List<NoteApi.Note> = emptyList(),
        val reminders: List<NoteApi.Note> = emptyList(),
        val shopping: List<NoteApi.ShopItem> = emptyList(),
        val items: Map<Long, List<NoteApi.Item>> = emptyMap(),
    )

    private val _state = MutableStateFlow(State(paired = Pairing.config(ctx) != null))
    val state: StateFlow<State> = _state

    init {
        restore()
    }

    /** Draw whatever the watch last saw, before anything touches the network. */
    private fun restore() {
        val snap = Pairing.cache(ctx) ?: return
        _state.value = _state.value.copy(
            checklists = readNotes(snap.optJSONArray("checklists")),
            reminders = readNotes(snap.optJSONArray("reminders")),
            shopping = readShopping(snap.optJSONArray("shopping")),
            items = readItems(snap.optJSONObject("items")),
            pending = Pairing.outbox(ctx).size,
        )
    }

    suspend fun refresh() {
        // Ask the phone's data item first: it may have been published while
        // this app wasn't running, which no listener would tell us about.
        val cfg = Pairing.pullFromPhone(ctx) ?: run {
            _state.value = _state.value.copy(paired = false)
            return
        }
        _state.value = _state.value.copy(paired = true, loading = true, error = null)
        flush(cfg)
        try {
            // Both at once: on a watch connection, two round trips in a row is
            // most of the wait.
            coroutineScope {
                val listsJob = async { NoteApi.notes(cfg) }
                val shopJob = async { NoteApi.shopping(cfg) }
                val remindJob = async { NoteApi.reminders(cfg) }
                val (lists, items) = listsJob.await()
                val shop = shopJob.await()
                val upcoming = remindJob.await()
                _state.value = _state.value.copy(
                    loading = false, offline = false, error = null,
                    checklists = lists, shopping = shop, reminders = upcoming,
                    // The slim list carries the items, so opening one is instant.
                    items = items,
                )
            }
            save()
        } catch (e: Exception) {
            if (isRefused(e)) {
                // The token expired or was revoked. Saying "pair from your phone"
                // is the only useful thing here, and the phone re-pairs the next
                // time it's opened. The outbox is kept: those edits are still good.
                Pairing.forget(ctx)
                _state.value = _state.value.copy(paired = false, loading = false, error = null)
                return
            }
            _state.value = _state.value.copy(
                loading = false,
                offline = isOffline(e),
                error = if (isOffline(e)) null else (e.message ?: "Couldn't reach NoteTrace"),
            )
        }
    }

    /**
     * Opening a list needs no request: the slim list already carried its items,
     * and anything ticked offline is already laid over them.
     */
    fun openList(noteId: Long) {
        // Kept as a hook for a future per-list refresh; nothing to do today.
    }

    suspend fun setItemChecked(noteId: Long, uuid: String, checked: Boolean) {
        val current = _state.value.items[noteId].orEmpty()
        val next = current.map { if (it.uuid == uuid) it.copy(checked = checked) else it }
        _state.value = _state.value.copy(items = _state.value.items + (noteId to next))
        bumpCounts(noteId, next)
        Pairing.queue(ctx, Pairing.Op.item(noteId, uuid, checked))
        _state.value = _state.value.copy(pending = Pairing.outbox(ctx).size)
        save()
        Pairing.config(ctx)?.let { flush(it) }
    }

    /**
     * A whole list put back, from the wrist.
     *
     * A shopping list is the same list next week, and tapping every item to
     * start it again is worse on a watch than anywhere else. One ordinary tick
     * per item underneath, so it queues with no connection and merges the way
     * every other tick does.
     */
    suspend fun uncheckAll(noteId: Long) {
        val current = _state.value.items[noteId].orEmpty()
        val back = current.filter { it.checked }
        if (back.isEmpty()) return
        val next = current.map { if (it.checked) it.copy(checked = false) else it }
        _state.value = _state.value.copy(items = _state.value.items + (noteId to next))
        bumpCounts(noteId, next)
        back.forEach { Pairing.queue(ctx, Pairing.Op.item(noteId, it.uuid, false)) }
        _state.value = _state.value.copy(pending = Pairing.outbox(ctx).size)
        save()
        Pairing.config(ctx)?.let { flush(it) }
    }

    /**
     * What the wearer just said becomes a note, now or when there's a connection.
     * A time in the sentence ("tomorrow at nine") becomes the reminder instead
     * of being written down.
     */
    suspend fun addSpokenNote(text: String) {
        val clean = text.trim()
        if (clean.isBlank()) return
        val heard = SpokenTime.parse(clean)
        val body = heard.text.ifBlank { clean }
        val at = heard.at?.withZoneSameInstant(java.time.ZoneOffset.UTC)
            ?.format(java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")).orEmpty()
        flash(if (at.isNotBlank()) "Reminder set" else "Note saved")
        Pairing.queue(ctx, Pairing.Op.note(body, at, java.util.TimeZone.getDefault().id))
        _state.value = _state.value.copy(pending = Pairing.outbox(ctx).size)
        val cfg = Pairing.config(ctx) ?: return
        if (flush(cfg)) refresh()
    }

    /** Done with a reminder, from the watch rather than from its notification. */
    suspend fun reminderDone(noteId: Long) {
        _state.value = _state.value.copy(reminders = _state.value.reminders.filterNot { it.id == noteId })
        Pairing.queue(ctx, Pairing.Op.reminderDone(noteId))
        _state.value = _state.value.copy(pending = Pairing.outbox(ctx).size)
        save()
        val cfg = Pairing.config(ctx) ?: return
        flush(cfg)
    }

    /** Say what just happened, briefly. The watch has no room for a toast. */
    private fun flash(message: String) {
        _state.value = _state.value.copy(flash = message)
    }

    fun clearFlash() {
        if (_state.value.flash != null) _state.value = _state.value.copy(flash = null)
    }

    /** Said while looking at a checklist: a new item on it. */
    suspend fun addSpokenItem(noteId: Long, text: String) {
        val clean = text.trim()
        if (clean.isBlank()) return
        flash("Added")
        Pairing.queue(ctx, Pairing.Op.newItem(noteId, clean))
        _state.value = _state.value.copy(pending = Pairing.outbox(ctx).size)
        val cfg = Pairing.config(ctx) ?: return
        if (flush(cfg)) refresh()
    }

    /** Said while looking at the shopping list: a new thing to buy. */
    suspend fun addSpokenShopping(text: String) {
        val clean = text.trim()
        if (clean.isBlank()) return
        flash("Added")
        Pairing.queue(ctx, Pairing.Op.newShopping(clean))
        _state.value = _state.value.copy(pending = Pairing.outbox(ctx).size)
        val cfg = Pairing.config(ctx) ?: return
        if (flush(cfg)) refresh()
    }

    suspend fun setShoppingChecked(id: Long, checked: Boolean) {
        _state.value = _state.value.copy(
            shopping = _state.value.shopping.map { if (it.id == id) it.copy(checked = checked) else it },
        )
        Pairing.queue(ctx, Pairing.Op.shopping(id, checked))
        _state.value = _state.value.copy(pending = Pairing.outbox(ctx).size)
        save()
        Pairing.config(ctx)?.let { flush(it) }
    }

    /** Send what's waiting. Anything the server refuses is dropped, not retried forever. */
    private suspend fun flush(cfg: Pairing.Config): Boolean {
        var queue = Pairing.outbox(ctx)
        while (queue.isNotEmpty()) {
            val op = queue.first()
            try {
                when (op.kind) {
                    "item" -> NoteApi.setChecked(cfg, op.noteId, op.uuid, op.checked)
                    "shopping" -> NoteApi.checkShopping(cfg, op.id, op.checked)
                    "note" -> NoteApi.createNote(cfg, op.text, op.at, op.tz)
                    "add_item" -> NoteApi.addItem(cfg, op.noteId, op.text)
                    "add_shopping" -> NoteApi.addShopping(cfg, op.text)
                    "reminder_done" -> NoteApi.clearReminder(cfg, op.noteId)
                }
            } catch (e: Exception) {
                if (isOffline(e)) {
                    _state.value = _state.value.copy(offline = true, pending = queue.size)
                    return false
                }
                if (isRefused(e)) {
                    // Not this token's fault to fix: keep the work and stop, so a
                    // re-pair sends it rather than losing it.
                    _state.value = _state.value.copy(pending = queue.size)
                    return false
                }
                // The item is gone, or the server said no: drop it and carry on.
            }
            queue = queue.drop(1)
            Pairing.writeOutbox(ctx, queue)
        }
        _state.value = _state.value.copy(pending = 0, offline = false)
        return true
    }

    private fun bumpCounts(noteId: Long, items: List<NoteApi.Item>) {
        _state.value = _state.value.copy(
            checklists = _state.value.checklists.map {
                if (it.id == noteId) it.copy(open = items.count { i -> !i.checked }, done = items.count { i -> i.checked })
                else it
            },
        )
    }

    /** The server answered, and said no to this token. */
    private fun isRefused(e: Exception): Boolean =
        (e as? NoteApi.ApiError)?.status in setOf(401, 403)

    private fun isOffline(e: Exception): Boolean =
        e is java.io.IOException || (e as? NoteApi.ApiError)?.status in setOf(0, 502, 503, 504)

    // ── The snapshot on disk ─────────────────────────────────────────────

    private fun save() {
        val s = _state.value
        val snap = JSONObject()
            .put("checklists", JSONArray().apply {
                s.checklists.forEach {
                    put(JSONObject().put("id", it.id).put("title", it.title).put("kind", it.kind)
                        .put("excerpt", it.excerpt).put("open", it.open).put("done", it.done)
                        .put("pinned", it.pinned))
                }
            })
            .put("reminders", JSONArray().apply {
                s.reminders.forEach {
                    put(JSONObject().put("id", it.id).put("title", it.title).put("kind", it.kind)
                        .put("excerpt", it.excerpt).put("reminder_at", it.reminderAt).put("repeats", it.repeats))
                }
            })
            .put("shopping", JSONArray().apply {
                s.shopping.forEach {
                    put(JSONObject().put("id", it.id).put("name", it.name).put("amount", it.amount)
                        .put("aisle", it.aisle ?: JSONObject.NULL).put("checked", it.checked))
                }
            })
            .put("items", JSONObject().apply {
                s.items.forEach { (noteId, items) ->
                    put(noteId.toString(), JSONArray().apply {
                        items.forEach { put(JSONObject().put("uuid", it.uuid).put("text", it.text).put("checked", it.checked)) }
                    })
                }
            })
        Pairing.putCache(ctx, snap)
        // The tile draws from this snapshot, so redraw it now rather than leaving
        // yesterday's count on the watch face.
        ListTileService.refresh(ctx)
        ListComplicationService.refresh(ctx)
    }

    private fun readNotes(arr: JSONArray?): List<NoteApi.Note> = (0 until (arr?.length() ?: 0)).map {
        val o = arr!!.getJSONObject(it)
        NoteApi.Note(
            o.optLong("id"), o.optString("title"), o.optString("kind").ifBlank { "text" },
            o.optString("excerpt"), o.optInt("open"), o.optInt("done"),
            o.optString("reminder_at"), o.optBoolean("repeats"), o.optBoolean("pinned"),
        )
    }

    private fun readShopping(arr: JSONArray?): List<NoteApi.ShopItem> = (0 until (arr?.length() ?: 0)).map {
        val o = arr!!.getJSONObject(it)
        NoteApi.ShopItem(
            o.optLong("id"), o.optString("name"), o.optString("amount"),
            o.optString("aisle").takeIf { a -> a.isNotBlank() && a != "null" }, o.optBoolean("checked"),
        )
    }

    private fun readItems(obj: JSONObject?): Map<Long, List<NoteApi.Item>> {
        if (obj == null) return emptyMap()
        return obj.keys().asSequence().associate { key ->
            val arr = obj.optJSONArray(key) ?: JSONArray()
            key.toLong() to (0 until arr.length()).map {
                val o = arr.getJSONObject(it)
                NoteApi.Item(o.optString("uuid"), o.optString("text"), o.optBoolean("checked"))
            }
        }
    }
}
