// BE13-11A — broker provenance and MQTT ingestion boundary (OFFLINE). SINTETICO: every delivery, principal and limit is a
// TEST_ONLY double; no broker, network or credential is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMqttIngestionBoundary, describeMqttBoundaryReadiness } from '../dist/src/services/mqtt-ingestion-boundary.service.js';
import { createBlockingMqttBoundaryPlaceholders } from '../dist/src/adapters/ingestion-production-placeholders.js';
import { boundarySetup, delivery, envelope, bytesOf, TEST_ONLY_CONFIG, PRINCIPAL, KEY } from '../test-support/be13-11a-broker.fixtures.js';

const measurementsOf = s => [...s.persistence.measurements.values()];
const auditActions = s => s.audit.entries.map(e => e.action);

test('P01 verified provenance → ingested: identity from the mapping, request bound to realm + context fingerprint, audited, counted', async () => {
  const s = await boundarySetup();
  const r = await s.boundary.deliver(delivery());
  assert.equal(r.status, 'ingested');
  assert.deepEqual(r.results.map(x => [x.field, x.result.status]), [['temperature', 'accepted']]);
  assert.deepEqual([r.provenance.sourceId, r.provenance.principalReference, r.provenance.verifierRevision, r.provenance.mappingRevision], ['synthetic-ingest', PRINCIPAL, 1, 1]);
  const call = s.verifier.calls[0];
  assert.equal(call.realm, 'test');
  assert.match(call.contextFingerprint, /^[0-9a-f]{64}$/);
  assert.ok(Object.isFrozen(call) && Object.isFrozen(call.brokerObserved));
  assert.equal(measurementsOf(s).length, 1);
  assert.ok(auditActions(s).includes('broker-provenance-verified'));
  assert.ok(s.metrics.events.some(e => e.name === 'provenance_result_total' && e.labels.outcome === 'verified'));
});

test('P02 unverified provenance: no authenticated principal, or an unknown one → security, not retryable, nothing ingested', async () => {
  const s = await boundarySetup();
  const none = await s.boundary.deliver(delivery({ obs: { authenticatedPrincipalReference: null } }));
  assert.deepEqual([none.status, none.reasonCode, none.retryClass, none.retryable], ['rejected', 'broker-provenance-unverified', 'security', false]);
  assert.equal(s.verifier.calls.length, 0, 'no principal → the verifier is not even asked');
  const unknown = await s.boundary.deliver(delivery({ obs: { authenticatedPrincipalReference: 'principal:someone-else' } }));
  assert.equal(unknown.reasonCode, 'broker-principal-unknown');
  assert.equal(measurementsOf(s).length, 0);
  assert.equal(s.quarantine.rows.size, 0, 'boundary rejections never create quarantine records');
});

test('P03 rejected provenance → broker-provenance-rejected (security)', async () => {
  const s = await boundarySetup({ verifierMode: { kind: 'reject' } });
  const r = await s.boundary.deliver(delivery());
  assert.deepEqual([r.reasonCode, r.retryClass, r.retryable], ['broker-provenance-rejected', 'security', false]);
  assert.ok(auditActions(s).includes('broker-provenance-rejected'));
});

test('P04 verifier throws or exceeds the TEST_ONLY timeout → broker-verifier-unavailable (transient), alert, nothing ingested', async () => {
  for (const kind of ['throw', 'hang']) {
    const s = await boundarySetup({ verifierMode: { kind } });
    const r = await s.boundary.deliver(delivery());
    assert.deepEqual([r.reasonCode, r.retryClass, r.retryable], ['broker-verifier-unavailable', 'transient', true]);
    assert.ok(s.alerts.events.some(a => a.type === 'BROKER_VERIFIER_UNAVAILABLE'));
    assert.equal(measurementsOf(s).length, 0);
  }
});

