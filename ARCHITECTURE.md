# Architecture

Orientation for new contributors. Covers the shape of the codebase,
the design decisions worth knowing before touching things, and the
house conventions that aren't obvious from reading the source.

## Stack

- **Frontend:** Svelte 4 (compat mode on Svelte 5 runtime), Vite,
  svelte-spa-router v4 (hash routing)
- **Server:** Node + Express 5, better-sqlite3
- **Mobile:** PWA + Capacitor 8 (Android)
- **Deploy:** `docker compose up -d`, container listens on 3004, the
  sample compose maps host port 3004

## Layout

The important reads:

- `src/App.svelte`, root, all routes wired here
- `src/lib/api.js`, API proxy that picks between HTTP, native SQLite,
  and cached impls per platform
- `src/lib/db.js`, localStorage-backed settings for the PWA
- `src/lib/db-native.js`, on-device SQLite for Android local mode
- `src/lib/sync.js`, push/pull orchestrator for Android server mode
- `server/db.js`, schema, migrations, sole SQLite entry point
- `server/routes/`, Express handlers, one file per domain
- `src/routes/`, top-level Svelte page components

Everything else is discoverable with `grep` and `ls`.

## Key Design Decisions

Things you'd want to know before rewriting them.

### Portaled elements need a fixed first node

`use:portal` moves an element to `<body>`. If that element is the first
node of a component or `{#if}` block that has other top-level nodes,
Svelte's teardown walks from the moved node and leaves the rest behind.
Wrap such components in a plain element (see `.editor-host` in
NoteEditor.svelte).

### Layers stack in the order they open

Every open layer registers with `src/lib/back-stack.js`, so the list is
the order they opened in, and Android's back closes the newest. Popovers,
sheets, dialogs and the time picker register through `use:closeOnBack` on
their backdrop, which also raises one opened from another above it when its
own z-index is lower, as the calendar sheet (200) opened from a reminder
popover (300) was (#39). The full-screen layers (the note editor, the image
and file viewers, the drawing editor) register with `onBack` alone: they
have no element in the list and aren't raised. Escape: sheets and dialogs
take it from inside themselves; a popover listens on the whole window and
passes it to the newest layer (`escapeFrom`), even before that one has
taken focus.

### Swapping a component in place needs `{#key}`

On the Svelte 5 runtime, an `{#if}` block whose condition turns false
and then true again while its outro is still running resumes the old
instance instead of mounting a new one. Opening a linked note from
inside the editor hits exactly that, so Notes.svelte wraps the editor in
`{#key editing}`.

### Routing re-mounts on nav

`{#key $location}` in App.svelte forces route components to
destroy/recreate on every nav so `onMount` fires fresh each time.
Intentional. If you strip this, the page-transition and
skeleton-loader UX breaks.

### Markdown is the source of truth for note bodies

`notes.body_md` stores Markdown. The editor renders and edits rich
text, but what lands in the database, in exports, and in sync payloads
is plain Markdown, so a note is always portable and full-text search
works on readable text.

### Nothing is silently lost on conflict

