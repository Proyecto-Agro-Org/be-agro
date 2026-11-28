import type { FailureClassification, IngestionStage, RetryClass } from './ingestion-recovery.contracts.js';

// BE13-08 — deterministic failure classification. Lives in code, not in a
// policy: no injected policy, payload field or caller flag can make a
// security, validation, conflict or policy-blocked failure retryable.
const CLASS_BY_CODE: Readonly<Record<string, RetryClass>> = Object.freeze({
  // transient: temporary unavailability or an authority that changed between reads
  'dependency-error': 'transient', 'idempotency-unavailable': 'transient', 'retry-exhausted': 'transient',
  'stale-association': 'transient', 'stale-resolution': 'transient', 'stale-device': 'transient', 'stale-temporal-policy': 'transient',
  'stale-catalog': 'transient', 'stale-hardware': 'transient', 'persistence-uncertain': 'transient',
  // ambiguous commit: must be recovered before deciding anything
  'persistence-unavailable': 'ambiguous-commit',
  // validation: malformed input, permanent
  'unsupported-document': 'validation', 'invalid-schema': 'validation', 'missing-source': 'validation', 'missing-event-id': 'validation',
  'missing-technical-identity': 'validation', 'unsupported-operation': 'validation', 'invalid-timestamp': 'validation', 'invalid-payload': 'validation',
  'invalid-candidate': 'validation', 'invalid-selection': 'validation', 'absent-field': 'validation', 'invalid-value': 'validation',
  'invalid-ready': 'validation', 'schema-mismatch': 'validation', 'validation': 'validation',
  // security / integrity: permanent, never auto-retried
  'unverified-provenance': 'security', 'conflicting-identity': 'security', 'unverified-hardware': 'security', 'realm-mismatch': 'security',
  'contradictory-authority': 'security', 'invalid-authority-response': 'security', 'invalid-missing-reason': 'security', 'attribution-drift': 'security',
  'unverified-device': 'security', 'ambiguous-device': 'security', 'overlapping-association': 'security', 'overlap': 'security',
  // BE13-11A broker boundary. Provenance failures are SECURITY (never retried); only an unreachable verifier is transient.
  'broker-provenance-unverified': 'security', 'broker-provenance-rejected': 'security', 'broker-principal-unknown': 'security',
  'broker-realm-mismatch': 'security', 'broker-context-mismatch': 'security', 'technical-identity-mismatch': 'security',
  'broker-verifier-unavailable': 'transient',
  'broker-context-malformed': 'validation', 'payload-too-large': 'validation', 'payload-invalid-utf8': 'validation', 'payload-malformed': 'validation',
  'payload-dangerous-key': 'validation', 'payload-limits-exceeded': 'validation', 'topic-not-routed': 'validation', 'no-configured-field': 'validation',
  'retained-message-blocked': 'policy-blocked', 'boundary-not-configured': 'policy-blocked',
  // BE13-11B durable inbox: unavailable store = transient (nothing confirmed, nothing processed); a record whose bytes/context/
  // provenance no longer match is a consistency failure (never repaired, never processed); an unknown id is validation.
  'broker-inbox-unavailable': 'transient', 'broker-inbox-integrity-failed': 'consistency', 'broker-inbox-not-found': 'validation',
  // conflict
  'idempotency-conflict': 'conflict',
  // waiting for a human decision or for missing reference data (BLOCKED_BY_POLICY)
  'unresolved-clock': 'policy-blocked', 'untrusted-clock': 'policy-blocked', 'unresolved-time': 'policy-blocked',
  'unapproved-declared-at': 'policy-blocked', 'missing-declared-at': 'policy-blocked', 'missing-reason-required': 'policy-blocked',
  'unresolved-persisted-at': 'policy-blocked', 'unapproved-magnitude': 'policy-blocked', 'incompatible-unit': 'policy-blocked',
  'invalid-catalogue': 'policy-blocked', 'inactive-device': 'policy-blocked', 'unresolved-device': 'policy-blocked', 'unknown-device': 'policy-blocked',
  'missing-association': 'policy-blocked', 'no-window': 'policy-blocked',
  // persistence inconsistency: never repaired silently
  'persistence-state-inconsistent': 'consistency',
});

