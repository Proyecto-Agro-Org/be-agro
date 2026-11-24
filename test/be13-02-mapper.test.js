import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIngestProvenanceAuthority } from '../dist/src/iot/ingest-provenance.authority.js';
import { createProtectedIngestMapper } from '../dist/src/iot/protected-ingest.mapper.js';

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'be13-01', 'fixtures');
const manifest = JSON.parse(readFileSync(join(fixtureRoot, 'manifest.json'), 'utf8'));
const fixture = id => JSON.parse(readFileSync(join(fixtureRoot, manifest.find(row => row.id === id).file), 'utf8'));
const copy = value => structuredClone(value);

function documentFromEnvelope(envelope, patch = {}) {
  const messageType = envelope.mqtt?.messageType ?? 'unknown';
  const receivedAt = typeof envelope.sentAt === 'number' ? envelope.sentAt + 100 : 1795115600100;
  return {
    _id: 'synthetic-record-001', sourceId: 'synthetic-ingest',
    operation: messageType === 'telemetry' ? 'measurement' : 'device-status',
    eventId: envelope.eventId, clientid: envelope.clientid,
    _receivedAt: new Date(receivedAt), _payload: copy(envelope.payload ?? {}),
    _provenance: {
      serviceAuthenticated: true, sourceId: 'synthetic-ingest', eventId: envelope.eventId,
      technicalClientId: envelope.clientid, brokerIdentity: 'declared-unverified',
      mqttContext: envelope.mqtt ? 'service-declared' : 'missing', topic: envelope.mqtt?.topic ?? null,
      messageType, dataOriginDeclared: envelope.mqtt?.dataOrigin ?? 'unknown',
      physicalMeasurementVerified: false, commercialAttribution: false,
      deviceTimestamp: envelope.deviceTimestamp ?? null,
      brokerDeclaredAt: new Date(envelope.sentAt), receivedAt: new Date(receivedAt),
    },
    ...patch,
  };
}

function descriptor(document) {
  return { sourceId: document.sourceId, operation: document._provenance.messageType,
    eventId: document.eventId, device: { kind: 'mqtt-clientid', value: document.clientid } };
}

function authorized(document) {
  const externalEvidence = Object.freeze({ syntheticTestOnly: true });
  const boundary = createIngestProvenanceAuthority({ verify(value) { return value === externalEvidence ? descriptor(document) : null; } });
  return { mapper: createProtectedIngestMapper(boundary.authority), capability: boundary.attest(externalEvidence), boundary, externalEvidence };
}

const mapAuthorized = document => { const h = authorized(document); return h.mapper.map(document, h.capability); };

test('BE13-02 valid protected telemetry produces an unattributed measurement candidate', () => {
  const result = mapAuthorized(documentFromEnvelope(fixture('F01')));
  assert.equal(result.status, 'candidate'); assert.equal(result.kind, 'measurement-candidate');
  assert.equal(result.eligibleForMeasurementMapping, true);
});

test('BE13-02 legacy document is quarantined as unsupported', () => {
  assert.deepEqual(authorized(documentFromEnvelope(fixture('F01'))).mapper.map(fixture('F13')), { status: 'quarantined', reason: 'unsupported-document' });
});

test('BE13-02 missing source is classified before schema validation', () => {
  const document = documentFromEnvelope(fixture('F01')); delete document.sourceId;
  assert.equal(authorized(document).mapper.map(document).reason, 'missing-source');
});

test('BE13-02 missing event ID is quarantined', () => {
  const document = documentFromEnvelope(fixture('F08'));
  assert.equal(authorized(document).mapper.map(document).reason, 'missing-event-id');
});

test('BE13-02 missing technical identity is quarantined', () => {
  const document = documentFromEnvelope(fixture('F01')); delete document.clientid;
  assert.equal(authorized(document).mapper.map(document).reason, 'missing-technical-identity');
});