Two edits of one row meet field by field: the newer edit of each field
stays, by when it was made (on the server's clock), and fields that only
mean something together merge as one (a note's text and kind, its
reminder's time, repeat and zone; an item's tick and when; a picture's
file and what describes it). `server/lib/field-sync.js` is the rule,
byte-identical with the other Trace apps that use it and pinned by hash
in `scripts/field-sync.test.js`; `server/lib/sync-fields.js` lists each
table's fields and groups. Every synced row keeps `field_times` (when each
field last changed), stamped by triggers on every write (db.js) unless a
merged sync edit stamps its own; it never goes out in a pull. The Android
app keeps each row's `server_base` (the copy the server has; rows from
before get one after a pull, a few hundred at a time) and pushes
`changed_fields`, so a whole row from the phone changes only what was
changed there, with `field_edits`, each field's own edit time (kept by
triggers in its `edit_times` table), so a field changed before a later
change of another keeps its time. The web's offline outbox sends the same
for notes and items. A row without them (older apps) counts every field it
sends as edited at its `updated_at`; one changed before the update and
again after it (still waiting, no copy kept) goes whole, each field with
its own time (`_rest` in `edit_times`: the earlier change's). A write that
moves a row's `updated_at` without changing a field (an item ticked moves
its note's) starts the times of a row from before them from the write
before, so it isn't an edit. A full backup restores them. A delete loses to a later edit of the row
(for a note, also of its items, pictures and labels), and an edit made
before a delete doesn't bring the row back; ties go to the delete. A
setting is one field, the newer value wins. A note title or text that
loses is kept in version history rather than dropped. The note editor
saves only the title or text it changed, so a save of one never puts the
other back; closing it renames links only (`links_only`, below). A label
change sends the set it was made on (`labels_from`), so only what it put
on or took off changes. The watch sends a queued tick or reminder done
with when it was made (`edited_at`, `client_now` on `PATCH
/api/notes/:id` and `.../items/:uuid`): a field changed here after it
stays, and what goes in counts from when it was made (with its group, an
item's `checked_at` too), not from when it arrived. Without `client_now`,
or with a clock a year or more out, it counts as made now. Servers from
before ignore `links_only`, `labels_from` and `edited_at`. Checklist items merge per item (a stable uuid plus tombstones
for deletes), so a device with a stale list can never wipe items another
device added.

### Shared notes keep one owner

A note belongs to its owner (`notes.user_id`). `note_members` grants
other accounts `view` or `edit`. Content (title, body, color,
checklist) is shared; pin and archive live on the member's row, labels
are per person (`note_labels.user_id`), and reminders, trash, and
permanent delete stay with the owner. Checklist items always carry the
owner's `user_id`, whoever adds them, so the owner's queries and sync
see every item. Access rules live in `server/lib/notes.js`
(`noteAccess`), and sync applies the same rules: a member's pull gets
shared notes with their own pin and archive plus `share_role`,
`share_owner`, and `share_count`, and `revoked_notes` tells a device
to drop notes it can no longer see. Sharing changes re-stamp the note
so every device that can see it pulls it again.

### Reminders have three delivery paths

A reminder is stored as its first occurrence (UTC), a repeat, and the
IANA time zone it was set in, so a repeat keeps its wall-clock time
across daylight saving (`nextOccurrence` in `src/lib/reminders.js`,
mirrored in `server/lib/reminders.js`, both covered by tests).

- **Android:** native exact alarms. After every note change or sync,
  `src/lib/note-reminders.js` hands the native side the full reminder
  list (with notification text) and `NoteReminderStore` saves it to a
  file. `NoteReminderScheduler.java` arms one `setExactAndAllowWhileIdle`
  alarm per note for its next occurrence (`ReminderMath.java`, a Java
  port of the JS math with the same test cases). `NoteReminderReceiver`
  re-checks the latest list when the alarm fires, so an edited or cleared
  reminder doesn't go off, shows the notification, and arms the next
  one. Done queues the note id; the app clears the reminder through its
  normal data layer when it next runs. `BootReceiver` re-arms after
  reboots, updates, and clock or time zone changes. The native code never
  opens the app's SQLite database: the Capacitor SQLite plugin ships its
  own SQLite, and a second SQLite library in the same process can release
  its file locks and corrupt the database.
- **Browser:** `src/lib/web-reminders.js` shows due reminders while a
  NoteTrace tab is open, once per occurrence (recorded in
  localStorage). `public/sw-notifications.js` is imported into the
  service worker so a click opens the note.
- **Server:** `server/lib/reminder-delivery.js` runs every minute,
  finds occurrences that just came due (up to 2 hours late after a
  restart), and sends each one once, deduped in `notification_log` by
  occurrence time, to the owner's push service and the
  `reminder.fired` webhook.

### Images are note attachments

`note_attachments` rows (uuid, url, size, position) sync like checklist
items: per row, tombstoned on delete, owner's `user_id`, and editable by
`edit` members of a shared note. Files are uploaded first through
`/api/upload` (scaled down in the browser by `src/lib/note-images.js`),
and the server only accepts `/uploads/` paths it stored. In Android
local mode a photo is saved on the device; the sync's photo pass uploads
it and rewrites the URL before the row is pushed, and the server holds
back any row that still points at a device-local file.

### Voice notes and image text are attachment text

A voice note is an audio attachment with `duration_ms`, a `waveform` (64
bar heights) and, once transcribed, `segments` (timestamped lines), both
JSON text cleaned by `server/lib/voice-meta.js`; an image is an attachment
too. Trace's transcript or the text read from an image is
saved in `extracted_text` on the same row, and the full-text index
covers it (the FTS `items` column is checklist text plus attachment
text; `server/db.js` recreates the FTS triggers on every start, so
existing databases pick up changes). Transcription and image reading
call the user's own AI provider from the browser or phone, like the
Trace chat; when Trace is set by environment variables they go through
`/api/ai/transcribe` and `/api/ai/read-image` instead.

`server/lib/transcript.js` (shared with the app) turns provider replies into
timestamped segments: Whisper-style `verbose_json`, or Gemini lines that start
with `[m:ss]`. A recording bigger than one request's limit is split with
`-c copy` by `server/lib/audio-tools.js` (the audio-only ffmpeg built in the
Dockerfile) through `/api/upload/split`, or by `VoiceRecorderPlugin.splitFile`
in Android local mode, and the pieces' segments are offset and merged.
`/api/upload/audio?convert=1` converts formats browsers can't play (Keep's
3GP/AMR) to M4A.

Recording goes through `src/lib/voice-recorder.js`: MediaRecorder in a
browser, and `VoiceRecorderService.java` (a microphone foreground service
with a wake lock) in the Android app, so it survives the screen turning off.
Both give the same handle: pause, resume, elapsed time, a live level, and a
waveform built from the levels at stop.

With Trace set by environment variables, the chat's tool loop still runs
on the device: `/api/app-config/env-locks` reports the server's provider and
model, the client builds that provider's request, and `/api/ai/relay`
adds the key, forces the configured model, allowlists body fields, and
forwards it.

### Note tools are shared by Trace and MCP

`server/lib/note-tools.js` defines the note tools (search, get, create,
update, append, checklist items, tasks and due dates, reminders, labels, trash) once, as a
JSON Schema catalog plus `executeNoteTool(name, args, api, opts)`. It
imports only the pure `server/lib/reminders.js`, so Vite bundles it for
the client too. Trace passes `NoteApi`
(so tools work offline in Android local mode); the MCP server passes an
adapter over `server/lib/notes.js`. The view-only guard, owner-only
actions, and item matching live in that one file.

### The public REST API only adds

`/api/v1` (`server/routes/api-v1.js`) is for other apps: `GET /me` and
`POST /notes`, behind bearer tokens with the `notes:create` scope, which
can do nothing else. `server/lib/public-notes.js` checks every field
before writing anything, then writes the labels, note and reminder in one
transaction through `server/lib/notes.js`, answering in the same shape as
the MCP `get_note` tool. A source link is plain Markdown in the note, so
it needs no column. An `Idempotency-Key` is remembered for 24 hours in
`api_idempotency` (left out of backups, pruned by the scheduler), so a
retry replays the first answer instead of adding a second note. Keys
belong to the user, and the body is hashed with its keys sorted. Every
signed-in user manages their own tokens (`server/routes/api-tokens.js`)
and may give them only `notes:create`; the MCP scopes stay admin-only.

### `[[Links]]` are plain Markdown

A link is stored as `[[Title]]` in `body_md` and shown as a chip by a
TipTap node (`src/lib/note-link-extension.js`). Backlinks are a query
over bodies, not a table, so imports and sync need nothing extra.
Renaming a note rewrites `[[Old]]` to `[[New]]` in the owner's own
notes, on the server and in Android local mode. The editor's title
autosaves send `rename_links: false`, and closing the editor sends one
rename from the title it opened with (`rename_links_from`, with
`links_only`: the links follow to the note's title as it is now, and no
title is written, so a rename made elsewhere meanwhile stays), so partial
titles never rewrite links. In the browser it isn't queued: with no
connection, a server gone quiet or changes still waiting, the editor
closes at once and the links stay as they are. A rename is skipped when another note has
the old or the new title.

### Card order, selection, and gestures are client state

Custom order is a user setting (`noteOrder`, a list of note keys: `s<server id>`,
or `l<device id>` for a note that never reached a server) applied on top of the
normal list (`src/lib/note-order.js`), so reordering never touches `updated_at`,
version history, or sync conflict rules. Dragging (`src/lib/card-drag.js`) and
swiping (`src/lib/card-swipe.js`) are actions on the grid that read
`data-note-id` from the cards; a mouse drag starts after a few pixels, a touch
drag after a long press (which also selects), and a swipe only for a quick
sideways move. Search filters (`src/lib/note-filters.js`) filter the loaded list
in the browser.

### Tasks are checklist items

The Tasks view (`src/routes/Tasks.svelte`) reads the normal notes list; there's
no task table. `server/lib/task-rules.js` decides what counts: an unchecked item
with `checklist_items.due_date` (a `YYYY-MM-DD` calendar day, synced with the
item), or any unchecked item on a checklist with `in_tasks` set, or everything
when the `tasksAllChecklists` setting is on. Like pinned and archived,
`in_tasks` lives on `notes` for the owner and on `note_members` for someone the
note is shared with. `src/lib/due-dates.js` groups the items. Quick add appends
to a checklist titled "Tasks", which is always shown. Trace and MCP's
`list_tasks` use the same rule.

The daily Tasks Due notification follows the reminder paths. The digest text
comes from the pure `server/lib/task-digest-core.js`. On Android,
`src/lib/note-reminders.js` schedules the next 14 digests as alarms with negative
ids, which open `/tasks`. In a browser, `src/lib/web-reminders.js` fires it once a
day while a tab is open. On the server, `server/lib/task-digest.js` runs in the
reminder tick, sends at the user's digest time in their `timezone` setting (until
20:00 if it was down), and records one `tasks_due` row per local date in
`notification_log`.

