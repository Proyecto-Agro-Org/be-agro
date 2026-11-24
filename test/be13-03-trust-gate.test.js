// BE13-03 — Trust gate. Every positive case uses EXPLICIT TEST DOUBLES of the
// authorities. Nothing here is productive evidence of a device registry,
// clock policy, BE-04 catalogue or hardware attestation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIngestProvenanceAuthority } from '../dist/src/iot/ingest-provenance.authority.js';
import { createProtectedIngestMapper } from '../dist/src/iot/protected-ingest.mapper.js';
import { createAttributionTrustGate } from '../dist/src/services/attribution-trust-gate.service.js';

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'be13-01', 'fixtures');
const manifest = JSON.parse(readFileSync(join(fixtureRoot, 'manifest.json'), 'utf8'));
const fixture = id => JSON.parse(readFileSync(join(fixtureRoot, manifest.find(row => row.id === id).file), 'utf8'));

const REALM = 'test';
const SENT = 1795115600000;
const RECEIVED = SENT + 100;
const DEVICE_TS = 1795115595000;

function documentFromEnvelope(envelope, receivedAt = envelope.sentAt + 100) {
  const messageType = envelope.mqtt?.messageType ?? 'unknown';
  return {
    sourceId: 'synthetic-ingest', operation: messageType === 'telemetry' ? 'measurement' : 'device-status',
    eventId: envelope.eventId, clientid: envelope.clientid,
    _receivedAt: new Date(receivedAt), _payload: structuredClone(envelope.payload ?? {}),
    _provenance: {
      serviceAuthenticated: true, sourceId: 'synthetic-ingest', eventId: envelope.eventId,
      technicalClientId: envelope.clientid, brokerIdentity: 'declared-unverified',
      mqttContext: 'service-declared', topic: envelope.mqtt?.topic ?? null,
      messageType, dataOriginDeclared: envelope.mqtt?.dataOrigin ?? 'unknown',
      physicalMeasurementVerified: false, commercialAttribution: false,
      deviceTimestamp: envelope.deviceTimestamp ?? null,
      brokerDeclaredAt: new Date(envelope.sentAt), receivedAt: new Date(receivedAt),
    },
  };
}

function mapCandidate(document) {
  const evidence = Object.freeze({ syntheticTestOnly: true });
  const boundary = createIngestProvenanceAuthority({ verify(value) {
    return value === evidence ? { sourceId: document.sourceId, operation: document._provenance.messageType,
      eventId: document.eventId, device: { kind: 'mqtt-clientid', value: document.clientid } } : null;
  } });
  return createProtectedIngestMapper(boundary.authority).map(document, boundary.attest(evidence));
}

// Candidate from fixture F01 (synthetic). `patch` alters the envelope before mapping.
function candidate(patch = {}, receivedAt) {
  const envelope = { ...fixture('F01'), ...patch };
  const result = mapCandidate(documentFromEnvelope(envelope, receivedAt));
  assert.equal(result.status, 'candidate', 'test fixture must be a genuine BE13-02 candidate');
  return result;
}

// ------------------------------------------------------------ test doubles
const device = (patch = {}) => ({ id: 'device-1', sourceId: 'synthetic-ingest', key: { kind: 'mqtt-clientid', value: 'synthetic-device-001' },
  verification: 'verified', lifecycle: 'active', version: 3, createdAt: 1, updatedAt: 2, ...patch });
const association = (patch = {}) => ({ id: 'assoc-A', revision: 1, clientId: 'client-A', sensorId: 'sensor-A', fieldId: 'field-A', areaId: 'area-A',
  physicalDeviceId: 'device-1', sourceId: 'synthetic-ingest', device: { kind: 'mqtt-clientid', value: 'synthetic-device-001' },
  validFrom: RECEIVED - 10_000, validTo: null, state: 'active', auditReason: 'synthetic', ...patch });
const closed = (patch) => association({ state: 'closed', ...patch });

