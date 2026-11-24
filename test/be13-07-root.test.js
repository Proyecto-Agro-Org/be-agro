// BE13-07 — Composition root tests (R01–R20 + readiness). Positive paths use
// EXPLICIT SYNTHETIC DOUBLES from test-support/; production placeholders block.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMeasurementIngestionRoot, describeIngestionRootReadiness } from '../dist/src/services/measurement-ingestion-root.js';
import { createProductionPlaceholders, isBlockingPlaceholder } from '../dist/src/adapters/ingestion-production-placeholders.js';
import { protectedDocument, device, association, world, createInMemoryPersistence, deepFrozen, createTestOnlyRetryPolicy, createDeterministicScheduler,
  createInMemoryRecovery, createInMemoryQuarantine } from '../test-support/be13-composition.fixtures.js';

const ACK = Object.freeze({ mode: 'current-state-only', limitation: 'DEVICE_STATUS_HISTORY_REQUIRED' });
// Synthetic provenance verifier: the evidence object itself carries the descriptor (test only).
const syntheticVerifier = { verify: e => (e && e.syntheticTestOnly === true ? { sourceId: e.sourceId, operation: 'telemetry', eventId: e.eventId,
  device: { kind: 'mqtt-clientid', value: e.clientid } } : null) };
const evidenceFor = doc => ({ syntheticTestOnly: true, sourceId: doc.sourceId, eventId: doc.eventId, clientid: doc.clientid });

function syntheticRoot(overrides = {}, worldOverrides = {}) {
  const w = world(worldOverrides);
  const persistence = createInMemoryPersistence(w.calls);
  let realmCalls = 0;
  const deps = {
    realmAuthority: { authorizedRealm: () => { realmCalls += 1; return 'test'; } },
    provenanceVerifier: syntheticVerifier,
    hardware: w.deps.hardware, temporal: w.deps.temporal, catalogue: w.deps.catalogue, policies: w.deps.policies,
    identityStore: w.deps.identityStore, persistence,
    be12: { temporal: { select: async e => (w.state.be12Temporal ? w.state.be12Temporal(e) : { status: 'trusted', at: e.receivedAt, clock: 'received-at' }) },
      catalogue: { accepts: async () => true } },
    deviceStatusHistory: ACK,
    ...overrides,
  };
  return { w, deps, persistence, realmCalls: () => realmCalls, root: () => createMeasurementIngestionRoot(deps) };
}
const ingestDoc = async (root, patch = {}, field = 'temperature', options) => {
  const doc = protectedDocument(patch, options);
  return root.ingest(doc, evidenceFor(doc), { field });
};

test('R01 every dependency and the device-history acknowledgement are mandatory', () => {
  const { deps } = syntheticRoot();
  for (const name of ['realmAuthority', 'provenanceVerifier', 'hardware', 'temporal', 'catalogue', 'policies', 'identityStore', 'persistence', 'be12', 'deviceStatusHistory']) {
    assert.throws(() => createMeasurementIngestionRoot({ ...deps, [name]: undefined }), TypeError, name);
  }
  for (const name of ['declaredAt', 'clock', 'missingReason', 'persistenceTime']) {
    assert.throws(() => createMeasurementIngestionRoot({ ...deps, policies: { ...deps.policies, [name]: undefined } }), TypeError, name);
  }
  for (const ack of [{ mode: 'historical' , limitation: 'DEVICE_STATUS_HISTORY_REQUIRED' }, { mode: 'current-state-only' }, { ...ACK, waived: true }, 'ack']) {
    assert.throws(() => createMeasurementIngestionRoot({ ...deps, deviceStatusHistory: ack }), TypeError);
  }
  assert.throws(() => createMeasurementIngestionRoot({ ...deps, persistence: { lookup: async () => ({}) } }), TypeError);
  assert.throws(() => createMeasurementIngestionRoot({ ...deps, be12: { temporal: deps.be12.temporal } }), TypeError);
});

