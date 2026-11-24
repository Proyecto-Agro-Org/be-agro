// BE13-06 — Offline tests for the Mongo identity store, atomic persistence
// identifiers, persistent composition and the local destination guard.
// Real MongoDB behaviour is covered by the separate local campaign
// (scripts/audit-be13-06-mongodb-local.ts via scripts/be11-local.ps1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIngestionIdentityStoreFromCollections, deviceFilter, associationAtFilter } from '../dist/src/repositories/mongo-ingestion-identity.store.js';
import { idempotencyDocumentId, measurementDocumentId } from '../dist/src/repositories/mongo-measurement-persistence.repository.js';
import { ingestionCollections, ingestionIndexes, idempotencyValidator, measurementValidator } from '../dist/src/models/ingestion-persistence.models.js';
import { createPersistentMeasurementIngestionComposition, createMeasurementIngestionComposition } from '../dist/src/services/measurement-ingestion-composition.service.js';
import { assertLocalMongoUri, assertLocalReplicaSetHello } from '../dist/scripts/be13-06/local-guard.js';
import { REALM, candidate, association, world, createInMemoryPersistence, deepFrozen } from '../test-support/be13-composition.fixtures.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const day = ms => new Date(ms);
const deviceDoc = (patch = {}) => ({ _id: 'test:device-1', realm: 'test', id: 'device-1', clientId: 'owner', sourceId: 'synthetic-ingest', keyKind: 'mqtt-clientid',
  keyValue: 'synthetic-device-001', verification: 'verified', verificationAuthority: 'x', lifecycle: 'active', version: 3, createdAt: day(1), updatedAt: day(2), ...patch });
const assocDoc = (patch = {}) => ({ _id: 'test:a', realm: 'test', id: 'a', revision: 1, clientId: 'client-A', sensorId: 's', fieldId: 'f', areaId: 'ar', validFrom: day(0),
  validTo: null, auditReason: 'x', physicalDeviceId: 'device-1', sourceId: 'synthetic-ingest', keyKind: 'mqtt-clientid', keyValue: 'synthetic-device-001', state: 'active', ...patch });

// Fake collections that record the exact filter and evaluate the subset of
// operators the store uses, so semantics (not only shapes) are checked offline.
function matches(doc, filter) {
  return Object.entries(filter).every(([k, v]) => {
    if (k === '$or') return v.some(f => matches(doc, f));
    if (v === null) return doc[k] === null;
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('$lte' in v) return doc[k] !== null && doc[k].getTime() <= v.$lte.getTime();
      if ('$gt' in v) return doc[k] !== null && doc[k].getTime() > v.$gt.getTime();
    }
    return v instanceof Date ? doc[k]?.getTime() === v.getTime() : doc[k] === v;
  });
}
function fakeCollections(deviceRows, associationRows, seen = []) {
  return {
    devices: { find(filter, options) { seen.push(['devices', filter, options]); return { limit: n => ({ toArray: async () => deviceRows.filter(d => matches(d, filter)).slice(0, n) }) }; } },
    associations: { find(filter, options) { seen.push(['associations', filter, options]);
      return { sort: () => ({ limit: n => ({ toArray: async () => associationRows.filter(a => matches(a, filter)).sort((x, y) => x.validFrom - y.validFrom).slice(0, n) }) }) }; } },
  };
}

// ---------------------------------------------------------------- C3 identity store
test('BE13-06 store: realm is inside every Mongo filter (not a post-filter)', async () => {
  const seen = [], store = createIngestionIdentityStoreFromCollections(fakeCollections([deviceDoc()], [assocDoc()], seen));
  await store.findDevicesByKey({ realm: 'test', sourceId: 'synthetic-ingest', key: { kind: 'mqtt-clientid', value: 'synthetic-device-001' }, limit: 2 });
  await store.findAssociationsAt({ realm: 'test', physicalDeviceId: 'device-1', at: 5, limit: 2 });
  assert.deepEqual(seen[0][1], { realm: 'test', sourceId: 'synthetic-ingest', keyKind: 'mqtt-clientid', keyValue: 'synthetic-device-001' });
  assert.equal(seen[1][1].realm, 'test');
  for (const [, , options] of seen) assert.deepEqual(options, { maxTimeMS: 3000, collation: { locale: 'simple' } });
  assert.deepEqual(deviceFilter('preview', 's', { kind: 'device-id', value: 'v' }).realm, 'preview');
});