// World of test doubles. History is filtered by [validFrom, validTo) like a storage query would.
function world(overrides = {}) {
  const calls = [];
  const state = {
    devices: [device()],
    history: [association()],
    temporal: { status: 'trusted', at: RECEIVED, clock: 'received-at', policyRevision: 7 },
    catalogue: { temperature: { magnitude: 'temperature', unit: 'celsius' }, soil_moisture: { magnitude: 'soil-moisture-raw', unit: 'percent' } },
    hardware: { status: 'verified', origin: 'simulated', method: 'synthetic-double', attestationRevision: 2 },
    ...overrides,
  };
  const ports = {
    devices: { async resolve(q) { calls.push(['devices', q]); return { realm: q.realm, devices: structuredClone(state.devices) }; } },
    associations: { async findAt(q) {
      calls.push(['associations', q]);
      const records = state.history.filter(r => r.physicalDeviceId === q.physicalDeviceId && r.validFrom <= q.at && (r.validTo === null || q.at < r.validTo));
      return { realm: q.realm, complete: true, records: structuredClone(records.slice(0, q.limit)) };
    } },
    temporal: { async decide(q) { calls.push(['temporal', q]); return { realm: q.realm, ...state.temporal }; } },
    catalogue: { async evaluate(q) {
      calls.push(['catalogue', q]);
      const row = state.catalogue[q.field];
      if (row === 'incompatible') return { status: 'incompatible-unit', realm: q.realm };
      return row ? { status: 'approved', realm: q.realm, field: q.field, catalogueRevision: 4, ...row } : { status: 'unknown-magnitude', realm: q.realm };
    } },
    hardware: { async verify(q) { calls.push(['hardware', q]);
      return state.hardware.status === 'verified' ? { realm: q.realm, physicalDeviceId: q.physicalDeviceId, ...state.hardware } : { realm: q.realm, ...state.hardware }; } },
  };
  return { ports, state, calls, gate: options => createAttributionTrustGate(ports, { realm: REALM, ...options }) };
}

const evaluate = (w, c = candidate(), field = 'temperature', options) => w.gate(options).evaluate(c, { field });
const reasonOf = async (w, c, field, options) => (await evaluate(w, c, field, options)).reason;

function deepFrozen(value) {
  if (value === null || typeof value !== 'object') return true;
  return Object.isFrozen(value) && Object.values(value).every(deepFrozen);
}

// ======================================================== 1. Candidate
test('BE13-03 #1 rejects anything that is not an issued BE13-02 measurement candidate', async () => {
  const w = world(), real = candidate();
  for (const input of [null, undefined, 42, 'candidate', {}, structuredClone(real), JSON.parse(JSON.stringify(real)), { ...real },
    Object.freeze({ ...real }), fixture('F13'), documentFromEnvelope(fixture('F01'))]) {
    assert.deepEqual(await w.gate().evaluate(input, { field: 'temperature' }), { status: 'quarantined', reason: 'invalid-candidate', eventId: null });
  }
  assert.equal(w.calls.length, 0, 'no authority is consulted for an invalid candidate');
});

test('BE13-03 #1b technical-event candidates (device-status) are not measurements', async () => {
  const technical = mapCandidate(documentFromEnvelope(fixture('F02')));
  assert.equal(technical.status, 'candidate');
  assert.equal((await world().gate().evaluate(technical, { field: 'temperature' })).reason, 'invalid-candidate');
});

test('BE13-03 #1c selection must reference an own numeric/null payload field', async () => {
  const w = world();
  assert.equal(await reasonOf(w, candidate(), 'humidity'), 'absent-field');
  assert.equal(await reasonOf(w, candidate(), 'toString'), 'absent-field');
  assert.equal(await reasonOf(w, candidate({ payload: { temperature: '21.5' } }), 'temperature'), 'invalid-value');
  assert.equal(await reasonOf(w, candidate({ payload: { temperature: true } }), 'temperature'), 'invalid-value');
  assert.equal(await reasonOf(w, candidate({ payload: { temperature: { v: 1 } } }), 'temperature'), 'invalid-value');
  assert.equal((await w.gate().evaluate(candidate(), { field: 'temperature', clientId: 'x' })).reason, 'invalid-candidate');
  assert.equal((await w.gate().evaluate(candidate(), null)).reason, 'invalid-candidate');
  assert.equal(w.calls.length, 0);
});

