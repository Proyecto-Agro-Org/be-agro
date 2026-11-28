// BE13-08 — retry semantics, R1 recovery, quarantine and replay (offline).
// Doubles are synthetic and TEST_ONLY (test-support/); real-Mongo behaviour is in the campaign.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createResilientMeasurementIngestionRoot, describeIngestionRootReadiness } from '../dist/src/services/measurement-ingestion-root.js';
import { createProductionPlaceholders, createBlockingRetryPolicy, createBlockingRetryScheduler } from '../dist/src/adapters/ingestion-production-placeholders.js';
import { classifyIngestionFailure, isTransitionAllowed, initialQuarantineStatus } from '../dist/src/iot/ingestion-failure-classification.js';
import { technicalInputFingerprint } from '../dist/src/iot/ingestion-event-fingerprint.js';
import { protectedDocument, mapDocument, device, world, createInMemoryPersistence, createTestOnlyRetryPolicy, createDeterministicScheduler,
  createInMemoryRecovery, createInMemoryQuarantine } from '../test-support/be13-composition.fixtures.js';

const ACK = { mode: 'current-state-only', limitation: 'DEVICE_STATUS_HISTORY_REQUIRED' };
const verifier = { verify: e => (e && e.syntheticTestOnly === true ? { sourceId: e.sourceId, operation: 'telemetry', eventId: e.eventId, device: { kind: 'mqtt-clientid', value: e.clientid } } : null) };
const evidenceFor = doc => ({ syntheticTestOnly: true, sourceId: doc.sourceId, eventId: doc.eventId, clientid: doc.clientid });

async function setup({ worldOverrides = {}, maxAttempts = 3, persistenceWrap, extra = {} } = {}) {
  const w = world(worldOverrides);
  const persistence = createInMemoryPersistence(w.calls);
  const quarantine = await createInMemoryQuarantine();
  const scheduler = createDeterministicScheduler(w.calls);
  const deps = { realmAuthority: { authorizedRealm: () => 'test' }, provenanceVerifier: verifier, hardware: w.deps.hardware, temporal: w.deps.temporal,
    catalogue: w.deps.catalogue, policies: w.deps.policies, identityStore: w.deps.identityStore, persistence: persistenceWrap ? persistenceWrap(persistence) : persistence,
    be12: { temporal: { select: async e => ({ status: 'trusted', at: e.receivedAt, clock: 'received-at' }) }, catalogue: { accepts: async () => true } },
    deviceStatusHistory: ACK, retryPolicy: createTestOnlyRetryPolicy(maxAttempts, w.calls), retryScheduler: scheduler,
    recovery: createInMemoryRecovery(persistence, w.calls), quarantine, ...extra };
  return { w, persistence, quarantine, scheduler, deps, root: createResilientMeasurementIngestionRoot(deps) };
}
const ingest = (root, patch = {}, field = 'temperature', options) => { const doc = protectedDocument(patch, options); return root.ingest(doc, evidenceFor(doc), { field }); };
const count = (calls, name) => calls.filter(([n]) => n === name).length;
const keyId = (eventId = 'synthetic-telemetry-001', field = 'temperature') => JSON.stringify(['test', 'synthetic-ingest', 'measurement', eventId, field]);

// ---------------------------------------------------------------- classification & state machine
test('BE13-08 classification is deterministic and closed', () => {
  const cases = [['persistence-unavailable', null, 'ambiguous-commit'], ['dependency-error', null, 'transient'], ['builder-rejected', 'stale-hardware', 'transient'],
    ['trust-gate-rejected', 'unverified-hardware', 'security'], ['realm-mismatch', null, 'security'], ['attribution-drift', 'clientId', 'security'],
    ['idempotency-conflict', null, 'conflict'], ['builder-rejected', 'unresolved-clock', 'policy-blocked'], ['trust-gate-rejected', 'inactive-device', 'policy-blocked'],
    ['builder-rejected', 'missing-reason-required', 'policy-blocked'], ['mapper-rejected', 'invalid-schema', 'validation'], ['mapper-rejected', 'unverified-provenance', 'security'],
    ['persistence-state-inconsistent', null, 'consistency'], ['internal-error', null, 'unknown'], ['totally-new-code', null, 'unknown'], [{ retryable: true }, 'x', 'unknown']];
  for (const [reason, cause, expected] of cases) assert.equal(classifyIngestionFailure(reason, cause).retryClass, expected, JSON.stringify([reason, cause]));
  assert.equal(classifyIngestionFailure('dependency-error', null).retryable, true);
  for (const c of ['security', 'validation', 'conflict', 'policy-blocked', 'consistency', 'unknown', 'ambiguous-commit']) {
    assert.equal(classifyIngestionFailure(c === 'security' ? 'realm-mismatch' : 'internal-error', null).retryable, false);
  }
  assert.deepEqual(['transient', 'security', 'policy-blocked', 'unknown'].map(initialQuarantineStatus), ['RETRYABLE', 'BLOCKED', 'BLOCKED', 'OPEN']);
});