test('P05 malformed verifier responses → invalid-authority-response; a VERIFIED for another context/principal → broker-context-mismatch', async () => {
  for (const answer of [null, 'VERIFIED', { status: 'VERIFIED' }, { status: 'VERIFIED', realm: 'test', principalReference: PRINCIPAL, contextFingerprint: 'x', authentication: 'broker-confirmed', verifiedAt: 1, verifierRevision: 1 },
    { status: 'OK', realm: 'test' }, r => ({ status: 'VERIFIED', realm: r.realm, principalReference: PRINCIPAL, contextFingerprint: r.contextFingerprint, authentication: 'password', verifiedAt: 1, verifierRevision: 1 })]) {
    const s = await boundarySetup({ verifierMode: { kind: 'answer', answer } });
    assert.equal((await s.boundary.deliver(delivery())).reasonCode, 'invalid-authority-response');
  }
  const other = await boundarySetup({ verifierMode: { kind: 'answer', answer: r => ({ status: 'VERIFIED', realm: r.realm, principalReference: PRINCIPAL, contextFingerprint: 'a'.repeat(64),
    authentication: 'broker-confirmed', verifiedAt: 1, verifierRevision: 1 }) } });
  assert.equal((await other.boundary.deliver(delivery())).reasonCode, 'broker-context-mismatch');
  const otherPrincipal = await boundarySetup({ verifierMode: { kind: 'answer', answer: r => ({ status: 'VERIFIED', realm: r.realm, principalReference: 'principal:other', contextFingerprint: r.contextFingerprint,
    authentication: 'broker-confirmed', verifiedAt: 1, verifierRevision: 1 }) } });
  assert.equal((await otherPrincipal.boundary.deliver(delivery())).reasonCode, 'broker-context-mismatch');
});

test('P06 realm mismatch from the verifier or from the identity mapping → broker-realm-mismatch', async () => {
  const v = await boundarySetup({ verifierMode: { kind: 'answer', answer: r => ({ status: 'VERIFIED', realm: 'preview', principalReference: PRINCIPAL, contextFingerprint: r.contextFingerprint,
    authentication: 'broker-confirmed', verifiedAt: 1, verifierRevision: 1 }) } });
  assert.equal((await v.boundary.deliver(delivery())).reasonCode, 'broker-realm-mismatch');
  const m = await boundarySetup({ mappingMode: { kind: 'answer', answer: { status: 'mapped', realm: 'preview', principalReference: PRINCIPAL, sourceId: 'synthetic-ingest',
    technicalDeviceKey: { kind: 'mqtt-clientid', value: KEY }, mappingRevision: 1 } } });
  assert.equal((await m.boundary.deliver(delivery())).reasonCode, 'broker-realm-mismatch');
});

test('P07 topic spoofing: a routed topic naming another device changes no identity; the declared topic is ignored; unrouted → topic-not-routed', async () => {
  const s = await boundarySetup();
  const r = await s.boundary.deliver(delivery({ obs: { topic: 'synthetic/agro/device-999/telemetry' }, env: { mqtt: { topic: 'synthetic/agro/OTHER', messageType: 'telemetry', dataOrigin: 'simulated' } } }));
  assert.equal(r.results[0].result.status, 'accepted');
  const [m] = measurementsOf(s);
  assert.deepEqual([m.key.sourceId, m.event.device?.value ?? m.key.sourceId, m.attribution.clientId], ['synthetic-ingest', m.event.device?.value ?? 'synthetic-ingest', 'client-A']);
  assert.equal((await s.boundary.deliver(delivery({ obs: { topic: 'other/realm/production/telemetry' }, env: { eventId: 'synthetic-telemetry-002' } }))).reasonCode, 'topic-not-routed');
});

test('P08 the MQTT client id is a technical connection identity, never the business clientId', async () => {
  const s = await boundarySetup();
  const r = await s.boundary.deliver(delivery());
  const [m] = measurementsOf(s);
  assert.equal(m.attribution.clientId, 'client-A', 'business clientId comes from the BE-12 association');
  assert.notEqual(m.attribution.clientId, KEY);
  assert.equal(JSON.stringify(r).includes('client-A'), false, 'the boundary result exposes no business identity');
  assert.ok(!('clientId' in r) && !('clientid' in r.provenance));
});

