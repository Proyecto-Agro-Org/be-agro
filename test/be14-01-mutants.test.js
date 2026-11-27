// BE14-01 — mutation check (8 mutants) over the compiled reference publisher.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { checkPublisherInvariants } from '../test-support/be14-01-invariants.js';

const LIB = 'dist/scripts/be14-01/reference-publisher.js';
const url = p => new URL('../' + p, import.meta.url);
const load = async patch => {
  if (!patch) return import(url(LIB).href);
  const text = readFileSync(url(LIB), 'utf8'); assert.equal(text.split(patch[0]).length - 1, 1, 'mutation anchor must match exactly once: ' + patch[0].slice(0, 80));
  const copy = LIB.replace(/\.js$/, `.mut-${patch[2]}.js`); writeFileSync(url(copy), text.replace(patch[0], patch[1]));
  try { return await import(url(copy).href); } finally { rmSync(url(copy), { force: true }); }
};
const MUTANTS = [
  { id: 'M1', what: 'PUBACK is treated as success', kills: 'INV-P1', patch: ["move(e, 'publish-ok');", "move(e, 'publish-ok'); e.state = 'CONFIRMED';"] },
  { id: 'M2', what: 'a retry generates a new eventId', kills: 'INV-P2', patch: ['o.mqtt.publish(e.eventId,', "o.mqtt.publish(e.eventId + '-r' + e.publishAttempts,"] },
  { id: 'M3', what: 'a retry generates a new hash (different bytes)', kills: 'INV-P3', patch: ["o.mqtt.publish(e.eventId, Buffer.from(e.payloadB64, 'base64'))", "o.mqtt.publish(e.eventId, Buffer.concat([Buffer.from(e.payloadB64, 'base64'), Buffer.from(' ')]))"] },
  { id: 'M4', what: 'a restart loses the outbox', kills: 'INV-P4', patch: ['let snap = o.store.load();', 'let snap = { nextSeq: 1, entries: [] };'] },
  { id: 'M5', what: '`pending` finalizes the entry as confirmed', kills: 'INV-P5', patch: ['counters.reconciliation_pending += 1;', "{ counters.reconciliation_pending += 1; finish(e, 'confirmed', label); persist(); return; }"] },
  { id: 'M6', what: 'a conflict is retried instead of terminal', kills: 'INV-P6', patch: ["a.status === 'conflict'", "a.status === 'never-conflict'"] },
  { id: 'M7', what: 'HTTP 429 is ignored', kills: 'INV-P7', patch: ["if (a.kind === 'throttled') {", 'if (false) {'] },
  { id: 'M8', what: 'an answer about another eventId is accepted', kills: 'INV-P8', patch: ['b.eventId !== eventId || ', ''] },
];
test('P-MUT0 control: the unmutated module satisfies every invariant', async () => { assert.deepEqual(await checkPublisherInvariants(await load(null)), []); });
for (const m of MUTANTS) test(`${m.id} killed — ${m.what}`, async () => { const v = await checkPublisherInvariants(await load([...m.patch, m.id])); assert.ok(v.includes(m.kills), `${m.id} survived: ${JSON.stringify(v)}`); });
