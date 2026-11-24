import { z } from 'zod';
import { catalogueRealmSchema } from '../auth/identity-catalogue.schemas.js';
import { isBlockingPlaceholder } from '../adapters/ingestion-production-placeholders.js';
import { DEFAULT_AUTHORITY_TIMEOUT_MS, runBounded } from './authority-call.js';
import type { AuthorizationDecision, OperatorCapability, OperatorPrincipal } from '../iot/ingestion-operations.contracts.js';
import type { TrustGateRealm } from '../iot/trust-gate.contracts.js';
import type {
  LeaseAcquireResult, LeaseReleaseResult, OperationsSecurityPolicyBundle, OperationsSecurityPolicyDependencies, PolicyDependencyStatus, PrincipalResolution,
  ReplayLease, ReplayLeaseGovernor, ReplayLeaseStore, RetentionEvaluation, SecurityPolicyName, SecurityPolicyReadiness,
} from '../iot/operations-security-policy.contracts.js';

// BE13-10A — policy framework. Every policy is an injected port invoked with a
// bounded timeout and a STRICT schema: a throw, a timeout, a malformed answer or
// an answer for another realm is the conservative outcome (deny / conflict /
// lease active / unverified / retain). No provider, duration, period or rule is
// chosen here. No env, no clock reads, no randomness, no network, no deletion.

const CAPABILITIES = ['QUARANTINE_VIEW', 'QUARANTINE_REPLAY', 'QUARANTINE_UNBLOCK', 'QUARANTINE_BLOCK', 'QUARANTINE_RESOLVE', 'QUARANTINE_DISCARD', 'AUDIT_VIEW', 'OPERATIONS_VIEW'] as const;
const capabilitySchema = z.enum(CAPABILITIES);
// Same charset as the audit actorId: an identity that cannot be audited cannot operate.
const safeRef = z.string().min(1).max(128).regex(/^[A-Za-z0-9:_./-]+$/);
const revision = z.number().int().min(0);
const instant = z.number().int().min(0).max(8.64e15);
const quarantineIdSchema = z.string().regex(/^q_[0-9a-f]{64}$/);
const streamSchema = z.union([z.literal('realm'), quarantineIdSchema]);
const uniqueCapabilities = z.array(capabilitySchema).max(CAPABILITIES.length).refine(a => new Set(a).size === a.length);

const identitySchema = z.object({ realm: catalogueRealmSchema, subject: safeRef, issuer: safeRef, authenticationReference: safeRef,
  attributes: z.array(z.object({ name: z.string().regex(/^[a-z][a-z0-9_.:-]{0,63}$/), value: z.string().min(1).max(256) }).strict()).max(32) }).strict();
const identityResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('authenticated'), identity: identitySchema }).strict(),
  z.object({ status: z.literal('denied'), reason: z.enum(['unauthenticated', 'realm-out-of-scope']) }).strict(),
]);
const mappingResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('mapped'), realm: catalogueRealmSchema, capabilities: uniqueCapabilities, policyRevision: revision }).strict(),
  z.object({ status: z.literal('denied'), realm: catalogueRealmSchema, reason: z.enum(['unknown-identity', 'no-capability']) }).strict(),
]);
const sodDecisionSchema = z.discriminatedUnion('decision', [
  z.object({ realm: catalogueRealmSchema, decision: z.literal('permit'), policyRevision: revision }).strict(),
  z.object({ realm: catalogueRealmSchema, decision: z.literal('conflict'), conflictingCapabilities: z.array(capabilitySchema).max(CAPABILITIES.length), policyRevision: revision }).strict(),
]);
const timeSchema = z.discriminatedUnion('status', [
  z.object({ realm: catalogueRealmSchema, status: z.literal('trusted'), at: instant, authorityRevision: revision }).strict(),
  z.object({ realm: catalogueRealmSchema, status: z.literal('untrusted') }).strict(),
]);
const leaseDecisionSchema = z.object({ realm: catalogueRealmSchema, status: z.enum(['ACTIVE', 'EXPIRED']), recoveryByNonOwner: z.enum(['never', 'when-expired']), policyRevision: revision }).strict();
const leaseSchema = z.object({ realm: catalogueRealmSchema, quarantineId: quarantineIdSchema, leaseId: safeRef, ownerOperatorId: safeRef, acquiredAt: instant,
  state: z.enum(['ACTIVE', 'RELEASED']), version: z.number().int().min(1) }).strict();
