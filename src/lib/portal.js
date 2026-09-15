// Portal action: mounts element directly on document.body to escape
// any CSS stacking context created by parent transforms/filters.
// `use:portal={false}` leaves the node where it is.
export function portal(node, enabled = true) {
  if (enabled === false) return {};
  let target = document.body;
  target.appendChild(node);
  return {
    destroy() { if (node.parentNode) node.parentNode.removeChild(node); }
  };
}
