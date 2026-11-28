import { z } from 'zod';
import { logicalKey } from '../auth/validation.js';
import { technicalDeviceKeySchema } from '../telemetry/association.schemas.js';

export const sensorLifecycleSchema = z.enum(['active', 'inactive', 'decommissioned']);
export const sensorVersionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);
export const sensorTimestampSchema = z.number().int().min(0).max(8_640_000_000_000_000);
const safeText = z.string().trim().min(1).max(120).refine(value => !/[\p{Cc}\p{Cf}]/u.test(value));
const reason = z.string().trim().min(1).max(240).refine(value => !/[\p{Cc}\p{Cf}]/u.test(value));

export const sensorCreateSchema = z.object({ fieldId: logicalKey, areaId: logicalKey, name: safeText, description: z.string().max(2000).nullable() }).strict();
export const sensorPatchSchema = z.object({ name: safeText.optional(), description: z.string().max(2000).nullable().optional(), version: sensorVersionSchema }).strict()
  .refine(value => value.name !== undefined || value.description !== undefined);
export const deviceCreateSchema = z.object({ sourceId: logicalKey, key: technicalDeviceKeySchema }).strict();
export const associationCreateSchema = z.object({ sensorId: logicalKey, physicalDeviceId: logicalKey, validFrom: sensorTimestampSchema, auditReason: reason }).strict();
export const deviceReassignmentSchema = associationCreateSchema.extend({ associationId: logicalKey, associationRevision: sensorVersionSchema }).strict();
export const associationCloseSchema = z.object({ associationId: logicalKey, associationRevision: sensorVersionSchema, validTo: sensorTimestampSchema, auditReason: reason }).strict();
export const areaReassignmentSchema = z.object({ sensorId: logicalKey, fieldId: logicalKey, areaId: logicalKey, validFrom: sensorTimestampSchema,
  sensorVersion: sensorVersionSchema, auditReason: reason }).strict();
export const lifecycleInputSchema = z.object({ version: sensorVersionSchema, auditReason: reason }).strict();
export const sensorPageSchema = z.object({ after: logicalKey.optional(), limit: z.number().int().min(1).max(100) }).strict();

export const logicalSensorSchema = z.object({ id: logicalKey, clientId: logicalKey, fieldId: logicalKey, areaId: logicalKey, name: safeText,
  description: z.string().max(2000).nullable(), lifecycle: sensorLifecycleSchema, version: sensorVersionSchema,
  createdAt: sensorTimestampSchema, updatedAt: sensorTimestampSchema }).strict();
export const physicalDeviceSchema = z.object({ id: logicalKey, sourceId: logicalKey, key: technicalDeviceKeySchema,
  verification: z.enum(['unverified', 'verified']), lifecycle: sensorLifecycleSchema, version: sensorVersionSchema,
  createdAt: sensorTimestampSchema, updatedAt: sensorTimestampSchema }).strict();
export const areaAssignmentSchema = z.object({ id: logicalKey, revision: sensorVersionSchema, clientId: logicalKey, sensorId: logicalKey,
  fieldId: logicalKey, areaId: logicalKey, validFrom: sensorTimestampSchema, validTo: sensorTimestampSchema.nullable() }).strict();
export const sensorDeviceAssociationSchema = z.object({ id: logicalKey, revision: sensorVersionSchema, clientId: logicalKey,
  sensorId: logicalKey, fieldId: logicalKey, areaId: logicalKey, physicalDeviceId: logicalKey, sourceId: logicalKey,
  device: technicalDeviceKeySchema, validFrom: sensorTimestampSchema, validTo: sensorTimestampSchema.nullable(),
  state: z.enum(['active', 'closed']), auditReason: reason }).strict();
