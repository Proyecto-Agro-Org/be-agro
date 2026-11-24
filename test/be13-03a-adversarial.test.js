// BE13-03A — Adversarial audit regressions for the trust gate.
// Positive cases use EXPLICIT TEST DOUBLES; they are not productive evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIngestProvenanceAuthority } from '../dist/src/iot/ingest-provenance.authority.js';
import * as mapperModule from '../dist/src/iot/protected-ingest.mapper.js';
import { createAttributionTrustGate } from '../dist/src/services/attribution-trust-gate.service.js';
import { fingerprintAuthorityResponse } from '../dist/src/iot/trust-gate.fingerprint.js';
import { trustedMeasurementEventSchema } from '../dist/src/measurements/schemas.js';
import { createMeasurementAttributionService } from '../dist/src/services/measurement-attribution.service.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, '..', 'docs', 'be13-01', 'fixtures');
const manifest = JSON.parse(readFileSync(join(fixtureRoot, 'manifest.json'), 'utf8'));
const fixture = id => JSON.parse(readFileSync(join(fixtureRoot, manifest.find(row => row.id === id).file), 'utf8'));
const { createProtectedIngestMapper, isIssuedProtectedCandidate } = mapperModule;

const REALM = 'test';
const SENT = 1795115600000;
const RECEIVED = SENT + 100;

function documentFromEnvelope(envelope, receivedAt = envelope.sentAt + 100, persistedAt) {
  return {
    sourceId: 'synthetic-ingest', operation: 'measurement', eventId: envelope.eventId, clientid: envelope.clientid,
    _receivedAt: new Date(receivedAt), ...(persistedAt === undefined ? {} : { persistedAt: new Date(persistedAt) }),
    _payload: structuredClone(envelope.payload ?? {}),
    _provenance: {
      serviceAuthenticated: true, sourceId: 'synthetic-ingest', eventId: envelope.eventId, technicalClientId: envelope.clientid,
      brokerIdentity: 'declared-unverified', mqttContext: 'service-declared', topic: envelope.mqtt.topic, messageType: 'telemetry',
      dataOriginDeclared: envelope.mqtt.dataOrigin, physicalMeasurementVerified: false, commercialAttribution: false,
      deviceTimestamp: envelope.deviceTimestamp ?? null, brokerDeclaredAt: new Date(envelope.sentAt), receivedAt: new Date(receivedAt),
    },
  };
}

function mapWith(factory, document) {
  const evidence = Object.freeze({ syntheticTestOnly: true });
  const boundary = createIngestProvenanceAuthority({ verify(value) {
    return value === evidence ? { sourceId: document.sourceId, operation: 'telemetry', eventId: document.eventId,
      device: { kind: 'mqtt-clientid', value: document.clientid } } : null;
  } });
  return factory(boundary.authority).map(document, boundary.attest(evidence));
}

function candidate(patch = {}, receivedAt, persistedAt) {
  const result = mapWith(createProtectedIngestMapper, documentFromEnvelope({ ...fixture('F01'), ...patch }, receivedAt, persistedAt));
  assert.equal(result.status, 'candidate');
  return result;
}

const device = (patch = {}) => ({ id: 'device-1', sourceId: 'synthetic-ingest', key: { kind: 'mqtt-clientid', value: 'synthetic-device-001' },
  verification: 'verified', lifecycle: 'active', version: 3, createdAt: 1, updatedAt: 2, ...patch });
const association = (patch = {}) => ({ id: 'assoc-A', revision: 1, clientId: 'client-A', sensorId: 'sensor-A', fieldId: 'field-A', areaId: 'area-A',
  physicalDeviceId: 'device-1', sourceId: 'synthetic-ingest', device: { kind: 'mqtt-clientid', value: 'synthetic-device-001' },
  validFrom: 0, validTo: null, state: 'active', auditReason: 'synthetic', ...patch });
const closed = patch => association({ state: 'closed', ...patch });

