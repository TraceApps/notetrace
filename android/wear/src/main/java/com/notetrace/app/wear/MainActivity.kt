package com.notetrace.app.wear

import android.content.Intent
import android.os.Bundle
import android.speech.RecognizerIntent
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import androidx.navigation.NavHostController
import androidx.wear.compose.material3.AppScaffold
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.CircularProgressIndicator
import androidx.wear.compose.material3.Icon
import androidx.wear.compose.material3.ListHeader
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.ScreenScaffold
import androidx.wear.compose.material3.SplitCheckboxButton
import androidx.wear.compose.material3.Text
import androidx.wear.compose.material3.TitleCard
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.navigation.SwipeDismissableNavHost
import androidx.wear.compose.navigation.composable
import androidx.wear.compose.navigation.rememberSwipeDismissableNavController
import kotlinx.coroutines.launch

/**
 * NoteTrace on the wrist: your checklists and the CookTrace shopping list,
 * ticked off without reaching for the phone.
 */
class MainActivity : ComponentActivity() {

    private lateinit var store: WearStore

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = WearStore(applicationContext)
        setContent { WearApp(store) }
    }

    override fun onResume() {
        super.onResume()
        // Coming back from the watch face should show current lists.
        lifecycleScope.launch { store.refresh() }
    }
}

@Composable
fun WearApp(store: WearStore) {
    val nav = rememberSwipeDismissableNavController()
    AppScaffold {
        SwipeDismissableNavHost(navController = nav, startDestination = "home") {
            composable("home") { HomeScreen(store, nav) }
            composable("shopping") { ShoppingScreen(store) }
            composable("reminders") { RemindersScreen(store, nav) }
            composable("list/{noteId}") { entry ->
                val id = entry.arguments?.getString("noteId")?.toLongOrNull() ?: 0L
                ChecklistScreen(store, id)
            }
            composable("note/{noteId}") { entry ->
                val id = entry.arguments?.getString("noteId")?.toLongOrNull() ?: 0L
                NoteScreen(store, id)
            }
        }
    }
}