test('BE13-08 quarantine state machine refuses arbitrary transitions', () => {
  assert.equal(isTransitionAllowed('RETRYABLE', 'RESOLVED', 'transient'), true);
  assert.equal(isTransitionAllowed('BLOCKED', 'RETRYABLE', 'policy-blocked'), true);
  for (const c of ['security', 'validation', 'conflict', 'consistency']) assert.equal(isTransitionAllowed('BLOCKED', 'RETRYABLE', c), false, c);
  for (const [from, to] of [['RESOLVED', 'RETRYABLE'], ['DISCARDED', 'OPEN'], ['BLOCKED', 'RESOLVED'], ['OPEN', 'RESOLVED'], ['RESOLVED', 'RESOLVED'], ['X', 'OPEN']]) {
    assert.equal(isTransitionAllowed(from, to, 'transient'), false, `${from}->${to}`);
  }
});

// ---------------------------------------------------------------- R1
test('R1-01 commit confirmed but caller sees an ambiguous error → recovered-committed, zero new writes', async () => {
  const s = await setup({ persistenceWrap: p => ({ lookup: p.lookup, async persistAtomically(input) { await p.persistAtomically(input); throw Object.assign(new Error('x'), { errorLabels: ['UnknownTransactionCommitResult'] }); } }) });
  const r = await ingest(s.root);
  assert.deepEqual([r.status, r.attempts, s.persistence.claims.size, s.persistence.measurements.size], ['recovered-committed', 1, 1, 1]);
  assert.equal(count(s.w.calls, 'persist:atomic'), 1, 'no re-execution after a confirmed commit');
  assert.equal(count(s.w.calls, 'retry:decide'), 0);
  assert.match(r.measurementId, /^m_/);
});

test('R1-02 commit did not happen → recovery says absent → exact retry persists once', async () => {
  let fail = true; const seen = [];
  const s = await setup({ persistenceWrap: p => ({ lookup: p.lookup, async persistAtomically(input) { seen.push(input); if (fail) { fail = false; throw new Error('aborted'); } return p.persistAtomically(input); } }) });
  const r = await ingest(s.root);
  assert.deepEqual([r.status, r.attempts, s.persistence.claims.size, s.persistence.measurements.size, s.scheduler.waits.length], ['accepted', 2, 1, 1, 1]);
  const inputs = seen.map(i => [i.key.eventId, i.key.field, i.key.realm, i.fingerprint]);
  assert.deepEqual(inputs.length, 2); assert.deepEqual(inputs[0], inputs[1], 'the retry keeps the exact same identity and fingerprint');
});

test('R1-03 claim without measurement → quarantined as persistence-state-inconsistent; evidence kept', async () => {
  const s = await setup();
  const c = mapDocument(protectedDocument());
  s.persistence.claims.set(keyId(), { fingerprint: technicalInputFingerprint('test', c, 'temperature'), measurementId: 'm_' + 'a'.repeat(64) });
  const r = await ingest(s.root);
  assert.deepEqual([r.status, r.reasonCode, r.retryClass, r.quarantineStatus], ['quarantined', 'persistence-state-inconsistent', 'consistency', 'BLOCKED']);
  assert.equal((await s.quarantine.get(r.quarantineId)).cause, 'orphan-claim');
  assert.equal(s.persistence.claims.size, 1, 'nothing repaired or deleted');
});

test('R1-04 measurement without claim → quarantined; nothing repaired', async () => {
  const s = await setup({ persistenceWrap: p => ({ lookup: p.lookup, async persistAtomically(input) {
    if ([...p.measurements.values()].some(m => m.key.eventId === input.key.eventId && m.key.field === input.key.field)) throw Object.assign(new Error('E11000'), { code: 11000 });
    return p.persistAtomically(input); } }) });
  s.persistence.measurements.set('m_orphan', { key: { realm: 'test', sourceId: 'synthetic-ingest', operation: 'measurement', eventId: 'synthetic-telemetry-001', field: 'temperature' }, fingerprint: 'b'.repeat(64) });
  const r = await ingest(s.root);
  assert.deepEqual([r.reasonCode, r.retryClass], ['persistence-state-inconsistent', 'consistency']);
  assert.equal((await s.quarantine.get(r.quarantineId)).cause, 'orphan-measurement');
  assert.deepEqual([s.persistence.claims.size, s.persistence.measurements.size], [0, 1]);
});

