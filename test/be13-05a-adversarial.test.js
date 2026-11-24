// BE13-05A — Adversarial audit of the ingestion composition.
// All dependencies are EXPLICIT SYNTHETIC DOUBLES, including deliberately malicious ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as compositionModule from '../dist/src/services/measurement-ingestion-composition.service.js';
import { technicalInputFingerprint } from '../dist/src/iot/ingestion-event-fingerprint.js';
import { REALM, RECEIVED, SENT, candidate, association, device, world, deepFrozen, objectsOf } from '../test-support/be13-composition.fixtures.js';

const { createMeasurementIngestionComposition } = compositionModule;
const ingest = (w, c = candidate(), field = 'temperature', extra) => w.compose(extra).ingest(c, { field });

test('BE13-05A V1 fabricated, cloned, spread, Proxy or prototype candidates never enter the pipeline', async () => {
  const w = world(), c = candidate();
  for (const fake of [structuredClone(c), { ...c }, Object.freeze({ ...c }), new Proxy(c, {}), Object.create(c), JSON.parse(JSON.stringify(c))]) {
    assert.equal((await ingest(w, fake)).reason, 'invalid-candidate');
  }
  assert.equal(w.calls.length, 0);
});

test('BE13-05A V2 the composition accepts only candidates: a ready or trusted event cannot be injected', async () => {
  const w = world(), accepted = await ingest(w);
  for (const injected of [accepted, accepted.event, { status: 'ready-for-attribution' }, { status: 'trusted-event', event: accepted.event }]) {
    assert.equal((await ingest(world(), injected)).reason, 'invalid-candidate');
  }
  assert.deepEqual(Object.keys(compositionModule), ['createMeasurementIngestionComposition']);
});

test('BE13-05A V3 every dependency is mandatory; no permissive defaults; realm only from context', () => {
  const { deps } = world();
  for (const name of ['realmContext', 'identityStore', 'temporal', 'hardware', 'catalogue', 'policies', 'idempotency', 'be12']) {
    assert.throws(() => createMeasurementIngestionComposition({ ...deps, [name]: undefined }), TypeError, name);
  }
  for (const name of ['clock', 'declaredAt', 'missingReason', 'persistenceTime']) {
    assert.throws(() => createMeasurementIngestionComposition({ ...deps, policies: { ...deps.policies, [name]: undefined } }), TypeError, name);
  }
  assert.throws(() => createMeasurementIngestionComposition({ ...deps, realmContext: { realm: REALM, extra: 1 } }), TypeError);
  assert.throws(() => createMeasurementIngestionComposition({ ...deps, authorityTimeoutMs: 0 }), TypeError);
});

test('BE13-05A V4 a payload-declared realm, tenant or clientId is ignored', async () => {
  const c = candidate({ payload: { temperature: 2, realm: 'production', tenant: 'evil', clientId: 'synthetic-device-001', fieldId: 'f-evil' } });
  const w = world(), r = await ingest(w, c);
  assert.deepEqual([r.attribution.realm, r.attribution.clientId, r.attribution.fieldId, r.idempotency.key.realm], [REALM, 'client-A', 'field-A', REALM]);
  for (const [, q] of w.calls) if (q && typeof q === 'object') assert.equal(Object.hasOwn(q, 'clientId'), false);
});

test('BE13-05A V5 idempotency bypass: concurrent identical events yield exactly one accepted', async () => {
  const w = world(), composition = w.compose();
  const results = await Promise.all([1, 2, 3, 4].map(() => composition.ingest(candidate(), { field: 'temperature' })));
  assert.deepEqual(results.map(r => r.status).sort(), ['accepted', 'duplicate', 'duplicate', 'duplicate']);
});

test('BE13-05A V6 eventId collision with different content conflicts; a lying idempotency port is contained', async () => {
  const w = world(); await ingest(w);
  assert.equal((await ingest(w, candidate({ payload: { temperature: 0, soil_moisture: 5 } }))).reason, 'idempotency-conflict');
  assert.equal((await ingest(w, candidate({ sentAt: SENT + 1 }))).reason, 'idempotency-conflict');
  const lying = world();
  const r = await ingest(lying, candidate(), 'temperature', { idempotency: { lookup: async k => ({ realm: k.realm, status: 'present', fingerprint: 'nope' }), claim: async () => ({}) } });
  assert.equal(r.reason, 'idempotency-unavailable', 'malformed fingerprint is not treated as a conflict or duplicate');
  const claimLies = world();
  const r2 = await ingest(claimLies, candidate(), 'temperature', { idempotency: { lookup: async k => ({ realm: k.realm, status: 'absent' }),
    claim: async k => ({ realm: k.realm, status: 'claimed', extra: true }) } });
  assert.equal(r2.reason, 'idempotency-unavailable');
});

test('BE13-05A V7 the technical fingerprint ignores delivery metadata but covers declared content', () => {
  const base = technicalInputFingerprint(REALM, candidate(), 'temperature');
  assert.equal(technicalInputFingerprint(REALM, candidate({}, { receivedAt: RECEIVED + 9_999, persistedAt: null }), 'temperature'), base);
  assert.equal(technicalInputFingerprint(REALM, candidate({ mqtt: { topic: 'synthetic/agro/other/telemetry', messageType: 'telemetry', dataOrigin: 'simulated' } }), 'temperature'), base);
  for (const variant of [technicalInputFingerprint('preview', candidate(), 'temperature'), technicalInputFingerprint(REALM, candidate(), 'soil_moisture'),
    technicalInputFingerprint(REALM, candidate({ eventId: 'other-event' }), 'temperature'), technicalInputFingerprint(REALM, candidate({ deviceTimestamp: 1 }), 'temperature'),
    technicalInputFingerprint(REALM, candidate({ payload: { soil_moisture: null, temperature: 0 } }), 'temperature')]) {
    if (variant === technicalInputFingerprint(REALM, candidate({ payload: { soil_moisture: null, temperature: 0 } }), 'temperature')) assert.equal(variant, base, 'key order is canonical');
    else assert.notEqual(variant, base);
  }
});

