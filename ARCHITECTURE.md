# Architecture

Orientation for new contributors. Covers the shape of the codebase,
the design decisions worth knowing before touching things, and the
house conventions that aren't obvious from reading the source.

## Stack

- **Frontend:** Svelte 4 (compat mode on Svelte 5 runtime), Vite,
  svelte-spa-router v4 (hash routing)
- **Server:** Node + Express 5, better-sqlite3
- **Mobile:** PWA + Capacitor 8 (Android)
- **Deploy:** `docker compose up -d`, container listens on 3001, the
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

### Reminders have two delivery paths

A reminder is stored as its first occurrence (UTC), a repeat, and the
IANA time zone it was set in, so a repeat keeps its wall-clock time
across daylight saving (`nextOccurrence` in `src/lib/reminders.js`,
mirrored in `server/lib/reminders.js`, both covered by tests).

- **Android:** `src/lib/note-reminders.js` rebuilds the scheduled
  local notifications from the note list after every change or sync.
- **Server:** `server/lib/reminder-delivery.js` runs every minute,
  finds occurrences that just came due (up to 2 hours late after a
  restart), and sends each one once, deduped in `notification_log` by
  occurrence time, to the owner's push service and the
  `reminder.fired` webhook.

### Imports parse on the client

Google Keep and Markdown imports are read and parsed in the browser or
WebView (`src/lib/import-export/`, pure modules with tests) and sent
in batches to `POST /api/notes/import`, or written straight to the
on-device database in Android local mode. Original dates are kept and
an exact repeat of a note already present is skipped, so importing the
same file twice is harmless. The Markdown export builds its ZIP on the
client from the normal notes API, so it works in every mode, and it
imports back without losing labels, color, reminder, or dates.

### Federation-style calls go through the server

Anything that talks to another service with a secret (AI providers
when locked server-side, push services, webhooks) goes through this
server. Tokens and API keys never reach the browser or WebView.

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
