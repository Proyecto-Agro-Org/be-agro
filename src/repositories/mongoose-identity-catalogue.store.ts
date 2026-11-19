import { mongo, type Connection } from 'mongoose';
import { z } from 'zod';
import type { IdentityCatalogueStore } from '../auth/identity-catalogue.contracts.js';
import type { IdentityCatalogueAdministrationStore } from '../auth/identity-catalogue-admin.contracts.js';
import { managedUserSchema, managedClientSchema } from '../auth/identity-catalogue.schemas.js';
import { checkedOutput, logicalKey } from '../auth/validation.js';
import { validateAuthenticationPersistenceConfig, type AuthenticationPersistenceConfig } from '../config/authentication-persistence.js';
import { ApplicationError, isApplicationErrorCode, type ApplicationErrorCode } from '../errors/application.error.js';
import { defineIdentityCatalogueModels, type CatalogueUserDocument, type CatalogueClientDocument } from '../models/identity-catalogue.models.js';
import { fromCatalogueUserDocument, fromCatalogueClientDocument, toCatalogueUserDocument, toCatalogueClientDocument } from './identity-catalogue.mapper.js';

const indexes = z.array(z.object({ key: z.record(z.string(), z.unknown()), unique: z.boolean().optional(),
  sparse: z.boolean().optional(), hidden: z.boolean().optional(), partialFilterExpression: z.unknown().optional(),
  expireAfterSeconds: z.unknown().optional(), collation: z.object({ locale: z.string() }).optional() }));
const principalQuery = z.object({ realm: logicalKey, issuer: z.literal('https://accounts.google.com'), subject: logicalKey }).strict();
const userQuery = z.object({ realm: logicalKey, userId: logicalKey }).strict();
const clientQuery = z.object({ realm: logicalKey, clientId: logicalKey }).strict();