// ======================================================== 2-5. Device
test('BE13-03 #2 device not found is unresolved-device', async () => {
  assert.equal(await reasonOf(world({ devices: [] })), 'unresolved-device');
});

test('BE13-03 #3 two devices for one key are ambiguous; never the first one', async () => {
  assert.equal(await reasonOf(world({ devices: [device(), device({ id: 'device-2' })] })), 'ambiguous-device');
});

test('BE13-03 #4 unverified device is quarantined', async () => {
  assert.equal(await reasonOf(world({ devices: [device({ verification: 'unverified' })] })), 'unverified-device');
});

test('BE13-03 #5 inactive or decommissioned device is quarantined', async () => {
  assert.equal(await reasonOf(world({ devices: [device({ lifecycle: 'inactive' })] })), 'inactive-device');
  assert.equal(await reasonOf(world({ devices: [device({ lifecycle: 'decommissioned' })] })), 'inactive-device');
});

test('BE13-03 device authority returning another key or source is contradictory', async () => {
  assert.equal(await reasonOf(world({ devices: [device({ key: { kind: 'mqtt-clientid', value: 'other-device' } })] })), 'contradictory-authority');
  assert.equal(await reasonOf(world({ devices: [device({ sourceId: 'other-source' })] })), 'contradictory-authority');
  assert.equal(await reasonOf(world({ devices: [device({ key: { kind: 'device-id', value: 'synthetic-device-001' } })] })), 'contradictory-authority');
});

// ======================================================== 6. Hardware
test('BE13-03 #6 unauthenticated hardware is quarantined; ingest provenance is not hardware proof', async () => {
  assert.equal(await reasonOf(world({ hardware: { status: 'unverified' } })), 'unverified-hardware');
  const w = world(); delete w.ports.hardware;
  assert.equal(await reasonOf(w), 'unverified-hardware', 'default hardware adapter blocks');
});

test('BE13-03 hardware verdict must match the resolved device and declared origin', async () => {
  const w = world(); w.ports.hardware.verify = async q => ({ status: 'verified', realm: q.realm, physicalDeviceId: 'device-2', origin: 'simulated', method: 'x', attestationRevision: 1 });
  assert.equal(await reasonOf(w), 'contradictory-authority');
  assert.equal(await reasonOf(world({ hardware: { status: 'verified', origin: 'physical', method: 'x', attestationRevision: 1 } })), 'contradictory-authority',
    'F01 declares simulated; a physical verdict contradicts it');
  const physical = candidate({ mqtt: { ...fixture('F01').mqtt, dataOrigin: 'physical-unverified' } });
  assert.equal(await reasonOf(world(), physical), 'contradictory-authority', 'physical-unverified declaration with simulated verdict');
  const ok = await evaluate(world({ hardware: { status: 'verified', origin: 'physical', method: 'x', attestationRevision: 1 } }), physical);
  assert.equal(ok.status, 'ready-for-attribution');
});

// ======================================================== 7. Time
test('BE13-03 #7 untrusted or unresolved clock is quarantined; default temporal adapter blocks', async () => {
  assert.equal(await reasonOf(world({ temporal: { status: 'untrusted', reason: 'untrusted-clock' } })), 'untrusted-clock');
  assert.equal(await reasonOf(world({ temporal: { status: 'unresolved' } })), 'unresolved-time');
  const w = world(); delete w.ports.temporal;
  assert.equal(await reasonOf(w), 'untrusted-clock');
});

