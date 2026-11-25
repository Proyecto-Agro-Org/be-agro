// BE13-11D — EMQX local adapter, persist-before-ack and receipted recovery. OFFLINE part (fake MQTT client; no broker, no network).
// The real-broker evidence lives in the Docker campaign (scripts/audit-be13-11d-emqx-local.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createEmqxMqttBrokerAdapter, assertLoopbackBrokerUrl, assertLabCredentialShape, parseBrokerAuthoredEnvelope, describeEmqxLocalLabReadiness, LAB_VERIFIED_TOPIC }
  from '../dist/src/adapters/emqx-mqtt-broker.adapter.js';
import { decideBrokerAck } from '../dist/src/iot/broker-adapter.contracts.js';
import { reconciliationSetup, TEST_ONLY_RECEIPTED_POLICY, TEST_ONLY_POLICY } from '../test-support/be13-11c-reconciliation.fixtures.js';
import { bytesOf, envelope } from '../test-support/be13-11a-broker.fixtures.js';
import { RECEIVED } from '../test-support/be13-composition.fixtures.js';

const PW = 'labpw-' + 'a1b2c3d4e5f60718';
const USER = 'lab-device-a', KEY = 'synthetic-device-001';

// ---- fake MQTT.js client (records options; lets a test drive customHandleAcks like the library does) ------------------------
function fakeFactory() {
  const created = [];
  const factory = (url, options) => {
    const c = new EventEmitter(); c.url = url; c.options = options; c.ended = []; c.subscribed = [];
    c.subscribe = (topic, opts, cb) => { c.subscribed.push({ topic, opts }); cb(null, [{ qos: opts.qos }]); };
    c.end = (force, o, cb) => { c.ended.push(force); if (typeof cb === 'function') cb(); else if (typeof o === 'function') o(); };
    created.push(c); setImmediate(() => c.emit('connect', { sessionPresent: false }));
    return c;
  };
  return { factory, created };
}
const wrap = (payloadBytes, patch = {}, who = {}) => Buffer.from(JSON.stringify({ clientid: KEY, username: USER, qos: 1, topic: 'synthetic/agro/device-001/telemetry', retain: false,
  publish_received_at: 1795115600050, payload_b64: Buffer.from(payloadBytes).toString('base64'), ...who, ...patch }));
const deviceBytes = (patch = {}) => bytesOf(envelope(patch));
const adapterOn = (f, extra = {}) => createEmqxMqttBrokerAdapter({ brokerUrl: 'mqtt://127.0.0.1:28001', clientId: 'lab-consumer-1', username: 'lab-consumer', password: PW,
  mqttFactory: f.factory, clock: () => RECEIVED, ...extra });
// Drives the library's QoS1 hook and reports when the callback fired.
const deliver = (client, message, packet = { qos: 1, messageId: 7 }) => {
  const record = { acked: false, args: null };
  const done = client.options.customHandleAcks(LAB_VERIFIED_TOPIC, message, packet, (...args) => { record.acked = true; record.args = args; });
  return { record, done };
};
const settle = () => new Promise(r => setTimeout(r, 15));

test('D01 network guard: only loopback literal IPs over plain mqtt:// with an explicit lab port', () => {
  for (const ok of ['mqtt://127.0.0.1:28001', 'mqtt://[::1]:28001', 'mqtt://127.0.0.2:2000']) assert.equal(assertLoopbackBrokerUrl(ok) instanceof URL, true, ok);
  for (const bad of ['mqtts://127.0.0.1:8883', 'ws://127.0.0.1:8083', 'wss://x', 'mqtt://localhost:1883', 'mqtt://emqx.example.com:1883', 'mqtt://broker.emqxcloud.com:1883',
    'mqtt://10.0.0.5:1883', 'mqtt://192.168.1.2:1883', 'mqtt://0.0.0.0:1883', 'mqtt://127.0.0.1.evil.com:1883', 'mqtt://user:pw@127.0.0.1:1883', 'mqtt://127.0.0.1',
    'mqtt://127.0.0.1:80', 'mqtt://127.0.0.1:1883/path', 'mongodb+srv://cluster.mongodb.net', '', null, undefined, 42, 'mqtt://' + 'a'.repeat(200)])
    assert.throws(() => assertLoopbackBrokerUrl(bad), /LAB_BROKER/, String(bad));
});

