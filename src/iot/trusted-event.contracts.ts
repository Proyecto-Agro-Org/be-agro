// BE13-04 — ReadyForAttribution → revalidation → TrustedMeasurementEvent.
// Offline, fail-closed, no persistence, no routes, not composed in app.ts.
// Every decision that BE13-03 could not make (declaredAt, missingReason,
// persistedAt, BE-12 clock) comes from an injected policy whose default blocks.
import type { MissingReason, TrustedMeasurementEvent } from '../measurements/contracts.js';
import type { ProtectedMeasurementCandidate } from './protected-ingest.contracts.js';
import type {
  AssociationResolutionPort,
  DeviceResolutionPort,
  HardwareAuthorityPort,
  MeasurementCataloguePort,
  ReadyForAttribution,
  ReadyForAttributionFingerprints,
  ReadyForAttributionRevisions,
  TemporalAuthorityPort,
  TrustGateClock,
  TrustGateRealm,
} from './trust-gate.contracts.js';

// ------------------------------------------------------------ Revalidators
// Same contracts as the BE13-03 authorities: they read CURRENT state for the
// exact query BE13-03 used (rebuilt by trust-gate.queries.ts, never supplied by
// the caller). Their response is re-fingerprinted and compared with the ready.
// Realm isolation is an adapter/storage responsibility: the realm is part of
// every query and must be applied in storage; responses must echo it.
export type DeviceRevalidator = DeviceResolutionPort;
export type AssociationRevalidator = AssociationResolutionPort;
export type TemporalRevalidator = TemporalAuthorityPort;
export type CatalogueRevalidator = MeasurementCataloguePort;
export type HardwareRevalidator = HardwareAuthorityPort;

export interface TrustedEventRevalidators {
  readonly devices: DeviceRevalidator;
  readonly associations: AssociationRevalidator;
  readonly temporal: TemporalRevalidator;
  readonly catalogue: CatalogueRevalidator;
  readonly hardware: HardwareRevalidator;
}

// ------------------------------------------------------------ Policies
export type BE12Clock = 'received-at' | 'declared-at-approved';
export type DeclaredAtSource = 'device-timestamp' | 'broker-sent-at' | 'none';

export interface CandidateClocks {
  readonly deviceTimestamp: string | number | null;
  readonly sentAt: number;
  readonly receivedAt: number;
  readonly persistedAt: number | null;
}

export interface ClockPolicyQuery {
  readonly realm: TrustGateRealm;
  readonly eventId: string;
  readonly gateClock: TrustGateClock;
  readonly authorizedAt: number;
  readonly temporalPolicyRevision: number;
}
export type ClockPolicyDecision =
  | { readonly status: 'approved'; readonly realm: TrustGateRealm; readonly clock: BE12Clock; readonly policyRevision: number }
  | { readonly status: 'blocked'; readonly realm: TrustGateRealm };
export interface ClockPolicy { decide(query: ClockPolicyQuery): Promise<ClockPolicyDecision> }

export interface DeclaredAtPolicyQuery {
  readonly realm: TrustGateRealm;
  readonly eventId: string;
  readonly sourceId: string;
  readonly physicalDeviceId: string;
  // Candidate evidence (BE13-02): declared clocks, never trusted by themselves.
  readonly candidateClocks: CandidateClocks;
  // Ready evidence (BE13-03).
  readonly gateClock: TrustGateClock;
  readonly authorizedAt: number;
  readonly temporalPolicyRevision: number;
}
export type DeclaredAtPolicyDecision =
  | { readonly status: 'approved'; readonly realm: TrustGateRealm; readonly source: DeclaredAtSource; readonly declaredAt: number | null;
      readonly policyRevision: number }
  | { readonly status: 'blocked'; readonly realm: TrustGateRealm };
export interface DeclaredAtPolicy { decide(query: DeclaredAtPolicyQuery): Promise<DeclaredAtPolicyDecision> }

