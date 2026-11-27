// BE13-11J — mutation check (6 mutants). Each mutant rewrites ONE statement of the compiled module, imports the mutated copy and must be killed
// by the invariant checker. The unmutated modules must pass the same checker (otherwise "killed" would prove nothing).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { checkInvariants } from '../test-support/be13-11j-invariants.js';

const SERVICE = 'dist/src/services/ingest-confirmation.service.js', RECON = 'dist/scripts/be13-11j/publisher-reconciler.js', PERSIST = 'dist/src/repositories/mongo-measurement-persistence.repository.js';
const url = p => new URL('../' + p, import.meta.url);
const load = async (p, patch, tag) => {
  if (!patch) return import(url(p).href);
  const text = readFileSync(url(p), 'utf8'); assert.equal(text.split(patch[0]).length - 1, 1, 'mutation anchor must match exactly once: ' + patch[0].slice(0, 60));
  const copy = p.replace(/\.js$/, `.mut-${tag}.js`); writeFileSync(url(copy), text.replace(patch[0], patch[1]));
  try { return await import(url(copy).href); } finally { rmSync(url(copy), { force: true }); }
};
async function run(mutation) {
  const base = { service: await load(SERVICE), recon: await load(RECON), persist: await load(PERSIST) };
  const m = { ...base };
  if (mutation) m[mutation.module] = await load(mutation.path, mutation.patch, mutation.id);
  return checkInvariants({ createService: m.service.createIngestConfirmationService, reconcilePublish: m.recon.reconcilePublish, idempotencyDocumentId: m.persist.idempotencyDocumentId });
}

const MUTANTS = [
  { id: 'M1', what: 'publisher treats PUBACK as final', module: 'recon', path: RECON, kills: 'INV-A',
    patch: ['brokerAcceptedAny ||= brokerAccepted;', "brokerAcceptedAny ||= brokerAccepted; if (brokerAccepted) return { eventId, outcome: 'CONFIRMED', attempts: attempt, brokerAcceptedAny, finalConfirmation: 'puback', exhausted: null, trail };"] },
  { id: 'M2', what: 'retry uses a new eventId', module: 'recon', path: RECON, kills: 'INV-B',
    patch: ['await deps.publish(eventId, attempt)', "await deps.publish(eventId + '-r' + attempt, attempt)"] },
  { id: 'M3', what: 'confirmation accepts an event of another tenant', module: 'service', path: SERVICE, kills: 'INV-C',
    patch: ['r.realm === scope.realm && r.sourceId === scope.sourceId && r.eventId === eventId', 'r.realm === scope.realm && r.eventId === eventId'] },
  { id: 'M4', what: 'pending is read as confirmed', module: 'recon', path: RECON, kills: 'INV-D',
    patch: ['CONFIRMED_STATUSES.includes(answer.status)', "(CONFIRMED_STATUSES.includes(answer.status) || answer.status === 'pending')"] },
  { id: 'M5', what: 'a duplicate gets a new idempotency identity (second measurement)', module: 'persist', path: PERSIST, kills: 'INV-E',
    patch: ["JSON.stringify(['be13-06/v1', key.realm,", "JSON.stringify(['be13-06/v1', Math.random(), key.realm,"] },
  { id: 'M6', what: 'retry exhausted silently becomes success', module: 'recon', path: RECON, kills: 'INV-F',
    patch: ["return { eventId, outcome: 'UNCONFIRMED_EXPLICIT', attempts: trail.length", "return { eventId, outcome: 'CONFIRMED', attempts: trail.length"] },
];

test('MUT0 control: the unmutated modules satisfy every invariant', async () => { assert.deepEqual(await run(null), []); });
for (const m of MUTANTS) test(`${m.id} killed — ${m.what}`, async () => {
  const violated = await run({ ...m });
  assert.ok(violated.includes(m.kills), `${m.id} survived: violated=${JSON.stringify(violated)}`);
});
