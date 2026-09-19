/**
 * label-tree.js: nested labels. A label named "Home/Garage" sits under
 * "Home" in the sidebar and pickers; "Home" doesn't have to exist as a
 * label itself. Pure, so it's testable.
 */
export const SEP = '/';

const parts = (name) => String(name || '').split(SEP).map(s => s.trim()).filter(Boolean);

/**
 * Labels (in their saved order) to a tree:
 * [{ path, name, depth, label (or null for a group), children: [...] }]
 * Siblings keep the order of the first label under them.
 */
export function buildLabelTree(labels) {
  const root = { children: [], byName: new Map() };
  for (const label of labels || []) {
    const segs = parts(label.name);
    if (!segs.length) continue;
    let node = root;
    segs.forEach((seg, i) => {
      const key = seg.toLowerCase();
      let child = node.byName.get(key);
      if (!child) {
        child = { path: node.path ? node.path + SEP + seg : seg, name: seg, depth: i, label: null, children: [], byName: new Map() };
        node.byName.set(key, child);
        node.children.push(child);
      }
      if (i === segs.length - 1 && !child.label) child.label = label;
      node = child;
    });
  }
  const strip = (n) => ({ path: n.path, name: n.name, depth: n.depth, label: n.label, children: n.children.map(strip) });
  return root.children.map(strip);
}

/**
 * Labels in the order chosen in Settings, nested labels right after their
 * parent. mode: 'alpha' (A to Z), 'used' (most notes first, counting the
 * labels nested under a parent), or 'custom' (the order dragged in Edit
 * Labels; a group sits where its first label does). Ties go A to Z.
 */
export function orderLabels(labels, mode = 'alpha') {
  const tree = buildLabelTree(labels);
  const count = (n) => (n.label?.note_count || 0) + n.children.reduce((s, c) => s + count(c), 0);
  const pos = (n) => Math.min(n.label && n.label.position != null ? Number(n.label.position) : Infinity, ...n.children.map(pos));
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
  const cmp = mode === 'used' ? (a, b) => count(b) - count(a) || byName(a, b)
    : mode === 'custom' ? (a, b) => (pos(a) - pos(b)) || byName(a, b)
    : byName;
  const out = [];
  const walk = (nodes) => {
    for (const n of [...nodes].sort(cmp)) {
      if (n.label) out.push(n.label);
      walk(n.children);
    }
  };
  walk(tree);
  return out;
}

/** Ids of a label and every label nested under it. */
export function labelAndDescendantIds(labels, labelId) {
  const label = (labels || []).find(l => l.id === labelId);
  if (!label) return [labelId];
  const prefix = parts(label.name).join(SEP).toLowerCase() + SEP;
  return [labelId, ...(labels || []).filter(l => l.id !== labelId && parts(l.name).join(SEP).toLowerCase().startsWith(prefix)).map(l => l.id)];
}

/** Labels to rename when "from" becomes "to": [{ id, name }] for nested ones. */
export function renameNested(labels, from, to) {
  const prefix = parts(from).join(SEP).toLowerCase() + SEP;
  const newBase = parts(to).join(SEP);
  return (labels || [])
    .filter(l => parts(l.name).join(SEP).toLowerCase().startsWith(prefix))
    .map(l => ({ id: l.id, name: newBase + SEP + parts(l.name).slice(parts(from).length).join(SEP) }));
}

/** Flatten a tree for pickers: [{ node, depth }] depth-first. */
export function flattenTree(tree, out = []) {
  for (const n of tree) { out.push(n); flattenTree(n.children, out); }
  return out;
}
