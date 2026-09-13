/**
 * reminders.js: reminder timing shared by the picker, cards, and Android
 * notification scheduling. server/lib/reminders.js is the server copy of
 * the same math; keep the two in step.
 *
 * A reminder is stored as its first occurrence (reminder_at, UTC), an
 * optional repeat ('daily' | 'weekly' | 'monthly' | 'yearly'), and the IANA
 * timezone it was set in. Repeats keep the same wall-clock time in that
 * timezone, so "daily at 8:00" stays at 8:00 through daylight-saving
 * changes.
 */

export const REPEATS = ['daily', 'weekly', 'monthly', 'yearly'];

export function localTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

/** Parse a stored UTC timestamp ("YYYY-MM-DD HH:MM:SS" or ISO) to a Date. */
export function parseUtc(s) {
  if (!s) return null;
  const str = String(s);
  const iso = str.includes('T') ? str : str.replace(' ', 'T');
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z');
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Date to the stored UTC shape. */
export function toUtcString(date) {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

function partsIn(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  });
  const p = {};
  for (const { type, value } of fmt.formatToParts(date)) p[type] = Number(value);
  return { y: p.year, m: p.month, d: p.day, h: p.hour, min: p.minute, s: p.second };
}

function offsetMs(date, tz) {
  const p = partsIn(date, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(date.getTime() / 1000) * 1000;
}

/** Wall-clock time in `tz` to a UTC Date. */
export function zonedToUtc(y, m, d, h, min, tz) {
  const guess = Date.UTC(y, m - 1, d, h, min, 0);
  let t = guess - offsetMs(new Date(guess), tz);
  t = guess - offsetMs(new Date(t), tz);
  return new Date(t);
}

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * The next time this reminder fires at or after `from`. One-off reminders
 * return their single time (even when past). Repeating reminders return
 * the first occurrence strictly after `from`.
 */
export function nextOccurrence(reminderAt, repeat, tz, from = new Date()) {
  const anchor = parseUtc(reminderAt);
  if (!anchor) return null;
  if (!REPEATS.includes(repeat)) return anchor;
  if (anchor > from) return anchor;
  const zone = tz || localTimeZone();
  const a = partsIn(anchor, zone);
  const n = partsIn(from, zone);

  const at = (y, m, d) => zonedToUtc(y, m, Math.min(d, daysInMonth(y, m)), a.h, a.min, zone);

  if (repeat === 'daily') {
    let c = at(n.y, n.m, n.d);
    for (let i = 0; c <= from && i < 3; i++) {
      const nd = new Date(Date.UTC(n.y, n.m - 1, n.d + i + 1));
      c = at(nd.getUTCFullYear(), nd.getUTCMonth() + 1, nd.getUTCDate());
    }
    return c;
  }
  if (repeat === 'weekly') {
    const anchorDow = new Date(Date.UTC(a.y, a.m - 1, a.d)).getUTCDay();
    const todayDow = new Date(Date.UTC(n.y, n.m - 1, n.d)).getUTCDay();
    let delta = (anchorDow - todayDow + 7) % 7;
    let base = new Date(Date.UTC(n.y, n.m - 1, n.d + delta));
    let c = at(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate());
    if (c <= from) {
      base = new Date(Date.UTC(n.y, n.m - 1, n.d + delta + 7));
      c = at(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate());
    }
    return c;
  }
  if (repeat === 'monthly') {
    let y = n.y, m = n.m;
    let c = at(y, m, a.d);
    if (c <= from) { m += 1; if (m > 12) { m = 1; y += 1; } c = at(y, m, a.d); }
    return c;
  }
  // yearly
  let c = at(n.y, a.m, a.d);
  if (c <= from) c = at(n.y + 1, a.m, a.d);
  return c;
}

/** True when a one-off reminder's time has passed. */
export function isPast(reminderAt, repeat, from = new Date()) {
  if (REPEATS.includes(repeat)) return false;
  const d = parseUtc(reminderAt);
  return !!d && d <= from;
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Short human label in the viewer's locale: "Today, 5:30 PM", "Tomorrow, 8:00 AM", "Mon, Sep 22, 8:00 AM". */
export function formatReminder(date, { hour12, today = 'Today', tomorrow = 'Tomorrow' } = {}) {
  if (!date) return '';
  const now = new Date();
  const tmr = new Date(now); tmr.setDate(now.getDate() + 1);
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', ...(hour12 != null ? { hour12 } : {}) });
  if (sameDay(date, now)) return `${today}, ${time}`;
  if (sameDay(date, tmr)) return `${tomorrow}, ${time}`;
  const withinYear = Math.abs(date - now) < 300 * 86400000;
  const day = date.toLocaleDateString(undefined, withinYear
    ? { weekday: 'short', month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
  return `${day}, ${time}`;
}

/** Quick picks shown at the top of the reminder picker. */
export function reminderPresets(now = new Date()) {
  const at = (days, hour) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(hour, 0, 0, 0);
    return d;
  };
  const presets = [];
  if (now.getHours() < 17) presets.push({ key: 'later_today', date: at(0, 18) });
  else if (now.getHours() < 20) presets.push({ key: 'later_today', date: at(0, 21) });
  presets.push({ key: 'tomorrow', date: at(1, 8) });
  const toMonday = ((8 - now.getDay()) % 7) || 7;
  presets.push({ key: 'next_week', date: at(toMonday, 8) });
  return presets;
}
