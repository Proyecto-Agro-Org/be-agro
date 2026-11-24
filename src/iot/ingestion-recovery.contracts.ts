// BE13-08 — Retry semantics, persistence recovery, quarantine and replay.
// Offline/local only; not mounted in app.ts; no background processing.
// See ADR_BE13_08_RETRY_SEMANTICS.md and ADR_BE13_08_QUARANTINE.md.
import type { TechnicalDeviceKey } from '../telemetry/association.contracts.js';
import type { ProtectedStoreOperation } from './protected-ingest.contracts.js';
import type { TrustGateRealm } from './trust-gate.contracts.js';
import type { IdempotencyKey } from './ingestion-composition.contracts.js';
import type { MeasurementIngestionRootDependencies } from './ingestion-root.contracts.js';

// ------------------------------------------------------------ Classification
// Deterministic, in code. A policy can never turn a non-retryable class into a retryable one.
export type RetryClass =
  | 'transient'          // dependency/persistence temporarily unavailable, authority changed between reads
  | 'ambiguous-commit'   // persistence outcome unknown: MUST be recovered before anything else
  | 'validation'         // malformed input / selection: permanent
  | 'security'           // provenance, hardware, realm, contradictions, drift: permanent, never auto-retried
  | 'conflict'           // same key, different content: permanent
  | 'policy-blocked'     // waits for a human decision (BLOCKED_BY_POLICY)
  | 'consistency'        // persistence state inconsistent: permanent until a human investigates
  | 'unknown';           // internal error: conservative

export type IngestionStage = 'mapper' | 'trust-gate' | 'builder' | 'be12' | 'composition' | 'persistence' | 'recovery' | 'retry';

export interface FailureClassification {
  readonly retryClass: RetryClass;
  readonly stage: IngestionStage;
  readonly reasonCode: string;   // closed code, kebab-case
  readonly retryable: boolean;   // true only for 'transient' (ambiguous is recovered first)
}

// ------------------------------------------------------------ Retry policy & scheduler
export interface RetryDecisionInput {
  readonly realm: TrustGateRealm;
  readonly attempt: number;            // attempts already made (≥ 1)
  readonly retryClass: 'transient';    // only retryable classes ever reach the policy
  readonly reasonCode: string;
}
export type RetryDecision =
  | { readonly action: 'retry' }
  | { readonly action: 'stop' };       // → quarantine as RETRYABLE (retry exhausted), never discarded
export interface IngestionRetryPolicy { decide(input: RetryDecisionInput): RetryDecision }

// Delays are delegated so tests are deterministic and no real long sleeps exist.
export interface RetryScheduler { wait(input: { readonly attempt: number; readonly reasonCode: string }): Promise<void> }

// ------------------------------------------------------------ Recovery
export type RecoveryState = 'committed' | 'not-committed' | 'inconsistent';
export type RecoveryInconsistency =
  | 'orphan-claim' | 'orphan-measurement' | 'claim-measurement-mismatch' | 'fingerprint-mismatch' | 'malformed-claim' | 'malformed-measurement' | 'unexpected-identity';
export type RecoveryReport =
  | { readonly realm: TrustGateRealm; readonly state: 'committed'; readonly measurementId: string; readonly fingerprint: string }
  | { readonly realm: TrustGateRealm; readonly state: 'not-committed' }
  | { readonly realm: TrustGateRealm; readonly state: 'inconsistent'; readonly inconsistency: RecoveryInconsistency };
// Read-only. Never repairs, never deletes evidence.
export interface PersistenceRecoveryPort { inspect(key: IdempotencyKey): Promise<RecoveryReport> }

// ------------------------------------------------------------ Quarantine
export type QuarantineStatus = 'OPEN' | 'RETRYABLE' | 'REPLAYING' | 'BLOCKED' | 'RESOLVED' | 'DISCARDED';
export interface QuarantineEntry {
  readonly realm: TrustGateRealm;
  readonly stage: IngestionStage;
  readonly sourceId: string | null;
  readonly operation: ProtectedStoreOperation | null;
  readonly eventId: string | null;
  readonly field: string | null;
  readonly device: TechnicalDeviceKey | null;
  readonly reasonCode: string;
  readonly cause: string | null;
  readonly retryClass: RetryClass;
  readonly fingerprint: string | null;      // technical input fingerprint (no payload)
  readonly documentDigest: string | null;   // SHA-256 of a canonical document when no eventId exists
}
export interface QuarantineAuditEntry {
  readonly action: 'recorded' | 'transition' | 'replay';
  readonly outcome: string;
  readonly reasonCode: string | null;
  readonly evidence: string | null;
}
export interface QuarantineRecord extends QuarantineEntry {
  readonly quarantineId: string;
  readonly status: QuarantineStatus;
  readonly version: number;   // BE13-09: incremented on every mutation (CAS)
  readonly attemptCount: number;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  readonly audit: readonly (QuarantineAuditEntry & { readonly at: number })[];
  // BE13-10B: present ONLY while status is REPLAYING (enforced by the Mongo validator).
  readonly lease?: QuarantineLease | null;
}
// BE13-10B — replay lease. ownerId comes from the authorized OperatorPrincipal; acquiredAt from the
// OperationsTimeAuthority (never from the caller); token = the record version produced by the acquiring CAS
// (monotonic per record, unique per acquisition): it is the FENCING TOKEN. Not random, not a secret.
export interface QuarantineLease { readonly ownerId: string; readonly acquiredAt: number; readonly token: number }
// Who may settle a replay: the holder of an exact lease, or (non-leased BE13-08 replay) whoever still sees RETRYABLE.
export type ReplayHolder =
  | { readonly kind: 'lease'; readonly ownerId: string; readonly leaseToken: number }
  | { readonly kind: 'unleased' };
