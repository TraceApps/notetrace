/**
 * timeline.js: groups notes by the local day they were last edited, for the
 * timeline view. Pure so it's testable; labels are formatted by the caller.
 */

function _date(ts) {
  if (!ts) return null;
  const s = String(ts);
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isFinite(d.getTime()) ? d : null;
}

const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * [{ key: 'YYYY-MM-DD', kind: 'today'|'yesterday'|'week'|'year'|'older', date, notes }]
 * newest day first, notes newest first within a day.
 */
export function groupByDay(notes, { now = new Date(), field = 'updated_at' } = {}) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const groups = new Map();
  const sorted = [...notes].sort((a, b) => (_date(b[field])?.getTime() || 0) - (_date(a[field])?.getTime() || 0));
  for (const n of sorted) {
    const d = _date(n[field]) || new Date(0);
    const key = dayKey(d);
    if (!groups.has(key)) {
      const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      const diff = Math.round((today - day) / 86400000);
      const kind = diff <= 0 ? 'today' : diff === 1 ? 'yesterday' : diff < 7 ? 'week' : d.getFullYear() === now.getFullYear() ? 'year' : 'older';
      groups.set(key, { key, kind, date: day, notes: [] });
    }
    groups.get(key).notes.push(n);
  }
  return [...groups.values()];
}