test('BE13-06 store: same key in two realms never crosses', async () => {
  const rows = [deviceDoc(), deviceDoc({ _id: 'preview:device-1', realm: 'preview', id: 'device-p' })];
  const store = createIngestionIdentityStoreFromCollections(fakeCollections(rows, []));
  const key = { kind: 'mqtt-clientid', value: 'synthetic-device-001' };
  assert.deepEqual((await store.findDevicesByKey({ realm: 'test', sourceId: 'synthetic-ingest', key, limit: 2 })).rows.map(r => r.id), ['device-1']);
  assert.deepEqual((await store.findDevicesByKey({ realm: 'preview', sourceId: 'synthetic-ingest', key, limit: 2 })).rows.map(r => r.id), ['device-p']);
});

test('BE13-06 store: [validFrom, validTo) with A→B→A at 199/200/299/300', async () => {
  const rows = [assocDoc({ id: 'A1', clientId: 'A', validFrom: day(100), validTo: day(200), state: 'closed' }),
    assocDoc({ id: 'B', clientId: 'B', validFrom: day(200), validTo: day(300), state: 'closed' }), assocDoc({ id: 'A2', clientId: 'A', validFrom: day(300) })];
  const store = createIngestionIdentityStoreFromCollections(fakeCollections([], rows));
  const at = async t => (await store.findAssociationsAt({ realm: 'test', physicalDeviceId: 'device-1', at: t, limit: 2 })).rows.map(r => r.clientId);
  assert.deepEqual([await at(99), await at(199), await at(200), await at(299), await at(300)], [[], ['A'], ['B'], ['B'], ['A']]);
  const filter = associationAtFilter('test', 'device-1', 200);
  assert.deepEqual([filter.validFrom.$lte.getTime(), filter.$or[0], filter.$or[1].validTo.$gt.getTime()], [200, { validTo: null }, 200]);
});

test('BE13-06 store: ambiguity is reported (limit 2), never resolved by picking', async () => {
  const store = createIngestionIdentityStoreFromCollections(fakeCollections([deviceDoc(), deviceDoc({ _id: 'test:x', id: 'x' }), deviceDoc({ _id: 'test:y', id: 'y' })], []));
  const r = await store.findDevicesByKey({ realm: 'test', sourceId: 'synthetic-ingest', key: { kind: 'mqtt-clientid', value: 'synthetic-device-001' }, limit: 2 });
  assert.equal(r.rows.length, 2);
});

test('BE13-06 store: BE-11 documents map to epoch semantics; malformed documents fail closed', async () => {
  const ok = await createIngestionIdentityStoreFromCollections(fakeCollections([deviceDoc()], [])).findDevicesByKey({ realm: 'test', sourceId: 'synthetic-ingest',
    key: { kind: 'mqtt-clientid', value: 'synthetic-device-001' }, limit: 2 });
  assert.deepEqual(ok.rows[0], { realm: 'test', id: 'device-1', sourceId: 'synthetic-ingest', key: { kind: 'mqtt-clientid', value: 'synthetic-device-001' },
    verification: 'verified', lifecycle: 'active', version: 3, createdAt: 1, updatedAt: 2 });
  for (const bad of [{ version: -1 }, { lifecycle: 'zombie' }, { createdAt: 'yesterday' }, { createdAt: new Date(NaN) }, { verification: 'maybe' }, { id: '' }, { version: 1.5 }]) {
    const store = createIngestionIdentityStoreFromCollections(fakeCollections([deviceDoc(bad)], []));
    await assert.rejects(store.findDevicesByKey({ realm: 'test', sourceId: 'synthetic-ingest', key: { kind: 'mqtt-clientid', value: 'synthetic-device-001' }, limit: 2 }));
  }
  const badAssoc = createIngestionIdentityStoreFromCollections(fakeCollections([], [assocDoc({ state: 'active', validTo: day(9) })]));
  await assert.rejects(badAssoc.findAssociationsAt({ realm: 'test', physicalDeviceId: 'device-1', at: 5, limit: 2 }));
});

test('BE13-06 store: invalid or injected queries are rejected before touching Mongo', async () => {
  const seen = [], store = createIngestionIdentityStoreFromCollections(fakeCollections([deviceDoc()], [], seen));
  for (const q of [{ realm: 'tenant-a', sourceId: 's', key: { kind: 'mqtt-clientid', value: 'v' }, limit: 2 },
    { realm: 'test', sourceId: { $ne: null }, key: { kind: 'mqtt-clientid', value: 'v' }, limit: 2 },
    { realm: 'test', sourceId: 's', key: { kind: 'mqtt-clientid', value: { $gt: '' } }, limit: 2 },
    { realm: 'test', sourceId: 's', key: { kind: 'mqtt-clientid', value: 'v' }, limit: 3 },
    { sourceId: 's', key: { kind: 'mqtt-clientid', value: 'v' }, limit: 2 }]) await assert.rejects(store.findDevicesByKey(q));
  await assert.rejects(store.findAssociationsAt({ realm: 'test', physicalDeviceId: 'd', at: -1, limit: 2 }));
  assert.equal(seen.length, 0);
});

