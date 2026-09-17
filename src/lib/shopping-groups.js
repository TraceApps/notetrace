/**
 * shopping-groups.js: the CookTrace shopping list, grouped the way CookTrace
 * shows it. CookTrace already sorts it (unchecked first, by aisle, then its own
 * order); this keeps that order and splits it into aisle groups, with items
 * that have no aisle last, and checked items on their own.
 */

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
  // CookTrace sorts aisles alphabetically with no aisle last; keep that even for items added here.
  list.sort((a, b) => (a.aisle == null) - (b.aisle == null) || String(a.aisle).localeCompare(String(b.aisle)));
  return { groups: list, checked };
}

/** "3", "2 cups", "500 g": quantity and unit together, or '' when neither. */
export function amountLabel(item) {
  const q = item?.quantity;
  const qty = q == null || q === '' ? '' : String(Number.isInteger(Number(q)) ? Number(q) : Number(q).toFixed(2).replace(/\.?0+$/, ''));
  return [qty, item?.unit || ''].filter(Boolean).join(' ');
}