// Consulted ONLY when the value is null. A numeric value (0 included) never
// carries a missing reason; an absent field never reaches BE13-04.
export interface MissingReasonPolicyQuery {
  readonly realm: TrustGateRealm;
  readonly eventId: string;
  readonly physicalDeviceId: string;
  readonly sensorId: string;
  readonly field: string;
  readonly magnitude: string;
  readonly unit: string;
}
export type MissingReasonPolicyDecision =
  | { readonly status: 'approved'; readonly realm: TrustGateRealm; readonly missingReason: MissingReason; readonly policyRevision: number }
  | { readonly status: 'blocked'; readonly realm: TrustGateRealm };
export interface MissingReasonPolicy { decide(query: MissingReasonPolicyQuery): Promise<MissingReasonPolicyDecision> }

// Consulted ONLY when the candidate carries persistedAt. A null persistedAt is
// never completed (no Date.now, receivedAt, sentAt or authorizedAt).
export interface PersistenceTimePolicyQuery {
  readonly realm: TrustGateRealm;
  readonly eventId: string;
  readonly receivedAt: number;
  readonly persistedAt: number;
}
export type PersistenceTimePolicyDecision =
  | { readonly status: 'approved'; readonly realm: TrustGateRealm; readonly persistedAt: number; readonly policyRevision: number }
  | { readonly status: 'blocked'; readonly realm: TrustGateRealm };
export interface PersistenceTimePolicy { decide(query: PersistenceTimePolicyQuery): Promise<PersistenceTimePolicyDecision> }

export interface TrustedEventPolicies {
  readonly clock?: ClockPolicy;
  readonly declaredAt?: DeclaredAtPolicy;
  readonly missingReason?: MissingReasonPolicy;
  readonly persistenceTime?: PersistenceTimePolicy;
}

export interface TrustedEventBuilderPorts {
  readonly revalidators: TrustedEventRevalidators;
  readonly policies?: TrustedEventPolicies;
}

export interface TrustedEventBuilderOptions {
  readonly realm: TrustGateRealm;
  readonly authorityTimeoutMs?: number;
}

// ------------------------------------------------------------ Results
export type TrustedEventQuarantineCode =
  | 'invalid-candidate'
  | 'invalid-ready'
  | 'realm-mismatch'
  | 'stale-device'
  | 'stale-association'
  | 'stale-temporal-policy'
  | 'stale-catalog'
  | 'stale-hardware'
  | 'unresolved-clock'
  | 'unapproved-declared-at'
  | 'missing-declared-at'
  | 'missing-reason-required'
  | 'invalid-missing-reason'
  | 'unresolved-persisted-at'
  | 'schema-mismatch'
  | 'contradictory-authority'
  | 'invalid-authority-response'
  | 'dependency-error'
  | 'internal-error';

export interface TrustedEventQuarantined {
  readonly status: 'quarantined';
  readonly reason: TrustedEventQuarantineCode;
  readonly eventId: string | null;
}

export interface TrustedEventAttribution {
  // Values BE-12 must independently reproduce; NOT an AttributionResult.
  readonly realm: TrustGateRealm;
  readonly authorizedAt: number;
  readonly clock: BE12Clock;
  readonly physicalDeviceId: string;
  readonly clientId: string;
  readonly fieldId: string;
  readonly areaId: string;
  readonly sensorId: string;
  readonly associationId: string;
  readonly associationRevision: number;
}

export interface TrustedEventPolicyRevisions {
  readonly clock: number;
  readonly declaredAt: number;
  readonly declaredAtSource: DeclaredAtSource;
  readonly missingReason: number | null;
  readonly persistenceTime: number;
}

export interface TrustedEventReady {
  readonly status: 'trusted-event';
  // Exactly one BE-12 TrustedMeasurementEvent, parsed by trustedMeasurementEventSchema.
  readonly event: TrustedMeasurementEvent;
  readonly attribution: TrustedEventAttribution;
  readonly policies: TrustedEventPolicyRevisions;
  readonly revisions: ReadyForAttributionRevisions;
  readonly fingerprints: ReadyForAttributionFingerprints;
  // BE-12 resolve() still re-reads its own ports before attributing.
  readonly revalidation: 'required';
}

export type TrustedEventResult = TrustedEventReady | TrustedEventQuarantined;

export interface TrustedEventBuilder {
  build(candidate: ProtectedMeasurementCandidate, ready: ReadyForAttribution): Promise<TrustedEventResult>;
}