test('P09 technical identity mismatch (declared key, payload alias or connection client id) → rejected before the pipeline, alerted', async () => {
  for (const d of [delivery({ env: { clientid: 'synthetic-device-002' } }), delivery({ env: { payload: { temperature: 1, client_id: 'synthetic-device-002' } } }),
    delivery({ obs: { mqttClientId: 'synthetic-device-002' } })]) {
    const s = await boundarySetup();
    const r = await s.boundary.deliver(d);
    assert.deepEqual([r.reasonCode, r.retryClass, r.retryable], ['technical-identity-mismatch', 'security', false]);
    assert.equal(s.quarantine.rows.size, 0, 'rejected at the boundary, not inside the pipeline');
    assert.ok(s.alerts.events.some(a => a.type === 'TECHNICAL_IDENTITY_MISMATCH'));
    assert.ok(auditActions(s).includes('technical-identity-mismatch'));
  }
});

test('P10 retained messages are blocked by default (policy-blocked); only an explicit TEST_ONLY policy accepts them', async () => {
  const s = await boundarySetup();
  const r = await s.boundary.deliver(delivery({ obs: { retain: true } }));
  assert.deepEqual([r.reasonCode, r.retryClass, r.retryable], ['retained-message-blocked', 'policy-blocked', false]);
  assert.equal(s.verifier.calls.length, 0);
  const accept = await boundarySetup({ extra: { boundaryConfig: { ...TEST_ONLY_CONFIG, retained: 'accept' } } });
  assert.equal((await accept.boundary.deliver(delivery({ obs: { retain: true } }))).status, 'ingested');
});

test('P11 invalid JSON, invalid UTF-8, non-object roots and non-finite numbers are rejected (never repaired)', async () => {
  const s = await boundarySetup();
  const cases = [[bytesOf('{"version":1,'), 'payload-malformed'], [Buffer.from([0x7b, 0xff, 0xfe, 0x7d]), 'payload-invalid-utf8'], [bytesOf('[1,2]'), 'payload-malformed'],
    [bytesOf('"text"'), 'payload-malformed'], [bytesOf(JSON.stringify(envelope()).replace('"temperature":0', '"temperature":1e400')), 'payload-malformed'],
    [bytesOf(JSON.stringify(envelope({ payload: { temperature: '0' } }))), null]];
  for (const [payload, reason] of cases) {
    const r = await s.boundary.deliver(delivery({ payload }));
    if (reason) assert.equal(r.reasonCode, reason); else assert.equal(r.status, 'ingested', '"0" is kept as a string (no coercion); downstream decides');
  }
  assert.equal(s.verifier.calls.length, 1, 'only the structurally valid delivery reached the verifier');
});

test('P12 dangerous keys (__proto__, constructor, prototype) anywhere are rejected; no prototype is polluted', async () => {
  const s = await boundarySetup();
  for (const text of ['{"__proto__":{"polluted":true},"version":1}', '{"version":1,"payload":{"constructor":{"prototype":{"polluted":true}}}}',
    JSON.stringify(envelope()).replace('"payload":{', '"payload":{"prototype":1,')]) {
    assert.equal((await s.boundary.deliver(delivery({ payload: bytesOf(text) }))).reasonCode, 'payload-dangerous-key');
  }
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});

test('P13 oversized payloads are rejected before hashing, parsing or verification; nesting, key count and string length are bounded', async () => {
  const s = await boundarySetup();
  const big = await s.boundary.deliver(delivery({ payload: Buffer.alloc(4097, 0x20) }));
  assert.deepEqual([big.reasonCode, big.payloadFingerprint], ['payload-too-large', null]);
  const deep = await s.boundary.deliver(delivery({ payload: bytesOf('{"a":' + '['.repeat(20) + ']'.repeat(20) + '}') }));
  assert.equal(deep.reasonCode, 'payload-limits-exceeded');
  const keys = Object.fromEntries(Array.from({ length: 70 }, (_, i) => ['k' + i, i]));
  assert.equal((await s.boundary.deliver(delivery({ env: { payload: keys } }))).reasonCode, 'payload-limits-exceeded');
  assert.equal((await s.boundary.deliver(delivery({ env: { payload: { temperature: 'x'.repeat(300) } } }))).reasonCode, 'payload-limits-exceeded');
  assert.equal(s.verifier.calls.length, 0);
});

