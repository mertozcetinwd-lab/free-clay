/**
 * Auto-run. Off by default (Clay has it on): with the setting on, a column that has "auto-run"
 * ticked re-runs for a row when a person changes one of its inputs, and runs for new rows.
 * Each trigger is an ordinary run with the default budget cap, so it shows in Spend like any other.
 *
 * Writes made BY a run never trigger auto-run. That rules out loops (column A feeding column B
 * feeding A) at the price of chains: an output that feeds another auto column needs a click.
 */

import { parseJson } from './util.js';
import { hooks, loadColumns } from './tables.js';
import { enqueueRun } from './runner.js';
import { columnRefs } from '../public/js/template.js';
import { COMPUTED } from '../public/js/logic.js';

export { columnRefs };

hooks.afterWrite = async (db, tableId, change) => {
  const on = await db.prepare(`SELECT value FROM settings WHERE key='auto_run'`).first();
  if (parseJson(on?.value, false) !== true) return;
  const cols = await loadColumns(db, tableId);
  const auto = cols.filter((c) => COMPUTED.includes(c.kind) && c.config.auto);
  if (!auto.length) return;
  if (change.newRows) {
    for (const c of auto) await enqueueRun(db, tableId, { column_id: c.id, scope: 'empty' });
    return;
  }
  // A changed input also changes every formula that reads it (and formulas reading those).
  const changed = new Set(change.changed);
  const formulas = cols.filter((c) => c.kind === 'formula');
  for (let grew = true; grew;) {
    grew = false;
    for (const f of formulas) if (!changed.has(f.key) && [...columnRefs(f)].some((k) => changed.has(k))) { changed.add(f.key); grew = true; }
  }
  for (const c of auto) {
    if ([...columnRefs(c)].some((k) => changed.has(k))) await enqueueRun(db, tableId, { column_id: c.id, scope: 'selected', row_ids: change.rowIds });
  }
};