function world(overrides = {}) {
  const calls = [];
  const state = {
    devices: [device()], history: [association()],
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
  return { ports, state, calls, gate: options => createAttributionTrustGate(ports, { realm: REALM, ...options }) };
}

const evaluate = (w, c = candidate(), field = 'temperature', options) => w.gate(options).evaluate(c, { field });
const reasonOf = async (...args) => (await evaluate(...args)).reason;
const deepFrozen = v => v === null || typeof v !== 'object' || (Object.isFrozen(v) && Object.values(v).every(deepFrozen));
function objectsOf(value, out = new Set()) {
  if (value !== null && typeof value === 'object' && !out.has(value)) { out.add(value); Object.values(value).forEach(v => objectsOf(v, out)); }
  return out;
}

// ============================================================ Registry
test('BE13-03A #1 copies of a genuine candidate are rejected (spread, assign, deep copy, symbols, prototype tricks)', async () => {
  const w = world(), real = candidate();
  const deepCopy = v => (v === null || typeof v !== 'object') ? v : Object.freeze(Array.isArray(v) ? v.map(deepCopy)
    : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepCopy(x)])));
  const withSymbols = {}; for (const key of Reflect.ownKeys(real)) withSymbols[key] = real[key];
  const descriptors = Object.create(Object.getPrototypeOf(real), Object.getOwnPropertyDescriptors(real));
  const inheriting = Object.freeze(Object.create(real));
  const reprototyped = Object.setPrototypeOf({ ...real }, real);
  for (const input of [{ ...real }, Object.assign({}, real), deepCopy(real), Object.freeze(withSymbols), descriptors, inheriting, reprototyped]) {
    assert.deepEqual(await w.gate().evaluate(input, { field: 'temperature' }), { status: 'quarantined', reason: 'invalid-candidate', eventId: null });
  }
  assert.equal(w.calls.length, 0);
});

test('BE13-03A #2 structuredClone and JSON round-trip are rejected', async () => {
  const real = candidate();
  for (const input of [structuredClone(real), JSON.parse(JSON.stringify(real))]) assert.equal(await reasonOf(world(), input), 'invalid-candidate');
});

test('BE13-03A #3 a Proxy over a genuine candidate is rejected without invoking traps', async () => {
  let touched = 0;
  const proxy = new Proxy(candidate(), { get(t, k, r) { touched++; return Reflect.get(t, k, r); }, ownKeys(t) { touched++; return Reflect.ownKeys(t); },
    getOwnPropertyDescriptor(t, k) { touched++; return Reflect.getOwnPropertyDescriptor(t, k); } });
  assert.equal(await reasonOf(world(), proxy), 'invalid-candidate');
  assert.equal(touched, 0);
});

test('BE13-03A #4 the registry cannot be written from outside the mapper', async () => {
  assert.equal(typeof isIssuedProtectedCandidate, 'function');
  assert.deepEqual(Object.keys(mapperModule).sort(), ['createProtectedIngestMapper', 'isIssuedProtectedCandidate']);
  assert.equal(existsSync(join(here, '..', 'src', 'iot', 'protected-candidate.registry.ts')), false, 'old exported registry removed');
  const forged = Object.freeze(structuredClone(candidate()));
  assert.equal(isIssuedProtectedCandidate(forged), false);
  assert.equal(await reasonOf(world(), forged), 'invalid-candidate');
});

test('BE13-03A #4b a candidate from another module instance of the mapper is rejected (fail-closed)', async () => {
  const duplicate = await import('../dist/src/iot/protected-ingest.mapper.js?be13-03a-duplicate');
  assert.notEqual(duplicate.createProtectedIngestMapper, createProtectedIngestMapper);
  const foreign = mapWith(duplicate.createProtectedIngestMapper, documentFromEnvelope(fixture('F01')));
  assert.equal(foreign.status, 'candidate');
  assert.equal(duplicate.isIssuedProtectedCandidate(foreign), true);
  assert.equal(isIssuedProtectedCandidate(foreign), false);
  assert.equal(await reasonOf(world(), foreign), 'invalid-candidate');
});

test('BE13-03A #5 reusing a candidate is deterministic and leaves it intact and immutable', async () => {
  const c = candidate(), snapshot = structuredClone(c);
  const [a, b] = [await evaluate(world(), c), await evaluate(world(), c)];
  assert.deepEqual(a, b);
  assert.deepEqual(structuredClone(c), snapshot);
  assert.equal(deepFrozen(c), true);
  assert.throws(() => { c.sourceId = 'x'; }, TypeError);
  assert.throws(() => { c.payload.temperature = 99; }, TypeError);
});

// ============================================================ TOCTOU / revisions
function flipping(name, mutate, fromCall = 2) {
  const w = world(), method = Object.keys(w.ports[name])[0], original = w.ports[name][method];
  let n = 0; w.ports[name][method] = async q => { const out = await original(q); return ++n >= fromCall ? mutate(out) : out; };
  return w;
}

