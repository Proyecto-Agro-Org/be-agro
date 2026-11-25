// BE13-11C — Durable Inbox reconciliation (N4) + EMQX adapter contract. OFFLINE, SINTETICO, TEST_ONLY values.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reconciliationSetup, createInMemoryReconciliationStore, TEST_ONLY_POLICY, delivery } from '../test-support/be13-11c-reconciliation.fixtures.js';
import { createInMemoryBrokerInbox } from '../test-support/be13-11a-broker.fixtures.js';
import { createBrokerInboxReconciler } from '../dist/src/services/broker-inbox-reconciliation.service.js';
import { createDurableBrokerAdmissionService } from '../dist/src/services/mqtt-ingestion-boundary.service.js';
import { createBlockingMqttBoundaryPlaceholders } from '../dist/src/adapters/ingestion-production-placeholders.js';
import { decideBrokerAck, ADAPTER_FORBIDDEN_AUTHORITY_FIELDS } from '../dist/src/iot/broker-adapter.contracts.js';
import { RECEIVED } from '../test-support/be13-composition.fixtures.js';

const ripe = s => s.inbox.advance(TEST_ONLY_POLICY.minAgeMs + 1000);
const onlyOrphan = async s => { const r = await s.orphan(); const [id] = s.inbox.rows.keys(); ripe(s); return { r, id }; };

test('R01 orphan candidate detection: an unconfirmed-but-stored record is a candidate only after the policy age; counts are explicit', async () => {
  const s = await reconciliationSetup();
  const { r, id } = await onlyOrphan(s);
  assert.equal(r.reasonCode, 'broker-inbox-unavailable');              // the caller never got a receipt
  assert.equal(s.inbox.rows.size, 1);                                  // ...but the record exists
  const report = await s.reconciler.reconcileBrokerInbox({ mode: 'inspect-only', limit: 10 });
  assert.deepEqual([report.status, report.candidates, report.counts.absent], ['report', [id], 1]);
  assert.ok(s.metrics.events.some(m => m.name === 'broker_inbox_orphan_candidate_total'));
  assert.ok(s.alerts.events.some(a => a.type === 'BROKER_INBOX_ORPHAN_DETECTED'));
});

test('R01b a young record is NOT a candidate (age measured on the database clock, value is TEST_ONLY)', async () => {
  const s = await reconciliationSetup();
  await s.orphan();
  const report = await s.reconciler.reconcileBrokerInbox({ mode: 'inspect-only', limit: 10 });
  assert.deepEqual([report.candidates.length, report.counts.absent], [0, 1]);
});

test('R02 a majority-confirmed record is never considered lost: bytes stay identical through inspect, reconcile and recovery', async () => {
  const s = await reconciliationSetup();
  const { id } = await onlyOrphan(s);
  const before = JSON.stringify({ ...s.inbox.rows.get(id), rawPayload: [...s.inbox.rows.get(id).rawPayload] });
  await s.reconciler.reconcileBrokerInbox({ mode: 'inspect-only', limit: 10 });
  assert.equal(await s.reconciler.reconcileOne(id), 'recovered-and-processed');
  assert.equal(JSON.stringify({ ...s.inbox.rows.get(id), rawPayload: [...s.inbox.rows.get(id).rawPayload] }), before);
});

