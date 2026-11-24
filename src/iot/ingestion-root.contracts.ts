// BE13-07 — Composition root contracts. The root is the ONLY high-level
// factory meant to assemble BE13-02 → BE13-06 for a future runtime. It is NOT
// mounted in app.ts and does not authenticate anything by itself: it decides
// WHICH implementations are treated as authorities. WeakSet/WeakMap registries
// remain in-process provenance only. External authentication is pending.
import type { ExternalProvenanceVerifier } from './ingest-provenance.authority.js';
import type { MeasurementProvenance, TemporalDecision, TrustedMeasurementEvent } from '../measurements/contracts.js';
import type { ProtectedIngestQuarantineCode } from './protected-ingest.contracts.js';
import type {
  HardwareAuthorityPort,
  MeasurementCataloguePort,
  TemporalAuthorityPort,
  TrustGateRealm,
} from './trust-gate.contracts.js';
import type { ClockPolicy, DeclaredAtPolicy, MissingReasonPolicy, PersistenceTimePolicy } from './trusted-event.contracts.js';
import type {
  IngestionIdentityStore,
  MeasurementPersistencePort,
  PersistentCompositionResult,
} from './ingestion-composition.contracts.js';

// Realm comes from an authorized deployment/composition context, never from an
// MQTT payload, topic, sourceId, clientid or device id. Read ONCE at construction.
export interface RealmAuthority {
  authorizedRealm(): TrustGateRealm;
}

// BE-12 attribution service authorities (its devices/associations ports are
// built by the root from the same realm-scoped identity store).
export interface Be12AuthorityPorts {
  readonly temporal: { select(event: TrustedMeasurementEvent): Promise<TemporalDecision> };
  readonly catalogue: { accepts(input: { readonly magnitude: string; readonly unit: string; readonly provenance: MeasurementProvenance }): Promise<boolean> };
}

// Explicit acknowledgement so the current-state-only device limitation cannot be lost.
export interface DeviceStatusHistoryAcknowledgement {
  readonly mode: 'current-state-only';
  readonly limitation: 'DEVICE_STATUS_HISTORY_REQUIRED';
}

export interface MeasurementIngestionRootDependencies {
  readonly realmAuthority: RealmAuthority;
  readonly provenanceVerifier: ExternalProvenanceVerifier;
  readonly hardware: HardwareAuthorityPort;
  readonly temporal: TemporalAuthorityPort;
  readonly catalogue: MeasurementCataloguePort;
  readonly policies: {
    readonly declaredAt: DeclaredAtPolicy;
    readonly clock: ClockPolicy;
    readonly missingReason: MissingReasonPolicy;
    readonly persistenceTime: PersistenceTimePolicy;
  };
  readonly identityStore: IngestionIdentityStore;
  readonly persistence: MeasurementPersistencePort;
  readonly be12: Be12AuthorityPorts;
  readonly deviceStatusHistory: DeviceStatusHistoryAcknowledgement;
  readonly authorityTimeoutMs?: number;
}

export interface RootMapperQuarantined {
  readonly status: 'quarantined';
  readonly reason: 'mapper-rejected';
  readonly cause: ProtectedIngestQuarantineCode;
  readonly eventId: null;
}

export type MeasurementIngestionRootResult = PersistentCompositionResult | RootMapperQuarantined;

export type DependencyReadiness = 'MISSING' | 'BLOCKED' | 'INJECTED_UNVERIFIED';
export interface IngestionRootReadiness {
  // READY_FOR_TEST only means "no missing dependency and no blocking placeholder";
  // it is NOT a production approval and does not verify any authority.
  readonly overall: 'READY_FOR_TEST' | 'BLOCKED';
  readonly dependencies: Readonly<Record<string, DependencyReadiness>>;
  readonly limitations: readonly ['DEVICE_STATUS_HISTORY_REQUIRED'];
}

export interface MeasurementIngestionRoot {
  ingest(protectedDocument: unknown, provenanceEvidence: unknown, selection: { readonly field: string }): Promise<MeasurementIngestionRootResult>;
  readonly realm: TrustGateRealm;
}
