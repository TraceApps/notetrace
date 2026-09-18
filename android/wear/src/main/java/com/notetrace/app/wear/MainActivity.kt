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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
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
import androidx.wear.compose.foundation.rotary.RotaryScrollableDefaults
import androidx.wear.compose.foundation.rotary.rotaryScrollable
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

/**
 * A list that the crown scrolls, not only a finger. Every screen uses this, so
 * the bezel or crown works the way it does in the rest of the watch.
 */
@Composable
private fun CrownColumn(
    listState: androidx.wear.compose.foundation.lazy.ScalingLazyListState,
    content: androidx.wear.compose.foundation.lazy.ScalingLazyListScope.() -> Unit,
) {
    val focus = remember { FocusRequester() }
    ScalingLazyColumn(
        state = listState,
        modifier = Modifier
            .fillMaxSize()
            .rotaryScrollable(RotaryScrollableDefaults.behavior(listState), focusRequester = focus),
        content = content,
    )
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
}

/** Press, speak, and hand back what was heard. The system does the listening. */
@Composable
private fun rememberSpeech(prompt: String, onHeard: (String) -> Unit): () -> Unit {
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val said = result.data
            ?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
            ?.firstOrNull()
            .orEmpty()
        if (said.isNotBlank()) onHeard(said)
    }
    return {
        launcher.launch(
            Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                putExtra(RecognizerIntent.EXTRA_PROMPT, prompt)
            },
        )
    }
}

