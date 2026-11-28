// BE13-08A — adversarial vectors for retry, recovery, quarantine and replay (offline).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createResilientMeasurementIngestionRoot } from '../dist/src/services/measurement-ingestion-root.js';
import { createProductionPlaceholders } from '../dist/src/adapters/ingestion-production-placeholders.js';
import { quarantineIdFor } from '../dist/src/repositories/mongo-ingestion-quarantine.store.js';
import { quarantineValidator } from '../dist/src/models/ingestion-quarantine.models.js';
import { protectedDocument, world, createInMemoryPersistence, createTestOnlyRetryPolicy, createDeterministicScheduler,
  createInMemoryRecovery, createInMemoryQuarantine } from '../test-support/be13-composition.fixtures.js';

const ACK = { mode: 'current-state-only', limitation: 'DEVICE_STATUS_HISTORY_REQUIRED' };
const verifier = { verify: e => (e && e.syntheticTestOnly === true ? { sourceId: e.sourceId, operation: 'telemetry', eventId: e.eventId, device: { kind: 'mqtt-clientid', value: e.clientid } } : null) };
const evidenceFor = doc => ({ syntheticTestOnly: true, sourceId: doc.sourceId, eventId: doc.eventId, clientid: doc.clientid });
async function setup(extra = {}, persistenceWrap) {
  const w = world(); const persistence = createInMemoryPersistence(w.calls); const quarantine = await createInMemoryQuarantine();
  const deps = { realmAuthority: { authorizedRealm: () => 'test' }, provenanceVerifier: verifier, hardware: w.deps.hardware, temporal: w.deps.temporal,
    catalogue: w.deps.catalogue, policies: w.deps.policies, identityStore: w.deps.identityStore, persistence: persistenceWrap ? persistenceWrap(persistence) : persistence,
    be12: { temporal: { select: async e => ({ status: 'trusted', at: e.receivedAt, clock: 'received-at' }) }, catalogue: { accepts: async () => true } },
    deviceStatusHistory: ACK, retryPolicy: createTestOnlyRetryPolicy(3, w.calls), retryScheduler: createDeterministicScheduler(w.calls),
    recovery: createInMemoryRecovery(persistence, w.calls), quarantine, ...extra };
  return { w, persistence, quarantine, deps, root: createResilientMeasurementIngestionRoot(deps) };
}
const ingest = (root, patch = {}, field = 'temperature') => { const doc = protectedDocument(patch); return root.ingest(doc, evidenceFor(doc), { field }); };
const down = p => ({ lookup: p.lookup, persistAtomically: async () => { throw new Error('down'); } });

test('A1 a "retryable" flag in the payload or the selection cannot make a security failure retryable', async () => {
  const s = await setup({ hardware: createProductionPlaceholders().hardware });
  const doc = protectedDocument({ payload: { temperature: 1, retryable: true, retryClass: 'transient', status: 'RETRYABLE' } });
  const r = await s.root.ingest(doc, evidenceFor(doc), { field: 'temperature', retryable: true });
  assert.deepEqual([r.retryClass, r.quarantineStatus], ['security', 'BLOCKED']);
  assert.equal(s.w.calls.filter(([n]) => n === 'retry:decide').length, 0);
});

test('A2 forcing a replay of BLOCKED, RESOLVED or DISCARDED entries is refused; illegal status jumps are refused', async () => {
  const s = await setup({ hardware: createProductionPlaceholders().hardware });
  const doc = protectedDocument();
  const q = await s.root.ingest(doc, evidenceFor(doc), { field: 'temperature' });
  assert.equal((await s.root.replay({ quarantineId: q.quarantineId, protectedDocument: doc, provenanceEvidence: evidenceFor(doc), field: 'temperature' })).reasonCode, 'replay-not-allowed');
  for (const to of ['RESOLVED', 'OPEN', 'RETRYABLE']) {
    assert.notEqual(await s.quarantine.transition({ quarantineId: q.quarantineId, from: 'BLOCKED', to, evidence: 'forged:evidence', outcome: 'forced' }), 'transitioned', to);
  }
  assert.equal(await s.quarantine.transition({ quarantineId: q.quarantineId, from: 'RETRYABLE', to: 'RESOLVED', evidence: null, outcome: 'forced' }), 'stale');
  assert.equal(await s.quarantine.transition({ quarantineId: q.quarantineId, from: 'BLOCKED', to: 'DISCARDED', evidence: 'operator:discard', outcome: 'discarded' }), 'transitioned');
  assert.equal((await s.root.replay({ quarantineId: q.quarantineId, protectedDocument: doc, provenanceEvidence: evidenceFor(doc), field: 'temperature' })).reasonCode, 'replay-not-allowed');
});

test('A3 forged, malformed or cross-realm quarantine ids are rejected', async () => {
  const s = await setup();
  const doc = protectedDocument();
  for (const id of ['q_' + 'f'.repeat(64), 'q_' + 'F'.repeat(64), 'x', '', null, { $ne: null }]) {
    const r = await s.root.replay({ quarantineId: id, protectedDocument: doc, provenanceEvidence: evidenceFor(doc), field: 'temperature' });
    assert.ok(['quarantine-not-found', 'invalid-replay-input'].includes(r.reasonCode), String(id));
  }
  const entry = { realm: 'preview', stage: 'persistence', sourceId: 's', operation: 'measurement', eventId: 'e', field: 'f', device: null, reasonCode: 'dependency-error',
    cause: null, retryClass: 'transient', fingerprint: null, documentDigest: null };
  assert.notEqual(quarantineIdFor(entry), quarantineIdFor({ ...entry, realm: 'test' }), 'the realm is part of the quarantine identity');
  await assert.rejects(s.quarantine.record(entry), /REALM/);
});