test('BE13-03A #6 identity changes between reads with the SAME revision are detected', async () => {
  assert.equal(await reasonOf(flipping('associations', o => ({ ...o, records: o.records.map(r => ({ ...r, clientId: 'client-B' })) }))), 'stale-association');
  assert.equal(await reasonOf(flipping('associations', o => ({ ...o, records: o.records.map(r => ({ ...r, sensorId: 'sensor-Z' })) }))), 'stale-association');
  assert.equal(await reasonOf(flipping('devices', o => ({ ...o, devices: o.devices.map(d => ({ ...d, updatedAt: 99 })) }))), 'stale-resolution');
  assert.equal(await reasonOf(flipping('hardware', o => ({ ...o, method: 'other-method' }))), 'stale-resolution');
  assert.equal(await reasonOf(flipping('catalogue', o => ({ ...o, unit: 'fahrenheit' }))), 'stale-resolution');
  assert.equal(await reasonOf(flipping('temporal', o => ({ ...o, clock: 'broker-declared-approved', at: SENT }))), 'stale-resolution');
});

test('BE13-03A #7 a change AFTER the second read is not detected by the gate; result requires revalidation', async () => {
  const w = flipping('associations', o => ({ ...o, records: o.records.map(r => ({ ...r, clientId: 'client-B' })) }), 3);
  const gate = w.gate();
  const first = await gate.evaluate(candidate(), { field: 'temperature' });
  assert.equal(first.status, 'ready-for-attribution');
  assert.equal(first.clientId, 'client-A', 'the gate cannot see the change that happens after it returns');
  assert.equal(first.revalidation, 'required');
  const now = await w.ports.associations.findAt({ realm: REALM, physicalDeviceId: first.physicalDeviceId, at: first.authorizedAt, limit: 2 });
  assert.notEqual(fingerprintAuthorityResponse('association', now), first.fingerprints.association,
    'a later stage re-reading and comparing fingerprints detects the change');
});

test('BE13-03A #8 same revisions with different content yield different fingerprints', async () => {
  const a = await evaluate(world());
  const b = await evaluate(world({ history: [association({ clientId: 'client-Z' })] }));
  assert.deepEqual(a.revisions, b.revisions, 'revision numbers alone cannot tell them apart');
  assert.notEqual(a.fingerprints.association, b.fingerprints.association);
  assert.equal(a.fingerprints.device, b.fingerprints.device);
  for (const key of ['device', 'hardware', 'temporal', 'association', 'catalogue']) assert.match(a.fingerprints[key], /^[0-9a-f]{64}$/);
});

test('BE13-03A fingerprints are recomputable from a fresh authority read and reject invalid responses', async () => {
  const w = world(), ready = await evaluate(w);
  const q = Object.fromEntries(w.calls.map(([name, query]) => [name, query]));
  assert.equal(fingerprintAuthorityResponse('device', await w.ports.devices.resolve(q.devices)), ready.fingerprints.device);
  assert.equal(fingerprintAuthorityResponse('association', await w.ports.associations.findAt(q.associations)), ready.fingerprints.association);
  assert.equal(fingerprintAuthorityResponse('temporal', await w.ports.temporal.decide(q.temporal)), ready.fingerprints.temporal);
  assert.equal(fingerprintAuthorityResponse('catalogue', await w.ports.catalogue.evaluate(q.catalogue)), ready.fingerprints.catalogue);
  assert.equal(fingerprintAuthorityResponse('hardware', await w.ports.hardware.verify(q.hardware)), ready.fingerprints.hardware);
  for (const bad of [null, {}, { realm: REALM, devices: [{ ...device(), extra: 1 }] }]) assert.equal(fingerprintAuthorityResponse('device', bad), null);
  assert.equal(fingerprintAuthorityResponse('unknown', {}), null);
});

test('BE13-03A revisions reject empty/negative/non-integer values', async () => {
  for (const bad of [undefined, null, '', -1, 1.5, '1']) {
    assert.equal(await reasonOf(world({ devices: [device({ version: bad })] })), 'invalid-authority-response');
    assert.equal(await reasonOf(world({ temporal: { status: 'trusted', at: RECEIVED, clock: 'received-at', policyRevision: bad } })), 'invalid-authority-response');
  }
});

