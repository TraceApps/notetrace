/**
 * shopping-groups.js: the CookTrace shopping list, grouped the way CookTrace
 * shows it. CookTrace already sorts it (unchecked first, by aisle, then its own
 * order); this keeps that order and splits it into aisle groups, with items
 * that have no aisle last, and checked items on their own.
 *
 * Like CookTrace's By Aisle view, rows with the same name, unit, and aisle
 * show as one: CookTrace keeps a row per recipe, so two recipes needing
 * onions are two rows there. A merged row adds up the amounts, lists every
 * recipe, and carries `ids` so a tick reaches all of them.
 */

const _norm = (s) => String(s ?? '').trim().toLowerCase();
const _hasQty = (it) => it.quantity != null && it.quantity !== '' && Number.isFinite(Number(it.quantity));

/** Rows with the same name and unit (and aisle, when asked) as one. Keeps first-seen order. */
export function mergeRows(rows, { byAisle = true } = {}) {
  const map = new Map();
  for (const it of rows || []) {
    const k = `${_norm(it.name)}|${_norm(it.unit)}|${it.checked ? 1 : 0}${byAisle ? `|${_norm(it.aisle)}` : ''}`;
    if (map.has(k)) map.get(k).push(it);
    else map.set(k, [it]);
  }
  return [...map.values()].map(members => {
    const first = members[0];
    const recipe_names = [...new Set(members.map(m => m.recipe_name).filter(Boolean))];
    const ids = members.map(m => m.id);
    if (members.length === 1) return { ...first, ids, key: String(first.id), recipe_names };
    // Any row without an amount makes the total unknown: no number beats a wrong one.
    const quantity = members.every(_hasQty)
      ? Math.round(members.reduce((s, m) => s + Number(m.quantity), 0) * 100) / 100
      : null;
    return { ...first, quantity, ids, key: ids.join(','), recipe_names, pending: members.some(m => m.pending) };
  });
}

/** Items with pending offline changes applied, in CookTrace's order. */
export function applyPending(items, ops) {
  let list = (items || []).map(i => ({ ...i }));
  for (const op of ops || []) {
    if (op.type === 'check') {
      const it = list.find(i => i.id === op.id);
      if (it) { it.checked = !!op.checked; it.pending = true; }
    } else if (op.type === 'add') {
      const name = String(op.name || '').trim();
      if (!name || list.some(i => !i.checked && i.name.toLowerCase() === name.toLowerCase())) continue;
      list.push({ id: op.tempId, name, quantity: null, unit: null, aisle: null, checked: false, recipe_name: null, pending: true });
    } else if (op.type === 'clear') {
      list = list.filter(i => !i.checked);
    }
  }
  return list;
}

/** { groups: [{ key, aisle, items }], checked: [items] } */
export function groupShopping(items) {
  const groups = new Map();
  const checked = [];
  for (const it of items || []) {
    if (it.checked) { checked.push(it); continue; }
    const aisle = it.aisle && String(it.aisle).trim() ? String(it.aisle).trim() : null;
    const key = aisle ? `aisle:${aisle.toLowerCase()}` : 'none';
    if (!groups.has(key)) groups.set(key, { key, aisle, items: [] });
    groups.get(key).items.push(it);
  }
  const list = [...groups.values()];
  for (const g of list) g.items = mergeRows(g.items);
  // CookTrace sorts aisles alphabetically with no aisle last; keep that even for items added here.
  list.sort((a, b) => (a.aisle == null) - (b.aisle == null) || String(a.aisle).localeCompare(String(b.aisle)));
  return { groups: list, checked: mergeRows(checked, { byAisle: false }) };
}

/** "3", "2 cups", "500 g": quantity and unit together, or '' when neither. */
export function amountLabel(item) {
  const q = item?.quantity;
  const qty = q == null || q === '' ? '' : String(Number.isInteger(Number(q)) ? Number(q) : Number(q).toFixed(2).replace(/\.?0+$/, ''));
  return [qty, item?.unit || ''].filter(Boolean).join(' ');
}
