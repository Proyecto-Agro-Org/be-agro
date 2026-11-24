// BE13-07A — Adversarial audit of the composition root. Doubles are explicit
// and synthetic; some are deliberately malicious.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as placeholdersModule from '../dist/src/adapters/ingestion-production-placeholders.js';
import * as rootModule from '../dist/src/services/measurement-ingestion-root.js';
import { createPersistentMeasurementIngestionComposition } from '../dist/src/services/measurement-ingestion-composition.service.js';
import { protectedDocument, mapDocument, association, world, createInMemoryPersistence } from '../test-support/be13-composition.fixtures.js';

const { createMeasurementIngestionRoot, describeIngestionRootReadiness } = rootModule;
const { createProductionPlaceholders } = placeholdersModule;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ACK = { mode: 'current-state-only', limitation: 'DEVICE_STATUS_HISTORY_REQUIRED' };
const verifier = { verify: e => (e && e.syntheticTestOnly === true ? { sourceId: e.sourceId, operation: 'telemetry', eventId: e.eventId,
  device: { kind: 'mqtt-clientid', value: e.clientid } } : null) };
const evidenceFor = doc => ({ syntheticTestOnly: true, sourceId: doc.sourceId, eventId: doc.eventId, clientid: doc.clientid });
function deps(extra = {}, worldOverrides = {}) {
  const w = world(worldOverrides);
  return { w, deps: { realmAuthority: { authorizedRealm: () => 'test' }, provenanceVerifier: verifier, hardware: w.deps.hardware, temporal: w.deps.temporal,
    catalogue: w.deps.catalogue, policies: w.deps.policies, identityStore: w.deps.identityStore, persistence: createInMemoryPersistence(),
    be12: { temporal: { select: async e => ({ status: 'trusted', at: e.receivedAt, clock: 'received-at' }) }, catalogue: { accepts: async () => true } },
    deviceStatusHistory: ACK, ...extra } };
}
const ingest = (r, patch = {}, field = 'temperature') => { const doc = protectedDocument(patch); return r.ingest(doc, evidenceFor(doc), { field }); };
const walk = dir => readdirSync(dir).flatMap(name => { const p = join(dir, name); return statSync(p).isDirectory() ? walk(p) : [p]; });

