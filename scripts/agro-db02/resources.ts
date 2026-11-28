import assert from 'node:assert/strict';
import { Mongoose, type Connection } from 'mongoose';
import { db02Uri, validateDb02Database, type LocalRequest } from './guard.js';
import { validateAuthenticationPersistenceConfig } from '../../src/config/authentication-persistence.js';
import { defineAuthenticationModels } from '../../src/models/authentication.models.js';
import { defineIdentityCatalogueModels } from '../../src/models/identity-catalogue.models.js';
import { catalogueCollectionValidators } from '../../src/models/identity-catalogue.validators.js';
import { createMongooseSessionRepository } from '../../src/repositories/mongoose-session.repository.js';
import { createMongooseIdentityCatalogueStore } from '../../src/repositories/mongoose-identity-catalogue.store.js';
import { createMongooseCatalogueSessionInvalidator } from '../../src/repositories/mongoose-session-invalidator.repository.js';
import { createIdentityCatalogueAdministration } from '../../src/services/identity-catalogue-admin.service.js';
import { createIdentityCatalogue } from '../../src/repositories/identity-catalogue.repository.js';

export const collectionNames = ['agro_auth_db02_users', 'agro_auth_db02_clients', 'agro_auth_db02_sessions', 'agro_auth_db02_challenges',
  'db02_business_associations', 'db02_ingest_devices', 'db02_ingest_measurements'] as const;
export const persistence = (realm = 'test') => validateAuthenticationPersistenceConfig({ collectionPrefix: 'agro_auth_db02', realm });
export async function connectOwned(request: LocalRequest, database: string) {
  validateDb02Database(database, request);
  const connection = new Mongoose().createConnection(); connection.on('error', () => {});
  try {
    await connection.openUri(db02Uri(request, database), { directConnection: true, family: 4, autoCreate: false, autoIndex: false,
      bufferCommands: false, retryReads: false, retryWrites: false, serverSelectionTimeoutMS: 3000,
      connectTimeoutMS: 3000, socketTimeoutMS: 5000, maxPoolSize: 3, minPoolSize: 0 });
    assert.equal(connection.name, database); assert.ok(connection.db);
    const hello = await connection.db.command({ hello: 1 }, { timeoutMS: 3000 });
    if (hello.msg === 'isdbgrid' || (hello.hosts ?? []).some((host: string) => !/^(localhost|127\.0\.0\.1):27017$/.test(host))) throw new Error('DB02_REDIRECTED_TOPOLOGY');
    if (request.topology === 'single-node-replica-set') { assert.equal(hello.setName, 'agro_db02'); assert.equal(hello.isWritablePrimary, true); }
    else assert.equal(hello.setName, undefined);
    return connection;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '';
    const category = message.includes('ECONNREFUSED') ? 'connection-refused' : message.includes('ETIMEDOUT') ? 'connection-timeout' :
      message === 'DB02_REDIRECTED_TOPOLOGY' ? 'unexpected-topology' : 'connection-or-hello-failed';
    console.info(JSON.stringify({ event: 'db02-connection-error', category,
      errorClass: error instanceof Error && /^[A-Za-z]+$/.test(error.name) ? error.name : 'UnknownError' }));
    await connection.close().catch(() => {}); throw new Error('DB02_OWNED_CONNECTION_FAILED');
  }
}
export async function provisionOwned(connection: Connection, created: string[]) {
  const db = connection.db!;
  assert.equal((await db.listCollections({}, { nameOnly: true }).toArray()).length, 0);
  const models = { ...defineIdentityCatalogueModels(connection, persistence()), ...defineAuthenticationModels(connection, persistence()) };
  for (const model of Object.values(models)) {
    const name = model.collection.name;
    assert.ok(collectionNames.includes(name as typeof collectionNames[number]));
    const validator = name.endsWith('_users') ? catalogueCollectionValidators.users : name.endsWith('_clients') ? catalogueCollectionValidators.clients : undefined;
    console.info(JSON.stringify({ event: 'db02-provision', collection: name, action: 'createCollection' }));
    await db.createCollection(name, { collation: { locale: 'simple' }, ...(validator ? { validator, validationLevel: 'strict', validationAction: 'error' } : {}) });
    created.push(name);
    for (const [keys, settings] of model.schema.indexes()) {
      console.info(JSON.stringify({ event: 'db02-provision', collection: name, index: settings.name, action: 'createIndex' }));
      const key = Object.fromEntries(Object.entries(keys).map(([k, direction]) => { assert.equal(direction, 1); return [k, 1 as const]; }));
      await db.collection(name).createIndex(key, { name: settings.name, unique: settings.unique === true,
        collation: { locale: 'simple' }, ...(typeof settings.expireAfterSeconds === 'number' ? { expireAfterSeconds: settings.expireAfterSeconds } : {}) });
    }
  }
  for (const name of collectionNames.slice(4)) { await db.createCollection(name, { collation: { locale: 'simple' } }); created.push(name); }
  await db.collection('db02_ingest_devices').createIndex({ sourceId: 1, clientid: 1 }, { unique: true, name: 'db02_device_unique' });
  await db.collection('db02_ingest_measurements').createIndex({ clientid: 1, _receivedAt: -1, _id: -1 }, { name: 'db02_history' });
  await db.collection('db02_business_associations').createIndex({ realm: 1, clientId: 1, fieldId: 1, areaId: 1, sensorId: 1, validFrom: 1 });
  await db.collection('db02_business_associations').createIndex({ realm: 1, sourceId: 1, 'device.kind': 1, 'device.value': 1, validFrom: 1 });
}
export async function realPorts(connection: Connection, realm = 'test') {
  const options = persistence(realm), catalogue = await createMongooseIdentityCatalogueStore(connection, options);
  const repository = await createMongooseSessionRepository(connection, options);
  const invalidator = createMongooseCatalogueSessionInvalidator(connection, options);
  return { ...catalogue, repository, invalidator, catalogue: createIdentityCatalogue(catalogue.store, realm),
    admin: createIdentityCatalogueAdministration({ store: catalogue.administration, invalidator }, realm) };
}
