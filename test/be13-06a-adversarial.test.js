// BE13-06A — Offline adversarial vectors for the Mongo store and atomic persistence.
// Real-transaction vectors (races, aborts, tampered claims) run in the local Mongo campaign.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createIngestionIdentityStoreFromCollections } from '../dist/src/repositories/mongo-ingestion-identity.store.js';
import { createMongoMeasurementPersistence, idempotencyDocumentId } from '../dist/src/repositories/mongo-measurement-persistence.repository.js';
import { createPersistentMeasurementIngestionComposition } from '../dist/src/services/measurement-ingestion-composition.service.js';
import { technicalInputFingerprint } from '../dist/src/iot/ingestion-event-fingerprint.js';
import { candidate, world, createInMemoryPersistence } from '../test-support/be13-composition.fixtures.js';

// A connection whose session must never be opened: proves rejection happens before any write.
function sealedConnection() {
  const touched = { session: 0, collection: [] };
  const collection = name => { touched.collection.push(name); return { findOne: async () => { throw new Error('must not read'); } }; };
  return { touched, connection: { db: { collection }, startSession: async () => { touched.session += 1; throw new Error('must not open a session'); } } };
}
const key = (patch = {}) => ({ realm: 'test', sourceId: 'synthetic-ingest', operation: 'measurement', eventId: 'e1', field: 'temperature', ...patch });
const event = (patch = {}) => ({ eventId: 'e1', sourceId: 'synthetic-ingest', device: { kind: 'mqtt-clientid', value: 'd' }, receivedAt: 10, declaredAt: null, persistedAt: 11,
  magnitude: 'temperature', unit: 'u', value: 1, missingReason: null, provenance: 'simulated', simulated: true, metadata: {}, ...patch });
const attribution = (patch = {}) => ({ realm: 'test', attributedAt: 10, clock: 'received-at', physicalDeviceId: 'd1', clientId: 'c', fieldId: 'f', areaId: 'a', sensorId: 's',
  associationId: 'as', associationRevision: 1, ...patch });
const input = (patch = {}) => ({ key: key(), fingerprint: 'a'.repeat(64), event: event(), attribution: attribution(), ...patch });

test('BE13-06A V1 forged realm, mismatched event or attribution never opens a transaction', async () => {
  const { connection, touched } = sealedConnection();
  const p = createMongoMeasurementPersistence({ connection, prefix: 'agro_ingest_adv', realm: 'test' });
  for (const bad of [input({ key: key({ realm: 'preview' }) }), input({ attribution: attribution({ realm: 'preview' }) }), input({ event: event({ eventId: 'other' }) }),
    input({ event: event({ sourceId: 'other' }) }), input({ key: key({ realm: 'tenant-x' }) })]) {
    await assert.rejects(p.persistAtomically(bad));
  }
  assert.equal(touched.session, 0);
});

test('BE13-06A V2 malformed or injected persistence input is rejected before Mongo', async () => {
  const { connection, touched } = sealedConnection();
  const p = createMongoMeasurementPersistence({ connection, prefix: 'agro_ingest_adv', realm: 'test' });
  for (const bad of [input({ fingerprint: 'nothex' }), input({ key: key({ eventId: { $ne: null } }) }), input({ key: { ...key(), extra: 1 } }),
    input({ event: event({ value: null }) }), input({ event: event({ persistedAt: 9 }) }), input({ attribution: attribution({ clientId: { $gt: '' } }) }),
    { ...input(), extra: true }, null, 'x']) {
    await assert.rejects(p.persistAtomically(bad));
  }
  await assert.rejects(p.lookup({ ...key(), realm: 'preview' }));
  await assert.rejects(p.lookup({ ...key(), field: { $exists: true } }));
  assert.equal(touched.session, 0);
});

test('BE13-06A V3 persistence refuses construction without a connected database or with a bad prefix/realm', () => {
  assert.throws(() => createMongoMeasurementPersistence({ connection: {}, prefix: 'agro_ingest_adv', realm: 'test' }), TypeError);
  assert.throws(() => createMongoMeasurementPersistence({ connection: sealedConnection().connection, prefix: 'production', realm: 'test' }));
  assert.throws(() => createMongoMeasurementPersistence({ connection: sealedConnection().connection, prefix: 'agro_ingest_adv', realm: 'tenant-a' }));
});

