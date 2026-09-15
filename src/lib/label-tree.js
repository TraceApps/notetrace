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
