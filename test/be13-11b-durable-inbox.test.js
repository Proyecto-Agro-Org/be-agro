// BE13-11B — Durable Broker Inbox and persist-before-ingest (OFFLINE, SINTETICO / TEST_ONLY doubles).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDurableBrokerAdmissionService, describeDurableAdmissionReadiness } from '../dist/src/services/mqtt-ingestion-boundary.service.js';
import { createBlockingMqttBoundaryPlaceholders } from '../dist/src/adapters/ingestion-production-placeholders.js';
import { payloadSha256 } from '../dist/src/iot/broker-fingerprints.js';
import { boundarySetup, delivery, envelope, bytesOf, createInMemoryBrokerInbox } from '../test-support/be13-11a-broker.fixtures.js';

const persistOnly = (s, d) => s.admission.admit(d, { mode: 'persist-only' });
const measurements = s => s.persistence.measurements.size;
const onlyRecord = s => [...s.inbox.rows.values()][0];

test('D01 verified delivery → persisted (persist-only): receipt from the store, nothing ingested yet', async () => {
  const s = await boundarySetup();
  const r = await persistOnly(s, delivery());
  assert.equal(r.status, 'persisted');
  assert.match(r.receipt.inboxId, /^ib_[0-9a-f]{32}$/);
  assert.deepEqual([r.receipt.realm, s.inbox.rows.size, measurements(s)], ['test', 1, 0]);
  assert.ok(Object.isFrozen(r.receipt));
  assert.ok(s.audit.entries.some(e => e.action === 'inbox-persisted'));
});

for (const [name, opts, d, reason, retryable] of [
  ['D02 REJECTED provenance', { verifierMode: { kind: 'reject' } }, delivery(), 'broker-provenance-rejected', false],
  ['D03 UNVERIFIED provenance', {}, delivery({ obs: { authenticatedPrincipalReference: null } }), 'broker-provenance-unverified', false],
  ['D04 transient verifier failure', { verifierMode: { kind: 'throw' } }, delivery(), 'broker-verifier-unavailable', true],
  ['D27 retained (blocked)', {}, delivery({ obs: { retain: true } }), 'retained-message-blocked', false],
]) {
  test(`${name} is NOT persisted: no inbox record, no quarantine, no measurement`, async () => {
    const s = await boundarySetup(opts);
    const r = await s.admission.admit(d, { mode: 'persist-and-process' });
    assert.deepEqual([r.reasonCode, r.retryable], [reason, retryable]);
    assert.deepEqual([s.inbox.rows.size, s.quarantine.rows.size, measurements(s)], [0, 0, 0]);
  });
}

test('D05 the exact raw bytes round-trip (no re-serialization)', async () => {
  const s = await boundarySetup();
  const bytes = bytesOf('{ "version":1, "eventId":"synthetic-telemetry-001","sentAt":1795115600000,"clientid":"synthetic-device-001","payload":{"temperature":0},"mqtt":{"messageType":"telemetry","dataOrigin":"simulated"} }');
  const r = await persistOnly(s, delivery({ payload: bytes }));
  const rec = await s.inbox.getById({ realm: 'test', inboxId: r.receipt.inboxId });
  assert.equal(Buffer.compare(Buffer.from(rec.rawPayload), bytes), 0, 'whitespace and key order preserved');
  assert.equal(payloadSha256(rec.rawPayload), r.receipt.rawPayloadSha256);
});

test('D06 rawPersistedAt is assigned by the store; it is not receivedAt, sentAt or deviceTimestamp', async () => {
  const s = await boundarySetup();
  const r = await persistOnly(s, delivery());
  const rec = onlyRecord(s), env = envelope();
  assert.equal(r.receipt.rawPersistedAt, rec.rawPersistedAt);
  assert.ok(![rec.receivedAt, env.sentAt, env.deviceTimestamp].includes(rec.rawPersistedAt));
});

test('D07 nobody can declare rawPersistedAt: delivery context, envelope, direct path', async () => {
  const s = await boundarySetup();
  assert.equal((await s.boundary.deliver(delivery({ obs: { rawPersistedAt: Date.now() } }))).reasonCode, 'broker-context-malformed');
  assert.equal((await s.boundary.deliver(delivery({ env: { rawPersistedAt: 1, persistedAt: 1 } }))).reasonCode, 'payload-malformed');
  const direct = await s.direct.deliver(delivery());
  assert.deepEqual([direct.results[0].result.status, direct.results[0].result.reasonCode], ['quarantined', 'unresolved-persisted-at']);
  assert.equal(s.inbox.rows.size, 0);
});

test('D08/D16 realm isolation: a store or an admission of another realm never reads the record', async () => {
  const s = await boundarySetup();
  const r = await persistOnly(s, delivery());
  assert.equal(await s.inbox.getById({ realm: 'preview', inboxId: r.receipt.inboxId }), null);
  const preview = createDurableBrokerAdmissionService({ ...s.deps, realmAuthority: { authorizedRealm: () => 'preview' }, durableInbox: s.inbox });
  assert.equal((await preview.processPersistedBrokerDelivery({ inboxId: r.receipt.inboxId })).reasonCode, 'broker-inbox-not-found');
  assert.equal(measurements(s), 0);
});