test('BE13-06A V4 structural key collisions are impossible by encoding', () => {
  const pairs = [[key({ sourceId: 'a', eventId: 'b:c' }), key({ sourceId: 'a:b', eventId: 'c' })],
    [key({ eventId: 'x', field: 'y,z' }), key({ eventId: 'x,y', field: 'z' })], [key({ realm: 'test' }), key({ realm: 'preview' })]];
  for (const [a, b] of pairs) assert.notEqual(idempotencyDocumentId(a), idempotencyDocumentId(b));
});

test('BE13-06A V5 fingerprint collision attempts: reordered keys equal; any declared change differs', () => {
  const base = technicalInputFingerprint('test', candidate({ payload: { a: 1, b: 2 } }), 'a');
  assert.equal(technicalInputFingerprint('test', candidate({ payload: { b: 2, a: 1 } }), 'a'), base);
  for (const variant of [{ payload: { a: 1, b: 3 } }, { payload: { a: 1, b: 2, c: null } }, { payload: { a: '1', b: 2 } }, { payload: { a: [1], b: 2 } }]) {
    assert.notEqual(technicalInputFingerprint('test', candidate(variant), 'a'), base, JSON.stringify(variant));
  }
});

test('BE13-06A V6 hostile Mongo results (proxies, getters, wrong types) fail closed', async () => {
  const hostileRows = [new Proxy({}, { get() { throw new Error('secret'); } }), { get realm() { throw new Error('x'); } }, 42, null];
  for (const row of hostileRows) {
    const store = createIngestionIdentityStoreFromCollections({ devices: { find: () => ({ limit: () => ({ toArray: async () => [row] }) }) }, associations: {} });
    await assert.rejects(store.findDevicesByKey({ realm: 'test', sourceId: 's', key: { kind: 'mqtt-clientid', value: 'v' }, limit: 2 }));
  }
  const throwing = createIngestionIdentityStoreFromCollections({ devices: { find: () => { throw new Error('mongodb://u:p@h'); } }, associations: {} });
  await assert.rejects(throwing.findDevicesByKey({ realm: 'test', sourceId: 's', key: { kind: 'mqtt-clientid', value: 'v' }, limit: 2 }));
});

test('BE13-06A V7 cross-client association and stale association never reach the store', async () => {
  const w = world({ history: [{ ...world().state.history[0] }, { ...world().state.history[0], id: 'assoc-B', clientId: 'client-B' }] });
  const p = createInMemoryPersistence();
  const { idempotency: _i, ...rest } = w.deps;
  const r = await createPersistentMeasurementIngestionComposition({ ...rest, persistence: p }).ingest(candidate(), { field: 'temperature' });
  assert.deepEqual([r.reason, r.cause, p.claims.size], ['trust-gate-rejected', 'overlapping-association', 0]);
  const s = world(); let n = 0; const store = s.deps.identityStore, orig = store.findAssociationsAt.bind(store);
  const stale = { findDevicesByKey: store.findDevicesByKey.bind(store), async findAssociationsAt(q) { n++; const o = await orig(q); if (n > 2) o.rows = o.rows.map(x => ({ ...x, revision: 9 })); return o; } };
  const { idempotency: _j, ...rest2 } = s.deps; const p2 = createInMemoryPersistence();
  const r2 = await createPersistentMeasurementIngestionComposition({ ...rest2, identityStore: stale, persistence: p2 }).ingest(candidate(), { field: 'temperature' });
  assert.deepEqual([r2.cause, p2.claims.size], ['stale-association', 0]);
});

test('BE13-06A V8 transaction replay: a lying store answering "persisted" twice cannot create two accepted results for one lookup-hit', async () => {
  const w = world(); const { idempotency: _i, ...rest } = w.deps;
  const p = createInMemoryPersistence();
  const composition = createPersistentMeasurementIngestionComposition({ ...rest, persistence: p });
  const first = await composition.ingest(candidate(), { field: 'temperature' });
  const replay = await composition.ingest(candidate(), { field: 'temperature' });
  assert.deepEqual([first.status, replay.status, replay.measurementId], ['accepted', 'duplicate', first.measurementId]);
});
