// BE13-09 — operations governance (offline). All authorities are explicit TEST_ONLY doubles.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createIngestionOperationsBootstrap, describeOperationsReadiness, describeIngestionOperationalState } from '../dist/src/services/ingestion-operations.service.js';
import { createDenyAllOperatorAuthorization, createUnconfiguredMetrics, createUnconfiguredAlerts, createProductionPlaceholders } from '../dist/src/adapters/ingestion-production-placeholders.js';
import { sanitizeMetricLabels } from '../dist/src/iot/ingestion-observability.js';
import { protectedDocument, world, createInMemoryPersistence, createTestOnlyRetryPolicy, createDeterministicScheduler, createInMemoryRecovery,
  createInMemoryQuarantine, createInMemoryAudit, createSyntheticOperatorAuthority, createRecordingMetrics, createRecordingAlerts, createSyntheticLeaseGovernance } from '../test-support/be13-composition.fixtures.js';

const ACK = { mode: 'current-state-only', limitation: 'DEVICE_STATUS_HISTORY_REQUIRED' };
const verifier = { verify: e => (e && e.syntheticTestOnly === true ? { sourceId: e.sourceId, operation: 'telemetry', eventId: e.eventId, device: { kind: 'mqtt-clientid', value: e.clientid } } : null) };
const evidenceFor = doc => ({ syntheticTestOnly: true, sourceId: doc.sourceId, eventId: doc.eventId, clientid: doc.clientid });
const ALL = ['QUARANTINE_VIEW', 'QUARANTINE_REPLAY', 'QUARANTINE_UNBLOCK', 'QUARANTINE_BLOCK', 'QUARANTINE_RESOLVE', 'QUARANTINE_DISCARD', 'AUDIT_VIEW', 'OPERATIONS_VIEW'];
const operators = {
  'tok-admin': { operatorId: 'op-admin', realms: ['test'], capabilities: ALL, authenticationReference: 'synthetic:admin' },
  'tok-viewer': { operatorId: 'op-viewer', realms: ['test'], capabilities: ['QUARANTINE_VIEW', 'OPERATIONS_VIEW'], authenticationReference: 'synthetic:viewer' },
  'tok-preview': { operatorId: 'op-preview', realms: ['preview'], capabilities: ALL, authenticationReference: 'synthetic:preview' },
  'tok-replayer': { operatorId: 'op-replayer', realms: ['test'], capabilities: ['QUARANTINE_REPLAY'], authenticationReference: 'synthetic:replayer' },
};
const admin = { token: 'tok-admin' }, viewer = { token: 'tok-viewer' }, previewOp = { token: 'tok-preview' };

async function setup({ extra = {}, down = false, maxAttempts = 1 } = {}) {
  const w = world();
  const persistence = createInMemoryPersistence(w.calls);
  let failing = down;
  const flaky = { lookup: k => persistence.lookup(k), persistAtomically: async (i, o) => { if (failing) throw new Error('down'); return persistence.persistAtomically(i, o); }, replayFencing: 'atomic' };
  const quarantine = await createInMemoryQuarantine(), audit = createInMemoryAudit(), metrics = createRecordingMetrics(), alerts = createRecordingAlerts();
  const lease = createSyntheticLeaseGovernance();
  const deps = { realmAuthority: { authorizedRealm: () => 'test' }, provenanceVerifier: verifier, hardware: w.deps.hardware, temporal: w.deps.temporal, catalogue: w.deps.catalogue,
    policies: w.deps.policies, identityStore: w.deps.identityStore, persistence: flaky,
    be12: { temporal: { select: async e => ({ status: 'trusted', at: e.receivedAt, clock: 'received-at' }) }, catalogue: { accepts: async () => true } },
    deviceStatusHistory: ACK, retryPolicy: createTestOnlyRetryPolicy(maxAttempts), retryScheduler: createDeterministicScheduler(), recovery: createInMemoryRecovery(persistence),
    quarantine, authorization: createSyntheticOperatorAuthority(operators), audit, metrics, alerts, retention: { mode: 'retain-indefinitely' },
    timeAuthority: lease.timeAuthority, leasePolicy: lease.leasePolicy, ...extra };
  return { w, persistence, quarantine, audit, metrics, alerts, deps, lease, boot: createIngestionOperationsBootstrap(deps), fix: () => { failing = false; }, breakIt: () => { failing = true; } };
}
async function retryableEntry(opts = {}) {
  const s = await setup({ down: true, ...opts });
  const doc = protectedDocument();
  const q = await s.boot.ingest(doc, evidenceFor(doc), { field: 'temperature' });
  assert.equal(q.quarantineStatus, 'RETRYABLE');
  const rec = await s.quarantine.get(q.quarantineId);
  return { ...s, doc, q, version: rec.version };
}
const replayInput = (s, version = s.version) => ({ quarantineId: s.q.quarantineId, expectedVersion: version, protectedDocument: s.doc, provenanceEvidence: evidenceFor(s.doc), field: 'temperature' });
const ev = (evidenceType, reference = 'TICKET-1') => ({ evidenceType, reference });