// ---------------------------------------------------------------- C4 identifiers and schema
test('BE13-06 ids: deterministic, realm-scoped, collision-safe encoding', () => {
  const k = { realm: 'test', sourceId: 'a:b', operation: 'measurement', eventId: 'c', field: 'f' };
  assert.equal(idempotencyDocumentId(k), idempotencyDocumentId({ ...k }));
  assert.match(idempotencyDocumentId(k), /^[0-9a-f]{64}$/);
  assert.match(measurementDocumentId(k), /^m_[0-9a-f]{64}$/);
  const variants = [{ ...k, realm: 'preview' }, { ...k, sourceId: 'a', eventId: 'b:c' }, { ...k, field: 'g' }, { ...k, operation: 'device-status' }];
  for (const v of variants) assert.notEqual(idempotencyDocumentId(v), idempotencyDocumentId(k));
});

test('BE13-06 schema: collections, strict validators and unique key indexes', () => {
  assert.deepEqual(ingestionCollections('agro_ingest_x'), { idempotency: 'agro_ingest_x_idempotency', measurements: 'agro_ingest_x_measurements' });
  assert.throws(() => ingestionCollections('prod'));
  assert.equal(idempotencyValidator.$jsonSchema.additionalProperties, false);
  assert.equal(measurementValidator.$jsonSchema.additionalProperties, false);
  assert.ok(measurementValidator.$jsonSchema.required.includes('storedAt') && measurementValidator.$jsonSchema.properties.event.required.includes('persistedAt'));
  for (const list of Object.values(ingestionIndexes)) {
    assert.equal(list.length, 1); assert.equal(list[0].unique, true);
    assert.deepEqual(Object.keys(list[0].key), ['realm', 'sourceId', 'operation', 'eventId', 'field']);
  }
});

// ---------------------------------------------------------------- persistent composition
const persistentDeps = (w, persistence = createInMemoryPersistence(w.calls)) => {
  const { idempotency: _ignored, ...rest } = w.deps;
  return { ...rest, persistence };
};

test('BE13-06 persistent composition: first → persisted:true with measurementId; retry → duplicate with the same reference', async () => {
  const w = world(), p = createInMemoryPersistence(w.calls), composition = createPersistentMeasurementIngestionComposition(persistentDeps(w, p));
  const first = await composition.ingest(candidate(), { field: 'temperature' });
  assert.deepEqual([first.status, first.persisted], ['accepted', true]);
  assert.match(first.measurementId, /^m_/);
  const retry = await composition.ingest(candidate({}, { receivedAt: 1795115700000, persistedAt: 1795115700010 }), { field: 'temperature' });
  assert.deepEqual([retry.status, retry.measurementId], ['duplicate', first.measurementId]);
  assert.deepEqual([p.claims.size, p.measurements.size], [1, 1]);
  assert.equal(deepFrozen(first), true);
});

test('BE13-06 persistent composition: conflict writes nothing', async () => {
  const w = world(), p = createInMemoryPersistence(), composition = createPersistentMeasurementIngestionComposition(persistentDeps(w, p));
  await composition.ingest(candidate(), { field: 'temperature' });
  const r = await composition.ingest(candidate({ payload: { temperature: 5, soil_moisture: null } }), { field: 'temperature' });
  assert.equal(r.reason, 'idempotency-conflict');
  assert.deepEqual([p.claims.size, p.measurements.size], [1, 1]);
});

test('BE13-06 persistent composition: attribution drift never reaches the store', async () => {
  const w = world(), p = createInMemoryPersistence(w.calls);
  const be12 = { resolve: async e => { w.state.history = [association({ clientId: 'client-Z' })]; return w.deps.be12.resolve(e); } };
  const r = await createPersistentMeasurementIngestionComposition({ ...persistentDeps(w, p), be12 }).ingest(candidate(), { field: 'temperature' });
  assert.deepEqual([r.reason, r.cause], ['attribution-drift', 'clientId']);
  assert.equal(w.calls.some(([n]) => n === 'persist:atomic'), false);
  assert.deepEqual([p.claims.size, p.measurements.size], [0, 0]);
});