test('R1-05 fingerprint mismatch: different content → conflict; claim/measurement disagreement → inconsistent', async () => {
  const s = await setup();
  await ingest(s.root);
  const r = await ingest(s.root, { payload: { temperature: 9, soil_moisture: null } });
  assert.deepEqual([r.reasonCode, r.retryClass, r.quarantineStatus], ['idempotency-conflict', 'conflict', 'BLOCKED']);
  const t = await setup();
  await ingest(t.root);
  const claim = t.persistence.claims.get(keyId()); t.persistence.measurements.get(claim.measurementId).fingerprint = 'c'.repeat(64);
  const d = await ingest(t.root);
  assert.deepEqual([d.reasonCode, (await t.quarantine.get(d.quarantineId)).cause], ['persistence-state-inconsistent', 'fingerprint-mismatch']);
});

test('BE13-08 ordinary success and verified duplicate', async () => {
  const s = await setup();
  const a = await ingest(s.root), d = await ingest(s.root, {}, 'temperature', { receivedAt: 1795115700000, persistedAt: 1795115700010 });
  assert.deepEqual([a.status, d.status, d.measurementId], ['accepted', 'duplicate', a.measurementId]);
  assert.ok(count(s.w.calls, 'recovery:inspect') >= 1, 'a duplicate is confirmed against persisted state');
});

// ---------------------------------------------------------------- retry policy
test('BE13-08 retry is bounded by the policy and quarantined (RETRYABLE) when exhausted', async () => {
  const s = await setup({ maxAttempts: 3, persistenceWrap: p => ({ lookup: p.lookup, persistAtomically: async () => { throw new Error('down'); } }) });
  const r = await ingest(s.root);
  assert.deepEqual([r.status, r.attempts, r.quarantineStatus, r.retryClass], ['quarantined', 3, 'RETRYABLE', 'transient']);
  assert.equal((await s.quarantine.get(r.quarantineId)).cause, 'retry-exhausted');
  assert.equal(s.scheduler.waits.length, 2);
});

test('BE13-08 a policy that always retries is still capped by the hard ceiling', async () => {
  const s = await setup({ persistenceWrap: p => ({ lookup: p.lookup, persistAtomically: async () => { throw new Error('down'); } }),
    extra: { retryPolicy: { decide: () => ({ action: 'retry' }) } } });
  const r = await ingest(s.root);
  assert.deepEqual([r.status, r.attempts], ['quarantined', 10]);
});

test('BE13-08 production retry placeholders never retry automatically', async () => {
  const s = await setup({ persistenceWrap: p => ({ lookup: p.lookup, persistAtomically: async () => { throw new Error('down'); } }),
    extra: { retryPolicy: createBlockingRetryPolicy(), retryScheduler: createBlockingRetryScheduler() } });
  const r = await ingest(s.root);
  assert.deepEqual([r.attempts, r.quarantineStatus], [1, 'RETRYABLE']);
  const t = await setup({ persistenceWrap: p => ({ lookup: p.lookup, persistAtomically: async () => { throw new Error('down'); } }),
    extra: { retryScheduler: createBlockingRetryScheduler() } });
  assert.deepEqual([(await ingest(t.root)).attempts], [1], 'a scheduler that refuses stops retries');
});

// ---------------------------------------------------------------- classification into quarantine
test('BE13-08 security, policy-blocked and validation failures are quarantined BLOCKED without consulting the retry policy', async () => {
  const p = createProductionPlaceholders();
  const sec = await setup({ extra: { hardware: p.hardware } });
  const a = await ingest(sec.root);
  assert.deepEqual([a.reasonCode, a.retryClass, a.quarantineStatus], ['unverified-hardware', 'security', 'BLOCKED']);
  assert.equal(count(sec.w.calls, 'retry:decide'), 0);
  const pol = await setup({ worldOverrides: {} });
  const clock = await setup({ extra: { policies: { ...pol.deps.policies, clock: p.policies.clock } } });
  const b = await ingest(clock.root);
  assert.deepEqual([b.reasonCode, b.retryClass, b.quarantineStatus], ['unresolved-clock', 'policy-blocked', 'BLOCKED']);
  const inactive = await setup({ worldOverrides: { devices: [device({ lifecycle: 'inactive' })] } });
  assert.deepEqual([(await ingest(inactive.root)).retryClass], ['policy-blocked'], 'DEVICE_STATUS_HISTORY_REQUIRED');
  const val = await setup();
  const doc = { not: 'a protected document', secret: 'x-emqx-key=abc' };
  const c = await val.root.ingest(doc, {}, { field: 'temperature' });
  const stored = await val.quarantine.get(c.quarantineId);
  assert.deepEqual([c.retryClass, stored.sourceId, stored.eventId, stored.fingerprint], ['validation', null, null, null]);
  assert.match(stored.documentDigest, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(stored).includes('x-emqx-key'), false, 'no payload stored');
});

