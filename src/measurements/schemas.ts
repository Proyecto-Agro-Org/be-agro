import { z } from 'zod';
import { epoch, logicalKey } from '../auth/validation.js';
import { catalogueRealmSchema, securityVersionSchema } from '../auth/identity-catalogue.schemas.js';
import { technicalDeviceKeySchema } from '../telemetry/association.schemas.js';

export const provenanceSchema = z.enum(['physical','derived','estimated','simulated','manual','laboratory']);
export const missingReasonSchema = z.enum(['absent','invalid','unknown-unit','not-calibrated','insufficient-dependency']);
const metadataValue = z.union([z.string().max(256),z.number().finite(),z.boolean(),z.null()]);
export const trustedMeasurementEventSchema = z.object({ eventId: logicalKey, sourceId: logicalKey,
  device: technicalDeviceKeySchema, receivedAt: epoch, declaredAt: epoch.nullable(), persistedAt: epoch,
  magnitude: logicalKey, unit: logicalKey, value: z.number().finite().nullable(), missingReason: missingReasonSchema.nullable(),
  provenance: provenanceSchema, simulated: z.boolean(), metadata: z.record(logicalKey,metadataValue).refine(row=>Object.keys(row).length<=20) }).strict()
  .refine(row=>(row.value===null)===(row.missingReason!==null))
  .refine(row=>row.simulated===(row.provenance==='simulated'))
  .refine(row=>row.persistedAt>=row.receivedAt);
export const resolvedPhysicalDeviceSchema = z.object({ id:logicalKey,sourceId:logicalKey,device:technicalDeviceKeySchema,
  lifecycle:z.enum(['active','inactive','decommissioned']),verification:z.enum(['verified','unverified']) }).strict();
export const attributionWindowSchema = z.object({ id:logicalKey,revision:securityVersionSchema,realm:catalogueRealmSchema,
  clientId:logicalKey,fieldId:logicalKey,areaId:logicalKey,sensorId:logicalKey,physicalDeviceId:logicalKey,
  validFrom:epoch,validTo:epoch.nullable() }).strict().refine(row=>row.validTo===null||row.validFrom<row.validTo);
export const temporalDecisionSchema = z.discriminatedUnion('status',[
  z.object({status:z.literal('trusted'),at:epoch,clock:z.enum(['received-at','declared-at-approved'])}).strict(),
  z.object({status:z.literal('untrusted'),reason:z.enum(['untrusted-clock','outside-tolerance'])}).strict(),
]);
export const attributedMeasurementSchema = z.object({ id:logicalKey,eventId:logicalKey,realm:catalogueRealmSchema,
  clientId:logicalKey,fieldId:logicalKey,areaId:logicalKey,sensorId:logicalKey,physicalDeviceId:logicalKey,
  associationId:logicalKey,associationRevision:securityVersionSchema,magnitude:logicalKey,unit:logicalKey,
  value:z.number().finite().nullable(),missingReason:missingReasonSchema.nullable(),provenance:provenanceSchema,
  receivedAt:epoch,declaredAt:epoch.nullable(),persistedAt:epoch,attributedAt:epoch }).strict()
  .refine(row=>(row.value===null)===(row.missingReason!==null));
const cursorSchema=z.object({attributedAt:epoch,id:logicalKey}).strict();
export const selectorSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('sensor'),sensorId:logicalKey}).strict(),
  z.object({kind:z.literal('device'),physicalDeviceId:logicalKey}).strict(),
  z.object({kind:z.literal('area'),fieldId:logicalKey,areaId:logicalKey}).strict(),
  z.object({kind:z.literal('field'),fieldId:logicalKey}).strict(),
]);
export const measurementPageRequestSchema=z.object({selector:selectorSchema,from:epoch,to:epoch,limit:z.number().int().min(1).max(200),after:cursorSchema.optional()}).strict()
  .refine(row=>row.from<row.to).refine(row=>!row.after||(row.after.attributedAt>=row.from&&row.after.attributedAt<row.to));
export const measurementPageSchema=z.object({items:z.array(attributedMeasurementSchema).max(200),next:cursorSchema.nullable()}).strict();
