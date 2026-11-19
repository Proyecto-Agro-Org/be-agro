import { Schema, type Connection, type Model } from 'mongoose';
import { validateAuthenticationPersistenceConfig, type AuthenticationPersistenceConfig } from '../config/authentication-persistence.js';

// Technical authentication metadata only. Collection names/schema are a proposal;
// no agronomic collection, provisioning model, connection or DDL is selected here.
export interface ChallengeDocument {
  _id: string; digest: string; nonceDigest: string; realm: string; audience: string;
  expiresAt: Date; consumedAt: Date | null;
}
export interface SessionDocument {
  _id: string; id: string; digest: string; realm: string; userId: string; clientId: string;
  securityVersion: number; createdAt: Date; absoluteExpiresAt: Date; idleExpiresAt: Date;
  revokedAt: Date | null;
}
interface AuthenticationModels { challenges: Model<ChallengeDocument>; sessions: Model<SessionDocument> }
// Cache model metadata, never identities, credentials or session records.
const ownedModels = new WeakMap<Connection, Map<string, AuthenticationModels>>();
export function defineAuthenticationModels(connection: Connection, options: AuthenticationPersistenceConfig): AuthenticationModels {
  const config = validateAuthenticationPersistenceConfig(options), prefix = config.collectionPrefix;
  let cache = ownedModels.get(connection);
  if (cache?.has(prefix)) return cache.get(prefix)!;
  const names = { challenges: prefix + '_challenges', sessions: prefix + '_sessions' };
  if (connection.models[names.challenges] || connection.models[names.sessions]) throw new TypeError('Authentication model namespace already in use.');
  const settings = { autoCreate: false, autoIndex: false, bufferCommands: false, versionKey: false as const,
    strict: 'throw' as const, strictQuery: 'throw' as const, id: false };
  const requiredString = { type: String, required: true, immutable: true };
  const requiredDate = { type: Date, required: true, immutable: true };
  const challenges = new Schema<ChallengeDocument>({
    _id: requiredString, digest: requiredString, nonceDigest: requiredString, realm: requiredString, audience: requiredString,
    expiresAt: requiredDate, consumedAt: { type: Date, default: null },
  }, settings);
  challenges.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'auth_challenge_expiry' });
  const sessions = new Schema<SessionDocument>({
    _id: requiredString, id: requiredString, digest: requiredString, realm: requiredString,
    userId: requiredString, clientId: requiredString,
    securityVersion: { type: Number, required: true, immutable: true }, createdAt: requiredDate,
    absoluteExpiresAt: requiredDate, idleExpiresAt: { type: Date, required: true }, revokedAt: { type: Date, default: null },
  }, settings);
  sessions.index({ realm: 1, digest: 1 }, { unique: true, name: 'auth_session_digest_unique' });
  sessions.index({ absoluteExpiresAt: 1 }, { expireAfterSeconds: 0, name: 'auth_session_expiry' });
  const result = Object.freeze({ challenges: connection.model(names.challenges, challenges, names.challenges),
    sessions: connection.model(names.sessions, sessions, names.sessions) });
  if (!cache) { cache = new Map(); ownedModels.set(connection, cache); }
  cache.set(prefix, result);
  return result;
}
