// BE13-11D — adversarial vectors (OFFLINE part: fake MQTT client + in-memory inbox). Vectors that need a real broker are proven in the
// Docker campaign; the mapping is in MATRIZ_BE13_11D_VECTORES.md. TEST_ONLY, synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createEmqxMqttBrokerAdapter, parseBrokerAuthoredEnvelope, LAB_VERIFIED_TOPIC } from '../dist/src/adapters/emqx-mqtt-broker.adapter.js';
import { decideBrokerAck } from '../dist/src/iot/broker-adapter.contracts.js';
import { reconciliationSetup } from '../test-support/be13-11c-reconciliation.fixtures.js';
import { bytesOf, envelope } from '../test-support/be13-11a-broker.fixtures.js';
import { RECEIVED } from '../test-support/be13-composition.fixtures.js';

const PW = 'labpw-' + 'f1e2d3c4b5a69788';
const USER = 'lab-device-a', KEY = 'synthetic-device-001';
const fakeFactory = () => { const created = []; return { created, factory: (url, options) => { const c = new EventEmitter(); c.options = options; c.subscribe = (t, o, cb) => cb(null, [{ qos: o.qos }]); c.end = (f, o, cb) => { (typeof cb === 'function' ? cb : o)?.(); };
  created.push(c); setImmediate(() => c.emit('connect', {})); return c; } }; };
const wrap = (bytes, patch = {}, who = {}) => Buffer.from(JSON.stringify({ clientid: KEY, username: USER, qos: 1, topic: 'synthetic/agro/device-001/telemetry', retain: false, publish_received_at: 1795115600050,
  payload_b64: Buffer.from(bytes).toString('base64'), ...who, ...patch }));
const dev = (patch = {}) => bytesOf(envelope(patch));
const settle = () => new Promise(r => setTimeout(r, 15));
const labSetup = () => reconciliationSetup({
  verifierMode: { kind: 'answer', answer: req => ['emqx-user:' + USER, 'emqx-user:lab-device-b'].includes(req.brokerObserved.authenticatedPrincipalReference)
    ? { status: 'VERIFIED', realm: req.realm, principalReference: req.brokerObserved.authenticatedPrincipalReference, contextFingerprint: req.contextFingerprint, authentication: 'broker-confirmed', verifiedAt: req.brokerObserved.receivedAt, verifierRevision: 1 }
    : { status: 'UNVERIFIED', realm: req.realm, reason: 'principal-unknown', verifierRevision: 1 } },
  mappingMode: { kind: 'answer', answer: req => req.principalReference === 'emqx-user:' + USER
    ? { status: 'mapped', realm: req.realm, principalReference: req.principalReference, sourceId: 'synthetic-ingest', technicalDeviceKey: { kind: 'mqtt-clientid', value: KEY }, mappingRevision: 1 }
    : req.principalReference === 'emqx-user:lab-device-b' ? { status: 'mapped', realm: req.realm, principalReference: req.principalReference, sourceId: 'other-source', technicalDeviceKey: { kind: 'mqtt-clientid', value: 'device-b' }, mappingRevision: 1 }
    : { status: 'unknown', realm: req.realm } } });
async function harness() {
  const s = await labSetup(), f = fakeFactory();
  const a = createEmqxMqttBrokerAdapter({ brokerUrl: 'mqtt://127.0.0.1:28002', clientId: 'lab-consumer-1', username: 'lab-consumer', password: PW, mqttFactory: f.factory, clock: () => RECEIVED, poisonPolicy: 'ack-and-drop' });
  await a.start(async d => decideBrokerAck(d.brokerObserved.qos, await s.admission.admit(d, { mode: 'persist-only' })));
  const send = (message, packet = { qos: 1, messageId: 5 }) => { const r = { acked: false }; f.created.at(-1).options.customHandleAcks(LAB_VERIFIED_TOPIC, message, packet, () => { r.acked = true; }); return r; };
  return { s, a, f, send };
}

test('A01 credential stuffing: a weak or production-looking credential never even builds a client (and the broker refuses the rest: campaign E02)', () => {
  const f = fakeFactory();
  for (const pw of ['password', '123456', 'hunter2hunter2hunter2', 'Prod-Secret-2026!!!!', 'labpw-', 'labpw-XYZ']) assert.throws(() => createEmqxMqttBrokerAdapter({ brokerUrl: 'mqtt://127.0.0.1:28002', clientId: 'c', username: 'lab-consumer', password: pw, mqttFactory: f.factory }), /LAB_CREDENTIAL/);
  assert.equal(f.created.length, 0);
});