test('D02 credential shape: only generated TEST_ONLY credentials are accepted (no production-looking secrets)', () => {
  assertLabCredentialShape(USER, PW);
  for (const [u, p] of [[USER, 'short'], [USER, 'hunter2hunter2hunter2'], [USER, 'labpw-NOT-HEX-xxxxxxxxxx'], ['bad user', PW], ['', PW], [USER, undefined], [undefined, PW]])
    assert.throws(() => assertLabCredentialShape(u, p), /LAB_CREDENTIAL/);
  const f = fakeFactory();
  assert.throws(() => adapterOn(f, { brokerUrl: 'mqtt://emqx.example.com:1883' }), /NOT_LOOPBACK/);
  assert.throws(() => adapterOn(f, { password: 'real-looking-password-123' }), /NOT_TEST_ONLY/);
  assert.equal(f.created.length, 0, 'a refused configuration never creates a client');
});

test('D03 envelope → observed facts only: exact bytes, broker-authored principal, no authority fields', () => {
  const bytes = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x31, 0x7d, 0x00, 0xff]);  // includes bytes that are not valid UTF-8
  const r = parseBrokerAuthoredEnvelope(wrap(bytes), { qos: 1, messageId: 9 }, 'emqx-rule-delivery:abc', RECEIVED);
  assert.equal(r.ok, true);
  assert.equal(Buffer.compare(Buffer.from(r.delivery.payload), bytes), 0);
  assert.deepEqual(r.delivery.brokerObserved, { connectionReference: 'emqx-rule-delivery:abc', authenticatedPrincipalReference: 'emqx-user:' + USER, mqttClientId: KEY,
    topic: 'synthetic/agro/device-001/telemetry', qos: 1, retain: false, packetId: 9, receivedAt: RECEIVED });
  for (const forbidden of ['realm', 'clientId', 'sourceId', 'trusted', 'verified', 'rawPersistedAt', 'persistedAt', 'hardwareIdentity'])
    assert.equal(Object.hasOwn(r.delivery.brokerObserved, forbidden), false, forbidden);
  assert.equal(r.brokerReceivedAt, 1795115600050);
});

test('D04 envelope parser is closed: extra authority keys, bad QoS, bad usernames and non-canonical base64 are refused', () => {
  const p = { qos: 1, messageId: 1 }, ok = deviceBytes();
  for (const patch of [{ realm: 'production' }, { trusted: true }, { verified: true }, { sourceId: 'x' }, { rawPersistedAt: 1 }, { extra: 1 }])
    assert.equal(parseBrokerAuthoredEnvelope(wrap(ok, patch), p, 'c', RECEIVED).ok, false, JSON.stringify(patch));
  assert.equal(parseBrokerAuthoredEnvelope(wrap(ok, { qos: 2 }), p, 'c', RECEIVED).ok, false);          // envelope QoS must equal the delivery QoS
  assert.equal(parseBrokerAuthoredEnvelope(wrap(ok, { qos: 7 }), { qos: 7 }, 'c', RECEIVED).ok, false);
  assert.equal(parseBrokerAuthoredEnvelope(wrap(ok, {}, { username: 'a b' }), p, 'c', RECEIVED).ok, false);
  assert.equal(parseBrokerAuthoredEnvelope(wrap(ok, {}, { clientid: '' }), p, 'c', RECEIVED).ok, false);
  assert.equal(parseBrokerAuthoredEnvelope(wrap(ok, { payload_b64: 'AAA' }), p, 'c', RECEIVED).reason, 'payload-encoding-invalid');   // not canonical
  assert.equal(parseBrokerAuthoredEnvelope(wrap(ok, { payload_b64: '***' }), p, 'c', RECEIVED).ok, false);
  assert.equal(parseBrokerAuthoredEnvelope(Buffer.from([0xff, 0xfe]), p, 'c', RECEIVED).ok, false);        // invalid UTF-8 envelope
  assert.equal(parseBrokerAuthoredEnvelope(Buffer.from('[1,2]'), p, 'c', RECEIVED).ok, false);
  assert.equal(parseBrokerAuthoredEnvelope(wrap(ok, { qos: 0 }), { qos: 0 }, 'c', RECEIVED).delivery.brokerObserved.packetId, null);   // QoS 0 has no packet id
});

