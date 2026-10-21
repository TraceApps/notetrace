// Portalled children are siblings in <body>, so CSS ancestry cannot place a
// calendar above its reminder popover. Each newly opened layer gets at least
// its normal z-index, and sits above every layer already open.
const layers = [];

export function overlayLayer(node) {
  const baseline = Number.parseInt(getComputedStyle(node).zIndex, 10) || 0;
  const z = Math.max(baseline, ...layers.map(layer => layer.z + 1));
  const previous = node.style.zIndex;
  const layer = { node, z };
  node.style.zIndex = String(z);
  layers.push(layer);
  return {
    destroy() {
      const index = layers.indexOf(layer);
      if (index >= 0) layers.splice(index, 1);
      node.style.zIndex = previous;
    },
  };
}

export function isTopOverlay(node) {
  return layers.at(-1)?.node === node;
}