test('BE13-06 persistent composition: store failures, malformed outcomes and realm crossing fail closed', async () => {
  const w = world();
  const throwing = { lookup: async k => ({ realm: k.realm, status: 'absent' }), persistAtomically: async () => { throw new Error('mongodb://secret'); } };
  const r1 = await createPersistentMeasurementIngestionComposition(persistentDeps(w, throwing)).ingest(candidate(), { field: 'temperature' });
  assert.deepEqual([r1.reason, JSON.stringify(r1).includes('secret')], ['persistence-unavailable', false]);
  const malformed = { lookup: async k => ({ realm: k.realm, status: 'absent' }), persistAtomically: async k => ({ realm: k.key.realm, status: 'persisted', measurementId: 'x' }) };
  assert.equal((await createPersistentMeasurementIngestionComposition(persistentDeps(world(), malformed)).ingest(candidate(), { field: 'temperature' })).reason, 'persistence-unavailable');
  const foreign = { lookup: async () => ({ realm: 'production', status: 'absent' }), persistAtomically: async () => ({}) };
  const r3 = await createPersistentMeasurementIngestionComposition(persistentDeps(world(), foreign)).ingest(candidate(), { field: 'temperature' });
  assert.deepEqual([r3.reason, r3.cause], ['realm-mismatch', 'persistence']);
});

test('BE13-06 persistent composition: persistence is mandatory; claim mode is unchanged', async () => {
  const w = world();
  assert.throws(() => createPersistentMeasurementIngestionComposition({ ...persistentDeps(w), persistence: undefined }), TypeError);
  assert.throws(() => createPersistentMeasurementIngestionComposition({ ...persistentDeps(w), persistence: { lookup: async () => ({}) } }), TypeError);
  const claim = await createMeasurementIngestionComposition(w.deps).ingest(candidate(), { field: 'temperature' });
  assert.deepEqual([claim.status, claim.persisted, Object.hasOwn(claim, 'measurementId')], ['accepted', false, false]);
});

// ---------------------------------------------------------------- local destination guard
test('BE13-06 guard: only the owned loopback replica set is accepted', () => {
  assertLocalMongoUri('mongodb://127.0.0.1:27059/agro_db02_test_abc?directConnection=true&replicaSet=agro_db02', 27059);
  for (const uri of ['mongodb+srv://cluster0.abcd.mongodb.net/db', 'mongodb://cluster0-shard-00-00.abcd.mongodb.net:27017/db?directConnection=true&replicaSet=agro_db02',
    'mongodb://10.0.0.5:27059/db?directConnection=true&replicaSet=agro_db02', 'mongodb://user:pass@127.0.0.1:27059/db?directConnection=true&replicaSet=agro_db02',
    'mongodb://127.0.0.1:27059/db?replicaSet=agro_db02', 'mongodb://127.0.0.1:27059/db?directConnection=true&replicaSet=prod',
    'mongodb://127.0.0.1:27059/db?directConnection=true&replicaSet=agro_db02&tls=true', 'mongodb://localhost:27059/db?directConnection=true&replicaSet=agro_db02',
    'mongodb://127.0.0.1:27060/db?directConnection=true&replicaSet=agro_db02', '']) assert.throws(() => assertLocalMongoUri(uri, 27059), uri);
  assertLocalReplicaSetHello({ setName: 'agro_db02', isWritablePrimary: true, hosts: ['localhost:27017'] });
  for (const hello of [{ msg: 'isdbgrid' }, { setName: 'atlas-x', isWritablePrimary: true, hosts: ['localhost:27017'] },
    { setName: 'agro_db02', isWritablePrimary: false, hosts: ['localhost:27017'] }, { setName: 'agro_db02', isWritablePrimary: true, hosts: ['10.1.1.1:27017'] },
    { setName: 'agro_db02', isWritablePrimary: true, hosts: ['localhost:27017', 'localhost:27018'] }]) assert.throws(() => assertLocalReplicaSetHello(hello));
});

test('BE13-06 runtime isolation: not exposed by app/routes; no env URIs or hardcoded hosts in repositories', () => {
  const app = [readFileSync(join(root, 'src', 'app.ts'), 'utf8'), ...readdirSync(join(root, 'src', 'routes')).map(f => readFileSync(join(root, 'src', 'routes', f), 'utf8'))];
  for (const text of app) for (const token of ['mongo-ingestion-identity', 'mongo-measurement-persistence', 'ingestion-persistence', 'measurement-ingestion-composition'])
    assert.equal(text.includes(token), false, token);
  for (const file of ['repositories/mongo-ingestion-identity.store.ts', 'repositories/mongo-measurement-persistence.repository.ts', 'models/ingestion-persistence.models.ts']) {
    const text = readFileSync(join(root, 'src', file), 'utf8');
    for (const forbidden of ['process.env', 'mongodb://', 'mongodb+srv', 'openUri', 'createConnection', 'Date.now', 'Math.random']) assert.equal(text.includes(forbidden), false, `${file}: ${forbidden}`);
  }
  assert.equal(REALM, 'test');
});