test('BE13-03 temporal authority cannot invent an instant outside the candidate clocks', async () => {
  assert.equal(await reasonOf(world({ temporal: { status: 'trusted', at: RECEIVED - 1, clock: 'received-at', policyRevision: 1 } })), 'contradictory-authority');
  assert.equal(await reasonOf(world({ temporal: { status: 'trusted', at: SENT + 1, clock: 'broker-declared-approved', policyRevision: 1 } })), 'contradictory-authority');
  assert.equal(await reasonOf(world({ temporal: { status: 'trusted', at: DEVICE_TS, clock: 'device-declared-approved', policyRevision: 1 } }),
    candidate({ deviceTimestamp: 'not-a-number' })), 'contradictory-authority');
  const future = candidate({ deviceTimestamp: RECEIVED + 5_000 });
  assert.equal(await reasonOf(world({ temporal: { status: 'trusted', at: RECEIVED + 5_000, clock: 'device-declared-approved', policyRevision: 1 } }), future),
    'contradictory-authority', 'acquisition after reception is impossible');
});

// ======================================================== 8-12. Association
test('BE13-03 #8 no association at the authorized instant', async () => {
  assert.equal(await reasonOf(world({ history: [] })), 'missing-association');
});

test('BE13-03 #9 overlapping associations are never resolved by picking one', async () => {
  assert.equal(await reasonOf(world({ history: [association(), association({ id: 'assoc-X', clientId: 'client-X', validFrom: RECEIVED - 5 })] })),
    'overlapping-association');
});

test('BE13-03 #10 historical association is used, not the current one', async () => {
  const w = world({ history: [
    closed({ id: 'assoc-old', clientId: 'client-old', sensorId: 'sensor-old', validFrom: RECEIVED - 10_000, validTo: RECEIVED + 1 }),
    association({ id: 'assoc-current', clientId: 'client-current', sensorId: 'sensor-current', validFrom: RECEIVED + 1 }),
  ] });
  const result = await evaluate(w);
  assert.equal(result.status, 'ready-for-attribution');
  assert.equal(result.clientId, 'client-old'); assert.equal(result.associationId, 'assoc-old');
  const assocQuery = w.calls.find(([name]) => name === 'associations')[1];
  assert.equal(assocQuery.at, RECEIVED, 'association is queried at the authorized instant, never at "now"');
});

const reassignment = boundary => [
  closed({ id: 'assoc-A', clientId: 'client-A', sensorId: 'sensor-A', fieldId: 'field-A', areaId: 'area-A', validFrom: 0, validTo: boundary }),
  association({ id: 'assoc-B', clientId: 'client-B', sensorId: 'sensor-B', fieldId: 'field-B', areaId: 'area-B', validFrom: boundary }),
];

test('BE13-03 #11 reassignment A→B preserves ownership on each side of the boundary', async () => {
  const before = await evaluate(world({ history: reassignment(RECEIVED + 1) }));
  const after = await evaluate(world({ history: reassignment(RECEIVED) }));
  assert.equal(before.clientId, 'client-A'); assert.equal(before.fieldId, 'field-A');
  assert.equal(after.clientId, 'client-B'); assert.equal(after.fieldId, 'field-B');
});

test('BE13-03 #12 reassignment A→B→A resolves each event to its historical owner', async () => {
  const t1 = RECEIVED - 1_000, t2 = RECEIVED + 1_000;
  const history = [
    closed({ id: 'assoc-A1', clientId: 'client-A', validFrom: 0, validTo: t1 }),
    closed({ id: 'assoc-B', clientId: 'client-B', sensorId: 'sensor-B', validFrom: t1, validTo: t2 }),
    association({ id: 'assoc-A2', clientId: 'client-A', validFrom: t2 }),
  ];
  const at = async received => evaluate(world({ history, temporal: { status: 'trusted', at: received, clock: 'received-at', policyRevision: 1 } }),
    candidate({ sentAt: received - 100 }, received));
  const [a1, b, a2] = [await at(t1 - 1), await at(t1 + 5), await at(t2)];
  assert.deepEqual([a1.clientId, a1.associationId], ['client-A', 'assoc-A1']);
  assert.deepEqual([b.clientId, b.associationId], ['client-B', 'assoc-B']);
  assert.deepEqual([a2.clientId, a2.associationId], ['client-A', 'assoc-A2']);
});

