// BE13-10A — Security policy framework for operations governance.
// Contracts ONLY for decisions that are still pending (identity provider, role
// mapping, separation of duties, lease expiry, audit retention, legal hold,
// evidence verification). Nothing here selects a provider, a duration, a
// retention period or a rule set. Every port is injected; the defaults are
// blocking placeholders. Offline: no endpoints, no workers, no env, no clock reads.
import type { TrustGateRealm } from './trust-gate.contracts.js';
import type { EvidenceType, OperatorCapability, OperatorPrincipal, OperatorAuthorizationPort } from './ingestion-operations.contracts.js';

export type PolicyDependencyStatus = 'MISSING' | 'BLOCKED' | 'INJECTED_UNVERIFIED';

// ---------------------------------------------------------------- identity provider
// Turns an EXTERNAL authenticated identity into an internal identity. The input
// is an opaque credential/reference; the provider never returns roles or
// capabilities (those come from OperatorCapabilityMappingPolicy).
export interface IdentityRequest { readonly credential: unknown; readonly realm: TrustGateRealm }
export interface TrustedIdentityAttribute { readonly name: string; readonly value: string } // asserted BY THE PROVIDER, never by the caller
export interface AuthenticatedOperatorIdentity {
  readonly realm: TrustGateRealm;
  readonly subject: string;                    // stable operator id at the provider
  readonly issuer: string;                     // opaque provider reference (no secrets, no URLs with tokens)
  readonly authenticationReference: string;    // opaque session/assertion reference
  readonly attributes: readonly TrustedIdentityAttribute[];
}
export type IdentityResult =
  | { readonly status: 'authenticated'; readonly identity: AuthenticatedOperatorIdentity }
  | { readonly status: 'denied'; readonly reason: 'unauthenticated' | 'realm-out-of-scope' };
export interface OperatorIdentityProvider { identify(request: IdentityRequest): Promise<IdentityResult> }

// ---------------------------------------------------------------- capability mapping
export interface CapabilityMappingRequest { readonly realm: TrustGateRealm; readonly identity: AuthenticatedOperatorIdentity }
export type CapabilityMappingResult =
  | { readonly status: 'mapped'; readonly realm: TrustGateRealm; readonly capabilities: readonly OperatorCapability[]; readonly policyRevision: number }
  | { readonly status: 'denied'; readonly realm: TrustGateRealm; readonly reason: 'unknown-identity' | 'no-capability' };
export interface OperatorCapabilityMappingPolicy { map(request: CapabilityMappingRequest): Promise<CapabilityMappingResult> }

// ---------------------------------------------------------------- separation of duties
// Static SoD: which capability combinations an operator may HOLD and USE.
// Dynamic SoD (same operator acting twice on one entry) needs audit history and
// is a pending decision; it is NOT modelled here.
export interface SeparationOfDutiesRequest {
  readonly realm: TrustGateRealm;
  readonly operatorId: string;
  readonly capabilities: readonly OperatorCapability[];
  readonly requestedCapability: OperatorCapability;
}
export type SeparationOfDutiesDecision =
  | { readonly realm: TrustGateRealm; readonly decision: 'permit'; readonly policyRevision: number }
  | { readonly realm: TrustGateRealm; readonly decision: 'conflict'; readonly conflictingCapabilities: readonly OperatorCapability[]; readonly policyRevision: number };
export interface SeparationOfDutiesPolicy { evaluate(request: SeparationOfDutiesRequest): Promise<SeparationOfDutiesDecision> }

// ---------------------------------------------------------------- time authority (the domain never reads the wall clock directly)
export type TimeAuthorityResult =
  | { readonly realm: TrustGateRealm; readonly status: 'trusted'; readonly at: number; readonly authorityRevision: number }
  | { readonly realm: TrustGateRealm; readonly status: 'untrusted' };
export interface OperationsTimeAuthority { now(request: { readonly realm: TrustGateRealm }): Promise<TimeAuthorityResult> }

