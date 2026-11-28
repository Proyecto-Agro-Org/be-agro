import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Mongoose, type Connection } from 'mongoose';
import { validateLocalAuditRequest } from './audit-auth-mongodb-local.js';
import { defineIdentityCatalogueModels } from '../src/models/identity-catalogue.models.js';
import { catalogueCollectionValidators } from '../src/models/identity-catalogue.validators.js';
import { defineAuthenticationModels } from '../src/models/authentication.models.js';
import { createMongooseIdentityCatalogueStore } from '../src/repositories/mongoose-identity-catalogue.store.js';
import { createMongooseSessionRepository } from '../src/repositories/mongoose-session.repository.js';
import { createMongooseCatalogueSessionInvalidator } from '../src/repositories/mongoose-session-invalidator.repository.js';
import { createIdentityCatalogueAdministration } from '../src/services/identity-catalogue-admin.service.js';
import { createIdentityCatalogue } from '../src/repositories/identity-catalogue.repository.js';
import { createSessionService } from '../src/services/session.service.js';
import { validateAuthenticationPersistenceConfig } from '../src/config/authentication-persistence.js';

export function validateCatalogueAuditRequest(environment: Record<string, unknown>) {
  const local = validateLocalAuditRequest(environment);
  if (environment.AGRO_CATALOGUE_LOCAL_AUDIT !== 'AUTHORIZED_DISPOSABLE_CATALOGUE_ONLY') throw new Error('LOCAL_CATALOGUE_AUDIT_NOT_AUTHORIZED');
  return local;
}
// Manual positive test only, NEVER part of app.ts/npm test. Requires a dedicated
// approved local instance; it creates/drops only its four disposable collections.
export async function auditLocalCatalogueMongo(environment: Record<string, unknown> = process.env) {
  const local = validateCatalogueAuditRequest(environment); // Before any socket.
  const name = 'agro_catalogue_audit_' + randomBytes(12).toString('hex');
  console.info(JSON.stringify({ event: 'local_catalogue_audit_scope', database: name }));
  const options = validateAuthenticationPersistenceConfig({ collectionPrefix: 'agro_auth_catalogue_manual', realm: 'test' });
  const connections: Connection[] = [], created: string[] = [];
  const uri = 'mongodb://127.0.0.1:' + local.port + '/' + name +
    (local.replicaSet ? '?replicaSet=' + encodeURIComponent(local.replicaSet) : '');
  async function connect() {
    const c = new Mongoose().createConnection(); connections.push(c); c.on('error', () => {});
    await c.openUri(uri, { directConnection: true, autoCreate: false, autoIndex: false, bufferCommands: false,
      serverSelectionTimeoutMS: 3000, connectTimeoutMS: 3000, socketTimeoutMS: 5000,
      maxPoolSize: 3, minPoolSize: 0, retryReads: false, retryWrites: false });
    assert.equal(c.name, name); return c;
  }
  try {
    const first = await connect(), db = first.db; assert.ok(db);
    assert.equal((await db.listCollections({}, { nameOnly: true }).toArray()).length, 0);
    const models = defineIdentityCatalogueModels(first, options), auth = defineAuthenticationModels(first, options);
    for (const model of [models.users, models.clients, auth.sessions, auth.challenges]) {
      const collection = model.collection.name;
      const validator = collection.endsWith('_users') ? catalogueCollectionValidators.users :
        collection.endsWith('_clients') ? catalogueCollectionValidators.clients : undefined;
      await db.createCollection(collection, { collation: { locale: 'simple' }, ...(validator ? { validator, validationLevel: 'strict', validationAction: 'error' } : {}) });
      created.push(collection);
      for (const [keys, settings] of model.schema.indexes()) {
        const ascending = Object.fromEntries(Object.entries(keys).map(([key, direction]) => {
          assert.equal(direction, 1); return [key, 1 as const];
        }));
        assert.equal(typeof settings.name, 'string');
        assert.ok(settings.unique === undefined || typeof settings.unique === 'boolean');
        await db.collection(collection).createIndex(ascending, { name: settings.name, unique: settings.unique === true,
          collation: { locale: 'simple' },
          ...(typeof settings.expireAfterSeconds === 'number' ? { expireAfterSeconds: settings.expireAfterSeconds } : {}) });
      }
    }
    async function worker(c: Connection) {
      const p = await createMongooseIdentityCatalogueStore(c, options);
      const invalidator = createMongooseCatalogueSessionInvalidator(c, options);
      return { ...p, admin: createIdentityCatalogueAdministration({ store: p.administration, invalidator }, 'test') };
    }
    const a = await worker(first), b = await worker(await connect());
    for (const id of ['client-a', 'client-b']) await a.admin.createClient({ id, name: 'Synthetic local audit client' });
    const input = { issuer: 'https://accounts.google.com' as const, subject: 'synthetic-local-subject',
      name: 'Synthetic local user', email: 'synthetic@example.invalid', clientId: 'client-a' };
    const registrations = await Promise.allSettled([a.admin.createUser({ ...input, id: 'user-a' }), b.admin.createUser({ ...input, id: 'user-b' })]);
    const winners = registrations.filter(r => r.status === 'fulfilled'); assert.equal(winners.length, 1);
    const userId = winners[0].value.id;
    const changes = await Promise.allSettled([a.admin.changeMembership({ userId, expectedVersion: 0, clientId: 'client-b' }),
      b.admin.changeMembership({ userId, expectedVersion: 0, clientId: null })]);
    assert.equal(changes.filter(r => r.status === 'fulfilled').length, 1);
    await a.admin.changeMembership({ userId, expectedVersion: 1, clientId: 'client-a' });
    const repository = await createMongooseSessionRepository(first, options);
    // Fake identity verifier is confined to this manual disposable test script.
    const service = createSessionService({ repository, catalogue: createIdentityCatalogue(b.store, 'test'),
      verifier: { async verify() { return { status: 'verified', identity: { issuer: input.issuer, subject: input.subject } }; } } },
    { realm: 'test', audience: '123-local-audit.apps.googleusercontent.com', allowedOrigins: ['http://127.0.0.1:3000'],
      challengeTtlMs: 300000, absoluteTtlMs: 28800000, idleTtlMs: 1800000 });
    const attempt = await service.challenge(), session = await service.login('synthetic-local-only', attempt.challengeId);
    await a.admin.setClientActive({ clientId: 'client-a', expectedVersion: 0, active: false });
    await a.admin.setClientActive({ clientId: 'client-a', expectedVersion: 1, active: true });
    await assert.rejects(service.authorization.authenticate(session.token));
    await a.admin.changeMembership({ userId, expectedVersion: 2, clientId: 'client-a' });
    await assert.rejects(service.authorization.authenticate(session.token));
    const row = await b.administration.findUser(userId); assert.equal(row?.securityVersion, 3); assert.equal(row.membership?.clientSecurityVersion, 2);
    await assert.rejects(db.collection(models.users.collection.name).updateOne({ id: userId }, { $set: { securityVersion: [3] } }));
    return { database: name, checks: ['unique_principal', 'cas_two_connections', 'client_generation', 'stale_session', 'bson_validator'],
      limitation: 'One OS process/two connections; failover, distributed durability and E2E remain unverified.' };
  } finally {
    let failed = false; const owner = connections[0];
    if (created.length && owner?.db && owner.name === name && owner.db.databaseName === name && /^agro_catalogue_audit_[a-f0-9]{24}$/.test(name)) {
      for (const collection of created) {
        if (!/^agro_auth_catalogue_manual_(users|clients|sessions|challenges)$/.test(collection)) { failed = true; continue; }
        try { await owner.db.dropCollection(collection); } catch { failed = true; }
      }
    } else if (created.length) failed = true;
    for (const c of connections) try { await c.close(); } catch { failed = true; }
    if (failed) throw new Error('LOCAL_CATALOGUE_CLEANUP_UNCONFIRMED');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify({ ...await auditLocalCatalogueMongo(), cleanup: 'owned collections removed' })); }
  catch { console.error('LOCAL_CATALOGUE_AUDIT_NOT_COMPLETED; verify authorization, dedicated instance and owned cleanup.'); process.exitCode = 1; }
}