### The List layout reuses the editor in place

`NoteEditor` takes `inline` to render inside the List layout's reading pane
instead of over the page (no portal, backdrop, or open animation). Inline, its
actions move from the bottom bar to a toolbar across the top, with no Done
button. Switching notes calls the editor's exported `leave()` first, which runs
the same steps as closing it (`src/lib/editor-close.js`: pending text saved,
links renamed after a title change, a note emptied there removed, the lists
told) without the close event, before the pane is re-keyed. Only Done also
removes an empty note that was merely opened. Only the last note picked opens
(`paneSeq`). The pane closing for
another layout does the same, and an editor that goes away without closing
(the page left) runs the steps on its way out unless the account changed.
Moving the note between the pane and full screen (a fold) uses `handOff()`
instead: nothing closes, and the next editor gets `openedAs`, the title the
note first opened with, so its links still follow a rename. Sections come from
`src/lib/list-groups.js`. On wide screens `Notes.svelte` sizes the workspace to
the space under the banner after each update, so the list and the pane scroll
separately while the page itself doesn't.

### Screen sizes and foldables

`src/stores/window-size.js` sorts the window into compact (under 600px),
medium (to 1023px), and expanded size classes and holds `contentWidth`, the
room left beside a pinned sidebar, which App.svelte keeps current and mirrors
as `size-*` and `wide-content` classes on `<html>`. Auto navigation, the List
layout's two panes (`contentWidth` of 740px or more), and Settings' two panes
read these instead of their own breakpoints. The notes layout is saved per size
class (`notesLayoutBySize`), so a foldable's two screens keep their own.

