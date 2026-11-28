// BE13-04 — Trusted event builder. Real flow: BE13-02 mapper → BE13-03 gate →
// BE13-04 builder. Authorities, revalidators and policies are EXPLICIT TEST
// DOUBLES; nothing here is productive evidence or an approved policy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIngestProvenanceAuthority } from '../dist/src/iot/ingest-provenance.authority.js';
import { createProtectedIngestMapper } from '../dist/src/iot/protected-ingest.mapper.js';
import { createAttributionTrustGate } from '../dist/src/services/attribution-trust-gate.service.js';
import { createTrustedEventBuilder, assembleTrustedMeasurementEvent } from '../dist/src/services/trusted-event-builder.service.js';
import { trustedMeasurementEventSchema } from '../dist/src/measurements/schemas.js';
import { createMeasurementAttributionService } from '../dist/src/services/measurement-attribution.service.js';

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'be13-01', 'fixtures');
const manifest = JSON.parse(readFileSync(join(fixtureRoot, 'manifest.json'), 'utf8'));
const fixture = id => JSON.parse(readFileSync(join(fixtureRoot, manifest.find(row => row.id === id).file), 'utf8'));

const REALM = 'test';
const SENT = 1795115600000;
const RECEIVED = SENT + 100;
const PERSISTED = RECEIVED + 10;
const DEVICE_TS = 1795115595000;

function documentFromEnvelope(envelope, receivedAt, persistedAt) {
  return {
    sourceId: 'synthetic-ingest', operation: 'measurement', eventId: envelope.eventId, clientid: envelope.clientid,
    _receivedAt: new Date(receivedAt), ...(persistedAt === null ? {} : { persistedAt: new Date(persistedAt) }),
    _payload: structuredClone(envelope.payload ?? {}),
    _provenance: {
      serviceAuthenticated: true, sourceId: 'synthetic-ingest', eventId: envelope.eventId, technicalClientId: envelope.clientid,
      brokerIdentity: 'declared-unverified', mqttContext: 'service-declared', topic: envelope.mqtt.topic, messageType: 'telemetry',
      dataOriginDeclared: envelope.mqtt.dataOrigin, physicalMeasurementVerified: false, commercialAttribution: false,
      deviceTimestamp: envelope.deviceTimestamp ?? null, brokerDeclaredAt: new Date(envelope.sentAt), receivedAt: new Date(receivedAt),
    },
  };
}

function candidate(patch = {}, { receivedAt = RECEIVED, persistedAt = PERSISTED } = {}) {
  const document = documentFromEnvelope({ ...fixture('F01'), ...patch }, receivedAt, persistedAt);
  const evidence = Object.freeze({ syntheticTestOnly: true });
  const boundary = createIngestProvenanceAuthority({ verify(value) {
    return value === evidence ? { sourceId: document.sourceId, operation: 'telemetry', eventId: document.eventId,
      device: { kind: 'mqtt-clientid', value: document.clientid } } : null;
  } });
  const result = createProtectedIngestMapper(boundary.authority).map(document, boundary.attest(evidence));
  assert.equal(result.status, 'candidate');
  return result;
}

const device = (patch = {}) => ({ id: 'device-1', sourceId: 'synthetic-ingest', key: { kind: 'mqtt-clientid', value: 'synthetic-device-001' },
  verification: 'verified', lifecycle: 'active', version: 3, createdAt: 1, updatedAt: 2, ...patch });
const association = (patch = {}) => ({ id: 'assoc-A', revision: 1, clientId: 'client-A', sensorId: 'sensor-A', fieldId: 'field-A', areaId: 'area-A',
  physicalDeviceId: 'device-1', sourceId: 'synthetic-ingest', device: { kind: 'mqtt-clientid', value: 'synthetic-device-001' },
  validFrom: 0, validTo: null, state: 'active', auditReason: 'synthetic', ...patch });
const closed = patch => association({ state: 'closed', ...patch });

