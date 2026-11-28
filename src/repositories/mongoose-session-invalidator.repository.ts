import type { Connection } from 'mongoose';
import { z } from 'zod';
import type { CatalogueSessionInvalidator } from '../auth/identity-catalogue-admin.contracts.js';
import { securityVersionSchema } from '../auth/identity-catalogue.schemas.js';
import { checkedOutput, epoch, logicalKey } from '../auth/validation.js';
import { validateAuthenticationPersistenceConfig, type AuthenticationPersistenceConfig } from '../config/authentication-persistence.js';
import { ApplicationError } from '../errors/application.error.js';
import { defineAuthenticationModels, type SessionDocument } from '../models/authentication.models.js';

const resultSchema = z.object({ acknowledged: z.literal(true), matchedCount: z.number().int().nonnegative().safe(),
  modifiedCount: z.number().int().nonnegative().safe() }).refine(row => row.modifiedCount <= row.matchedCount);
export function createMongooseCatalogueSessionInvalidator(connection: Connection, options: AuthenticationPersistenceConfig): CatalogueSessionInvalidator {
  const config = validateAuthenticationPersistenceConfig(options);
  const models = defineAuthenticationModels(connection, config);
  if (connection.readyState !== 1 || !connection.db) throw new ApplicationError('DEPENDENCY_UNAVAILABLE');
  const sessions = connection.db.collection<SessionDocument>(models.sessions.collection.name);
  return Object.freeze<CatalogueSessionInvalidator>({ realm: config.realm, async revokeBeforeVersion(scope, id, versionInput, at) {
    if (scope !== config.realm) throw new ApplicationError('INTERNAL_ERROR');
    const userId = checkedOutput(logicalKey, id), version = checkedOutput(securityVersionSchema, versionInput);
    const date = new Date(checkedOutput(epoch, at));
    try {
      if (connection.readyState !== 1) throw new Error();
      const value = await sessions.updateMany({ realm: scope, userId, securityVersion: { $lt: version },
        $expr: { $and: [
          { $eq: [{ $type: '$realm' }, 'string'] }, { $eq: ['$realm', { $literal: scope }] },
          { $eq: [{ $type: '$userId' }, 'string'] }, { $eq: ['$userId', { $literal: userId }] },
          { $in: [{ $type: '$securityVersion' }, ['double', 'int', 'long']] },
          { $gte: ['$securityVersion', 0] }, { $lt: ['$securityVersion', version] },
          { $eq: [{ $type: '$revokedAt' }, 'null'] },
        ] } }, { $set: { revokedAt: date } }, { maxTimeMS: config.operationTimeoutMs,
        collation: { locale: 'simple' }, upsert: false,
        writeConcern: { w: 'majority', j: true, wtimeout: config.operationTimeoutMs } });
      const result = checkedOutput(resultSchema, value);
      return Object.freeze({ acknowledged: true as const, realm: scope, userId, beforeVersion: version,
        matchedCount: result.matchedCount, modifiedCount: result.modifiedCount });
    } catch { throw new ApplicationError('DEPENDENCY_UNAVAILABLE'); }
  } });
}