test('BE13-03 association authority returning records for another device or outside the window is contradictory', async () => {
  const w = world();
  w.ports.associations.findAt = async q => ({ realm: q.realm, complete: true, records: [association({ physicalDeviceId: 'device-2' })] });
  assert.equal(await reasonOf(w), 'contradictory-authority');
  w.ports.associations.findAt = async q => ({ realm: q.realm, complete: true, records: [closed({ validFrom: 0, validTo: q.at })] });
  assert.equal(await reasonOf(w), 'contradictory-authority', 'validTo is exclusive');
  w.ports.associations.findAt = async q => ({ realm: q.realm, complete: true, records: [association({ validFrom: q.at + 1 })] });
  assert.equal(await reasonOf(w), 'contradictory-authority');
  w.ports.associations.findAt = async q => ({ realm: q.realm, complete: false, records: [association()] });
  assert.equal(await reasonOf(w), 'invalid-authority-response', 'incomplete pages are not accepted');
  w.ports.associations.findAt = async q => ({ realm: q.realm, complete: true, records: [association({ state: 'active', validTo: q.at + 10 })] });
  assert.equal(await reasonOf(w), 'invalid-authority-response', 'active state with closed window is inconsistent');
});

// ======================================================== 13-16. Catalogue/values
test('BE13-03 #13 unknown magnitude is quarantined; default catalogue blocks', async () => {
  const f12 = candidate({ payload: fixture('F12').payload });
  const field = Object.keys(fixture('F12').payload)[0];
  assert.equal(await reasonOf(world(), f12, field), 'unapproved-magnitude');
  const w = world(); delete w.ports.catalogue;
  assert.equal(await reasonOf(w), 'unapproved-magnitude');
});

test('BE13-03 #14 incompatible unit is quarantined without conversion', async () => {
  assert.equal(await reasonOf(world({ catalogue: { temperature: 'incompatible' } })), 'incompatible-unit');
});

test('BE13-03 catalogue approving a different field is contradictory', async () => {
  const w = world(); w.ports.catalogue.evaluate = async q => ({ status: 'approved', realm: q.realm, field: 'soil_moisture', magnitude: 'm', unit: 'u', catalogueRevision: 1 });
  assert.equal(await reasonOf(w), 'contradictory-authority');
});

test('BE13-03 #15 null stays null and its missing reason is not inferred', async () => {
  const w = world(), result = await evaluate(w, candidate(), 'soil_moisture');
  assert.equal(result.status, 'ready-for-attribution');
  assert.equal(result.value, null);
  assert.equal(Object.hasOwn(result, 'missingReason'), false);
  assert.equal(w.calls.find(([n]) => n === 'catalogue')[1].valueKind, 'null');
});

test('BE13-03 #16 zero stays zero and is a valid measurement', async () => {
  const result = await evaluate(world(), candidate(), 'temperature');
  assert.equal(result.status, 'ready-for-attribution');
  assert.equal(Object.is(result.value, 0), true);
  assert.equal(result.magnitude, 'temperature'); assert.equal(result.unit, 'celsius');
});

