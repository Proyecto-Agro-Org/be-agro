import { z } from 'zod';
import { catalogueRealmSchema, securityVersionSchema } from '../auth/identity-catalogue.schemas.js';
import { epoch, logicalKey } from '../auth/validation.js';
import { physicalDeviceSchema, sensorDeviceAssociationSchema } from '../sensors/schemas.js';

const technicalId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/);
const timestamp = <T extends z.ZodType>(value: T, origin: string) =>
  z.object({ value, origin: z.literal(origin), trustedForAttribution: z.literal(false) }).strict();

// Defensive re-validation of a BE13-02 measurement candidate. Identity of the
// object is checked separately through the issued-candidate registry.
export const gateCandidateSchema = z.object({
  status: z.literal('candidate'),
  kind: z.literal('measurement-candidate'),
  sourceId: technicalId,
  storeOperation: z.literal('measurement'),
  operation: z.literal('telemetry'),
  eventId: technicalId,
  device: z.object({ kind: z.literal('mqtt-clientid'), value: technicalId }).strict(),
  declaredTechnicalIdentity: technicalId,
  idempotencyKey: z.object({ sourceId: technicalId, operation: z.literal('measurement'), eventId: technicalId }).strict(),
  timestamps: z.object({
    deviceTimestamp: timestamp(z.union([z.string().max(128), z.number().finite(), z.null()]), 'device-declared'),
    sentAt: timestamp(epoch, 'broker-declared'),
    receivedAt: timestamp(epoch, 'ingest-received'),
    persistedAt: timestamp(epoch.nullable(), 'ingest-persisted'),
  }).strict(),
  payload: z.record(z.string(), z.unknown()),
  provenance: z.object({
    technicalIdentityAuthorization: z.literal('external-capability'),
    payloadIntegrity: z.literal('not-attested'),
    brokerIdentityDeclared: z.enum(['broker-assertion-config-verified', 'declared-unverified']),
    mqttContext: z.literal('service-declared'),
    topic: z.string().min(1),
    dataOriginDeclared: z.enum(['simulated', 'physical-unverified', 'unknown']),
    physicalMeasurementVerified: z.literal(false),
    commercialAttribution: z.literal(false),
  }).strict(),
  eligibleForMeasurementMapping: z.literal(true),
}).strict()
  .refine(row => row.declaredTechnicalIdentity === row.device.value)
  .refine(row => row.idempotencyKey.sourceId === row.sourceId && row.idempotencyKey.eventId === row.eventId)
  .refine(row => row.timestamps.persistedAt.value === null || row.timestamps.persistedAt.value >= row.timestamps.receivedAt.value);

export const gateSelectionSchema = z.object({ field: logicalKey }).strict();
export const gateOptionsSchema = z.object({
  realm: catalogueRealmSchema,
  authorityTimeoutMs: z.number().int().min(1).max(60_000).optional(),
}).strict();

export const deviceResolutionSchema = z.object({
  realm: catalogueRealmSchema,
  devices: z.array(physicalDeviceSchema).max(2),
}).strict();

export const associationAtResolutionSchema = z.object({
  realm: catalogueRealmSchema,
  complete: z.literal(true),
  records: z.array(sensorDeviceAssociationSchema.refine(row => row.validTo === null || row.validFrom < row.validTo)
    .refine(row => (row.state === 'active') === (row.validTo === null))).max(2),
}).strict();

export const temporalAuthorityDecisionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('trusted'), realm: catalogueRealmSchema, at: epoch,
    clock: z.enum(['received-at', 'device-declared-approved', 'broker-declared-approved']), policyRevision: securityVersionSchema }).strict(),
  z.object({ status: z.literal('untrusted'), realm: catalogueRealmSchema, reason: z.literal('untrusted-clock') }).strict(),
  z.object({ status: z.literal('unresolved'), realm: catalogueRealmSchema }).strict(),
]);

export const catalogueDecisionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('approved'), realm: catalogueRealmSchema, field: logicalKey, magnitude: logicalKey, unit: logicalKey,
    catalogueRevision: securityVersionSchema }).strict(),
  z.object({ status: z.literal('unknown-magnitude'), realm: catalogueRealmSchema }).strict(),
  z.object({ status: z.literal('incompatible-unit'), realm: catalogueRealmSchema }).strict(),
]);

export const hardwareDecisionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('verified'), realm: catalogueRealmSchema, physicalDeviceId: logicalKey,
    origin: z.enum(['physical', 'simulated']), method: logicalKey, attestationRevision: securityVersionSchema }).strict(),
  z.object({ status: z.literal('unverified'), realm: catalogueRealmSchema }).strict(),
]);
