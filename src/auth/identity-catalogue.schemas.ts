import { z } from 'zod';
import { epoch, logicalKey } from './validation.js';

export const catalogueRealmSchema = z.enum(['development', 'test', 'preview', 'production']);
export const securityVersionSchema = z.number().int().nonnegative().safe();
export const catalogueWriteReceiptSchema = z.object({ acknowledged: z.literal(true),
  realm: catalogueRealmSchema, id: logicalKey }).strict();
export const catalogueRevocationReceiptSchema = z.object({ acknowledged: z.literal(true), realm: catalogueRealmSchema,
  userId: logicalKey, beforeVersion: securityVersionSchema, matchedCount: securityVersionSchema,
  modifiedCount: securityVersionSchema }).strict().refine(row => row.modifiedCount <= row.matchedCount);
export type CatalogueWriteReceipt = z.output<typeof catalogueWriteReceiptSchema>;
export type CatalogueRevocationReceipt = z.output<typeof catalogueRevocationReceiptSchema>;
export const membershipRecordSchema = z.object({ clientId: logicalKey, active: z.boolean(), updatedAt: epoch,
  clientSecurityVersion: securityVersionSchema.optional() }).strict();
export const catalogueUserRecordSchema = z.object({ id: logicalKey, issuer: logicalKey, subject: logicalKey,
  name: logicalKey, email: z.email().max(320), active: z.boolean(), securityVersion: securityVersionSchema,
  updatedAt: epoch, membership: membershipRecordSchema.nullable() }).strict()
  .refine(user => !user.membership || user.membership.updatedAt <= user.updatedAt);
export const catalogueClientRecordSchema = z.object({ id: logicalKey, name: logicalKey, active: z.boolean(),
  updatedAt: epoch, securityVersion: securityVersionSchema.optional() }).strict();

// Legacy injected ports may omit generations; the physical BE09.5 store may NOT.
export const managedMembershipSchema = membershipRecordSchema.extend({ clientSecurityVersion: securityVersionSchema });
export const managedUserSchema = z.object({ ...catalogueUserRecordSchema.shape, issuer: z.literal('https://accounts.google.com'),
  membership: managedMembershipSchema.nullable() }).strict()
  .refine(user => !user.membership || user.membership.updatedAt <= user.updatedAt);
export const managedClientSchema = catalogueClientRecordSchema.extend({ securityVersion: securityVersionSchema });
const date = z.instanceof(Date).refine(value => epoch.safeParse(value.getTime()).success);
const bsonMembership = managedMembershipSchema.extend({ updatedAt: date });
export const catalogueUserDocumentSchema = z.object({ ...managedUserSchema.shape, _id: z.string().min(1).max(300),
  realm: catalogueRealmSchema, updatedAt: date, membership: bsonMembership.nullable() }).strict()
  // Extend replaces Date-dependent logical refinements below with BSON checks.
  .refine(row => row._id === row.realm + ':' + row.id &&
    (!row.membership || row.membership.updatedAt.getTime() <= row.updatedAt.getTime()));
export const catalogueClientDocumentSchema = managedClientSchema.extend({ _id: z.string().min(1).max(300),
  realm: catalogueRealmSchema, updatedAt: date }).refine(row => row._id === row.realm + ':' + row.id);

export type ManagedCatalogueUser = z.output<typeof managedUserSchema>;
export type ManagedCatalogueClient = z.output<typeof managedClientSchema>;
