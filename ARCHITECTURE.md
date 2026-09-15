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

Two devices editing the same note body resolve by last write, and the
losing version is kept in version history rather than dropped.
Checklist items merge per item (a stable uuid plus tombstones for
deletes), so a device with a stale list can never wipe items another
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

A voice note is an audio attachment with `duration_ms`; an image is an
attachment too. Trace's transcript or the text read from an image is
saved in `extracted_text` on the same row, and the full-text index
covers it (the FTS `items` column is checklist text plus attachment
text; `server/db.js` recreates the FTS triggers on every start, so
existing databases pick up changes). Transcription and image reading
call the user's own AI provider from the browser or phone, like the
Trace chat; when Trace is set by environment variables they go through
`/api/ai/transcribe` and `/api/ai/read-image` instead.

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

### `[[Links]]` are plain Markdown

A link is stored as `[[Title]]` in `body_md` and shown as a chip by a
TipTap node (`src/lib/note-link-extension.js`). Backlinks are a query
over bodies, not a table, so imports and sync need nothing extra.
Renaming a note rewrites `[[Old]]` to `[[New]]` in the owner's own
notes, on the server and in Android local mode. The editor's title
autosaves send `rename_links: false`, and closing the editor sends one
rename from the title it opened with (`rename_links_from`), so partial
titles never rewrite links. A rename is skipped when another note has
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

The Tasks view (`src/routes/Tasks.svelte`) reads the normal notes list and
shows unchecked items; there's no task table. The only new data is
`checklist_items.due_date` (a `YYYY-MM-DD` calendar day, synced with the item),
and `src/lib/due-dates.js` groups items by it. Quick add appends to a checklist
titled "Tasks".

The daily Tasks Due notification follows the reminder paths. The digest text
comes from the pure `server/lib/task-digest-core.js`. On Android,
`src/lib/note-reminders.js` schedules the next 14 digests as alarms with negative
ids, which open `/tasks`. In a browser, `src/lib/web-reminders.js` fires it once a
day while a tab is open. On the server, `server/lib/task-digest.js` runs in the
reminder tick, sends at the user's digest time in their `timezone` setting (until
20:00 if it was down), and records one `tasks_due` row per local date in
`notification_log`.

### The List layout reuses the editor in place

`NoteEditor` takes `inline` to render inside the List layout's side pane
instead of over the page (no portal, backdrop, or open animation). Switching
notes calls the editor's exported `flush()` first so pending text is saved
before the pane is re-keyed. Sections come from `src/lib/list-groups.js`.

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
