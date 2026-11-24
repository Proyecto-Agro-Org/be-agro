import { z } from 'zod';

const technicalId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/);
const instant = z.date().refine(value => Number.isSafeInteger(value.getTime()) && value.getTime() >= 0);
const deviceTimestamp = z.union([z.string().max(128), z.number().finite(), z.null()]);

export const protectedMessageTypeSchema = z.enum(['telemetry', 'device-status', 'connected', 'disconnected']);
export const protectedStoreOperationSchema = z.enum(['measurement', 'device-status']);

export const protectedIngestDocumentSchema = z.object({
  _id: technicalId.optional(),
  sourceId: technicalId,
  operation: protectedStoreOperationSchema,
  eventId: technicalId,
  clientid: technicalId,
  _receivedAt: instant,
  persistedAt: instant.optional(),
  _payload: z.record(z.string(), z.unknown()),
  _provenance: z.object({
    serviceAuthenticated: z.literal(true),
    sourceId: technicalId,
    eventId: technicalId,
    technicalClientId: technicalId,
    brokerIdentity: z.enum(['broker-assertion-config-verified', 'declared-unverified']),
    mqttContext: z.enum(['service-declared', 'missing']),
    topic: z.string().min(1).max(1024).nullable(),
    messageType: z.enum(['telemetry', 'device-status', 'connected', 'disconnected', 'unknown']),
    dataOriginDeclared: z.enum(['simulated', 'physical-unverified', 'unknown']),
    physicalMeasurementVerified: z.literal(false),
    commercialAttribution: z.literal(false),
    deviceTimestamp,
    brokerDeclaredAt: instant,
    receivedAt: instant,
  }).strict(),
}).strict();

export type ProtectedIngestDocument = z.infer<typeof protectedIngestDocumentSchema>;
