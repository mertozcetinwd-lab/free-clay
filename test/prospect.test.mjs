import { test } from 'node:test';
import assert from 'node:assert/strict';
import { client, fakeEnv } from './helpers.mjs';

test('prospecting drafts persist steps and cannot send', async () => {
  const api = await client(fakeEnv());
  const draft = await api.post('/api/prospect/sequences', { name: 'Review first', steps: [
    { type: 'email_draft', delay_days: 0, subject: 'A question', body: 'Hi {{first_name}}, {{reason to contact}}', variant: 'A' },
    { type: 'manual_task', delay_days: 3, body: 'Review before any follow-up', variant: 'A' },
  ] });
  assert.equal(draft.status, 201);
  assert.equal(draft.body.steps.length, 2);
  assert.equal(draft.body.sending_enabled, undefined);
  assert.equal((await api.get('/api/prospect/sequences')).body[0].steps[1].type, 'manual_task');
  const revised = await api.put(`/api/prospect/sequences/${draft.body.id}`, { name: 'Review later', steps: [] });
  assert.equal(revised.body.name, 'Review later');
  assert.deepEqual(revised.body.steps, []);
  assert.equal((await api.post('/api/prospect/sequences', { name: 'Bad', steps: [{ type: 'email_draft', delay_days: -1, body: 'Hi' }] })).status, 400);
  assert.equal((await api.post('/api/prospect/sequences', { name: 'No subject', steps: [{ type: 'email_draft', delay_days: 0, body: 'Hi' }] })).status, 400);
  assert.equal((await api.post('/api/prospect/sequences', { name: 'Too many', steps: Array(21).fill({ type: 'manual_task', delay_days: 0, body: 'Review' }) })).status, 400);
});
