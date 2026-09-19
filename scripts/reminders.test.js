/**
 * Reminder repeat math (src/lib/reminders.js and its server copy). Runs in
 * plain Node: both modules only use Intl, no DOM.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import * as client from '../src/lib/reminders.js';
import * as server from '../server/lib/reminders.js';

const NY = 'America/New_York';

for (const [name, R] of [['client', client], ['server', server]]) {
  test(`${name}: one-off reminders return their own time, even when past`, () => {
    const d = R.nextOccurrence('2026-01-05 13:00:00', null, NY, new Date('2026-03-01T00:00:00Z'));
    assert.equal(d.toISOString(), '2026-01-05T13:00:00.000Z');
    assert.equal(R.isPast('2026-01-05 13:00:00', null, new Date('2026-03-01T00:00:00Z')), true);
    assert.equal(R.isPast('2026-01-05 13:00:00', 'daily', new Date('2026-03-01T00:00:00Z')), false);
  });

  test(`${name}: daily keeps the wall-clock time across the spring DST change`, () => {
    // 8:00 AM New York in January is 13:00 UTC; after March 8 2026 it is 12:00 UTC.
    const anchor = R.toUtcString(R.zonedToUtc(2026, 1, 5, 8, 0, NY));
    assert.equal(anchor, '2026-01-05 13:00:00');
    const d = R.nextOccurrence(anchor, 'daily', NY, new Date('2026-03-20T15:00:00Z'));
    assert.equal(d.toISOString(), '2026-03-21T12:00:00.000Z');
  });

  test(`${name}: daily fires later today when today's time has not passed`, () => {
    const anchor = R.toUtcString(R.zonedToUtc(2026, 1, 5, 20, 30, NY));
    const d = R.nextOccurrence(anchor, 'daily', NY, new Date('2026-03-20T15:00:00Z'));
    assert.equal(d.toISOString(), '2026-03-21T00:30:00.000Z'); // 8:30 PM EDT on Mar 20
  });

  test(`${name}: weekly stays on the same weekday`, () => {
    const anchor = R.toUtcString(R.zonedToUtc(2026, 9, 7, 9, 0, NY)); // Monday
    const d = R.nextOccurrence(anchor, 'weekly', NY, new Date('2026-09-16T12:00:00Z')); // Wednesday
    assert.equal(d.toISOString(), '2026-09-21T13:00:00.000Z'); // next Monday 9:00 EDT
  });

  test(`${name}: monthly clamps the 31st to short months`, () => {
    const anchor = R.toUtcString(R.zonedToUtc(2026, 1, 31, 9, 0, NY));
    const d = R.nextOccurrence(anchor, 'monthly', NY, new Date('2026-02-10T12:00:00Z'));
    assert.equal(d.toISOString(), '2026-02-28T14:00:00.000Z');
  });

  test(`${name}: yearly rolls to next year once this year has passed`, () => {
    const anchor = R.toUtcString(R.zonedToUtc(2025, 9, 13, 10, 0, NY));
    const d = R.nextOccurrence(anchor, 'yearly', NY, new Date('2026-09-14T00:00:00Z'));
    assert.equal(d.toISOString(), '2027-09-13T14:00:00.000Z');
  });
}

test('client: due occurrence uses its own shorter window', () => {
  const note = { reminder_at: '2026-03-10 14:00:00', reminder_rrule: null, reminder_tz: NY };
  assert.equal(client.dueOccurrence(note, new Date('2026-03-10T14:05:00Z')).toISOString(), '2026-03-10T14:00:00.000Z');
  assert.equal(client.dueOccurrence(note, new Date('2026-03-10T14:20:00Z')), null);
  assert.equal(client.dueOccurrence(note, new Date('2026-03-10T14:20:00Z'), 30 * 60 * 1000).toISOString(), '2026-03-10T14:00:00.000Z');
});

test('server: due occurrence is found once passed, within the late window', () => {
  const note = { reminder_at: '2026-03-10 14:00:00', reminder_rrule: null, reminder_tz: NY };
  assert.equal(server.dueOccurrence(note, new Date('2026-03-10T13:59:00Z')), null);
  assert.equal(server.dueOccurrence(note, new Date('2026-03-10T14:00:30Z')).toISOString(), '2026-03-10T14:00:00.000Z');
  assert.equal(server.dueOccurrence(note, new Date('2026-03-10T17:00:00Z')), null); // 3h late: stale
});

test('server: repeating reminder is due on each occurrence, not only the first', () => {
  const anchor = server.toUtcString(server.zonedToUtc(2026, 1, 5, 8, 0, NY));
  const note = { reminder_at: anchor, reminder_rrule: 'daily', reminder_tz: NY };
  const due = server.dueOccurrence(note, new Date('2026-03-21T12:05:00Z')); // 8:05 AM EDT
  assert.equal(due.toISOString(), '2026-03-21T12:00:00.000Z');
  assert.equal(server.dueOccurrence(note, new Date('2026-03-21T18:00:00Z')), null);
});
