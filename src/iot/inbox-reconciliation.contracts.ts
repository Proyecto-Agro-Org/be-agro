import type { TrustGateRealm } from './trust-gate.contracts.js';

// BE13-11C — Durable Inbox reconciliation (OFFLINE, manual). Resolves N4: a write the caller could not confirm may exist in
// Mongo without any receipt ever reaching the process. The raw inbox record stays IMMUTABLE; the operational state lives in a
// separate collection (one document per inboxId) written only through this narrow, CAS-guarded interface.

// ---- state machine -------------------------------------------------------------------------------------------------
// (absent)  --admit: receipt validated-->  receipted  --processing completes-->  completed(admission-processed)
// (absent)  --reconciler claim------------> claimed   --complete(token,version)--> completed(<ReconciliationOutcome>)
// claimed   --claim lease expired (policy)--> claimed (version+1, new token; the old holder is fenced out)
export type InboxStateStatus = 'receipted' | 'claimed' | 'completed';
export type ReconciliationOutcome = 'recovered-and-processed' | 'already-processed' | 'integrity-failed' | 'blocked' | 'admission-processed';
// Closed result vocabulary (no free text). `duplicate` = the inbox was already completed (nothing was done).
export type ReconciliationResultCode = 'recovered-and-processed' | 'already-processed' | 'duplicate' | 'integrity-failed' | 'blocked' | 'stale-reconciliation' | 'unavailable';

// A "candidate orphan" is a durable raw record that has NO state document: no receipt marker, no claim, no completion.
// It becomes claimable only when the injected policy says so (minimum age measured against the DATABASE clock, never the
// process clock). The default productive policy is BLOCKED: no value is chosen here.
export type InboxReconciliationPolicy =
  | { readonly mode: 'BLOCKED'; readonly reason: 'reconciliation-policy-not-decided' }
  | { readonly mode: 'TEST_ONLY' | 'APPROVED'; readonly minAgeMs: number; readonly claimLeaseMs: number; readonly maxBatch: number };

export interface InboxCandidate {
  readonly inboxId: string;
  readonly rawPersistedAt: number;                       // technical instant (server-assigned); no payload, no topic, no client id
}
export interface InboxClaim { readonly inboxId: string; readonly token: string; readonly version: number }
export interface InboxStateCounts { readonly absent: number; readonly receipted: number; readonly claimed: number; readonly completed: number }

// Every call is realm-bound by construction (the store is created for ONE realm) and carries explicit limits.
export interface BrokerInboxReconciliationStore {
  // Receipt marker: insert-only. Existing state (claimed/completed) is never touched.
  markReceipted(request: { readonly realm: TrustGateRealm; readonly inboxId: string }): Promise<void>;
  // receipted -> completed(admission-processed), only if still receipted at version 1 (no token: the caller held the receipt).
  completeFromReceipt(request: { readonly realm: TrustGateRealm; readonly inboxId: string }): Promise<boolean>;
  // Bounded, read-only scan of raw records without a state document, older than minAgeMs (database clock).
  listCandidates(request: { readonly realm: TrustGateRealm; readonly minAgeMs: number; readonly limit: number }): Promise<readonly InboxCandidate[]>;
  // Bounded counts by state (inspect-only).
  count(request: { readonly realm: TrustGateRealm; readonly limit: number }): Promise<InboxStateCounts>;
  // CAS claim: succeeds for an absent state, or takes over a claim whose lease (database clock) has expired. At most ONE winner.
  claim(request: { readonly realm: TrustGateRealm; readonly inboxId: string; readonly claimLeaseMs: number }): Promise<InboxClaim | null>;
  // Fenced completion: only the holder of the current (token, version) can complete. Returns false for a stale holder.
  complete(request: { readonly realm: TrustGateRealm; readonly claim: InboxClaim; readonly outcome: ReconciliationOutcome }): Promise<boolean>;
  getState(request: { readonly realm: TrustGateRealm; readonly inboxId: string }): Promise<{ readonly status: InboxStateStatus; readonly version: number; readonly outcome: string | null } | null>;
}

export interface ReconcileOptions {
  readonly mode: 'inspect-only' | 'reconcile';
  readonly limit: number;                                // explicit scan bound (1..MAX_RECONCILE_LIMIT)
}
export const MAX_RECONCILE_LIMIT = 500;

export interface ReconcileReport {
  readonly status: 'report';
  readonly mode: 'inspect-only' | 'reconcile';
  readonly realm: TrustGateRealm;
  readonly policy: 'BLOCKED' | 'TEST_ONLY' | 'APPROVED';
  readonly scanned: number;
  readonly candidates: readonly string[];
  readonly counts: InboxStateCounts;
  readonly results: readonly { readonly inboxId: string; readonly result: ReconciliationResultCode }[];
}
export interface ReconcileBlocked { readonly status: 'blocked'; readonly reason: 'reconciliation-policy-not-decided' | 'invalid-options' | 'unavailable' }
export interface BrokerInboxReconciler {
  readonly realm: TrustGateRealm;
  // Manual, bounded, offline. No loop, no timer, no polling.
  reconcileBrokerInbox(options: ReconcileOptions): Promise<ReconcileReport | ReconcileBlocked>;
  // One claimed unit of work (used by the sweep; exposed for concurrency tests and operators who already know the id).
  reconcileOne(inboxId: string): Promise<ReconciliationResultCode>;
}