// A mutable synthetic world shared by the gate authorities and the builder revalidators.
function world(overrides = {}) {
  const calls = [];
  const state = {
    devices: [device()], history: [association()],
    temporal: { status: 'trusted', at: RECEIVED, clock: 'received-at', policyRevision: 7 },
    catalogue: { temperature: { magnitude: 'temperature', unit: 'celsius' }, soil_moisture: { magnitude: 'soil-moisture-raw', unit: 'percent' } },
    hardware: { status: 'verified', origin: 'simulated', method: 'synthetic-double', attestationRevision: 2 },
    policies: {
      clock: { status: 'approved', clock: 'received-at', policyRevision: 11 },
      declaredAt: q => ({ status: 'approved', source: 'device-timestamp', declaredAt: q.candidateClocks.deviceTimestamp, policyRevision: 12 }),
      missingReason: { status: 'approved', missingReason: 'absent', policyRevision: 13 },
      persistenceTime: q => ({ status: 'approved', persistedAt: q.persistedAt, policyRevision: 14 }),
    },
    ...overrides,
  };
  const authorities = {
    devices: { async resolve(q) { calls.push(['devices', q]); return { realm: q.realm, devices: structuredClone(state.devices) }; } },
    associations: { async findAt(q) {
      calls.push(['associations', q]);
      const records = state.history.filter(r => r.physicalDeviceId === q.physicalDeviceId && r.validFrom <= q.at && (r.validTo === null || q.at < r.validTo));
      return { realm: q.realm, complete: true, records: structuredClone(records) };
    } },
    temporal: { async decide(q) { calls.push(['temporal', q]); return { realm: q.realm, ...state.temporal }; } },
    catalogue: { async evaluate(q) {
      calls.push(['catalogue', q]);
      const row = state.catalogue[q.field];
      return row ? { status: 'approved', realm: q.realm, field: q.field, catalogueRevision: 4, ...row } : { status: 'unknown-magnitude', realm: q.realm };
    } },
    hardware: { async verify(q) { calls.push(['hardware', q]);
      return state.hardware.status === 'verified' ? { realm: q.realm, physicalDeviceId: q.physicalDeviceId, ...state.hardware } : { realm: q.realm, ...state.hardware }; } },
  };
  const policy = name => ({ async decide(q) {
    calls.push(['policy:' + name, q]);
    const p = state.policies[name];
    return { realm: q.realm, ...(typeof p === 'function' ? p(q) : p) };
  } });
  const policies = { clock: policy('clock'), declaredAt: policy('declaredAt'), missingReason: policy('missingReason'), persistenceTime: policy('persistenceTime') };
  return {
    state, calls, authorities, policies,
    gate: () => createAttributionTrustGate(authorities, { realm: REALM }),
    builder: (opts = {}) => createTrustedEventBuilder({ revalidators: authorities, policies: opts.policies ?? policies }, { realm: REALM, ...opts.options }),
  };
}

async function readyFor(w, c, field = 'temperature') {
  const ready = await w.gate().evaluate(c, { field });
  assert.equal(ready.status, 'ready-for-attribution', 'fixture must reach ready-for-attribution');
  return ready;
}
async function flow(w, c = candidate(), field = 'temperature', builderOpts) {
  const ready = await readyFor(w, c, field);
  return { ready, result: await w.builder(builderOpts).build(c, ready) };
}
const reasonAfter = async (w, mutate, c = candidate(), field = 'temperature') => {
  const ready = await readyFor(w, c, field); mutate(w.state);
  return (await w.builder().build(c, ready)).reason;
};
const deepFrozen = v => v === null || typeof v !== 'object' || (Object.isFrozen(v) && Object.values(v).every(deepFrozen));
const objectsOf = (v, out = new Set()) => { if (v !== null && typeof v === 'object' && !out.has(v)) { out.add(v); Object.values(v).forEach(x => objectsOf(x, out)); } return out; };

// ================================================================ provenance
test('BE13-04 #1 a ready that was not emitted by BE13-03 for this candidate is invalid-ready', async () => {
  const w = world(), c = candidate(), ready = await readyFor(w, c);
  const other = candidate({ eventId: 'synthetic-telemetry-002' }), otherReady = await readyFor(w, other);
  for (const fake of [structuredClone(ready), { ...ready }, Object.freeze({ ...ready }), JSON.parse(JSON.stringify(ready)), null, {}, otherReady]) {
    assert.deepEqual(await w.builder().build(c, fake), { status: 'quarantined', reason: 'invalid-ready', eventId: null });
  }
});

test('BE13-04 #2 a candidate not emitted by BE13-02 is invalid-candidate', async () => {
  const w = world(), c = candidate(), ready = await readyFor(w, c);
  for (const fake of [structuredClone(c), { ...c }, null]) assert.equal((await w.builder().build(fake, ready)).reason, 'invalid-candidate');
});