test('O-default: the deny-all placeholder denies every operation and the denial is audited', async () => {
  const s = await retryableEntry({ extra: { authorization: createDenyAllOperatorAuthorization() } });
  assert.deepEqual(await s.boot.operations.replay(admin, replayInput(s)), { status: 'denied', reason: 'unauthenticated' });
  assert.deepEqual((await s.boot.operations.discard(admin, { quarantineId: s.q.quarantineId, expectedVersion: s.version, evidence: ev('operator-decision') })).reason, 'unauthenticated');
  assert.ok(s.audit.entries.some(e => e.action === 'authorization-denied'));
  assert.ok(s.metrics.events.some(e => e.name === 'authorization_denied_total'));
});

test('O-capabilities: each operation needs its own capability; credential-carried roles/capabilities are ignored', async () => {
  const s = await retryableEntry();
  assert.equal((await s.boot.operations.replay(viewer, replayInput(s))).reason, 'forbidden');
  assert.equal((await s.boot.operations.replay({ token: 'tok-viewer', capabilities: ALL, roles: ['admin'] }, replayInput(s))).reason, 'forbidden');
  assert.equal((await s.boot.operations.discard({ token: 'tok-replayer' }, { quarantineId: s.q.quarantineId, expectedVersion: s.version, evidence: ev('operator-decision') })).reason, 'forbidden');
  assert.equal((await s.boot.operations.view(viewer, s.q.quarantineId)).status, 'done');
});

test('O03 realm scope: an operator of another realm is denied even knowing the quarantineId', async () => {
  const s = await retryableEntry();
  assert.equal((await s.boot.operations.replay(previewOp, replayInput(s))).reason, 'realm-out-of-scope');
  assert.equal((await s.boot.operations.view(previewOp, s.q.quarantineId)).reason, 'realm-out-of-scope');
});

test('O-authority: allow without capability, malformed decisions, throws and slow authorities fail closed', async () => {
  for (const authorization of [
    { authorize: async () => ({ decision: 'allow', principal: { ...operators['tok-viewer'] } }) },
    { authorize: async () => ({ decision: 'allow', principal: { ...operators['tok-admin'], realms: ['preview'] } }) },
    { authorize: async () => ({ decision: 'allow' }) },
    { authorize: async () => ({ decision: 'ALLOW', principal: operators['tok-admin'] }) },
    { authorize: async () => { throw new Error('idp down'); } },
    { authorize: async () => ({ decision: 'allow', principal: { ...operators['tok-admin'], extra: 'x' } }) },
  ]) {
    const s = await retryableEntry({ extra: { authorization } });
    const r = await s.boot.operations.replay(admin, replayInput(s));
    assert.equal(r.status, 'denied'); assert.ok(['forbidden', 'realm-out-of-scope'].includes(r.reason));
  }
});

test('O02/O04 authorized replay: lease → pipeline → RESOLVED; audit in strict sequence order', async () => {
  const s = await retryableEntry(); s.fix();
  const r = await s.boot.operations.replay(admin, replayInput(s));
  assert.deepEqual([r.status, r.quarantineStatus, r.replay.outcome.status, r.auditComplete], ['done', 'RESOLVED', 'accepted', true]);
  const trail = await s.audit.listForQuarantine(s.q.quarantineId, 50);
  // BE13-10B adds 'lease-acquired' (owner = the authorized principal) between the request and the start.
  assert.deepEqual(trail.map(a => a.action), ['quarantine-created', 'replay-requested', 'lease-acquired', 'replay-started', 'replay-result']);
  assert.deepEqual(trail.map(a => a.sequence), [1, 2, 3, 4, 5]);
  assert.deepEqual(trail.filter(a => a.actorId === 'op-admin').length, 4);
  assert.ok(trail.every(a => !JSON.stringify(a).includes('temperature')), 'no payload in audit');
});