test('A4 a malicious recovery (other realm, foreign fingerprint, garbage) never yields success', async () => {
  const cases = [
    [{ inspect: async k => ({ realm: 'production', state: 'committed', measurementId: 'm_' + 'a'.repeat(64), fingerprint: 'a'.repeat(64) }) }, 'realm-mismatch'],
    [{ inspect: async k => ({ realm: k.realm, state: 'committed', measurementId: 'm_' + 'a'.repeat(64), fingerprint: 'b'.repeat(64) }) }, 'idempotency-conflict'],
    [{ inspect: async k => ({ realm: k.realm, state: 'committed' }) }, 'persistence-uncertain'],
    [{ inspect: async () => ({ get state() { throw new Error('x'); } }) }, 'persistence-uncertain'],
    [{ inspect: async k => ({ realm: k.realm, state: 'maybe' }) }, 'persistence-uncertain'],
  ];
  for (const [recovery, expected] of cases) {
    const s = await setup({ recovery }, down);
    const r = await ingest(s.root);
    assert.equal(r.status, 'quarantined'); assert.equal(r.reasonCode, expected);
  }
});

test('A5 a malicious quarantine store answer is treated as unavailable (uncertain), never as success', async () => {
  for (const record of [async () => ({ quarantineId: 'x' }), async e => ({ realm: 'production', quarantineId: 'q_' + 'a'.repeat(64), status: 'RESOLVED', attemptCount: 1 }), async () => null]) {
    const s = await setup({ hardware: createProductionPlaceholders().hardware, quarantine: { record, get: async () => null, transition: async () => 'not-found', appendAudit: async () => false } });
    const r = await ingest(s.root);
    assert.deepEqual([r.status, r.reasonCode], ['uncertain', 'quarantine-unavailable']);
  }
});

test('A6 retry amplification is impossible: hard ceiling even with a hostile always-retry policy', async () => {
  let calls = 0;
  const s = await setup({ retryPolicy: { decide: () => ({ action: 'retry' }) } }, p => ({ lookup: p.lookup, persistAtomically: async () => { calls += 1; throw new Error('down'); } }));
  const r = await ingest(s.root);
  assert.deepEqual([r.attempts, calls], [10, 10]);
  const weird = await setup({ retryPolicy: { decide: () => ({ action: 'RETRY', forever: true }) } }, down);
  assert.equal((await ingest(weird.root)).attempts, 1);
  const thrower = await setup({ retryPolicy: { decide: () => { throw new Error('x'); } } }, down);
  assert.equal((await ingest(thrower.root)).attempts, 1);
});

test('A7 quarantine poisoning: the schema forbids payload, stack, secrets and invalid status/counters', () => {
  const s = quarantineValidator.$jsonSchema;
  assert.equal(s.additionalProperties, false);
  for (const forbidden of ['rawPayload', 'payload', 'stack', 'message', 'x-emqx-key', 'uri', 'token']) assert.equal(Object.hasOwn(s.properties, forbidden), false, forbidden);
  // BE13-09 adds REPLAYING (replay lease) and a CAS version.
  assert.deepEqual(s.properties.status.enum, ['OPEN', 'RETRYABLE', 'REPLAYING', 'BLOCKED', 'RESOLVED', 'DISCARDED']);
  assert.equal(s.properties.version.minimum, 1);
  assert.equal(s.properties.attemptCount.minimum, 1);
  assert.equal(s.properties.reasonCode.pattern, '^[a-z][a-z0-9-]{1,63}$');
  assert.equal(s.properties.audit.maxItems, 100);
});

test('A8 error leak: quarantine entries and results never carry messages or connection strings', async () => {
  const s = await setup({}, p => ({ lookup: p.lookup, persistAtomically: async () => { throw new Error('mongodb://user:pass@host/db stack trace'); } }));
  const r = await ingest(s.root);
  const stored = await s.quarantine.get(r.quarantineId);
  assert.equal(/mongodb|pass|stack/.test(JSON.stringify([r, stored])), false);
});

test('A9 idempotency bypass through retry: every retry keeps realm, eventId, field and fingerprint', async () => {
  const seen = []; let n = 0;
  const s = await setup({}, p => ({ lookup: p.lookup, async persistAtomically(i) { seen.push(JSON.stringify([i.key, i.fingerprint])); if (++n < 3) throw new Error('down'); return p.persistAtomically(i); } }));
  const r = await ingest(s.root);
  assert.deepEqual([r.status, r.attempts, new Set(seen).size, seen.length], ['accepted', 3, 1, 3]);
});

test('A10 no runtime: the resilient root is not mounted and reads no environment', () => {
  for (const file of ['src/app.ts']) for (const token of ['measurement-ingestion-root', 'quarantine', 'recovery']) assert.equal(readFileSync(new URL('../' + file, import.meta.url), 'utf8').includes(token), false);
  for (const file of ['src/services/measurement-ingestion-root.ts', 'src/repositories/mongo-ingestion-quarantine.store.ts', 'src/repositories/mongo-persistence-recovery.repository.ts',
    'src/iot/ingestion-failure-classification.ts']) {
    const text = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    for (const forbidden of ['process.env', 'setInterval', 'setTimeout', 'Date.now', 'Math.random']) assert.equal(text.includes(forbidden), false, `${file}: ${forbidden}`);
  }
});
