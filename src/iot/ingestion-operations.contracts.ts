// BE13-09 — Operations governance: operator authorization, separate append-only
// audit, observability contracts, offline bootstrap and operational readiness.
// Not mounted anywhere: no endpoints, workers, schedulers or external providers.
// Trust model: every authority here is INJECTED by the bootstrap. Code able to
// compose its own bootstrap can inject permissive authorities; nothing in this
// layer sandboxes in-process code.
import type { QuarantineStatus, RetryClass, IngestionStage, ResilientIngestionDependencies, ResilientIngestionResult, ReplayResult } from './ingestion-recovery.contracts.js';
import type { TrustGateRealm } from './trust-gate.contracts.js';
import type { OperationsTimeAuthority, ReplayLeasePolicy } from './operations-security-policy.contracts.js';

// ---------------------------------------------------------------- operators
export type OperatorCapability =
  | 'QUARANTINE_VIEW'
  | 'QUARANTINE_REPLAY'
  | 'QUARANTINE_UNBLOCK'
  | 'QUARANTINE_BLOCK'
  | 'QUARANTINE_RESOLVE'
  | 'QUARANTINE_DISCARD'
  | 'AUDIT_VIEW'
  | 'OPERATIONS_VIEW';

// Resolved BY THE AUTHORITY, never taken from the request.
export interface OperatorPrincipal {
  readonly operatorId: string;
  readonly realms: readonly TrustGateRealm[];
  readonly capabilities: readonly OperatorCapability[];
  readonly authenticationReference: string; // opaque reference of the upstream authentication (no secrets)
}

export interface AuthorizationRequest {
  readonly credential: unknown;               // opaque; only the authority interprets it
  readonly realm: TrustGateRealm;
  readonly capability: OperatorCapability;
  readonly quarantineId: string | null;
}
export type AuthorizationDecision =
  | { readonly decision: 'allow'; readonly principal: OperatorPrincipal }
  | { readonly decision: 'deny'; readonly reason: 'unauthenticated' | 'forbidden' | 'realm-out-of-scope' };
export interface OperatorAuthorizationPort { authorize(request: AuthorizationRequest): Promise<AuthorizationDecision> }

// ---------------------------------------------------------------- evidence
export type EvidenceType = 'policy-approval' | 'authority-restored' | 'dependency-restored' | 'data-verified' | 'operator-decision';
export interface ResolutionEvidenceInput {
  readonly evidenceType: EvidenceType;
  readonly reference: string;                                       // ticket / document reference, safe charset
  readonly metadata?: Readonly<Record<string, string | number | boolean>>; // ≤ 10 scalar entries
}
// issuedBy comes from the authorized principal; issuedAt from the audit store (server time).
export interface ResolutionEvidence extends ResolutionEvidenceInput {
  readonly issuedBy: string;
  readonly verification: 'DECLARED_UNVERIFIED';
}

// ---------------------------------------------------------------- audit (append-only)
export type AuditAction =
  | 'quarantine-created' | 'quarantine-recurred' | 'classification-changed' | 'recovery-outcome'
  | 'replay-requested' | 'replay-denied' | 'replay-started' | 'replay-result'
  | 'transition-requested' | 'transition-result' | 'resolved' | 'discarded' | 'authorization-denied'
  // BE13-10B — replay lease governance
  | 'lease-acquired' | 'lease-release-requested' | 'lease-released-owner' | 'lease-recovery-requested' | 'lease-recovered-expired' | 'lease-release-denied'
  | 'stale-replay-blocked';
export interface AuditAppend {
  readonly realm: TrustGateRealm;
  readonly quarantineId: string | null;
  readonly eventId: string | null;
  readonly action: AuditAction;
  readonly actorId: string;                          // operatorId or 'system'
  readonly actorCapabilities: readonly OperatorCapability[];
  readonly outcome: string;                          // kebab-case closed code
  readonly reasonCode: string | null;
  readonly evidence: { readonly evidenceType: EvidenceType; readonly reference: string; readonly verification: 'DECLARED_UNVERIFIED' } | null;
}
export interface AuditRecord extends AuditAppend {
  readonly auditId: string;
  readonly stream: string;     // quarantineId or 'realm'
  readonly sequence: number;   // strictly increasing per (realm, stream)
  readonly occurredAt: number; // server time; ordering does NOT depend on it
}
// Append-only: no update and no delete exist in this contract.
export interface IngestionAuditStore {
  append(entry: AuditAppend): Promise<{ readonly realm: TrustGateRealm; readonly auditId: string; readonly sequence: number }>;
  listForQuarantine(quarantineId: string, limit: number): Promise<readonly AuditRecord[]>;
  ping(): Promise<boolean>;
}

// Retention: no production TTL is decided. The default never deletes.
export type AuditRetentionPolicy = { readonly mode: 'retain-indefinitely' } | { readonly mode: 'pending-decision' };

// ---------------------------------------------------------------- observability (best-effort)
export type MetricName =
  | 'ingestion_total' | 'ingestion_accepted_total' | 'ingestion_duplicate_total' | 'ingestion_quarantined_total'
  | 'retry_attempt_total' | 'recovery_outcome_total' | 'quarantine_transition_total' | 'replay_total' | 'authorization_denied_total';
// Only low-cardinality labels; values are mapped onto closed vocabularies before emission.
export interface MetricLabels {
  readonly stage?: IngestionStage | 'operations';
  readonly reasonCode?: string;
  readonly retryClass?: RetryClass;
  readonly outcome?: string;
}
export interface IngestionMetricsPort { increment(name: MetricName, labels: MetricLabels): void | Promise<void> }