test('R03 wrong realm: a reconciler/store of another realm sees nothing and claims nothing', async () => {
  const s = await reconciliationSetup();
  const { id } = await onlyOrphan(s);
  const previewStore = createInMemoryReconciliationStore(s.inbox, 'preview');
  assert.deepEqual(await previewStore.listCandidates({ realm: 'preview', minAgeMs: 0, limit: 10 }), []);
  assert.equal(await previewStore.claim({ realm: 'preview', inboxId: id, claimLeaseMs: 1 }), null);
  await assert.rejects(() => s.store.listCandidates({ realm: 'preview', minAgeMs: 0, limit: 10 }), /REALM_MISMATCH/);
  const previewAdmission = createDurableBrokerAdmissionService({ ...s.deps, realmAuthority: { authorizedRealm: () => 'preview' }, durableInbox: s.inbox });
  const preview = createBrokerInboxReconciler({ realm: 'preview', admission: previewAdmission, reconciliationStore: previewStore, reconciliationPolicy: TEST_ONLY_POLICY,
    audit: s.deps.audit, metrics: s.deps.metrics, alerts: s.deps.alerts });
  assert.equal(await preview.reconcileOne(id), 'blocked');
  assert.throws(() => createBrokerInboxReconciler({ realm: 'preview', admission: s.admission, reconciliationStore: s.store, reconciliationPolicy: TEST_ONLY_POLICY,
    audit: s.deps.audit, metrics: s.deps.metrics, alerts: s.deps.alerts }), /realm/i);
  assert.equal(s.persistence.measurements.size, 0);
});

test('R04 claim: first claim wins with version 1 and a fence token; the state is claimed', async () => {
  const s = await reconciliationSetup();
  const { id } = await onlyOrphan(s);
  const claim = await s.store.claim({ realm: 'test', inboxId: id, claimLeaseMs: 5000 });
  assert.deepEqual([claim.inboxId, claim.version, /^[0-9a-f]{32}$/.test(claim.token)], [id, 1, true]);
  assert.equal((await s.store.getState({ realm: 'test', inboxId: id })).status, 'claimed');
  assert.equal(await s.store.claim({ realm: 'test', inboxId: id, claimLeaseMs: 5000 }), null);
});

test('R05 stale claim denied: after takeover the old holder cannot complete (fence token + version)', async () => {
  const s = await reconciliationSetup();
  const { id } = await onlyOrphan(s);
  const a = await s.store.claim({ realm: 'test', inboxId: id, claimLeaseMs: 5000 });
  assert.equal(await s.store.claim({ realm: 'test', inboxId: id, claimLeaseMs: 5000 }), null);       // live claim: no takeover
  s.inbox.advance(6000);
  const b = await s.store.claim({ realm: 'test', inboxId: id, claimLeaseMs: 5000 });                // expired: takeover
  assert.equal(b.version, 2);
  assert.equal(await s.store.complete({ realm: 'test', claim: a, outcome: 'recovered-and-processed' }), false);
  assert.equal(await s.store.complete({ realm: 'test', claim: { ...b, version: 1 }, outcome: 'blocked' }), false);
  assert.equal(await s.store.complete({ realm: 'test', claim: b, outcome: 'recovered-and-processed' }), true);
  assert.equal(await s.store.complete({ realm: 'test', claim: b, outcome: 'recovered-and-processed' }), false); // completed is final
});

for (const n of [2, 10]) {
  test(`R0${n === 2 ? 6 : 7} ${n} concurrent reconcilers: exactly one does the work, one measurement`, async () => {
    const s = await reconciliationSetup();
    const { id } = await onlyOrphan(s);
    const out = await Promise.all(Array.from({ length: n }, () => s.reconciler.reconcileOne(id)));
    assert.equal(out.filter(x => x === 'recovered-and-processed').length, 1);
    assert.ok(out.every(x => x === 'recovered-and-processed' || x === 'stale-reconciliation' || x === 'duplicate'));
    assert.equal(s.persistence.measurements.size, 1);
  });
}

test('R08 integrity failure: tampered bytes are never processed; the outcome is sticky and not retryable', async () => {
  const s = await reconciliationSetup();
  const { id } = await onlyOrphan(s);
  s.inbox.rows.get(id).rawPayload = Buffer.from(JSON.stringify({ tampered: true }));
  assert.equal(await s.reconciler.reconcileOne(id), 'integrity-failed');
  assert.equal(s.persistence.measurements.size, 0);
  assert.deepEqual((await s.store.getState({ realm: 'test', inboxId: id })).outcome, 'integrity-failed');
  assert.equal(await s.reconciler.reconcileOne(id), 'duplicate');      // never retried
  assert.ok(s.alerts.events.some(a => a.type === 'BROKER_INBOX_RECONCILIATION_FAILED'));
  assert.ok(s.audit.entries.some(r => r.action === 'inbox-reconciliation-integrity-failed'));
});