test('O05/O09 replay of BLOCKED, DISCARDED or with a stale version is denied and audited', async () => {
  const s = await retryableEntry();
  assert.equal((await s.boot.operations.replay(admin, replayInput(s, s.version + 5))).reason, 'stale-version');
  await s.boot.operations.discard(admin, { quarantineId: s.q.quarantineId, expectedVersion: s.version, evidence: ev('operator-decision') });
  const after = await s.quarantine.get(s.q.quarantineId);
  assert.equal(after.status, 'DISCARDED');
  assert.equal((await s.boot.operations.replay(admin, replayInput(s, after.version))).reason, 'transition-not-allowed');
  assert.ok(s.audit.entries.filter(e => e.action === 'replay-denied').length >= 2);
  const blocked = await setup({ extra: { hardware: createProductionPlaceholders().hardware } });
  const doc = protectedDocument(); const q = await blocked.boot.ingest(doc, evidenceFor(doc), { field: 'temperature' });
  const v = (await blocked.quarantine.get(q.quarantineId)).version;
  assert.equal((await blocked.boot.operations.replay(admin, { quarantineId: q.quarantineId, expectedVersion: v, protectedDocument: doc, provenanceEvidence: evidenceFor(doc), field: 'temperature' })).reason, 'transition-not-allowed');
});

test('O06/O07 resolve: authorized + data-verified evidence + recovery proves the measurement; otherwise denied', async () => {
  const s = await retryableEntry(); s.fix();
  // Persist the measurement through ordinary ingestion (dedupe makes it the same key), then resolve the RETRYABLE entry.
  await s.boot.ingest(s.doc, evidenceFor(s.doc), { field: 'temperature' });
  const v = (await s.quarantine.get(s.q.quarantineId)).version;
  assert.equal((await s.boot.operations.resolve(viewer, { quarantineId: s.q.quarantineId, expectedVersion: v, evidence: ev('data-verified') })).reason, 'forbidden');
  assert.equal((await s.boot.operations.resolve(admin, { quarantineId: s.q.quarantineId, expectedVersion: v, evidence: ev('operator-decision') })).reason, 'evidence-type-not-accepted');
  const r = await s.boot.operations.resolve(admin, { quarantineId: s.q.quarantineId, expectedVersion: v, evidence: ev('data-verified') });
  assert.deepEqual([r.status, r.quarantineStatus], ['done', 'RESOLVED']);
  assert.ok(s.audit.entries.some(e => e.action === 'resolved' && e.evidence?.verification === 'DECLARED_UNVERIFIED'));
  const t = await retryableEntry();
  assert.equal((await t.boot.operations.resolve(admin, { quarantineId: t.q.quarantineId, expectedVersion: t.version, evidence: ev('data-verified') })).reason, 'resolve-not-verified');
  assert.equal((await t.quarantine.get(t.q.quarantineId)).status, 'RETRYABLE');
});

test('O08 discard is terminal; unblock rules depend on the class and evidence type', async () => {
  const s = await retryableEntry();
  const d = await s.boot.operations.discard(admin, { quarantineId: s.q.quarantineId, expectedVersion: s.version, evidence: ev('operator-decision') });
  assert.equal(d.quarantineStatus, 'DISCARDED');
  assert.equal((await s.boot.operations.unblock(admin, { quarantineId: s.q.quarantineId, expectedVersion: d.version, evidence: ev('dependency-restored') })).reason, 'transition-not-allowed');
  const p = createProductionPlaceholders();
  const pol = await setup({ extra: { policies: { ...world().deps.policies, clock: p.policies.clock } } });
  const doc = protectedDocument(); const q = await pol.boot.ingest(doc, evidenceFor(doc), { field: 'temperature' });
  const v = (await pol.quarantine.get(q.quarantineId)).version;
  assert.equal((await pol.boot.operations.unblock(admin, { quarantineId: q.quarantineId, expectedVersion: v, evidence: ev('dependency-restored') })).reason, 'evidence-type-not-accepted');
  assert.equal((await pol.boot.operations.unblock(admin, { quarantineId: q.quarantineId, expectedVersion: v, evidence: { evidenceType: 'policy-approval', reference: 'x y z' } })).reason, 'evidence-required');
  const u = await pol.boot.operations.unblock(admin, { quarantineId: q.quarantineId, expectedVersion: v, evidence: ev('policy-approval', 'ADR-CLOCK-PENDING') });
  assert.deepEqual([u.status, u.quarantineStatus], ['done', 'RETRYABLE']);
  const sec = await setup({ extra: { hardware: p.hardware } });
  const sq = await sec.boot.ingest(doc, evidenceFor(doc), { field: 'temperature' });
  const sv = (await sec.quarantine.get(sq.quarantineId)).version;
  assert.equal((await sec.boot.operations.unblock(admin, { quarantineId: sq.quarantineId, expectedVersion: sv, evidence: ev('authority-restored') })).reason, 'transition-not-allowed', 'security never retryable');
});