test('P14 caller "trusted/verified/authenticated" flags never change anything: closed shapes reject them', async () => {
  const s = await boundarySetup({ verifierMode: { kind: 'reject' } });
  assert.equal((await s.boundary.deliver({ ...delivery(), trusted: true, verified: true })).reasonCode, 'broker-context-malformed');
  assert.equal((await s.boundary.deliver(delivery({ obs: { verified: true } }))).reasonCode, 'broker-context-malformed');
  assert.equal((await s.boundary.deliver(delivery({ env: { trusted: true } }))).reasonCode, 'payload-malformed');
  assert.equal((await s.boundary.deliver(delivery({ env: { payload: { temperature: 1, trusted: true, verified: true } } }))).reasonCode, 'broker-provenance-rejected',
    'flags inside the measurement payload are plain data; the verifier still decides');
});

test('P15 caller "retryable" flags never change the classification', async () => {
  const s = await boundarySetup({ verifierMode: { kind: 'reject' } });
  assert.equal((await s.boundary.deliver({ ...delivery(), retryable: true })).retryable, false);
  const r = await s.boundary.deliver(delivery({ env: { payload: { temperature: 1, retryable: true, retry_class: 'transient' } } }));
  assert.deepEqual([r.reasonCode, r.retryClass, r.retryable], ['broker-provenance-rejected', 'security', false]);
});

test('P16 QoS redelivery (1 or 2, DUP) of the same event stays idempotent: realm + sourceId + operation + eventId + field', async () => {
  const s = await boundarySetup();
  assert.equal((await s.boundary.deliver(delivery({ obs: { qos: 2, packetId: 1 } }))).results[0].result.status, 'accepted');
  assert.equal((await s.boundary.deliver(delivery({ obs: { qos: 1, packetId: 2, receivedAt: 1795115600200, rawPersistedAt: 1795115600210 } }))).results[0].result.status, 'duplicate');
  assert.equal(measurementsOf(s).length, 1);
});

test('P17 packet id reuse is irrelevant: different events with the same packet id are both ingested; it is never an event identity', async () => {
  const s = await boundarySetup();
  const a = await s.boundary.deliver(delivery({ obs: { packetId: 9 } }));
  const b = await s.boundary.deliver(delivery({ obs: { packetId: 9 }, env: { eventId: 'synthetic-telemetry-002' } }));
  assert.deepEqual([a.results[0].result.status, b.results[0].result.status], ['accepted', 'accepted']);
  assert.equal(measurementsOf(s).length, 2);
});

test('P18 full synthetic E2E accepted: delivery → boundary → BE13-02…10B → persistence; admitForReplay feeds an operator replay', async () => {
  const s = await boundarySetup();
  const r = await s.boundary.deliver(delivery());
  assert.equal(r.results[0].result.status, 'accepted');
  const [m] = measurementsOf(s);
  assert.deepEqual([m.key.realm, m.key.sourceId, m.key.eventId, m.key.field], ['test', 'synthetic-ingest', 'synthetic-telemetry-001', 'temperature']);
  const admitted = await s.boundary.admitForReplay(delivery());
  assert.equal(admitted.status, 'admitted');
  assert.deepEqual(admitted.fields, ['temperature']);
});

test('P19 full synthetic E2E quarantined: verified deliveries that fail inside the pipeline are quarantined there', async () => {
  const noInbox = await boundarySetup();
  const r = await noInbox.boundary.deliver(delivery({ obs: { rawPersistedAt: null } }));
  assert.deepEqual([r.results[0].result.status, r.results[0].result.reasonCode, r.results[0].result.quarantineStatus], ['quarantined', 'unresolved-persisted-at', 'BLOCKED']);
  const unknownDevice = await boundarySetup({ mappingMode: { kind: 'ok', key: 'synthetic-device-404' } });
  const u = await unknownDevice.boundary.deliver(delivery({ obs: { mqttClientId: 'synthetic-device-404' }, env: { clientid: 'synthetic-device-404' } }));
  assert.equal(u.results[0].result.status, 'quarantined');
  assert.equal(unknownDevice.persistence.measurements.size, 0);
});