// ============================================================ Realm / tenant
test('BE13-03A #9 cross-realm answers are rejected for associations and catalogue', async () => {
  const w1 = world(), a = w1.ports.associations.findAt;
  w1.ports.associations.findAt = async q => ({ ...(await a(q)), realm: 'production' });
  assert.equal(await reasonOf(w1), 'realm-mismatch');
  const w2 = world(), c = w2.ports.catalogue.evaluate;
  w2.ports.catalogue.evaluate = async q => ({ ...(await c(q)), realm: 'preview' });
  assert.equal(await reasonOf(w2), 'realm-mismatch');
  const w3 = world(), r = w3.ports.associations.findAt;
  w3.ports.associations.findAt = async q => { const out = await r(q); return { ...out, records: out.records.map(x => ({ ...x, realm: 'production' })) }; };
  assert.equal(await reasonOf(w3), 'invalid-authority-response', 'per-record realm is not part of the BE-11 contract and is rejected');
});

test('BE13-03A spoofing fields in payload never determine attribution', async () => {
  const spoof = candidate({ payload: { temperature: 21, tenant: 'evil', realm: 'production', fieldId: 'f-evil', areaId: 'a-evil',
    sensorId: 's-evil', physicalDeviceId: 'device-evil', clientId: 'synthetic-device-001' } });
  const w = world(), result = await evaluate(w, spoof);
  assert.equal(result.status, 'ready-for-attribution');
  assert.deepEqual([result.realm, result.clientId, result.fieldId, result.areaId, result.sensorId, result.physicalDeviceId],
    [REALM, 'client-A', 'field-A', 'area-A', 'sensor-A', 'device-1']);
  for (const [, q] of w.calls) for (const key of ['clientId', 'tenant', 'fieldId', 'areaId']) assert.equal(Object.hasOwn(q, key), false);
  assert.equal(await reasonOf(world(), spoof, 'physicalDeviceId'), 'invalid-value');
});

test('BE13-03A #10 A→B→A: historical event of A while the device belongs to B today', async () => {
  const t1 = RECEIVED - 1_000, t2 = RECEIVED + 1_000;
  const history = [closed({ id: 'A1', clientId: 'client-A', validFrom: 0, validTo: t1 }),
    closed({ id: 'B', clientId: 'client-B', validFrom: t1, validTo: t2 }), association({ id: 'A2', clientId: 'client-A', validFrom: t2 })];
  const at = (received, h = history) => evaluate(world({ history: h, temporal: { status: 'trusted', at: received, clock: 'received-at', policyRevision: 1 } }),
    candidate({ sentAt: received - 100 }, received));
  assert.equal((await at(t1 - 1)).clientId, 'client-A');
  assert.equal((await at(t1)).clientId, 'client-B', 'exact boundary belongs to the next window');
  assert.equal((await at(t2 - 1)).clientId, 'client-B');
  assert.equal((await at(t2)).clientId, 'client-A');
  const todayB = [closed({ id: 'A1', clientId: 'client-A', validFrom: 0, validTo: t2 }), association({ id: 'B-now', clientId: 'client-B', validFrom: t2 })];
  const historical = await at(t1, todayB);
  assert.deepEqual([historical.clientId, historical.associationId], ['client-A', 'A1']);
});

// ============================================================ Device state
test('BE13-03A #11 device inactive TODAY blocks a historical event that was valid at the time (conservative)', async () => {
  const w = world({ devices: [device({ lifecycle: 'inactive' })], history: [closed({ validFrom: 0, validTo: RECEIVED + 1 })] });
  assert.deepEqual(await evaluate(w), { status: 'quarantined', reason: 'inactive-device', eventId: 'synthetic-telemetry-001' });
  assert.equal(w.calls.some(([n]) => n === 'associations'), false, 'no historical lookup can override current lifecycle');
  const decommissioned = world({ devices: [device({ lifecycle: 'decommissioned' })], history: [closed({ validFrom: 0, validTo: RECEIVED + 1 })] });
  assert.equal(await reasonOf(decommissioned), 'inactive-device');
});

// ============================================================ Time
const trusted = (at, clock) => ({ temporal: { status: 'trusted', at, clock, policyRevision: 1 } });

