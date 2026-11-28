import test from 'node:test';
import assert from 'node:assert/strict';
import { createIngestProvenanceAuthority } from '../dist/src/iot/ingest-provenance.authority.js';
import { createProtectedIngestMapper } from '../dist/src/iot/protected-ingest.mapper.js';
import { trustedMeasurementEventSchema } from '../dist/src/measurements/schemas.js';

const base = () => ({
  _id: 'synthetic-record-a', sourceId: 'synthetic-ingest', operation: 'measurement', eventId: 'synthetic-event-a',
  clientid: 'synthetic-device-a', _receivedAt: new Date(1_000), _payload: { value: 0, missing: null },
  _provenance: { serviceAuthenticated: true, sourceId: 'synthetic-ingest', eventId: 'synthetic-event-a',
    technicalClientId: 'synthetic-device-a', brokerIdentity: 'declared-unverified', mqttContext: 'service-declared',
    topic: 'synthetic/device-a/telemetry', messageType: 'telemetry', dataOriginDeclared: 'unknown',
    physicalMeasurementVerified: false, commercialAttribution: false, deviceTimestamp: null,
    brokerDeclaredAt: new Date(900), receivedAt: new Date(1_000) },
});
const clone = value => structuredClone(value);
const descriptor = document => ({ sourceId: document.sourceId, operation: document._provenance.messageType,
  eventId: document.eventId, device: { kind: 'mqtt-clientid', value: document.clientid } });
function harness(document = base()) {
  const evidence = Object.freeze({ syntheticAuditOnly: true });
  const boundary = createIngestProvenanceAuthority({ verify(value) { return value === evidence ? descriptor(document) : null; } });
  return { document, boundary, mapper: createProtectedIngestMapper(boundary.authority), capability: boundary.attest(evidence) };
}

test('BE13-02A null, undefined and arrays never become candidates', () => {
  const { mapper } = harness();
  for (const value of [null, undefined, [], 'document']) assert.deepEqual(mapper.map(value), { status: 'quarantined', reason: 'unsupported-document' });
});

test('BE13-02A malformed scalar identifiers get controlled missing classifications', () => {
  for (const [field, reason] of [['sourceId', 'missing-source'], ['eventId', 'missing-event-id'], ['clientid', 'missing-technical-identity']]) {
    for (const value of ['', null, 7]) { const document = base(); document[field] = value; assert.equal(harness(document).mapper.map(document).reason, reason); }
  }
});

test('BE13-02A unknown top-level and provenance properties remain fail-closed', () => {
  for (const mutate of [document => { document.extra = true; }, document => { document._provenance.trusted = true; }]) {
    const document = base(); mutate(document); const h = harness(document); assert.equal(h.mapper.map(document, h.capability).reason, 'invalid-schema');
  }
});

test('BE13-02A NaN and Infinity nested in payload are invalid technical data', () => {
  for (const value of [NaN, Infinity, -Infinity]) { const document = base(); document._payload.value = value; const h = harness(document); assert.equal(h.mapper.map(document, h.capability).reason, 'invalid-payload'); }
});

test('BE13-02A payload deeper than protected ingest budget is quarantined', () => {
  const document = base(); let node = document._payload;
  for (let index = 0; index < 18; index += 1) node = node.next = {};
  const h = harness(document); assert.equal(h.mapper.map(document, h.capability).reason, 'invalid-payload');
});

test('BE13-02A payload exceeding the node budget is quarantined', () => {
  const document = base(); document._payload = Object.fromEntries(Array.from({ length: 10_001 }, (_, index) => [`k${index}`, index]));
  const h = harness(document); assert.equal(h.mapper.map(document, h.capability).reason, 'invalid-payload');
});

test('BE13-02A prototype pollution keys are rejected rather than copied', () => {
  const document = base(); Object.defineProperty(document._payload, '__proto__', { value: { polluted: true }, enumerable: true });
  const h = harness(document); assert.equal(h.mapper.map(document, h.capability).reason, 'invalid-payload');
  assert.equal({}.polluted, undefined);
});

test('BE13-02A inherited payload authority is neither copied nor trusted', () => {
  const document = base(); document._payload = Object.assign(Object.create({ clientId: 'foreign-client' }), { value: 1 });
  const result = harness(document); const mapped = result.mapper.map(document, result.capability);
  assert.equal(mapped.status, 'candidate'); assert.deepEqual(mapped.payload, { value: 1 }); assert.equal(Object.hasOwn(mapped.payload, 'clientId'), false);
});

test('BE13-02A copied and serialized capabilities are rejected', () => {
  const h = harness();
  for (const copied of [{ ...h.capability }, structuredClone(h.capability), JSON.parse(JSON.stringify(h.capability))])
    assert.equal(h.mapper.map(h.document, copied).reason, 'unverified-provenance');
});

test('BE13-02A capability from another authority instance is rejected', () => {
  const first = harness(), second = harness(first.document);
  assert.equal(first.mapper.map(first.document, second.capability).reason, 'unverified-provenance');
});

for (const [name, mutate] of [
  ['source', document => { document.sourceId = document._provenance.sourceId = 'synthetic-other-source'; }],
  ['operation', document => { document.operation = 'device-status'; document._provenance.messageType = 'device-status'; }],
  ['event', document => { document.eventId = document._provenance.eventId = 'synthetic-other-event'; }],
  ['device', document => { document.clientid = document._provenance.technicalClientId = 'synthetic-other-device'; }],
]) test(`BE13-02A capability cannot authorize another ${name}`, () => {
  const h = harness(), changed = clone(h.document); mutate(changed);
  assert.equal(h.mapper.map(changed, h.capability).reason, 'unverified-provenance');
});