// ---------------------------------------------------------------- replay lease
// Stored lease states. EXPIRED is DERIVED by ReplayLeasePolicy from trusted time;
// it is never stored and never assumed.
export type StoredLeaseState = 'ACTIVE' | 'RELEASED';
export type LeaseStatus = 'ACTIVE' | 'EXPIRED' | 'RELEASED';
export interface ReplayLease {
  readonly realm: TrustGateRealm;
  readonly quarantineId: string;
  readonly leaseId: string;          // identifier, NOT a secret and NOT an authenticator
  readonly ownerOperatorId: string;  // ownership is proven by the authenticated principal, never by the leaseId
  readonly acquiredAt: number;       // from the time authority
  readonly state: StoredLeaseState;
  readonly version: number;          // CAS
}
export interface LeasePolicyRequest { readonly realm: TrustGateRealm; readonly lease: ReplayLease; readonly now: number }
export interface LeasePolicyDecision {
  readonly realm: TrustGateRealm;
  readonly status: 'ACTIVE' | 'EXPIRED';
  readonly recoveryByNonOwner: 'never' | 'when-expired';
  readonly policyRevision: number;
}
export interface ReplayLeasePolicy { evaluate(request: LeasePolicyRequest): Promise<LeasePolicyDecision> }
export type LeaseReleaseReason = 'owner-release' | 'expired-recovery';
export interface ReplayLeaseStore {
  get(quarantineId: string): Promise<ReplayLease | null>;
  acquire(input: { quarantineId: string; ownerOperatorId: string; acquiredAt: number; expectedVersion: number }): Promise<'acquired' | 'held' | 'stale'>;
  release(input: { quarantineId: string; leaseId: string; expectedVersion: number; releasedBy: string; reason: LeaseReleaseReason }): Promise<'released' | 'stale'>;
}

// ---------------------------------------------------------------- audit retention + legal hold
// No TTL, no automatic deletion. The evaluation only says whether a record is
// RETAINED or ELIGIBLE for a human deletion REVIEW. Nothing deletes.
export type AuditRetentionDecision =
  | { readonly mode: 'pending-decision' }
  | { readonly mode: 'retain-indefinitely'; readonly approvalReference: string }
  | { readonly mode: 'retain-until'; readonly until: number; readonly approvalReference: string };
export interface AuditRetentionAuthority {
  policyFor(request: { readonly realm: TrustGateRealm; readonly stream: string }): Promise<{ readonly realm: TrustGateRealm; readonly policy: AuditRetentionDecision; readonly policyRevision: number }>;
}
export interface LegalHoldAuthority {
  holdFor(request: { readonly realm: TrustGateRealm; readonly stream: string }): Promise<{ readonly realm: TrustGateRealm; readonly stream: string; readonly legalHold: boolean; readonly holdReference: string | null }>;
}
export type RetentionOutcome = 'RETAIN' | 'ELIGIBLE_FOR_DELETION_REVIEW';
export type RetentionBasis =
  | 'legal-hold' | 'legal-hold-unknown' | 'pending-decision' | 'retain-indefinitely' | 'retain-until-not-reached'
  | 'retain-until-reached' | 'retention-unavailable' | 'time-untrusted' | 'invalid-request';
export interface RetentionEvaluation { readonly outcome: RetentionOutcome; readonly basis: RetentionBasis; readonly deletes: false }

// ---------------------------------------------------------------- evidence verification
export interface EvidenceVerificationRequest {
  readonly realm: TrustGateRealm;
  readonly quarantineId: string;
  readonly evidence: { readonly evidenceType: EvidenceType; readonly reference: string; readonly verification: 'DECLARED_UNVERIFIED' };
}
export type EvidenceVerificationStatus = 'VERIFIED' | 'UNVERIFIED' | 'REJECTED';
export interface EvidenceVerificationResult {
  readonly realm: TrustGateRealm;
  readonly reference: string;        // must echo the request
  readonly status: EvidenceVerificationStatus;
  readonly verifierRevision: number;
}
export interface ResolutionEvidenceVerifier { verify(request: EvidenceVerificationRequest): Promise<EvidenceVerificationResult> }

