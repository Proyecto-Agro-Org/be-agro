// BE13-11B — adversarial vectors against the Durable Broker Inbox path (OFFLINE, SINTETICO).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDurableBrokerAdmissionService } from '../dist/src/services/mqtt-ingestion-boundary.service.js';
import { boundarySetup, delivery, envelope, bytesOf } from '../test-support/be13-11a-broker.fixtures.js';

const persistOnly = (s, d = delivery()) => s.admission.admit(d, { mode: 'persist-only' });
const recover = (s, inboxId) => s.admission.processPersistedBrokerDelivery({ inboxId });

test('A01 forged receipt: an invented inboxId or receipt fields buy nothing — only a stored record is processed', async () => {
  const s = await boundarySetup();
  assert.equal((await recover(s, 'ib_' + 'f'.repeat(32))).reasonCode, 'broker-inbox-not-found');
  assert.equal((await s.admission.processPersistedBrokerDelivery({ inboxId: 'q_' + 'f'.repeat(64) })).reasonCode, 'broker-inbox-not-found');
  const forged = { inboxId: 'ib_' + 'e'.repeat(32), realm: 'test', rawPersistedAt: Date.now(), rawPayloadSha256: 'a'.repeat(64), rawPayloadBytes: 10, provenanceFingerprint: 'b'.repeat(64) };
  assert.equal((await s.admission.processPersistedBrokerDelivery(forged)).reasonCode, 'broker-inbox-not-found');
  assert.equal(s.persistence.measurements.size, 0);
});

test('A02 forged rawPersistedAt: never accepted from a delivery, an envelope or a hand-built protected document', async () => {
  const s = await boundarySetup();
  assert.equal((await s.boundary.deliver(delivery({ obs: { rawPersistedAt: 1795115600110 } }))).reasonCode, 'broker-context-malformed');
  assert.equal((await s.boundary.deliver(delivery({ env: { rawPersistedAt: 1795115600110 } }))).reasonCode, 'payload-malformed');
  // A hand-built document with persistedAt sent straight to the pipeline has no boundary-issued evidence.
  const hand = { sourceId: 'synthetic-ingest', operation: 'measurement', eventId: 'synthetic-telemetry-001', clientid: 'synthetic-device-001', _receivedAt: new Date(1795115600100),
    persistedAt: new Date(1795115600110), _payload: { temperature: 1 }, _provenance: {} };
  const q = await s.direct.deliver(delivery()); // creates a BLOCKED entry to address the pipeline through operations
  const [row] = [...s.quarantine.rows.values()];
  const r = await s.boundary.operations.replay({ token: 'tok-admin' }, { quarantineId: row.quarantineId, expectedVersion: row.version, protectedDocument: hand, provenanceEvidence: {}, field: 'temperature' });
  assert.equal(r.status, 'denied');
  assert.equal(q.results[0].result.reasonCode, 'unresolved-persisted-at');
  assert.equal(s.persistence.measurements.size, 0);
});

test('A03 cross-realm inboxId: knowing an id of realm test does not allow processing it from realm preview', async () => {
  const s = await boundarySetup();
  const r = await persistOnly(s);
  const preview = createDurableBrokerAdmissionService({ ...s.deps, realmAuthority: { authorizedRealm: () => 'preview' }, durableInbox: s.inbox });
  assert.equal((await preview.processPersistedBrokerDelivery({ inboxId: r.receipt.inboxId })).reasonCode, 'broker-inbox-not-found');
  assert.equal((await preview.admitForReplay({ inboxId: r.receipt.inboxId })).reasonCode, 'broker-inbox-not-found');
});

for (const [name, change] of [
  ['A04 raw bytes tampering', rec => { rec.rawPayload = bytesOf(JSON.stringify(envelope({ eventId: 'synthetic-telemetry-666' }))); }],
  ['A05 context tampering (packet id / QoS / receivedAt / connection)', rec => { rec.packetId = 9; rec.qos = 0; rec.receivedAt += 1; rec.connectionReference = 'conn:other'; }],
  ['A06 provenance tampering (verifiedAt / mappingRevision / key)', rec => { rec.verifiedAt += 1; rec.mappingRevision = 9; }],
]) {
  test(`${name} → integrity failure, no measurement`, async () => {
    const s = await boundarySetup();
    const r = await persistOnly(s);
    change(s.inbox.rows.get(r.receipt.inboxId));
    assert.equal((await recover(s, r.receipt.inboxId)).reasonCode, 'broker-inbox-integrity-failed');
    assert.equal((await s.admission.admitForReplay({ inboxId: r.receipt.inboxId })).status, 'rejected');
    assert.equal(s.persistence.measurements.size, 0);
  });
}

test('A07 packet id collision: same packet id, distinct events → distinct records and measurements; identical events → one measurement', async () => {
  const s = await boundarySetup();
  const a = await s.boundary.deliver(delivery({ obs: { packetId: 5 } }));
  const b = await s.boundary.deliver(delivery({ obs: { packetId: 5 }, env: { eventId: 'synthetic-telemetry-002' } }));
  const c = await s.boundary.deliver(delivery({ obs: { packetId: 5 } }));
  assert.equal(new Set([a, b, c].map(x => x.receipt.inboxId)).size, 3, 'the packet id never identifies an inbox record');
  assert.deepEqual([s.inbox.rows.size, s.persistence.measurements.size], [3, 2]);
});

