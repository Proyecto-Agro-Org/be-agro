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

// ---- BE13-11E finding F-E1: post-ACK processing must never mark a record `completed` when nothing was materialized.
import { reconciliationSetup, TEST_ONLY_RECEIPTED_POLICY } from '../test-support/be13-11c-reconciliation.fixtures.js';
import { delivery } from '../test-support/be13-11a-broker.fixtures.js';
import { createInMemoryPersistence, createInMemoryQuarantine } from '../test-support/be13-composition.fixtures.js';

test('S05 F-E1: a result that is `uncertain` (neither measurement nor quarantine could be recorded) leaves the record RECEIPTED, so recovery retries it', async () => {
  const down = new Error('dependency down'); let failing = false;
  const inner = createInMemoryPersistence(), innerQuarantine = await createInMemoryQuarantine();
  const persistence = { ...inner, async persistAtomically(...args) { if (failing) throw down; return inner.persistAtomically(...args); } };
  const quarantine = { ...innerQuarantine, async record(...args) { if (failing) throw down; return innerQuarantine.record(...args); } };
  const s = await reconciliationSetup({ receiptedPolicy: TEST_ONLY_RECEIPTED_POLICY, persistence, extra: { quarantine } });
  const r = await s.admission.admit(delivery(), { mode: 'persist-only' });
  assert.equal(r.status, 'persisted');
  failing = true;                                                          // the measurement cannot be written AND neither can the quarantine entry
  const out = await s.admission.processPersistedBrokerDelivery({ inboxId: r.receipt.inboxId });
  assert.equal(out.results[0].result.status, 'uncertain');
  assert.equal((await s.store.getState({ realm: 'test', inboxId: r.receipt.inboxId })).status, 'receipted', 'NOT completed: nothing was materialized');
  failing = false;                                                         // dependencies recover
  s.inbox.advance(TEST_ONLY_RECEIPTED_POLICY.minAgeMs + 500);
  assert.equal(await s.reconciler.reconcileOne(r.receipt.inboxId), 'recovered-and-processed');
  assert.equal(inner.measurements.size, 1);
});

test('S06 a rejected post-ACK load (inbox read unavailable) leaves the record RECEIPTED and recoverable', async () => {
  const s = await reconciliationSetup({ receiptedPolicy: TEST_ONLY_RECEIPTED_POLICY });
  const r = await s.admission.admit(delivery(), { mode: 'persist-only' });
  s.inbox.failing = true;
  const out = await s.admission.processPersistedBrokerDelivery({ inboxId: r.receipt.inboxId });
  assert.equal(out.reasonCode, 'broker-inbox-unavailable');
  s.inbox.failing = false;
  assert.equal((await s.store.getState({ realm: 'test', inboxId: r.receipt.inboxId })).status, 'receipted');
  s.inbox.advance(TEST_ONLY_RECEIPTED_POLICY.minAgeMs + 500);
  assert.equal(await s.reconciler.reconcileOne(r.receipt.inboxId), 'recovered-and-processed');
  assert.equal(s.persistence.measurements.size, 1);
});
