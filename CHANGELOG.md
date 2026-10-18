# Changelog

All notable changes to NoteTrace are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Added

- **Streaming for custom Trace providers.** OpenAI-compatible providers such as Strata stream chat replies as they arrive. Editor actions and connection tests also consume streams; server-configured providers forward progress with keep-alives through the proxy and relay. Active streams can run beyond two minutes, while 120 seconds without upstream data still ends a stalled request. Incomplete streams, truncated output and malformed tool calls fail before incomplete edits or tool arguments are used.

- **Custom Trace token limits** ([#23](https://github.com/TraceApps/notetrace/issues/23)). Set maximum output tokens (default 16,384) separately from the loaded context window in Settings > Trace. These settings sync with your account and apply to chat, editor actions, connection tests and the server proxy/relay. Truncated and reasoning-only replies now explain what to change instead of appearing empty; incomplete rewrites are not offered for applying.

- **Expand and Custom Instruction in Ask Trace** ([#23](https://github.com/TraceApps/notetrace/issues/23), requested by @harikiran-lab). Expand turns short notes into full sentences without adding facts. Custom Instruction does what you type ("Translate to Spanish", "Make it a table", "Write it as an email"); its result can replace the note or go below it. As with the others, you see the result first, and the old text stays in version history.
- **Read-only note padlocks** ([#30](https://github.com/TraceApps/notetrace/issues/30)). Lock a card or an open note to prevent accidental typing, cutting, checklist edits, and attachment changes while keeping text selectable for copying. Unlock to edit again. The lock is saved with the note and syncs across devices, including offline web and Android edits. Owners and editing collaborators can unlock it; viewing collaborators stay read-only.
- **Tables in text notes** ([#26](https://github.com/TraceApps/notetrace/issues/26), requested by @harikiran-lab). Add one from the formatting bar or `/table`, move between cells with Tab, and Enter moves down a row, adding one at the bottom; Shift+Enter starts a new line in a cell. In a table the bar has Add Row, Add Column, Delete Row, Delete Column and Delete Table. Tables are saved as Markdown tables (a line break in a cell as `<br>`), so they read the same in Obsidian and other Markdown apps, and print and show on public links. A table pasted from a web page comes in with merged cells split. A wide table scrolls sideways by itself.
- **NoteTrace can be translated on [Weblate](https://hosted.weblate.org/projects/notetrace/).** Pick a language and translate in the browser, no code needed. Settings > Support > Help Translate goes straight there. Each language joins the picker in Settings > Regional & Units once it has translations; anything not yet translated shows in English.
- **Right-to-left writing: Arabic, Hebrew and mixed lines** ([#21](https://github.com/TraceApps/notetrace/issues/21), requested by @mmBesar). Each paragraph, heading, list item, checkbox and quote reads the way its first letter does, so an Arabic line sits on the right with its bullet or box, and Arabic and English in one line come out in the right order. Titles, checklist items, cards, Tasks, the public link page, printing and Trace's chat do the same. How notes are saved doesn't change.
- **The watch app updates itself to the phone's release.** Installed from GitHub, it used to stay on whatever version it was put on with adb. Now, when the phone updates, the watch fetches the same release's watch app and installs it. The first time, the watch asks you to allow NoteTrace to install apps; after that it updates without a tap, while the watch is on its charger.

### Fixed

- **The round Trace button no longer sits dimmed behind an open note** ([#23](https://github.com/TraceApps/notetrace/issues/23)). On a computer it stayed under the note's backdrop where it couldn't be tapped; it now steps aside while a note is open over the page, as it does on a phone; on a text note, Ask Trace in the note's bar is there instead.
- **A note with a Markdown table keeps it.** A table in a note from an import (Obsidian, Joplin), the API or Trace didn't show in the editor, and the next edit saved the note without it. It shows as a table now and stays.
- **Turning on user accounts keeps the admin's email** (found with [nutritrace#269](https://github.com/TraceApps/nutritrace/issues/269)). Settings > Users registered the new admin with the email you entered, then saved the rest of your profile in a way that cleared it. A profile save now leaves alone any field it doesn't include. Thanks @jsapede.
- **Saving your Profile works in the Android app with a server, and in the browser no longer depends on the browser's storage** (found with [nutritrace#269](https://github.com/TraceApps/nutritrace/issues/269)). In the Android app connected to a server, every save failed with "Could not save profile" before anything reached the server. In the browser, a save failed the same way when the browser refused this site storage, and when something else was waiting to go up it waited behind it. With a connection it now goes straight up, an earlier profile save still waiting is replaced rather than sent after it, and Profile says when it needs a connection or when this browser couldn't keep it. A save kept for later no longer makes the app forget who is signed in. Thanks @jsapede.
- **Signing in with SSO finishes on phones with an older Android System WebView.** On older WebView versions (seen on 124), the app didn't recognize the sign-in return from the browser, so the sign-in page closed and the app stayed signed out. A home screen shortcut tapped while NoteTrace was already open did nothing there either.
- **Trace connects the first time its settings are filled in** ([#18](https://github.com/TraceApps/notetrace/issues/18)). Whichever setting was filled in last (usually the API key) said "Fill in provider, API key, and model first", or on a new install did nothing at all, and the chat button stayed hidden until a setting was changed again. **Test Connection** now has its own row, so a test can be run at any time (as suggested in [#27](https://github.com/TraceApps/notetrace/pull/27)). Thanks @harikiran-lab for the report and the suggestion.
- **OpenAI Compatible accepts a Base URL with or without `/v1`**, or the whole `/v1/chat/completions` address, in Settings and in `AI_BASE_URL` ([#18](https://github.com/TraceApps/notetrace/issues/18)). Given with `/v1`, every request went to `/v1/v1/chat/completions`.
- **OpenAI Compatible works without an API key**, for servers that need none (Ollama, LM Studio). The connection test asked for one, so the chat button never appeared.
- **When Trace gets no answer from your provider, it says what to check** instead of "Failed to fetch": the Base URL, or a server that has to allow this site on every answer, errors included, or an https:// address for a page on HTTPS. A reverse proxy that adds CORS headers only to successful answers hid the provider's real error, such as a model that can't use tools ([#18](https://github.com/TraceApps/notetrace/issues/18)).

---

## [1.1.2] - 2026-10-14

Patch release: public note links open behind a reverse proxy that has its own login.

### Fixed

- **A public link opens when NoteTrace sits behind a reverse proxy with its own login** ([#22](https://github.com/TraceApps/notetrace/issues/22)). The page fetched the note without the browser's proxy login, so the proxy refused it and the page said it couldn't load the note. For people without that login to open your links, leave `/n/`, `/api/n/` and the app's files open in the proxy ([Public links behind a login](https://traceapps.github.io/docs/getting-started/reverse-proxy/#public-links-behind-a-login)). Thanks @harikiran-lab for the report.

### Security

- No security fixes this cycle. `npm audit` reports 0 vulnerabilities for the app and the server.

---

## [1.1.1] - 2026-10-12

Patch release: public note links open again in browsers where NoteTrace has been used.

### Fixed

- **A public link no longer opens a blank page** ([#22](https://github.com/TraceApps/notetrace/issues/22)). In a browser where NoteTrace had been used, the app's cached copy answered the link instead of your server: always for a link with a query after it (like the `?fbclid=` chat apps add), and for any link while the browser still ran an older version's copy. A mistyped or cut-off link now says the link isn't available, instead of opening the sign-in page. Thanks @harikiran-lab for the report.

### Security

- No security fixes this cycle. `npm audit` reports 0 vulnerabilities for the app and the server.

---

## [1.1.0] - 2026-10-11

Minor release. Big themes: public links for notes, clearing a checklist in one tap, pictures and settings that work with no connection, foldable layouts that use the crease, a round of Android sync and account fixes, SSO fixes, and security hardening.

> **Upgrade note.** Nothing to change for most installs. Three things to know:
>
> - **Set `PUBLIC_URL`** if people get password reset or invite emails. Those links now use it, or else an address an admin has opened the app at; until an admin has opened the app once, no reset email goes out.
> - **SSO with an unverified email.** If your provider doesn't mark emails verified (Authentik's default since 2025.10), a sign-in that would have matched an existing account by email is refused. Link the provider from **Profile** once.
> - **Update the Android app too.** Most sync and account fixes, and the critical Capacitor fix, are in the app.

### Added

- **Public links for notes** ([#15](https://github.com/TraceApps/notetrace/issues/15)). From the Share dialog, the owner can make a read-only link for people without an account. It shows the note, its checklist and its pictures, never who owns it or who else it's shared with, and chat apps show a preview of it. Removing the link stops it at once. Thanks @Firnin for the idea.
- **Clear a checklist in one tap** ([#7](https://github.com/TraceApps/notetrace/issues/7)). The checked-items bar offers **Uncheck All** and **Delete Checked**, each with a single undo. Both work offline, and Uncheck All is on the watch too. Thanks @bonsairobo for the request.
- **Pictures work offline.** A picture or drawing added with no connection saves with the note and becomes a file on your server when the queue goes up. Photos are scaled so your server accepts them and keep their transparency, and a format the browser can only read (an iPhone's HEIC, say) is converted. Other files still need a connection.
- **Settings and your profile work offline**, picture included, and go up with everything else.
- **Settings has a Support page**, next to About: Ko-fi and GitHub Sponsors, plus free ways to help (star the repo, report a bug, translate).

### Changed

- **Foldables use the crease instead of reaching across it.** Half open like a book:
  - Notes are dealt into columns either side of the fold.
  - Settings puts its section list on one side and the section itself on the other, at any width.
  - Menus and pickers slide clear of the crease, while drawing keeps the whole screen.
  - Trace takes a panel of its own. In laptop posture it sits on the flat half, leaving your notes readable on the half standing up.
  - Settings, Diagnostics reports what the hinge is doing, open flat included, so you can tell whether your phone reports one at all.
- **Trace's attach button offers Camera or Gallery** on phones and in the Android app, the same as the other Trace apps.
- **Trace's model lists are current.** Claude Haiku 5.5 is the new default; Claude Sonnet 5.5 and Opus 5.5, GPT-6 Luna, GPT-5.6 Sol, and Gemini 3.8 Flash and 3.1 Flash Lite are added; Gemini 3.1 Pro is listed as the preview it is; and Gemini 2.5 leaves the list (open to existing Google users only). A model you already chose keeps working, and shut-down Gemini models switch to the default.
- **The in-app updater reuses an update it already downloaded.** Coming back to Updates goes straight to installing, and the button says Install. Older downloads are cleared.
- **Send to CookTrace reaches a CookTrace on your own network without `ALLOW_PRIVATE_COOKTRACE_URLS`**, which is no longer used. It only ever calls CookTrace's shopping API.
- **About links to the TraceApps family** instead of naming the other apps.

### Fixed

- **SSO no longer creates a second account for an email that already has one.** When the provider doesn't mark the email verified, the sign-in is refused with a pointer to link the provider from your profile.
- **SSO works with Authelia 4.39 and later out of the box.** Email, username and groups are read from the provider's userinfo when the ID token leaves them out.
- **The SSO callback works without the provider number, and at `/api/oidc/callback`**, the address older docs gave. Both ended on a blank page.
- **`OIDC_ENABLE_EMAIL_PASSWORD_LOGIN` works for providers added in Settings.** It was ignored unless a provider was also set through env vars.
- **Signing in on a plain-HTTP address explains what's wrong instead of looping.** The sign-in and setup screens link to the fix (HTTPS, or `INSECURE_COOKIES=1`), the server log says so too, and every doc explains `INSECURE_COOKIES` the same way.
- **A connection problem says what kind it was** ([#11](https://github.com/TraceApps/notetrace/issues/11)). The diagnostic log records whether it was a timeout, an address that wouldn't resolve, a refused connection or a rejected certificate, where all of them used to read "Failed to fetch". Thanks @mmBesar for the report.
- **A fresh install opens on setup**, not a welcome screen saying it's offline, and the app no longer loads behind the sign-in screen asking for data it would be refused.
- **The Android app says when a server isn't set up yet**, instead of saying it can't be reached. `/api/health` answers before setup too, so a container healthcheck passes from the first start.
- **The installed app works when NoteTrace is served from a subpath** (`BASE_URL`). Thanks @kgenerozov for the fix in LiftTrace and NutriTrace.
- **Accents no longer hide what you're looking for.** Labels, the [[link]] picker and Settings search ignore them like note search already did, so "Mañana" turns up when you type "manana".
- **Trace works with models that can't use tools** ([nutritrace#259](https://github.com/TraceApps/nutritrace/issues/259)), and **with OpenAI-compatible endpoints that stream unless told not to** ([nutritrace#258](https://github.com/TraceApps/nutritrace/issues/258)). With a model without tool support it answers without them and says once that it can't search or change your notes. Thanks @jsapede for both reports.
- **Trace shows your newest messages when you open it**, not the oldest 100.
- **The Trace button no longer covers sheets and dialogs.**
- **"Update Ready" on the web reloads**, instead of using the Android wording with a button that could do nothing, and a tab left open all day notices new versions again.
- **The updater can no longer offer a phone the watch build.**
- **Settings pages line up with the section list, and the list keeps its place**, on desktop and foldables.
- **Popovers stay on the screen when their contents load late**, and long pop-up messages wrap instead of running off it.
- **Sharing works in the Android app connected to a server.** The Share dialog could show the wrong people or none.
- **The Android app stores each note once.** The first sync stored every note twice, a note written offline could go up twice, and reconnecting to the same account uploaded a second copy of every note.
- **The Android app syncs half as often, and does less when nothing changed.** One sync runs while the app is on screen, instead of two with one still running in the background.
- **A note made offline in the Android app keeps the date it was made**, instead of the time it reached the server.
- **Settings changed in the Android app reach the server intact.** A change made before it synced is no longer lost or set back, and note templates and other list settings no longer come back broken.
- **Reminders stop when you sign out of the Android app**, and another account's don't fire for you.
- **Signing out of the Android app with no connection goes to the sign-in screen**, and closing "Is This the Same Server?" without choosing no longer clears the phone's data.
- **A note edited in the Android app after it was deleted elsewhere comes back with your edit on every device.** An edit made before the delete is dropped, and the app says so.
- **Restoring a backup in the Android app while connected to a server keeps notes in step**, without copies, and pull to refresh gets what changed while a sync was already running.
- **Trace chat stays in step between the Android app and the server.** Chat cleared on the server is cleared on the phone too, found while fixing the same bug in LiftTrace ([lifttrace#139](https://github.com/TraceApps/lifttrace/issues/139)); thanks @surfingbytes for the report.
- **Debug builds of the Android app no longer write your notes to the device log.**
- **The web app keeps what you did offline.** Something deleted while online stays deleted when the connection goes, the copy the browser keeps has a ceiling and makes way for unsent work, every way of signing out sends the queue first and asks before discarding it, and a change your server refuses says why in Settings, Diagnostics.

### Security

- **Update checks are off until you turn them on, and your server does the asking.** Every browser and phone used to ask GitHub directly every 4 hours. Setup now asks, so a new install contacts nothing on its own; existing installs keep checking, and `UPDATE_CHECK=off` overrides the setting. Reported on r/selfhosted.
- **Fonts are served by your own instance**, so Google no longer sees the address of everyone who opens the app. Reported on r/selfhosted.
- **Password reset and invite emails can no longer be pointed at someone else's site.** Their links took the address from the request, so a forged host could send someone's reset token elsewhere. They now use `PUBLIC_URL`, or an address an admin uses, and keep the `BASE_URL` subpath.
- **Names in emails can no longer carry markup.** A name or shared title went into invite and SMTP test emails as-is.
- **The image proxy passes images only**, and an image can't act as a page. Before sign-in it passed on whatever its image hosts sent back, a web page included.
- **Link previews, Send to CookTrace and push notifications connect only to the address they checked**, never to cloud-metadata addresses. A failed push test no longer shows the other server's raw reply, push follows a redirect only on the same server, and `/api/proxy` checks every redirect.
- **The Android app's SSO sign-in no longer passes the session token through the `notetrace://` link**, which another app could intercept. It carries a single-use code that only the app that started the sign-in can redeem.
- **The server answers as the account a request's token names, never as a leftover sign-in cookie.** After switching accounts in the Android app, some requests could be answered, and saved, as the previous account.
- **Signing in to another account in the Android app shows only that account's notes, and downloads all of them.** The previous account's notes stayed on the phone and its unsynced changes went into the new account. If any are left unsynced, the app asks first. Settings are kept per account and per server.
- **The diagnostic log never holds a secret.** It recorded sign-in codes and, in diagnostic mode, setting values, AI API keys included.
- **Uploaded files get unguessable names.** Their random part came from `Math.random()`, which can be predicted from its own output.
- **Dependency updates:**
  - **@capacitor/android** 8.3.0 and **@capacitor/core** 8.4.0 to 8.5.3, closes [GHSA-rvm3-566m-v7fv](https://github.com/advisories/GHSA-rvm3-566m-v7fv) (critical: a tapped link could load another site's page inside the app, with your sign-in and the app's phone features). The Android app was exposed through a link in a note shared with you as view-only. **@capacitor/ios** moves with them; NoteTrace has no iOS app.
  - **nodemailer** 9.1.1 to 10.0.12 on the server (and out of the web app, where nothing used it), closes [GHSA-v53p-9fqp-m79j](https://github.com/advisories/GHSA-v53p-9fqp-m79j) and [GHSA-prgh-xp8r-p3m5](https://github.com/advisories/GHSA-prgh-xp8r-p3m5) (high: slow parsing of crafted addresses), [GHSA-8vvx-rff5-p5rq](https://github.com/advisories/GHSA-8vvx-rff5-p5rq), [GHSA-g57g-f23g-4646](https://github.com/advisories/GHSA-g57g-f23g-4646) and [GHSA-6vj9-mwq6-2f5v](https://github.com/advisories/GHSA-6vj9-mwq6-2f5v) (moderate). NoteTrace mails only addresses saved on accounts or typed by an admin, so these needed a signed-in account.
  - **multer** 2.3.0 to 2.4.0, closes [GHSA-3pph-fpjx-jg34](https://github.com/advisories/GHSA-3pph-fpjx-jg34) (moderate: an upload cut off at the wrong moment could leave its file on disk). Uploads require signing in.
  - **proxy-addr** 2.0.7 to 2.0.8, closes [GHSA-jqcg-44mw-7w3h](https://github.com/advisories/GHSA-jqcg-44mw-7w3h) (critical). NoteTrace sets no trusted proxy, so it wasn't exposed.
  - **@modelcontextprotocol/sdk** 1.30.0 to 1.32.1, closes [GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h) (high), with **ip-address** 10.7.0 to 10.7.3 and **fast-uri** 3.1.7 to 3.1.8, closes [GHSA-j6r3-76f7-8jcv](https://github.com/advisories/GHSA-j6r3-76f7-8jcv), [GHSA-h3mg-xc3c-68pw](https://github.com/advisories/GHSA-h3mg-xc3c-68pw) and [GHSA-hrr3-gc8f-f4qj](https://github.com/advisories/GHSA-hrr3-gc8f-f4qj) (moderate). They sit in parts of the SDK NoteTrace doesn't use, so it wasn't exposed.
  - **devalue** 5.9.2 to 5.9.4, closes [GHSA-j22f-vq7h-c4qm](https://github.com/advisories/GHSA-j22f-vq7h-c4qm), [GHSA-mcm9-63f2-9j32](https://github.com/advisories/GHSA-mcm9-63f2-9j32), [GHSA-x5rw-q4pp-hg5g](https://github.com/advisories/GHSA-x5rw-q4pp-hg5g), [GHSA-hx4r-w6wj-j8fg](https://github.com/advisories/GHSA-hx4r-w6wj-j8fg), [GHSA-4q55-j62x-fr9h](https://github.com/advisories/GHSA-4q55-j62x-fr9h) and [GHSA-wf3x-273g-mvxv](https://github.com/advisories/GHSA-wf3x-273g-mvxv) (high). Only Svelte's server-side rendering uses it, which NoteTrace doesn't.
  - **brace-expansion** (5.0.9 to 5.0.12, 2.1.4 to 2.1.7), **source-map-js** 1.2.1 to 1.2.2 and **fast-uri** 3.1.7 to 3.1.8 in the build tools, closes [GHSA-q2hr-2g5m-vwhr](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr), [GHSA-qhr7-859c-m2p7](https://github.com/advisories/GHSA-qhr7-859c-m2p7), [GHSA-6j4f-fj2g-mc7p](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p) and [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) (high: slow or crashing input). They only run while building NoteTrace.
- `npm audit` reports 0 vulnerabilities for the app and the server.

---

## [1.1.0-dev04] - 2026-10-09 (pre-release)

A dev pre-release of the 1.1.0 minor. Public links for notes, SSO fixes, a round of Android sync fixes, and security updates.

### Added

- **Public links for notes** (#15). From the Share dialog, the owner can make a read-only link for people without an account. It shows the note, its checklist and its pictures, never who owns it or who else it's shared with, and chat apps show a preview of it. Removing the link stops it at once.

### Changed

- **Trace's attach button offers Camera or Gallery** on phones and in the Android app, the same as the other Trace apps.
- **Send to CookTrace reaches a CookTrace on your own network without `ALLOW_PRIVATE_COOKTRACE_URLS`**, which is no longer used. It only ever calls CookTrace's shopping API.

### Fixed

- **SSO no longer creates a second account for an email that already has one.** When the provider doesn't mark the email verified (Authentik's default since 2025.10), the sign-in is refused with a pointer to link the provider from your profile.
- **SSO works with Authelia 4.39 and later out of the box.** Email, username and groups are read from the provider's userinfo when the ID token leaves them out.
- **The SSO callback works without the provider number, and at `/api/oidc/callback`**, the address older docs gave. Both ended on a blank page.
- **`OIDC_ENABLE_EMAIL_PASSWORD_LOGIN` works for providers added in Settings.** It was ignored unless a provider was also set through env vars.
- **Signing in on a plain-HTTP address explains what's wrong instead of looping.** The sign-in and setup screens link to the fix (HTTPS, or `INSECURE_COOKIES=1`), and the server log says so too.
- **The app no longer loads behind the sign-in screen**, where it asked the server for your data and was refused.
- **The installed app works when NoteTrace is served from a subpath** (`BASE_URL`). Thanks @kgenerozov for the fix in LiftTrace and NutriTrace.
- **Trace works with OpenAI-compatible endpoints that stream unless told not to** ([nutritrace#258](https://github.com/TraceApps/nutritrace/issues/258), reported by @jsapede). Chat and reading pictures failed with "Unexpected non-whitespace character after JSON".
- **Trace shows your newest messages when you open it**, not the oldest 100.
- **Popovers stay on the screen when their contents load late.** The Share dialog opened near the bottom of a note ran off the screen.
- **Sharing works in the Android app connected to a server.** The Share dialog could show the wrong people or none.
- **The Android app stores each note once.** The first sync stored every note twice, a note written offline could go up twice, and reconnecting to the same account uploaded a second copy of every note.
- **A note made offline in the Android app keeps the date it was made**, instead of the time it reached the server.
- **Debug builds of the Android app no longer write your notes to the device log.**
- **Signing out of the Android app with no connection goes to the sign-in screen**, not the app with nobody signed in.
- **Settings changed in the Android app reach the server intact.** A change made before it synced is no longer lost or set back, and note templates and other list settings no longer come back broken.
- **Reminders stop when you sign out of the Android app**, and another account's don't fire for you. Yours come back when you sign back in.
- **Closing "Is This the Same Server?" without choosing no longer clears the phone's data.** The app asks again the next time you sign in.
- **Pull to refresh gets what changed on the server while a sync was already running.**
- **A note edited in the Android app after it was deleted elsewhere comes back with your edit on every device**, checklist items included. An edit made before the delete is dropped, and the app says so.
- **Restoring a backup in the Android app while connected to a server keeps notes in step.** A backup of the same account catches up without copies; one from another account, server or version goes up once as new notes.
- **Trace chat stays in step between the Android app and the server.** Chat cleared on the server is cleared on the phone and in its backups too, found while fixing the same bug in LiftTrace ([lifttrace#139](https://github.com/TraceApps/lifttrace/issues/139), reported by @surfingbytes). Chat from the phone reaches the server instead of being sent again with every sync.

### Security

- **The image proxy passes images only**, and an image can't act as a page. Before sign-in it passed on whatever its image hosts sent back, a web page included, from the app's own address.
- **Password reset and invite emails can no longer be pointed at someone else's site.** Their links took the address from the request, so a forged host could send someone's reset token elsewhere. They now use `PUBLIC_URL` when it's set, or an address an admin uses, and keep the `BASE_URL` subpath.
- **Names in emails can no longer carry markup.** A name or shared title went into invite and SMTP test emails as-is.
- **Link previews, Send to CookTrace and push notifications connect only to the address they checked**, never to cloud-metadata addresses. A failed push test no longer shows the other server's raw reply, push follows a redirect only on the same server, and `/api/proxy` checks every redirect.
- **The Android app's SSO sign-in no longer passes the session token through the `notetrace://` link**, which another app could intercept. It carries a single-use code that only the app that started the sign-in can redeem.
- **The server answers as the account a request's token names, never as a leftover sign-in cookie.** After switching accounts in the Android app, some requests could be answered, and saved, as the previous account.
- **Signing in to another account in the Android app shows only that account's notes, and downloads all of them.** The previous account's notes stayed on the phone and its unsynced changes went into the new account. If any are left unsynced, the app asks first. Settings are kept per account and per server.
- **The diagnostic log never holds a secret.** It recorded sign-in codes and, in diagnostic mode, setting values, AI API keys included.
- **Uploaded files get unguessable names.** Their random part came from `Math.random()`, which can be predicted from its own output.
- **@capacitor/android** bumped 8.3.0 to 8.5.3 and **@capacitor/core** 8.4.0 to 8.5.3, closes [GHSA-rvm3-566m-v7fv](https://github.com/advisories/GHSA-rvm3-566m-v7fv) (critical: a tapped link could load another site's page inside the app, with your sign-in and the app's phone features). A link in a note shared with you as view-only could do this. **@capacitor/ios** moves to 8.5.3 with them; NoteTrace has no iOS app.
- **proxy-addr** bumped 2.0.7 to 2.0.8 on the server, closes [GHSA-jqcg-44mw-7w3h](https://github.com/advisories/GHSA-jqcg-44mw-7w3h) (critical: some IPv6-style trusted-proxy ranges trusted every client). NoteTrace sets no trusted proxy, so it wasn't exposed.
- **@modelcontextprotocol/sdk** bumped 1.30.0 to 1.32.1 on the server, closes [GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h) (high: its OAuth client could send credentials to a server the other side picked). NoteTrace uses only its MCP server, so it wasn't exposed.
- **ip-address** bumped 10.7.0 to 10.7.3 and **fast-uri** 3.1.7 to 3.1.8 on the server, closes [GHSA-j6r3-76f7-8jcv](https://github.com/advisories/GHSA-j6r3-76f7-8jcv), [GHSA-h3mg-xc3c-68pw](https://github.com/advisories/GHSA-h3mg-xc3c-68pw) and [GHSA-hrr3-gc8f-f4qj](https://github.com/advisories/GHSA-hrr3-gc8f-f4qj) (moderate). Both come in with the MCP SDK, for parts NoteTrace doesn't use, so it wasn't exposed.
- **devalue** bumped 5.9.2 to 5.9.4, closes [GHSA-j22f-vq7h-c4qm](https://github.com/advisories/GHSA-j22f-vq7h-c4qm), [GHSA-mcm9-63f2-9j32](https://github.com/advisories/GHSA-mcm9-63f2-9j32), [GHSA-x5rw-q4pp-hg5g](https://github.com/advisories/GHSA-x5rw-q4pp-hg5g), [GHSA-hx4r-w6wj-j8fg](https://github.com/advisories/GHSA-hx4r-w6wj-j8fg), [GHSA-4q55-j62x-fr9h](https://github.com/advisories/GHSA-4q55-j62x-fr9h) and [GHSA-wf3x-273g-mvxv](https://github.com/advisories/GHSA-wf3x-273g-mvxv) (high). Only Svelte's server-side rendering uses it, which NoteTrace doesn't, so it wasn't exposed.
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
