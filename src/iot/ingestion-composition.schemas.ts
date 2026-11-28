import { z } from 'zod';
import { catalogueRealmSchema, securityVersionSchema } from '../auth/identity-catalogue.schemas.js';
import { epoch, logicalKey } from '../auth/validation.js';
import { physicalDeviceSchema, sensorDeviceAssociationSchema } from '../sensors/schemas.js';

export const storedPhysicalDeviceSchema = physicalDeviceSchema.extend({ realm: catalogueRealmSchema }).strict();
export const storedDeviceAssociationSchema = sensorDeviceAssociationSchema.extend({ realm: catalogueRealmSchema }).strict()
  .refine(row => row.validTo === null || row.validFrom < row.validTo)
  .refine(row => (row.state === 'active') === (row.validTo === null));

export const storedDevicesResponseSchema = z.object({ realm: catalogueRealmSchema, rows: z.array(storedPhysicalDeviceSchema).max(2) }).strict();
export const storedAssociationsResponseSchema = z.object({ realm: catalogueRealmSchema, complete: z.literal(true),
  rows: z.array(storedDeviceAssociationSchema).max(2) }).strict();

const fingerprintHex = z.string().regex(/^[0-9a-f]{64}$/);
export const idempotencyLookupSchema = z.discriminatedUnion('status', [
  z.object({ realm: catalogueRealmSchema, status: z.literal('absent') }).strict(),
  z.object({ realm: catalogueRealmSchema, status: z.literal('present'), fingerprint: fingerprintHex }).strict(),
]);
export const idempotencyClaimSchema = z.object({ realm: catalogueRealmSchema, status: z.enum(['claimed', 'replay', 'conflict']) }).strict();

export const compositionSelectionSchema = z.object({ field: logicalKey }).strict();
export const compositionOptionsSchema = z.object({ realm: catalogueRealmSchema }).strict();
export const authorityTimeoutSchema = z.number().int().min(1).max(60_000).optional();

export const be12VerifiedSchema = z.object({ status: z.literal('verified'), attributedAt: epoch, clock: z.enum(['received-at', 'declared-at-approved']),
  physicalDeviceId: logicalKey, realm: catalogueRealmSchema, clientId: logicalKey, fieldId: logicalKey, areaId: logicalKey, sensorId: logicalKey,
  associationId: logicalKey, associationRevision: securityVersionSchema }).passthrough();

const measurementIdSchema = z.string().regex(/^m_[0-9a-f]{64}$/);
export const persistenceLookupSchema = z.discriminatedUnion('status', [
  z.object({ realm: catalogueRealmSchema, status: z.literal('absent') }).strict(),
  z.object({ realm: catalogueRealmSchema, status: z.literal('present'), fingerprint: fingerprintHex, measurementId: measurementIdSchema }).strict(),
]);
export const persistenceOutcomeSchema = z.discriminatedUnion('status', [
  z.object({ realm: catalogueRealmSchema, status: z.literal('persisted'), measurementId: measurementIdSchema }).strict(),
  z.object({ realm: catalogueRealmSchema, status: z.literal('duplicate'), measurementId: measurementIdSchema }).strict(),
  z.object({ realm: catalogueRealmSchema, status: z.literal('conflict') }).strict(),
]);
export const idempotencyKeySchema = z.object({ realm: catalogueRealmSchema, sourceId: logicalKey, operation: z.enum(['measurement', 'device-status']),
  eventId: logicalKey, field: logicalKey }).strict();
export const compositionAttributionSchema = z.object({ realm: catalogueRealmSchema, attributedAt: epoch, clock: z.enum(['received-at', 'declared-at-approved']),
  physicalDeviceId: logicalKey, clientId: logicalKey, fieldId: logicalKey, areaId: logicalKey, sensorId: logicalKey, associationId: logicalKey,
  associationRevision: securityVersionSchema }).strict();
export { fingerprintHex, measurementIdSchema };
