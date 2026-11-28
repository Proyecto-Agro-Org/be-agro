import { z } from 'zod';
import { catalogueRealmSchema, securityVersionSchema } from '../auth/identity-catalogue.schemas.js';
import { epoch, logicalKey } from '../auth/validation.js';
import { missingReasonSchema } from '../measurements/schemas.js';

export const trustedEventBuilderOptionsSchema = z.object({
  realm: catalogueRealmSchema,
  authorityTimeoutMs: z.number().int().min(1).max(60_000).optional(),
}).strict();

export const clockPolicyDecisionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('approved'), realm: catalogueRealmSchema, clock: z.enum(['received-at', 'declared-at-approved']),
    policyRevision: securityVersionSchema }).strict(),
  z.object({ status: z.literal('blocked'), realm: catalogueRealmSchema }).strict(),
]);

export const declaredAtPolicyDecisionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('approved'), realm: catalogueRealmSchema, source: z.enum(['device-timestamp', 'broker-sent-at', 'none']),
    declaredAt: epoch.nullable(), policyRevision: securityVersionSchema }).strict()
    .refine(row => (row.source === 'none') === (row.declaredAt === null)),
  z.object({ status: z.literal('blocked'), realm: catalogueRealmSchema }).strict(),
]);

export const missingReasonPolicyDecisionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('approved'), realm: catalogueRealmSchema, missingReason: missingReasonSchema,
    policyRevision: securityVersionSchema }).strict(),
  z.object({ status: z.literal('blocked'), realm: catalogueRealmSchema }).strict(),
]);

export const persistenceTimePolicyDecisionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('approved'), realm: catalogueRealmSchema, persistedAt: epoch, policyRevision: securityVersionSchema }).strict(),
  z.object({ status: z.literal('blocked'), realm: catalogueRealmSchema }).strict(),
]);

export const trustedEventAttributionSchema = z.object({ realm: catalogueRealmSchema, authorizedAt: epoch,
  clock: z.enum(['received-at', 'declared-at-approved']), physicalDeviceId: logicalKey, clientId: logicalKey, fieldId: logicalKey,
  areaId: logicalKey, sensorId: logicalKey, associationId: logicalKey, associationRevision: securityVersionSchema }).strict();
