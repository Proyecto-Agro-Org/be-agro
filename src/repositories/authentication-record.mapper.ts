import { z } from 'zod';
import type { AppSessionRecord, LoginChallengeRecord } from '../auth/session.contracts.js';
import { challengeRecordSchema, digestSchema, sessionRecordSchema } from '../auth/session.schemas.js';
import { checkedOutput, epoch, logicalKey } from '../auth/validation.js';
import type { ChallengeDocument, SessionDocument } from '../models/authentication.models.js';
import { ApplicationError } from '../errors/application.error.js';

const bsonDate = z.instanceof(Date).refine(date => epoch.safeParse(date.getTime()).success);
const challengeDocument = z.object({ _id: logicalKey, digest: digestSchema, nonceDigest: digestSchema,
  realm: logicalKey, audience: logicalKey, expiresAt: bsonDate, consumedAt: bsonDate.nullable() }).strict();
const sessionDocument = z.object({ _id: z.string().min(1).max(300), id: logicalKey, digest: digestSchema, realm: logicalKey,
  userId: logicalKey, clientId: logicalKey, securityVersion: z.number().int().nonnegative().safe(),
  createdAt: bsonDate, absoluteExpiresAt: bsonDate, idleExpiresAt: bsonDate, revokedAt: bsonDate.nullable() }).strict();

export function authenticationKey(realm: string, id: string): string { return realm + ':' + id; }
export function toChallengeDocument(input: LoginChallengeRecord): ChallengeDocument {
  const row = checkedOutput(challengeRecordSchema, input);
  if (row.consumedAt !== null) throw new ApplicationError('INTERNAL_ERROR');
  return { ...row, _id: authenticationKey(row.realm, row.digest), expiresAt: new Date(row.expiresAt), consumedAt: null };
}
export function toSessionDocument(input: AppSessionRecord): SessionDocument {
  const row = checkedOutput(sessionRecordSchema, input);
  if (row.revokedAt !== null) throw new ApplicationError('INTERNAL_ERROR');
  return { ...row, _id: authenticationKey(row.realm, row.id), createdAt: new Date(row.createdAt),
    absoluteExpiresAt: new Date(row.absoluteExpiresAt), idleExpiresAt: new Date(row.idleExpiresAt), revokedAt: null };
}
export function fromChallengeDocument(input: unknown): LoginChallengeRecord {
  const { _id, ...row } = checkedOutput(challengeDocument, input);
  if (_id !== authenticationKey(row.realm, row.digest)) throw new ApplicationError('INTERNAL_ERROR');
  return Object.freeze(checkedOutput(challengeRecordSchema, { ...row,
    expiresAt: row.expiresAt.getTime(), consumedAt: row.consumedAt?.getTime() ?? null }));
}
export function fromSessionDocument(input: unknown): AppSessionRecord {
  const { _id, ...row } = checkedOutput(sessionDocument, input);
  if (_id !== authenticationKey(row.realm, row.id)) throw new ApplicationError('INTERNAL_ERROR');
  return Object.freeze(checkedOutput(sessionRecordSchema, { ...row, createdAt: row.createdAt.getTime(),
    absoluteExpiresAt: row.absoluteExpiresAt.getTime(), idleExpiresAt: row.idleExpiresAt.getTime(), revokedAt: row.revokedAt?.getTime() ?? null }));
}