// ================================================================ revalidation
test('BE13-04 #3 device revision changed → stale-device', async () => {
  assert.equal(await reasonAfter(world(), s => { s.devices = [device({ version: 4 })]; }), 'stale-device');
});
test('BE13-04 #4 device fingerprint changed with the same revision → stale-device', async () => {
  assert.equal(await reasonAfter(world(), s => { s.devices = [device({ updatedAt: 99 })]; }), 'stale-device');
  assert.equal(await reasonAfter(world(), s => { s.devices = [device({ lifecycle: 'inactive' })]; }), 'stale-device');
});
test('BE13-04 #5 association revision changed → stale-association', async () => {
  assert.equal(await reasonAfter(world(), s => { s.history = [association({ revision: 2 })]; }), 'stale-association');
});
test('BE13-04 #6 association fingerprint changed with the same revision → stale-association', async () => {
  assert.equal(await reasonAfter(world(), s => { s.history = [association({ clientId: 'client-Z' })]; }), 'stale-association');
});
test('BE13-04 #7 temporal authority changed → stale-temporal-policy', async () => {
  assert.equal(await reasonAfter(world(), s => { s.temporal = { ...s.temporal, policyRevision: 8 }; }), 'stale-temporal-policy');
  assert.equal(await reasonAfter(world(), s => { s.temporal = { status: 'untrusted', reason: 'untrusted-clock' }; }), 'stale-temporal-policy');
});
test('BE13-04 #8 catalogue changed → stale-catalog', async () => {
  assert.equal(await reasonAfter(world(), s => { s.catalogue = { temperature: { magnitude: 'temperature', unit: 'kelvin' } }; }), 'stale-catalog');
  assert.equal(await reasonAfter(world(), s => { s.catalogue = {}; }), 'stale-catalog');
});
test('BE13-04 #9 hardware changed → stale-hardware', async () => {
  assert.equal(await reasonAfter(world(), s => { s.hardware = { ...s.hardware, attestationRevision: 3 }; }), 'stale-hardware');
  assert.equal(await reasonAfter(world(), s => { s.hardware = { status: 'unverified' }; }), 'stale-hardware');
});

test('BE13-04 #10 realm mismatch: builder realm or revalidator realm', async () => {
  const w = world(), c = candidate(), ready = await readyFor(w, c);
  const preview = createTrustedEventBuilder({ revalidators: w.authorities, policies: w.policies }, { realm: 'preview' });
  assert.equal((await preview.build(c, ready)).reason, 'realm-mismatch');
  const original = w.authorities.devices.resolve;
  w.authorities.devices.resolve = async q => ({ ...(await original(q)), realm: 'production' });
  assert.equal((await w.builder().build(c, ready)).reason, 'realm-mismatch');
  const p = world(); const r2 = await readyFor(p, c); p.state.policies.clock = { ...p.state.policies.clock, realm: 'production' };
  assert.equal((await p.builder().build(c, r2)).reason, 'realm-mismatch', 'policy answering for another realm');
});

// ================================================================ policies
test('BE13-04 #11 declaredAt not approved (default policy blocks)', async () => {
  const w = world(); const { result } = await flow(w, candidate(), 'temperature', { policies: { ...w.policies, declaredAt: undefined } });
  assert.equal(result.reason, 'unapproved-declared-at');
  const w2 = world(); w2.state.policies.declaredAt = { status: 'blocked' };
  assert.equal((await flow(w2)).result.reason, 'unapproved-declared-at');
});

test('BE13-04 #12 declaredAt approved by a synthetic policy is the exact candidate clock', async () => {
  const device = await flow(world());
  assert.equal(device.result.event.declaredAt, DEVICE_TS);
  const broker = world(); broker.state.policies.declaredAt = { status: 'approved', source: 'broker-sent-at', declaredAt: SENT, policyRevision: 1 };
  assert.equal((await flow(broker)).result.event.declaredAt, SENT);
  const none = world(); none.state.policies.declaredAt = { status: 'approved', source: 'none', declaredAt: null, policyRevision: 1 };
  const r = (await flow(none)).result;
  assert.equal(r.event.declaredAt, null); assert.equal(r.policies.declaredAtSource, 'none');
});

test('BE13-04 #13 null value without an approved missingReason is quarantined', async () => {
  const w = world(); const { result } = await flow(w, candidate(), 'soil_moisture', { policies: { ...w.policies, missingReason: undefined } });
  assert.equal(result.reason, 'missing-reason-required');
});

