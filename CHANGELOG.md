# Changelog

All notable changes to NoteTrace are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

---

## [1.1.0-dev01] - 2026-09-24 (pre-release)

A dev pre-release of the 1.1.0 minor. Pictures, settings and your profile now work without a connection, a checklist can be cleared in one tap either way, and update checks are off until you ask for them.

### Added

- **Clear a checklist in one tap.** The checked-items bar now offers **Uncheck All** and **Delete Checked**, each with a single undo. Both work offline, and Uncheck All is on the watch too. ([#7](https://github.com/TraceApps/notetrace/issues/7), requested by @bonsairobo)
- **Pictures work offline.** A picture or drawing added with no connection saves with the note and becomes a file on your server when the queue goes up. One too large to keep says so. Other files still need a connection.
- **Settings changed offline are kept** and go up with everything else, rather than being applied here and forgotten.
- **Your profile works offline, picture included**, the same as in NutriTrace, LiftTrace and CookTrace.

### Fixed

- **The updater can no longer offer a phone the watch build.** Both APKs ship in one release under the same package id, and the updater took whichever was listed first. It now picks the phone's build by name.
- **"A New Version Is Available" on the web says what it means, and Reload works.** It used the Android wording, and the button could do nothing at all. It now says "Update Ready", reloads either way, and a tab left open all day notices new versions again. Same fix in all four Trace apps.
- **The Trace button no longer covers sheets and dialogs.** It stays above the page and below anything opened on top of it. Same fix as NutriTrace [#233](https://github.com/TraceApps/nutritrace/issues/233).
- **Something deleted while online stays deleted when the connection goes.** A stale copy from before sign-in could bring it back.
- **Photos kept offline survive the trip.** They are scaled so your server accepts them, they keep their transparency, and a format this browser can only read (an iPhone's HEIC, say) is converted rather than refused in silence. One that cannot be read at all says it needs a connection.
- **Adding a photo offline works in the installed app.** The code for it was fetched on demand, which is the one moment there is nothing to fetch from.
- **The copy this browser keeps has a ceiling**, and if storage runs out, your unsent work is kept and the copy makes way for it.
- **Nothing waiting is lost at sign-out.** Every way of signing out sends the queue first and asks before discarding it, and the queue is no longer stranded under a name nothing reads after an offline reload.
- **Your profile saves to your account** rather than to local settings when you save it before the app has finished checking your server.
- **Something your server refuses says why** in Settings, Diagnostics, instead of only flashing past.

### Security

- **Update checks are off until you turn them on, and your server does the asking.** Every browser and phone used to ask GitHub directly every 4 hours. Setup now asks, and skipping the question leaves checks off, so a new install contacts nothing on its own. Nothing about you or your instance is sent either way. Existing installs keep checking as before, and `UPDATE_CHECK=off` overrides the setting. Reported on r/selfhosted.
- **Fonts are served by your own instance**, so Google no longer sees the address of everyone who opens the app. They are still split by script, so a page downloads only the alphabets it needs. Medium-weight text also renders correctly in the Android app for the first time. Reported on r/selfhosted.
- No dependency changes. `npm audit --omit=dev` reports 0 vulnerabilities for the app and the server.

---

## [1.0.1] - 2026-09-20

A fix-only release. One editor fix for everyone, three for the Android app.

### Fixed

- **A label no longer sits on top of a long note's text.** In a note long enough to scroll, the text ran past the bottom of its box, so the labels underneath it (and a reminder or share chip) were drawn over the middle of the note. Reported by [@bonsairobo](https://github.com/bonsairobo) in [#8](https://github.com/TraceApps/notetrace/issues/8).
- **Reordering tasks no longer refreshes the page.** In the Android app connected to a server, dragging a reorder handle downward on the Tasks page while it was scrolled to the top was treated as pull-to-refresh and synced. The same applied to checklist and label handles, the voice note scrubber and the list width resizer. Dragging those no longer counts as a pull; pulling down anywhere else still refreshes as before.
- **The Android back button closes what's open first.** Back only closed a drawing, a file or an image before going back a page, so with a note, sheet, dialog or menu open it left the page underneath and took the layer with it. Back now closes the newest layer first, one at a time, the same as its own close button: an open note saves and closes, a menu or picker closes, a dialog closes as Cancel, and the camera stops. In a drawing, back first closes the palette, then clears the selection, then finishes, like Escape, and it no longer leaves the note while a drawing is still saving. The sync merge questions still need an answer, and the app lock can't be dismissed, so back leaves them open. It also closes the slide-out sidebar if that's showing. With nothing open, back goes back a page and then offers to exit, as before.
- **Sheets stay below the status bar.** The shared sheet used across the app and the keyboard shortcuts list. The Android app draws under the status bar, and these were capped only at a share of the screen, so one that filled its cap (a tall one, or any with the keyboard up) could start under the status bar. They now always stop below it and scroll their content instead. Nothing changes where there's room, or on a computer. Same fix as NutriTrace [#228](https://github.com/TraceApps/nutritrace/issues/228).

### Security

- No dependency changes. `npm audit --omit=dev` reports 0 vulnerabilities for the app and the server.

---

## [1.0.0] - 2026-09-19

First stable release. NoteTrace is a self-hosted home for everyday notes: notes, checklists and reminders in a card grid, on your own server, with a web app that works offline, an Android app, and a Wear OS app. It's built to replace Google Keep, the everyday half of Evernote, Apple Notes and the like, and it takes your notes in and gives them back out in open formats.

- **Notes and checklists.** A card grid with pins, colors, nested labels in the order you choose, archive, trash, version history, and full-text search across text, checklist items, voice transcripts and text in images. See [Notes, checklists and labels](https://traceapps.github.io/docs/notetrace/notes/).
- **A real editor.** Markdown underneath, formatting by tap or keyboard, checkboxes inside text notes, links between notes, templates, and print or save as PDF. See the [feature tour](https://traceapps.github.io/docs/notetrace/features/).
- **Reminders and Tasks.** One-off or repeating reminders that keep their local time, exact alarms on Android, and a Tasks view that gathers every item with a due date. See [Reminders](https://traceapps.github.io/docs/notetrace/reminders/).
- **Offline everywhere.** The installed web app keeps working with no connection and syncs when you're back; the Android app runs fully offline or synced with your server; so does the watch. See [Android](https://traceapps.github.io/docs/notetrace/android/).
- **Wear OS.** Your notes, checklists, shopping list and reminders on the watch, with voice capture that turns "tomorrow at nine" into a reminder, a tile, a watch face complication, and full offline use. It pairs itself from the phone and talks to your server directly. See [Wear OS](https://traceapps.github.io/docs/notetrace/wear/).
- **Voice notes and drawings.** Record with the screen off, read a transcript you can tap to jump to that moment, and draw on any note with a pen, marker or highlighter. See [Voice notes](https://traceapps.github.io/docs/notetrace/voice-notes/).
- **Sharing.** Share a note or list with other people on your server, with view or edit access, while pins, labels and reminders stay your own. See [Sharing](https://traceapps.github.io/docs/notetrace/sharing/).
- **Bring your notes with you.** Import from Google Keep, Evernote, Memos, Blinko and Markdown vaults like Obsidian and Joplin (Apple Notes and OneNote through Markdown), and export everything as Markdown with images. See [Import and export](https://traceapps.github.io/docs/notetrace/import-export/).
- **Trace, the optional AI assistant.** Tidy up or summarise a note, turn one into a checklist, or ask Trace to find and change notes for you, with Claude, OpenAI, Gemini or any OpenAI-compatible model. See [Trace in NoteTrace](https://traceapps.github.io/docs/notetrace/trace/).
- **Part of the Trace family.** Your CookTrace shopping list inside NoteTrace, home screen widgets, single sign-on, scheduled backups, webhooks, and an API and MCP endpoint for your own tools. See the [Settings reference](https://traceapps.github.io/docs/notetrace/settings/).

### Security

- `npm audit --omit=dev` reports 0 vulnerabilities for the app and the server. Tokens for linked apps are stored encrypted and never reach the browser, outbound links and webhooks go through an SSRF guard, and uploads are stored under their real type and served with a sandboxing policy.

---

## [1.0.0-dev02] - 2026-09-18 (pre-release)

Second dev pre-release of the 1.0.0 major. Adds the Wear OS app: your notes, checklists, the CookTrace shopping list and reminders on the wrist, with voice capture, a tile, a watch face complication and full offline use. Also fixes the Trace panel running off the top of the screen in phone browsers.

> **Upgrade note.** This release has two APKs: the phone app and, new, the watch app. Install both; the watch pairs itself the next time you open NoteTrace on the phone. Pull the new server image as well, since the watch relies on a new, lighter notes endpoint. The watch still works against an older server, just with bigger downloads and no note previews.

### Added

- **NoteTrace on Wear OS.** A watch app for Wear OS 3 and up, tested on a Pixel Watch 4. It talks to your server directly over Wi-Fi or LTE, so it keeps working with the phone in another room. Your notes and checklists are listed with pinned ones first, the CookTrace shopping list is grouped by aisle, and upcoming reminders are shown soonest first. Tap a checklist to tick items off, or a note to read it. Ticked items drop to the bottom under a heading that counts them, dimmed and struck through, so you can see what you just did and undo a mis-tap. Every screen scrolls with the crown, and ticking gives a small buzz.
- **No typing to set it up.** The watch pairs itself when you sign in on the phone: the phone hands over your server address and a token through the standard Wear data connection. Signing out on the phone removes them from the watch. If the token later expires or is revoked, the watch asks you to pair again instead of showing errors, and keeps anything it had queued.
- **Speak to the watch.** Speak a note from the main screen, add an item from inside a checklist, or add something to buy from the shopping list. The watch's own speech recognition does the work, so nothing is recorded or uploaded, and it uses whatever language the watch is set to. Say a time and it becomes the reminder instead of part of the text: "call the plumber tomorrow at nine" makes a note reading "call the plumber", due at nine tomorrow. It understands the everyday phrasings (in twenty minutes, tonight, tomorrow at nine, Friday at eight, at 6:30 pm) and reads a time already past today as tomorrow. This is worked out on the watch, so it works without a connection.
- **Reminders on the wrist.** A Reminders row appears when anything is scheduled, with times such as "Today 6:30 PM", "Tomorrow" or "Overdue" in red, and repeating ones marked. Tap a reminder to open its note, or tick it to mark it done. When a reminder fires, the phone's notification appears on the watch with Done and Snooze.
- **A tile and a watch face complication.** The tile, one swipe from the watch face, shows what's due or what's left to buy. The complication puts the same count on the watch face itself ("3 Due", "7 Buy"). Both use the watch's saved copy, so they cost no battery or data and still show something useful offline.
- **Works without a connection.** The watch keeps the last lists it loaded, so it opens and works in a shop with no signal. Ticks, spoken notes, added items and finished reminders wait in a queue and are sent when the connection returns. Each action confirms itself ("Note saved", "Reminder set", "Added") and says when it's waiting for a connection. Ticking the same item twice sends once; saying two items adds two.
- **Choose which notes go on the watch.** On the phone, Settings, Notes, On Your Watch. The default is Everything, so nothing changes unless you pick. Choose "Only what I pick" and each note and checklist gets a switch. Clearing every pick shows everything again, so the watch can't end up empty by accident. The setting syncs across your devices, and reminders and the shopping list are never hidden.
- **A lighter notes list for small screens.** `GET /api/notes?slim=1` returns titles, checklist items, a short plain-text preview of each text note, and reminder times, without bodies, attachments or link previews. Add `watch=1` to limit it to the notes picked for the watch. The watch app uses this endpoint, and it suits any small client of your own.

### Changed

- **Reminder notifications show icons on Done and Snooze.** Without icons, a watch shows the notification's buttons as empty circles.

### Fixed

- **The Trace panel fits the screen in phone browsers.** It was sized in `vh`, which on a phone browser measures the viewport without the address bar and toolbar, so the panel's header was pushed off the top. It now uses the visible viewport. The same fix applies to the Send to CookTrace popover, image viewer, Trace actions, version history, image picker and setup wizard. The Android app was not affected.

### Security

- No new dependencies in the web app or server. `npm audit --omit=dev` reports 0 vulnerabilities for both. The watch app adds its own Android libraries (OkHttp, Wear Compose, Tiles, Wear Complications and Play services Wearable). It stores its server address and token in the watch's private app storage, never logs the token, and deletes both when you sign out on the phone.

**Watch testers:** the watch app has had one wrist on it so far. If something feels slow or awkward, or a phrase you say doesn't set the time you meant, open an issue with the watch model and, for a spoken time, what you said.

