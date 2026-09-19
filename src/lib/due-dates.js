/**
 * due-dates.js: due dates on checklist items (YYYY-MM-DD, the user's own
 * calendar day, so there's no time zone to get wrong). Pure, and tested.
 */
const pad = (n) => String(n).padStart(2, '0');

export function toDateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayStr(now = new Date()) { return toDateStr(now); }

export function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return toDateStr(new Date(y, m - 1, d + days));
}

/** Days from today to the date (negative when overdue). */
export function daysUntil(dateStr, now = new Date()) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const due = new Date(y, m - 1, d);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due - today) / 86400000);
}

/** 'overdue' | 'today' | 'tomorrow' | 'week' | 'later' */
export function dueStatus(dateStr, now = new Date()) {
  const n = daysUntil(dateStr, now);
  return n < 0 ? 'overdue' : n === 0 ? 'today' : n === 1 ? 'tomorrow' : n < 7 ? 'week' : 'later';
}

/** Short label: Today, Tomorrow, Yesterday, a weekday this week, else a date. */
export function dueLabel(dateStr, t, now = new Date()) {
  const n = daysUntil(dateStr, now);
  if (n === 0) return t('due.today');
  if (n === 1) return t('due.tomorrow');
  if (n === -1) return t('due.yesterday');
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const date = new Date(y, m - 1, d);
  if (n > 1 && n < 7) return date.toLocaleDateString(undefined, { weekday: 'short' });
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(y !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

/** Group open tasks: [{ key, items }] in Overdue, Today, Tomorrow, This Week, Later, No Date order. */
export function groupByDue(tasks, now = new Date()) {
  const order = ['overdue', 'today', 'tomorrow', 'week', 'later', 'none'];
  const groups = new Map(order.map(k => [k, []]));
  for (const task of tasks) groups.get(task.due_date ? dueStatus(task.due_date, now) : 'none').push(task);
  for (const [k, list] of groups) {
    if (k !== 'none') list.sort((a, b) => a.due_date.localeCompare(b.due_date));
  }
  return order.map(key => ({ key, items: groups.get(key) })).filter(g => g.items.length);
}
