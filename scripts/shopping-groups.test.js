import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupShopping, applyPending, amountLabel } from '../src/lib/shopping-groups.js';

const item = (id, name, aisle, extra = {}) => ({ id, name, aisle, checked: false, quantity: null, unit: null, ...extra });

test('items group by aisle in order, no aisle last, checked apart', () => {
  const { groups, checked } = groupShopping([
    item(1, 'Bread', 'Bakery'), item(2, 'Limes', 'Produce'), item(3, 'Tape', null), item(4, 'Rolls', 'bakery'),
    item(5, 'Yogurt', 'Dairy', { checked: true }),
  ]);
  assert.deepEqual(groups.map(g => [g.aisle, g.items.map(i => i.name)]), [['Bakery', ['Bread', 'Rolls']], ['Produce', ['Limes']], [null, ['Tape']]]);
  assert.deepEqual(checked.map(i => i.name), ['Yogurt']);
});

test('offline ticks, adds, and clears show before they reach CookTrace', () => {
  const base = [item(1, 'Limes', 'Produce'), item(2, 'Bread', 'Bakery', { checked: true })];
  const shown = applyPending(base, [
    { type: 'check', id: 1, checked: true },
    { type: 'add', name: 'Coffee', tempId: 'tmp-1' },
    { type: 'add', name: 'coffee', tempId: 'tmp-2' },
  ]);
  assert.equal(shown.find(i => i.id === 1).checked, true);
  assert.equal(shown.filter(i => /coffee/i.test(i.name)).length, 1);
  assert.ok(shown.find(i => i.name === 'Coffee').pending);
  const cleared = applyPending(base, [{ type: 'clear' }]);
  assert.deepEqual(cleared.map(i => i.name), ['Limes']);
  assert.equal(base[0].checked, false, 'the cached list is left as it was');
});

test('amounts read naturally', () => {
  assert.equal(amountLabel({ quantity: 3 }), '3');
  assert.equal(amountLabel({ quantity: 1.5, unit: 'cups' }), '1.5 cups');
  assert.equal(amountLabel({ quantity: 0.333333, unit: 'kg' }), '0.33 kg');
  assert.equal(amountLabel({ unit: 'bunch' }), 'bunch');
  assert.equal(amountLabel({}), '');
});

test('the same item from two recipes shows once, like CookTrace', () => {
  const { groups, checked } = groupShopping([
    item(1, 'Onion', 'Produce', { quantity: 1, recipe_name: 'Chili' }),
    item(2, 'Limes', 'Produce', { quantity: 3 }),
    item(3, 'onion', 'Produce', { quantity: 2, recipe_name: 'Tacos' }),
    item(4, 'Flour', 'Baking', { quantity: 2, unit: 'cups' }),
    item(5, 'Flour', 'Baking', { quantity: 100, unit: 'g' }),
    item(6, 'Salt', 'Baking', { quantity: 1 }),
    item(7, 'Salt', 'Baking'),
    item(8, 'Eggs', 'Dairy', { checked: true, quantity: 6 }),
    item(9, 'Eggs', 'Dairy', { checked: true, quantity: 6 }),
  ]);
  const produce = groups.find(g => g.aisle === 'Produce').items;
  assert.deepEqual(produce.map(i => [i.name, i.quantity, i.ids, i.recipe_names]), [['Onion', 3, [1, 3], ['Chili', 'Tacos']], ['Limes', 3, [2], []]]);
  const baking = groups.find(g => g.aisle === 'Baking').items;
  assert.equal(baking.filter(i => i.name === 'Flour').length, 2, 'different units stay apart');
  assert.equal(baking.find(i => i.name === 'Salt').quantity, null, 'an unknown amount makes the total unknown');
  assert.deepEqual(checked.map(i => [i.name, i.quantity, i.ids]), [['Eggs', 12, [8, 9]]]);
  assert.equal(new Set(groups.flatMap(g => g.items.map(i => i.key))).size, groups.flatMap(g => g.items).length, 'keys are unique');
});
