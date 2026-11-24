// BE13-05 — Offline composition BE13-02 → BE13-03 → BE13-04 → BE-12.
// Not mounted in app.ts, no routes, no workers, no persistence, no external IO.
// TypeScript types are NOT a security boundary; WeakSet/WeakMap registries are
// in-process provenance; injected policies/adapters are not authentication.
// The productive trust boundary is the composition root that chooses adapters.
import type { AttributionResult, TrustedMeasurementEvent } from '../measurements/contracts.js';
import type { ProtectedMeasurementCandidate, ProtectedStoreOperation } from './protected-ingest.contracts.js';
import type { TechnicalDeviceKey } from '../telemetry/association.contracts.js';
import type { Lifecycle, VerificationState } from '../sensors/contracts.js';
import type {
  HardwareAuthorityPort,
  MeasurementCataloguePort,
  TemporalAuthorityPort,
  TrustGateRealm,
} from './trust-gate.contracts.js';
import type { ClockPolicy, DeclaredAtPolicy, MissingReasonPolicy, PersistenceTimePolicy } from './trusted-event.contracts.js';

// ---------------------------------------------------------------- Identity store
// Realm-scoped READ store for ingestion. Every query carries the realm and the
// implementation MUST apply it in storage. Rows also carry their realm so the
// adapters can reject a store that leaks rows from another realm.
// BE-11's SensorRepository is client-scoped and exposes neither a lookup by
// technical key within a realm nor an association-at-instant query, so a
// Mongo implementation of this port is PENDING (requires a BE-11 contract
// extension tested against a real replica set).
export interface StoredPhysicalDevice {
  readonly realm: TrustGateRealm;
  readonly id: string;
  readonly sourceId: string;
  readonly key: TechnicalDeviceKey;
  readonly verification: VerificationState;
  readonly lifecycle: Lifecycle;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface StoredDeviceAssociation {
  readonly realm: TrustGateRealm;
  readonly id: string;
  readonly revision: number;
  readonly clientId: string;
  readonly sensorId: string;
  readonly fieldId: string;
  readonly areaId: string;
  readonly physicalDeviceId: string;
  readonly sourceId: string;
  readonly device: TechnicalDeviceKey;
  readonly validFrom: number;
  readonly validTo: number | null;
  readonly state: 'active' | 'closed';
  readonly auditReason: string;
}

export interface IngestionIdentityStore {
  findDevicesByKey(query: { readonly realm: TrustGateRealm; readonly sourceId: string; readonly key: TechnicalDeviceKey; readonly limit: 2 }):
    Promise<{ readonly realm: TrustGateRealm; readonly rows: readonly StoredPhysicalDevice[] }>;
  // Rows whose [validFrom, validTo) contains `at`, filtered in storage.
  findAssociationsAt(query: { readonly realm: TrustGateRealm; readonly physicalDeviceId: string; readonly at: number; readonly limit: 2 }):
    Promise<{ readonly realm: TrustGateRealm; readonly complete: true; readonly rows: readonly StoredDeviceAssociation[] }>;
}

// ---------------------------------------------------------------- Idempotency
// Key: realm + sourceId + operation + eventId + field. One logical measurement
// per (event, payload field). Transport retries carry the same fingerprint;
// a semantic duplicate with different content is a conflict. No exactly-once.
export interface IdempotencyKey {
  readonly realm: TrustGateRealm;
  readonly sourceId: string;
  readonly operation: ProtectedStoreOperation;
  readonly eventId: string;
  readonly field: string;
}

export type IdempotencyLookup =
  | { readonly realm: TrustGateRealm; readonly status: 'absent' }
  | { readonly realm: TrustGateRealm; readonly status: 'present'; readonly fingerprint: string };

// claim() MUST be atomic in the adapter (e.g. unique-index insert): exactly one
// concurrent caller obtains 'claimed' for a key.
export type IdempotencyClaim =
  | { readonly realm: TrustGateRealm; readonly status: 'claimed' }
  | { readonly realm: TrustGateRealm; readonly status: 'replay' }
  | { readonly realm: TrustGateRealm; readonly status: 'conflict' };

export interface MeasurementIdempotencyPort {
  lookup(key: IdempotencyKey): Promise<IdempotencyLookup>;
  claim(input: IdempotencyKey & { readonly fingerprint: string }): Promise<IdempotencyClaim>;
}

// ---------------------------------------------------------------- BE-12
export interface MeasurementAttributionService {
  resolve(event: unknown): Promise<AttributionResult>;
}

// ---------------------------------------------------------------- Composition root
export interface RealmContext {
  // Authorized realm of this composition. NEVER taken from an IoT payload.
  readonly realm: TrustGateRealm;
}

export interface MeasurementIngestionDependencies {
  readonly realmContext: RealmContext;
  readonly identityStore: IngestionIdentityStore;
  readonly temporal: TemporalAuthorityPort;
  readonly hardware: HardwareAuthorityPort;
  readonly catalogue: MeasurementCataloguePort;
  readonly policies: {
    readonly clock: ClockPolicy;
    readonly declaredAt: DeclaredAtPolicy;
    readonly missingReason: MissingReasonPolicy;
    readonly persistenceTime: PersistenceTimePolicy;
  };
  readonly idempotency: MeasurementIdempotencyPort;
  readonly be12: MeasurementAttributionService;
  readonly authorityTimeoutMs?: number;
}

// ---------------------------------------------------------------- Results
export type CompositionQuarantineCode =
  | 'invalid-candidate'
  | 'invalid-selection'
  | 'trust-gate-rejected'
  | 'builder-rejected'
  | 'be12-rejected'
  | 'realm-mismatch'
  | 'attribution-drift'
  | 'idempotency-conflict'
  | 'idempotency-unavailable'
  | 'dependency-error'
  | 'internal-error';

export interface CompositionQuarantined {
  readonly status: 'quarantined';
  readonly reason: CompositionQuarantineCode;
  // Closed upstream code (gate/builder/BE-12 reason) when applicable; never a message.
  readonly cause: string | null;
  readonly eventId: string | null;
}

export interface CompositionAttribution {
  readonly realm: TrustGateRealm;
  readonly attributedAt: number;
  readonly clock: 'received-at' | 'declared-at-approved';
  readonly physicalDeviceId: string;
  readonly clientId: string;
  readonly fieldId: string;
  readonly areaId: string;
  readonly sensorId: string;
  readonly associationId: string;
  readonly associationRevision: number;
}

export interface CompositionAccepted {
  readonly status: 'accepted';
  readonly event: TrustedMeasurementEvent;
  // Reconciled: BE13-04 expectation and BE-12 resolution were identical.
  readonly attribution: CompositionAttribution;
  readonly idempotency: Readonly<{ key: IdempotencyKey; fingerprint: string }>;
  // Nothing is persisted by this stage.
  readonly persisted: false;
}

export interface CompositionDuplicate {
  readonly status: 'duplicate';
  readonly eventId: string;
  readonly idempotency: Readonly<{ key: IdempotencyKey; fingerprint: string }>;
}

export type CompositionResult = CompositionAccepted | CompositionDuplicate | CompositionQuarantined;

export interface MeasurementIngestionComposition {
  ingest(candidate: ProtectedMeasurementCandidate, selection: { readonly field: string }): Promise<CompositionResult>;
}