test('A08 mqttClientId collision: the client id is never an inbox identity or dedupe key', async () => {
  const s = await boundarySetup();
  const ids = [];
  for (const e of ['x', 'y']) ids.push((await persistOnly(s, delivery({ env: { eventId: 'synthetic-telemetry-' + e } }))).receipt.inboxId);
  assert.notEqual(ids[0], ids[1]);
  assert.ok(ids.every(id => !id.includes('synthetic-device')));
});

test('A09 sourceId spoofing in the payload never reaches the inbox record or the measurement', async () => {
  const s = await boundarySetup();
  assert.equal((await s.boundary.deliver(delivery({ env: { sourceId: 'attacker-source' } }))).reasonCode, 'payload-malformed');
  const r = await s.boundary.deliver(delivery({ env: { payload: { temperature: 1, source_id: 'attacker-source' } } }));
  assert.equal(s.inbox.rows.get(r.receipt.inboxId).sourceId, 'synthetic-ingest');
  assert.ok([...s.persistence.measurements.values()].every(m => m.key.sourceId === 'synthetic-ingest'));
});

test('A10 topic realm spoofing: the stored realm is the authorized one', async () => {
  const s = await boundarySetup();
  const r = await persistOnly(s, delivery({ obs: { topic: 'synthetic/agro/production/telemetry' } }));
  assert.equal(s.inbox.rows.get(r.receipt.inboxId).realm, 'test');
});

test('A11 credential-like fields can never be injected into a record', async () => {
  const s = await boundarySetup();
  for (const d of [delivery({ obs: { password: 'x' } }), delivery({ obs: { 'x-emqx-key': 'x' } }), { ...delivery(), token: 'x' }, delivery({ env: { password: 'x' } })])
    assert.equal((await s.boundary.deliver(d)).status, 'rejected');
  assert.equal(s.inbox.rows.size, 0);
  const r = await persistOnly(s);
  const keys = Object.keys(s.inbox.rows.get(r.receipt.inboxId));
  assert.equal(keys.some(k => /password|token|secret|key$/i.test(k) && k !== 'technicalDeviceKey'), false);
});

test('A12/A13 malformed or hostile store responses on recovery → integrity failure (never processed)', async () => {
  for (const answer of [rec => ({ ...rec, extra: 1 }), rec => ({ ...rec, qos: 5 }), rec => ({ ...rec, rawPayload: 'bytes' }), rec => ({ ...rec, get sourceId() { throw new Error('hostile'); } })]) {
    const s = await boundarySetup();
    const r = await persistOnly(s);
    const original = s.inbox.getById.bind(s.inbox);
    s.inbox.getById = async q => answer(await original(q));
    assert.equal((await recover(s, r.receipt.inboxId)).reasonCode, 'broker-inbox-integrity-failed');
    assert.equal(s.persistence.measurements.size, 0);
  }
  const t = await boundarySetup();
  t.inbox.getById = async () => { throw new Error('down'); };
  const out = await recover(t, 'ib_' + '1'.repeat(32));
  assert.deepEqual([out.reasonCode, out.retryable], ['broker-inbox-unavailable', true]);
  assert.ok(t.alerts.events.some(a => a.type === 'BROKER_INBOX_RECOVERY_FAILURE'));
});

test('A14 oversized raw payload: rejected before verification and before the inbox', async () => {
  const s = await boundarySetup();
  assert.equal((await persistOnly(s, delivery({ payload: Buffer.alloc(4097, 0x20) }))).reasonCode, 'payload-too-large');
  assert.equal(s.verifier.calls.length, 0);
  assert.equal(s.inbox.rows.size, 0);
});

test('A15 direct boundary bypass: without the inbox nothing is ever accepted; the admission owns provenance too', async () => {
  const s = await boundarySetup();
  for (let i = 0; i < 3; i += 1) assert.notEqual((await s.direct.deliver(delivery({ env: { eventId: 'synthetic-telemetry-d' + i } }))).results[0].result.status, 'accepted');
  assert.equal(s.persistence.measurements.size, 0);
  assert.throws(() => createDurableBrokerAdmissionService({ ...s.deps, durableInbox: s.inbox, provenanceVerifier: { verify: () => ({}) } }), /owns provenance/);
});

test('A16 no worker, scheduler, polling, broker client or env in the inbox code; app.ts untouched', () => {
  for (const file of ['src/repositories/mongo-broker-inbox.store.ts', 'src/models/broker-inbox.models.ts', 'src/services/mqtt-ingestion-boundary.service.ts', 'src/iot/broker-fingerprints.ts']) {
    const src = readFileSync(new URL('../' + file, import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
    assert.equal(/process\.env|setInterval|setTimeout|cron|mqtt:\/\/|from 'mqtt'|emqx|expireAfterSeconds|deleteOne|deleteMany|updateMany|replaceOne/i.test(src), false, file);
  }
  const app = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8').toLowerCase();
  for (const t of ['inbox', 'broker', 'mqtt']) assert.equal(app.includes(t), false, t);
});