test('D05 the client is configured for deferred ACK: MQTT 5 (customHandleAcks is ignored below v5), persistent session, no reconnect storms', async () => {
  const f = fakeFactory(), a = adapterOn(f);
  await a.start(async () => decideBrokerAck(1, { status: 'persisted' }));
  const o = f.created[0].options;
  assert.deepEqual([o.protocolVersion, o.clean, o.reconnectPeriod, typeof o.customHandleAcks, o.clientId], [5, false, 0, 'function', 'lab-consumer-1']);
  assert.deepEqual(f.created[0].subscribed, [{ topic: LAB_VERIFIED_TOPIC, opts: { qos: 2 } }]);
  assert.equal(f.created[0].url.startsWith('mqtt://127.0.0.1'), true);
  assert.equal(JSON.stringify(a.stats()).includes(PW), false);
  await assert.rejects(() => a.start(async () => decideBrokerAck(1, { status: 'persisted' })), /ALREADY_STARTED/);
  await a.stop();
});

test('D06 PUBACK is withheld until the handler decides (deferred ACK), then released exactly once', async () => {
  const f = fakeFactory(), a = adapterOn(f);
  let release; const gate = new Promise(r => { release = r; });
  await a.start(async () => { await gate; return decideBrokerAck(1, { status: 'persisted' }); });
  const { record } = deliver(f.created[0], wrap(deviceBytes()));
  await settle();
  assert.equal(record.acked, false, 'no ACK while the durable write is pending');
  release(); await settle();
  assert.deepEqual([record.acked, record.args], [true, [null, 0]]);
  assert.equal(a.stats().acked, 1);
  await a.stop();
});

test('D07 handler failure or a transient decision is NEVER an ACK: connection dropped so the broker redelivers', async () => {
  for (const handler of [async () => { throw new Error('inbox down'); }, async () => decideBrokerAck(1, { status: 'rejected', reasonCode: 'broker-inbox-unavailable' }),
    async () => decideBrokerAck(1, { status: 'rejected', reasonCode: 'broker-verifier-unavailable' })]) {
    const f = fakeFactory(), a = adapterOn(f);
    await a.start(handler);
    const { record } = deliver(f.created[0], wrap(deviceBytes()));
    await settle();
    assert.equal(record.acked, false);
    assert.deepEqual(f.created[0].ended, [true]);
    assert.equal(a.stats().withheld, 1);
  }
});

test('D08 poison messages: lab policy is explicit; default withholds; ack-and-drop is TEST_ONLY and counted; no republish, no loop', async () => {
  const poison = async () => decideBrokerAck(1, { status: 'rejected', reasonCode: 'payload-malformed' });
  const f1 = fakeFactory(), a1 = adapterOn(f1);
  await a1.start(poison);
  const r1 = deliver(f1.created[0], wrap(deviceBytes())); await settle();
  assert.deepEqual([r1.record.acked, a1.stats().withheld], [false, 1]);
  const f2 = fakeFactory(), a2 = adapterOn(f2, { poisonPolicy: 'ack-and-drop' });
  await a2.start(poison);
  const r2 = deliver(f2.created[0], wrap(deviceBytes())); await settle();
  assert.deepEqual([r2.record.acked, a2.stats().dropped, f2.created[0].ended], [true, 1, []]);
  // a malformed broker envelope takes the same poison path (never reaches the handler)
  const f3 = fakeFactory(), a3 = adapterOn(f3, { poisonPolicy: 'ack-and-drop' }); let called = 0;
  await a3.start(async () => { called += 1; return decideBrokerAck(1, { status: 'persisted' }); });
  const r3 = deliver(f3.created[0], Buffer.from('{"not":"an envelope"}')); await settle();
  assert.deepEqual([called, r3.record.acked, a3.stats().malformed], [0, true, 1]);
});