`src/lib/fold.js` reports a half-open fold as `{ posture, start, end }`. The
Android app gets it from `FoldPlugin.java` (Jetpack WindowManager's
FoldingFeature, converted to CSS pixels); a browser with the Viewport Segments
API reports it through `window.viewport.segments`. It sets `fold-book` or
`fold-tabletop` and `--fold-start`/`--fold-end` on `<html>`;
`src/styles/fold.css` moves overlays off the crease, and the List layout snaps
its divider to a book fold. Folding or unfolding with a note open flushes the
editor and reopens the note in the pane or full screen.

### Long lists draw a screenful at a time

`Notes.svelte` keeps a `shown` count (60 at a time) and slices the notes it
hands to the grid, the timeline, and the List layout; a marker element after
the last one (`src/lib/grow-on-scroll.js`, an IntersectionObserver) raises it as
you scroll, and the count resets when the view, the query, or the filters
change. Selection, search, and the keyboard keys work on the full list, so only
the drawing is windowed.

### Uploads can't be mistaken for pages

`safeUploadExtension()` in `server/lib/upload-paths.js` names every upload from
an allowlist for its kind, never from the uploader's file name, and
`UPLOAD_RESPONSE_HEADERS` serves `/uploads` with `nosniff` and a sandboxing
content policy, which also covers files stored before this.

### A voice note that can't be uploaded waits

`src/lib/pending-voice.js` keeps the recording (and, for a note that doesn't
exist yet, what to create it with) in IndexedDB, retries when the connection
returns, the app comes forward, or once a minute, and hands the result to an
open editor through a `note:voice-uploaded` event, or attaches and transcribes
it itself. `close()` won't clean up a note that has one waiting.

### The installed web app works offline

