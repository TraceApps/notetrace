/**
 * list-groups.js: sections for the List layout. Pure, and tested.
 *
 *   by 'none'  : Pinned, then everything else (like the grid)
 *   by 'label' : one section per label (a note with two labels shows in both), then No Label
 *   by 'color' : one section per note color, default color last
 *   by 'date'  : by the day each note was last edited (same days as the timeline)
 */
import { groupByDay } from './timeline.js';

const COLOR_ORDER = ['plum', 'tide', 'moss', 'sand', 'clay', 'rose', null];

export function groupNotes(notes, by, { labels = [], pinnedFirst = true, now = new Date() } = {}) {
  const list = notes || [];
  if (by === 'label') {
    const out = [];
    for (const l of labels) {
      const inLabel = list.filter(n => (n.labels || []).includes(l.id));
      if (inLabel.length) out.push({ key: `l${l.id}`, kind: 'label', label: l, notes: inLabel });
    }
    const none = list.filter(n => !(n.labels || []).some(id => labels.some(l => l.id === id)));
    if (none.length) out.push({ key: 'l-none', kind: 'no-label', notes: none });
    return out;
  }
  if (by === 'color') {
    return COLOR_ORDER
      .map(c => ({ key: `c${c || 'default'}`, kind: 'color', color: c, notes: list.filter(n => (n.color || null) === c) }))
      .filter(g => g.notes.length);
  }
  if (by === 'date') {
    return groupByDay(list, { now }).map(d => ({ key: `d${d.key}`, kind: 'day', day: d, notes: d.notes }));
  }
  if (!pinnedFirst) return list.length ? [{ key: 'all', kind: 'all', notes: list }] : [];
  const pinned = list.filter(n => n.pinned);
  const others = list.filter(n => !n.pinned);
  return [
    ...(pinned.length ? [{ key: 'pinned', kind: 'pinned', notes: pinned }] : []),
    ...(others.length ? [{ key: 'others', kind: pinned.length ? 'others' : 'all', notes: others }] : []),
  ];
}
