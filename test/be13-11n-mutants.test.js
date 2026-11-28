// BE13-11N — mutation check (8 mutants) over the compiled publisher outbox.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { checkOutboxInvariants } from '../test-support/be13-11n-invariants.js';

const LIB = 'dist/scripts/be13-11n/publisher-outbox.js';
const url = p => new URL('../' + p, import.meta.url);
const load = async patch => {
  if (!patch) return import(url(LIB).href);
  const text = readFileSync(url(LIB), 'utf8'); assert.equal(text.split(patch[0]).length - 1, 1, 'mutation anchor must match exactly once: ' + patch[0].slice(0, 70));
  const copy = LIB.replace(/\.js$/, `.mut-${patch[2]}.js`); writeFileSync(url(copy), text.replace(patch[0], patch[1]));
  try { return await import(url(copy).href); } finally { rmSync(url(copy), { force: true }); }
};
const MUTANTS = [
  { id: 'M1', what: 'PUBACK is treated as final success', kills: 'INV-N1', patch: ['e.brokerAcceptedCount += 1;', "{ e.brokerAcceptedCount += 1; e.status = 'CONFIRMED'; }"] },
  { id: 'M2', what: 'a retry uses a derived eventId', kills: 'INV-N2', patch: ['deps.publish(e.eventId, Buffer.from(e.payloadB64', 'deps.publish(e.eventId + \'-r\' + e.attempts, Buffer.from(e.payloadB64'] },
  { id: 'M3', what: 'a full outbox silently drops the oldest entry', kills: 'INV-N3', patch: ["if (active() >= policy.capacity)\n            return { result: 'REJECTED_OUTBOX_FULL' };", 'if (active() >= policy.capacity)\n            entries.shift();'] },
  { id: 'M4', what: 'a restart ignores the durable state', kills: 'INV-N4', patch: ['let entries = options.store.load();', 'let entries = [];'] },
  { id: 'M5', what: 'an eventId reused with other bytes is reported as already present', kills: 'INV-N5', patch: ['existing.payloadSha256 === sha ?', 'true ?'] },
  { id: 'M6', what: 'a conflict is retried instead of terminal', kills: 'INV-N6', patch: ["answer.status === 'conflict'", "answer.status === 'never-conflict'"] },
  { id: 'M7', what: 'an exhausted slow lane becomes success', kills: 'INV-N7', patch: ["finish(e, 'UNCONFIRMED_EXPLICIT', t, label)", "finish(e, 'CONFIRMED', t, label)"] },
  { id: 'M8', what: 'pending is read as confirmed', kills: 'INV-N8', patch: ['CONFIRMED_STATUSES.includes(answer.status)', "(CONFIRMED_STATUSES.includes(answer.status) || answer.status === 'pending')"] },
];
test('N-MUT0 control: the unmutated module satisfies every invariant', async () => { assert.deepEqual(await checkOutboxInvariants(await load(null)), []); });
for (const m of MUTANTS) test(`${m.id} killed — ${m.what}`, async () => { const v = await checkOutboxInvariants(await load([...m.patch, m.id])); assert.ok(v.includes(m.kills), `${m.id} survived: ${JSON.stringify(v)}`); });
