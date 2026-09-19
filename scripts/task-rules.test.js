import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTask, isTasksInbox } from '../server/lib/task-rules.js';

const list = (extra = {}) => ({ kind: 'checklist', title: 'Groceries', in_tasks: false, ...extra });

test('a shopping list item is not a task until it has a due date', () => {
  assert.equal(isTask(list(), { text: 'Limes' }), false);
  assert.equal(isTask(list(), { text: 'Gift', due_date: '2026-09-20' }), true);
});

test('a checklist shown in Tasks counts every open item', () => {
  assert.equal(isTask(list({ in_tasks: true }), { text: 'Fix the gate' }), true);
  assert.equal(isTask(list({ in_tasks: true }), { text: 'Done already', checked: true }), false);
  assert.equal(isTask(list({ in_tasks: true }), { text: '   ' }), false);
});

test('Show Every Checklist in Tasks counts everything open', () => {
  assert.equal(isTask(list(), { text: 'Limes' }, { allChecklists: true }), true);
  assert.equal(isTask({ kind: 'text', title: 'x' }, { text: 'Limes' }, { allChecklists: true }), false);
});

test('the Tasks inbox is found by title', () => {
  assert.equal(isTasksInbox(list({ title: ' tasks ' })), true);
  assert.equal(isTasksInbox(list({ title: 'Task list' })), false);
  assert.equal(isTasksInbox({ kind: 'text', title: 'Tasks' }), false);
});

import { nextDueDate, cleanTaskRepeat } from '../server/lib/task-rules.js';

test('a repeating task ticked on time moves on one step', () => {
  assert.equal(nextDueDate('2026-09-15', 'daily', '2026-09-15'), '2026-09-16');
  assert.equal(nextDueDate('2026-09-15', 'weekly', '2026-09-15'), '2026-09-22');
  assert.equal(nextDueDate('2026-09-15', 'monthly', '2026-09-15'), '2026-10-15');
  assert.equal(nextDueDate('2026-09-15', 'yearly', '2026-09-15'), '2027-09-15');
});

test('ticked early, it still moves on just one step', () => {
  assert.equal(nextDueDate('2026-09-21', 'weekly', '2026-09-16'), '2026-09-28');
});

test('ticked late, the missed ones are skipped', () => {
  assert.equal(nextDueDate('2026-09-01', 'weekly', '2026-09-16'), '2026-09-22');
  assert.equal(nextDueDate('2026-09-10', 'daily', '2026-09-16'), '2026-09-17');
});

test('weekdays skip the weekend', () => {
  assert.equal(nextDueDate('2026-09-18', 'weekdays', '2026-09-18'), '2026-09-21');   // Friday to Monday
  assert.equal(nextDueDate('2026-09-15', 'weekdays', '2026-09-15'), '2026-09-16');
});

test('the 31st lands on the last day of a shorter month', () => {
  assert.equal(nextDueDate('2026-01-31', 'monthly', '2026-01-31'), '2026-02-28');
  assert.equal(nextDueDate('2028-02-29', 'yearly', '2028-02-29'), '2029-02-28');
});

test('nothing repeats without a date or a known repeat', () => {
  assert.equal(nextDueDate(null, 'weekly', '2026-09-16'), null);
  assert.equal(nextDueDate('2026-09-16', 'fortnightly', '2026-09-16'), null);
  assert.equal(cleanTaskRepeat('weekly'), 'weekly');
  assert.equal(cleanTaskRepeat('hourly'), null);
});

import { itemAfterPatch } from '../server/lib/task-rules.js';

test('ticking a repeating item moves it on instead of ticking it', () => {
  const bins = { uuid: 'a', text: 'Bins', checked: false, due_date: '2026-09-15', due_repeat: 'weekly' };
  const after = itemAfterPatch(bins, { checked: true, today: '2026-09-15' }, '2026-09-15');
  assert.equal(after.checked, false);
  assert.equal(after.due_date, '2026-09-22');
  assert.equal('today' in after, false);
});

test('ticking an ordinary item just ticks it', () => {
  const after = itemAfterPatch({ uuid: 'b', text: 'Milk', checked: false }, { checked: true }, '2026-09-15');
  assert.equal(after.checked, true);
});

test('clearing the date clears the repeat', () => {
  const after = itemAfterPatch({ uuid: 'c', text: 'Bins', checked: false, due_date: '2026-09-15', due_repeat: 'weekly' }, { due_date: null });
  assert.equal(after.due_repeat, null);
});
