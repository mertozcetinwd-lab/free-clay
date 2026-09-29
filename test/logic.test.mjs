import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coerce, toDate, inferType, invalid, fmtMicros, displayText } from '../public/js/types.js';
import { applyFilters, sortRows, fillRate, builtInView, indexMeta, searchRows } from '../public/js/logic.js';
import { mapHeaders, parseCsv } from '../src/csv.js';

test('dates: ISO, US order, month names; impossible days refused', () => {
  assert.equal(toDate('2026-09-27T10:00:00Z'), '2026-09-27');
  assert.equal(toDate('9/27/26'), '2026-09-27');
  assert.equal(toDate('Sep 27, 2026'), '2026-09-27');
  assert.equal(toDate('2026-02-30'), null);
  assert.equal(toDate('27'), null);
});

test('coerce keeps mismatches as text and clears blanks', () => {
  assert.equal(coerce('number', '1,200'), 1200);
  assert.equal(coerce('number', 'n/a'), 'n/a');
  assert.equal(coerce('number', '  '), null);
  assert.equal(coerce('checkbox', 'No'), false);
  assert.deepEqual(coerce('multi_select', '["x","y"]'), ['x', 'y']);
  assert.equal(invalid('number', 'n/a'), true);
  assert.equal(invalid('email', 'not-an-email'), true);
});

test('type inference from headers and values', () => {
  assert.equal(inferType('Work Email', []), 'email');
  assert.equal(inferType('Site', ['https://a.example.com']), 'url');
  assert.equal(inferType('Revenue', ['$1,000', '$20.50']), 'currency');
  assert.equal(inferType('Employees', ['12', '40']), 'number');
  assert.equal(inferType('Phone', ['3525551234']), 'text');
  assert.equal(inferType('Zip', ['32601']), 'text');
});

test('money shows fractions of a cent for cheap calls', () => {
  assert.equal(fmtMicros(0), '$0');
  assert.equal(fmtMicros(1900), '$0.0019');
  assert.equal(fmtMicros(350000), '$0.35');
});

test('header mapping: exact first, then alias group, never two headers into one column', () => {
  const cols = [{ key: 'website', name: 'Website' }, { key: 'email', name: 'Email' }];
  assert.deepEqual(mapHeaders(['Domain', 'Company Website', 'E-mail', 'City'], cols), ['website', null, 'email', null]);
  assert.deepEqual(mapHeaders(['website', 'Website'], cols), ['website', null]);
});

test('CSV parser handles quotes, newlines inside quotes and a BOM', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","line1\nline2"\r\n\r\n'), [['a', 'b'], ['x, y', 'line1\nline2']]);
});

const cols = [
  { id: 1, key: 'name', type: 'text', kind: 'data' },
  { id: 2, key: 'emp', type: 'number', kind: 'data' },
  { id: 3, key: 'email', type: 'email', kind: 'enrich' },
];
const rows = [
  { id: 1, data: { name: 'Acme', emp: 12, email: 'a@acme.example.com' } },
  { id: 2, data: { name: 'Beta', emp: 'lots' } },
  { id: 3, data: { name: 'Cato', emp: 4 } },
];

test('filters, search and sort (empty and mistyped values sink)', () => {
  assert.deepEqual(applyFilters(rows, [{ col: 'emp', op: 'gt', value: '5' }], cols).map((r) => r.id), [1]);
  assert.deepEqual(applyFilters(rows, [{ col: 'email', op: 'empty' }], cols).map((r) => r.id), [2, 3]);
  assert.deepEqual(searchRows(rows, 'cat', cols).map((r) => r.id), [3]);
  assert.deepEqual(sortRows(rows, { col: 'emp', dir: 'asc' }, cols).map((r) => r.id), [3, 1, 2]);
  assert.deepEqual(sortRows(rows, { col: 'emp', dir: 'desc' }, cols).map((r) => r.id), [1, 3, 2]);
});

test('fill rate counts only valid values', () => {
  assert.equal(fillRate(rows, cols[1]), 67);
  assert.equal(fillRate(rows, cols[2]), 33);
  assert.equal(fillRate([], cols[2]), 0);
});

test('built-in views: errored and fully enriched', () => {
  const meta = indexMeta([{ row_id: 2, column_id: 3, status: 'error' }]);
  assert.deepEqual(builtInView('errored', rows, cols, meta).map((r) => r.id), [2]);
  assert.deepEqual(builtInView('enriched', rows, cols, meta).map((r) => r.id), [1]);
  assert.deepEqual(applyFilters(rows, [{ col: 'email', op: 'status_error' }], cols, meta).map((r) => r.id), [2]);
  assert.equal(displayText('multi_select', ['a', 'b']), 'a, b');
});
