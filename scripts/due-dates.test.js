import assert from 'node:assert/strict';
import test from 'node:test';
import { addDays, daysUntil, dueStatus, dueLabel, groupByDue } from '../src/lib/due-dates.js';

const now = new Date(2026, 8, 14, 15, 30); // Mon Sep 14 2026, 15:30 local
const t = (k) => ({ 'due.today': 'Today', 'due.tomorrow': 'Tomorrow', 'due.yesterday': 'Yesterday' }[k]);

test('addDays and daysUntil work on calendar days', () => {
  assert.equal(addDays('2026-09-14', 1), '2026-09-15');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(daysUntil('2026-09-14', now), 0);
  assert.equal(daysUntil('2026-09-13', now), -1);
  assert.equal(daysUntil('2026-09-21', now), 7);
});

test('status and labels', () => {
  assert.equal(dueStatus('2026-09-10', now), 'overdue');
  assert.equal(dueStatus('2026-09-14', now), 'today');
  assert.equal(dueStatus('2026-09-15', now), 'tomorrow');
  assert.equal(dueStatus('2026-09-18', now), 'week');
  assert.equal(dueStatus('2026-10-01', now), 'later');
  assert.equal(dueLabel('2026-09-14', t, now), 'Today');
  assert.equal(dueLabel('2026-09-13', t, now), 'Yesterday');
});

test('groupByDue orders groups and dates', () => {
  const tasks = [
    { id: 1, due_date: '2026-10-01' }, { id: 2, due_date: null }, { id: 3, due_date: '2026-09-01' },
    { id: 4, due_date: '2026-09-14' }, { id: 5, due_date: '2026-09-05' },
  ];
  const g = groupByDue(tasks, now);
  assert.deepEqual(g.map(x => x.key), ['overdue', 'today', 'later', 'none']);
  assert.deepEqual(g[0].items.map(x => x.id), [3, 5]);
});