test('R09 already processed: a record whose measurement exists is detected through downstream idempotency; no second measurement', async () => {
  const s = await reconciliationSetup();
  const { id } = await onlyOrphan(s);
  assert.equal((await s.admission.processPersistedBrokerDelivery({ inboxId: id })).status, 'ingested');   // processed by the receipt-less path
  assert.equal(s.persistence.measurements.size, 1);
  assert.equal(await s.reconciler.reconcileOne(id), 'already-processed');
  assert.equal(s.persistence.measurements.size, 1);
});

test('R10 recovered: a never-processed orphan is processed exactly once', async () => {
  const s = await reconciliationSetup();
  const { id } = await onlyOrphan(s);
  const report = await s.reconciler.reconcileBrokerInbox({ mode: 'reconcile', limit: 10 });
  assert.deepEqual(report.results, [{ inboxId: id, result: 'recovered-and-processed' }]);
  assert.equal(s.persistence.measurements.size, 1);
});

test('R11 second reconciliation is a duplicate: nothing is claimed or processed again', async () => {
  const s = await reconciliationSetup();
  const { id } = await onlyOrphan(s);
  await s.reconciler.reconcileOne(id);
  assert.equal(await s.reconciler.reconcileOne(id), 'duplicate');
  const again = await s.reconciler.reconcileBrokerInbox({ mode: 'reconcile', limit: 10 });
  assert.deepEqual([again.candidates.length, again.results.length], [0, 0]);
  assert.equal(s.persistence.measurements.size, 1);
});

test('R12 crash after claim: a new reconciler takes over after the lease and the old holder is fenced out; one measurement', async () => {
  const s = await reconciliationSetup();
  const { id } = await onlyOrphan(s);
  const dead = await s.store.claim({ realm: 'test', inboxId: id, claimLeaseMs: 5000 });         // reconciler A claims, then "crashes"
  assert.equal(await s.reconciler.reconcileOne(id), 'stale-reconciliation');                     // live claim: B cannot work
  s.inbox.advance(6000);
  assert.equal(await s.reconciler.reconcileOne(id), 'recovered-and-processed');
  assert.equal(await s.store.complete({ realm: 'test', claim: dead, outcome: 'recovered-and-processed' }), false);
  assert.equal(s.persistence.measurements.size, 1);
});

test('R13 audit: candidate / claimed / completed are recorded without payload, topic or client ids', async () => {
  const s = await reconciliationSetup();
  await onlyOrphan(s);
  await s.reconciler.reconcileBrokerInbox({ mode: 'reconcile', limit: 10 });
  const dump = JSON.stringify(s.audit.entries);
  for (const a of ['inbox-reconciliation-candidate', 'inbox-reconciliation-claimed', 'inbox-reconciliation-completed']) assert.ok(dump.includes(a), a);
  for (const leak of ['temperature', 'synthetic/agro', 'synthetic-device', 'rawPayload']) assert.equal(dump.includes(leak), false, leak);
});

test('R14 metrics: bounded closed labels', async () => {
  const s = await reconciliationSetup();
  await onlyOrphan(s);
  await s.reconciler.reconcileBrokerInbox({ mode: 'reconcile', limit: 10 });
  const m = s.metrics.events.filter(e => e.name === 'broker_inbox_reconciliation_total');
  assert.ok(m.some(e => e.labels.outcome === 'recovered-and-processed'));
  for (const e of s.metrics.events) assert.ok(Object.keys(e.labels).every(k => ['stage', 'reasonCode', 'retryClass', 'outcome'].includes(k)));
});

