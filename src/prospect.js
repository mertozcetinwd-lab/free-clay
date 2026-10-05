import { fail, nowIso } from './util.js';

const idOf = (value) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) fail(400, 'Bad sequence id');
  return id;
};
const short = (value, max) => String(value ?? '').trim().slice(0, max);
const out = (row) => row && { ...row, steps: JSON.parse(row.steps) };

export async function listProspectSequences(db) {
  const { results } = await db.prepare('SELECT * FROM prospect_sequences ORDER BY updated_at DESC LIMIT 200').all();
  return results.map(out);
}

export async function saveProspectSequence(db, input, id = null) {
  const name = short(input?.name, 100);
  if (!name) fail(400, 'Name the draft sequence');
  if (!Array.isArray(input?.steps) || input.steps.length > 20) fail(400, 'Use up to 20 steps');
  const steps = input.steps.map((raw, index) => {
    if (!['email_draft', 'manual_task'].includes(raw?.type)) fail(400, `Step ${index + 1} needs a draft or manual task`);
    const delay_days = Number(raw.delay_days);
    if (!Number.isInteger(delay_days) || delay_days < 0 || delay_days > 365) fail(400, `Step ${index + 1} needs a valid day delay`);
    const subject = short(raw.subject, 180), body = short(raw.body, 10000), variant = short(raw.variant, 30) || 'A';
    if (!body || (raw.type === 'email_draft' && !subject)) fail(400, `Step ${index + 1} needs text and a draft subject`);
    return { type: raw.type, delay_days, subject, body, variant };
  });
  const at = nowIso();
  if (id !== null) {
    const row = await db.prepare('UPDATE prospect_sequences SET name=?2,steps=?3,updated_at=?4 WHERE id=?1 RETURNING *')
      .bind(idOf(id), name, JSON.stringify(steps), at).first();
    if (!row) fail(404, 'Draft sequence not found');
    return out(row);
  }
  return out(await db.prepare('INSERT INTO prospect_sequences(name,steps,created_at,updated_at) VALUES (?1,?2,?3,?3) RETURNING *')
    .bind(name, JSON.stringify(steps), at).first());
}