test('BE13-03A #12 each clock is accepted only on exact equality', async () => {
  const c = candidate();
  const device_ts = c.timestamps.deviceTimestamp.value;
  for (const [at, clock] of [[RECEIVED, 'received-at'], [SENT, 'broker-declared-approved'], [device_ts, 'device-declared-approved']]) {
    const result = await evaluate(world(trusted(at, clock)), c);
    assert.deepEqual([result.status, result.authorizedAt, result.clock], ['ready-for-attribution', at, clock]);
  }
  const same = candidate({ sentAt: RECEIVED }, RECEIVED);
  assert.equal((await evaluate(world(trusted(RECEIVED, 'broker-declared-approved')), same)).clock, 'broker-declared-approved',
    'when two clocks share a value the authority-named clock is reported');
});

test('BE13-03A #13 semantically similar but non-identical instants are rejected', async () => {
  const iso = candidate({ deviceTimestamp: new Date(RECEIVED - 5_000).toISOString() });
  assert.equal(await reasonOf(world(trusted(RECEIVED - 5_000, 'device-declared-approved')), iso), 'contradictory-authority', 'no ISO/zone parsing');
  const seconds = candidate({ deviceTimestamp: Math.floor((RECEIVED - 5_000) / 1000) });
  assert.equal(await reasonOf(world(trusted(Math.floor((RECEIVED - 5_000) / 1000) * 1000, 'device-declared-approved')), seconds), 'contradictory-authority',
    'no unit/precision conversion');
  const fractional = candidate({ deviceTimestamp: RECEIVED - 0.5 });
  assert.equal(await reasonOf(world(trusted(RECEIVED - 1, 'device-declared-approved')), fractional), 'contradictory-authority');
  const persisted = candidate({}, RECEIVED, RECEIVED + 10);
  assert.equal(await reasonOf(world(trusted(RECEIVED + 10, 'received-at')), persisted), 'contradictory-authority', 'persistedAt is never an attribution clock');
  const ahead = candidate({ sentAt: RECEIVED + 500 }, RECEIVED);
  assert.equal(await reasonOf(world(trusted(RECEIVED + 500, 'broker-declared-approved')), ahead), 'contradictory-authority', 'after reception');
  const absent = candidate({ deviceTimestamp: undefined });
  assert.equal(await reasonOf(world(trusted(0, 'device-declared-approved')), absent), 'contradictory-authority', 'absent device clock');
});

test('BE13-03A #14 persistedAt null is preserved, not normalized, and blocks BE-12 conversion', async () => {
  const result = await evaluate(world(), candidate());
  assert.equal(result.timestamps.persistedAt, null);
  const withPersisted = await evaluate(world(), candidate({}, RECEIVED, RECEIVED + 10));
  assert.equal(withPersisted.timestamps.persistedAt, RECEIVED + 10);
});

// ============================================================ Hardware
test('BE13-03A #15 valid BE13-02 provenance is not hardware authentication', async () => {
  const c = candidate();
  assert.equal(c.provenance.technicalIdentityAuthorization, 'external-capability');
  const w = world({ hardware: { status: 'unverified' } });
  assert.equal(await reasonOf(w, c), 'unverified-hardware');
  const query = w.calls.find(([n]) => n === 'hardware')[1];
  assert.deepEqual(Object.keys(query).sort(), ['dataOriginDeclared', 'device', 'eventId', 'physicalDeviceId', 'realm', 'sourceId']);
  const blocking = world(); delete blocking.ports.hardware;
  assert.equal(await reasonOf(blocking, c), 'unverified-hardware');
});

test('BE13-03A #16 contradictory hardware verdicts with valid provenance are rejected', async () => {
  const physicalDecl = candidate({ mqtt: { ...fixture('F01').mqtt, dataOrigin: 'physical-unverified' } });
  assert.equal(await reasonOf(world(), physicalDecl), 'contradictory-authority');
  assert.equal(await reasonOf(world({ hardware: { status: 'verified', origin: 'physical', method: 'x', attestationRevision: 1 } }), candidate()), 'contradictory-authority');
  const other = world(); other.ports.hardware.verify = async q => ({ status: 'verified', realm: q.realm, physicalDeviceId: 'device-9', origin: 'simulated', method: 'x', attestationRevision: 1 });
  assert.equal(await reasonOf(other), 'contradictory-authority');
  const unknownDecl = candidate({ mqtt: { ...fixture('F01').mqtt, dataOrigin: 'unknown' } });
  const decided = await evaluate(world({ hardware: { status: 'verified', origin: 'physical', method: 'x', attestationRevision: 1 } }), unknownDecl);
  assert.deepEqual([decided.status, decided.provenance.dataOriginDeclared, decided.provenance.hardware.origin], ['ready-for-attribution', 'unknown', 'physical']);
});