test('D09 the stored sourceId comes from the identity mapping, never from the payload', async () => {
  const s = await boundarySetup();
  await persistOnly(s, delivery({ env: { payload: { temperature: 1, source_id: 'attacker-source' } } }));
  assert.equal(onlyRecord(s).sourceId, 'synthetic-ingest');
});

test('D10 identical deliveries → two inbox records, ONE measurement (business dedupe downstream)', async () => {
  const s = await boundarySetup();
  const a = await s.boundary.deliver(delivery());
  const b = await s.boundary.deliver(delivery({ obs: { packetId: 99 } }));
  assert.deepEqual([a.results[0].result.status, b.results[0].result.status], ['accepted', 'duplicate']);
  assert.notEqual(a.receipt.inboxId, b.receipt.inboxId);
  assert.deepEqual([s.inbox.rows.size, measurements(s)], [2, 1]);
});

test('D11/D12 crash recovery: persist-only, "process dies", a NEW service recovers by inboxId → accepted; second recovery → duplicate', async () => {
  const s = await boundarySetup();
  const r = await persistOnly(s, delivery());
  const restarted = createDurableBrokerAdmissionService({ ...s.deps, durableInbox: s.inbox }); // new instance, same durable store
  const first = await restarted.processPersistedBrokerDelivery({ inboxId: r.receipt.inboxId });
  assert.equal(first.results[0].result.status, 'accepted');
  assert.deepEqual(first.receipt, r.receipt);
  const second = await restarted.processPersistedBrokerDelivery({ inboxId: r.receipt.inboxId, protectedDocument: {}, payload: bytesOf('{}') });
  assert.equal(second.results[0].result.status, 'duplicate', 'extra fields are ignored: only the stored bytes are used');
  assert.equal(measurements(s), 1);
});

test('D13/D14/D15 tampered record (bytes, hash, provenance, context) → integrity failure: no measurement, alert, audit, nothing repaired', async () => {
  const tamper = [
    rec => { rec.rawPayload = bytesOf(JSON.stringify(envelope({ payload: { temperature: 99 } }))); },
    rec => { rec.rawPayloadSha256 = 'f'.repeat(64); },
    rec => { rec.sourceId = 'attacker-source'; },
    rec => { rec.principalReference = 'principal:other'; },
    rec => { rec.verifierRevision = 7; },
    rec => { rec.topic = 'synthetic/agro/other/telemetry'; },
    rec => { rec.mqttClientId = 'synthetic-device-002'; rec.technicalDeviceKey = 'synthetic-device-002'; },
    rec => { rec.rawPayloadBytes = 1; },
  ];
  for (const change of tamper) {
    const s = await boundarySetup();
    const r = await persistOnly(s, delivery());
    const rec = s.inbox.rows.get(r.receipt.inboxId); const before = JSON.stringify({ ...rec, rawPayload: [...rec.rawPayload] });
    change(rec);
    const out = await s.admission.processPersistedBrokerDelivery({ inboxId: r.receipt.inboxId });
    assert.deepEqual([out.reasonCode, out.retryClass, out.retryable], ['broker-inbox-integrity-failed', 'consistency', false], change.toString());
    assert.equal(measurements(s), 0);
    assert.ok(s.alerts.events.some(a => a.type === 'BROKER_INBOX_INTEGRITY_FAILURE'));
    assert.ok(s.audit.entries.some(e => e.action === 'inbox-integrity-failed'));
    assert.notEqual(JSON.stringify({ ...rec, rawPayload: [...rec.rawPayload] }), before, 'the tampered record is left as is (not repaired)');
  }
});

test('D17/D18 inbox write failure or malformed receipt → nothing reaches the pipeline', async () => {
  for (const setupInbox of [i => { i.failing = true; }, i => { i.answer = { inboxId: 'ib_' + '0'.repeat(32) }; },
    i => { i.answer = r => ({ inboxId: 'ib_' + '1'.repeat(32), realm: 'test', rawPersistedAt: 1, rawPayloadSha256: 'a'.repeat(64), rawPayloadBytes: r.rawPayload.byteLength, provenanceFingerprint: 'b'.repeat(64) }); },
    i => { i.answer = { get inboxId() { throw new Error('hostile'); } }; }]) {
    const s = await boundarySetup();
    setupInbox(s.inbox);
    const r = await s.admission.admit(delivery(), { mode: 'persist-and-process' });
    assert.deepEqual([r.reasonCode, r.retryable], ['broker-inbox-unavailable', true]);
    assert.deepEqual([s.quarantine.rows.size, measurements(s)], [0, 0]);
    assert.ok(s.alerts.events.some(a => a.type === 'BROKER_INBOX_PERSISTENCE_UNAVAILABLE'));
  }
});

