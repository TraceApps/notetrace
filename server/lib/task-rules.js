/**
 * task-rules.js: which checklist items count as tasks. Pure; shared by the
 * Tasks view, Trace, and MCP.
 *
 * An open item is a task when it has a due date, or when its checklist is set
 * to Show in Tasks (in_tasks). With the "Show Every Checklist in Tasks"
 * setting, every open item is one.
 */
export function isTask(note, item, { allChecklists = false } = {}) {
  if (!note || note.kind !== 'checklist' || !item || item.checked) return false;
  if (!String(item.text || '').trim()) return false;
  return allChecklists || !!item.due_date || !!note.in_tasks;
}

/** The checklist the Tasks view's Add a Task box writes to. */
export function isTasksInbox(note, inboxTitle = 'Tasks') {
  return note?.kind === 'checklist' && String(note.title || '').trim().toLowerCase() === String(inboxTitle).toLowerCase();
}

// ── Repeating tasks ──────────────────────────────────────────────────────
// A repeating task is one item whose due date moves on when it's ticked,
// rather than a new item each time. Dates are calendar days (YYYY-MM-DD) in
// the user's own time zone, so the arithmetic below is done in UTC to keep
// daylight saving out of it.

export const TASK_REPEATS = ['daily', 'weekdays', 'weekly', 'monthly', 'yearly'];

/** A repeat that can be stored, or null. */
export const cleanTaskRepeat = (v) => (TASK_REPEATS.includes(v) ? v : null);

const _parse = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s ? d : null;
};
const _fmt = (d) => d.toISOString().slice(0, 10);

function _step(d, repeat) {
  const n = new Date(d.getTime());
  if (repeat === 'daily') n.setUTCDate(n.getUTCDate() + 1);
  else if (repeat === 'weekdays') {
    n.setUTCDate(n.getUTCDate() + 1);
    const day = n.getUTCDay();
    if (day === 6) n.setUTCDate(n.getUTCDate() + 2);
    else if (day === 0) n.setUTCDate(n.getUTCDate() + 1);
  } else if (repeat === 'weekly') n.setUTCDate(n.getUTCDate() + 7);
  else if (repeat === 'monthly' || repeat === 'yearly') {
    // The 31st becomes the last day of a shorter month rather than spilling
    // into the next one.
    const day = n.getUTCDate();
    n.setUTCDate(1);
    if (repeat === 'monthly') n.setUTCMonth(n.getUTCMonth() + 1);
    else n.setUTCFullYear(n.getUTCFullYear() + 1);
    const last = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 0)).getUTCDate();
    n.setUTCDate(Math.min(day, last));
  }
  return n;
}

/**
 * Where a repeating task's due date goes when it's ticked: the next time it
 * comes round after today. Ticked early, it moves on by one step; ticked late,
 * the missed ones are skipped rather than left overdue. Null when the item
 * doesn't repeat or has no date.
 */
export function nextDueDate(due, repeat, today) {
  const from = _parse(due);
  if (!from || !cleanTaskRepeat(repeat)) return null;
  const limit = _parse(today) ? today : _fmt(from);
  let d = _step(from, repeat);
  for (let guard = 0; _fmt(d) <= limit && guard < 20000; guard++) d = _step(d, repeat);
  return _fmt(d);
}

/**
 * A checklist item as it will be after `patch`, with the repeat rule applied:
 * what the server stores and what a screen should show straight away. Only
 * item fields are taken from the patch (`today` is the caller's calendar day).
 */
export function itemAfterPatch(item, patch = {}, today = null) {
  const next = { ...item };
  for (const k of ['text', 'checked', 'position', 'due_date', 'due_repeat']) if (k in patch) next[k] = patch[k];
  if (!next.due_date) next.due_repeat = null;
  if (next.checked && !item.checked && cleanTaskRepeat(next.due_repeat)) {
    const moved = nextDueDate(next.due_date, next.due_repeat, today || next.due_date);
    if (moved) { next.due_date = moved; next.checked = false; }
  }
  return next;
}