export type AlertType = 'QUARANTINE_BACKLOG_HIGH' | 'RETRY_EXHAUSTED' | 'PERSISTENCE_INCONSISTENT' | 'AUTHORIZATION_DENIED_SPIKE'
  | 'RECOVERY_INCONSISTENT' | 'REALM_ISOLATION_VIOLATION' | 'AUDIT_RESULT_MISSING';
export type AlertSeverity = 'INFO' | 'WARNING' | 'CRITICAL';
// Facts, not thresholds: thresholding/aggregation is external and not decided.
export interface AlertEvent { readonly type: AlertType; readonly severity: AlertSeverity; readonly reasonCode: string | null }
export interface IngestionAlertPort { emit(event: AlertEvent): void | Promise<void> }

// ---------------------------------------------------------------- operations service
export type OperationDenial =
  | 'invalid-request' | 'unauthenticated' | 'forbidden' | 'realm-out-of-scope' | 'quarantine-not-found' | 'stale-version'
  | 'transition-not-allowed' | 'evidence-required' | 'evidence-type-not-accepted' | 'audit-unavailable' | 'resolve-not-verified'
  // BE13-10B — replay lease governance
  | 'time-authority-unavailable' | 'lease-owned-by-another-operator' | 'lease-active' | 'lease-policy-unavailable' | 'stale-replay-lease' | 'replay-fence-unsupported';
export type OperationResult =
  | { readonly status: 'done'; readonly quarantineId: string; readonly quarantineStatus: QuarantineStatus; readonly version: number; readonly auditComplete: boolean }
  | { readonly status: 'denied'; readonly reason: OperationDenial };

export interface QuarantineView {
  readonly quarantineId: string;
  readonly status: QuarantineStatus;
  readonly version: number;
  readonly stage: IngestionStage;
  readonly reasonCode: string;
  readonly retryClass: RetryClass;
  readonly attemptCount: number;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
}

export interface IngestionOperations {
  view(credential: unknown, quarantineId: string): Promise<{ readonly status: 'done'; readonly view: QuarantineView } | { readonly status: 'denied'; readonly reason: OperationDenial }>;
  replay(credential: unknown, input: { readonly quarantineId: string; readonly expectedVersion: number; readonly protectedDocument: unknown;
    readonly provenanceEvidence: unknown; readonly field: string }): Promise<OperationResult & { readonly replay?: ReplayResult }>;
  unblock(credential: unknown, input: { readonly quarantineId: string; readonly expectedVersion: number; readonly evidence: ResolutionEvidenceInput }): Promise<OperationResult>;
  block(credential: unknown, input: { readonly quarantineId: string; readonly expectedVersion: number; readonly evidence: ResolutionEvidenceInput }): Promise<OperationResult>;
  resolve(credential: unknown, input: { readonly quarantineId: string; readonly expectedVersion: number; readonly evidence: ResolutionEvidenceInput }): Promise<OperationResult>;
  discard(credential: unknown, input: { readonly quarantineId: string; readonly expectedVersion: number; readonly evidence: ResolutionEvidenceInput }): Promise<OperationResult>;
  // BE13-10B: ONLY the lease owner (same authorized operatorId) may release its own ACTIVE lease (QUARANTINE_REPLAY).
  releaseLease(credential: unknown, input: { readonly quarantineId: string; readonly expectedVersion: number; readonly evidence: ResolutionEvidenceInput }): Promise<OperationResult>;
  // BE13-10B: anyone authorized for QUARANTINE_UNBLOCK may recover a lease the injected ReplayLeasePolicy declares EXPIRED
  // under TRUSTED time. Recovery returns the entry to RETRYABLE (CAS); a new replay or a discard are separate operations.
  recoverExpiredLease(credential: unknown, input: { readonly quarantineId: string; readonly expectedVersion: number; readonly evidence: ResolutionEvidenceInput }): Promise<OperationResult>;
}

// ---------------------------------------------------------------- bootstrap & readiness
export interface IngestionOperationsBootstrapDependencies extends ResilientIngestionDependencies {
  readonly authorization: OperatorAuthorizationPort;
  readonly audit: IngestionAuditStore;
  readonly metrics: IngestionMetricsPort;
  readonly alerts: IngestionAlertPort;
  readonly retention: AuditRetentionPolicy;
  // BE13-10B: lease acquisition time and expiry decisions. Placeholders (createBlockingSecurityPolicies) never expire
  // and never provide trusted time, so the default bootstrap can neither acquire nor recover a lease.
  readonly timeAuthority: OperationsTimeAuthority;
  readonly leasePolicy: ReplayLeasePolicy;
}

export interface OperationsReadiness {
  readonly technicalTestReady: boolean;
  readonly operationsTestReady: boolean;
  readonly productionReady: false; // ALWAYS false; nothing in this layer can declare production readiness
  readonly dependencies: Readonly<Record<string, 'MISSING' | 'BLOCKED' | 'INJECTED_UNVERIFIED'>>;
  readonly limitations: readonly string[];
}

export interface OperationalState {
  readonly realm: TrustGateRealm;
  readonly quarantine: readonly { readonly status: QuarantineStatus; readonly reasonCode: string; readonly retryClass: RetryClass; readonly count: number }[];
  readonly totals: Readonly<Record<QuarantineStatus, number>>;
  readonly auditHealthy: boolean;
  readonly quarantineStoreHealthy: boolean;
  readonly productionReady: false;
}

export interface IngestionOperationsBootstrap {
  readonly realm: TrustGateRealm;
  ingest(protectedDocument: unknown, provenanceEvidence: unknown, selection: { readonly field: string }): Promise<ResilientIngestionResult>;
  readonly operations: IngestionOperations;
  operationalState(credential: unknown): Promise<{ readonly status: 'done'; readonly state: OperationalState } | { readonly status: 'denied'; readonly reason: OperationDenial }>;
}