test('O10 stale version on transitions (optimistic CAS)', async () => {
  const s = await retryableEntry();
  assert.equal((await s.boot.operations.block(admin, { quarantineId: s.q.quarantineId, expectedVersion: s.version - 0 + 1, evidence: ev('operator-decision') })).reason, 'stale-version');
  assert.equal((await s.boot.operations.block(admin, { quarantineId: s.q.quarantineId, expectedVersion: s.version, evidence: ev('operator-decision') })).status, 'done');
  assert.equal((await s.boot.operations.discard(admin, { quarantineId: s.q.quarantineId, expectedVersion: s.version, evidence: ev('operator-decision') })).reason, 'stale-version');
});

test('O11/O12/O13 concurrency: replay×replay, resolve×resolve and replay×discard never produce impossible states', async () => {
  const a = await retryableEntry(); a.fix();
  const [r1, r2] = await Promise.all([a.boot.operations.replay(admin, replayInput(a)), a.boot.operations.replay(admin, replayInput(a))]);
  assert.deepEqual([r1.status, r2.status].sort(), ['denied', 'done']);
  assert.equal(a.persistence.measurements.size, 1);
  const b = await retryableEntry(); b.fix();
  await b.boot.ingest(b.doc, evidenceFor(b.doc), { field: 'temperature' });
  const v = (await b.quarantine.get(b.q.quarantineId)).version;
  const rs = await Promise.all([1, 2].map(() => b.boot.operations.resolve(admin, { quarantineId: b.q.quarantineId, expectedVersion: v, evidence: ev('data-verified') })));
  assert.deepEqual(rs.map(r => r.status).sort(), ['denied', 'done']);
  const c = await retryableEntry(); c.fix();
  const [rep, dis] = await Promise.all([c.boot.operations.replay(admin, replayInput(c)),
    c.boot.operations.discard(admin, { quarantineId: c.q.quarantineId, expectedVersion: c.version, evidence: ev('operator-decision') })]);
  const final = (await c.quarantine.get(c.q.quarantineId)).status;
  assert.ok(!(final === 'DISCARDED' && c.persistence.measurements.size > 0), 'never a measurement for a discarded entry');
  assert.equal([rep.status, dis.status].filter(x => x === 'done').length, 1);
});

test('O18 audit failure blocks administrative actions (fail-closed) without changing state', async () => {
  const s = await retryableEntry(); s.fix(); s.audit.setFailing(true);
  assert.equal((await s.boot.operations.replay(admin, replayInput(s))).reason, 'audit-unavailable');
  assert.equal((await s.boot.operations.discard(admin, { quarantineId: s.q.quarantineId, expectedVersion: s.version, evidence: ev('operator-decision') })).reason, 'audit-unavailable');
  assert.equal((await s.quarantine.get(s.q.quarantineId)).status, 'RETRYABLE');
  assert.equal(s.persistence.measurements.size, 0);
});

test('Lease release (BE13-10B): only the OWNER releases its active lease; REPLAYING cannot be entered by a generic transition', async () => {
  const s = await retryableEntry();
  // The generic transition can no longer create an ownerless REPLAYING entry.
  assert.equal(await s.quarantine.transition({ quarantineId: s.q.quarantineId, from: 'RETRYABLE', to: 'REPLAYING', expectedVersion: s.version, evidence: 'crash', outcome: 'x' }), 'not-allowed');
  // A replay of op-admin that "crashed" while holding the lease (taken through the lease CAS, as the service does).
  const acquired = await s.quarantine.acquireLease({ quarantineId: s.q.quarantineId, expectedVersion: s.version, ownerId: 'op-admin', acquiredAt: s.lease.clock.at });
  assert.equal(acquired.result, 'acquired');
  const v = (await s.quarantine.get(s.q.quarantineId)).version;
  const input = { quarantineId: s.q.quarantineId, expectedVersion: v, evidence: ev('operator-decision') };
  assert.equal((await s.boot.operations.discard(admin, input)).reason, 'transition-not-allowed');
  assert.equal((await s.boot.operations.releaseLease(viewer, input)).reason, 'forbidden');
  assert.equal((await s.boot.operations.releaseLease({ token: 'tok-replayer' }, input)).reason, 'lease-owned-by-another-operator');
  assert.equal((await s.boot.operations.releaseLease(admin, input)).quarantineStatus, 'RETRYABLE');
  assert.equal((await s.quarantine.get(s.q.quarantineId)).lease, null);
});