// ============================================================ Catalogue / values
test('BE13-03A #17 catalogue contradictions, invalid units and unit changes', async () => {
  const other = world(); other.ports.catalogue.evaluate = async q => ({ status: 'approved', realm: q.realm, field: 'soil_moisture', magnitude: 'temperature', unit: 'celsius', catalogueRevision: 1 });
  assert.equal(await reasonOf(other), 'contradictory-authority');
  const empty = world(); empty.ports.catalogue.evaluate = async q => ({ status: 'approved', realm: q.realm, field: q.field, magnitude: 'temperature', unit: '', catalogueRevision: 1 });
  assert.equal(await reasonOf(empty), 'invalid-authority-response');
  const incompatible = world(); incompatible.ports.catalogue.evaluate = async q => ({ status: 'incompatible-unit', realm: q.realm });
  assert.equal(await reasonOf(incompatible), 'incompatible-unit');
  const converted = await evaluate(world({ catalogue: { temperature: { magnitude: 'temperature', unit: 'fahrenheit' } } }),
    candidate({ payload: { temperature: 21.5 } }));
  assert.deepEqual([converted.unit, converted.value], ['fahrenheit', 21.5], 'unit is the authority\'s; the value is never converted');
});

test('BE13-03A #18 null, zero, absent and a payload-declared missingReason', async () => {
  const c = candidate({ payload: { zero: 0, nothing: null, temperature: 5, missingReason: 'absent' } });
  const w = world({ catalogue: { zero: { magnitude: 'm', unit: 'u' }, nothing: { magnitude: 'm', unit: 'u' }, temperature: { magnitude: 't', unit: 'c' } } });
  const zero = await evaluate(w, c, 'zero'), nothing = await evaluate(w, c, 'nothing'), five = await evaluate(w, c, 'temperature');
  assert.equal(Object.is(zero.value, 0), true);
  assert.equal(nothing.value, null);
  assert.equal(five.value, 5);
  for (const r of [zero, nothing, five]) assert.equal(Object.hasOwn(r, 'missingReason'), false);
  assert.equal(await reasonOf(w, c, 'absentField'), 'absent-field');
  assert.equal(await reasonOf(w, c, 'missingReason'), 'invalid-value');
});

// ============================================================ Hostile dependencies / timeout
test('BE13-03A #19 hostile throws and late mutation are contained', async () => {
  const hostileError = { get message() { throw new Error('boom'); }, toString() { throw new Error('boom'); } };
  for (const thrown of ['secret string', hostileError, null, undefined, 42, new Proxy({}, { get() { throw new Error('x'); } })]) {
    const w = world(); w.ports.temporal.decide = () => { throw thrown; };
    assert.deepEqual(await evaluate(w), { status: 'quarantined', reason: 'dependency-error', eventId: 'synthetic-telemetry-001' });
    w.ports.temporal.decide = () => Promise.reject(thrown);
    assert.equal(await reasonOf(w), 'dependency-error');
  }
  const w = world(); const live = [];
  w.ports.associations.findAt = async q => { const out = { realm: q.realm, complete: true, records: [association()] }; live.push(out); return out; };
  const result = await evaluate(w);
  for (const out of live) { out.records[0].clientId = 'client-X'; out.records.push(association({ id: 'X' })); }
  assert.equal(result.clientId, 'client-A');
});

test('BE13-03A #20 timeout quarantines; late resolutions/rejections change nothing and are handled', async () => {
  const unhandled = []; const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const late = world(); const original = late.ports.devices.resolve;
    late.ports.devices.resolve = q => new Promise(resolve => setTimeout(() => resolve(original(q)), 60));
    assert.equal(await reasonOf(late, candidate(), 'temperature', { authorityTimeoutMs: 10 }), 'dependency-error');
    const rejecting = world(); rejecting.ports.hardware.verify = () => new Promise((_, reject) => setTimeout(() => reject(new Error('late secret')), 40));
    assert.equal(await reasonOf(rejecting, candidate(), 'temperature', { authorityTimeoutMs: 10 }), 'dependency-error');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', onUnhandled); }
  const fast = world();
  assert.equal((await evaluate(fast, candidate(), 'temperature', { authorityTimeoutMs: 60_000 })).status, 'ready-for-attribution');
});

