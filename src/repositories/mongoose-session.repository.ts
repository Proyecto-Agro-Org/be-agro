import type { Connection } from 'mongoose';
import { z } from 'zod';
import type { SessionRepository } from '../auth/session.contracts.js';
import { digestSchema } from '../auth/session.schemas.js';
import { checkedOutput, epoch, logicalKey } from '../auth/validation.js';
import { validateAuthenticationPersistenceConfig, type AuthenticationPersistenceConfig } from '../config/authentication-persistence.js';
import { ApplicationError } from '../errors/application.error.js';
import { defineAuthenticationModels, type ChallengeDocument, type SessionDocument } from '../models/authentication.models.js';
import { authenticationKey, fromChallengeDocument, fromSessionDocument, toChallengeDocument, toSessionDocument } from './authentication-record.mapper.js';

const indexesSchema = z.array(z.object({ key: z.record(z.string(), z.unknown()), unique: z.boolean().optional(),
  sparse: z.boolean().optional(), partialFilterExpression: z.unknown().optional(), hidden: z.boolean().optional(),
  collation: z.object({ locale: z.string() }).optional() }));
const updateResult = z.object({ acknowledged: z.literal(true), matchedCount: z.number().int().min(0).max(1),
  modifiedCount: z.number().int().min(0).max(1) }).refine(value => value.modifiedCount <= value.matchedCount);

