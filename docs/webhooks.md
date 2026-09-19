# Outgoing Webhooks

Point NoteTrace at a URL and it fires a signed HTTP POST the instant
something happens: a note is created, a checklist is fully checked off,
or a reminder comes due. Useful for wiring NoteTrace into n8n, Home
Assistant, or any other automation without polling. Off by default.

## Enabling it

```
WEBHOOKS_ENABLED=1
```

Optionally, to allow a webhook target on a private or loopback address
(a same-Docker-network Home Assistant instance, for example):

```
ALLOW_PRIVATE_WEBHOOK_URLS=1
```

## Configuring a webhook

Settings, Webhooks (admin, multi-user mode only, a webhook needs a real
account to own it). Provide a target URL and pick which events to
subscribe to. A secret is generated automatically (or you can supply
your own), shown exactly once, save it, it is needed to verify
signatures on the receiving end and cannot be retrieved again later.

## Events

| Event | Fires when |
|---|---|
| `note.created` | A new note is created, from any device. |
| `checklist.completed` | Every item on a checklist note has been checked off. |
| `reminder.fired` | A note reminder comes due. |

Imports don't fire `note.created`, so importing a large Google Keep
export doesn't flood a receiver.

## Payload

Every delivery is a JSON POST with this envelope:

```json
{
  "event": "note.created",
  "timestamp": "2026-09-12T14:30:00.000Z",
  "data": { ... event-specific ... }
}
```

Event data:

```json
// note.created
{ "note_id": 42, "title": "Groceries", "kind": "checklist" }

// checklist.completed
{ "note_id": 42, "title": "Groceries" }

// reminder.fired (one delivery per occurrence of a repeating reminder)
{ "note_id": 42, "title": "Water the plants", "reminder_at": "2026-09-14T12:00:00.000Z", "repeat": "weekly" }
```

`reminder.fired` goes to the note's owner. It fires within about a
minute of the reminder time, and a server that was down at that moment
still sends it if it's back within two hours.

## Verifying a delivery

Each request carries:

```
X-NoteTrace-Signature: sha256=<hex hmac-sha256 of the exact raw request body, using your webhook's secret>
X-NoteTrace-Event: note.created
X-NoteTrace-Delivery: <a uuid unique to this specific delivery attempt>
```

Recompute the HMAC over the raw body bytes you received (not a
re-serialized copy) and compare it to the signature header. Example in
Node:

```js
import { createHmac, timingSafeEqual } from 'crypto';

function verify(rawBody, signatureHeader, secret) {
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const given = signatureHeader.replace('sha256=', '');
  return timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}
```

## Retries and delivery status

A failed delivery (a network error, a timeout, or a non-2xx response)
is retried up to 3 times total, with a short backoff. There is no
persistent delivery queue: if a receiver is down for longer than a few
seconds, that event is not redelivered later. This is a deliberate
tradeoff for a self-hosted, personal-scale feature rather than a full
delivery queue with hours of retry.

Each webhook's last delivery outcome (delivered or failed, with the
error) is shown in Settings, use the "send test event" button there to
verify a target works without waiting for a real event.