// ============================================================ Immutability / confusion
test('BE13-03A #21 ready result is deeply frozen and shares no object with authority queries or candidate', async () => {
  const w = world(), c = candidate(), result = await evaluate(w, c);
  assert.equal(deepFrozen(result), true);
  const mine = objectsOf(result), theirs = new Set([...w.calls.flatMap(([, q]) => [...objectsOf(q)]), ...objectsOf(c)]);
  for (const object of mine) assert.equal(theirs.has(object), false);
  assert.throws(() => { result.fingerprints.association = 'x'; }, TypeError);
  assert.throws(() => { result.revisions.deviceVersion = 0; }, TypeError);
});

test('BE13-03A #22 ready-for-attribution cannot pass as a TrustedMeasurementEvent', async () => {
  const ready = await evaluate(world());
  assert.equal(trustedMeasurementEventSchema.safeParse(ready).success, false);
  for (const key of ['declaredAt', 'missingReason', 'attributedAt', 'metadata', 'simulated', 'receivedAt', 'persistedAt']) assert.equal(Object.hasOwn(ready, key), false, key);
  const be12 = createMeasurementAttributionService({
    devices: { findExact: async () => { throw new Error('must not be called'); } },
    associations: { findAt: async () => { throw new Error('must not be called'); } },
    temporal: { select: async () => { throw new Error('must not be called'); } },
    catalogue: { accepts: async () => { throw new Error('must not be called'); } },
  }, { realm: REALM });
  await assert.rejects(be12.resolve(ready), error => error.code === 'VALIDATION_ERROR');
});

// ============================================================ Pre-publication review (BE13-03 → dev)
test('BE13-03A review: map() output is unchanged and only genuine candidates are registered', () => {
  const quarantined = createProtectedIngestMapper(createIngestProvenanceAuthority({ verify: () => null }).authority).map(documentFromEnvelope(fixture('F01')));
  assert.deepEqual(quarantined, { status: 'quarantined', reason: 'unverified-provenance' });
  assert.equal(isIssuedProtectedCandidate(quarantined), false, 'quarantine results are never registered');
  for (const value of [null, undefined, 1, 'x', {}, fixture('F13')]) assert.equal(isIssuedProtectedCandidate(value), false);
  const c = candidate();
  assert.equal(isIssuedProtectedCandidate(c), true);
  assert.equal(Object.isFrozen(c), true);
  assert.deepEqual(Object.keys(c), ['status', 'kind', 'sourceId', 'storeOperation', 'operation', 'eventId', 'device', 'declaredTechnicalIdentity',
    'idempotencyKey', 'timestamps', 'payload', 'provenance', 'eligibleForMeasurementMapping']);
});

test('BE13-03A review: fingerprint canonicalization is deterministic and content-sensitive', () => {
  const dev = device({ version: 0 });
  const reversed = Object.fromEntries(Object.entries(dev).reverse()); reversed.key = { value: dev.key.value, kind: dev.key.kind };
  const fp = response => fingerprintAuthorityResponse('device', response);
  assert.equal(fp({ realm: REALM, devices: [dev] }), fp({ devices: [reversed], realm: REALM }), 'property order does not matter');
  assert.equal(fp(Object.freeze({ realm: REALM, devices: Object.freeze([Object.freeze({ ...dev })]) })), fp({ realm: REALM, devices: [dev] }));
  assert.equal(fp({ realm: REALM, devices: [{ ...dev, version: -0 }] }), fp({ realm: REALM, devices: [dev] }), '-0 and 0 are the same number');
  const two = [dev, device({ id: 'device-2' })];
  assert.notEqual(fp({ realm: REALM, devices: two }), fp({ realm: REALM, devices: [...two].reverse() }), 'array order is content');
  assert.notEqual(fp({ realm: REALM, devices: [{ ...dev, id: 'café' }] }), fp({ realm: REALM, devices: [{ ...dev, id: 'café' }] }),
    'no Unicode normalization: different code points are different content');
  assert.equal(fp({ realm: REALM, devices: [{ ...dev, extra: undefined }] }), null, 'undefined extra keys are rejected, not ignored');
  assert.equal(fingerprintAuthorityResponse('temporal', { realm: REALM, status: 'trusted', at: new Date(5), clock: 'received-at', policyRevision: 1 }), null,
    'dates are not coerced');
  const { validTo, ...noValidTo } = association();
  assert.equal(fingerprintAuthorityResponse('association', { realm: REALM, complete: true, records: [noValidTo] }), null, 'missing is not null');
});
