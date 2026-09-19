/**
 * task-digest-core.js: the daily "tasks due" notification, as pure
 * functions shared by the server (push), the Android app (a scheduled
 * alarm), and the browser (an open tab). No database, no network.
 */
export const DEFAULT_DIGEST_TIME = '09:00';

export function cleanDigestTime(v) {
  const m = String(v || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return DEFAULT_DIGEST_TIME;
  const h = Number(m[1]), min = Number(m[2]);
  return h <= 23 && min <= 59 ? `${String(h).padStart(2, '0')}:${m[2]}` : DEFAULT_DIGEST_TIME;
}

/** The calendar date (YYYY-MM-DD) and minutes past midnight at `now` in `tz`. */
export function localParts(now, tz) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat('en-US', { hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(now);
  }
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

export const timeToMinutes = (hhmm) => { const [h, m] = cleanDigestTime(hhmm).split(':').map(Number); return h * 60 + m; };

/**
 * tasks: [{ text, due_date, checked, list }]. Null when nothing is due.
 * Resolves { title, body, dueToday, overdue }.
 */
export function buildTaskDigest(tasks, today) {
  const open = (tasks || []).filter(t => !t.checked && t.due_date && String(t.text || '').trim());
  const dueToday = open.filter(t => t.due_date === today);
  const overdue = open.filter(t => t.due_date < today).sort((a, b) => a.due_date.localeCompare(b.due_date));
  if (!dueToday.length && !overdue.length) return null;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const title = dueToday.length
    ? `${plural(dueToday.length, 'task', 'tasks')} due today${overdue.length ? `, ${overdue.length} overdue` : ''}`
    : `${plural(overdue.length, 'overdue task', 'overdue tasks')}`;
  const lines = [...dueToday, ...overdue].slice(0, 6)
    .map(t => `- ${String(t.text).trim().slice(0, 80)}${t.list ? ` (${t.list})` : ''}`);
  const more = dueToday.length + overdue.length - lines.length;
  if (more > 0) lines.push(`and ${more} more`);
  return { title, body: lines.join('\n'), dueToday: dueToday.length, overdue: overdue.length };
}
