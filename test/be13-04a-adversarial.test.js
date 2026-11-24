// BE13-04A — Adversarial audit of the trusted event builder.
// All authorities/policies are EXPLICIT TEST DOUBLES (including deliberately lying ones).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIngestProvenanceAuthority } from '../dist/src/iot/ingest-provenance.authority.js';
import { createProtectedIngestMapper } from '../dist/src/iot/protected-ingest.mapper.js';
import * as gateModule from '../dist/src/services/attribution-trust-gate.service.js';
import { createTrustedEventBuilder } from '../dist/src/services/trusted-event-builder.service.js';

const { createAttributionTrustGate, isIssuedReadyFor } = gateModule;
const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'be13-01', 'fixtures');
const manifest = JSON.parse(readFileSync(join(fixtureRoot, 'manifest.json'), 'utf8'));
const fixture = id => JSON.parse(readFileSync(join(fixtureRoot, manifest.find(row => row.id === id).file), 'utf8'));

const REALM = 'test';
const SENT = 1795115600000;
const RECEIVED = SENT + 100;
const PERSISTED = RECEIVED + 10;
const DEVICE_TS = 1795115595000;

function candidate(patch = {}, { receivedAt = RECEIVED, persistedAt = PERSISTED } = {}) {
  const envelope = { ...fixture('F01'), ...patch };
  const document = {
    sourceId: 'synthetic-ingest', operation: 'measurement', eventId: envelope.eventId, clientid: envelope.clientid,
    _receivedAt: new Date(receivedAt), ...(persistedAt === null ? {} : { persistedAt: new Date(persistedAt) }), _payload: structuredClone(envelope.payload),
    _provenance: { serviceAuthenticated: true, sourceId: 'synthetic-ingest', eventId: envelope.eventId, technicalClientId: envelope.clientid,
      brokerIdentity: 'declared-unverified', mqttContext: 'service-declared', topic: envelope.mqtt.topic, messageType: 'telemetry',
      dataOriginDeclared: envelope.mqtt.dataOrigin, physicalMeasurementVerified: false, commercialAttribution: false,
      deviceTimestamp: envelope.deviceTimestamp ?? null, brokerDeclaredAt: new Date(envelope.sentAt), receivedAt: new Date(receivedAt) },
  };
  const evidence = Object.freeze({});
  const boundary = createIngestProvenanceAuthority({ verify: v => v === evidence ? { sourceId: document.sourceId, operation: 'telemetry',
    eventId: document.eventId, device: { kind: 'mqtt-clientid', value: document.clientid } } : null });
  const result = createProtectedIngestMapper(boundary.authority).map(document, boundary.attest(evidence));
  assert.equal(result.status, 'candidate');
  return result;
}

const device = (patch = {}) => ({ id: 'device-1', sourceId: 'synthetic-ingest', key: { kind: 'mqtt-clientid', value: 'synthetic-device-001' },
  verification: 'verified', lifecycle: 'active', version: 3, createdAt: 1, updatedAt: 2, ...patch });
const association = (patch = {}) => ({ id: 'assoc-A', revision: 1, clientId: 'client-A', sensorId: 'sensor-A', fieldId: 'field-A', areaId: 'area-A',
  physicalDeviceId: 'device-1', sourceId: 'synthetic-ingest', device: { kind: 'mqtt-clientid', value: 'synthetic-device-001' },
  validFrom: 0, validTo: null, state: 'active', auditReason: 'synthetic', ...patch });

function world(overrides = {}) {
  const calls = [];
  const state = {
    devices: [device()], history: [association()],
    temporal: { status: 'trusted', at: RECEIVED, clock: 'received-at', policyRevision: 7 },
    hardware: { status: 'verified', origin: 'simulated', method: 'synthetic-double', attestationRevision: 2 },
    policies: {
      clock: () => ({ status: 'approved', clock: 'received-at', policyRevision: 1 }),
      declaredAt: q => ({ status: 'approved', source: 'device-timestamp', declaredAt: q.candidateClocks.deviceTimestamp, policyRevision: 1 }),
      missingReason: () => ({ status: 'approved', missingReason: 'absent', policyRevision: 1 }),
      persistenceTime: q => ({ status: 'approved', persistedAt: q.persistedAt, policyRevision: 1 }),
    },
    ...overrides,
  };
  const authorities = {
    devices: { async resolve(q) { calls.push(['devices', q]); return { realm: q.realm, devices: structuredClone(state.devices) }; } },
    associations: { async findAt(q) { calls.push(['associations', q]);
      return { realm: q.realm, complete: true, records: structuredClone(state.history.filter(r => r.validFrom <= q.at && (r.validTo === null || q.at < r.validTo))) }; } },
    temporal: { async decide(q) { calls.push(['temporal', q]); return { realm: q.realm, ...state.temporal }; } },
    catalogue: { async evaluate(q) { calls.push(['catalogue', q]);
      return { status: 'approved', realm: q.realm, field: q.field, magnitude: 'temperature', unit: 'celsius', catalogueRevision: 4 }; } },
    hardware: { async verify(q) { calls.push(['hardware', q]); return { realm: q.realm, physicalDeviceId: q.physicalDeviceId, ...state.hardware }; } },
  };
  const policy = name => ({ async decide(q) { calls.push(['policy:' + name, q]); return { realm: q.realm, ...state.policies[name](q) }; } });
  const policies = { clock: policy('clock'), declaredAt: policy('declaredAt'), missingReason: policy('missingReason'), persistenceTime: policy('persistenceTime') };
  return { state, calls, authorities, policies,
    gate: () => createAttributionTrustGate(authorities, { realm: REALM }),
    builder: (extra = {}) => createTrustedEventBuilder({ revalidators: authorities, policies }, { realm: REALM, ...extra }) };
}
async function setup(overrides, c = candidate()) {
  const w = world(overrides); const ready = await w.gate().evaluate(c, { field: 'temperature' });
  assert.equal(ready.status, 'ready-for-attribution');
  return { w, c, ready, build: () => w.builder().build(c, ready) };
}