test('BE13-08 quarantine dedupe: the same failure twice is one record with attemptCount 2', async () => {
  const p = createProductionPlaceholders();
  const s = await setup({ extra: { hardware: p.hardware } });
  const a = await ingest(s.root), b = await ingest(s.root);
  assert.equal(a.quarantineId, b.quarantineId);
  const r = await s.quarantine.get(a.quarantineId);
  assert.deepEqual([s.quarantine.rows.size, r.attemptCount, r.audit.length], [1, 2, 2]);
});

test('BE13-08 quarantine is realm-isolated', async () => {
  const s = await setup({ extra: { hardware: createProductionPlaceholders().hardware } });
  const a = await ingest(s.root);
  const preview = await createInMemoryQuarantine('preview');
  for (const [k, v] of s.quarantine.rows) preview.rows.set(k, v);
  assert.equal(await preview.get(a.quarantineId), null);
});

test('BE13-08 unavailable quarantine store or recovery → uncertain / persistence-uncertain (never silent success)', async () => {
  const s = await setup({ extra: { hardware: createProductionPlaceholders().hardware, quarantine: { record: async () => { throw new Error('mongodb://x'); }, get: async () => null,
    transition: async () => 'not-found', appendAudit: async () => false } } });
  const r = await ingest(s.root);
  assert.deepEqual([r.status, r.reasonCode, JSON.stringify(r).includes('mongodb')], ['uncertain', 'quarantine-unavailable', false]);
  const t = await setup({ persistenceWrap: p => ({ lookup: p.lookup, persistAtomically: async () => { throw new Error('x'); } }),
    extra: { recovery: { inspect: async () => { throw new Error('down'); } } } });
  const u = await ingest(t.root);
  assert.deepEqual([u.reasonCode, u.quarantineStatus], ['persistence-uncertain', 'RETRYABLE']);
});

// ---------------------------------------------------------------- replay
async function retryableEntry() {
  let down = true;
  const s = await setup({ maxAttempts: 1, persistenceWrap: p => ({ lookup: p.lookup, async persistAtomically(i, o) { if (down) throw new Error('down'); return p.persistAtomically(i, o); }, replayFencing: 'atomic' }) });
  const doc = protectedDocument();
  const q = await s.root.ingest(doc, evidenceFor(doc), { field: 'temperature' });
  assert.equal(q.quarantineStatus, 'RETRYABLE');
  return { ...s, doc, q, fix: () => { down = false; } };
}

test('BE13-08 replay permitted: same identity, dependency fixed → accepted → RESOLVED with audit', async () => {
  const s = await retryableEntry(); s.fix();
  const r = await s.root.replay({ quarantineId: s.q.quarantineId, protectedDocument: s.doc, provenanceEvidence: evidenceFor(s.doc), field: 'temperature' });
  assert.deepEqual([r.status, r.outcome.status, r.quarantineStatus], ['replayed', 'accepted', 'RESOLVED']);
  const stored = await s.quarantine.get(s.q.quarantineId);
  assert.ok(stored.audit.some(a => a.action === 'transition' && a.outcome === 'replay-persisted')); // BE13-10B: settled by the fence, atomically with the write
  assert.deepEqual([s.persistence.claims.size, s.persistence.measurements.size], [1, 1]);
});

test('BE13-08 replay denied for BLOCKED; unblocking needs evidence and is impossible for security', async () => {
  const p = createProductionPlaceholders();
  const s = await setup({ extra: { hardware: p.hardware } });
  const doc = protectedDocument();
  const q = await s.root.ingest(doc, evidenceFor(doc), { field: 'temperature' });
  const r = await s.root.replay({ quarantineId: q.quarantineId, protectedDocument: doc, provenanceEvidence: evidenceFor(doc), field: 'temperature' });
  assert.deepEqual(r, { status: 'replay-rejected', reasonCode: 'replay-not-allowed' });
  assert.equal(await s.quarantine.transition({ quarantineId: q.quarantineId, from: 'BLOCKED', to: 'RETRYABLE', evidence: 'operator:fixed', outcome: 'unblocked' }), 'not-allowed');
  const clock = await setup({ extra: { policies: { ...s.deps.policies, clock: p.policies.clock } } });
  const cq = await clock.root.ingest(doc, evidenceFor(doc), { field: 'temperature' });
  assert.equal(await clock.quarantine.transition({ quarantineId: cq.quarantineId, from: 'BLOCKED', to: 'RETRYABLE', evidence: null, outcome: 'unblocked' }), 'not-allowed');
  assert.equal(await clock.quarantine.transition({ quarantineId: cq.quarantineId, from: 'BLOCKED', to: 'RETRYABLE', evidence: 'policy:clock-approved', outcome: 'unblocked' }), 'transitioned');
});

