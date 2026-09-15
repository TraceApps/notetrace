import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLabelTree, labelAndDescendantIds, renameNested, flattenTree } from '../src/lib/label-tree.js';

const labels = [
  { id: 1, name: 'Home/Garage' },
  { id: 2, name: 'Work' },
  { id: 3, name: 'Home' },
  { id: 4, name: 'home/Kitchen/Pantry' },
  { id: 5, name: 'Homelab' },
];

test('buildLabelTree nests by slash and keeps first-seen order', () => {
  const tree = buildLabelTree(labels);
  assert.deepEqual(tree.map(n => n.name), ['Home', 'Work', 'Homelab']);
  const home = tree[0];
  assert.equal(home.label.id, 3);
  assert.deepEqual(home.children.map(n => n.name), ['Garage', 'Kitchen']);
  const kitchen = home.children[1];
  assert.equal(kitchen.label, null, 'Kitchen is a group without its own label');
  assert.equal(kitchen.children[0].label.id, 4);
  assert.equal(kitchen.children[0].depth, 2);
  assert.deepEqual(flattenTree(tree).map(n => n.path), ['Home', 'Home/Garage', 'Home/Kitchen', 'Home/Kitchen/Pantry', 'Work', 'Homelab']);
});

test('descendants match by path, not by prefix text', () => {
  assert.deepEqual(labelAndDescendantIds(labels, 3).sort(), [1, 3, 4]);
  assert.deepEqual(labelAndDescendantIds(labels, 5), [5]);
});

test('renameNested moves children with their parent', () => {
  assert.deepEqual(renameNested(labels, 'Home', 'House'), [{ id: 1, name: 'House/Garage' }, { id: 4, name: 'House/Kitchen/Pantry' }]);
});