test('BE13-04 #14 null value with an approved missingReason', async () => {
  const { result } = await flow(world(), candidate(), 'soil_moisture');
  assert.equal(result.status, 'trusted-event');
  assert.equal(result.event.value, null); assert.equal(result.event.missingReason, 'absent'); assert.equal(result.policies.missingReason, 13);
});

test('BE13-04 #15 zero stays zero; no missingReason and the missingReason policy is not consulted', async () => {
  const w = world(); const { result } = await flow(w, candidate(), 'temperature');
  assert.equal(Object.is(result.event.value, 0), true); assert.equal(result.event.missingReason, null);
  assert.equal(result.policies.missingReason, null);
  assert.equal(w.calls.some(([n]) => n === 'policy:missingReason'), false);
});

test('BE13-04 #16 positive value is preserved unconverted', async () => {
  const { result } = await flow(world(), candidate({ payload: { temperature: 21.5 } }));
  assert.deepEqual([result.event.value, result.event.unit, result.event.missingReason], [21.5, 'celsius', null]);
});

test('BE13-04 #17 persistedAt null is never completed', async () => {
  const w = world(); const { result } = await flow(w, candidate({}, { persistedAt: null }));
  assert.equal(result.reason, 'unresolved-persisted-at');
  assert.equal(w.calls.some(([n]) => n === 'policy:persistenceTime'), false, 'no policy can supply a missing instant');
  const blocked = world(); blocked.state.policies.persistenceTime = { status: 'blocked' };
  assert.equal((await flow(blocked)).result.reason, 'unresolved-persisted-at');
});

test('BE13-04 #18 persistedAt approved equals the candidate persistence instant', async () => {
  const { result } = await flow(world());
  assert.equal(result.event.persistedAt, PERSISTED); assert.equal(result.policies.persistenceTime, 14);
});

test('BE13-04 #19 BE-12 clock not approved (default policy blocks)', async () => {
  const w = world(); assert.equal((await flow(w, candidate(), 'temperature', { policies: { ...w.policies, clock: undefined } })).result.reason, 'unresolved-clock');
});

test('BE13-04 #20 BE-12 clock approved: received-at and declared-at-approved', async () => {
  const received = await flow(world());
  assert.deepEqual([received.result.attribution.clock, received.result.attribution.authorizedAt], ['received-at', RECEIVED]);
  const declared = world({ temporal: { status: 'trusted', at: DEVICE_TS, clock: 'device-declared-approved', policyRevision: 7 } });
  declared.state.policies.clock = { status: 'approved', clock: 'declared-at-approved', policyRevision: 2 };
  const r = (await flow(declared)).result;
  assert.deepEqual([r.status, r.attribution.clock, r.attribution.authorizedAt, r.event.declaredAt], ['trusted-event', 'declared-at-approved', DEVICE_TS, DEVICE_TS]);
});

// ================================================================ BE-12 schema
test('BE13-04 #21 the final step rejects anything the BE-12 schema rejects', () => {
  const base = { eventId: 'e', sourceId: 's', device: { kind: 'mqtt-clientid', value: 'd' }, receivedAt: 10, declaredAt: null, persistedAt: 10,
    magnitude: 'm', unit: 'u', value: 1, missingReason: null, provenance: 'physical', simulated: false, metadata: {} };
  assert.notEqual(assembleTrustedMeasurementEvent(base), null);
  for (const bad of [{ ...base, persistedAt: 9 }, { ...base, value: null }, { ...base, value: 1, missingReason: 'absent' }, { ...base, simulated: true },
    { ...base, clientId: 'client-A' }, { ...base, value: Infinity }, { ...base, metadata: { a: { nested: true } } }, null, 'x']) {
    assert.equal(assembleTrustedMeasurementEvent(bad), null);
  }
});

test('BE13-04 #22 the trusted event passes the BE-12 schema and BE-12 attribution reproduces the same owner', async () => {
  const { result } = await flow(world());
  assert.equal(trustedMeasurementEventSchema.safeParse(result.event).success, true);
  const a = result.attribution;
  const be12 = createMeasurementAttributionService({
    devices: { findExact: async () => [{ id: a.physicalDeviceId, sourceId: result.event.sourceId, device: result.event.device, lifecycle: 'active', verification: 'verified' }] },
    associations: { findAt: async q => [{ id: a.associationId, revision: a.associationRevision, realm: q.realm, clientId: a.clientId, fieldId: a.fieldId,
      areaId: a.areaId, sensorId: a.sensorId, physicalDeviceId: a.physicalDeviceId, validFrom: 0, validTo: null }] },
    temporal: { select: async () => ({ status: 'trusted', at: a.authorizedAt, clock: a.clock }) },
    catalogue: { accepts: async () => true },
  }, { realm: REALM });
  const verified = await be12.resolve(result.event);
  assert.deepEqual([verified.status, verified.clientId, verified.associationId, verified.attributedAt], ['verified', a.clientId, a.associationId, a.authorizedAt]);
});

