// BE13-11F — LAB guard for durable sessions (OFFLINE, fake MQTT client). A durable-session configuration that cannot recover a broker-side
// session is refused before any client exists. Defaults of the non-durable lab path are pinned so a mutated default is detected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createEmqxMqttBrokerAdapter, assertDurableSessionConfig } from '../dist/src/adapters/emqx-mqtt-broker.adapter.js';
import { decideBrokerAck } from '../dist/src/iot/broker-adapter.contracts.js';

const PW = 'labpw-' + 'abcdef0123456789';
const fake = () => { const created = []; return { created, factory: (url, options) => { const c = new EventEmitter(); c.options = options; c.subscribe = (t, o, cb) => cb(null, [{ qos: o.qos }]);
  c.end = (f, o, cb) => { (typeof cb === 'function' ? cb : o)?.(); }; created.push(c); setImmediate(() => c.emit('connect', {})); return c; } }; };
const make = (f, extra = {}) => createEmqxMqttBrokerAdapter({ brokerUrl: 'mqtt://127.0.0.1:28004', clientId: 'lab-consumer-durable', username: 'lab-consumer', password: PW, mqttFactory: f.factory, ...extra });
const handler = async d => decideBrokerAck(d.brokerObserved.qos, { status: 'persisted' });

test('F01 a valid durable-session configuration is accepted and creates a persistent MQTT5 session', async () => {
  const f = fake(), a = make(f, { durableSession: true, clean: false, sessionExpirySeconds: 3600 }); await a.start(handler);
  const o = f.created[0].options;
  assert.deepEqual([o.clean, o.properties.sessionExpiryInterval, o.protocolVersion, o.clientId], [false, 3600, 5, 'lab-consumer-durable']);
});

test('F02 clean start is refused in durable mode (it discards the broker-side session)', () => {
  const f = fake();
  assert.throws(() => make(f, { durableSession: true, clean: true, sessionExpirySeconds: 3600 }), /CLEAN_START_FORBIDDEN/);
  assert.throws(() => make(f, { durableSession: true, sessionExpirySeconds: 3600 }), /CLEAN_START_FORBIDDEN/);       // clean not stated explicitly
  assert.equal(f.created.length, 0);
});

test('F03 a missing, zero, negative or fractional session expiry is refused (the session would not outlive the connection)', () => {
  const f = fake();
  for (const bad of [undefined, 0, -1, 1.5, '3600', NaN]) assert.throws(() => make(f, { durableSession: true, clean: false, sessionExpirySeconds: bad }), /SESSION_EXPIRY_REQUIRED/, String(bad));
});

test('F04 an unstable client id (random per reconnect / hex suffix / too short) is refused', () => {
  const f = fake();
  for (const id of ['lab-consumer-1a2b3c4d5e6f7a8b', 'ab', '1abc', 'lab consumer', 'c'.repeat(129), 'consumer-' + 'f'.repeat(32)])
    assert.throws(() => assertDurableSessionConfig({ clean: false, sessionExpirySeconds: 60, clientId: id }), /STABLE_CLIENT_ID_REQUIRED/, id);
  assertDurableSessionConfig({ clean: false, sessionExpirySeconds: 60, clientId: 'lab-consumer-durable' });
});

test('F05 the guard is opt-in and the non-durable defaults are pinned (persistent session, expiry 600 s)', async () => {
  const f = fake(), a = make(f); await a.start(handler);               // no durableSession flag: BE13-11D/11E behaviour unchanged
  const o = f.created[0].options;
  assert.deepEqual([o.clean, o.properties.sessionExpiryInterval], [false, 600]);
});
