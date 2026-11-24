// BE13-03 — Identity-resolution gate. Offline, fail-closed coordination of
// injected authorities. A `ready-for-attribution` result is NOT a
// TrustedMeasurementEvent, is not persisted and is not productive evidence:
// it only states that every injected authority answered consistently.
import type { PhysicalDevice, SensorDeviceAssociation } from '../sensors/contracts.js';
import type { TechnicalDeviceKey } from '../telemetry/association.contracts.js';
import type { DeclaredDataOrigin, ProtectedMeasurementCandidate } from './protected-ingest.contracts.js';

export type TrustGateRealm = 'development' | 'test' | 'preview' | 'production';

// ---------------------------------------------------------------- A. Device
export interface DeviceResolutionQuery {
  readonly realm: TrustGateRealm;
  readonly sourceId: string;
  readonly device: TechnicalDeviceKey;
  readonly limit: 2;
}
// Reuses the BE-11 PhysicalDevice contract (verification, lifecycle, version).
export interface DeviceResolution {
  readonly realm: TrustGateRealm;
  readonly devices: readonly PhysicalDevice[];
}
export interface DeviceResolutionPort { resolve(query: DeviceResolutionQuery): Promise<DeviceResolution> }

// ----------------------------------------------------------- B. Association
export interface AssociationAtQuery {
  readonly realm: TrustGateRealm;
  readonly physicalDeviceId: string;
  // Authorized instant from the temporal authority; never "now".
  readonly at: number;
  readonly limit: 2;
}
// Contract: storage filters by [validFrom, validTo) containing `at`. Returning a
// record that does not contain `at` is a contract violation, not a hint.
export interface AssociationAtResolution {
  readonly realm: TrustGateRealm;
  readonly complete: true;
  readonly records: readonly SensorDeviceAssociation[];
}
export interface AssociationResolutionPort { findAt(query: AssociationAtQuery): Promise<AssociationAtResolution> }

// ------------------------------------------------------------- C. Temporal
export type TrustGateClock = 'received-at' | 'device-declared-approved' | 'broker-declared-approved';
export interface TemporalAuthorityQuery {
  readonly realm: TrustGateRealm;
  readonly eventId: string;
  readonly sourceId: string;
  readonly physicalDeviceId: string;
  readonly timestamps: Readonly<{
    deviceTimestamp: string | number | null;
    sentAt: number;
    receivedAt: number;
    persistedAt: number | null;
  }>;
}
export type TemporalAuthorityDecision =
  | { readonly status: 'trusted'; readonly realm: TrustGateRealm; readonly at: number; readonly clock: TrustGateClock; readonly policyRevision: number }
  | { readonly status: 'untrusted'; readonly realm: TrustGateRealm; readonly reason: 'untrusted-clock' }
  | { readonly status: 'unresolved'; readonly realm: TrustGateRealm };
export interface TemporalAuthorityPort { decide(query: TemporalAuthorityQuery): Promise<TemporalAuthorityDecision> }

// ------------------------------------------------- D. Magnitude/unit catalogue
export interface CatalogueQuery {
  readonly realm: TrustGateRealm;
  readonly sourceId: string;
  readonly physicalDeviceId: string;
  readonly sensorId: string;
  // Technical payload field selected for evaluation; not an approved magnitude.
  readonly field: string;
  readonly valueKind: 'number' | 'null';
  readonly at: number;
}
export type CatalogueDecision =
  | { readonly status: 'approved'; readonly realm: TrustGateRealm; readonly field: string; readonly magnitude: string; readonly unit: string; readonly catalogueRevision: number }
  | { readonly status: 'unknown-magnitude'; readonly realm: TrustGateRealm }
  | { readonly status: 'incompatible-unit'; readonly realm: TrustGateRealm };
export interface MeasurementCataloguePort { evaluate(query: CatalogueQuery): Promise<CatalogueDecision> }