// Explicit factory on an already-open connection. It checks indexes but never
// creates them, migrates data, opens sockets or becomes part of default app.ts.
export async function createMongooseIdentityCatalogueStore(connection: Connection, options: AuthenticationPersistenceConfig) {
  const config = validateAuthenticationPersistenceConfig(options), realm = config.realm;
  const models = defineIdentityCatalogueModels(connection, config);
  function available() { if (connection.readyState !== 1 || !connection.db) throw new ApplicationError('DEPENDENCY_UNAVAILABLE'); }
  available(); const db = connection.db!;
  const users = db.collection<CatalogueUserDocument>(models.users.collection.name);
  const clients = db.collection<CatalogueClientDocument>(models.clients.collection.name);
  async function storage<T>(action: () => Promise<T>): Promise<T> {
    try { available(); return await action(); }
    catch (error: unknown) {
      let code: ApplicationErrorCode = 'DEPENDENCY_UNAVAILABLE';
      try {
        const own = typeof error === 'object' && error !== null ? Object.getOwnPropertyDescriptor(error, 'code') : undefined;
        if (own && 'value' in own) {
          if (error instanceof mongo.MongoServerError && own.value === 11000) code = 'CONFLICT';
          else if (error instanceof ApplicationError && isApplicationErrorCode(own.value)) code = own.value;
        }
      } catch { /* Do not evaluate exception accessors or keep provider causes. */ }
      throw new ApplicationError(code);
    }
  }
  const [userIndexes, clientIndexes] = await storage(() => Promise.all([
    users.listIndexes({ maxTimeMS: config.operationTimeoutMs }).toArray(),
    clients.listIndexes({ maxTimeMS: config.operationTimeoutMs }).toArray(),
  ]));
  function unique(input: unknown, key: Record<string, number>, primary = false) {
    return checkedOutput(indexes, input).some(index => JSON.stringify(index.key) === JSON.stringify(key) &&
      (primary ? index.unique !== false : index.unique === true) && index.sparse !== true && index.hidden !== true &&
      index.partialFilterExpression === undefined && index.expireAfterSeconds === undefined &&
      (index.collation === undefined || index.collation.locale === 'simple'));
  }
  if (!unique(userIndexes, { _id: 1 }, true) || !unique(clientIndexes, { _id: 1 }, true) ||
    !unique(userIndexes, { realm: 1, id: 1 }) || !unique(userIndexes, { realm: 1, issuer: 1, subject: 1 }) ||
    !unique(clientIndexes, { realm: 1, id: 1 })) throw new ApplicationError('DEPENDENCY_UNAVAILABLE');
  const read = { maxTimeMS: config.operationTimeoutMs, readPreference: 'primary' as const,
    readConcern: { level: 'majority' as const }, collation: { locale: 'simple' } };
  const write = { maxTimeMS: config.operationTimeoutMs, writeConcern: { w: 'majority' as const, j: true,
    wtimeout: config.operationTimeoutMs }, collation: { locale: 'simple' }, upsert: false,
    returnDocument: 'after' as const, includeResultMetadata: false as const };
  async function user(filter: Record<string, unknown>) {
    const rows = await storage(() => users.find(filter, read).limit(2).toArray());
    if (rows.length > 1) throw new ApplicationError('INTERNAL_ERROR');
    if (!rows.length) return null;
    const row = rows[0]; if (row.realm !== realm) throw new ApplicationError('INTERNAL_ERROR');
    return fromCatalogueUserDocument(row);
  }
  async function client(filter: Record<string, unknown>) {
    const rows = await storage(() => clients.find(filter, read).limit(2).toArray());
    if (rows.length > 1) throw new ApplicationError('INTERNAL_ERROR');
    if (!rows.length) return null;
    const row = rows[0]; if (row.realm !== realm) throw new ApplicationError('INTERNAL_ERROR');
    return fromCatalogueClientDocument(row);
  }
  const findUser = (id: string) => user({ realm, id: checkedOutput(logicalKey, id) });
  const findClient = (id: string) => client({ realm, id: checkedOutput(logicalKey, id) });
  const store = Object.freeze<IdentityCatalogueStore>({
    async findUserByPrincipal(input) {
      const query = checkedOutput(principalQuery, input); if (query.realm !== realm) return null;
      const row = await user(query);
      if (row && (row.issuer !== query.issuer || row.subject !== query.subject)) throw new ApplicationError('INTERNAL_ERROR');
      return row;
    },
    async findUserById(input) {
      const query = checkedOutput(userQuery, input); if (query.realm !== realm) return null;
      const row = await findUser(query.userId); if (row && row.id !== query.userId) throw new ApplicationError('INTERNAL_ERROR'); return row;
    },
    async findClientById(input) {
      const query = checkedOutput(clientQuery, input); if (query.realm !== realm) return null;
      const row = await findClient(query.clientId); if (row && row.id !== query.clientId) throw new ApplicationError('INTERNAL_ERROR'); return row;
    },
  });
  // Compare every observed field as a whole BSON value. Unlike query equality,
  // $expr $eq does not match elements inside malicious arrays. No blind writes.
  function snapshot(row: CatalogueUserDocument | CatalogueClientDocument) {
    return { $and: Object.entries(row).map(([key, value]) => ({ $eq: ['$' + key, { $literal: value }] })) };
  }
  const administration = Object.freeze<IdentityCatalogueAdministrationStore>({
    realm, findUser, findClient,
    async insertUser(input) {
      const document = toCatalogueUserDocument(input, realm);
      if (document.securityVersion !== 0) throw new ApplicationError('INTERNAL_ERROR');
      return storage(async () => {
        await new models.users(document).validate();
        const result = await users.insertOne(document, { writeConcern: write.writeConcern });
        if (result.acknowledged !== true || result.insertedId !== document._id) throw new ApplicationError('DEPENDENCY_UNAVAILABLE');
        return Object.freeze({ acknowledged: true as const, realm, id: document.id });
      });
    },
    async insertClient(input) {
      const document = toCatalogueClientDocument(input, realm);
      if (document.securityVersion !== 0) throw new ApplicationError('INTERNAL_ERROR');
      return storage(async () => {
        await new models.clients(document).validate();
        const result = await clients.insertOne(document, { writeConcern: write.writeConcern });
        if (result.acknowledged !== true || result.insertedId !== document._id) throw new ApplicationError('DEPENDENCY_UNAVAILABLE');
        return Object.freeze({ acknowledged: true as const, realm, id: document.id });
      });
    },
    async replaceUser(beforeInput, afterInput) {
      const before = checkedOutput(managedUserSchema, beforeInput), after = checkedOutput(managedUserSchema, afterInput);
      if (after.id !== before.id || after.issuer !== before.issuer || after.subject !== before.subject ||
        after.securityVersion !== before.securityVersion + 1 || after.updatedAt < before.updatedAt) throw new ApplicationError('INTERNAL_ERROR');
      const old = toCatalogueUserDocument(before, realm), next = toCatalogueUserDocument(after, realm);
      const { _id: _key, realm: _scope, id: _id, issuer: _issuer, subject: _subject, ...mutable } = next;
      const changed = await storage(() => users.findOneAndUpdate({ realm, id: before.id,
        securityVersion: before.securityVersion, $expr: snapshot(old) }, { $set: mutable }, write));
      if (!changed) return false;
      const result = fromCatalogueUserDocument(changed);
      if (JSON.stringify(result) !== JSON.stringify(after)) throw new ApplicationError('INTERNAL_ERROR');
      return true;
    },
    async replaceClient(beforeInput, afterInput) {
      const before = checkedOutput(managedClientSchema, beforeInput), after = checkedOutput(managedClientSchema, afterInput);
      if (after.id !== before.id || after.securityVersion !== before.securityVersion + 1 ||
        after.updatedAt < before.updatedAt) throw new ApplicationError('INTERNAL_ERROR');
      const old = toCatalogueClientDocument(before, realm), next = toCatalogueClientDocument(after, realm);
      const { _id: _key, realm: _scope, id: _id, ...mutable } = next;
      const changed = await storage(() => clients.findOneAndUpdate({ realm, id: before.id,
        securityVersion: before.securityVersion, $expr: snapshot(old) }, { $set: mutable }, write));
      if (!changed) return false;
      const result = fromCatalogueClientDocument(changed);
      if (JSON.stringify(result) !== JSON.stringify(after)) throw new ApplicationError('INTERNAL_ERROR');
      return true;
    },
  });
  return Object.freeze({ store, administration });
}