test('D19 write confirmed, pipeline then fails → the record stays intact and recoverable', async () => {
  let down = true;
  const s = await boundarySetup();
  const real = s.persistence;
  const flaky = await boundarySetup({ persistence: { lookup: k => real.lookup(k), async persistAtomically(i, o) { if (down) throw new Error('down'); return real.persistAtomically(i, o); },
    replayFencing: 'atomic', claims: real.claims, measurements: real.measurements }, durableInbox: s.inbox });
  const r = await flaky.boundary.deliver(delivery());
  assert.equal(r.results[0].result.status, 'quarantined');
  const rec = onlyRecord(s), snapshot = payloadSha256(rec.rawPayload);
  down = false;
  const again = await flaky.admission.processPersistedBrokerDelivery({ inboxId: r.receipt.inboxId });
  assert.equal(again.results[0].result.status, 'accepted');
  assert.equal(payloadSha256(onlyRecord(s).rawPayload), snapshot);
});

test('D20 concurrent recovery by 2 and 10 callers → at most ONE measurement', async () => {
  for (const n of [2, 10]) {
    const s = await boundarySetup();
    const r = await persistOnly(s, delivery());
    const out = await Promise.all(Array.from({ length: n }, () => s.admission.processPersistedBrokerDelivery({ inboxId: r.receipt.inboxId })));
    assert.equal(measurements(s), 1);
    assert.equal(out.filter(o => o.results[0].result.status === 'accepted').length, 1);
  }
});

test('D21/D22 audit carries no raw payload; metrics/alerts keep closed labels without ids', async () => {
  const s = await boundarySetup();
  const marker = 'pw-SYNTHETIC-NOT-A-SECRET-456';
  const r = await s.boundary.deliver(delivery({ env: { payload: { temperature: 1, note: marker } } }));
  await s.admission.processPersistedBrokerDelivery({ inboxId: r.receipt.inboxId });
  assert.ok(['inbox-persisted', 'inbox-recovery-started', 'inbox-processed'].every(a => s.audit.entries.some(e => e.action === a)));
  const text = JSON.stringify([s.audit.entries, s.metrics.events, s.alerts.events]);
  for (const id of [marker, r.receipt.inboxId, 'synthetic-device-001', 'synthetic-telemetry-001', 'synthetic/agro']) assert.equal(text.includes(id) && !s.audit.entries.some(e => e.eventId === id), false, id);
  for (const e of s.metrics.events) assert.ok(Object.keys(e.labels).every(k => ['stage', 'reasonCode', 'retryClass', 'outcome'].includes(k)));
});

test('D23 readiness reports the durable inbox; placeholders (or a blocking inbox) never persist; productionReady false', async () => {
  const p = createBlockingMqttBoundaryPlaceholders();
  const s = await boundarySetup({ durableInbox: p.durableInbox });
  assert.equal((await s.boundary.deliver(delivery())).reasonCode, 'broker-inbox-unavailable');
  assert.equal(describeDurableAdmissionReadiness({ ...s.deps, durableInbox: p.durableInbox }).dependencies.durableInbox, 'BLOCKED');
  const ok = describeDurableAdmissionReadiness({ ...s.deps, durableInbox: createInMemoryBrokerInbox() });
  assert.deepEqual([ok.dependencies.durableInbox, ok.boundaryTestReady, ok.productionReady], ['INJECTED_UNVERIFIED', true, false]);
  assert.ok(ok.limitations.includes('INBOX_RETENTION_PENDING') && ok.limitations.includes('NO_INBOX_WORKER'));
  assert.throws(() => createDurableBrokerAdmissionService({ ...s.deps }), /durableInbox/);
});

test('D24 an audit failure after a confirmed write destroys nothing (persisted and processed anyway)', async () => {
  const s = await boundarySetup();
  s.audit.setFailing(true);
  const r = await s.boundary.deliver(delivery());
  assert.equal(r.results[0].result.status, 'accepted');
  assert.equal(s.inbox.rows.size, 1);
});

test('D25 H2 regression: distinct events never overwrite each other (sha256 measurement ids)', async () => {
  const s = await boundarySetup();
  for (const id of ['a', 'b', 'c']) await s.boundary.deliver(delivery({ env: { eventId: 'synthetic-telemetry-' + id } }));
  assert.deepEqual([s.persistence.claims.size, measurements(s)], [3, 3]);
});

test('D26 H3 regression: security rejections create neither quarantine nor inbox records', async () => {
  const s = await boundarySetup();
  for (const d of [delivery({ env: { clientid: 'synthetic-device-002' } }), delivery({ obs: { authenticatedPrincipalReference: 'principal:x' } }), delivery({ payload: bytesOf('{"__proto__":1}') })])
    assert.equal((await s.boundary.deliver(d)).status, 'rejected');
  assert.deepEqual([s.quarantine.rows.size, s.inbox.rows.size], [0, 0]);
});

test('Mode is closed: an unknown admission mode is refused without persisting', async () => {
  const s = await boundarySetup();
  for (const options of [{ mode: 'persist' }, {}, null]) assert.equal((await s.admission.admit(delivery(), options)).reasonCode, 'broker-context-malformed');
  assert.equal(s.inbox.rows.size, 0);
});