const P = createProductionPlaceholders;
const blockedCase = async (name, overrides, field = 'temperature') => {
  const { root } = syntheticRoot(overrides);
  return ingestDoc(root(), {}, field);
};

test('R02 placeholder provenance verifier blocks at the mapper', async () => {
  const r = await blockedCase('provenance', { provenanceVerifier: P().provenanceVerifier });
  assert.deepEqual(r, { status: 'quarantined', reason: 'mapper-rejected', cause: 'unverified-provenance', eventId: null });
});
test('R03 placeholder hardware authority blocks', async () => {
  const r = await blockedCase('hardware', { hardware: P().hardware });
  assert.deepEqual([r.reason, r.cause], ['trust-gate-rejected', 'unverified-hardware']);
});
test('R04 placeholder temporal authority blocks', async () => {
  const r = await blockedCase('temporal', { temporal: P().temporal });
  assert.deepEqual([r.reason, r.cause], ['trust-gate-rejected', 'untrusted-clock']);
});
test('R05 placeholder catalogues block (BE13 catalogue and BE-12 catalogue)', async () => {
  const r = await blockedCase('catalogue', { catalogue: P().catalogue });
  assert.deepEqual([r.reason, r.cause], ['trust-gate-rejected', 'unapproved-magnitude']);
  const { deps } = syntheticRoot();
  const r2 = await blockedCase('be12', { be12: { temporal: deps.be12.temporal, catalogue: P().be12.catalogue } });
  assert.deepEqual([r2.reason, r2.cause], ['be12-rejected', 'invalid-catalogue']);
});
test('R06 placeholder declaredAt policy blocks', async () => {
  const { deps } = syntheticRoot();
  const r = await blockedCase('declaredAt', { policies: { ...deps.policies, declaredAt: P().policies.declaredAt } });
  assert.deepEqual([r.reason, r.cause], ['builder-rejected', 'unapproved-declared-at']);
});
test('R07 placeholder clock policy blocks', async () => {
  const { deps } = syntheticRoot();
  const r = await blockedCase('clock', { policies: { ...deps.policies, clock: P().policies.clock } });
  assert.deepEqual([r.reason, r.cause], ['builder-rejected', 'unresolved-clock']);
});
test('R08 placeholder missingReason policy blocks null values', async () => {
  const { deps } = syntheticRoot();
  const r = await blockedCase('missingReason', { policies: { ...deps.policies, missingReason: P().policies.missingReason } }, 'soil_moisture');
  assert.deepEqual([r.reason, r.cause], ['builder-rejected', 'missing-reason-required']);
});
test('R09 placeholder persistedAt policy blocks', async () => {
  const { deps } = syntheticRoot();
  const r = await blockedCase('persistenceTime', { policies: { ...deps.policies, persistenceTime: P().policies.persistenceTime } });
  assert.deepEqual([r.reason, r.cause], ['builder-rejected', 'unresolved-persisted-at']);
});

test('R10 the realm comes from the realm authority, read once at construction', async () => {
  const s = syntheticRoot(), root = s.root();
  assert.equal(root.realm, 'test');
  for (let i = 0; i < 3; i += 1) await ingestDoc(root, { eventId: `e-${i}` });
  assert.equal(s.realmCalls(), 1);
  const r = await ingestDoc(root, { eventId: 'e-final' });
  assert.equal(r.attribution.realm, 'test');
});

test('R11 a realm spoofed in payload, topic or sourceId-like fields is ignored', async () => {
  const { root } = syntheticRoot();
  const r = await ingestDoc(root(), { payload: { temperature: 3, realm: 'production', tenant: 'evil' },
    mqtt: { topic: 'production/realm/evil/telemetry', messageType: 'telemetry', dataOrigin: 'simulated' } });
  assert.deepEqual([r.status, r.attribution.realm, r.idempotency.key.realm], ['accepted', 'test', 'test']);
});