const STAGE_BY_REASON: Readonly<Record<string, IngestionStage>> = Object.freeze({
  'mapper-rejected': 'mapper', 'trust-gate-rejected': 'trust-gate', 'builder-rejected': 'builder', 'be12-rejected': 'be12',
  'persistence-unavailable': 'persistence', 'idempotency-conflict': 'persistence', 'idempotency-unavailable': 'persistence',
  'persistence-state-inconsistent': 'recovery', 'retry-exhausted': 'retry', 'persistence-uncertain': 'recovery',
});

const KEBAB = /^[a-z][a-z0-9-]{1,63}$/;

// `reason` is the composition/root reason; `cause` the closed upstream code (gate/builder/BE-12/mapper).
export function classifyIngestionFailure(reason: unknown, cause: unknown): FailureClassification {
  const r = typeof reason === 'string' && KEBAB.test(reason) ? reason : 'internal-error';
  const c = typeof cause === 'string' && KEBAB.test(cause) ? cause : null;
  const wrapper = ['mapper-rejected', 'trust-gate-rejected', 'builder-rejected', 'be12-rejected'].includes(r);
  // For wrapped rejections the decisive code is the upstream cause; otherwise the reason itself.
  const code = wrapper ? (c ?? r) : r;
  const retryClass: RetryClass = Object.hasOwn(CLASS_BY_CODE, code) ? CLASS_BY_CODE[code] : 'unknown';
  const stage: IngestionStage = STAGE_BY_REASON[r] ?? (r === 'attribution-drift' || r === 'realm-mismatch' ? 'composition' : 'composition');
  return Object.freeze({ retryClass, stage, reasonCode: code, retryable: retryClass === 'transient' });
}

export function initialQuarantineStatus(retryClass: RetryClass): 'RETRYABLE' | 'BLOCKED' | 'OPEN' {
  if (retryClass === 'transient' || retryClass === 'ambiguous-commit') return 'RETRYABLE';
  if (retryClass === 'unknown') return 'OPEN';
  return 'BLOCKED';
}

// Quarantine state machine. RESOLVED and DISCARDED are terminal. A security,
// validation, conflict or consistency entry can never become RETRYABLE.
// BE13-09: REPLAYING is a lease taken by an authorized replay (RETRYABLE →
// REPLAYING by CAS); while leased the entry cannot be discarded or resolved
// by anyone else. There is deliberately no BLOCKED → RESOLVED: a blocked entry
// is closed with DISCARDED, or unblocked with evidence and replayed.
const TRANSITIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  OPEN: ['RETRYABLE', 'BLOCKED', 'DISCARDED'],
  RETRYABLE: ['RETRYABLE', 'REPLAYING', 'RESOLVED', 'BLOCKED', 'DISCARDED'],
  REPLAYING: ['RESOLVED', 'RETRYABLE', 'BLOCKED'],
  BLOCKED: ['RETRYABLE', 'DISCARDED'],
  RESOLVED: [],
  DISCARDED: [],
});
export function isTransitionAllowed(from: string, to: string, retryClass: RetryClass): boolean {
  if (!Object.hasOwn(TRANSITIONS, from) || !TRANSITIONS[from].includes(to)) return false;
  // Leaving the replay lease back to RETRYABLE is always allowed (the entry was already RETRYABLE).
  if (to === 'RETRYABLE' && from !== 'RETRYABLE' && from !== 'REPLAYING' && !['transient', 'ambiguous-commit', 'policy-blocked', 'unknown'].includes(retryClass)) return false;
  return true;
}

// BE13-09: closed vocabulary of reason codes (used to bound metric label cardinality).
export function isKnownReasonCode(code: unknown): code is string {
  return typeof code === 'string' && Object.hasOwn(CLASS_BY_CODE, code);
}
