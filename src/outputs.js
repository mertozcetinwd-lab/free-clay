/**
 * "Add as column": turn one field of an enrichment's result into its own column. Clay calls this
 * defining outputs. The new column fills at once from results already stored in cells_meta, so
 * adding an output after a run needs no re-run and costs nothing.
 */

import { fail } from './util.js';
import { getColumn, createColumn, patchColumn } from './tables.js';
import { getFunction } from './functions/index.js';

const OUTPUT_KINDS = ['enrich', 'waterfall', 'ai', 'http', 'message'];

export async function addOutputColumn(db, colId, body) {
  const col = await getColumn(db, colId);
  if (!OUTPUT_KINDS.includes(col.kind)) fail(400, 'Only computed columns have outputs');
  const field = String(body?.field || '').trim();
  if (!/^[A-Za-z0-9_.[\]-]{1,80}$/.test(field)) fail(400, 'Bad output field');
  const already = (col.config.outputs || []).find((o) => o.field === field);
  if (already) fail(409, `That field already fills the column “${already.column}”`);
  const fn = col.kind === 'enrich' ? getFunction(col.config.fn) : null;
  const known = fn?.outputs.find((o) => o.key === field);
  const out = await createColumn(db, col.table_id, {
    name: String(body.name || known?.label || field).slice(0, 80),
    type: body.type || known?.type || 'text',
    position: body.position,
  });
  const outputs = [...(col.config.outputs || []).filter((o) => o.field !== field), { field, column: out.key }];
  await patchColumn(db, col.id, { config: { ...col.config, outputs } });
  // Backfill from stored results. The path is a bound parameter.
  await db.prepare(`UPDATE rows SET data = json_set(data, ?2, json_extract(m.result, ?3))
      FROM cells_meta m WHERE m.row_id = rows.id AND m.column_id = ?1 AND m.result IS NOT NULL
        AND json_extract(m.result, ?3) IS NOT NULL`).bind(col.id, `$."${out.key}"`, `$.${field.includes('.') || field.includes('[') ? field : `"${field}"`}`).run();
  return { column: out, source: await getColumn(db, col.id) };
}
