import type { TechnicalDeviceKey } from '../telemetry/association.contracts.js';

export type ProtectedStoreOperation = 'measurement' | 'device-status';
export type ProtectedMessageType = 'telemetry' | 'device-status' | 'connected' | 'disconnected';
export type DeclaredDataOrigin = 'simulated' | 'physical-unverified' | 'unknown';

export interface VerifiedIngestProvenance {
  readonly sourceId: string;
  readonly operation: ProtectedMessageType;
  readonly eventId: string;
  readonly device: TechnicalDeviceKey;
}

declare const provenanceCapabilityBrand: unique symbol;
export interface IngestProvenanceCapability {
  readonly [provenanceCapabilityBrand]: never;
}

export interface IngestProvenanceAuthority {
  accepts(capability: unknown, expected: VerifiedIngestProvenance): boolean;
}

export type CandidateTimestamp<T> = Readonly<{
  value: T;
  origin: 'device-declared' | 'broker-declared' | 'ingest-received' | 'ingest-persisted';
  trustedForAttribution: false;
}>;

export interface ProtectedMeasurementCandidate {
  readonly status: 'candidate';
  readonly kind: 'measurement-candidate' | 'technical-event-candidate';
  readonly sourceId: string;
  readonly storeOperation: ProtectedStoreOperation;
  readonly operation: ProtectedMessageType;
  readonly eventId: string;
  readonly device: TechnicalDeviceKey;
  readonly declaredTechnicalIdentity: string;
  readonly idempotencyKey: Readonly<{ sourceId: string; operation: ProtectedStoreOperation; eventId: string }>;
  readonly timestamps: Readonly<{
    deviceTimestamp: CandidateTimestamp<string | number | null>;
    sentAt: CandidateTimestamp<number>;
    receivedAt: CandidateTimestamp<number>;
    persistedAt: CandidateTimestamp<number | null>;
  }>;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly provenance: Readonly<{
    technicalIdentityAuthorization: 'external-capability';
    payloadIntegrity: 'not-attested';
    brokerIdentityDeclared: 'broker-assertion-config-verified' | 'declared-unverified';
    mqttContext: 'service-declared';
    topic: string | null;
    dataOriginDeclared: DeclaredDataOrigin;
    physicalMeasurementVerified: false;
    commercialAttribution: false;
  }>;
  readonly eligibleForMeasurementMapping: boolean;
}

export type ProtectedIngestQuarantineCode =
  | 'unsupported-document'
  | 'invalid-schema'
  | 'missing-source'
  | 'missing-event-id'
  | 'missing-technical-identity'
  | 'conflicting-identity'
  | 'unverified-provenance'
  | 'unsupported-operation'
  | 'invalid-timestamp'
  | 'invalid-payload'
  | 'internal-error';

export interface ProtectedIngestQuarantined {
  readonly status: 'quarantined';
  readonly reason: ProtectedIngestQuarantineCode;
}

export type ProtectedIngestMapResult = ProtectedMeasurementCandidate | ProtectedIngestQuarantined;