const evidenceInputSchema = z.object({ quarantineId: quarantineIdSchema, evidence: z.object({ evidenceType: z.enum(['policy-approval', 'authority-restored', 'dependency-restored', 'data-verified', 'operator-decision']),
  reference: safeRef, verification: z.literal('DECLARED_UNVERIFIED') }).strict() }).strict();
const evidenceResultSchema = z.object({ realm: catalogueRealmSchema, reference: safeRef, status: z.enum(['VERIFIED', 'UNVERIFIED', 'REJECTED']), verifierRevision: revision }).strict();
const retentionResultSchema = z.object({ realm: catalogueRealmSchema, policyRevision: revision, policy: z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('pending-decision') }).strict(),
  z.object({ mode: z.literal('retain-indefinitely'), approvalReference: safeRef }).strict(),
  z.object({ mode: z.literal('retain-until'), until: instant, approvalReference: safeRef }).strict(),
]) }).strict();
const legalHoldSchema = z.object({ realm: catalogueRealmSchema, stream: streamSchema, legalHold: z.boolean(), holdReference: safeRef.nullable() }).strict();

const freeze = <T>(value: T): T => Object.freeze(value);

// Bounded + strict call: any failure is `null` (the caller chooses the conservative outcome).
async function callPolicy<S extends z.ZodType>(schema: S, operation: () => unknown): Promise<z.output<S> | null> {
  try {
    const parsed = schema.safeParse(await runBounded(operation, DEFAULT_AUTHORITY_TIMEOUT_MS));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- readiness
const REQUIREMENTS: ReadonlyArray<readonly [SecurityPolicyName, string]> = [
  ['identityProvider', 'identify'], ['capabilityMapping', 'map'], ['separationOfDuties', 'evaluate'], ['leasePolicy', 'evaluate'],
  ['timeAuthority', 'now'], ['evidenceVerifier', 'verify'], ['retention', 'policyFor'], ['legalHold', 'holdFor'],
];
const LIMITATIONS = freeze(['IDP_SELECTION_PENDING', 'ROLE_MAPPING_PENDING', 'SEPARATION_OF_DUTIES_RULES_PENDING', 'LEASE_EXPIRY_PENDING',
  'TIME_AUTHORITY_PENDING', 'EVIDENCE_VERIFICATION_PENDING', 'AUDIT_RETENTION_PENDING', 'LEGAL_HOLD_PROCESS_PENDING', 'WORM_NOT_PROVIDED',
  'DYNAMIC_SEPARATION_OF_DUTIES_NOT_MODELLED', 'LEASE_OWNERSHIP_NOT_PERSISTED_IN_QUARANTINE_STORE', 'NO_RUNTIME_NO_ENDPOINTS'] as const);

export function describeSecurityPolicyReadiness(input: unknown): SecurityPolicyReadiness {
  const deps = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const dependencies = {} as Record<SecurityPolicyName, PolicyDependencyStatus>;
  for (const [name, method] of REQUIREMENTS) {
    // Hostile getters/proxies count as MISSING: readiness never throws.
    let v: unknown, present = false;
    try { v = deps[name]; present = typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>)[method] === 'function'; } catch { present = false; }
    dependencies[name] = !present ? 'MISSING' : isBlockingPlaceholder(v) ? 'BLOCKED' : 'INJECTED_UNVERIFIED';
  }
  const policyTestReady = Object.values(dependencies).every(s => s === 'INJECTED_UNVERIFIED');
  return freeze({ policyTestReady, productionReady: false as const, dependencies: freeze(dependencies), limitations: LIMITATIONS });
}

// ---------------------------------------------------------------- bundle
export function createOperationsSecurityPolicyBundle(input: OperationsSecurityPolicyDependencies): OperationsSecurityPolicyBundle {
  if (typeof input !== 'object' || input === null) throw new TypeError('Security policy dependencies required');
  const realmParsed = catalogueRealmSchema.safeParse(input.realm);
  if (!realmParsed.success) throw new TypeError('Security policy realm required');
  const realm: TrustGateRealm = realmParsed.data;
  // Explicit and complete: no policy has a default, permissive or otherwise.
  const deps = {} as Record<SecurityPolicyName, Record<string, (...a: unknown[]) => unknown>>;
  for (const [name, method] of REQUIREMENTS) {
    const v = input[name] as unknown;
    if (typeof v !== 'object' || v === null || typeof (v as Record<string, unknown>)[method] !== 'function') throw new TypeError(`Security policy required: ${name}`);
    deps[name] = v as Record<string, (...a: unknown[]) => unknown>;
  }
  const readiness = describeSecurityPolicyReadiness(input);
  const ids = deps.identityProvider, mapping = deps.capabilityMapping, sod = deps.separationOfDuties, leasePolicy = deps.leasePolicy,
    time = deps.timeAuthority, verifier = deps.evidenceVerifier, retention = deps.retention, legalHold = deps.legalHold;

  async function trustedNow(): Promise<number | null> {
    const t = await callPolicy(timeSchema, () => time.now(freeze({ realm })));
    return t && t.realm === realm && t.status === 'trusted' ? t.at : null;
  }

  async function resolvePrincipal(credential: unknown, requestedCapability: OperatorCapability): Promise<PrincipalResolution> {
    const deny = (reason: Extract<PrincipalResolution, { status: 'denied' }>['reason']) => freeze({ status: 'denied' as const, reason });
    if (!capabilitySchema.safeParse(requestedCapability).success) return deny('forbidden');
    // 1. identity: the credential is opaque and goes ONLY to the provider.
    const id = await callPolicy(identityResultSchema, () => ids.identify(freeze({ credential, realm })));
    if (!id) return deny('unauthenticated');
    if (id.status === 'denied') return deny(id.reason);
    if (id.identity.realm !== realm) return deny('realm-out-of-scope');
    const identity = freeze({ ...id.identity, attributes: freeze(id.identity.attributes.map(a => freeze({ ...a }))) });
    // 2. capabilities come from the mapping policy, never from the identity or the caller.
    const mapped = await callPolicy(mappingResultSchema, () => mapping.map(freeze({ realm, identity })));
    if (!mapped || mapped.realm !== realm || mapped.status !== 'mapped' || mapped.capabilities.length === 0) return deny('forbidden');
    if (!mapped.capabilities.includes(requestedCapability)) return deny('forbidden');
    const capabilities = freeze([...mapped.capabilities]);
    // 3. separation of duties: anything but an explicit permit for this realm is a conflict.
    const decision = await callPolicy(sodDecisionSchema, () => sod.evaluate(freeze({ realm, operatorId: identity.subject, capabilities, requestedCapability })));
    if (!decision || decision.realm !== realm || decision.decision !== 'permit') return deny('separation-of-duties');
    const principal: OperatorPrincipal = freeze({ operatorId: identity.subject, realms: freeze([realm]), capabilities, authenticationReference: identity.authenticationReference });
    return freeze({ status: 'resolved' as const, principal });
  }

  const authorization = freeze({
    async authorize(request: { credential: unknown; realm: TrustGateRealm; capability: OperatorCapability }): Promise<AuthorizationDecision> {
      if (request?.realm !== realm) return freeze({ decision: 'deny' as const, reason: 'realm-out-of-scope' as const });
      const r = await resolvePrincipal(request.credential, request.capability);
      if (r.status === 'resolved') return freeze({ decision: 'allow' as const, principal: r.principal });
      return freeze({ decision: 'deny' as const, reason: r.reason === 'separation-of-duties' ? 'forbidden' as const : r.reason });
    },
  });

  async function verifyEvidence(raw: unknown) {
    const parsed = evidenceInputSchema.safeParse(raw);
    // Caller-declared verification (e.g. 'VERIFIED') never passes: the request is rejected.
    if (!parsed.success) return freeze({ status: 'REJECTED' as const, basis: 'invalid-request' as const });
    const request = freeze({ realm, quarantineId: parsed.data.quarantineId, evidence: freeze({ ...parsed.data.evidence }) });
    const r = await callPolicy(evidenceResultSchema, () => verifier.verify(request));
    if (!r || r.realm !== realm || r.reference !== request.evidence.reference) return freeze({ status: 'UNVERIFIED' as const, basis: 'verifier-unavailable' as const });
    return freeze({ status: r.status, basis: 'verifier' as const });
  }

  async function evaluateRetention(raw: unknown): Promise<RetentionEvaluation> {
    const result = (outcome: RetentionEvaluation['outcome'], basis: RetentionEvaluation['basis']) => freeze({ outcome, basis, deletes: false as const });
    const parsed = z.object({ stream: streamSchema }).strict().safeParse(raw);
    if (!parsed.success) return result('RETAIN', 'invalid-request');
    const stream = parsed.data.stream;
    // Legal hold is evaluated FIRST and wins over any retention decision.
    const hold = await callPolicy(legalHoldSchema, () => legalHold.holdFor(freeze({ realm, stream })));
    if (!hold || hold.realm !== realm || hold.stream !== stream) return result('RETAIN', 'legal-hold-unknown');
    if (hold.legalHold) return result('RETAIN', 'legal-hold');
    const policy = await callPolicy(retentionResultSchema, () => retention.policyFor(freeze({ realm, stream })));
    if (!policy || policy.realm !== realm) return result('RETAIN', 'retention-unavailable');
    if (policy.policy.mode === 'pending-decision') return result('RETAIN', 'pending-decision');
    if (policy.policy.mode === 'retain-indefinitely') return result('RETAIN', 'retain-indefinitely');
    const now = await trustedNow();
    if (now === null) return result('RETAIN', 'time-untrusted');
    return now > policy.policy.until ? result('ELIGIBLE_FOR_DELETION_REVIEW', 'retain-until-reached') : result('RETAIN', 'retain-until-not-reached');
  }

  function createLeaseGovernor(store: ReplayLeaseStore): ReplayLeaseGovernor {
    if (typeof store !== 'object' || store === null || !['get', 'acquire', 'release'].every(m => typeof (store as unknown as Record<string, unknown>)[m] === 'function'))
      throw new TypeError('Replay lease store required');
    const loadLease = async (quarantineId: string): Promise<ReplayLease | null | 'error'> => {
      try {
        const raw = await runBounded(() => store.get(quarantineId), DEFAULT_AUTHORITY_TIMEOUT_MS);
        if (raw === null) return null;
        const parsed = leaseSchema.safeParse(raw);
        // A lease of another realm or another entry is treated as absent (never acted upon).
        return parsed.success && parsed.data.realm === realm && parsed.data.quarantineId === quarantineId ? freeze(parsed.data) : null;
      } catch { return 'error'; }
    };
    const leasePolicyFor = (lease: ReplayLease, now: number) =>
      callPolicy(leaseDecisionSchema, () => leasePolicy.evaluate(freeze({ realm, lease, now }))).then(d => (d && d.realm === realm ? d : null));

    async function status(raw: string) {
      const id = quarantineIdSchema.safeParse(raw);
      if (!id.success) return freeze({ status: 'UNKNOWN' as const, lease: null });
      const lease = await loadLease(id.data);
      if (lease === 'error' || lease === null) return freeze({ status: 'UNKNOWN' as const, lease: null });
      if (lease.state === 'RELEASED') return freeze({ status: 'RELEASED' as const, lease });
      // Expiry is never assumed: without trusted time AND an explicit EXPIRED decision the lease is ACTIVE.
      const now = await trustedNow();
      const decision = now === null ? null : await leasePolicyFor(lease, now);
      return freeze({ status: decision?.status === 'EXPIRED' ? 'EXPIRED' as const : 'ACTIVE' as const, lease });
    }

    async function acquire(credential: unknown, raw: unknown): Promise<LeaseAcquireResult> {
      const deny = (reason: Extract<LeaseAcquireResult, { status: 'denied' }>['reason']) => freeze({ status: 'denied' as const, reason });
      const input = z.object({ quarantineId: quarantineIdSchema, expectedVersion: z.number().int().min(0) }).strict().safeParse(raw);
      if (!input.success) return deny('invalid-request');
      const who = await resolvePrincipal(credential, 'QUARANTINE_REPLAY');
      if (who.status === 'denied') return deny(who.reason);
      const now = await trustedNow();
      if (now === null) return deny('time-authority-unavailable');
      let outcome: unknown;
      try { outcome = await runBounded(() => store.acquire({ quarantineId: input.data.quarantineId, ownerOperatorId: who.principal.operatorId, acquiredAt: now,
        expectedVersion: input.data.expectedVersion }), DEFAULT_AUTHORITY_TIMEOUT_MS); } catch { outcome = 'stale'; }
      return outcome === 'acquired' ? freeze({ status: 'acquired' as const }) : deny(outcome === 'held' ? 'lease-active' : 'stale-version');
    }

    async function release(credential: unknown, raw: unknown): Promise<LeaseReleaseResult> {
      const deny = (reason: Extract<LeaseReleaseResult, { status: 'denied' }>['reason']) => freeze({ status: 'denied' as const, reason });
      const input = z.object({ quarantineId: quarantineIdSchema, leaseId: safeRef, expectedVersion: z.number().int().min(1) }).strict().safeParse(raw);
      if (!input.success) return deny('invalid-request');
      const who = await resolvePrincipal(credential, 'QUARANTINE_REPLAY');
      if (who.status === 'denied') return deny(who.reason);
      const lease = await loadLease(input.data.quarantineId);
      if (lease === 'error' || lease === null) return deny('lease-not-found');
      if (lease.state !== 'ACTIVE') return deny('lease-not-active');
      if (lease.leaseId !== input.data.leaseId) return deny('lease-mismatch');
      if (lease.version !== input.data.expectedVersion) return deny('stale-version');
      let reason: 'owner-release' | 'expired-recovery';
      if (lease.ownerOperatorId === who.principal.operatorId) reason = 'owner-release';
      else {
        // Non-owner: only an EXPIRED lease, under trusted time, with a policy that allows recovery. Never a silent takeover.
        const now = await trustedNow();
        if (now === null) return deny('time-authority-unavailable');
        const decision = await leasePolicyFor(lease, now);
        if (!decision) return deny('lease-policy-unavailable');
        if (decision.status !== 'EXPIRED' || decision.recoveryByNonOwner !== 'when-expired') return deny('lease-active');
        reason = 'expired-recovery';
      }
      let outcome: unknown;
      try { outcome = await runBounded(() => store.release({ quarantineId: lease.quarantineId, leaseId: lease.leaseId, expectedVersion: lease.version,
        releasedBy: who.principal.operatorId, reason }), DEFAULT_AUTHORITY_TIMEOUT_MS); } catch { outcome = 'stale'; }
      return outcome === 'released' ? freeze({ status: 'released' as const, reason }) : deny('stale-version');
    }

    return freeze({ status, acquire, release });
  }

  return freeze({ realm, resolvePrincipal, authorization, verifyEvidence, evaluateRetention, createLeaseGovernor, readiness });
}