test('BE13-02A exact capability reuse for the exact event is deterministic', () => {
  const h = harness(), first = h.mapper.map(h.document, h.capability), second = h.mapper.map(h.document, h.capability);
  assert.equal(first.status, 'candidate'); assert.deepEqual(first, second);
});

test('BE13-02A altered payload with the same identity remains outside replay detection responsibility', () => {
  const h = harness(), altered = clone(h.document); altered._payload.value = 99;
  const mapped = h.mapper.map(altered, h.capability);
  assert.equal(mapped.status, 'candidate'); assert.equal(mapped.payload.value, 99);
  assert.equal(Object.hasOwn(mapped, 'duplicate'), false); assert.equal(Object.hasOwn(mapped, 'ack'), false);
  assert.equal(mapped.provenance.payloadIntegrity, 'not-attested');
  assert.equal(mapped.provenance.technicalIdentityAuthorization, 'external-capability');
  assert.equal(Object.hasOwn(mapped.provenance, 'authorization'), false);
});

test('BE13-02A nested arrays and objects are deeply copied and frozen', () => {
  const document = base(); document._payload = { rows: [{ values: [1, 2] }] }; const h = harness(document), result = h.mapper.map(document, h.capability);
  document._payload.rows[0].values[0] = 99;
  assert.deepEqual(result.payload, { rows: [{ values: [1, 2] }] });
  assert.equal(Object.isFrozen(result.payload.rows), true); assert.equal(Object.isFrozen(result.payload.rows[0]), true); assert.equal(Object.isFrozen(result.payload.rows[0].values), true);
});

test('BE13-02A mutation attempts against nested output do not change it', () => {
  const document = base(); document._payload = { nested: { value: 1 } }; const h = harness(document), result = h.mapper.map(document, h.capability);
  assert.throws(() => { result.payload.nested.value = 2; }, TypeError); assert.equal(result.payload.nested.value, 1);
});

test('BE13-02A hostile payload getter fails closed without exposing its error', () => {
  const document = base(); Object.defineProperty(document._payload, 'secret', { enumerable: true, get() { throw new Error('mongodb://user:secret@private'); } });
  const h = harness(document), result = h.mapper.map(document, h.capability);
  assert.equal(result.status, 'quarantined'); assert.equal(JSON.stringify(result).includes('mongodb'), false);
});

test('BE13-02A mismatched received timestamps are conflicting identity evidence', () => {
  const document = base(); document._provenance.receivedAt = new Date(1_001); const h = harness(document);
  assert.equal(h.mapper.map(document, h.capability).reason, 'conflicting-identity');
});

test('BE13-02A out-of-order declared clocks are preserved but never trusted', () => {
  const document = base(); document._provenance.brokerDeclaredAt = new Date(5_000); document._provenance.deviceTimestamp = 9_000;
  const h = harness(document), result = h.mapper.map(document, h.capability);
  assert.equal(result.status, 'candidate'); assert.equal(result.timestamps.sentAt.value, 5_000); assert.equal(result.timestamps.deviceTimestamp.value, 9_000);
  assert.equal(result.timestamps.sentAt.trustedForAttribution, false); assert.equal(result.timestamps.deviceTimestamp.trustedForAttribution, false);
});

test('BE13-02A missing persisted time remains null and does not borrow another clock', () => {
  const h = harness(), result = h.mapper.map(h.document, h.capability);
  assert.equal(result.timestamps.persistedAt.value, null); assert.notEqual(result.timestamps.persistedAt.value, result.timestamps.receivedAt.value);
});

test('BE13-02A unknown and crossed operations are quarantined', () => {
  const unknown = base(); unknown.operation = 'firmware-update'; assert.equal(harness(unknown).mapper.map(unknown).reason, 'unsupported-operation');
  const crossed = base(); crossed._provenance.messageType = 'connected'; const h = harness(crossed); assert.equal(h.mapper.map(crossed, h.capability).reason, 'unsupported-operation');
});

test('BE13-02A business-looking payload fields remain raw and never become candidate authority', () => {
  const document = base(); Object.assign(document._payload, { clientId: document.clientid, sensorId: 'sensor-x', physicalDeviceId: 'device-x', fieldId: 'field-x', areaId: 'area-x' });
  const h = harness(document), result = h.mapper.map(document, h.capability);
  assert.equal(result.status, 'candidate');
  for (const key of ['clientId', 'sensorId', 'physicalDeviceId', 'fieldId', 'areaId', 'attributedAt']) assert.equal(Object.hasOwn(result, key), false);
});

test('BE13-02A candidate cannot satisfy the strict TrustedMeasurementEvent schema', () => {
  const h = harness(), result = h.mapper.map(h.document, h.capability);
  assert.equal(result.status, 'candidate'); assert.equal(trustedMeasurementEventSchema.safeParse(result).success, false);
});

test('BE13-02A secret-looking payload never appears in quarantine output', () => {
  const document = base(); document._payload = { token: 'synthetic-secret-token', uri: 'mongodb://synthetic.invalid/db', value: Infinity };
  const h = harness(document), result = h.mapper.map(document, h.capability), serialized = JSON.stringify(result);
  assert.deepEqual(result, { status: 'quarantined', reason: 'invalid-payload' });
  assert.equal(serialized.includes('secret-token'), false); assert.equal(serialized.includes('mongodb'), false);
});

test('BE13-02A payload property order does not change mapping semantics', () => {
  const first = base(), second = base(); first._payload = { a: 1, b: 2 }; second._payload = { b: 2, a: 1 };
  const a = harness(first), b = harness(second);
  assert.deepEqual(a.mapper.map(first, a.capability), b.mapper.map(second, b.capability));
});