test('O19/O20 metrics are emitted with bounded labels; a failing metrics adapter never alters results', async () => {
  const s = await setup();
  const doc = protectedDocument();
  const r = await s.boot.ingest(doc, evidenceFor(doc), { field: 'temperature' });
  assert.equal(r.status, 'accepted');
  assert.ok(s.metrics.events.some(e => e.name === 'ingestion_accepted_total'));
  for (const e of s.metrics.events) for (const v of Object.values(e.labels)) assert.ok(!/synthetic|device|client|sensor|q_|test/.test(String(v)), JSON.stringify(e));
  const t = await setup({ extra: { metrics: { increment: () => { throw new Error('metrics down'); } }, alerts: { emit: () => new Promise(() => {}) } } });
  const r2 = await t.boot.ingest(doc, evidenceFor(doc), { field: 'temperature' });
  assert.equal(r2.status, 'accepted');
  assert.deepEqual(sanitizeMetricLabels({ reasonCode: 'synthetic-telemetry-001', stage: 'client-A', retryClass: 'x', outcome: 'q_abc', eventId: 'e', clientId: 'c' }),
    { stage: 'other', reasonCode: 'other', retryClass: 'other', outcome: 'other' });
});

test('O21 alert events are facts without identifiers', async () => {
  const s = await setup({ down: true, maxAttempts: 2 });
  const doc = protectedDocument(); await s.boot.ingest(doc, evidenceFor(doc), { field: 'temperature' });
  assert.ok(s.alerts.events.some(a => a.type === 'RETRY_EXHAUSTED' && a.severity === 'WARNING'));
  for (const a of s.alerts.events) assert.deepEqual(Object.keys(a).sort(), ['reasonCode', 'severity', 'type']);
});

test('O22 operational snapshot: counts only, OPERATIONS_VIEW required, productionReady false', async () => {
  const s = await retryableEntry();
  assert.equal((await s.boot.operationalState({ token: 'tok-replayer' })).status, 'denied');
  const r = await s.boot.operationalState(viewer);
  assert.equal(r.status, 'done');
  assert.deepEqual([r.state.totals.RETRYABLE, r.state.auditHealthy, r.state.quarantineStoreHealthy, r.state.productionReady], [1, true, true, false]);
  assert.equal(/q_|synthetic|eventId|telemetry-0/.test(JSON.stringify(r.state)), false);
  assert.equal(describeIngestionOperationalState({ realm: 'test', quarantine: [], auditHealthy: false, quarantineStoreHealthy: true }).totals.OPEN, 0);
});

test('Readiness: TECHNICAL / OPERATIONS test readiness; PRODUCTION always false', async () => {
  const s = await setup();
  const ok = describeOperationsReadiness(s.deps);
  assert.deepEqual([ok.technicalTestReady, ok.operationsTestReady, ok.productionReady], [true, true, false]);
  const placeholders = describeOperationsReadiness({ ...s.deps, authorization: createDenyAllOperatorAuthorization(), metrics: createUnconfiguredMetrics(), alerts: createUnconfiguredAlerts() });
  assert.deepEqual([placeholders.technicalTestReady, placeholders.operationsTestReady, placeholders.dependencies.authorization, placeholders.dependencies.metrics], [true, false, 'BLOCKED', 'BLOCKED']);
  assert.equal(describeOperationsReadiness({ ...s.deps, retention: { mode: 'pending-decision' } }).dependencies.retention, 'BLOCKED');
  assert.equal(describeOperationsReadiness(null).productionReady, false);
  for (const name of ['authorization', 'audit', 'metrics', 'alerts', 'retention']) assert.throws(() => createIngestionOperationsBootstrap({ ...s.deps, [name]: undefined }), TypeError, name);
});
