# Privacy Policy: NoteTrace

**Last updated:** September 13, 2026

## Overview

NoteTrace is a self-hosted notes app. Your data is stored on **your own server**, not on any central server, not in the cloud, and not shared with third parties.

## Data Collection

### What NoteTrace stores on YOUR server:

- Notes (titles, bodies, checklists, images you attach, colors, pin / archive / trash state, reminder times)
- Who each note is shared with, and whether they can view or edit it (only accounts on your own server)
- AI chat history (if Trace is enabled)
- User account information (username, hashed password, optional email, optional display name, optional avatar)
- OIDC SSO links (provider, subject claim)
- API tokens (stored as hashes) and webhook configurations
- App settings and preferences

### What NoteTrace does NOT collect:

- We do not operate any central server that receives your data
- We do not collect analytics, telemetry, or usage statistics
- We do not serve advertisements
- We do not sell, share, or transmit your data to third parties
- We do not use tracking cookies or fingerprinting

## Third-Party Services

NoteTrace connects to the following external services **only when you explicitly enable them**:

- **OIDC providers (Authentik, Keycloak, Pocket-ID, Authelia, Google, Auth0, or any OIDC 1.0 provider).** If admins configure SSO, sign-in is delegated to your chosen identity provider. Client secrets are stored encrypted at rest.
- **AI providers (Claude, OpenAI, Gemini, OpenAI-compatible).** If Trace is enabled, your conversation and any note content you include is sent to the provider you choose. Subject to their respective privacy policies. Your API key is stored on your server, not ours. The "OpenAI Compatible" provider (Ollama, LM Studio, LocalAI, vLLM, and similar) connects directly from the browser to the endpoint you configure; the NoteTrace server never sees those requests in per-user mode.
- **Push notification services (Apprise, Gotify, ntfy).** Optional. If configured, notification content (note reminders, backup-failed alerts) is sent to your push server. Only one provider is active at a time.
- **SMTP (email).** Optional. If configured, password reset emails and user invites are sent via your SMTP provider.
- **Webhooks.** Optional and off by default. If an admin enables them, event payloads are sent to the URLs you configure.
- **GitHub Releases.** The in-app update check reads public release information from GitHub. No account data is sent.

Google Keep (Takeout), Blinko, and Markdown imports are read on your own device or browser and saved only to your own server or on-device database. A Memos import connects from your browser or phone directly to the Memos server you enter, using the access token you paste; the token isn't stored.

## Data Retention

Your data is retained on your server until you delete it. You can:

- Delete individual notes at any time (trashed notes are purged after 30 days)
- Export all your data via JSON export or full backup (ZIP)
- Delete your account and all associated data
- Wipe the database entirely

## Android App

The NoteTrace Android app stores data locally on your device in a SQLite database within the app's private data directory. When connected to a server, data syncs bidirectionally. The app requests the following permissions:

- **Internet.** Server sync, AI chat, in-app updates
- **Camera.** Note photos, Trace image attachments
- **Microphone.** Voice input for Trace
- **Notifications.** Note reminders, backup-failed alerts
- **Biometric.** Optional App Lock and biometric sign-in; fingerprint and face data never leave Android's secure hardware
- **Schedule / use exact alarm.** Note reminders fire at the exact minute, even when the app is closed
- **Receive boot completed.** Re-arm note reminders after a reboot
- **External storage (Android 12 and below).** Save exported backups to your Downloads folder
- **Install packages.** In-app self-updater (`Settings > Updates`) hands the downloaded APK to the system installer

NoteTrace does **not** request Health Connect, contacts, or location permissions.

### Local data at rest

NoteTrace does not add its own SQLite-level encryption (e.g. SQLCipher) on top of the database. Instead, it relies on Android's built-in file-based encryption (FBE), which has been the default on every Android device since Android 7 (2016). FBE encrypts the app's private data directory using a key derived from your device PIN, password, or biometric, so a locked phone is already encrypted at rest.

An attacker with physical access to your *locked* device cannot read your data. An attacker with physical access to your *unlocked* device can read it. Settings > App Lock adds a fingerprint, face, or PIN prompt before the app opens, which keeps notes out of view on an unlocked phone; it's a screen lock, not extra encryption.

Full backups (ZIP exports) are unencrypted by default; keep them in trusted storage if you back up off-device.

## Children's Privacy

NoteTrace is not directed at children under 13. We do not knowingly collect data from children.

## Changes to This Policy

This privacy policy may be updated from time to time. Changes will be noted in the changelog.

## Contact

For privacy questions, open an issue at [github.com/traceapps/notetrace](https://github.com/traceapps/notetrace/issues).
