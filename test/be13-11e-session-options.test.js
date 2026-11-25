// BE13-11E — TEST_ONLY session/subscription options of the lab adapter (OFFLINE, fake MQTT client). Defaults must stay the BE13-11D ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createEmqxMqttBrokerAdapter, LAB_VERIFIED_TOPIC } from '../dist/src/adapters/emqx-mqtt-broker.adapter.js';
import { decideBrokerAck } from '../dist/src/iot/broker-adapter.contracts.js';

const PW = 'labpw-' + 'c0ffee1234567890';
const fake = () => { const created = []; return { created, factory: (url, options) => { const c = new EventEmitter(); c.options = options; c.subs = []; c.subscribe = (t, o, cb) => { c.subs.push({ t, o }); cb(null, [{ qos: o.qos }]); };
  c.end = (f, o, cb) => { (typeof cb === 'function' ? cb : o)?.(); }; created.push(c); setImmediate(() => c.emit('connect', {})); return c; } }; };
const make = (f, extra = {}) => createEmqxMqttBrokerAdapter({ brokerUrl: 'mqtt://127.0.0.1:28003', clientId: 'lab-consumer-x', username: 'lab-consumer', password: PW, mqttFactory: f.factory, ...extra });
const handler = async d => decideBrokerAck(d.brokerObserved.qos, { status: 'persisted' });

test('S01 defaults are unchanged: persistent session, verified topic, no receiveMaximum override, not closed', async () => {
  const f = fake(), a = make(f); await a.start(handler);
  const o = f.created[0].options;
  assert.deepEqual([o.clean, o.protocolVersion, o.reconnectPeriod, Object.hasOwn(o.properties, 'receiveMaximum'), f.created[0].subs[0].t, a.closed()], [false, 5, 0, false, LAB_VERIFIED_TOPIC, false]);
});

test('S02 TEST_ONLY profiles: clean start, shared-subscription filter and receiveMaximum are passed through; MQTT 5 and manual ACK stay forced', async () => {
  const f = fake(), a = make(f, { clean: true, receiveMaximum: 10, subscribeTopic: '$share/lab/' + LAB_VERIFIED_TOPIC, sessionExpirySeconds: 30 }); await a.start(handler);
  const c = f.created[0];
  assert.deepEqual([c.options.clean, c.options.properties.receiveMaximum, c.options.properties.sessionExpiryInterval, c.subs[0].t, c.options.protocolVersion, typeof c.options.customHandleAcks],
    [true, 10, 30, '$share/lab/' + LAB_VERIFIED_TOPIC, 5, 'function']);
});

test('S03 closed() reflects the connection state so the lab supervisor can restart a NEW adapter (never a silent reuse)', async () => {
  const f = fake(), a = make(f); await a.start(handler);
  assert.equal(a.closed(), false);
  f.created[0].emit('close');
  assert.equal(a.closed(), true);
  const first = a.connectionReference(); await a.stop();
  const b = make(f); await b.start(handler);
  assert.notEqual(b.connectionReference(), first);
  assert.equal(b.closed(), false);
});

test('S04 the options cannot weaken the guards: a non-loopback broker or a non-lab credential is still refused', () => {
  const f = fake();
  assert.throws(() => make(f, { brokerUrl: 'mqtt://emqx.example.com:1883', clean: true }), /NOT_LOOPBACK/);
  assert.throws(() => make(f, { password: 'real-looking-password-123', receiveMaximum: 5 }), /NOT_TEST_ONLY/);
  assert.equal(f.created.length, 0);
});
