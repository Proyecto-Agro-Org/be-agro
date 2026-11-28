import { z } from 'zod';

import { eventIdSchema } from './event-id.js';
const technicalId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/);
const instant = z.date().refine(value => Number.isSafeInteger(value.getTime()) && value.getTime() >= 0);
const deviceTimestamp = z.union([z.string().max(128), z.number().finite(), z.null()]);
const mqttTopic = z.string().min(1).refine(value => Buffer.byteLength(value, 'utf8') <= 1024 && !/[+#\u0000]/.test(value)).nullable();

export const protectedMessageTypeSchema = z.enum(['telemetry', 'device-status', 'connected', 'disconnected']);
export const protectedStoreOperationSchema = z.enum(['measurement', 'device-status']);

export const protectedIngestDocumentSchema = z.object({
  _id: technicalId.optional(),
  sourceId: technicalId,
  operation: protectedStoreOperationSchema,
  eventId: eventIdSchema,
  clientid: technicalId,
  _receivedAt: instant,
  persistedAt: instant.optional(),
  _payload: z.record(z.string(), z.unknown()),
  _provenance: z.object({
    serviceAuthenticated: z.literal(true),
    sourceId: technicalId,
    eventId: eventIdSchema,
    technicalClientId: technicalId,
    brokerIdentity: z.enum(['broker-assertion-config-verified', 'declared-unverified']),
    mqttContext: z.enum(['service-declared', 'missing']),
    topic: mqttTopic,
    messageType: z.enum(['telemetry', 'device-status', 'connected', 'disconnected', 'unknown']),
    dataOriginDeclared: z.enum(['simulated', 'physical-unverified', 'unknown']),
    physicalMeasurementVerified: z.literal(false),
    commercialAttribution: z.literal(false),
    deviceTimestamp,
    brokerDeclaredAt: instant,
    receivedAt: instant,
  }).strict().refine(value => value.messageType !== 'telemetry' || value.topic !== null),
}).strict();

export type ProtectedIngestDocument = z.infer<typeof protectedIngestDocumentSchema>;
