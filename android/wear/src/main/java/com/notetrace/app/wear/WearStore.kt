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
        val checklists: List<NoteApi.Note> = emptyList(),
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
                val listsJob = async { NoteApi.checklists(cfg) }
                val shopJob = async { NoteApi.shopping(cfg) }
                val (lists, items) = listsJob.await()
                val shop = shopJob.await()
                _state.value = _state.value.copy(
                    loading = false, offline = false, error = null,
                    checklists = lists, shopping = shop,
                    // The slim list carries the items, so opening one is instant.
                    items = items,
                )
            }
            save()
        } catch (e: Exception) {
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
    private suspend fun flush(cfg: Pairing.Config) {
        var queue = Pairing.outbox(ctx)
        while (queue.isNotEmpty()) {
            val op = queue.first()
            try {
                when (op.kind) {
                    "item" -> NoteApi.setChecked(cfg, op.noteId, op.uuid, op.checked)
                    "shopping" -> NoteApi.checkShopping(cfg, op.id, op.checked)
                }
            } catch (e: Exception) {
                if (isOffline(e)) {
                    _state.value = _state.value.copy(offline = true, pending = queue.size)
                    return
                }
                // The item is gone, or the server said no: drop it and carry on.
            }
            queue = queue.drop(1)
            Pairing.writeOutbox(ctx, queue)
        }
        _state.value = _state.value.copy(pending = 0, offline = false)
    }

    private fun bumpCounts(noteId: Long, items: List<NoteApi.Item>) {
        _state.value = _state.value.copy(
            checklists = _state.value.checklists.map {
                if (it.id == noteId) it.copy(open = items.count { i -> !i.checked }, done = items.count { i -> i.checked })
                else it
            },
        )
    }

    private fun isOffline(e: Exception): Boolean =
        e is java.io.IOException || (e as? NoteApi.ApiError)?.status in setOf(0, 502, 503, 504)

    // ── The snapshot on disk ─────────────────────────────────────────────

    private fun save() {
        val s = _state.value
        val snap = JSONObject()
            .put("checklists", JSONArray().apply {
                s.checklists.forEach { put(JSONObject().put("id", it.id).put("title", it.title).put("open", it.open).put("done", it.done)) }
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
    }

    private fun readNotes(arr: JSONArray?): List<NoteApi.Note> = (0 until (arr?.length() ?: 0)).map {
        val o = arr!!.getJSONObject(it)
        NoteApi.Note(o.optLong("id"), o.optString("title"), o.optInt("open"), o.optInt("done"))
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