export type LeaseAcquireResult = { readonly result: 'acquired'; readonly leaseToken: number } | { readonly result: 'stale' | 'not-found' | 'not-allowed' };
export type TransitionResult = 'transitioned' | 'not-allowed' | 'not-found' | 'stale';
export interface IngestionQuarantineStore {
  record(entry: QuarantineEntry): Promise<{ readonly realm: TrustGateRealm; readonly quarantineId: string; readonly status: QuarantineStatus; readonly attemptCount: number }>;
  get(quarantineId: string): Promise<QuarantineRecord | null>;
  // Conditional on `from`; illegal transitions are refused by the state machine.
  // expectedVersion (BE13-09): when given, the transition also requires that exact version (optimistic CAS).
  // BE13-10B: transitions into or out of REPLAYING are refused here ('not-allowed'); only the lease CAS below handles them.
  transition(input: { readonly quarantineId: string; readonly from: QuarantineStatus; readonly to: QuarantineStatus; readonly evidence: string | null;
    readonly outcome: string; readonly expectedVersion?: number }): Promise<TransitionResult>;
  // BE13-10B: single CAS RETRYABLE(version) → REPLAYING with lease { ownerId, acquiredAt, token }.
  acquireLease(input: { readonly quarantineId: string; readonly expectedVersion: number; readonly ownerId: string; readonly acquiredAt: number }): Promise<LeaseAcquireResult>;
  // BE13-10B: single CAS that ends a replay. lease holder → REPLAYING + exact owner + exact token (+ version when given);
  // unleased → RETRYABLE. Clears the lease. `transaction` (opaque) runs it inside the persistence transaction: this is the
  // FENCE that makes "measurement written" and "lease still held" one atomic fact.
  settleReplay(input: { readonly quarantineId: string; readonly holder: ReplayHolder; readonly to: 'RESOLVED' | 'RETRYABLE' | 'BLOCKED';
    readonly outcome: string; readonly evidence: string | null; readonly expectedVersion?: number }, transaction?: unknown): Promise<TransitionResult>;
  // BE13-09: counts per status and reason inside the store realm (no identifiers).
  summarize?(): Promise<readonly { readonly status: QuarantineStatus; readonly reasonCode: string; readonly retryClass: RetryClass; readonly count: number }[]>;
  appendAudit(quarantineId: string, entry: QuarantineAuditEntry): Promise<boolean>;
}

// ------------------------------------------------------------ Resilient root
export interface ResilientIngestionDependencies extends MeasurementIngestionRootDependencies {
  readonly retryPolicy: IngestionRetryPolicy;
  readonly retryScheduler: RetryScheduler;
  readonly recovery: PersistenceRecoveryPort;
  readonly quarantine: IngestionQuarantineStore;
}

export type ResilientIngestionResult =
  | { readonly status: 'accepted'; readonly measurementId: string; readonly eventId: string; readonly attempts: number }
  | { readonly status: 'duplicate'; readonly measurementId: string; readonly eventId: string; readonly attempts: number }
  // R1: the commit outcome was ambiguous and recovery proved it committed with this exact content.
  | { readonly status: 'recovered-committed'; readonly measurementId: string; readonly eventId: string; readonly attempts: number }
  | { readonly status: 'quarantined'; readonly quarantineId: string | null; readonly quarantineStatus: QuarantineStatus | null;
      readonly reasonCode: string; readonly retryClass: RetryClass; readonly eventId: string | null; readonly attempts: number }
  // Quarantine store itself unavailable: nothing could be recorded; caller must retry the same input.
  | { readonly status: 'uncertain'; readonly reasonCode: 'quarantine-unavailable' | 'recovery-unavailable'; readonly eventId: string | null; readonly attempts: number };

export type ReplayResult =
  | { readonly status: 'replay-rejected'; readonly reasonCode: 'quarantine-not-found' | 'replay-not-allowed' | 'replay-identity-mismatch' | 'replay-fingerprint-mismatch' | 'invalid-replay-input'
      // BE13-10B: the lease/fence was no longer held when the measurement would have been written (nothing was written),
      // or the persistence adapter cannot fence (nothing was attempted).
      | 'stale-replay-lease' | 'replay-fence-unsupported' }
  | { readonly status: 'replayed'; readonly quarantineId: string; readonly outcome: ResilientIngestionResult; readonly quarantineStatus: QuarantineStatus };

export interface ResilientMeasurementIngestion {
  readonly realm: TrustGateRealm;
  ingest(protectedDocument: unknown, provenanceEvidence: unknown, selection: { readonly field: string }): Promise<ResilientIngestionResult>;
  // Explicit, never automatic. Requires the ORIGINAL document and provenance evidence again.
  // lease (BE13-10B): the operations service holds this exact lease (REPLAYING, owner, token); the measurement is only
  // written if the lease is still held INSIDE the persistence transaction (fence), and the replay always settles it.
  // Without lease (BE13-08): fenced on the entry still being RETRYABLE.
  replay(input: { readonly quarantineId: string; readonly protectedDocument: unknown; readonly provenanceEvidence: unknown; readonly field: string;
    readonly lease?: { readonly ownerId: string; readonly leaseToken: number } }): Promise<ReplayResult>;
}