The service worker precaches the built app. Page loads go to the server first
and fall back to the precached `index.html` offline, after 3 seconds, or on a
5xx from a proxy, and nothing is stored from them, so a reload after a deploy
gets the new app and a sign-in proxy can show its page
(`src/lib/pwa-navigation.js`, #37). The API, uploads, the share
target and public note links opened as a page are never kept (`NetworkOnly`), so
an export or a backup can't outlive the session, and
`public/sw-retired-caches.js` deletes the old `pages-cache` that held them. It keeps `/uploads` files (`CacheFirst`, range requests so a cached
recording can be scrubbed), and keeps the last notes, labels, and settings
(`NetworkFirst`). `logout()` deletes those two caches so an account's notes
don't outlive its session on a shared computer.

A server that takes the connection and never answers fails no request, so
each request with an offline answer gets a deadline for the server's first
answer (a long body still downloads at its own pace)
(`src/lib/request-deadline.js`, the same file in the four Trace apps): the
sign-in check at startup with an account kept here (3 s), a read (4 s: the
copy answers, or it says it needs a connection, as with none; 10 s for the
reads the app names heavy, the whole notes list and its titles, for a small
server with a big account). One that runs out counts as no connection (`err.offline`),
and the server counts as quiet for 20 s: reads wait 1.5 s, and changes go
into the outbox without being sent, unless one sent before is still waiting
(`queueUnsent`), so the older one can't land last over it. A change that is sent (and the outbox's
replay) has no deadline, as before: one cut off might have landed, and sent
again it could be made twice. Any answer from the server ends that
early, and a read that runs out while quiet doesn't start it again, so a
server slower than 1.5 s is asked at full length when it ends. Reads the app
names slow wait as long as they take: Trace, a link's preview, the
CookTrace list, update checks, exports and backups (`offlineDeadlineMs()` in
`offline-api.js`). Changes it can't queue (imports, version restores,
uploads) wait as long as they take too.


### Label icons

A label's optional `icon` is a Material Symbols name from the fixed list in
`server/lib/label-icons.js`; anything else is saved as no icon.

### Nested labels are names

`Home/Garage` is an ordinary label whose name contains a slash;
`src/lib/label-tree.js` builds the tree for the sidebar and pickers, and a
parent view also shows its nested labels' notes. Renaming a parent renames the
labels under it. Nothing in the schema or sync knows about nesting.

### Link previews are fetched by the server

`server/lib/link-preview.js` fetches the first link on a card through the SSRF
guard (every redirect hop re-checked), reads Open Graph tags
(`link-preview-core.js`, shared with the client and unit tested), and caches
the result in `link_previews` for a week. Images and icons are served only for
pages already in that cache, so the route can't be used as an open proxy.

### Imports parse on the client

Google Keep, Evernote, Blinko, Memos, and Markdown imports are read and parsed in
the browser or WebView (`src/lib/import-export/`, pure modules with
tests) and sent in batches to `POST /api/notes/import`, or written
straight to the on-device database in Android local mode. Memos is read
from the user's Memos server with their access token, which Memos
accepts from any origin. The import returns the id of each created note,
and images are uploaded only for those, so a repeated import uploads
nothing twice. Original dates are kept and
an exact repeat of a note already present is skipped, so importing the
same file twice is harmless. The Markdown export builds its ZIP on the
client from the normal notes API, so it works in every mode, and it
imports back without losing labels, color, reminder, or dates.

### Federation-style calls go through the server

Anything that talks to another service with a secret (AI providers
when locked server-side, push services, webhooks, CookTrace) goes
through this server. Tokens and API keys never reach the browser or
WebView. Keys like the CookTrace token are listed in
`server/lib/server-only-keys.js`, which keeps them out of settings
responses, sync pulls and pushes, and the data export.

Send to CookTrace (`server/lib/cooktrace.js`) calls CookTrace's MCP
endpoint with the user's token (`add_shopping_item`, one call per item),
so it needs nothing new on the CookTrace side beyond turning on MCP
writes. CookTrace addresses pass the same SSRF guard as webhooks.

### Native sync semantics

Order is **pull-then-push** so mobile refreshes against the server's
latest state before propagating local changes. Server-side push uses
`COALESCE(?, existing)` on FK columns so a stale mobile payload
can't clobber a newer server value, and inserts only bind the columns
the client sent so omitted columns fall back to schema defaults.

### Only the app's own addresses get CORS

`server/lib/cors.js` (identical in all four Trace apps) decides which pages
on another address may call the API with the person's sign-in. Allowed: the
Android app's WebView (`https://app.notetrace.local`) and the address in
`PUBLIC_URL`, each compared whole: scheme, host and port. Anything else gets
no CORS headers. The web app calls its own address, which needs none;
the API, MCP and the watch app send no Origin.