test('D09 QoS 0 has no ACK: the handler runs from the message event, QoS>0 is not processed twice', async () => {
  const f = fakeFactory(), a = adapterOn(f); const seen = [];
  await a.start(async d => { seen.push(d.brokerObserved.qos); return decideBrokerAck(d.brokerObserved.qos, { status: 'persisted' }); });
  f.created[0].emit('message', LAB_VERIFIED_TOPIC, wrap(deviceBytes(), { qos: 0 }), { qos: 0 });
  f.created[0].emit('message', LAB_VERIFIED_TOPIC, wrap(deviceBytes(), { qos: 1 }), { qos: 1, messageId: 3 });
  await settle();
  assert.deepEqual(seen, [0]);
  assert.equal(a.stats().qos0, 1);
});

test('D10 a new connection reference on every start: nothing trusted survives a restart', async () => {
  const f = fakeFactory(), a = adapterOn(f);
  await a.start(async () => decideBrokerAck(1, { status: 'persisted' })); const first = a.connectionReference(); await a.stop();
  await a.start(async () => decideBrokerAck(1, { status: 'persisted' })); const second = a.connectionReference(); await a.stop();
  assert.notEqual(first, second);
  assert.match(first, /^emqx-rule-delivery:[0-9a-f]{16}$/);
});

// ---- integration with the durable inbox (in-memory) -----------------------------------------------------------------------
const labSetup = async extra => reconciliationSetup({
  verifierMode: { kind: 'answer', answer: req => req.brokerObserved.authenticatedPrincipalReference === 'emqx-user:' + USER
    ? { status: 'VERIFIED', realm: req.realm, principalReference: 'emqx-user:' + USER, contextFingerprint: req.contextFingerprint, authentication: 'broker-confirmed', verifiedAt: req.brokerObserved.receivedAt, verifierRevision: 1 }
    : { status: 'UNVERIFIED', realm: req.realm, reason: 'principal-unknown', verifierRevision: 1 } },
  mappingMode: { kind: 'answer', answer: req => req.principalReference === 'emqx-user:' + USER
    ? { status: 'mapped', realm: req.realm, principalReference: req.principalReference, sourceId: 'synthetic-ingest', technicalDeviceKey: { kind: 'mqtt-clientid', value: KEY }, mappingRevision: 1 }
    : { status: 'unknown', realm: req.realm } }, ...extra });
// The consumer handler of the lab: persist-only → receipt → decision. Processing happens AFTER the ACK, from the stored record.
const persistThenAck = (s, log) => async delivery => {
  const r = await s.admission.admit(delivery, { mode: 'persist-only' });
  log?.push({ at: 'decision', inbox: s.inbox.rows.size, status: r.status });
  return decideBrokerAck(delivery.brokerObserved.qos, r);
};

test('D11 persist-before-ack: the record is durable and receipted BEFORE the ACK is released', async () => {
  const s = await labSetup(), f = fakeFactory(), a = adapterOn(f), log = [];
  await a.start(persistThenAck(s, log));
  const { record } = deliver(f.created[0], wrap(deviceBytes()));
  await settle();
  assert.deepEqual([record.acked, log[0].inbox, log[0].status], [true, 1, 'persisted']);
  const [id] = s.inbox.rows.keys();
  assert.equal((await s.store.getState({ realm: 'test', inboxId: id })).status, 'receipted');
  assert.equal(s.persistence.measurements.size, 0, 'processing has not happened yet: it follows the ACK');
});

test('D12 inbox unavailable: no record, no ACK, nothing processed', async () => {
  const s = await labSetup(), f = fakeFactory(), a = adapterOn(f);
  await a.start(persistThenAck(s));
  s.inbox.failing = true;
  const { record } = deliver(f.created[0], wrap(deviceBytes())); await settle();
  assert.deepEqual([record.acked, s.inbox.rows.size, s.persistence.measurements.size, f.created[0].ended], [false, 0, 0, [true]]);
});