test('BE13-05A V8 malicious BE-12: same attribution but a different event, clock or instant is drift', async () => {
  const cases = [
    [e => ({ ...e, value: 1 }), 'event'],
    [e => ({ ...e, magnitude: 'other' }), 'event'],
  ];
  for (const [alter, cause] of cases) {
    const w = world();
    const be12 = { resolve: async e => { const v = await w.deps.be12.resolve(e); return { ...v, event: alter(v.event) }; } };
    assert.deepEqual([(await ingest(w, candidate(), 'temperature', { be12 })).cause], [cause]);
  }
  const clock = world(); clock.state.be12Temporal = e => ({ status: 'trusted', at: e.declaredAt, clock: 'declared-at-approved' });
  assert.deepEqual([(await ingest(clock)).reason, (await ingest(clock)).cause], ['attribution-drift', 'attributedAt']);
  const rev = world();
  const be12 = { resolve: async e => ({ ...(await rev.deps.be12.resolve(e)), associationRevision: 99 }) };
  assert.equal((await ingest(rev, candidate(), 'temperature', { be12 })).cause, 'associationRevision');
});

test('BE13-05A V9 BE-12 rejections and thrown conflicts are classified without diagnostics', async () => {
  const w = world(); w.state.be12Catalogue = false;
  assert.deepEqual([(await ingest(w)).reason, (await ingest(w)).cause], ['be12-rejected', 'invalid-catalogue']);
  const conflict = world();
  const r = await ingest(conflict, candidate(), 'temperature', { be12: { resolve: async () => { throw Object.assign(new Error('secret'), { code: 'CONFLICT' }); } } });
  assert.deepEqual([r.reason, r.cause], ['attribution-drift', 'be12-conflict']);
  const hostile = await ingest(world(), candidate(), 'temperature', { be12: { resolve: async () => { throw { get code() { throw new Error('x'); } }; } } });
  assert.equal(hostile.reason, 'dependency-error');
  const odd = await ingest(world(), candidate(), 'temperature', { be12: { resolve: async () => ({ status: 'quarantined', reason: '<script>' }) } });
  assert.deepEqual([odd.reason, odd.cause], ['be12-rejected', null]);
  const slow = await ingest(world(), candidate(), 'temperature', { authorityTimeoutMs: 20, be12: { resolve: () => new Promise(() => {}) } });
  assert.equal(slow.reason, 'dependency-error');
});

test('BE13-05A V10 malicious policy cannot make a contradictory event acceptable', async () => {
  const w = world(); w.state.policies.persistenceTime = () => ({ status: 'approved', persistedAt: RECEIVED, policyRevision: 1 });
  assert.deepEqual([(await ingest(w)).reason, (await ingest(w)).cause], ['builder-rejected', 'contradictory-authority']);
});

test('BE13-05A V11 drift after revalidation: changes before BE-12 are caught, changes after acceptance are not (TOCTOU)', async () => {
  const before = world();
  const r = await ingest(before, candidate(), 'temperature', { be12: { resolve: async e => { before.state.devices = [device({ lifecycle: 'inactive' })]; return before.deps.be12.resolve(e); } } });
  assert.deepEqual([r.reason, r.cause], ['be12-rejected', 'inactive-device']);
  const after = world(), accepted = await ingest(after);
  after.state.history = [association({ clientId: 'client-Z' })];
  assert.equal(accepted.attribution.clientId, 'client-A', 'an accepted result is a snapshot; later changes are not reflected');
});

test('BE13-05A V12 cross-client and cross-realm resolution attempts', async () => {
  const crossRealm = world({ devices: [device({ realm: 'preview' })] });
  assert.equal((await ingest(crossRealm)).cause, 'unresolved-device');
  const leak = world();
  const store = { findDevicesByKey: leak.deps.identityStore.findDevicesByKey.bind(leak.deps.identityStore),
    findAssociationsAt: async q => ({ realm: q.realm, complete: true, rows: [association({ realm: 'production' })] }) };
  assert.equal((await ingest(leak, candidate(), 'temperature', { identityStore: store })).cause, 'realm-mismatch');
  const twoClients = world({ history: [association(), association({ id: 'assoc-B', clientId: 'client-B' })] });
  assert.equal((await ingest(twoClients)).cause, 'overlapping-association', 'never pick one of two owners');
});

test('BE13-05A V13 duplicate and quarantine results are frozen and share nothing with dependency calls', async () => {
  const w = world(); await ingest(w);
  const duplicate = await ingest(w);
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(deepFrozen(duplicate), true);
  const theirs = new Set(w.calls.flatMap(([, q]) => [...objectsOf(q)]));
  for (const object of objectsOf(duplicate)) assert.equal(theirs.has(object), false, 'duplicate result must not alias an object handed to the idempotency port');
  const q = await ingest(world({ devices: [] }));
  assert.equal(deepFrozen(q), true);
  assert.deepEqual(Object.keys(q).sort(), ['cause', 'eventId', 'reason', 'status']);
});