// ================================================================ failures
test('BE13-04 #23 a throwing revalidator or policy quarantines with dependency-error', async () => {
  for (const [kind, name, method] of [['auth', 'devices', 'resolve'], ['auth', 'associations', 'findAt'], ['auth', 'temporal', 'decide'],
    ['auth', 'catalogue', 'evaluate'], ['auth', 'hardware', 'verify'], ['policy', 'clock', 'decide'], ['policy', 'declaredAt', 'decide'],
    ['policy', 'persistenceTime', 'decide']]) {
    const w = world(), c = candidate(), ready = await readyFor(w, c);
    (kind === 'auth' ? w.authorities : w.policies)[name][method] = () => { throw new Error('mongodb://user:secret@host'); };
    assert.deepEqual(await w.builder().build(c, ready), { status: 'quarantined', reason: 'dependency-error', eventId: 'synthetic-telemetry-001' }, name);
  }
});

test('BE13-04 #24 malformed responses: invalid-authority-response / invalid-missing-reason', async () => {
  const w = world(), c = candidate(), ready = await readyFor(w, c);
  w.policies.clock.decide = async q => ({ realm: q.realm, status: 'approved', clock: 'device-time', policyRevision: 1 });
  assert.equal((await w.builder().build(c, ready)).reason, 'invalid-authority-response');
  const m = world(); const r2 = await readyFor(m, c, 'soil_moisture');
  m.state.policies.missingReason = { status: 'approved', missingReason: 'sensor-offline', policyRevision: 1 };
  assert.equal((await m.builder().build(c, r2)).reason, 'invalid-missing-reason');
  const d = world(); const r3 = await readyFor(d, c);
  d.state.policies.declaredAt = { status: 'approved', source: 'none', declaredAt: DEVICE_TS, policyRevision: 1 };
  assert.equal((await d.builder().build(c, r3)).reason, 'invalid-authority-response');
});

test('BE13-04 #25 hostile Proxy responses and a Proxy ready are contained', async () => {
  const w = world(), c = candidate(), ready = await readyFor(w, c);
  w.authorities.hardware.verify = async () => new Proxy({}, { get(_, k) { if (k === 'then') return undefined; throw new Error('secret'); } });
  assert.equal((await w.builder().build(c, ready)).reason, 'invalid-authority-response');
  assert.equal((await world().builder().build(c, new Proxy(ready, {}))).reason, 'invalid-ready');
});

// ================================================================ properties
test('BE13-04 #26 deterministic: same inputs and authorities → identical result', async () => {
  const w = world(), c = candidate(), ready = await readyFor(w, c);
  assert.deepEqual(await w.builder().build(c, ready), await w.builder().build(c, ready));
});

test('BE13-04 #27 immutable output; ready and candidate untouched; no shared references', async () => {
  const w = world(), c = candidate(), ready = await readyFor(w, c);
  const before = [structuredClone(c), structuredClone(ready)];
  const result = await w.builder().build(c, ready);
  assert.equal(deepFrozen(result), true);
  assert.deepEqual([structuredClone(c), structuredClone(ready)], before);
  const theirs = new Set([...objectsOf(c), ...objectsOf(ready), ...w.calls.flatMap(([, q]) => [...objectsOf(q)])]);
  for (const object of objectsOf(result)) assert.equal(theirs.has(object), false);
  assert.throws(() => { result.event.value = 1; }, TypeError);
});

test('BE13-04 #28 clientId only from the historical association; never in the event or any policy query', async () => {
  const w = world({ history: [association({ clientId: 'tenant-real' })] }); const { result } = await flow(w);
  assert.equal(result.attribution.clientId, 'tenant-real');
  assert.equal(Object.hasOwn(result.event, 'clientId'), false);
  for (const [, q] of w.calls) assert.equal(Object.hasOwn(q, 'clientId'), false);
});