### Changes from another site are refused

`server/lib/cross-site.js` (identical in all four Trace apps) runs before
every route: a request that changes something (any method but GET, HEAD and
OPTIONS) passes only when the browser's `Sec-Fetch-Site` is `same-origin` or
`none`, or its `Origin` is one CORS allows (above) or exactly the request's
own address (from `X-Forwarded-Proto` and `X-Forwarded-Host`, or Host), or
it carries neither header (the Android app's native code, the watch app,
MCP, scripts, the other Trace apps' servers). Browsers always send `Origin`
on these methods (`null` from a sandboxed frame or a page that sends no
referrer), and a page can't change it, so a page on any other address, on
the same site or not, can't send a form, a no-cors fetch or an upload that
changes anything, with or without the sign-in cookie. Anything else gets a
403 (`code: "cross_site"`) and one warning in the log per address. Behind a
proxy that passes neither the public `Host` nor `X-Forwarded-Host`, writes
need `PUBLIC_URL` over plain http (no browser sends `Sec-Fetch-Site` there)
and, over https, from older browsers without it (such as Safari before
16.4). It can't tell apart apps that share one origin (two apps under
subpaths of the same host), and a DNS rebinding page counts as the app's own
address.

The CSRF token (`server/middleware/csrf.js`) still guards signed-in
sessions; this also covers a server without accounts, which has no sign-in
for a token to protect. `POST /share-target` is exempt: the system share
sheet sends it, and the server stores nothing there (it answers with a link
to a new note).

## Android Local Mode

NoteTrace on Android runs **standalone (offline-only)** or
**server-connected**, at the user's choice. First-launch wizard at
`src/routes/NativeSetup.svelte` picks the mode; Settings then Server
Connection changes it later.

- **Mode toggle:** `note:nativeMode` in localStorage
  (`'local' | 'server' | null`)
- **Dispatch:** `src/lib/api.js` Proxy picks `_NoteApiHttp` (PWA),
  `NoteApiNative` (native local), or `NoteApiCached` (native + server)
- **Local SQLite:** `src/lib/db-native.js`. Schema mirrors the synced
  server tables, plus `server_id` + `sync_status` columns for sync
  bookkeeping
- **Local CRUD:** `src/lib/api-native.js`
- **Cached impl:** `src/lib/api-cached.js` wraps native + triggers
  debounced background push after every write
- **Sync orchestrator:** `src/lib/sync.js`. 30s background timer +
  visibilitychange resume hook. Server endpoints at
  `/api/sync/push` and `/api/sync/pull`
- **Local backup:** `src/lib/local-backup.js` dumps the local SQLite
  tables + base64-inlined images to a single file
- **Share sheet:** `ShareIntentPlugin.java` hands text shared from other
  apps to `src/lib/share-intent.js`, which opens a prefilled note. The
  PWA does the same through the manifest `share_target` and
  `/share-target`
- **App lock:** `src/lib/app-lock.js` covers the UI with
  `LockScreen.svelte` on launch and after a chosen time in the
  background; unlock is fingerprint, face, or the device credential

## Conventions

- **localStorage prefix:** `note:` (cookies, csrf, cached user)
- **Per-user settings key:** `wl_u<id>_<key>` (legacy, shared with the
  other Trace apps, intentional)
- **Auth cookie:** `note_token`
- **API token prefix:** `note_pat_`
- **Runtime config:** `__NOTE_CONFIG__` injected on `window`
- **Deep-link scheme:** `notetrace://`
- **Android app id:** `com.notetrace.app`
- **Never use `nt` in identifiers.** That prefix belongs to NutriTrace.
- **Comments:** state the non-obvious constraint or say nothing.
  Skip comments that restate the next line

## Build & Release

```bash
npm run dev                    # local dev server
npm run build                  # PWA build to dist/
npm run android:build          # vite build + cap sync android
npm run android:apk:debug      # debug APK
npm run android:apk:release    # release APK (needs keystore.properties)
npm run i18n:check             # duplicate / unresolved i18n keys
```

`android/keystore.properties` (gitignored) configures release signing.
Debug and release builds sign with the same keystore so swapping
between them doesn't trigger Android's signature-mismatch reinstall,
which wipes the local SQLite DB.

## Related Docs

- [`ROADMAP.md`](ROADMAP.md), what's planned
- [`CONTRIBUTING.md`](CONTRIBUTING.md), how to open a PR, i18n rules
