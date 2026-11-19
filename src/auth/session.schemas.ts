import { z } from 'zod';
import { epoch, logicalKey } from './validation.js';
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const catalogueUserSchema = z.object({ id: logicalKey, issuer: logicalKey, subject: logicalKey,
  name: logicalKey, email: z.email().max(320), active: z.boolean(), securityVersion: z.number().int().nonnegative().safe(),
  client: z.object({ id: logicalKey, name: logicalKey, active: z.boolean() }).strict().nullable(),
}).strict();
export const challengeRecordSchema = z.object({ digest: digestSchema, nonceDigest: digestSchema, realm: logicalKey,
  audience: logicalKey, expiresAt: epoch, consumedAt: epoch.nullable() }).strict();
export const sessionRecordSchema = z.object({ id: logicalKey, digest: digestSchema, realm: logicalKey,
  userId: logicalKey, clientId: logicalKey, securityVersion: z.number().int().nonnegative().safe(),
  createdAt: epoch, absoluteExpiresAt: epoch, idleExpiresAt: epoch, revokedAt: epoch.nullable(),
}).strict().refine(r => r.createdAt < r.idleExpiresAt && r.idleExpiresAt <= r.absoluteExpiresAt);
export const assertionResultSchema = z.union([
  z.object({ status: z.literal('invalid') }).strict(),
  z.object({ status: z.literal('verified'), identity: z.object({ issuer: logicalKey, subject: logicalKey }).strict() }).strict(),
]);
