import { createConservativeReceivedAtPolicy } from './measurement-temporal-policy.js';
import {
  createBlockingHardwareAuthority,
  createBlockingMeasurementCatalogue,
  createBlockingTemporalAuthority,
} from './trust-gate-blocking.adapters.js';
import {
  createBlockingClockPolicy,
  createBlockingDeclaredAtPolicy,
  createBlockingMissingReasonPolicy,
  createBlockingPersistenceTimePolicy,
} from './trusted-event-blocking.policies.js';
import type { ExternalProvenanceVerifier } from '../iot/ingest-provenance.authority.js';
import type { Be12AuthorityPorts } from '../iot/ingestion-root.contracts.js';

// BE13-07 — production placeholders. Every one BLOCKS. They exist so a future
// bootstrap can be assembled without any permissive default: until a human
// decision replaces a placeholder with an approved implementation, no real
// measurement can pass. Placeholders are registered in a module-private
// WeakSet so readiness diagnostics can report them as BLOCKED. Nothing in this
// module approves anything; test doubles live only in test-support/.
const placeholders = new WeakSet<object>();
const register = <T extends object>(value: T): T => { placeholders.add(value); return Object.freeze(value); };

export function isBlockingPlaceholder(value: unknown): boolean {
  return typeof value === 'object' && value !== null && placeholders.has(value);
}

export function createBlockingProvenanceVerifier(): ExternalProvenanceVerifier {
  // No EMQX/broker provenance verifier exists yet: nothing is ever attested.
  return register({ verify: (_evidence: unknown) => null });
}

export function createBlockingBe12Authorities(): Be12AuthorityPorts {
  return register({
    temporal: createConservativeReceivedAtPolicy(),
    catalogue: Object.freeze({ async accepts() { return false; } }),
  });
}

export function createProductionPlaceholders() {
  return Object.freeze({
    provenanceVerifier: createBlockingProvenanceVerifier(),
    hardware: register(createBlockingHardwareAuthority()),
    temporal: register(createBlockingTemporalAuthority()),
    catalogue: register(createBlockingMeasurementCatalogue()),
    policies: Object.freeze({
      declaredAt: register(createBlockingDeclaredAtPolicy()),
      clock: register(createBlockingClockPolicy()),
      missingReason: register(createBlockingMissingReasonPolicy()),
      persistenceTime: register(createBlockingPersistenceTimePolicy()),
    }),
    be12: createBlockingBe12Authorities(),
  });
}

// BE13-08 — blocking retry placeholders. The production retry policy never
// retries automatically (every retryable failure goes to quarantine as
// RETRYABLE for an explicit replay) and the scheduler never schedules.
export function createBlockingRetryPolicy() {
  return register({ decide: (_input: unknown) => ({ action: 'stop' as const }) });
}
export function createBlockingRetryScheduler() {
  return register({ async wait(_input: unknown): Promise<void> { throw new Error('retry scheduling is not approved'); } });
}

// BE13-09 — operations placeholders. Authorization denies everything (default
// deny, no permissive fallback). Metrics and alerts discard events: no provider
// is approved; readiness reports them as BLOCKED.
export function createDenyAllOperatorAuthorization() {
  return register({ async authorize(_request: unknown) { return Object.freeze({ decision: 'deny' as const, reason: 'unauthenticated' as const }); } });
}
export function createUnconfiguredMetrics() {
  return register({ increment(_name: unknown, _labels: unknown) { /* no provider approved */ } });
}
export function createUnconfiguredAlerts() {
  return register({ emit(_event: unknown) { /* no provider approved */ } });
}

// BE13-10A — security policy placeholders. No identity provider, mapping, SoD
// rule set, lease duration, retention period or evidence verifier is approved:
// every placeholder answers with the MOST conservative outcome (deny, conflict,
// lease never expires, time untrusted, evidence unverified, retention pending,
// legal hold ON). Readiness reports each one as BLOCKED.
type RealmRequest = { readonly realm?: unknown; readonly stream?: unknown; readonly evidence?: { readonly reference?: unknown } } | undefined;
export function createBlockingSecurityPolicies() {
  return Object.freeze({
    identityProvider: register({ async identify(_request: unknown) { return Object.freeze({ status: 'denied' as const, reason: 'unauthenticated' as const }); } }),
    capabilityMapping: register({ async map(request: RealmRequest) { return Object.freeze({ status: 'denied' as const, realm: request?.realm, reason: 'unknown-identity' as const }); } }),
    separationOfDuties: register({ async evaluate(request: RealmRequest & { capabilities?: unknown }) {
      return Object.freeze({ realm: request?.realm, decision: 'conflict' as const, conflictingCapabilities: Object.freeze([]), policyRevision: 0 }); } }),
    leasePolicy: register({ async evaluate(request: RealmRequest) {
      return Object.freeze({ realm: request?.realm, status: 'ACTIVE' as const, recoveryByNonOwner: 'never' as const, policyRevision: 0 }); } }),
    timeAuthority: register({ async now(request: RealmRequest) { return Object.freeze({ realm: request?.realm, status: 'untrusted' as const }); } }),
    evidenceVerifier: register({ async verify(request: RealmRequest) {
      return Object.freeze({ realm: request?.realm, reference: request?.evidence?.reference, status: 'UNVERIFIED' as const, verifierRevision: 0 }); } }),
    retention: register({ async policyFor(request: RealmRequest) {
      return Object.freeze({ realm: request?.realm, policy: Object.freeze({ mode: 'pending-decision' as const }), policyRevision: 0 }); } }),
    legalHold: register({ async holdFor(request: RealmRequest) {
      return Object.freeze({ realm: request?.realm, stream: request?.stream, legalHold: true, holdReference: null }); } }),
  });
}

// BE13-11A — broker boundary placeholders. No broker authentication, identity source, payload limit or topic route is
// approved: the verifier never verifies, the mapping knows no principal, limits/config admit nothing, retained is blocked.
// A boundary assembled with them accepts NO delivery; readiness reports each as BLOCKED.
export function createBlockingMqttBoundaryPlaceholders() {
  return Object.freeze({
    brokerProvenanceVerifier: register({ async verify(request: { realm?: unknown } | undefined) {
      return Object.freeze({ status: 'UNVERIFIED' as const, realm: request?.realm, reason: 'not-authenticated' as const, verifierRevision: 0 }); } }),
    brokerIdentityMapping: register({ async resolve(request: { realm?: unknown } | undefined) { return Object.freeze({ status: 'unknown' as const, realm: request?.realm }); } }),
    payloadLimits: register({ maxBytes: 1, maxDepth: 1, maxKeys: 1, maxStringLength: 1 }),
    boundaryConfig: register({ topicRoutes: Object.freeze([]), retained: 'block' as const, fields: Object.freeze([]), verifierTimeoutMs: 1, auditVerifiedDeliveries: false }),
    // BE13-11B: no durable store approved: it never confirms a write and knows no record.
    // BE13-11C: no reconciliation interval/age/lease is decided: the policy is BLOCKED.
    reconciliationPolicy: register({ mode: 'BLOCKED' as const, reason: 'reconciliation-policy-not-decided' as const }),
    durableInbox: register({ async persistVerifiedDelivery(_request: unknown): Promise<never> { throw new Error('durable broker inbox not configured'); },
      async getById(_request: unknown) { return null; }, async ping() { return false; } }),
  });
}