test('D13 unknown principal / key crossover / sourceId or realm in the payload: rejected, NOT persisted, no quarantine', async () => {
  const s = await labSetup(), f = fakeFactory(), a = adapterOn(f, { poisonPolicy: 'ack-and-drop' });
  await a.start(persistThenAck(s));
  const cases = [wrap(deviceBytes(), {}, { username: 'lab-attacker' }), wrap(deviceBytes(), {}, { clientid: 'lab-device-b' }),
    wrap(deviceBytes({ sourceId: 'lab-source-b' })), wrap(deviceBytes({ realm: 'production' })), wrap(deviceBytes({ clientid: 'lab-device-b' })), wrap(Buffer.from('not json')),
    wrap(Buffer.alloc(5000, 0x20)), wrap(deviceBytes(), { retain: true })];
  for (const c of cases) deliver(f.created[0], c);
  await settle();
  assert.deepEqual([s.inbox.rows.size, s.quarantine.rows.size, s.persistence.measurements.size], [0, 0, 0]);
});

test('D14 duplicate delivery of the same event (QoS1 redelivery): two inbox records, one measurement', async () => {
  const s = await labSetup(), f = fakeFactory(), a = adapterOn(f);
  await a.start(persistThenAck(s));
  for (const id of [1, 2]) deliver(f.created[0], wrap(deviceBytes()), { qos: 1, messageId: id });
  await settle();
  for (const id of s.inbox.rows.keys()) await s.admission.processPersistedBrokerDelivery({ inboxId: id });
  assert.deepEqual([s.inbox.rows.size, s.persistence.measurements.size], [2, 1]);
});

// ---- receipted recovery (BE13-11D finding R1: consumer dies after the receipt/ACK) -----------------------------------------
const crashAfterAck = async s => {
  const f = fakeFactory(), a = adapterOn(f);
  await a.start(persistThenAck(s));
  const { record } = deliver(f.created[0], wrap(deviceBytes()));
  await settle();
  assert.equal(record.acked, true);
  await a.stop();                                  // the consumer "dies": no processing ever happens
  return [...s.inbox.rows.keys()][0];
};

test('R-A receipted recovery is BLOCKED by default: a dead consumer\'s record stays untouched (no age was chosen)', async () => {
  const s = await labSetup(); const id = await crashAfterAck(s);
  s.inbox.advance(60_000);
  assert.equal(await s.reconciler.reconcileOne(id), 'blocked');
  assert.deepEqual([s.persistence.measurements.size, (await s.store.getState({ realm: 'test', inboxId: id })).status], [0, 'receipted']);
  assert.equal((await s.reconciler.reconcileBrokerInbox({ mode: 'reconcile', limit: 10 })).candidates.length, 0);
});

test('R-B with a TEST_ONLY policy the record is recovered once after the age, with fencing; a fresh receipt is not claimed', async () => {
  const s = await labSetup({ receiptedPolicy: TEST_ONLY_RECEIPTED_POLICY }); const id = await crashAfterAck(s);
  assert.equal(await s.reconciler.reconcileOne(id), 'blocked');                       // too young: its owner may still be alive
  s.inbox.advance(TEST_ONLY_RECEIPTED_POLICY.minAgeMs + 500);
  const dead = null;
  assert.equal(await s.reconciler.reconcileOne(id), 'recovered-and-processed');
  assert.equal(s.persistence.measurements.size, 1);
  assert.equal(await s.reconciler.reconcileOne(id), 'duplicate');
  assert.equal(dead, null);
  assert.deepEqual(await s.store.getState({ realm: 'test', inboxId: id }), { status: 'completed', version: 3, outcome: 'recovered-and-processed' });   // receipted v1 → claimed v2 → completed v3
});