@Composable
private fun HomeScreen(store: WearStore, nav: NavHostController) {
    val state by store.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val listState = rememberScalingLazyListState()
    val is24h = WhenText.is24Hour(LocalContext.current)
    val speak = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val said = result.data
            ?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
            ?.firstOrNull()
            .orEmpty()
        if (said.isNotBlank()) scope.launch { store.addSpokenNote(said) }
    }

    ScreenScaffold(scrollState = listState) {
        if (!state.paired) {
            // A round screen cuts corners off, and the clock owns the top strip.
            Box(
                modifier = Modifier.fillMaxSize().padding(horizontal = 20.dp, vertical = 28.dp),
                contentAlignment = Alignment.Center,
            ) {
                Message(
                    title = "Pair from your phone",
                    body = "Open NoteTrace on your phone and sign in. The watch pairs itself.",
                )
            }
            return@ScreenScaffold
        }
        ScalingLazyColumn(state = listState, modifier = Modifier.fillMaxSize()) {
            item { ListHeader { Text("NoteTrace") } }
            if (state.pending > 0 || state.offline) {
                item { StatusLine(state) }
            }
            item {
                Button(
                    onClick = {
                        speak.launch(
                            Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                                putExtra(RecognizerIntent.EXTRA_PROMPT, "Say your note")
                            },
                        )
                    },
                    label = { Text("Speak a note") },
                    icon = { Icon(painter = painterResource(R.drawable.ic_mic), contentDescription = null) },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            if (state.reminders.isNotEmpty()) {
                val due = state.reminders.count { WhenText.isOverdue(it.reminderAt) }
                item {
                    TitleCard(
                        onClick = { nav.navigate("reminders") },
                        title = { Text("Reminders") },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(
                            if (due > 0) "$due due now"
                            else WhenText.due(state.reminders.first().reminderAt, is24h),
                        )
                    }
                }
            }
            if (state.shopping.isNotEmpty()) {
                item {
                    TitleCard(
                        onClick = { nav.navigate("shopping") },
                        title = { Text("Shopping List") },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text("${state.shopping.count { !it.checked }} to buy")
                    }
                }
            }
            items(state.checklists, key = { it.id }) { note ->
                TitleCard(
                    onClick = { nav.navigate((if (note.isChecklist) "list/" else "note/") + note.id) },
                    title = { Text(note.title, maxLines = 2, overflow = TextOverflow.Ellipsis) },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    if (note.isChecklist) {
                        Text(if (note.open == 0) "All done" else "${note.open} left")
                    } else if (note.excerpt.isNotBlank()) {
                        Text(note.excerpt.replace('\n', ' '), maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            if (state.checklists.isEmpty() && state.shopping.isEmpty()) {
                item {
                    Box(modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 12.dp)) {
                        Message(
                            title = if (state.loading) "Loading" else "Nothing to tick off",
                            body = if (state.loading) "" else "Checklists you make on your phone show up here.",
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ChecklistScreen(store: WearStore, noteId: Long) {
    val state by store.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val listState = rememberScalingLazyListState()
    val note = state.checklists.firstOrNull { it.id == noteId }
    val items = state.items[noteId].orEmpty()

    ScreenScaffold(scrollState = listState) {
        ScalingLazyColumn(state = listState, modifier = Modifier.fillMaxSize()) {
            item { ListHeader { Text(note?.title ?: "Checklist", maxLines = 2, overflow = TextOverflow.Ellipsis) } }
            if (items.isEmpty()) {
                item { Message(title = if (state.loading) "Loading" else "Empty list", body = "") }
            }
            items(items, key = { it.uuid }) { item ->
                SplitCheckboxButton(
                    checked = item.checked,
                    onCheckedChange = { scope.launch { store.setItemChecked(noteId, item.uuid, it) } },
                    toggleContentDescription = item.text,
                    onContainerClick = { scope.launch { store.setItemChecked(noteId, item.uuid, !item.checked) } },
                    containerClickLabel = item.text,
                    label = { Text(item.text, maxLines = 3, overflow = TextOverflow.Ellipsis) },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}

/**
 * What's coming up. The reminder itself arrives as a notification from the
 * phone, with Done and Snooze on it; this is for looking ahead.
 */
@Composable
private fun RemindersScreen(store: WearStore, nav: NavHostController) {
    val state by store.state.collectAsStateWithLifecycle()
    val listState = rememberScalingLazyListState()
    val is24h = WhenText.is24Hour(LocalContext.current)
    val sorted = state.reminders.sortedBy { it.reminderAt }

    ScreenScaffold(scrollState = listState) {
        ScalingLazyColumn(state = listState, modifier = Modifier.fillMaxSize()) {
            item { ListHeader { Text("Reminders") } }
            items(sorted, key = { it.id }) { note ->
                val overdue = WhenText.isOverdue(note.reminderAt)
                TitleCard(
                    onClick = { nav.navigate((if (note.isChecklist) "list/" else "note/") + note.id) },
                    title = { Text(note.title, maxLines = 2, overflow = TextOverflow.Ellipsis) },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        WhenText.due(note.reminderAt, is24h) + (if (note.repeats) ", repeats" else ""),
                        color = if (overdue) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            if (sorted.isEmpty()) {
                item {
                    Box(modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 12.dp)) {
                        Message(title = "Nothing scheduled", body = "Reminders you set on your phone show up here.")
                    }
                }
            }
        }
    }
}

/** A text note, to read. Writing one belongs on a phone. */
@Composable
private fun NoteScreen(store: WearStore, noteId: Long) {
    val state by store.state.collectAsStateWithLifecycle()
    val listState = rememberScalingLazyListState()
    val note = state.checklists.firstOrNull { it.id == noteId }

    ScreenScaffold(scrollState = listState) {
        ScalingLazyColumn(state = listState, modifier = Modifier.fillMaxSize()) {
            item { ListHeader { Text(note?.title ?: "Note", maxLines = 2, overflow = TextOverflow.Ellipsis) } }
            item {
                Text(
                    note?.excerpt?.ifBlank { "This note has no text." } ?: "",
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 4.dp),
                )
            }
            // The server sends the first stretch of a long note; the rest is on the phone.
            if ((note?.excerpt?.length ?: 0) >= 1200) {
                item {
                    Text(
                        "Longer than this. Open it on your phone for the rest.",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun ShoppingScreen(store: WearStore) {
    val state by store.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val listState = rememberScalingLazyListState()
    // Grouped by aisle, the way the phone and CookTrace show it.
    val open = state.shopping.filter { !it.checked }
    val byAisle = open.groupBy { it.aisle ?: "Other" }.toSortedMap(compareBy { it == "Other" })

    ScreenScaffold(scrollState = listState) {
        ScalingLazyColumn(state = listState, modifier = Modifier.fillMaxSize()) {
            item { ListHeader { Text("Shopping List") } }
            if (state.pending > 0 || state.offline) item { StatusLine(state) }
            byAisle.forEach { (aisle, items) ->
                item { ListHeader { Text(aisle) } }
                items(items, key = { it.id }) { item ->
                    SplitCheckboxButton(
                        checked = item.checked,
                        onCheckedChange = { scope.launch { store.setShoppingChecked(item.id, it) } },
                        toggleContentDescription = item.name,
                        onContainerClick = { scope.launch { store.setShoppingChecked(item.id, !item.checked) } },
                        containerClickLabel = item.name,
                        label = { Text(item.name, maxLines = 2, overflow = TextOverflow.Ellipsis) },
                        secondaryLabel = { if (item.amount.isNotBlank()) Text(item.amount) },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
            if (open.isEmpty()) {
                item { Message(title = "Nothing to buy", body = "Everything on the list is checked off.") }
            }
        }
    }
}

@Composable
private fun StatusLine(state: WearStore.State) {
    val text = when {
        state.offline && state.pending > 0 -> "Offline, ${state.pending} waiting"
        state.offline -> "Offline"
        state.pending > 0 -> "${state.pending} waiting"
        else -> ""
    }
    if (text.isBlank()) return
    Text(
        text,
        textAlign = TextAlign.Center,
        color = MaterialTheme.colorScheme.secondary,
        style = MaterialTheme.typography.labelSmall,
        modifier = Modifier.fillMaxWidth().padding(bottom = 4.dp),
    )
}

@Composable
private fun Message(title: String, body: String) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(title, textAlign = TextAlign.Center, style = MaterialTheme.typography.titleMedium)
        if (body.isNotBlank()) {
            Text(
                body,
                textAlign = TextAlign.Center,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 4.dp),
            )
        }
    }
}