/** The row that starts it, sized for a thumb on a small screen. */
@Composable
private fun SpeakButton(label: String, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        label = { Text(label) },
        icon = { Icon(painter = painterResource(R.drawable.ic_mic), contentDescription = null) },
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun HomeScreen(store: WearStore, nav: NavHostController) {
    val state by store.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val listState = rememberScalingLazyListState()
    val is24h = WhenText.is24Hour(LocalContext.current)
    val speak = rememberSpeech("Say your note") { said -> scope.launch { store.addSpokenNote(said) } }

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
        CrownColumn(listState) {
            item { ListHeader { Text("NoteTrace") } }
            if (state.pending > 0 || state.offline || state.error != null) {
                item { StatusLine(state) }
            }
            item { SpeakButton("Speak a note", speak) }
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
            item {
                Button(
                    onClick = { scope.launch { store.refresh() } },
                    label = { Text(if (state.loading) "Refreshing" else "Refresh") },
                    icon = { Icon(painter = painterResource(R.drawable.ic_refresh), contentDescription = null) },
                    modifier = Modifier.fillMaxWidth(),
                )
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
    val speak = rememberSpeech("Say the item") { said -> scope.launch { store.addSpokenItem(noteId, said) } }

    ScreenScaffold(scrollState = listState) {
        CrownColumn(listState) {
            item { ListHeader { Text(note?.title ?: "Checklist", maxLines = 2, overflow = TextOverflow.Ellipsis) } }
            item { SpeakButton("Add an item", speak) }
            if (items.isEmpty()) {
                item { Message(title = if (state.loading) "Loading" else "Empty list", body = "") }
            }
            val open = items.filter { !it.checked }
            val done = items.filter { it.checked }
            items(open, key = { it.uuid }) { item ->
                ItemRow(item.text, false) { scope.launch { store.setItemChecked(noteId, item.uuid, true) } }
            }
            if (done.isNotEmpty()) {
                // Ticked things sink here rather than vanishing: the tick is the
                // confirmation that the right one was tapped.
                item { ListHeader { Text(done.size.toString() + " done") } }
                items(done, key = { it.uuid }) { item ->
                    ItemRow(item.text, true) { scope.launch { store.setItemChecked(noteId, item.uuid, false) } }
                }
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
    val scope = rememberCoroutineScope()
    val listState = rememberScalingLazyListState()
    val is24h = WhenText.is24Hour(LocalContext.current)
    val sorted = state.reminders.sortedBy { it.reminderAt }

    ScreenScaffold(scrollState = listState) {
        CrownColumn(listState) {
            item { ListHeader { Text("Reminders") } }
            items(sorted, key = { it.id }) { note ->
                val overdue = WhenText.isOverdue(note.reminderAt)
                // Tap the row to open the note, the tick to be done with it.
                SplitCheckboxButton(
                    checked = false,
                    onCheckedChange = { scope.launch { store.reminderDone(note.id) } },
                    toggleContentDescription = "Done with " + note.title,
                    onContainerClick = { nav.navigate((if (note.isChecklist) "list/" else "note/") + note.id) },
                    containerClickLabel = note.title,
                    label = { Text(note.title, maxLines = 2, overflow = TextOverflow.Ellipsis) },
                    secondaryLabel = {
                        Text(
                            WhenText.due(note.reminderAt, is24h) + (if (note.repeats) ", repeats" else ""),
                            color = if (overdue) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    },
                    modifier = Modifier.fillMaxWidth(),
                )
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
        CrownColumn(listState) {
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
    val speak = rememberSpeech("Say what to buy") { said -> scope.launch { store.addSpokenShopping(said) } }
    // Grouped by aisle, the way the phone and CookTrace show it.
    val open = state.shopping.filter { !it.checked }
    val byAisle = open.groupBy { it.aisle ?: "Other" }.toSortedMap(compareBy { it == "Other" })

    ScreenScaffold(scrollState = listState) {
        CrownColumn(listState) {
            item { ListHeader { Text("Shopping List") } }
            if (state.pending > 0 || state.offline || state.error != null) item { StatusLine(state) }
            item { SpeakButton("Add to the list", speak) }
            byAisle.forEach { (aisle, items) ->
                item { ListHeader { Text(aisle) } }
                items(items, key = { it.id }) { item ->
                    ItemRow(item.name, false, item.amount) { scope.launch { store.setShoppingChecked(item.id, true) } }
                }
            }
            if (open.isEmpty()) {
                item { Message(title = "Nothing to buy", body = "Everything on the list is checked off.") }
            }
            val bought = state.shopping.filter { it.checked }
            if (bought.isNotEmpty()) {
                item { ListHeader { Text(bought.size.toString() + " in the basket") } }
                items(bought, key = { it.id }) { item ->
                    ItemRow(item.name, true, item.amount) { scope.launch { store.setShoppingChecked(item.id, false) } }
                }
            }
        }
    }
}

/**
 * One thing to tick off. Ticked ones stay, dimmed and struck through, so the
 * tap is confirmed rather than answered by the row disappearing.
 */
@Composable
private fun ItemRow(text: String, checked: Boolean, amount: String = "", onToggle: () -> Unit) {
    val haptics = LocalHapticFeedback.current
    val toggle = {
        // A tick you can feel, for a glance-and-tap in a shop.
        runCatching { haptics.performHapticFeedback(HapticFeedbackType.LongPress) }
        onToggle()
    }
    SplitCheckboxButton(
        checked = checked,
        onCheckedChange = { toggle() },
        toggleContentDescription = text,
        onContainerClick = toggle,
        containerClickLabel = text,
        label = {
            Text(
                text,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
                textDecoration = if (checked) TextDecoration.LineThrough else null,
                color = if (checked) MaterialTheme.colorScheme.onSurfaceVariant else Color.Unspecified,
            )
        },
        secondaryLabel = { if (amount.isNotBlank()) Text(amount) },
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun StatusLine(state: WearStore.State) {
    val text = when {
        state.error != null -> state.error
        state.offline && state.pending > 0 -> "Offline, ${state.pending} waiting"
        state.offline -> "Offline"
        state.pending > 0 -> "${state.pending} waiting"
        else -> ""
    }
    if (text.isBlank()) return
    Text(
        text,
        textAlign = TextAlign.Center,
        color = if (state.error != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.secondary,
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