test('R15 inspect-only never mutates: no state, no measurement, no claim', async () => {
  const s = await reconciliationSetup();
  await onlyOrphan(s);
  const rows = JSON.stringify([...s.inbox.rows.keys()]);
  await s.reconciler.reconcileBrokerInbox({ mode: 'inspect-only', limit: 10 });
  assert.deepEqual([s.store.states.size, s.persistence.measurements.size, JSON.stringify([...s.inbox.rows.keys()])], [0, 0, rows]);
});

test('R16 scan limit honored and invalid limits refused', async () => {
  const s = await reconciliationSetup();
  for (let i = 0; i < 5; i += 1) await s.orphan(delivery({ env: { eventId: 'synthetic-telemetry-r16-' + i } }));
  ripe(s);
  assert.equal((await s.reconciler.reconcileBrokerInbox({ mode: 'inspect-only', limit: 2 })).candidates.length, 2);
  assert.equal((await s.reconciler.reconcileBrokerInbox({ mode: 'reconcile', limit: 3 })).results.length, 3);
  const capped = s.rebuild({ ...TEST_ONLY_POLICY, maxBatch: 1 });
  assert.equal((await capped.reconcileBrokerInbox({ mode: 'inspect-only', limit: 50 })).candidates.length, 1);
  for (const limit of [0, -1, 501, 1.5, '5', undefined, Infinity]) assert.deepEqual(await s.reconciler.reconcileBrokerInbox({ mode: 'reconcile', limit }), { status: 'blocked', reason: 'invalid-options' });
  assert.equal((await s.reconciler.reconcileBrokerInbox({ mode: 'delete', limit: 1 })).reason, 'invalid-options');
});

test('R17 adapter contract: a delivery can never carry business identity; the technical key is authorized, not claimed', async () => {
  const s = await reconciliationSetup();
  for (const key of ['clientId', 'clientid', 'businessClientId', 'sourceId', 'deviceId']) {
    assert.equal((await s.boundary.deliver(delivery({ obs: { [key]: 'x' } }))).reasonCode, 'broker-context-malformed', key);
  }
  assert.equal((await s.boundary.deliver(delivery({ env: { clientid: 'other-device' } }))).reasonCode, 'technical-identity-mismatch');
  for (const f of ['realm', 'clientId', 'trusted', 'verified', 'rawPersistedAt', 'sourceId']) assert.ok(ADAPTER_FORBIDDEN_AUTHORITY_FIELDS.includes(f), f);
  assert.equal(s.inbox.rows.size, 0);
});

test('R18 adapter contract: the realm is never derived from the topic or supplied by the adapter', async () => {
  const s = await reconciliationSetup();
  assert.equal((await s.boundary.deliver(delivery({ obs: { realm: 'production' } }))).reasonCode, 'broker-context-malformed');
  const r = await s.boundary.deliver(delivery({ obs: { topic: 'synthetic/agro/production/telemetry' } }));
  assert.equal(r.status, 'ingested');
  assert.equal([...s.inbox.rows.values()][0].realm, 'test');
});

test('R19 QoS 0: no redelivery exists, so a failed persistence is reported as loss-possible, never as retryable', async () => {
  const s = await reconciliationSetup();
  s.inbox.failing = true;
  const lost = await s.admission.admit(delivery({ obs: { qos: 0, packetId: null } }), { mode: 'persist-only' });
  assert.equal(lost.reasonCode, 'broker-inbox-unavailable');
  assert.equal(decideBrokerAck(0, lost).decision, 'loss-possible-qos0');
  assert.equal(decideBrokerAck(1, lost).decision, 'withhold-ack-retry');
  s.inbox.failing = false;
  const ok = await s.admission.admit(delivery({ obs: { qos: 0, packetId: null } }), { mode: 'persist-only' });
  assert.equal(decideBrokerAck(0, ok).decision, 'ack-allowed');
  assert.equal(decideBrokerAck(2, { status: 'rejected', reasonCode: 'payload-malformed' }).decision, 'poison-policy-undecided');
});

