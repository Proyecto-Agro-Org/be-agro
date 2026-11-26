// BE13-11G — offline guards for "no MQTT ACK / no `duplicate` verdict from data that a majority does not hold".
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMongoMeasurementPersistence, idempotencyDocumentId, measurementDocumentId } from '../dist/src/repositories/mongo-measurement-persistence.repository.js';
import { createMongoBrokerInboxStore } from '../dist/src/repositories/mongo-broker-inbox.store.js';

const key = { realm: 'test', sourceId: 'lab-source-a', operation: 'measurement', eventId: 'e-1', field: 'temperature' };
const claim = { _id: idempotencyDocumentId(key), realm: 'test', sourceId: 'lab-source-a', operation: 'measurement', eventId: 'e-1', field: 'temperature', fingerprint: 'a'.repeat(64),
  state: 'committed', measurementId: measurementDocumentId(key), committedAt: new Date() };

function fakeConnection(onFindOne) {
  return { db: { collection: () => ({ findOne: async (q, o) => onFindOne(q, o) }) }, startSession: async () => { throw new Error('not used'); } };
}

test('G1: the idempotency pre-check reads with readConcern majority', async () => {
  const seen = [];
  const store = createMongoMeasurementPersistence({ connection: fakeConnection((q, o) => { seen.push(o); return null; }), prefix: 'agro_ingest_g1', realm: 'test' });
  assert.equal((await store.lookup(key)).status, 'absent');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].readConcern?.level, 'majority');
});

test('G2: a claim is reported as present only when the (majority) read returned it', async () => {
  const store = createMongoMeasurementPersistence({ connection: fakeConnection(() => claim), prefix: 'agro_ingest_g2', realm: 'test' });
  assert.equal((await store.lookup(key)).status, 'present');
});

test('G3: the durable inbox receipt re-reads with readConcern majority and writes with majority + journal', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../src/repositories/mongo-broker-inbox.store.ts', import.meta.url), 'utf8');
  assert.match(src, /const writeConcern = \{ w: 'majority' as const, j: true/);
  assert.match(src, /readConcern: \{ level: 'majority' \}/);
  assert.ok(src.indexOf('INBOX_NOT_VISIBLE') > src.indexOf('await getById({ realm, inboxId })'), 'receipt only after the majority read-back');
  assert.equal(typeof createMongoBrokerInboxStore, 'function');
});

test('G4: the MQTT ACK is released only from a persisted receipt (adapter path)', async () => {
  const lab = (await import('node:fs')).readFileSync(new URL('../scripts/be13-11d/lab-consumer.ts', import.meta.url), 'utf8');
  const decide = (await import('node:fs')).readFileSync(new URL('../src/iot/broker-adapter.contracts.ts', import.meta.url), 'utf8');
  assert.match(lab, /return decideBrokerAck\(delivery\.brokerObserved\.qos, r\)/);
  assert.match(decide, /persisted/);
});