test('BE13-02 contradictory payload identity is quarantined without choosing one', () => {
  const document = documentFromEnvelope(fixture('F09'));
  assert.equal(authorized(document).mapper.map(document).reason, 'conflicting-identity');
});

test('BE13-02 a well formed document without external capability is unverified', () => {
  const document = documentFromEnvelope(fixture('F01')), h = authorized(document);
  assert.deepEqual(h.mapper.map(document), { status: 'quarantined', reason: 'unverified-provenance' });
});

test('BE13-02 strict schema rejects unknown top-level trust flags', () => {
  const document = documentFromEnvelope(fixture('F01')); document.trusted = true;
  assert.equal(authorized(document).mapper.map(document).reason, 'invalid-schema');
});

test('BE13-02 invalid timestamp is classified without using the system clock', () => {
  const document = documentFromEnvelope(fixture('F10'));
  assert.equal(authorized(document).mapper.map(document).reason, 'invalid-timestamp');
});

test('BE13-02 declared timestamps remain separate and untrusted for attribution', () => {
  const document = documentFromEnvelope(fixture('F11'), { persistedAt: new Date(1795115700200) });
  const result = mapAuthorized(document);
  assert.equal(result.timestamps.deviceTimestamp.value, fixture('F11').deviceTimestamp);
  assert.equal(result.timestamps.sentAt.value, fixture('F11').sentAt);
  assert.equal(result.timestamps.receivedAt.value, document._receivedAt.getTime());
  assert.equal(result.timestamps.persistedAt.value, document.persistedAt.getTime());
  assert.equal(Object.values(result.timestamps).every(row => row.trustedForAttribution === false), true);
});

test('BE13-02 zero remains zero', () => {
  assert.equal(mapAuthorized(documentFromEnvelope(fixture('F07'))).payload.temperature, 0);
});

test('BE13-02 null remains null', () => {
  assert.equal(mapAuthorized(documentFromEnvelope(fixture('F07'))).payload.soil_moisture, null);
});

test('BE13-02 absent payload fields remain absent', () => {
  const result = mapAuthorized(documentFromEnvelope(fixture('F07')));
  assert.equal(Object.hasOwn(result.payload, 'electrical_conductivity'), false);
});

test('BE13-02 partial payload is copied without adding measurements', () => {
  const document = documentFromEnvelope(fixture('F07')); document._payload = { nested: { value: 1 } };
  const result = mapAuthorized(document);
  assert.deepEqual(result.payload, { nested: { value: 1 } }); assert.equal(Object.isFrozen(result.payload.nested), true);
});

test('BE13-02 unknown magnitude remains technical data, not an approved catalogue value', () => {
  const result = mapAuthorized(documentFromEnvelope(fixture('F12')));
  assert.equal(result.payload.magnitude, fixture('F12').payload.magnitude);
  assert.equal(Object.hasOwn(result, 'magnitude'), false);
});

for (const [id, operation] of [['F02', 'device-status'], ['F03', 'connected'], ['F04', 'disconnected']]) {
  test(`BE13-02 ${operation} remains an explicit non-measurement technical candidate`, () => {
    const result = mapAuthorized(documentFromEnvelope(fixture(id)));
    assert.equal(result.status, 'candidate'); assert.equal(result.operation, operation);
    assert.equal(result.kind, 'technical-event-candidate'); assert.equal(result.eligibleForMeasurementMapping, false);
  });
}

test('BE13-02 exact retry keeps the same idempotency tuple without implementing ACK', () => {
  const document = documentFromEnvelope(fixture('F05')), first = mapAuthorized(document), second = mapAuthorized(copy(document));
  assert.deepEqual(first.idempotencyKey, second.idempotencyKey); assert.equal(Object.hasOwn(first, 'duplicate'), false);
});