// ======================================================== 17-18. Dependencies/realm
test('BE13-03 #17 throwing, rejecting or silent authorities quarantine with dependency-error and no leak', async () => {
  for (const name of ['devices', 'hardware', 'temporal', 'associations', 'catalogue']) {
    const w = world(), method = Object.keys(w.ports[name])[0];
    w.ports[name][method] = () => { throw new Error('mongodb://secret@host stack'); };
    assert.deepEqual(await evaluate(w), { status: 'quarantined', reason: 'dependency-error', eventId: 'synthetic-telemetry-001' }, name);
    w.ports[name][method] = async () => { throw new Error('secret'); };
    assert.equal(await reasonOf(w), 'dependency-error', name);
  }
  const silent = world(); silent.ports.devices.resolve = () => new Promise(() => {});
  assert.equal(await reasonOf(silent, candidate(), 'temperature', { authorityTimeoutMs: 20 }), 'dependency-error');
});

test('BE13-03 #18 any authority answering for another realm is quarantined', async () => {
  for (const name of ['devices', 'hardware', 'temporal', 'associations', 'catalogue']) {
    const w = world(), method = Object.keys(w.ports[name])[0], original = w.ports[name][method];
    w.ports[name][method] = async q => ({ ...(await original(q)), realm: 'production' });
    assert.equal(await reasonOf(w), 'realm-mismatch', name);
  }
  const w = world(), original = w.ports.devices.resolve;
  w.ports.devices.resolve = async q => ({ ...(await original(q)), realm: 'tenant-b' });
  assert.equal(await reasonOf(w), 'invalid-authority-response');
});

test('BE13-03 malformed, extra-field or hostile authority responses are rejected', async () => {
  const cases = [
    w => { w.ports.devices.resolve = async () => null; },
    w => { w.ports.devices.resolve = async q => ({ realm: q.realm, devices: [{ ...device(), clientId: 'client-A' }] }); },
    w => { w.ports.devices.resolve = async q => ({ realm: q.realm, devices: [device(), device(), device()] }); },
    w => { w.ports.temporal.decide = async q => ({ realm: q.realm, status: 'trusted', at: String(RECEIVED), clock: 'received-at', policyRevision: 1 }); },
    w => { w.ports.temporal.decide = async q => ({ realm: q.realm, status: 'trusted', at: RECEIVED, clock: 'received-at', policyRevision: 1, tolerance: 999 }); },
    w => { w.ports.catalogue.evaluate = async q => ({ realm: q.realm, status: 'approved', field: q.field, magnitude: 'temperature', unit: 'celsius' }); },
    w => { w.ports.hardware.verify = async () => new Proxy({}, { get(_, key) { if (key === 'then') return undefined; throw new Error('secret'); },
      ownKeys() { throw new Error('secret'); } }); },
    w => { w.ports.hardware.verify = async () => ({ get status() { throw new Error('secret'); } }); },
  ];
  for (const mutate of cases) { const w = world(); mutate(w); assert.equal(await reasonOf(w), 'invalid-authority-response'); }
  const thenable = world(); thenable.ports.devices.resolve = () => ({ get then() { throw new Error('secret'); } });
  assert.equal(await reasonOf(thenable), 'dependency-error');
});

// ======================================================== 19. Multi-tenant isolation
test('BE13-03 #19 clientId only comes from the historical association, never from candidate/payload', async () => {
  const spoof = candidate({ clientid: 'client-A', payload: { temperature: 21.5, clientId: 'client-A', clientid: 'client-A' } });
  const w = world({ devices: [device({ key: { kind: 'mqtt-clientid', value: 'client-A' } })],
    history: [association({ clientId: 'tenant-real', device: { kind: 'mqtt-clientid', value: 'client-A' } })] });
  const result = await evaluate(w, spoof);
  assert.equal(result.status, 'ready-for-attribution');
  assert.equal(result.clientId, 'tenant-real');
  assert.notEqual(result.clientId, result.sourceId);
  assert.notEqual(result.clientId, result.device.value, 'mqtt-clientid is not clientId');
  for (const [, query] of w.calls) {
    assert.equal(Object.hasOwn(query, 'clientId'), false, 'no authority receives a caller/payload clientId');
  }
});

