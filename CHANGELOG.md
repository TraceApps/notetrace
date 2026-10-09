# Changelog

All notable changes to NoteTrace are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Added

- **Public links for notes** (#15). The owner can make a read-only link to a note from the Share dialog, for people without an account. It shows the note, its checklist, and its pictures, and nothing about who owns it or who else it's shared with. Chat apps show the note's title, a line of its text, and its first picture. Removing the link stops it at once, and a note in the trash isn't readable until it's restored.

### Changed

- **Trace's attach button offers Camera or Gallery on phones and in the Android app**, the same as the other Trace apps. Each choice goes straight to the camera or the photo picker; on a computer the button opens the file picker.

### Fixed

- **Signing in through SSO with an email that already has an account no longer creates a second account.** When the identity provider doesn't mark the email verified (Authentik's default since 2025.10), the sign-in is refused with a pointer to link the provider from your profile, instead of landing you in a new, empty account.
- **SSO works with Authelia 4.39 and later out of the box.** Email, username and groups are read from the provider's userinfo when the ID token leaves them out.
- **The SSO callback also works without the provider number, and at `/api/oidc/callback`**, the address older docs gave. Both used to end on a blank page.
- **`OIDC_ENABLE_EMAIL_PASSWORD_LOGIN` works for providers added in Settings.** It was ignored unless a provider was also defined through env vars.
- **Signing in on a plain-HTTP address says what's wrong instead of looping.** The sign-in cookie only works over HTTPS unless `INSECURE_COOKIES=1` is set, so signing in from an `http://` address dropped you back on the login page with no error. The sign-in and setup screens now explain it and link to the fix, the app no longer flashes before sending you back, and the server log says so too.
- **Sharing works in the Android app connected to a server.** The Share dialog asked the server about the phone's own copy of the note, so it could show the wrong people or none.
- **Popovers stay on the screen when their contents load late.** The Share dialog opened near the bottom of a note ran off the screen once its list arrived.
- **The app no longer loads behind the sign-in screen.** Opened signed out, it asked the server for your data and was refused before the sign-in screen replaced it. It now waits to learn who is signed in.
- **The installed app works when NoteTrace is served from a subpath.** With `BASE_URL` set (say `/notetrace`), every visit after the first sent the app's requests to the site root instead, online and offline. Thanks @kgenerozov for the fix in LiftTrace and NutriTrace.
- **Trace works with OpenAI-compatible endpoints that stream unless told not to** ([nutritrace#258](https://github.com/TraceApps/nutritrace/issues/258), reported by @jsapede). Chat answers and reading pictures failed with "Unexpected non-whitespace character after JSON"; every request now asks for a single answer.
- **The Android app stores each note once.** The first sync stored every note twice, and a note written offline could go up twice.
- **The Android app no longer writes your notes to the device log.** Debug builds logged every note the app read or saved.
- **Signing out of the Android app with no connection goes to the sign-in screen.** It showed the app with nobody signed in.
- **A note made offline in the Android app keeps the date it was made.** The first sync replaced it with the time the note reached the server.
- **A setting changed in the Android app before it reached the server is no longer lost** when another account signs in on the phone and the sign-in is canceled, or set back when your settings load from the server. It goes up with the next sync.
- **Reminders stop when you sign out of the Android app**, and the previous account's don't fire after another account signs in. Your own come back when you sign back in.
- **Connecting the Android app back to the account it was disconnected from no longer uploads a second copy of every note.** Only what you made, changed or deleted while disconnected goes up.
- **Note templates and other list settings changed in the Android app reach the server intact.** They went up as plain text and came back broken on every device.
- **Closing "Is This the Same Server?" without choosing no longer clears the phone's data.** Nothing is cleared or sent, and the app asks again the next time you sign in.
- **Pull to refresh in the Android app gets what changed on the server while a sync was already running.**
- **A note edited in the Android app after it was deleted elsewhere comes back with your edit on every device**, checklist items included. An edit made before the delete isn't kept: the app removes the note and says so, instead of trying to send it forever.
- **Restoring a backup in the Android app while connected to a server no longer leaves notes out of step.** A backup of the same account catches up with the server without making copies; one from another account or server, or from an older version, goes up as new notes, once, and never changes the other account's.
- **Trace chat cleared on the server leaves the Android app's copy too**, including chat cleared while the phone was disconnected, so it no longer stays on the phone and in its backups. Found while fixing the same bug in LiftTrace ([lifttrace#139](https://github.com/TraceApps/lifttrace/issues/139), reported by @surfingbytes).
- **Trace chat in the Android app reaches the server with Push All, or when you connect with Upload or Merge.** It was refused, stayed counted as a change waiting to sync, and was sent again with every sync.
- **Trace shows your newest messages when you open it.** It loaded the oldest 100, so once a chat passed 100 messages the latest ones never appeared.

### Security

- **The image proxy passes images only.** For its image hosts it passed through whatever came back from the app's own address, a web page included, before sign-in. Anything that isn't an image is refused now, and images can't act as a page.
- **A password reset link can no longer be pointed at someone else's site.** The link took its address from the request, so anyone could ask for another person's reset with a forged host and have the real email, token included, send them to it. Reset, invite emails now link to `PUBLIC_URL` when it's set, or to an address an admin uses. Links also keep the `BASE_URL` subpath now.
- **Names in emails can no longer carry markup.** A name, or a title someone shared, went into the email as-is, so HTML or a link typed into it became real markup in the recipient's inbox. Affected the SMTP test and invite emails. Everything an email shows is escaped now.
- **Link previews, Send to CookTrace and push notifications connect only to the address they checked**, so a name can't answer the check with one address and the connection with another, and they never reach cloud-metadata addresses.
- **Send to CookTrace works with a CookTrace on your own network without `ALLOW_PRIVATE_COOKTRACE_URLS`**, which is no longer used. It only ever calls CookTrace's shopping API.
- **A failed push test no longer shows the other server's raw reply**, and push follows a redirect only on the same server. The open `/api/proxy` checks every redirect too.
- **The Android app's SSO sign-in no longer passes the session token through the `notetrace://` link**, which another app could intercept. The link carries a single-use code that only the app that started the sign-in can redeem.
- **Uploaded files get unguessable names.** The random part of the name was made with `Math.random()`, which can be predicted from its own output.
- **The server answers as the account whose token a request carries, never as the one a leftover sign-in cookie names.** After one account signed out of the Android app and another signed in, the first account's cookie stayed on the phone, so some of the app's requests could be answered, and saved, as the first account. The app also forgets NoteTrace's sign-in cookie whenever the account changes.
- **Signing in to another account in the Android app shows only that account's notes, and downloads all of them.** The previous account's notes stayed on the phone, its changes that hadn't synced went up into the new account, and the new account's older notes never downloaded. If the previous account left changes that haven't synced, the app asks first; Cancel signs out and keeps them for that account. Settings are kept per account and per server, and the home screen widget shows nothing while signed out.
- **The diagnostic log never holds a secret.** It recorded every link the app opened, sign-in codes included, and in diagnostic mode the value of every setting sent to the server, AI API keys included. It now records only which setting changed, and hides anything that looks like a key, token or password.
- **@capacitor/android** bumped 8.3.0 to 8.5.3 and **@capacitor/core** 8.4.0 to 8.5.3, closes [GHSA-rvm3-566m-v7fv](https://github.com/advisories/GHSA-rvm3-566m-v7fv) (critical: a tapped link could load another site's page inside the app as if it were the app, with your sign-in and the app's phone features). The Android app was exposed: a link in a note shared with you as view-only could do this. **@capacitor/ios** moves to 8.5.3 with them; NoteTrace has no iOS app.
- **proxy-addr** bumped 2.0.7 to 2.0.8 on the server, closes [GHSA-jqcg-44mw-7w3h](https://github.com/advisories/GHSA-jqcg-44mw-7w3h) (critical: some IPv6-style trusted-proxy ranges trusted every client's forwarded address). NoteTrace sets no trusted proxy, so it wasn't exposed.
- **@modelcontextprotocol/sdk** bumped 1.30.0 to 1.32.1 on the server, closes [GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h) (high: its OAuth client could send credentials to a server the other side picked). NoteTrace uses only its MCP server, so it wasn't exposed.
- **ip-address** bumped 10.7.0 to 10.7.3 and **fast-uri** 3.1.7 to 3.1.8 on the server, closes [GHSA-j6r3-76f7-8jcv](https://github.com/advisories/GHSA-j6r3-76f7-8jcv), [GHSA-h3mg-xc3c-68pw](https://github.com/advisories/GHSA-h3mg-xc3c-68pw) and [GHSA-hrr3-gc8f-f4qj](https://github.com/advisories/GHSA-hrr3-gc8f-f4qj) (moderate: a subnet check that mixed IPv4 and IPv6, a slow parse of a long address, and inconsistent host names in URLs). Both come in with the MCP SDK, for parts NoteTrace doesn't use, so it wasn't exposed.
- **devalue** bumped 5.9.2 to 5.9.4, closes [GHSA-j22f-vq7h-c4qm](https://github.com/advisories/GHSA-j22f-vq7h-c4qm), [GHSA-mcm9-63f2-9j32](https://github.com/advisories/GHSA-mcm9-63f2-9j32), [GHSA-x5rw-q4pp-hg5g](https://github.com/advisories/GHSA-x5rw-q4pp-hg5g), [GHSA-hx4r-w6wj-j8fg](https://github.com/advisories/GHSA-hx4r-w6wj-j8fg), [GHSA-4q55-j62x-fr9h](https://github.com/advisories/GHSA-4q55-j62x-fr9h) and [GHSA-wf3x-273g-mvxv](https://github.com/advisories/GHSA-wf3x-273g-mvxv) (high: slow or oversized output and a prototype check bypass when serializing data). Only Svelte's server-side rendering uses it, which NoteTrace doesn't, so it wasn't exposed.
- **brace-expansion** (5.0.9 to 5.0.12, 2.1.4 to 2.1.7), **source-map-js** 1.2.1 to 1.2.2 and **fast-uri** 3.1.7 to 3.1.8 in the build tools, closes [GHSA-q2hr-2g5m-vwhr](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr), [GHSA-qhr7-859c-m2p7](https://github.com/advisories/GHSA-qhr7-859c-m2p7), [GHSA-6j4f-fj2g-mc7p](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p), [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) and [GHSA-hrr3-gc8f-f4qj](https://github.com/advisories/GHSA-hrr3-gc8f-f4qj) (high: slow or crashing input). They only run while building NoteTrace, never in the app or server.
- `npm audit` reports 0 vulnerabilities for the app and the server.

---

## [1.1.0-dev03] - 2026-09-29 (pre-release)

A dev pre-release of the 1.1.0 minor. A Support page in Settings, two Settings layout fixes, and security updates.

### Added

- **Settings has a Support page**, next to About: Ko-fi and GitHub Sponsors, plus free ways to help (star the repo, report a bug, translate). It replaces the support row that used to sit in About.

### Changed

- **The in-app updater reuses an update it already downloaded.** Coming back to Updates goes straight to installing instead of downloading the whole APK again, and the button says Install. Older downloads are cleared so they stop piling up on the phone.
- **About links to the TraceApps family** instead of naming the other apps.

### Fixed

- **Settings pages line up with the section list** on desktop and foldables. Every page started 12px below the list beside it.
- **The Settings section list keeps its place** on desktop and foldables. Every click in it scrolled the list back to Profile.

### Security

- **multer** bumped 2.3.0 to 2.4.0, closes [GHSA-3pph-fpjx-jg34](https://github.com/advisories/GHSA-3pph-fpjx-jg34) (moderate: an upload cut off at just the wrong moment could leave its file behind on disk). Uploads and backup restore require signing in.
- **nodemailer** bumped 9.1.1 to 10.0.12 on the server, closes [GHSA-6vj9-mwq6-2f5v](https://github.com/advisories/GHSA-6vj9-mwq6-2f5v) (moderate: separate mail transports could share one TLS server name). Removed from the web app's own dependencies, where nothing used it.
- `npm audit` reports 0 vulnerabilities for the app and the server.

---

## [1.1.0-dev02] - 2026-09-27 (pre-release)

A dev pre-release of the 1.1.0 minor. A first pass at foldables, and search that no longer cares about accents.

### Added

- **Preliminary foldable support.** Half open like a book, the crease becomes a divider rather than something content sits across:
  - Notes are dealt into columns either side of the fold.
  - Settings puts its section list on one side and the section itself on the other.
  - Menus and pickers slide clear instead of being split by it.
  - Trace takes the panel beside the crease. In laptop posture it sits on the flat half, leaving your notes readable on the half standing up.
  - Drawing keeps the whole screen, since an opened foldable is a bigger sheet to draw on.
  - Settings, Diagnostics reports what the hinge is doing, so you can tell whether your phone reports one at all.

### Fixed

- **Accents no longer hide what you were looking for.** Searching notes already ignored them; labels, the [[link]] picker and Settings search did not, so a label called "Mañana" or a note titled "Répétition" went missing unless you typed the accent. They all ignore accents now, the match is highlighted in the result, and local mode on Android answers the same as the server. Text without accents matches exactly as before.
- **A connection problem says what kind it was.** When the app cannot reach your server, the diagnostic log now records the kind of failure and how long it waited. A timeout, an address that would not resolve, a refused connection and a rejected certificate all used to read "Failed to fetch".

### Security

- No dependency changes. `npm audit --omit=dev` reports 0 vulnerabilities for the app and the server.

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