// ================================================================ ready provenance
test('BE13-04A V1 fabricated, cloned, spread, Proxy, prototype and structurally identical readies are rejected', async () => {
  const { w, c, ready } = await setup();
  const withDescriptors = Object.create(Object.getPrototypeOf(ready), Object.getOwnPropertyDescriptors(ready));
  for (const fake of [structuredClone(ready), { ...ready }, Object.freeze({ ...ready }), new Proxy(ready, {}), Object.create(ready),
    Object.setPrototypeOf({ ...ready }, ready), withDescriptors, JSON.parse(JSON.stringify(ready))]) {
    assert.equal((await w.builder().build(c, fake)).reason, 'invalid-ready');
  }
  assert.equal(isIssuedReadyFor(ready, c), true);
  assert.deepEqual(Object.keys(gateModule).sort(), ['createAttributionTrustGate', 'isIssuedReadyFor'], 'no exported way to register a ready');
});

test('BE13-04A V2 forged revisions/fingerprints cannot be injected: the issued ready is frozen and copies are rejected', async () => {
  const { w, c, ready } = await setup();
  assert.throws(() => { ready.fingerprints.device = '0'.repeat(64); }, TypeError);
  assert.throws(() => { ready.revisions.deviceVersion = 99; }, TypeError);
  const forged = { ...ready, revisions: { ...ready.revisions, deviceVersion: 99 }, fingerprints: { ...ready.fingerprints, device: 'f'.repeat(64) } };
  assert.equal((await w.builder().build(c, forged)).reason, 'invalid-ready');
});

test('BE13-04A V3 a ready from another gate module instance is rejected (fail-closed)', async () => {
  const duplicate = await import('../dist/src/services/attribution-trust-gate.service.js?be13-04a-duplicate');
  const w = world(), c = candidate();
  const foreign = await duplicate.createAttributionTrustGate(w.authorities, { realm: REALM }).evaluate(c, { field: 'temperature' });
  assert.equal(foreign.status, 'ready-for-attribution');
  assert.equal(duplicate.isIssuedReadyFor(foreign, c), true);
  assert.equal((await w.builder().build(c, foreign)).reason, 'invalid-ready');
});

test('BE13-04A V4 a genuine ready paired with a different genuine candidate is rejected', async () => {
  const { w, ready } = await setup();
  const sibling = candidate();
  assert.equal((await w.builder().build(sibling, ready)).reason, 'invalid-ready', 'same content, different emitted object');
});

// ================================================================ lying revalidators
test('BE13-04A V5 revalidators returning contradictory current state are stale, never trusted', async () => {
  const cases = [
    s => { s.devices = [device(), device({ id: 'device-2' })]; },
    s => { s.devices = []; },
    s => { s.devices = [device({ id: 'device-9' })]; },
    s => { s.history = [association(), association({ id: 'assoc-X', clientId: 'client-X' })]; },
    s => { s.history = []; },
    s => { s.history = [association({ physicalDeviceId: 'device-9' })]; },
    s => { s.temporal = { status: 'unresolved' }; },
    s => { s.hardware = { ...s.hardware, origin: 'physical' }; },
  ];
  for (const mutate of cases) {
    const { w, build } = await setup(); mutate(w.state);
    assert.match((await build()).reason, /^stale-/);
  }
});