test('BE13-03 physicalDeviceId does not imply the current client', async () => {
  const result = await evaluate(world({ history: reassignment(RECEIVED + 50_000) }));
  assert.equal(result.physicalDeviceId, 'device-1');
  assert.equal(result.clientId, 'client-A', 'device currently owned by client-B; event belongs to client-A');
});

// ======================================================== 20-22. Determinism/immutability/revalidation
test('BE13-03 #20 evaluation is deterministic', async () => {
  const c = candidate(), first = await evaluate(world(), c), second = await evaluate(world(), c);
  assert.deepEqual(first, second);
  assert.equal(first.status, 'ready-for-attribution');
});

test('BE13-03 #21 results are deeply frozen and detached from authority objects', async () => {
  const shared = device();
  const w = world(); w.ports.devices.resolve = async q => ({ realm: q.realm, devices: [shared] });
  const result = await evaluate(w);
  assert.equal(deepFrozen(result), true);
  shared.id = 'mutated'; shared.version = 99;
  assert.equal(result.physicalDeviceId, 'device-1'); assert.equal(result.revisions.deviceVersion, 3);
  assert.throws(() => { 'use strict'; result.clientId = 'client-X'; });
  const quarantined = await reasonOf(world({ devices: [] }));
  assert.equal(quarantined, 'unresolved-device');
  assert.equal(deepFrozen(await evaluate(world({ devices: [] }))), true);
  for (const [, query] of w.calls) assert.equal(deepFrozen(query), true, 'queries passed to authorities are frozen');
});

test('BE13-03 ports mutated after construction have no effect', async () => {
  const w = world(), gate = w.gate();
  w.ports.devices.resolve = async () => { throw new Error('late swap'); };
  assert.equal((await gate.evaluate(candidate(), { field: 'temperature' })).status, 'ready-for-attribution');
});

test('BE13-03 #22 captures revisions and detects change between reads', async () => {
  const ready = await evaluate(world());
  assert.equal(ready.revalidation, 'required');
  assert.deepEqual(ready.revisions, { deviceVersion: 3, associationId: 'assoc-A', associationRevision: 1,
    temporalPolicyRevision: 7, catalogueRevision: 4, hardwareAttestationRevision: 2 });

  const flip = (name, mutate) => { const w = world(), method = Object.keys(w.ports[name])[0], original = w.ports[name][method];
    let n = 0; w.ports[name][method] = async q => { const out = await original(q); return ++n === 1 ? out : mutate(out); }; return w; };
  assert.equal(await reasonOf(flip('associations', o => ({ ...o, records: o.records.map(r => ({ ...r, revision: r.revision + 1 })) }))), 'stale-association');
  assert.equal(await reasonOf(flip('associations', o => ({ ...o, records: o.records.map(r => ({ ...r, clientId: 'client-B' })) }))), 'stale-association');
  assert.equal(await reasonOf(flip('devices', o => ({ ...o, devices: o.devices.map(d => ({ ...d, version: d.version + 1 })) }))), 'stale-resolution');
  assert.equal(await reasonOf(flip('temporal', o => ({ ...o, policyRevision: 8 }))), 'stale-resolution');
  assert.equal(await reasonOf(flip('catalogue', o => ({ ...o, catalogueRevision: 5 }))), 'stale-resolution');
  assert.equal(await reasonOf(flip('hardware', o => ({ ...o, attestationRevision: 3 }))), 'stale-resolution');
});

// ======================================================== 23-25. Temporal boundaries
const windowWorld = (validFrom, validTo) => world({ history: [validTo === null ? association({ validFrom }) : closed({ validFrom, validTo })] });

test('BE13-03 #23 validFrom is inclusive', async () => {
  assert.equal((await evaluate(windowWorld(RECEIVED, null))).status, 'ready-for-attribution');
  assert.equal(await reasonOf(windowWorld(RECEIVED + 1, null)), 'missing-association', 'before validFrom');
});