test('V1 no production module imports test-support; placeholders export only blocking factories', () => {
  for (const file of walk(join(root, 'src')).filter(f => f.endsWith('.ts'))) {
    // Real imports only (static, dynamic, require); comments that mention the folder are fine.
    assert.equal(/(from\s*['"][^'"]*test-support|import\s*\(\s*['"`][^'"`]*test-support|require\s*\(\s*['"][^'"]*test-support)/.test(readFileSync(file, 'utf8')), false, file);
  }
  assert.deepEqual(Object.keys(placeholdersModule).sort(), ['createBlockingBe12Authorities', 'createBlockingProvenanceVerifier', 'createBlockingRetryPolicy',
    'createBlockingRetryScheduler', 'createBlockingSecurityPolicies', 'createDenyAllOperatorAuthorization', 'createProductionPlaceholders', 'createUnconfiguredAlerts', 'createUnconfiguredMetrics',
    'isBlockingPlaceholder']); // BE13-09: deny-all authorization + no-op observability; BE13-10A: conservative security policies (all registered as blocking)
  assert.deepEqual(Object.keys(rootModule).sort(), ['createMeasurementIngestionRoot', 'createResilientMeasurementIngestionRoot', 'describeIngestionRootReadiness']);
});

test('V2 no environment-variable permissive mode exists', async () => {
  for (const file of ['services/measurement-ingestion-root.ts', 'adapters/ingestion-production-placeholders.ts', 'iot/ingestion-root.contracts.ts']) {
    assert.equal(readFileSync(join(root, 'src', file), 'utf8').includes('process.env'), false, file);
  }
  const keys = ['AGRO_INGEST_PERMISSIVE', 'AGRO_DISABLE_GUARDS', 'NODE_ENV', 'AGRO_TRUST_ALL'];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  try {
    for (const k of keys) process.env[k] = k === 'NODE_ENV' ? 'development' : '1';
    const { deps: d } = deps(); const p = createProductionPlaceholders();
    const r = createMeasurementIngestionRoot({ ...d, ...p });
    assert.equal((await ingest(r)).status, 'quarantined');
    assert.equal(describeIngestionRootReadiness({ ...d, ...p }).overall, 'BLOCKED');
  } finally { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
});

test('V3 a fake "production" authority is reported as INJECTED_UNVERIFIED, never as approved; placeholder copies lose the BLOCKED label but still block', async () => {
  const { deps: d } = deps();
  const fake = { verify: async q => ({ realm: q.realm, status: 'verified', physicalDeviceId: q.physicalDeviceId, origin: 'simulated', method: 'production-attestation', attestationRevision: 1 }) };
  const report = describeIngestionRootReadiness({ ...d, hardware: fake });
  assert.equal(report.dependencies.hardware, 'INJECTED_UNVERIFIED');
  assert.equal(Object.values(report.dependencies).includes('READY'), false);
  const copy = { ...createProductionPlaceholders().hardware };
  assert.equal(describeIngestionRootReadiness({ ...d, hardware: copy }).dependencies.hardware, 'INJECTED_UNVERIFIED');
  assert.equal((await ingest(createMeasurementIngestionRoot({ ...d, hardware: copy }))).cause, 'unverified-hardware');
});

test('V4 bypassing the root is possible in-process (documented limitation), but lower layers stay fail-closed', async () => {
  const { w } = deps();
  const { idempotency: _i, ...rest } = w.deps;
  const direct = createPersistentMeasurementIngestionComposition({ ...rest, persistence: createInMemoryPersistence() });
  const doc = protectedDocument();
  assert.equal((await direct.ingest(doc, { field: 'temperature' })).reason, 'invalid-candidate', 'a raw document is not a candidate');
  assert.equal((await direct.ingest({ ...mapDocument(doc) }, { field: 'temperature' })).reason, 'invalid-candidate', 'a cloned candidate is rejected');
});

test('V5 provenance evidence for another document, missing evidence, or a candidate passed as document are rejected', async () => {
  const { deps: d } = deps(); const r = createMeasurementIngestionRoot(d);
  const doc = protectedDocument(), other = protectedDocument({ eventId: 'other-event' });
  assert.equal((await r.ingest(doc, evidenceFor(other), { field: 'temperature' })).cause, 'unverified-provenance');
  assert.equal((await r.ingest(doc, undefined, { field: 'temperature' })).cause, 'unverified-provenance');
  assert.equal((await r.ingest(doc, { ...evidenceFor(doc), syntheticTestOnly: 'yes' }, { field: 'temperature' })).cause, 'unverified-provenance');
  const candidate = mapDocument(doc);
  assert.equal((await r.ingest(candidate, evidenceFor(doc), { field: 'temperature' })).reason, 'mapper-rejected');
});

test('V6 spoofed realm: only the authority counts; a realm authority changing later is ignored', async () => {
  let realm = 'test';
  const { deps: d } = deps({ realmAuthority: { authorizedRealm: () => realm } });
  const r = createMeasurementIngestionRoot(d);
  realm = 'production';
  const out = await ingest(r, { payload: { temperature: 1, realm: 'production' } });
  assert.deepEqual([out.attribution.realm, r.realm], ['test', 'test']);
});

test('V7 cross-realm data leaking from the store is detected', async () => {
  const { deps: d, w } = deps();
  const leaky = { findDevicesByKey: async q => ({ realm: q.realm, rows: (await w.deps.identityStore.findDevicesByKey(q)).rows.map(x => ({ ...x, realm: 'production' })) }),
    findAssociationsAt: w.deps.identityStore.findAssociationsAt.bind(w.deps.identityStore) };
  const out = await ingest(createMeasurementIngestionRoot({ ...d, identityStore: leaky }));
  assert.deepEqual([out.reason, out.cause], ['trust-gate-rejected', 'realm-mismatch']);
});

test('V8 malformed or malicious policies cannot produce an accepted measurement', async () => {
  const { deps: d } = deps();
  const malformed = { ...d.policies, clock: { decide: async q => ({ realm: q.realm, status: 'approved', clock: 'whatever', policyRevision: 1 }) } };
  assert.equal((await ingest(createMeasurementIngestionRoot({ ...d, policies: malformed }))).cause, 'invalid-authority-response');
  const lying = { ...d.policies, persistenceTime: { decide: async q => ({ realm: q.realm, status: 'approved', persistedAt: q.receivedAt, policyRevision: 1 }) } };
  assert.equal((await ingest(createMeasurementIngestionRoot({ ...d, policies: lying }))).cause, 'contradictory-authority');
});

test('V9 TOCTOU: an accepted result is a snapshot; later changes are not reflected (documented)', async () => {
  const { deps: d, w } = deps(); const r = createMeasurementIngestionRoot(d);
  const accepted = await ingest(r);
  w.state.history = [association({ clientId: 'client-Z' })];
  assert.equal(accepted.attribution.clientId, 'client-A');
  assert.equal((await ingest(r)).status, 'duplicate', 'a retry after the change is still the same stored measurement');
});