test('A02 clientId spoof: the client id is a broker-observed fact, never an identity (technical-identity-mismatch, nothing persisted)', async () => {
  const { s, send } = await harness();
  send(wrap(dev(), {}, { clientid: 'device-b' })); await settle();
  assert.deepEqual([s.inbox.rows.size, s.quarantine.rows.size, s.persistence.measurements.size], [0, 0, 0]);
  assert.ok(s.audit.entries.some(e => e.action === 'technical-identity-mismatch'));
});

test('A03 topic spoof: a topic naming another realm or device changes nothing; the stored realm is the authorized one', async () => {
  const { s, send } = await harness();
  for (const topic of ['synthetic/agro/production/telemetry', 'synthetic/agro/realm=production/x']) send(wrap(dev({ eventId: 'synthetic-telemetry-' + topic.length }), { topic })); await settle();
  assert.ok(s.inbox.rows.size >= 1 && [...s.inbox.rows.values()].every(r => r.realm === 'test'));
});

test('A04/A05 sourceId and realm spoof in the device payload are refused by the closed envelope', async () => {
  const { s, send } = await harness();
  send(wrap(dev({ sourceId: 'attacker-source' }))); send(wrap(dev({ realm: 'production' }))); send(wrap(dev({ payload: { temperature: 1, realm: 'production' }, extra: 1 }))); await settle();
  assert.equal(s.inbox.rows.size, 0);
});

test('A06 retained, A07 invalid UTF-8, A08 nested dangerous keys, A09 oversized: refused before any persistence', async () => {
  const { s, send } = await harness();
  send(wrap(dev(), { retain: true })); send(wrap(Buffer.from([0x7b, 0xff, 0xfe, 0x7d]))); send(wrap(Buffer.from('{"version":1,"payload":{"a":{"prototype":{}}}}'))); send(wrap(Buffer.alloc(5000, 0x20))); await settle();
  assert.deepEqual([s.inbox.rows.size, s.quarantine.rows.size, s.persistence.measurements.size], [0, 0, 0]);
});

test('A10/A11 reconnect and session identity: no identity survives a restart or leaks between deliveries on one connection', async () => {
  const { s, a, send } = await harness();
  const first = a.connectionReference();
  send(wrap(dev({ eventId: 'synthetic-telemetry-a1' }))); send(wrap(dev({ eventId: 'synthetic-telemetry-a2', clientid: 'device-b' }), {}, { username: 'lab-device-b', clientid: 'device-b' })); await settle();
  const principals = new Set([...s.inbox.rows.values()].map(r => r.principalReference));
  assert.deepEqual([...principals].sort(), ['emqx-user:lab-device-a', 'emqx-user:lab-device-b']);  // each delivery carries ITS OWN broker-authenticated principal
  await a.stop(); await a.start(async () => decideBrokerAck(1, { status: 'persisted' }));
  assert.notEqual(a.connectionReference(), first);
});

test('A12 packet id reuse and A13 duplicate event id: ids never identify anything; the business key dedupes', async () => {
  const { s, send } = await harness();
  send(wrap(dev({ eventId: 'synthetic-telemetry-p1' })), { qos: 1, messageId: 9 }); send(wrap(dev({ eventId: 'synthetic-telemetry-p2' })), { qos: 1, messageId: 9 });
  send(wrap(dev({ eventId: 'synthetic-telemetry-p1' })), { qos: 1, messageId: 10 }); await settle();
  for (const id of s.inbox.rows.keys()) await s.admission.processPersistedBrokerDelivery({ inboxId: id });
  assert.deepEqual([s.inbox.rows.size, s.persistence.measurements.size], [3, 2]);
});

test('A17 fake rawPersistedAt and A18 fake authenticated/trusted flags are refused in the broker envelope and in the device payload', async () => {
  const { s, send } = await harness();
  for (const patch of [{ rawPersistedAt: 1 }, { persistedAt: 1 }, { authenticated: true }, { trusted: true }, { verified: true }, { authenticatedPrincipalReference: 'emqx-user:lab-device-a' }])
    assert.equal(parseBrokerAuthoredEnvelope(wrap(dev(), patch), { qos: 1, messageId: 1 }, 'c', RECEIVED).ok, false, JSON.stringify(patch));
  send(wrap(dev({ authenticated: true, trusted: true, rawPersistedAt: 1 }))); await settle();
  assert.equal(s.inbox.rows.size, 0);
});

test('A19 a delivery that is NOT broker-authored (wrong shape, plain device envelope) is poison: never parsed as facts', async () => {
  const { s, a, send } = await harness();
  send(dev()); send(Buffer.from('{}')); send(Buffer.from('null')); await settle();
  assert.deepEqual([s.inbox.rows.size, a.stats().malformed], [0, 3]);
});
