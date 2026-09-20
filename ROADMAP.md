# Roadmap

Planned work, grouped by stage. No commitment to exact timing.
Items marked ~~strikethrough~~ have been implemented.

---

## Foundation

- ~~Accounts, user management, OIDC SSO~~
- ~~Full-database backups, scheduled auto-backups, restore~~
- ~~Android app with offline local mode and server sync~~
- ~~In-app updates (Stable and Dev channels)~~
- ~~Trace AI assistant (multi-provider)~~
- ~~Push notifications via Apprise, Gotify, ntfy~~
- ~~API tokens, webhooks, MCP endpoint~~

## Core Notes

- ~~Notes grid with pinned section and a quick-capture bar~~
- ~~Rich editor that stores Markdown~~
- ~~Checklists (text and checklist notes, switchable), drag to reorder~~
- ~~Pin, archive, trash (30-day purge)~~
- ~~Labels with colors, note colors~~
- ~~Full-text search across titles, bodies, and checklist items~~
- ~~Version history with one-tap restore~~
- Uncheck All and Delete Checked on a checklist, from the checked-items bar, with Undo, on the web, Android, and the watch ([#7](https://github.com/TraceApps/notetrace/issues/7))

## Android and Sync

- ~~Note sync with per-item checklist merge~~
- ~~Capture text and links from the Android share sheet~~
- ~~Capture images from the Android share sheet~~
- ~~Native reminders on Android~~
- ~~Biometric app lock~~
- ~~Editing offline in the browser, with an outbox that syncs when you're back~~
- Attachments offline in the browser: hold an image, voice note, drawing, or file on the device and upload it when the connection is back (today they need a connection; text, checklists, colors, labels, and reminders already work offline)
- Sharing, version history, and imports while offline: they need the server today, and say so

## Sharing and Import

- ~~Shared notes and lists with view or edit access~~
- ~~Reminders with repeats (daily, weekly, monthly, yearly) delivered through push~~
- ~~Google Takeout import (Google Keep notes, checklists, images, drawings, labels, colors, links)~~
- ~~Markdown import (Obsidian, Joplin, and other Markdown exports), with images~~
- ~~Memos import from a Memos server~~
- ~~Evernote import (.enex, with images, checklists, tags, and reminders)~~
- ~~Blinko backup import~~
- ~~Share photos into the installed web app~~
- ~~Start Page setting~~
- ~~Markdown ZIP export, with images~~
- ~~Image attachments on notes~~
- ~~Reminder notifications in the browser~~

## Advanced

- ~~`[[Note title]]` links with a Linked From section~~
- ~~Timeline view alongside the grid~~
- ~~Voice notes with transcription~~
- ~~Quick voice notes (capture bar, hold +, home screen shortcuts) with suggested titles~~
- ~~Recorder pause and level meter; waveform player with speed and resume~~
- ~~Voice notes from audio files, shared audio, and Google Keep recordings~~
- ~~Timestamped transcripts and long recordings split for transcription~~
- ~~Android recording with the screen off, up to 3 hours~~
- ~~Text search inside images~~
- ~~Trace AI note tools: tidy, summarize, ask your notes~~
- ~~Note webhook events~~
- ~~MCP note tools~~
- ~~CookTrace integration: send a checklist to a CookTrace shopping list~~

## Polish

- ~~Sidebar that collapses to icons, with a sliding highlight, a reminders-due badge, sync status, and foldable labels~~
- ~~Shared with Me view~~
- ~~Search filter chips (type, color, label)~~
- ~~Select several notes and act on them at once~~
- ~~Link previews on note cards~~
- ~~Drag notes into your own order~~
- ~~Keyboard shortcuts and slash commands~~
- ~~Compact card density~~
- ~~Nested labels~~
- ~~Swipe to archive and pull to refresh on phones~~
- ~~Card-to-editor animation~~
- ~~Tasks view of open checklist items, with due dates on items~~
- ~~List layout with grouping and a side pane on wide screens~~
- ~~Two-pane List workspace with a resizable list column~~
- ~~Foldables: Auto navigation, per-screen layouts, fold-aware book and tabletop layouts~~
- ~~Label icons~~
- ~~Big libraries: notes drawn a screenful at a time~~
- ~~Offline in the installed web app, with voice uploads that retry~~
- ~~Undo for deleted items, attachments, and text/checklist switches~~
- ~~Search: marked matches, voice and image hits, recent searches~~
- ~~Title band on cards~~
- ~~Due date notifications for checklist items~~
- ~~Trace and MCP tools for tasks and due dates~~

## Wear OS Companion

- ~~Home screen with pinned notes, checklists, and upcoming reminders~~
- ~~Check off checklist items from the watch~~
- ~~Read a note on the watch~~
- ~~The CookTrace shopping list, grouped by aisle, checked off as you shop~~
- ~~Voice capture: a note, an item on a checklist, or something to buy~~
- ~~Reminder actions (Done, Snooze) on the notification, and finishing one in the app~~
- ~~Tile and watch-face complication~~
- ~~Works with no connection: the last lists, with an outbox for anything done offline~~
- ~~Voice capture that spots a time and sets the reminder with it~~
- ~~A picker for which notes go on the watch, for a library too big to scroll on a wrist~~
- ~~Wear OS APK published with each release, alongside the phone one~~
