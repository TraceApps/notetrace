# Capture API v1

Accept reviewed Markdown notes and native tasks from linked applications such as MailFlow. Off by default: set `CAPTURE_ENABLED=1` and restart the server. Account mode is required. AI and MCP are independent and may remain disabled.

## Tokens

Signed-in users create a `capture:write` token under Settings → API Tokens. It can add captures and inspect capture capabilities, but cannot list or edit existing notes, read note content, or delete notes. Existing admin-only MCP token controls are unchanged. Tokens are hashed at rest, displayed once, rate-limited, revocable, and bound to the user who created them.

The session-authenticated `/api/capture-tokens` routes list, create, and revoke only the caller's capture-only tokens. They cannot grant MCP scopes. They retain normal session authentication and CSRF protection.

## Endpoints

Send `Authorization: Bearer note_pat_…` to both endpoints, including any configured server subpath. Cookie sessions alone cannot authorize capture.

- `GET /api/capture/capabilities`: version, Markdown/task/reminder support, maximum batch size, account name, and non-secret notification configuration hints.
- `POST /api/capture`: atomic import of at most 50 reviewed entries.

```json
{
  "version": 1,
  "request_id": "stable-save-identifier",
  "source": {
    "id": "stable-source-identifier",
    "url": "https://mail.example/?m=message-id",
    "subject": "Invoice",
    "sender": "sender@example.com",
    "date": "2026-10-21T10:00:00Z"
  },
  "entries": [{
    "key": "stable-entry-identifier",
    "kind": "task",
    "title": "Pay invoice",
    "markdown": "[Source email](https://mail.example/?m=message-id)",
    "due_date": "2099-11-10",
    "reminder_at": "2099-11-10T15:00:00Z",
    "time_zone": "America/Chicago",
    "labels": ["MailFlow"],
    "deadline_quote": "Please pay by November 10."
  }]
}
```

For a text note use `kind: "note"` and `markdown` with no task dates. A task is a native one-item checklist with `in_tasks` enabled. Task context remains Markdown in the source metadata; it is not inserted as an extra unchecked task. Note content is stored in `body_md`, never HTML.

Dates must be valid calendar dates. Reminder timestamps require an explicit offset and an IANA time zone. A new reminder in the past is rejected. No default reminder or inferred deadline is added by this API: callers must review and supply those values.

The response returns `version` and `entries` containing `key`, `note_id`, and `status` (`created`, `existing`, or `removed`). Reusing a request ID with the same payload returns the original response with `replayed: true`; changing its payload returns 409. Entry uniqueness is scoped to the token owner, source ID, and entry key. Existing content is not overwritten; a removed capture is not silently recreated. A deliberate copy requires a new entry key. Revoking and replacing a token for the same account retains duplicate protection.

All entries, labels, source metadata, and receipts commit together. Invalid batches create nothing. Source metadata is retained in the database, native sync, backups, and Markdown front matter (`source_json`). Native clients request `capture=1` when pulling; older clients do not receive unknown source columns.

## Reminders

Imported tasks use the existing browser, Android, and server-push reminder channels. Completed, removed, or trashed task cards are filtered before scheduling or sending. Reopening an unfinished task restores its reminder eligibility, subject to the existing occurrence/delivery rules. Completion on another offline device cannot cancel an already scheduled alarm until the devices synchronize.

## Deployment

Deploy NoteTrace capture support before enabling MailFlow's plugin. Rebuild your fork's image; this feature is not present in upstream prebuilt images. Compose forwards `CAPTURE_ENABLED`. Reverse proxies with their own login should pass `/api/capture` directly to NoteTrace; capture endpoints enforce their own bearer token and do not accept cookie authentication. Keep all other proxy rules as they are.

Existing notes, MCP flags and tokens, and reminder behavior for ordinary notes are unchanged. Database migrations add nullable source metadata and account-scoped receipt tables; native storage gains the matching nullable source column.