test('BE13-02 altered replay is not misreported as deduplicated by the mapper', () => {
  const first = documentFromEnvelope(fixture('F05')), altered = documentFromEnvelope(fixture('F06'));
  const a = mapAuthorized(first), b = mapAuthorized(altered);
  assert.deepEqual(a.idempotencyKey, b.idempotencyKey); assert.notDeepEqual(a.payload, b.payload);
  assert.equal(Object.hasOwn(b, 'ack'), false);
});

for (const forbidden of ['clientId', 'sensorId', 'physicalDeviceId', 'attributedAt']) {
  test(`BE13-02 candidate never contains ${forbidden}`, () => {
    assert.equal(Object.hasOwn(mapAuthorized(documentFromEnvelope(fixture('F01'))), forbidden), false);
  });
}

test('BE13-02 authority failures are sanitized to one controlled code', () => {
  const document = documentFromEnvelope(fixture('F01'));
  const boundary = createIngestProvenanceAuthority({ verify() { throw new Error('PRIVATE_TOKEN_AND_URI'); } });
  const mapper = createProtectedIngestMapper(boundary.authority);
  assert.equal(boundary.attest({}), null);
  assert.deepEqual(mapper.map(document, {}), { status: 'quarantined', reason: 'unverified-provenance' });
});

test('BE13-02 mapping is deterministic for the same document and capability', () => {
  const document = documentFromEnvelope(fixture('F01')), h = authorized(document);
  assert.deepEqual(h.mapper.map(document, h.capability), h.mapper.map(document, h.capability));
});

test('BE13-02 mapper neither mutates nor exposes mutable input references', () => {
  const document = documentFromEnvelope(fixture('F01')), before = copy(document), result = mapAuthorized(document);
  assert.deepEqual(document, before); document._payload.temperature = 99;
  assert.equal(result.payload.temperature, before._payload.temperature);
  assert.equal(Object.isFrozen(result), true); assert.equal(Object.isFrozen(result.timestamps), true);
});

test('BE13-02 unexpected hostile input becomes a sanitized internal quarantine', () => {
  const hostile = new Proxy({ sourceId: 'synthetic-ingest', operation: 'measurement' }, { get() { throw new Error('PRIVATE'); } });
  const boundary = createIngestProvenanceAuthority({ verify() { return null; } });
  const mapper = createProtectedIngestMapper(boundary.authority);
  assert.deepEqual(mapper.map(hostile, {}), { status: 'quarantined', reason: 'internal-error' });
});

test('BE13-02 payload claims cannot forge external provenance', () => {
  const document = documentFromEnvelope(fixture('F01')); document._payload.trusted = true; document._payload.serviceAuthenticated = true;
  const h = authorized(document);
  assert.equal(h.mapper.map(document, { trusted: true }).reason, 'unverified-provenance');
});

test('BE13-02 output has no persistence, transaction, retry or network responsibility', () => {
  const result = mapAuthorized(documentFromEnvelope(fixture('F01')));
  for (const key of ['ack', 'duplicate', 'transaction', 'retry', 'collection', 'uri']) assert.equal(Object.hasOwn(result, key), false);
});

test('BE13-02 capability is bound to source, event, operation and technical device', () => {
  const first = documentFromEnvelope(fixture('F01')), second = documentFromEnvelope(fixture('F12'));
  const h = authorized(first);
  assert.equal(h.mapper.map(second, h.capability).reason, 'unverified-provenance');
});

test('BE13-02 hostile verifier output cannot escape or mint a capability', () => {
  const hostile = new Proxy({}, { get() { throw new Error('PRIVATE_VERIFIER_OUTPUT'); } });
  const boundary = createIngestProvenanceAuthority({ verify() { return hostile; } });
  assert.equal(boundary.attest({}), null);
});

test('BE13-02 an arbitrary accepts method cannot replace an issued authority', () => {
  assert.throws(() => createProtectedIngestMapper({ accepts() { return true; } }), /Issued provenance authority required/);
});
