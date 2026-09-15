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
