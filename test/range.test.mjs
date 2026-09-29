import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rangeBounds, rangeTsv, parseTsv, pasteChanges, clearChanges, fillChanges } from '../public/js/range.js';

const cols = [{ key: 'a', kind: 'data', type: 'text' }, { key: 'b', kind: 'data', type: 'text' }, { key: 'f', kind: 'formula', type: 'text' }];
const rows = [1, 2, 3].map((id) => ({ id, data: { a: `a${id}`, b: `b${id}` } }));

test('range bounds work in any drag direction and fall back to the focused cell', () => {
  assert.deepEqual(rangeBounds(rows, cols, { focus: { row: 3, col: 'b' }, rangeEnd: { row: 1, col: 'a' } }), { r0: 0, r1: 2, c0: 0, c1: 1 });
  assert.deepEqual(rangeBounds(rows, cols, { focus: { row: 2, col: 'a' } }), { r0: 1, r1: 1, c0: 0, c1: 0 });
  assert.equal(rangeBounds(rows, cols, { focus: null }), null);
});

test('TSV round-trips tabs, newlines and quotes', () => {
  const tricky = [{ id: 9, data: { a: 'x\ty', b: 'say "hi"\nbye' } }];
  const tsv = rangeTsv(tricky, cols, { r0: 0, r1: 0, c0: 0, c1: 1 });
  assert.deepEqual(parseTsv(tsv), [['x\ty', 'say "hi"\nbye']]);
  assert.deepEqual(parseTsv('1\t2\r\n3\t4\n'), [['1', '2'], ['3', '4']]);
});

test('paste: a block lands at the top-left, one value fills the selection, formulas and overflow are skipped', () => {
  const block = pasteChanges(rows, cols, { r0: 1, r1: 1, c0: 1, c1: 1 }, [['P', 'Q'], ['R', 'S'], ['T', 'U']]);
  assert.deepEqual(block.changes.map((c) => [c.id, c.key, c.after]), [[2, 'b', 'P'], [3, 'b', 'R']]);
  assert.equal(block.dropped, 2);   // T and U have no row to land in; the formula column is skipped, not dropped
  const fill = pasteChanges(rows, cols, { r0: 0, r1: 2, c0: 0, c1: 0 }, [['Z']]);
  assert.deepEqual(fill.changes.map((c) => [c.id, c.after, c.before]), [[1, 'Z', 'a1'], [2, 'Z', 'a2'], [3, 'Z', 'a3']]);
  assert.equal(pasteChanges(rows, cols, { r0: 0, r1: 0, c0: 0, c1: 0 }, [['']]).changes[0].after, null);
});

test('clear and fill down skip formula columns and record the old values for undo', () => {
  const b = { r0: 0, r1: 2, c0: 0, c1: 2 };
  assert.deepEqual(clearChanges(rows, cols, b).map((c) => c.key + c.id), ['a1', 'b1', 'a2', 'b2', 'a3', 'b3']);
  const f = fillChanges(rows, cols, b);
  assert.deepEqual(f.map((c) => [c.id, c.key, c.before, c.after]), [[2, 'a', 'a2', 'a1'], [3, 'a', 'a3', 'a1'], [2, 'b', 'b2', 'b1'], [3, 'b', 'b3', 'b1']]);
});