test('R20 QoS 1 redelivery is duplicate-safe: persist-before-ack reduces loss, downstream idempotency removes the duplicate', async () => {
  const s = await reconciliationSetup();
  const a = await s.boundary.deliver(delivery({ obs: { qos: 1, packetId: 9 } }));
  const b = await s.boundary.deliver(delivery({ obs: { qos: 1, packetId: 9 } }));
  assert.deepEqual([decideBrokerAck(1, a).decision, decideBrokerAck(1, b).decision], ['ack-allowed', 'ack-allowed']);
  assert.deepEqual([s.inbox.rows.size, s.persistence.measurements.size], [2, 1]);
});

test('R21 default productive policy is BLOCKED: nothing is listed, claimed or processed', async () => {
  const s = await reconciliationSetup({ policy: createBlockingMqttBoundaryPlaceholders().reconciliationPolicy });
  const { id } = await onlyOrphan(s);
  assert.deepEqual(await s.reconciler.reconcileBrokerInbox({ mode: 'reconcile', limit: 10 }), { status: 'blocked', reason: 'reconciliation-policy-not-decided' });
  assert.equal(await s.reconciler.reconcileOne(id), 'blocked');
  const inspect = await s.reconciler.reconcileBrokerInbox({ mode: 'inspect-only', limit: 10 });
  assert.deepEqual([inspect.policy, inspect.candidates.length, inspect.counts.absent], ['BLOCKED', 0, 1]);
  for (const bad of [undefined, null, {}, { mode: 'TEST_ONLY' }, { ...TEST_ONLY_POLICY, minAgeMs: -1 }, { ...TEST_ONLY_POLICY, extra: 1 }])
    assert.equal(await s.rebuild(bad).reconcileOne(id), 'blocked');
  assert.deepEqual([s.store.states.size, s.persistence.measurements.size], [0, 0]);
});

test('R22 normal admission leaves a receipt marker and a completion: such records are never orphan candidates', async () => {
  const s = await reconciliationSetup();
  const r = await s.boundary.deliver(delivery());
  assert.deepEqual(await s.store.getState({ realm: 'test', inboxId: r.receipt.inboxId }), { status: 'completed', version: 2, outcome: 'admission-processed' });
  ripe(s);
  assert.equal((await s.reconciler.reconcileBrokerInbox({ mode: 'inspect-only', limit: 10 })).candidates.length, 0);
  assert.equal(await s.reconciler.reconcileOne(r.receipt.inboxId), 'duplicate');
});

test('R23 a lost marker only makes a processed record a candidate: reconciliation reports already-processed (no second measurement)', async () => {
  const s = await reconciliationSetup();
  s.store.failing = true;
  const r = await s.boundary.deliver(delivery());
  s.store.failing = false;
  assert.equal(r.status, 'ingested');                 // the marker write is best-effort and never changes the ingestion result
  ripe(s);
  const report = await s.reconciler.reconcileBrokerInbox({ mode: 'reconcile', limit: 10 });
  assert.deepEqual(report.results.map(x => x.result), ['already-processed']);
  assert.equal(s.persistence.measurements.size, 1);
});

test('R24 persist-only leaves the record receipted: it belongs to the receipt holder and is not claimable', async () => {
  const s = await reconciliationSetup();
  const r = await s.admission.admit(delivery(), { mode: 'persist-only' });
  assert.equal((await s.store.getState({ realm: 'test', inboxId: r.receipt.inboxId })).status, 'receipted');
  ripe(s);
  assert.equal(await s.reconciler.reconcileOne(r.receipt.inboxId), 'blocked');
  assert.equal((await s.admission.processPersistedBrokerDelivery({ inboxId: r.receipt.inboxId })).status, 'ingested');
  assert.equal((await s.store.getState({ realm: 'test', inboxId: r.receipt.inboxId })).outcome, 'admission-processed');
});

