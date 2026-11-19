// Manual opt-in verification only. Never imported by app.ts or run by npm test.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Mongoose, type Connection } from 'mongoose';
import { digestSecret } from '../src/auth/session-security.js';
import { validateAuthenticationPersistenceConfig } from '../src/config/authentication-persistence.js';
import { defineAuthenticationModels, type SessionDocument } from '../src/models/authentication.models.js';
import { createMongooseSessionRepository } from '../src/repositories/mongoose-session.repository.js';

export function validateLocalAuditRequest(environment: Record<string, unknown>) {
  if (environment.AGRO_AUTH_LOCAL_AUDIT !== 'AUTHORIZED_DISPOSABLE_LOOPBACK_ONLY') throw new Error('LOCAL_AUTH_AUDIT_NOT_AUTHORIZED');
  const value = environment.AGRO_AUTH_LOCAL_PORT ?? '27017';
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value) || Number(value) < 1024 || Number(value) > 65535) throw new Error('INVALID_LOCAL_AUDIT_PORT');
  const replicaSet = environment.AGRO_AUTH_LOCAL_REPLICA_SET;
  if (replicaSet !== undefined && (typeof replicaSet !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(replicaSet))) throw new Error('INVALID_LOCAL_AUDIT_REPLICA_SET');
  return Object.freeze({ port: Number(value), replicaSet });
}

export async function auditLocalAuthenticationMongo(environment: Record<string, unknown> = process.env) {
  const request = validateLocalAuditRequest(environment); // Before any connection.
  const databaseName = 'agro_auth_audit_' + randomBytes(12).toString('hex');
  console.info(JSON.stringify({ event: 'local_auth_audit_scope', database: databaseName }));
  const config = validateAuthenticationPersistenceConfig({ collectionPrefix: 'agro_auth_manual', realm: 'test' });
  const query = request.replicaSet ? '?replicaSet=' + encodeURIComponent(request.replicaSet) : '';
  // Caller cannot supply a URI, remote host, credentials or an existing DB name.
  const uri = 'mongodb://127.0.0.1:' + request.port + '/' + databaseName + query;
  const connections: Connection[] = [], created: string[] = [];
  async function connect() {
    const connection = new Mongoose().createConnection(); connections.push(connection);
    connection.on('error', () => {});
    await connection.openUri(uri, { autoCreate: false, autoIndex: false, bufferCommands: false, directConnection: true,
      serverSelectionTimeoutMS: 3000, connectTimeoutMS: 3000, socketTimeoutMS: 5000,
      maxPoolSize: 3, minPoolSize: 0, retryWrites: false, retryReads: false });
    assert.equal(connection.name, databaseName);
    return connection;
  }
  try {
    const first = await connect(), db = first.db;
    assert.ok(db); assert.equal(db.databaseName, databaseName);
    assert.equal((await db.listCollections({}, { nameOnly: true }).toArray()).length, 0);
    const models = defineAuthenticationModels(first, config);
    for (const name of [models.challenges.collection.name, models.sessions.collection.name]) {
      await db.createCollection(name, { collation: { locale: 'simple' } }); created.push(name);
    }
    await models.sessions.collection.createIndex({ realm: 1, digest: 1 }, { unique: true, name: 'auth_session_digest_unique' });
    await models.sessions.collection.createIndex({ absoluteExpiresAt: 1 }, { expireAfterSeconds: 0, name: 'auth_session_expiry' });
    await models.challenges.collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'auth_challenge_expiry' });
    const a = await createMongooseSessionRepository(first, config);
    const b = await createMongooseSessionRepository(await connect(), config);
    const at = Date.now(), challenge = { realm: 'test', digest: digestSecret(randomBytes(32).toString('hex')),
      nonceDigest: digestSecret(randomBytes(32).toString('hex')), audience: '123-local-audit.apps.googleusercontent.com',
      expiresAt: at + 60000, consumedAt: null };
    await a.insertChallenge(challenge);
    const claims = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? a : b)
      .consumeChallenge(challenge.digest, challenge.nonceDigest, 'test', Date.now())));
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(await b.consumeChallenge(challenge.digest, challenge.nonceDigest, 'test', Date.now()), false);
    const session = { id: randomBytes(32).toString('hex'), realm: 'test', digest: digestSecret(randomBytes(32).toString('hex')),
      userId: 'offline-fixture-user', clientId: 'offline-fixture-client', securityVersion: 1, createdAt: Date.now(),
      absoluteExpiresAt: Date.now() + 120000, idleExpiresAt: Date.now() + 60000, revokedAt: null };
    await a.insertSession(session);
    await assert.rejects(b.insertSession({ ...session, id: randomBytes(32).toString('hex') }));
    const stored = await db.collection<SessionDocument>(models.sessions.collection.name).findOne({ digest: session.digest, realm: 'test' });
    assert.ok(stored);
    await assert.rejects(db.collection<SessionDocument>(models.sessions.collection.name).insertOne({ ...stored,
      _id: 'test:raw-duplicate', id: 'raw-duplicate' }), (error: unknown) =>
      typeof error === 'object' && error !== null && 'code' in error && error.code === 11000);
    assert.equal((await b.findSessionByDigest(session.digest, 'test'))?.id, session.id);
    await a.revokeSession(session.digest, 'test', Date.now());
    assert.equal(typeof (await b.findSessionByDigest(session.digest, 'test'))?.revokedAt, 'number');
    assert.equal(await b.touchSession(session.id, 'test', Date.now(), Date.now() + 60000), null);
    const invalid = { ...challenge, digest: digestSecret(randomBytes(32).toString('hex')) };
    await a.insertChallenge(invalid);
    // Deliberately malformed fixture only in this newly created disposable DB.
    await db.collection(models.challenges.collection.name).updateOne({ digest: invalid.digest }, { $set: { consumedAt: [null] } });
    assert.equal(await b.consumeChallenge(invalid.digest, invalid.nonceDigest, 'test', Date.now()), false);
    const info: unknown = await db.command({ buildInfo: 1 });
    const version = typeof info === 'object' && info !== null && 'version' in info && typeof info.version === 'string' ? info.version : 'unknown';
    assert.notEqual(version, 'unknown');
    return { database: databaseName, version, checks: ['unique_digest', 'single_claim_two_connections', 'replay', 'revocation', 'scalar_null'],
      note: 'Single-process/two-connection probe; not a failover or distributed durability certification.' };
  } finally {
    let cleanupFailed = false;
    const owner = connections[0];
    if (created.length && owner?.db && owner.name === databaseName && owner.db.databaseName === databaseName && /^agro_auth_audit_[a-f0-9]{24}$/.test(databaseName)) {
      for (const name of created) {
        if (!/^agro_auth_manual_(challenges|sessions)$/.test(name)) { cleanupFailed = true; continue; }
        try { await owner.db.dropCollection(name); } catch { cleanupFailed = true; }
      }
    } else if (created.length) cleanupFailed = true;
    for (const connection of connections) { try { await connection.close(); } catch { cleanupFailed = true; } }
    if (cleanupFailed) throw new Error('LOCAL_AUTH_AUDIT_CLEANUP_UNCONFIRMED');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify({ ...await auditLocalAuthenticationMongo(), cleanup: 'owned collections removed' })); }
  catch { console.error('LOCAL_AUTH_MONGODB_AUDIT_NOT_COMPLETED; verify opt-in, dedicated local instance and cleanup.'); process.exitCode = 1; }
}