test('R12 cross-realm: another authorized realm never sees test rows; invalid or failing realm authority refuses construction', async () => {
  const { deps } = syntheticRoot();
  const preview = createMeasurementIngestionRoot({ ...deps, realmAuthority: { authorizedRealm: () => 'preview' } });
  const r = await ingestDoc(preview);
  assert.deepEqual([r.reason, r.cause], ['trust-gate-rejected', 'unresolved-device']);
  assert.throws(() => createMeasurementIngestionRoot({ ...deps, realmAuthority: { authorizedRealm: () => 'tenant-a' } }), TypeError);
  assert.throws(() => createMeasurementIngestionRoot({ ...deps, realmAuthority: { authorizedRealm: () => { throw new Error('x'); } } }), TypeError);
});

test('R13 full synthetic success through the root', async () => {
  const { root, persistence } = syntheticRoot();
  const r = await ingestDoc(root());
  assert.deepEqual([r.status, r.persisted, r.attribution.clientId], ['accepted', true, 'client-A']);
  assert.deepEqual([persistence.claims.size, persistence.measurements.size], [1, 1]);
  assert.equal(deepFrozen(r), true);
});

test('R14 exact retry → duplicate with the same measurement reference', async () => {
  const s = syntheticRoot(), root = s.root();
  const first = await ingestDoc(root);
  const retry = await ingestDoc(root, {}, 'temperature', { receivedAt: 1795115700000, persistedAt: 1795115700010 });
  assert.deepEqual([retry.status, retry.measurementId], ['duplicate', first.measurementId]);
});

test('R15 same key with different content → conflict', async () => {
  const s = syntheticRoot(), root = s.root();
  await ingestDoc(root);
  const r = await ingestDoc(root, { payload: { temperature: 99, soil_moisture: null } });
  assert.equal(r.reason, 'idempotency-conflict');
  assert.equal(s.persistence.measurements.size, 1);
});

test('R16 attribution drift between BE13-04 and BE-12 → quarantined, nothing persisted', async () => {
  const s = syntheticRoot();
  s.w.state.be12Temporal = e => { s.w.state.history = [association({ clientId: 'client-intruder' })]; return { status: 'trusted', at: e.receivedAt, clock: 'received-at' }; };
  const r = await ingestDoc(s.root());
  assert.deepEqual([r.reason, r.cause, s.persistence.measurements.size], ['attribution-drift', 'clientId', 0]);
});

test('R17 stale authority between gate and builder → builder-rejected', async () => {
  const s = syntheticRoot(); let n = 0;
  const hardware = { verify: async q => ({ realm: q.realm, status: 'verified', physicalDeviceId: q.physicalDeviceId, origin: 'simulated', method: 'm',
    attestationRevision: ++n > 2 ? 9 : 1 }) };
  const r = await ingestDoc(createMeasurementIngestionRoot({ ...s.deps, hardware }));
  assert.deepEqual([r.reason, r.cause], ['builder-rejected', 'stale-hardware']);
});

test('R18 device inactive today blocks (DEVICE_STATUS_HISTORY_REQUIRED, fail-closed)', async () => {
  const s = syntheticRoot({}, { devices: [device({ lifecycle: 'inactive' })] });
  const r = await ingestDoc(s.root());
  assert.deepEqual([r.reason, r.cause], ['trust-gate-rejected', 'inactive-device']);
});

test('R19 throwing dependencies fail closed without diagnostics', async () => {
  const s = syntheticRoot();
  const persistence = { lookup: async k => ({ realm: k.realm, status: 'absent' }), persistAtomically: async () => { throw new Error('mongodb://u:p@h'); } };
  const r = await ingestDoc(createMeasurementIngestionRoot({ ...s.deps, persistence }));
  assert.deepEqual([r.reason, JSON.stringify(r).includes('mongodb')], ['persistence-unavailable', false]);
  const r2 = await ingestDoc(createMeasurementIngestionRoot({ ...s.deps, provenanceVerifier: { verify: () => { throw new Error('secret'); } } }));
  assert.deepEqual([r2.reason, r2.cause], ['mapper-rejected', 'unverified-provenance']);
});