test('BE13-08 replay requires the exact identity and fingerprint; content changes are rejected and audited', async () => {
  const s = await retryableEntry(); s.fix();
  const other = protectedDocument({ eventId: 'synthetic-telemetry-999' });
  assert.equal((await s.root.replay({ quarantineId: s.q.quarantineId, protectedDocument: other, provenanceEvidence: evidenceFor(other), field: 'temperature' })).reasonCode, 'replay-identity-mismatch');
  assert.equal((await s.root.replay({ quarantineId: s.q.quarantineId, protectedDocument: s.doc, provenanceEvidence: evidenceFor(s.doc), field: 'soil_moisture' })).reasonCode, 'replay-identity-mismatch');
  const changed = protectedDocument({ payload: { temperature: 55, soil_moisture: null } });
  assert.equal((await s.root.replay({ quarantineId: s.q.quarantineId, protectedDocument: changed, provenanceEvidence: evidenceFor(changed), field: 'temperature' })).reasonCode, 'replay-fingerprint-mismatch');
  const audit = (await s.quarantine.get(s.q.quarantineId)).audit.filter(a => a.action === 'replay').map(a => a.outcome);
  assert.deepEqual(audit, ['replay-identity-mismatch', 'replay-identity-mismatch', 'replay-fingerprint-mismatch']);
  assert.equal(s.persistence.measurements.size, 0);
});

test('BE13-08 concurrent replays of the same entry → at most one measurement', async () => {
  const s = await retryableEntry(); s.fix();
  const replay = () => s.root.replay({ quarantineId: s.q.quarantineId, protectedDocument: s.doc, provenanceEvidence: evidenceFor(s.doc), field: 'temperature' });
  const results = await Promise.all([replay(), replay(), replay()]);
  assert.equal(s.persistence.measurements.size, 1);
  assert.ok(results.every(r => r.status === 'replay-rejected' || ['accepted', 'duplicate'].includes(r.outcome.status)));
  assert.equal((await s.quarantine.get(s.q.quarantineId)).status, 'RESOLVED');
});

// ---------------------------------------------------------------- readiness
test('BE13-08 readiness reports retry policy, scheduler, recovery and quarantine separately; placeholders BLOCKED', async () => {
  const s = await setup();
  const ready = describeIngestionRootReadiness(s.deps);
  assert.deepEqual([ready.overall, ready.productionReady, ready.dependencies.retryPolicy, ready.dependencies.retryScheduler, ready.dependencies.recovery, ready.dependencies.quarantine],
    ['READY_FOR_TEST', false, 'INJECTED_UNVERIFIED', 'INJECTED_UNVERIFIED', 'INJECTED_UNVERIFIED', 'INJECTED_UNVERIFIED']);
  const blocked = describeIngestionRootReadiness({ ...s.deps, retryPolicy: createBlockingRetryPolicy(), retryScheduler: createBlockingRetryScheduler() });
  assert.deepEqual([blocked.overall, blocked.dependencies.retryPolicy, blocked.dependencies.retryScheduler], ['BLOCKED', 'BLOCKED', 'BLOCKED']);
  for (const name of ['retryPolicy', 'retryScheduler', 'recovery', 'quarantine']) assert.throws(() => createResilientMeasurementIngestionRoot({ ...s.deps, [name]: undefined }), TypeError, name);
});

test('BE13-08 replication lag: a duplicate whose claim is not yet majority-committed is uncertainty, not corruption', async () => {
  let lagging = true;
  const s = await setup({ maxAttempts: 2 });
  await ingest(s.root); // persists (claim + measurement)
  const real = s.deps.recovery;
  const lagged = { inspect: async k => (lagging ? (lagging = false, { realm: k.realm, state: 'not-committed' }) : real.inspect(k)) };
  const root = createResilientMeasurementIngestionRoot({ ...s.deps, recovery: lagged });
  const r = await ingest(root);
  assert.deepEqual([r.status, r.attempts], ['duplicate', 2], 'retried once, then confirmed at majority');
  assert.equal(s.quarantine.rows.size, 0, 'never quarantined as orphan-claim');
});