// ---------------------------------------------------------------- bundle + readiness
export interface OperationsSecurityPolicyDependencies {
  readonly realm: TrustGateRealm;
  readonly identityProvider: OperatorIdentityProvider;
  readonly capabilityMapping: OperatorCapabilityMappingPolicy;
  readonly separationOfDuties: SeparationOfDutiesPolicy;
  readonly leasePolicy: ReplayLeasePolicy;
  readonly timeAuthority: OperationsTimeAuthority;
  readonly evidenceVerifier: ResolutionEvidenceVerifier;
  readonly retention: AuditRetentionAuthority;
  readonly legalHold: LegalHoldAuthority;
}
export type SecurityPolicyName = 'identityProvider' | 'capabilityMapping' | 'separationOfDuties' | 'leasePolicy' | 'timeAuthority' | 'evidenceVerifier' | 'retention' | 'legalHold';
export interface SecurityPolicyReadiness {
  readonly policyTestReady: boolean;     // every policy injected and not a blocking placeholder (still UNVERIFIED)
  readonly productionReady: false;       // ALWAYS false
  readonly dependencies: Readonly<Record<SecurityPolicyName, PolicyDependencyStatus>>;
  readonly limitations: readonly string[];
}
export type PrincipalResolution =
  | { readonly status: 'resolved'; readonly principal: OperatorPrincipal }
  | { readonly status: 'denied'; readonly reason: 'unauthenticated' | 'realm-out-of-scope' | 'forbidden' | 'separation-of-duties' };
export type LeaseReleaseResult =
  | { readonly status: 'released'; readonly reason: LeaseReleaseReason }
  | { readonly status: 'denied'; readonly reason: 'invalid-request' | 'unauthenticated' | 'forbidden' | 'realm-out-of-scope' | 'separation-of-duties' | 'lease-not-found' | 'lease-not-active' | 'lease-mismatch'
      | 'stale-version' | 'lease-active' | 'time-authority-unavailable' | 'lease-policy-unavailable' };
export type LeaseAcquireResult =
  | { readonly status: 'acquired' }
  | { readonly status: 'denied'; readonly reason: 'invalid-request' | 'unauthenticated' | 'forbidden' | 'realm-out-of-scope' | 'separation-of-duties' | 'lease-active' | 'stale-version' | 'time-authority-unavailable' };
export interface ReplayLeaseGovernor {
  status(quarantineId: string): Promise<{ readonly status: LeaseStatus | 'UNKNOWN'; readonly lease: ReplayLease | null }>;
  // Credentials, not principals: ownership is proven by the authenticated identity, never by an object built in-process.
  acquire(credential: unknown, input: { quarantineId: string; expectedVersion: number }): Promise<LeaseAcquireResult>;
  release(credential: unknown, input: { quarantineId: string; leaseId: string; expectedVersion: number }): Promise<LeaseReleaseResult>;
}
export interface OperationsSecurityPolicyBundle {
  readonly realm: TrustGateRealm;
  resolvePrincipal(credential: unknown, requestedCapability: OperatorCapability): Promise<PrincipalResolution>;
  readonly authorization: OperatorAuthorizationPort;   // drop-in for BE13-09 (identity → mapping → SoD)
  verifyEvidence(request: Omit<EvidenceVerificationRequest, 'realm'>): Promise<{ readonly status: EvidenceVerificationStatus; readonly basis: 'verifier' | 'verifier-unavailable' | 'invalid-request' }>;
  evaluateRetention(input: { stream: string }): Promise<RetentionEvaluation>; // never deletes
  createLeaseGovernor(store: ReplayLeaseStore): ReplayLeaseGovernor;
  readonly readiness: SecurityPolicyReadiness;
}