test('R20 malformed dependency responses fail closed', async () => {
  const s = syntheticRoot();
  const r = await ingestDoc(createMeasurementIngestionRoot({ ...s.deps, hardware: { verify: async () => ({ status: 'verified' }) } }));
  assert.deepEqual([r.reason, r.cause], ['trust-gate-rejected', 'invalid-authority-response']);
  const r2 = await ingestDoc(createMeasurementIngestionRoot({ ...s.deps, be12: { ...s.deps.be12, temporal: { select: async () => ({ status: 'maybe' }) } } }));
  assert.equal(r2.reason, 'dependency-error');
});

// ---------------------------------------------------------------- readiness / placeholders
test('Readiness: all production placeholders → BLOCKED per dependency; the default root processes nothing', async () => {
  const { deps } = syntheticRoot();
  const placeholders = P();
  const productionLike = { ...deps, ...placeholders };
  const report = describeIngestionRootReadiness(productionLike);
  assert.equal(report.overall, 'BLOCKED');
  for (const name of ['provenanceVerifier', 'hardware', 'temporal', 'catalogue', 'policies.declaredAt', 'policies.clock', 'policies.missingReason', 'policies.persistenceTime',
    'be12.temporal', 'be12.catalogue']) assert.equal(report.dependencies[name], 'BLOCKED', name);
  assert.equal(report.dependencies.identityStore, 'INJECTED_UNVERIFIED');
  assert.deepEqual(report.limitations, ['DEVICE_STATUS_HISTORY_REQUIRED']);
  const root = createMeasurementIngestionRoot(productionLike);
  for (const field of ['temperature', 'soil_moisture']) assert.equal((await ingestDoc(root, {}, field)).status, 'quarantined');
  for (const value of [placeholders.hardware, placeholders.policies.clock, placeholders.be12, placeholders.provenanceVerifier]) assert.equal(isBlockingPlaceholder(value), true);
});

test('Readiness: synthetic doubles → READY_FOR_TEST; missing → MISSING; contains no secrets', async () => {
  const { deps: base } = syntheticRoot();
  // BE13-08: the base pipeline alone is no longer READY_FOR_TEST — retry, recovery and quarantine are reported separately.
  const baseOnly = describeIngestionRootReadiness(base);
  assert.deepEqual([baseOnly.overall, baseOnly.dependencies.retryPolicy, baseOnly.dependencies.retryScheduler, baseOnly.dependencies.recovery,
    baseOnly.dependencies.quarantine], ['BLOCKED', 'MISSING', 'MISSING', 'MISSING', 'MISSING']);
  const deps = { ...base, retryPolicy: createTestOnlyRetryPolicy(), retryScheduler: createDeterministicScheduler(),
    recovery: createInMemoryRecovery(base.persistence), quarantine: await createInMemoryQuarantine() };
  assert.equal(describeIngestionRootReadiness(deps).overall, 'READY_FOR_TEST');
  for (const input of [deps, null, { ...deps, ...P() }]) assert.equal(describeIngestionRootReadiness(input).productionReady, false, 'READY_FOR_TEST is never production readiness');
  const missing = describeIngestionRootReadiness({ ...deps, persistence: undefined, deviceStatusHistory: undefined });
  assert.deepEqual([missing.overall, missing.dependencies.persistence, missing.dependencies.deviceStatusHistory], ['BLOCKED', 'MISSING', 'MISSING']);
  assert.deepEqual(describeIngestionRootReadiness(null).overall, 'BLOCKED');
  assert.equal(/mongodb|password|token|key=/i.test(JSON.stringify(describeIngestionRootReadiness(deps))), false);
});