test('BE13-04A V6 revalidators cannot be skipped or omitted; no bypass option exists', async () => {
  const w = world();
  assert.throws(() => createTrustedEventBuilder({ revalidators: { ...w.authorities, devices: undefined }, policies: w.policies }, { realm: REALM }), TypeError);
  assert.throws(() => createTrustedEventBuilder({ policies: w.policies }, { realm: REALM }), TypeError);
  assert.throws(() => createTrustedEventBuilder({ revalidators: w.authorities }, { realm: REALM, skipRevalidation: true }), TypeError);
  assert.throws(() => createTrustedEventBuilder({ revalidators: w.authorities, policies: { clock: null } }, { realm: REALM }), TypeError);
});

test('BE13-04A V7 every authority is re-read on each build with the exact BE13-03 queries', async () => {
  const { w, build } = await setup();
  const gateQueries = w.calls.splice(0).filter(([n]) => !n.startsWith('policy:'));
  await build();
  const builderQueries = w.calls.filter(([n]) => !n.startsWith('policy:'));
  assert.deepEqual(builderQueries.map(([n]) => n).sort(), ['associations', 'catalogue', 'devices', 'hardware', 'temporal']);
  for (const [name, query] of builderQueries) assert.deepEqual(query, gateQueries.find(([n]) => n === name)[1], name);
});

// ================================================================ lying policies
test('BE13-04A V8 declaredAt policies cannot invent or relabel instants', async () => {
  const lies = [
    () => ({ status: 'approved', source: 'device-timestamp', declaredAt: DEVICE_TS + 1, policyRevision: 1 }),
    () => ({ status: 'approved', source: 'device-timestamp', declaredAt: SENT, policyRevision: 1 }),
    () => ({ status: 'approved', source: 'broker-sent-at', declaredAt: RECEIVED, policyRevision: 1 }),
    () => ({ status: 'approved', source: 'broker-sent-at', declaredAt: PERSISTED, policyRevision: 1 }),
  ];
  for (const lie of lies) {
    const { w, build } = await setup(); w.state.policies.declaredAt = lie;
    assert.equal((await build()).reason, 'contradictory-authority');
  }
  const { w, c, ready } = await setup({}, candidate({ deviceTimestamp: '2026-11-24T00:00:00Z' }));
  w.state.policies.declaredAt = () => ({ status: 'approved', source: 'device-timestamp', declaredAt: 1795996800000, policyRevision: 1 });
  assert.equal((await w.builder().build(c, ready)).reason, 'missing-declared-at', 'ISO device clock is not parsed into an instant');
});

test('BE13-04A V9 clock policies cannot contradict the BE13-03 temporal evidence', async () => {
  const declared = { temporal: { status: 'trusted', at: DEVICE_TS, clock: 'device-declared-approved', policyRevision: 7 } };
  const a = await setup(declared); a.w.state.policies.clock = () => ({ status: 'approved', clock: 'received-at', policyRevision: 1 });
  assert.equal((await a.build()).reason, 'contradictory-authority', 'device clock relabelled as reception');
  const b = await setup(); b.w.state.policies.clock = () => ({ status: 'approved', clock: 'declared-at-approved', policyRevision: 1 });
  assert.equal((await b.build()).reason, 'contradictory-authority', 'reception relabelled as declared');
  const c = await setup(declared);
  c.w.state.policies.clock = () => ({ status: 'approved', clock: 'declared-at-approved', policyRevision: 1 });
  c.w.state.policies.declaredAt = () => ({ status: 'approved', source: 'broker-sent-at', declaredAt: SENT, policyRevision: 1 });
  assert.equal((await c.build()).reason, 'contradictory-authority', 'declaredAt source differs from the authorized clock');
  const d = await setup(declared);
  d.w.state.policies.clock = () => ({ status: 'approved', clock: 'declared-at-approved', policyRevision: 1 });
  d.w.state.policies.declaredAt = () => ({ status: 'approved', source: 'none', declaredAt: null, policyRevision: 1 });
  assert.equal((await d.build()).reason, 'contradictory-authority');
});

test('BE13-04A V10 persistence policies cannot substitute another instant', async () => {
  for (const value of [RECEIVED, SENT, PERSISTED + 1, RECEIVED - 1]) {
    const { w, build } = await setup(); w.state.policies.persistenceTime = () => ({ status: 'approved', persistedAt: value, policyRevision: 1 });
    assert.equal((await build()).reason, 'contradictory-authority', String(value));
  }
  const { w, c, ready } = await setup({}, candidate({}, { persistedAt: null }));
  w.state.policies.persistenceTime = () => ({ status: 'approved', persistedAt: RECEIVED, policyRevision: 1 });
  assert.equal((await w.builder().build(c, ready)).reason, 'unresolved-persisted-at');
});

test('BE13-04A V11 missingReason policies are never consulted for numbers and cannot be forced onto them', async () => {
  const { w, build } = await setup(); w.state.policies.missingReason = () => ({ status: 'approved', missingReason: 'invalid', policyRevision: 1 });
  const result = await build();
  assert.deepEqual([result.status, result.event.value, result.event.missingReason], ['trusted-event', 0, null]);
  assert.equal(w.calls.some(([n]) => n === 'policy:missingReason'), false);
});