// --------------------------------------------- E. Provenance / hardware
export interface HardwareAuthorityQuery {
  readonly realm: TrustGateRealm;
  readonly eventId: string;
  readonly sourceId: string;
  readonly device: TechnicalDeviceKey;
  readonly physicalDeviceId: string;
  readonly dataOriginDeclared: DeclaredDataOrigin;
}
export type HardwareOrigin = 'physical' | 'simulated';
export type HardwareDecision =
  | { readonly status: 'verified'; readonly realm: TrustGateRealm; readonly physicalDeviceId: string; readonly origin: HardwareOrigin;
      readonly method: string; readonly attestationRevision: number }
  | { readonly status: 'unverified'; readonly realm: TrustGateRealm };
export interface HardwareAuthorityPort { verify(query: HardwareAuthorityQuery): Promise<HardwareDecision> }

export interface TrustGatePorts {
  readonly devices?: DeviceResolutionPort;
  readonly associations?: AssociationResolutionPort;
  readonly temporal?: TemporalAuthorityPort;
  readonly catalogue?: MeasurementCataloguePort;
  readonly hardware?: HardwareAuthorityPort;
}

export interface TrustGateOptions {
  readonly realm: TrustGateRealm;
  // Operational bound for a non-responding authority. Not a temporal tolerance.
  readonly authorityTimeoutMs?: number;
}

export interface TrustGateSelection {
  // Technical payload key to evaluate. Selecting a field never attributes it.
  readonly field: string;
}

// --------------------------------------------------------------- Results
export type TrustGateQuarantineCode =
  | 'invalid-candidate'
  | 'absent-field'
  | 'invalid-value'
  | 'unresolved-device'
  | 'ambiguous-device'
  | 'unverified-device'
  | 'inactive-device'
  | 'unverified-hardware'
  | 'unresolved-time'
  | 'untrusted-clock'
  | 'missing-association'
  | 'overlapping-association'
  | 'stale-association'
  | 'stale-resolution'
  | 'unapproved-magnitude'
  | 'incompatible-unit'
  | 'realm-mismatch'
  | 'contradictory-authority'
  | 'invalid-authority-response'
  | 'dependency-error'
  | 'internal-error';

export interface TrustGateQuarantined {
  readonly status: 'quarantined';
  readonly reason: TrustGateQuarantineCode;
  // Present only when the input was a genuine issued candidate.
  readonly eventId: string | null;
}

export interface ReadyForAttributionRevisions {
  readonly deviceVersion: number;
  readonly associationId: string;
  readonly associationRevision: number;
  readonly temporalPolicyRevision: number;
  readonly catalogueRevision: number;
  readonly hardwareAttestationRevision: number;
}

export interface ReadyForAttribution {
  readonly status: 'ready-for-attribution';
  readonly realm: TrustGateRealm;
  readonly eventId: string;
  readonly sourceId: string;
  readonly device: TechnicalDeviceKey;
  readonly physicalDeviceId: string;
  // Only from the historical association resolved at `authorizedAt`.
  readonly clientId: string;
  readonly fieldId: string;
  readonly areaId: string;
  readonly sensorId: string;
  readonly associationId: string;
  readonly association: Readonly<{ validFrom: number; validTo: number | null }>;
  readonly authorizedAt: number;
  readonly clock: TrustGateClock;
  readonly field: string;
  readonly magnitude: string;
  readonly unit: string;
  // Unconverted. null is preserved as null; its missing reason is NOT inferred.
  readonly value: number | null;
  readonly timestamps: Readonly<{ receivedAt: number; persistedAt: number | null }>;
  readonly provenance: Readonly<{
    technicalIdentityAuthorization: 'external-capability';
    payloadIntegrity: 'not-attested';
    dataOriginDeclared: DeclaredDataOrigin;
    hardware: Readonly<{ status: 'verified'; origin: HardwareOrigin; method: string }>;
  }>;
  readonly revisions: ReadyForAttributionRevisions;
  // BE13-04/BE-12 must re-read every authority before emitting attribution.
  readonly revalidation: 'required';
}

export type TrustGateResult = ReadyForAttribution | TrustGateQuarantined;

export interface TrustGate {
  evaluate(candidate: ProtectedMeasurementCandidate, selection: TrustGateSelection): Promise<TrustGateResult>;
}