test('BE13-04 #29 A→B reassignment: a ready issued under A goes stale; re-running keeps the historical owner A', async () => {
  const w = world(), c = candidate(), ready = await readyFor(w, c);
  w.state.history = [closed({ id: 'assoc-A', revision: 2, clientId: 'client-A', validTo: RECEIVED + 1 }),
    association({ id: 'assoc-B', clientId: 'client-B', validFrom: RECEIVED + 1 })];
  assert.equal((await w.builder().build(c, ready)).reason, 'stale-association');
  const fresh = await w.builder().build(c, await readyFor(w, c));
  assert.deepEqual([fresh.status, fresh.attribution.clientId], ['trusted-event', 'client-A']);
});

test('BE13-04 #30 A→B→A: an event in the B window is attributed to B', async () => {
  const t1 = RECEIVED - 1_000, t2 = RECEIVED + 1_000;
  const w = world({ history: [closed({ id: 'A1', validTo: t1 }), closed({ id: 'B', clientId: 'client-B', validFrom: t1, validTo: t2 }),
    association({ id: 'A2', validFrom: t2 })] });
  const { result } = await flow(w);
  assert.deepEqual([result.attribution.clientId, result.attribution.associationId], ['client-B', 'B']);
});

test('BE13-04 #31 any change after Ready is caught by mandatory revalidation', async () => {
  for (const mutate of [s => { s.devices = [device({ version: 9 })]; }, s => { s.history = [association({ sensorId: 'sensor-Z' })]; },
    s => { s.hardware = { ...s.hardware, method: 'other' }; }, s => { s.catalogue = { temperature: { magnitude: 'temp', unit: 'celsius' } }; }]) {
    assert.match(await reasonAfter(world(), mutate), /^stale-/);
  }
});

test('BE13-04 #32 same revision + different fingerprint → stale', async () => {
  assert.equal(await reasonAfter(world(), s => { s.history = [association({ areaId: 'area-Z' })]; }), 'stale-association');
  assert.equal(await reasonAfter(world(), s => { s.temporal = { ...s.temporal, clock: 'broker-declared-approved', at: SENT }; }), 'stale-temporal-policy');
});

test('BE13-04 #33 a revision-only change also changes the fingerprint; both are compared', async () => {
  assert.equal(await reasonAfter(world(), s => { s.catalogue = { temperature: { magnitude: 'temperature', unit: 'celsius', catalogueRevision: 5 } }; }), 'stale-catalog');
  assert.equal(await reasonAfter(world(), s => { s.devices = [device({ version: 4 })]; }), 'stale-device');
});

test('BE13-04 #34 exact match: every revision and fingerprint equal → trusted-event', async () => {
  const { ready, result } = await flow(world());
  assert.equal(result.status, 'trusted-event');
  assert.deepEqual(result.revisions, ready.revisions); assert.deepEqual(result.fingerprints, ready.fingerprints);
  assert.equal(result.revalidation, 'required');
});

test('BE13-04 #35 hostile payload with clientId/physicalDeviceId does not reach the event or attribution', async () => {
  const c = candidate({ payload: { temperature: 3, clientId: 'synthetic-device-001', physicalDeviceId: 'device-evil', fieldId: 'f-evil' } });
  const { result } = await flow(world(), c);
  assert.deepEqual([result.attribution.clientId, result.attribution.physicalDeviceId, result.attribution.fieldId], ['client-A', 'device-1', 'field-A']);
  assert.deepEqual(result.event.metadata, {});
});

test('BE13-04 #36 a trusted event exists only after all revalidations and all policies', async () => {
  const w = world(); const { result } = await flow(w, candidate(), 'soil_moisture');
  assert.equal(result.status, 'trusted-event');
  const order = w.calls.map(([n]) => n);
  const lastGate = order.lastIndexOf('catalogue');
  const firstPolicy = order.findIndex(n => n.startsWith('policy:'));
  assert.ok(firstPolicy > lastGate, 'policies run only after every revalidation');
  for (const name of ['clock', 'declaredAt', 'missingReason', 'persistenceTime']) assert.ok(order.includes('policy:' + name), name);
  for (const name of ['clock', 'declaredAt', 'missingReason', 'persistenceTime']) {
    const blocked = world(); const r = (await flow(blocked, candidate(), 'soil_moisture', { policies: { ...blocked.policies, [name]: undefined } })).result;
    assert.equal(r.status, 'quarantined', `${name} default blocks`);
  }
  const none = world();
  assert.equal((await flow(none, candidate(), 'soil_moisture', { policies: {} })).result.status, 'quarantined');
});