// ================================================================ tenancy / spoofing
test('BE13-04A V12 payload clientId/physicalDeviceId/realm never influence the trusted event', async () => {
  const c = candidate({ payload: { temperature: 4, clientId: 'synthetic-device-001', physicalDeviceId: 'device-evil', realm: 'production', tenant: 't' } });
  const { w, ready, build } = await setup({}, c);
  const result = await build();
  assert.deepEqual([result.attribution.realm, result.attribution.clientId, result.attribution.physicalDeviceId], [REALM, 'client-A', 'device-1']);
  assert.deepEqual(Object.keys(result.event).sort(), ['declaredAt', 'device', 'eventId', 'magnitude', 'metadata', 'missingReason', 'persistedAt',
    'provenance', 'receivedAt', 'simulated', 'sourceId', 'unit', 'value']);
  for (const [, q] of w.calls) for (const key of ['clientId', 'tenant']) assert.equal(Object.hasOwn(q, key), false);
  assert.equal(ready.clientId, 'client-A');
});

test('BE13-04A V13 cross-realm answers from any revalidator or policy are rejected', async () => {
  for (const name of ['devices', 'associations', 'temporal', 'catalogue', 'hardware']) {
    const { w, c, ready } = await setup(); const method = Object.keys(w.authorities[name])[0], original = w.authorities[name][method];
    w.authorities[name][method] = async q => ({ ...(await original(q)), realm: 'preview' });
    assert.equal((await w.builder().build(c, ready)).reason, 'realm-mismatch', name);
  }
  for (const name of ['clock', 'declaredAt', 'persistenceTime']) {
    const { w, build } = await setup(); const original = w.state.policies[name];
    w.state.policies[name] = q => ({ ...original(q), realm: 'production' });
    assert.equal((await build()).reason, 'realm-mismatch', name);
  }
});

test('BE13-04A V14 temporal spoofing via revalidated temporal authority is stale', async () => {
  const { w, build } = await setup(); w.state.temporal = { status: 'trusted', at: SENT, clock: 'broker-declared-approved', policyRevision: 7 };
  assert.equal((await build()).reason, 'stale-temporal-policy');
});

test('BE13-04A V15 device inactive now (L1) blocks conservatively at revalidation', async () => {
  const { w, build } = await setup(); w.state.devices = [device({ lifecycle: 'inactive' })];
  assert.equal((await build()).reason, 'stale-device');
});

// ================================================================ hostile dependencies
test('BE13-04A V16 hostile throws, thenables, timeouts and late mutation are contained without leaks', async () => {
  for (const thrown of ['secret', null, undefined, { get message() { throw new Error('x'); } }, new Proxy({}, { get() { throw new Error('x'); } })]) {
    const { w, c, ready } = await setup(); w.policies.persistenceTime.decide = () => { throw thrown; };
    assert.deepEqual(await w.builder().build(c, ready), { status: 'quarantined', reason: 'dependency-error', eventId: 'synthetic-telemetry-001' });
  }
  const t = await setup(); t.w.authorities.catalogue.evaluate = () => ({ get then() { throw new Error('secret'); } });
  assert.equal((await t.w.builder().build(t.c, t.ready)).reason, 'dependency-error');
  const slow = await setup(); slow.w.policies.clock.decide = () => new Promise(() => {});
  assert.equal((await slow.w.builder({ authorityTimeoutMs: 15 }).build(slow.c, slow.ready)).reason, 'dependency-error');
  const live = await setup(); const outs = []; const orig = live.w.authorities.associations.findAt;
  live.w.authorities.associations.findAt = async q => { const o = await orig(q); outs.push(o); return o; };
  const result = await live.w.builder().build(live.c, live.ready);
  for (const o of outs) o.records[0].clientId = 'client-X';
  assert.equal(result.attribution.clientId, 'client-A');
});

test('BE13-04A V17 quarantine results never carry diagnostics', async () => {
  const { w, c, ready } = await setup(); w.authorities.devices.resolve = async () => { throw new Error('mongodb://u:p@h/db'); };
  const result = await w.builder().build(c, ready);
  assert.deepEqual(Object.keys(result).sort(), ['eventId', 'reason', 'status']);
  assert.equal(JSON.stringify(result).includes('mongodb'), false);
});

test('BE13-04A V18 gate quarantine results are never registered as ready', async () => {
  const w = world({ devices: [] }), c = candidate();
  const quarantined = await w.gate().evaluate(c, { field: 'temperature' });
  assert.equal(quarantined.status, 'quarantined');
  assert.equal(isIssuedReadyFor(quarantined, c), false);
  assert.equal((await world().builder().build(c, quarantined)).reason, 'invalid-ready');
});
