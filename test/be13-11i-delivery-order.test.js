// BE13-11I — offline guards for the D13 -> D13b delivery-order analysis (no broker, no Docker).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyEventualDelivery, classifyOutcome, deliveryTimeline, eventIdFromEnvelope, parseSessionResponses, scenarioOfEvent, splitStaleOwn } from '../dist/scripts/be13-11i/delivery-order.js';

const envelope = eventId => Buffer.from(JSON.stringify({ payload_b64: Buffer.from(JSON.stringify({ eventId })).toString('base64') }));

test('I1: the envelope decoder returns the inner eventId and never throws on garbage', () => {
  assert.equal(eventIdFromEnvelope(envelope('e11f-d13-3')), 'e11f-d13-3');
  assert.equal(eventIdFromEnvelope(Buffer.from('not json')), '');
  assert.equal(scenarioOfEvent('e11f-d13-3'), 'd13');
  assert.equal(scenarioOfEvent('e11f-d13b-59'), 'd13b');
  assert.equal(scenarioOfEvent('whatever'), null);
});

test('I2: the session snapshot parses the COMPLETE body (a body far longer than 900 chars) and marks absent fields NOT_EXPOSED', () => {
  const big = JSON.stringify({ clientid: 'c', connected: true, inflight_cnt: 7, mqueue_len: 0, filler: 'x'.repeat(5000), tail: { last: 1 } });
  assert.ok(big.length > 900);
  const r = parseSessionResponses({ client: { status: 200, body: big }, inflight: { status: 200, body: JSON.stringify({ data: [{ msgid: 'a' }, { msgid: 'b' }] }) }, mqueue: { status: 404, body: '{}' } });
  const f = n => r.fields.find(x => x.name === n);
  assert.equal(f('inflight_cnt').value, 7); assert.equal(f('inflight_cnt').status, 'OBSERVED');
  assert.equal(f('expiry_interval').status, 'NOT_EXPOSED');
  assert.equal(r.inflightMessages.length, 2);
  assert.equal(r.mqueueMessages, null);                 // 404 -> not exposed, never an empty list
  assert.equal(r.clientHttpStatus, 200);
});

test('I3: stale (another scenario) and own (current cycle) deliveries are never mixed', () => {
  const own = new Set(['e11f-d13b-0', 'e11f-d13b-1']);
  const { own: o, stale } = splitStaleOwn(['e11f-d13-0', 'e11f-d13b-0', 'e11f-d13-0', 'e11f-d13-1'], own);
  assert.deepEqual(o, ['e11f-d13b-0']); assert.deepEqual(stale, ['e11f-d13-0', 'e11f-d13-1']);
});

const pkt = (eventId, t) => ({ t, scn: 'd13b', dup: true, qos: 1, messageId: 1, eventId });

test('I4: delivery order and the stale-drain gap are computed from packet + ACK instants', () => {
  const stale = ['e11f-d13-0', 'e11f-d13-1'], own = new Set(['e11f-d13b-0', 'e11f-d13b-1', 'e11f-d13b-2']);
  const packets = [pkt('e11f-d13-0', 100), pkt('e11f-d13-1', 110), pkt('e11f-d13b-0', 120), pkt('e11f-d13-0', 300), pkt('e11f-d13b-1', 900)];
  const acks = new Map([['e11f-d13-0', 500], ['e11f-d13-1', 510]]);
  const t = deliveryTimeline(packets, own, stale, acks);
  assert.equal(t.staleDrained, true); assert.equal(t.lastStaleAckAt, 510);
  assert.equal(t.firstStaleAt, 100); assert.equal(t.firstOwnAt, 120); assert.equal(t.lastOwnAt, 900);
  assert.equal(t.staleBeforeFirstOwn, 2);
  assert.equal(t.ownDeliveredBeforeStaleDrained, 1); assert.equal(t.ownDeliveredAfterStaleDrained, 1);
  assert.equal(t.ownAfterLastStaleAckGapMs, 390);
});

test('I5: a stale set with an un-ACKed event is not "drained"; no own delivery leaves the gap null', () => {
  const t = deliveryTimeline([pkt('e11f-d13-0', 1)], new Set(['e11f-d13b-0']), ['e11f-d13-0', 'e11f-d13-1'], new Map([['e11f-d13-0', 5]]));
  assert.equal(t.staleDrained, false); assert.equal(t.ownAfterLastStaleAckGapMs, null); assert.equal(t.firstOwnAt, null);
});

test('I6: eventual-delivery classification', () => {
  assert.equal(classifyEventualDelivery(60, 60), 'EVENTUALLY_DELIVERED');
  assert.equal(classifyEventualDelivery(1, 60), 'PARTIAL_EVENTUAL_DELIVERY');
  assert.equal(classifyEventualDelivery(59, 60), 'PARTIAL_EVENTUAL_DELIVERY');
  assert.equal(classifyEventualDelivery(0, 60), 'NOT_EVENTUALLY_DELIVERED');
});

test('I7: outcome classification and the timeout rule', () => {
  const base = { n: 60, staleDelivered: 60, staleDrained: true, timedOut: true };
  assert.equal(classifyOutcome({ ...base, ownDeliveredFinal: 60, ownDeliveredAfterDrain: 59, timedOut: false }), 'STALE_REPLAY_STARVATION_LOCAL');
  assert.equal(classifyOutcome({ ...base, ownDeliveredFinal: 0, ownDeliveredAfterDrain: 0 }), 'SESSION_STATE_LOSS_LOCAL');
  assert.equal(classifyOutcome({ ...base, ownDeliveredFinal: 30, ownDeliveredAfterDrain: 29 }), 'MIXED_SESSION_FAILURE_LOCAL');
  assert.equal(classifyOutcome({ ...base, ownDeliveredFinal: 1, ownDeliveredAfterDrain: 0, timedOut: false }), 'INCONCLUSIVE_LOCAL');   // window not exhausted
  assert.equal(classifyOutcome({ ...base, ownDeliveredFinal: 1, ownDeliveredAfterDrain: 0, staleDrained: false }), 'INCONCLUSIVE_LOCAL');
  assert.equal(classifyOutcome({ ...base, ownDeliveredFinal: 60, ownDeliveredAfterDrain: 60, staleDelivered: 0 }), 'INCONCLUSIVE_LOCAL');   // 60/60 with no stale replay is not this phenomenon
});

test('I8: the 11I harness keeps the historical configuration and only adds observation', () => {
  const src = readFileSync(new URL('../scripts/audit-be13-11f-emqx-durability.ts', import.meta.url), 'utf8');
  assert.match(src, /withLab\(\{ durable: true, flushIntervalMs: 1, writeBufferMaxItems: 1 \}/);
  assert.match(src, /sessionExpirySeconds: 3600/);
  for (const p of ['S0', 'S1', 'S2', 'S3', 'S4', 'S5']) assert.ok(src.includes("deepSnapshot('" + p + "'"), p);
  assert.match(src, /BE13_11I_EXTEND_MS/);
  assert.match(src, /be13-11i-/);
});