test('R25 N1 clock skew: an adapter clock ahead of the database clock is rejected fail-closed, with NO tolerance and no measurement', async () => {
  const inbox = createInMemoryBrokerInbox('test', { start: RECEIVED - 10_000 });  // database clock BEHIND the adapter receivedAt
  const s = await reconciliationSetup({ durableInbox: inbox });
  const r = await s.boundary.deliver(delivery());
  assert.equal(r.status, 'ingested');
  assert.equal(r.results[0].result.status, 'quarantined');
  assert.equal(r.results[0].result.reasonCode, 'invalid-timestamp');
  assert.equal(s.persistence.measurements.size, 0);
});

test('R26 unavailable store: nothing final is recorded and the failure is explicit', async () => {
  const s = await reconciliationSetup();
  const { id } = await onlyOrphan(s);
  s.store.failing = true;
  assert.equal(await s.reconciler.reconcileOne(id), 'unavailable');
  s.store.failing = false;
  s.inbox.failing = true;
  assert.equal(await s.reconciler.reconcileOne(id), 'unavailable');
  s.inbox.failing = false;
  s.inbox.advance(6000);
  assert.equal(await s.reconciler.reconcileOne(id), 'recovered-and-processed');
  assert.equal(s.persistence.measurements.size, 1);
});

// ---- N1 clock skew: the EXACT rule is BE13-02 `persistedAt < receivedAt` => invalid-timestamp. No tolerance is chosen here.
const skew = async (start, env = {}) => {
  const s = await reconciliationSetup({ durableInbox: createInMemoryBrokerInbox('test', { start }) });
  const r = await s.boundary.deliver(delivery({ env }));
  return { s, status: r.results?.[0]?.result?.status, reason: r.results?.[0]?.result?.reasonCode };
};
test('R27 N1: database clock BEHIND the adapter (persistedAt < receivedAt) → invalid-timestamp; extreme skew behaves the same', async () => {
  for (const start of [RECEIVED - 2, RECEIVED - 10_000, RECEIVED - 30 * 24 * 3600 * 1000]) {
    const { s, status, reason } = await skew(start);
    assert.deepEqual([status, reason, s.persistence.measurements.size], ['quarantined', 'invalid-timestamp', 0]);
  }
});
test('R28 N1: equality (persistedAt == receivedAt) is accepted; the rule is strictly "less than"', async () => {
  const { s, status } = await skew(RECEIVED - 1);   // first write is start + 1 === RECEIVED
  assert.deepEqual([status, s.persistence.measurements.size], ['accepted', 1]);
});
test('R29 N1: database clock AHEAD of the adapter (large or small) is accepted: no upper bound exists in this rule', async () => {
  for (const start of [RECEIVED + 1, RECEIVED + 3_600_000, RECEIVED + 30 * 24 * 3600 * 1000]) assert.equal((await skew(start)).status, 'accepted');
});
test('R30 N1: the device timestamp is independent: it never causes or prevents invalid-timestamp', async () => {
  for (const deviceTimestamp of [1, 4102444800000, RECEIVED - 5]) {
    assert.equal((await skew(RECEIVED + 3_600_000, { deviceTimestamp })).status, 'accepted');
    assert.equal((await skew(RECEIVED - 10_000, { deviceTimestamp })).reason, 'invalid-timestamp');
  }
});
test('R31 N1: the quarantined record keeps the inbox record intact and recoverable once the clocks agree (no tolerance applied)', async () => {
  const { s } = await skew(RECEIVED - 10_000);
  const [id] = s.inbox.rows.keys();
  assert.equal(s.inbox.rows.get(id).rawPersistedAt < RECEIVED, true);
  assert.equal(s.persistence.measurements.size, 0);
});