test('P20 metrics and alerts use closed low-cardinality labels: no principal, client id, topic, eventId or connection reference', async () => {
  const s = await boundarySetup();
  await s.boundary.deliver(delivery());
  await s.boundary.deliver(delivery({ env: { clientid: 'synthetic-device-002', eventId: 'synthetic-telemetry-003' } }));
  await s.boundary.deliver(delivery({ obs: { authenticatedPrincipalReference: 'principal:x' } }));
  const text = JSON.stringify([s.metrics.events, s.alerts.events]);
  for (const id of [PRINCIPAL, 'principal:x', KEY, 'synthetic-device-002', 'synthetic/agro', 'synthetic-telemetry', 'conn:synthetic']) assert.equal(text.includes(id), false, id);
  for (const e of s.metrics.events) assert.ok(Object.keys(e.labels).every(k => ['stage', 'reasonCode', 'retryClass', 'outcome'].includes(k)));
  assert.ok(s.metrics.events.some(e => e.name === 'mqtt_boundary_rejected_total' && e.labels.reasonCode === 'technical-identity-mismatch'));
});

test('Placeholders: a boundary assembled only with placeholders accepts NOTHING; readiness reports BLOCKED; productionReady false', async () => {
  const p = createBlockingMqttBoundaryPlaceholders();
  const s = await boundarySetup({ extra: { ...p } });
  assert.equal((await s.boundary.deliver(delivery())).reasonCode, 'boundary-not-configured');
  const withConfig = await boundarySetup({ extra: { brokerProvenanceVerifier: p.brokerProvenanceVerifier, brokerIdentityMapping: p.brokerIdentityMapping } });
  assert.equal((await withConfig.boundary.deliver(delivery())).reasonCode, 'broker-provenance-unverified');
  const ready = describeMqttBoundaryReadiness(s.deps);
  assert.deepEqual(['brokerProvenanceVerifier', 'brokerIdentityMapping', 'payloadLimits', 'boundaryConfig'].map(n => ready.dependencies[n]), Array(4).fill('BLOCKED'));
  assert.equal(ready.boundaryTestReady, false);
  const ok = describeMqttBoundaryReadiness((await boundarySetup()).deps);
  assert.deepEqual([ok.boundaryTestReady, ok.productionReady], [true, false]);
  assert.equal(describeMqttBoundaryReadiness({}).dependencies.payloadLimits, 'MISSING');
  assert.ok(ok.limitations.includes('NO_BROKER_CONNECTION') && ok.limitations.includes('PROVENANCE_NOT_REVALIDATED_BEFORE_PERSISTENCE'));
});

test('The boundary owns provenance: an injected pipeline verifier is refused; the pipeline accepts only boundary-issued evidence', async () => {
  const s = await boundarySetup();
  assert.throws(() => createMqttIngestionBoundary({ ...s.deps, provenanceVerifier: { verify: () => ({}) } }), /owns provenance/);
  for (const name of ['brokerProvenanceVerifier', 'brokerIdentityMapping', 'payloadLimits', 'boundaryConfig'])
    assert.throws(() => createMqttIngestionBoundary({ ...s.deps, [name]: undefined }), new RegExp(name));
  // Operator replay with forged evidence is refused by the pipeline (the evidence was not issued by the boundary).
  await s.boundary.deliver(delivery({ obs: { rawPersistedAt: null } }));
  const [row] = [...s.quarantine.rows.values()];
  const r = await s.boundary.operations.replay({ token: 'tok-admin' }, { quarantineId: row.quarantineId, expectedVersion: row.version, protectedDocument: {}, provenanceEvidence: { syntheticTestOnly: true }, field: 'temperature' });
  assert.equal(r.status, 'denied', 'BLOCKED entries are not replayable and forged evidence is never accepted');
});
