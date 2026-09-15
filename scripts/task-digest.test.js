import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTaskDigest, cleanDigestTime, localParts, timeToMinutes } from '../server/lib/task-digest-core.js';

test('digest counts today and overdue, lists the first few', () => {
  const tasks = [
    { text: 'Call plumber', due_date: '2026-09-15', list: 'Home' },
    { text: 'Renew cert', due_date: '2026-09-12', list: 'Homelab' },
    { text: 'Done already', due_date: '2026-09-15', checked: true },
    { text: 'Later', due_date: '2026-09-20' },
    { text: 'No date' },
  ];
  const d = buildTaskDigest(tasks, '2026-09-15');
  assert.equal(d.title, '1 task due today, 1 overdue');
  assert.equal(d.body, '- Call plumber (Home)\n- Renew cert (Homelab)');
  assert.equal(buildTaskDigest([{ text: 'x', due_date: '2026-09-20' }], '2026-09-15'), null);
  assert.equal(buildTaskDigest([{ text: 'x', due_date: '2026-09-01' }, { text: 'y', due_date: '2026-09-02' }], '2026-09-15').title, '2 overdue tasks');
});

test('digest caps the list', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ text: `T${i}`, due_date: '2026-09-15' }));
  const d = buildTaskDigest(many, '2026-09-15');
  assert.equal(d.body.split('\n').length, 7);
  assert.match(d.body, /and 3 more$/);
});

test('times and local dates', () => {
  assert.equal(cleanDigestTime('8:30'), '08:30');
  assert.equal(cleanDigestTime('25:00'), '09:00');
  assert.equal(timeToMinutes('07:15'), 435);
  const p = localParts(new Date('2026-09-15T02:30:00Z'), 'America/New_York');
  assert.equal(p.date, '2026-09-14');
  assert.equal(p.minutes, 22 * 60 + 30);
});
