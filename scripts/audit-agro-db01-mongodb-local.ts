import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Mongoose, mongo, type Connection } from 'mongoose';
import { validateLocalAuditRequest } from './audit-auth-mongodb-local.js';
import { buildIngestMeasurementFilter, mapIngestMeasurementMetadata } from '../src/repositories/telemetry-metadata.mapper.js';

export function validateDb01AuditRequest(environment: Record<string, unknown>) {
  const local = validateLocalAuditRequest(environment);
  if (environment.AGRO_DB01_LOCAL_AUDIT !== 'AUTHORIZED_DISPOSABLE_DB01_ONLY') throw new Error('DB01_LOCAL_AUDIT_NOT_AUTHORIZED');
  return local;
}
// Opt-in only; never mounted/imported by runtime or executed positively by tests.
// Isolated fixture namespaces, NOT proposed production collection/model names.
export async function auditDb01LocalMongo(environment: Record<string, unknown> = process.env) {
  const local = validateDb01AuditRequest(environment), name = 'agro_db01_audit_' + randomBytes(12).toString('hex');
  const connections: Connection[] = [], created: string[] = [];
  console.info(JSON.stringify({ event: 'db01_disposable_scope', database: name }));
  const uri = 'mongodb://127.0.0.1:' + local.port + '/' + name +
    (local.replicaSet ? '?replicaSet=' + encodeURIComponent(local.replicaSet) : '');
  async function connect() {
    const c = new Mongoose().createConnection(); connections.push(c); c.on('error', () => {});
    await c.openUri(uri, { directConnection: true, autoCreate: false, autoIndex: false, bufferCommands: false,
      serverSelectionTimeoutMS: 3000, connectTimeoutMS: 3000, socketTimeoutMS: 5000,
      retryReads: false, retryWrites: false, maxPoolSize: 2, minPoolSize: 0 });
    assert.equal(c.name, name); return c;
  }
  try {
    const first = await connect(), db = first.db; assert.ok(db); assert.equal(db.databaseName, name);
    assert.equal((await db.listCollections({}, { nameOnly: true }).toArray()).length, 0);
    for (const collection of ['db01_business_associations', 'db01_ingest_devices', 'db01_ingest_measurements']) {
      await db.createCollection(collection, { collation: { locale: 'simple' } }); created.push(collection);
    }
    const business = db.collection('db01_business_associations'), devices = db.collection('db01_ingest_devices');
    const raw = db.collection('db01_ingest_measurements');
    await business.createIndex({ realm: 1, id: 1 }, { unique: true });
    await devices.createIndex({ clientid: 1 }, { unique: true });
    await raw.createIndex({ clientid: 1, _receivedAt: -1, _id: -1 });
    await devices.insertOne({ clientid: 'synthetic-device' });
    await assert.rejects(devices.insertOne({ clientid: 'synthetic-device' }),
      (error: unknown) => error instanceof mongo.MongoServerError && error.code === 11000);
    await business.insertMany([
      { realm: 'test', id: 'window-a', clientId: 'client-a', validFrom: new Date(100), validTo: new Date(500) },
      { realm: 'test', id: 'window-b', clientId: 'client-b', validFrom: new Date(500), validTo: new Date(1000) },
    ]);
    await raw.insertMany([
      { clientid: 'synthetic-device', _receivedAt: new Date(300), timestamp: '2999-01-01', cliente_id: 'forged-b' },
      { clientid: 'synthetic-device', _receivedAt: new Date(600), timestamp: '1900-01-01', cliente_id: 'forged-a' },
      { clientid: ['synthetic-device'], _receivedAt: new Date(300) },
      { clientid: 'synthetic-device', _receivedAt: [new Date(300)] },
      { clientid: 'another-device', _receivedAt: new Date(300) },
    ]);
    const second = await connect(); assert.ok(second.db);
    const key = { kind: 'mqtt-clientid' as const, value: 'synthetic-device' };
    const [a, b] = await Promise.all([
      raw.find(buildIngestMeasurementFilter({ deviceField: 'clientid', device: key, from: 100, to: 500 })).sort({ _receivedAt: -1, _id: -1 }).limit(10).toArray(),
      second.db.collection('db01_ingest_measurements').find(buildIngestMeasurementFilter({ deviceField: 'clientid', device: key, from: 500, to: 1000 })).limit(10).toArray(),
    ]);
    assert.equal(a.length, 1); assert.equal(b.length, 1);
    assert.equal(mapIngestMeasurementMetadata(a[0], 'clientid', key).receivedAt, 300);
    assert.equal(mapIngestMeasurementMetadata(b[0], 'clientid', key).receivedAt, 600);
    assert.notEqual(a[0]._id.toString(), b[0]._id.toString());
    return { database: name, checks: ['device_unique', 'bounded_windows', 'scalar_guards', 'metadata_types', 'two_connections'],
      limitation: 'Synthetic fixtures only. Does NOT verify current IoT attribution, association writer atomicity, two OS processes or distributed durability.' };
  } finally {
    let failed = false; const owner = connections[0];
    if (created.length && owner?.db && owner.name === name && owner.db.databaseName === name && /^agro_db01_audit_[a-f0-9]{24}$/.test(name)) {
      for (const collection of created) {
        if (!/^db01_(business_associations|ingest_devices|ingest_measurements)$/.test(collection)) { failed = true; continue; }
        try { await owner.db.dropCollection(collection); } catch { failed = true; }
      }
    } else if (created.length) failed = true;
    for (const c of connections) try { await c.close(); } catch { failed = true; }
    if (failed) throw new Error('DB01_OWNED_CLEANUP_UNCONFIRMED');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify({ ...await auditDb01LocalMongo(), cleanup: 'owned collections removed' })); }
  catch { console.error('DB01_LOCAL_AUDIT_NOT_COMPLETED; verify explicit authorization, disposable instance and owned cleanup.'); process.exitCode = 1; }
}
