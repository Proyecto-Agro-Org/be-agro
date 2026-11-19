import { z } from 'zod';
import { catalogueRealmSchema, securityVersionSchema } from '../auth/identity-catalogue.schemas.js';
import { epoch, logicalKey } from '../auth/validation.js';

export const technicalDeviceKeySchema = z.object({ kind: z.enum(['mqtt-clientid', 'device-id']), value: logicalKey }).strict();
export const persistedKeySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('object-id'), value: z.string().regex(/^[a-f0-9]{24}$/) }).strict(),
  z.object({ kind: z.literal('string'), value: logicalKey }).strict(),
]);
export const deviceAssociationSchema = z.object({ id: logicalKey, revision: securityVersionSchema,
  realm: catalogueRealmSchema, clientId: logicalKey, fieldId: logicalKey, areaId: logicalKey, sensorId: logicalKey,
  sourceId: logicalKey, device: technicalDeviceKeySchema, clockId: logicalKey, validFrom: epoch,
  validTo: epoch.nullable(), attribution: z.enum(['verified', 'quarantined']) }).strict()
  .refine(row => row.validTo === null || row.validFrom < row.validTo);
export const associationPageSchema = z.object({ complete: z.literal(true), records: z.array(deviceAssociationSchema).max(64) }).strict();
export const technicalDeviceIdentitySchema = z.object({ sourceId: logicalKey, device: technicalDeviceKeySchema,
  recordId: persistedKeySchema }).strict();
export const sourcePolicySchema = z.object({ sourceId: logicalKey, clockId: logicalKey,
  deviceKind: z.enum(['mqtt-clientid', 'device-id']), deviceField: z.enum(['clientid', 'device_id']),
  authenticatedIdentity: z.boolean(), verifiedTemporalAttribution: z.boolean() }).strict();
export const telemetryRangeRequestSchema = z.object({ fieldId: logicalKey, areaId: logicalKey, sensorId: logicalKey,
  from: epoch, to: epoch, limit: z.number().int().min(1).max(1000) }).strict().refine(value => value.from < value.to);