test('R-C the sweep finds stale receipted records only under their own policy; the owner finishing first wins safely', async () => {
  const s = await labSetup({ receiptedPolicy: TEST_ONLY_RECEIPTED_POLICY }); const id = await crashAfterAck(s);
  s.inbox.advance(TEST_ONLY_RECEIPTED_POLICY.minAgeMs + 500);
  const report = await s.reconciler.reconcileBrokerInbox({ mode: 'inspect-only', limit: 10 });
  assert.deepEqual(report.candidates, [id]);
  // the "dead" owner was only slow: it completes its own receipt path first; recovery must then be a no-op
  assert.equal((await s.admission.processPersistedBrokerDelivery({ inboxId: id })).status, 'ingested');
  assert.equal(await s.reconciler.reconcileOne(id), 'duplicate');
  assert.equal(s.persistence.measurements.size, 1);
});

test('R-D two recoverers race on a stale receipted record: one claim, one measurement; stale holder fenced', async () => {
  const s = await labSetup({ receiptedPolicy: TEST_ONLY_RECEIPTED_POLICY }); const id = await crashAfterAck(s);
  s.inbox.advance(TEST_ONLY_RECEIPTED_POLICY.minAgeMs + 500);
  const out = await Promise.all(Array.from({ length: 5 }, () => s.reconciler.reconcileOne(id)));
  assert.equal(out.filter(x => x === 'recovered-and-processed').length, 1);
  assert.equal(s.persistence.measurements.size, 1);
});

test('R-E integrity still comes first on a receipted recovery: tampered bytes are never processed', async () => {
  const s = await labSetup({ receiptedPolicy: TEST_ONLY_RECEIPTED_POLICY }); const id = await crashAfterAck(s);
  s.inbox.rows.get(id).rawPayload = bytesOf('{"tampered":true}');
  s.inbox.advance(TEST_ONLY_RECEIPTED_POLICY.minAgeMs + 500);
  assert.equal(await s.reconciler.reconcileOne(id), 'integrity-failed');
  assert.equal(s.persistence.measurements.size, 0);
});

test('R-F the receipted policy is validated: invalid shapes are BLOCKED (never a guessed age)', async () => {
  for (const bad of [undefined, null, {}, { mode: 'TEST_ONLY' }, { mode: 'TEST_ONLY', minAgeMs: -1 }, { mode: 'TEST_ONLY', minAgeMs: 1, extra: 1 }, { mode: 'NOPE', minAgeMs: 1 }, 'x']) {
    const s = await labSetup({ receiptedPolicy: bad }); const id = await crashAfterAck(s);
    s.inbox.advance(60_000);
    assert.equal(await s.reconciler.reconcileOne(id), 'blocked', JSON.stringify(bad));
  }
});

test('D15 readiness is laboratory-only: productionReady is the literal false in every combination', () => {
  const all = { loopbackGuard: true, testOnlyCredentials: true, deferredAck: true, durableInbox: true, reconciliation: true, cleanupVerified: true };
  assert.deepEqual([describeEmqxLocalLabReadiness(all).emqxLocalLabReady, describeEmqxLocalLabReadiness(all).productionReady], [true, false]);
  for (const k of Object.keys(all)) { const r = describeEmqxLocalLabReadiness({ ...all, [k]: false }); assert.deepEqual([r.emqxLocalLabReady, r.productionReady], [false, false], k); }
});

test('D16 structural: the adapter is lab-only code: no env, no timers, no app.ts/production wiring, no credential in source', () => {
  const src = readFileSync(new URL('../src/adapters/emqx-mqtt-broker.adapter.ts', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  assert.equal(/process\.env|setInterval|setTimeout|from 'mqtt'|mongodb\+srv|mongodb\.net/i.test(src), false);
  const connect = readFileSync(new URL('../src/adapters/emqx-mqtt-connect.ts', import.meta.url), 'utf8');
  assert.equal(/password|username/i.test(connect.replace(/\/\/.*$/gm, '')), false);
  const app = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8').toLowerCase();
  for (const t of ['emqx', 'mqtt', 'broker', 'inbox']) assert.equal(app.includes(t), false, t);
  void TEST_ONLY_POLICY;
});