test('BE13-03 #24 validTo is exclusive', async () => {
  assert.equal(await reasonOf(windowWorld(0, RECEIVED)), 'missing-association', 'exactly validTo');
  assert.equal((await evaluate(windowWorld(0, RECEIVED + 1))).status, 'ready-for-attribution', 'inside window');
  assert.equal(await reasonOf(windowWorld(0, RECEIVED - 1)), 'missing-association', 'after validTo');
});

test('BE13-03 adjacent windows resolve the boundary to the later window only', async () => {
  const result = await evaluate(world({ history: reassignment(RECEIVED) }));
  assert.equal(result.associationId, 'assoc-B');
});

test('BE13-03 #25 late event (deep sleep) is attributed by its approved acquisition instant, not by reception', async () => {
  const f11 = fixture('F11');
  const late = candidate({ ...f11, payload: { temperature: 12 } }, f11.sentAt + 3_600_000);
  assert.equal(typeof late.timestamps.deviceTimestamp.value, 'number');
  const acquired = late.timestamps.deviceTimestamp.value, received = late.timestamps.receivedAt.value;
  const history = reassignment(acquired + 1);
  const hardware = { status: 'verified', origin: 'physical', method: 'synthetic-double', attestationRevision: 1 };
  const approved = await evaluate(world({ history, hardware, temporal: { status: 'trusted', at: acquired, clock: 'device-declared-approved', policyRevision: 1 } }), late);
  assert.equal(approved.status, 'ready-for-attribution');
  assert.equal(approved.clientId, 'client-A'); assert.equal(approved.authorizedAt, acquired);
  const byReception = await evaluate(world({ history, hardware, temporal: { status: 'trusted', at: received, clock: 'received-at', policyRevision: 1 } }), late);
  assert.equal(byReception.clientId, 'client-B', 'reception clock yields a different owner: the policy choice matters');
  assert.equal(await reasonOf(world({ history, hardware, temporal: { status: 'untrusted', reason: 'untrusted-clock' } }), late), 'untrusted-clock',
    'uncertain clock never falls back to reception');
});

// ======================================================== Construction/defaults
test('BE13-03 gate with only default adapters never reaches ready-for-attribution', async () => {
  const gate = createAttributionTrustGate({}, { realm: REALM });
  assert.deepEqual(await gate.evaluate(candidate(), { field: 'temperature' }),
    { status: 'quarantined', reason: 'unresolved-device', eventId: 'synthetic-telemetry-001' });
});

test('BE13-03 invalid composition fails at construction', () => {
  assert.throws(() => createAttributionTrustGate(null, { realm: REALM }), TypeError);
  assert.throws(() => createAttributionTrustGate({}, { realm: 'tenant-a' }), TypeError);
  assert.throws(() => createAttributionTrustGate({}, { realm: REALM, authorityTimeoutMs: 0 }), TypeError);
  assert.throws(() => createAttributionTrustGate({}, { realm: REALM, extra: true }), TypeError);
  assert.throws(() => createAttributionTrustGate({ devices: {} }, { realm: REALM }), TypeError);
  assert.throws(() => createAttributionTrustGate({ temporal: { decide: 'yes' } }, { realm: REALM }), TypeError);
});

test('BE13-03 ready result exposes only the documented contract', async () => {
  const result = await evaluate(world());
  assert.deepEqual(Object.keys(result).sort(), ['areaId', 'association', 'associationId', 'authorizedAt', 'clientId', 'clock', 'device', 'eventId',
    'field', 'fieldId', 'magnitude', 'physicalDeviceId', 'provenance', 'realm', 'revalidation', 'revisions', 'sensorId', 'sourceId', 'status',
    'timestamps', 'unit', 'value'].sort());
  assert.equal(Object.hasOwn(result, 'payload'), false);
  assert.equal(Object.hasOwn(result, 'missingReason'), false);
  assert.equal(Object.hasOwn(result, 'attributedAt'), false, 'not a BE-12 attribution');
  assert.equal(result.provenance.payloadIntegrity, 'not-attested');
});