// Explicit preparation only, never imported by app.ts. Reads index metadata;
// does NOT connect, create collections/indexes, seed users, or infer Atlas schema.
export async function createMongooseSessionRepository(connection: Connection,
  options: AuthenticationPersistenceConfig): Promise<SessionRepository> {
  const config = validateAuthenticationPersistenceConfig(options);
  const requireConnection = () => { if (connection.readyState !== 1) throw new ApplicationError('DEPENDENCY_UNAVAILABLE'); };
  requireConnection();
  const models = defineAuthenticationModels(connection, config);
  const database = connection.db;
  if (!database) throw new ApplicationError('DEPENDENCY_UNAVAILABLE');
  const challengeCollection = database.collection<ChallengeDocument>(models.challenges.collection.name);
  const sessionCollection = database.collection<SessionDocument>(models.sessions.collection.name);
  async function storage<T>(operation: () => Promise<T>): Promise<T> {
    try { requireConnection(); return await operation(); }
    catch { throw new ApplicationError('DEPENDENCY_UNAVAILABLE'); }
  }
  const [challengeIndexes, sessionIndexes] = await storage(() => Promise.all([
    models.challenges.collection.listIndexes({ maxTimeMS: config.operationTimeoutMs }).toArray(),
    models.sessions.collection.listIndexes({ maxTimeMS: config.operationTimeoutMs }).toArray(),
  ]));
  function hasUnique(input: unknown, keys: Record<string, number>, primary = false) {
    return checkedOutput(indexesSchema, input).some(index =>
      JSON.stringify(index.key) === JSON.stringify(keys) && (primary ? index.unique !== false : index.unique === true) &&
      index.sparse !== true && index.partialFilterExpression === undefined && index.hidden !== true &&
      (index.collation === undefined || index.collation.locale === 'simple'));
  }
  if (!hasUnique(challengeIndexes, { _id: 1 }, true) || !hasUnique(sessionIndexes, { _id: 1 }, true) ||
    !hasUnique(sessionIndexes, { realm: 1, digest: 1 })) throw new ApplicationError('DEPENDENCY_UNAVAILABLE');
  const realm = config.realm;
  const readOptions = { maxTimeMS: config.operationTimeoutMs, readPreference: 'primary' as const,
    readConcern: { level: 'majority' as const }, collation: { locale: 'simple' } };
  const writeConcern = { w: 'majority' as const, j: true, wtimeout: config.operationTimeoutMs };
  const writeOptions = { maxTimeMS: config.operationTimeoutMs, writeConcern, upsert: false, runValidators: true,
    collation: { locale: 'simple' } };
  const challengeProjection = '_id digest nonceDigest realm audience expiresAt consumedAt';
  const sessionProjection = '_id id digest realm userId clientId securityVersion createdAt absoluteExpiresAt idleExpiresAt revokedAt';
  const id = (value: unknown) => checkedOutput(logicalKey, value);
  const digest = (value: unknown) => checkedOutput(digestSchema, value);
  const time = (value: unknown) => checkedOutput(epoch, value);
  const checkRealm = (value: string) => { if (value !== realm) throw new ApplicationError('INTERNAL_ERROR'); };
  const acknowledged = (value: unknown) => checkedOutput(updateResult, value);
  // Query equality/comparison/$type can match array elements. Mutation guards
  // inspect the complete field and compare identity strings as literals.
  const scalarType = (field: string, type: string) => ({ $eq: [{ $type: '$' + field }, type] });
  const scalarNull = (field: string) => scalarType(field, 'null');
  const exactString = (field: string, value: string) => ({ $and: [scalarType(field, 'string'),
    { $eq: ['$' + field, { $literal: value }] }] });

  return Object.freeze<SessionRepository>({
    async insertChallenge(record) {
      const document = toChallengeDocument(record); checkRealm(document.realm);
      await storage(async () => {
        const instance = new models.challenges(document); await instance.validate();
        const result = await challengeCollection.insertOne(instance.toObject(), { writeConcern });
        if (result.acknowledged !== true || result.insertedId !== document._id) throw new Error();
      });
    },
    async findChallenge(tokenDigest, requestedRealm) {
      if (requestedRealm !== realm) return null;
      const key = digest(tokenDigest);
      const found = await storage(() => models.challenges.findOne({ _id: authenticationKey(realm, key), realm },
        challengeProjection, readOptions).lean().exec());
      if (!found) return null;
      const row = fromChallengeDocument(found);
      if (row.realm !== realm || row.digest !== key) throw new ApplicationError('INTERNAL_ERROR');
      return row;
    },
    async consumeChallenge(tokenDigest, nonceDigest, requestedRealm, at) {
      if (requestedRealm !== realm) return false;
      const key = digest(tokenDigest), nonce = digest(nonceDigest), now = new Date(time(at));
      const result = await storage(() => models.challenges.updateOne({ _id: authenticationKey(realm, key), realm, digest: key,
        nonceDigest: nonce, consumedAt: { $type: 10 }, expiresAt: { $gt: now },
        $expr: { $and: [exactString('realm', realm), exactString('digest', key), exactString('nonceDigest', nonce),
          scalarType('expiresAt', 'date'), scalarNull('consumedAt'), { $gt: ['$expiresAt', '$$NOW'] }] } },
      { $set: { consumedAt: now } }, writeOptions).exec());
      return acknowledged(result).modifiedCount === 1;
    },
    async insertSession(record) {
      const document = toSessionDocument(record); checkRealm(document.realm);
      await storage(async () => {
        const instance = new models.sessions(document); await instance.validate();
        const result = await sessionCollection.insertOne(instance.toObject(), { writeConcern });
        if (result.acknowledged !== true || result.insertedId !== document._id) throw new Error();
      });
    },
    async findSessionByDigest(tokenDigest, requestedRealm) {
      if (requestedRealm !== realm) return null;
      const key = digest(tokenDigest);
      const found = await storage(() => models.sessions.findOne({ realm, digest: key }, sessionProjection, readOptions).lean().exec());
      if (!found) return null;
      const row = fromSessionDocument(found);
      if (row.realm !== realm || row.digest !== key) throw new ApplicationError('INTERNAL_ERROR');
      return row;
    },
    async findSessionById(sessionId, requestedRealm) {
      if (requestedRealm !== realm) return null;
      const key = id(sessionId);
      const found = await storage(() => models.sessions.findOne({ _id: authenticationKey(realm, key), realm },
        sessionProjection, readOptions).lean().exec());
      if (!found) return null;
      const row = fromSessionDocument(found);
      if (row.realm !== realm || row.id !== key) throw new ApplicationError('INTERNAL_ERROR');
      return row;
    },
    async touchSession(sessionId, requestedRealm, at, idleExpiresAt) {
      if (requestedRealm !== realm) return null;
      const key = id(sessionId), now = new Date(time(at)), idle = new Date(time(idleExpiresAt));
      if (idle <= now) throw new ApplicationError('INTERNAL_ERROR');
      const found = await storage(() => models.sessions.findOneAndUpdate({ _id: authenticationKey(realm, key), realm,
        revokedAt: { $type: 10 }, createdAt: { $lte: now }, absoluteExpiresAt: { $gt: now, $gte: idle },
        idleExpiresAt: { $gt: now }, $expr: { $and: [
          exactString('realm', realm), exactString('id', key), scalarType('createdAt', 'date'),
          scalarType('absoluteExpiresAt', 'date'), scalarType('idleExpiresAt', 'date'), scalarNull('revokedAt'),
          { $gt: ['$absoluteExpiresAt', '$$NOW'] }, { $gt: ['$idleExpiresAt', '$$NOW'] },
        ] } }, { $max: { idleExpiresAt: idle } }, { ...writeOptions, returnDocument: 'after' })
        .select(sessionProjection).lean().exec());
      if (!found) return null;
      const row = fromSessionDocument(found);
      if (row.realm !== realm || row.id !== key || row.revokedAt !== null || row.idleExpiresAt < idle.getTime()) throw new ApplicationError('INTERNAL_ERROR');
      return row;
    },
    async revokeSession(tokenDigest, requestedRealm, at) {
      if (requestedRealm !== realm) return;
      const key = digest(tokenDigest), now = new Date(time(at));
      acknowledged(await storage(() => models.sessions.updateOne({ realm, digest: key, revokedAt: { $type: 10 },
        $expr: { $and: [exactString('realm', realm), exactString('digest', key), scalarNull('revokedAt')] } },
        { $set: { revokedAt: now } }, writeOptions).exec()));
    },
  });
}
