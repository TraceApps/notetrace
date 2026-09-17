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
