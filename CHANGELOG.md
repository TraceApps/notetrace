# Changelog

All notable changes to NoteTrace are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

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

NoteTrace is free and always will be. The [iOS fund](https://traceapps.github.io/docs/support/) is raising $1,300 toward a Mac and an iPhone, so the Trace apps can run properly on iPhone.
