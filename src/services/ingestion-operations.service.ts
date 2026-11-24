import { z } from 'zod';
import { catalogueRealmSchema } from '../auth/identity-catalogue.schemas.js';
import { isBlockingPlaceholder } from '../adapters/ingestion-production-placeholders.js';
import { emitAlert, emitMetric } from '../iot/ingestion-observability.js';
import type {
  AuditAppend,
  AuditRetentionPolicy,
  AuthorizationDecision,
  EvidenceType,
  IngestionAlertPort,
  IngestionAuditStore,
  IngestionMetricsPort,
  IngestionOperations,
  IngestionOperationsBootstrap,
  IngestionOperationsBootstrapDependencies,
  OperationDenial,
  OperationResult,
  OperationalState,
  OperationsReadiness,
  OperatorAuthorizationPort,
  OperatorCapability,
  OperatorPrincipal,
  ResolutionEvidenceInput,
} from '../iot/ingestion-operations.contracts.js';
import type {
  IngestionQuarantineStore,
  IngestionRetryPolicy,
  LeaseAcquireResult,
  PersistenceRecoveryPort,
  QuarantineStatus,
  ResilientMeasurementIngestion,
} from '../iot/ingestion-recovery.contracts.js';
import type { OperationsTimeAuthority, ReplayLeasePolicy } from '../iot/operations-security-policy.contracts.js';
import type { TrustGateRealm } from '../iot/trust-gate.contracts.js';
import { runBounded } from './authority-call.js';
import { createResilientMeasurementIngestionRoot, describeIngestionRootReadiness } from './measurement-ingestion-root.js';
import { evaluateReplayLeaseExpiry, readTrustedTime } from './replay-lease-governance.js';

// BE13-09 — operations governance (offline). Trust model: authorization, audit,
// metrics and alerts are authorities INJECTED by the bootstrap. Whoever can
// compose a bootstrap can inject permissive ones; nothing here sandboxes
// in-process code. Administrative actions are FAIL-CLOSED on audit: no replay,
// unblock, block, resolve, discard or lease release happens without a durable
// audit record of the request. Metrics and alerts are best-effort.

const CAPABILITIES = ['QUARANTINE_VIEW', 'QUARANTINE_REPLAY', 'QUARANTINE_UNBLOCK', 'QUARANTINE_BLOCK', 'QUARANTINE_RESOLVE', 'QUARANTINE_DISCARD',
  'AUDIT_VIEW', 'OPERATIONS_VIEW'] as const;
const principalSchema = z.object({ operatorId: z.string().min(1).max(128).regex(/^[A-Za-z0-9:_./-]+$/), realms: z.array(catalogueRealmSchema).min(1).max(4),
  capabilities: z.array(z.enum(CAPABILITIES)).max(8), authenticationReference: z.string().min(1).max(128).regex(/^[A-Za-z0-9:_./-]+$/) }).strict();
const decisionSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('allow'), principal: principalSchema }).strict(),
  z.object({ decision: z.literal('deny'), reason: z.enum(['unauthenticated', 'forbidden', 'realm-out-of-scope']) }).strict(),
]);
const quarantineIdSchema = z.string().regex(/^q_[0-9a-f]{64}$/);
const versionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const evidenceSchema = z.object({ evidenceType: z.enum(['policy-approval', 'authority-restored', 'dependency-restored', 'data-verified', 'operator-decision']),
  reference: z.string().min(1).max(96).regex(/^[A-Za-z0-9:_./-]+$/),
  metadata: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/), z.union([z.string().max(128).regex(/^[A-Za-z0-9 :_./-]*$/), z.number().finite(), z.boolean()]))
    .refine(m => Object.keys(m).length <= 10).optional() }).strict();
const AUTHORITY_TIMEOUT_MS = 5_000;

const freeze = <T>(value: T): T => Object.freeze(value);
const SYSTEM: { operatorId: string; capabilities: readonly OperatorCapability[] } = Object.freeze({ operatorId: 'system', capabilities: Object.freeze([]) });

// ---------------------------------------------------------------- decorators for automatic ingestion
// Auditing of automatic ingestion is best-effort (it never changes measurement semantics);
// administrative actions below are fail-closed.
function auditBestEffort(audit: IngestionAuditStore, entry: AuditAppend) {
  return runBounded(() => audit.append(entry), AUTHORITY_TIMEOUT_MS).then(() => true, () => false);
}

function decorateQuarantine(realm: TrustGateRealm, inner: IngestionQuarantineStore, audit: IngestionAuditStore, metrics: IngestionMetricsPort, alerts: IngestionAlertPort): IngestionQuarantineStore {
  return freeze<IngestionQuarantineStore>({
    async record(entry) {
      const out = await inner.record(entry);
      const created = out.attemptCount === 1;
      await auditBestEffort(audit, { realm, quarantineId: out.quarantineId, eventId: entry.eventId, action: created ? 'quarantine-created' : 'quarantine-recurred',
        actorId: SYSTEM.operatorId, actorCapabilities: SYSTEM.capabilities, outcome: out.status.toLowerCase(), reasonCode: entry.reasonCode, evidence: null });
      await emitMetric(metrics, 'ingestion_quarantined_total', { stage: entry.stage, reasonCode: entry.reasonCode, retryClass: entry.retryClass });
      if (entry.cause === 'retry-exhausted') await emitAlert(alerts, { type: 'RETRY_EXHAUSTED', severity: 'WARNING', reasonCode: entry.reasonCode });
      if (entry.reasonCode === 'persistence-state-inconsistent') await emitAlert(alerts, { type: 'PERSISTENCE_INCONSISTENT', severity: 'CRITICAL', reasonCode: entry.reasonCode });
      if (entry.reasonCode === 'realm-mismatch') await emitAlert(alerts, { type: 'REALM_ISOLATION_VIOLATION', severity: 'CRITICAL', reasonCode: entry.reasonCode });
      return out;
    },
    get: id => inner.get(id),
    transition: input => inner.transition(input),
    acquireLease: input => inner.acquireLease(input),
    settleReplay: (input, transaction) => inner.settleReplay(input, transaction),
    appendAudit: (id, entry) => inner.appendAudit(id, entry),
    ...(typeof inner.summarize === 'function' ? { summarize: () => inner.summarize!() } : {}),
  });
}

function decorateRecovery(realm: TrustGateRealm, inner: PersistenceRecoveryPort, audit: IngestionAuditStore, metrics: IngestionMetricsPort, alerts: IngestionAlertPort): PersistenceRecoveryPort {
  return freeze<PersistenceRecoveryPort>({
    async inspect(key) {
      const report = await inner.inspect(key);
      const state = typeof report === 'object' && report !== null ? (report as { state?: unknown }).state : undefined;
      const outcome = state === 'committed' || state === 'not-committed' || state === 'inconsistent' ? state : 'invalid';
      await auditBestEffort(audit, { realm, quarantineId: null, eventId: key.eventId, action: 'recovery-outcome', actorId: SYSTEM.operatorId,
        actorCapabilities: SYSTEM.capabilities, outcome, reasonCode: null, evidence: null });
      await emitMetric(metrics, 'recovery_outcome_total', { stage: 'recovery', outcome });
      if (outcome === 'inconsistent') await emitAlert(alerts, { type: 'RECOVERY_INCONSISTENT', severity: 'CRITICAL', reasonCode: 'persistence-state-inconsistent' });
      return report;
    },
  });
}

function decorateRetryPolicy(inner: IngestionRetryPolicy, metrics: IngestionMetricsPort): IngestionRetryPolicy {
  return freeze<IngestionRetryPolicy>({
    decide(input) {
      const decision = inner.decide(input);
      const outcome = (decision as { action?: unknown } | undefined)?.action === 'retry' ? 'retry' : 'stop';
      void emitMetric(metrics, 'retry_attempt_total', { stage: 'retry', reasonCode: input.reasonCode, retryClass: input.retryClass, outcome });
      return decision;
    },
  });
}

// ---------------------------------------------------------------- operations service
// BE13-10B: lease release/recovery are NOT generic transitions any more (see leaseOp): REPLAYING is only left by lease CAS.
type Op = 'unblock' | 'block' | 'resolve' | 'discard';
const OP_RULES: Readonly<Record<Op, { capability: OperatorCapability; to: QuarantineStatus; from: readonly QuarantineStatus[]; evidence: (retryClass: string) => readonly EvidenceType[] }>> = freeze<Readonly<Record<Op, { capability: OperatorCapability; to: QuarantineStatus; from: readonly QuarantineStatus[]; evidence: (retryClass: string) => readonly EvidenceType[] }>>>({
  'unblock': { capability: 'QUARANTINE_UNBLOCK', to: 'RETRYABLE', from: ['BLOCKED', 'OPEN'],
    // Human-decision blocks need a structured policy approval; still DECLARED_UNVERIFIED.
    evidence: c => (c === 'policy-blocked' ? ['policy-approval'] : ['dependency-restored', 'authority-restored']) },
  'block': { capability: 'QUARANTINE_BLOCK', to: 'BLOCKED', from: ['OPEN', 'RETRYABLE'], evidence: () => ['operator-decision'] },
  'resolve': { capability: 'QUARANTINE_RESOLVE', to: 'RESOLVED', from: ['RETRYABLE'], evidence: () => ['data-verified'] },
  // REPLAYING is deliberately absent: an entry under an active lease can never be discarded (S7). After an authorized
  // expired-lease recovery it is RETRYABLE again, and discard is a separate, audited operation.
  'discard': { capability: 'QUARANTINE_DISCARD', to: 'DISCARDED', from: ['OPEN', 'RETRYABLE', 'BLOCKED'], evidence: () => ['operator-decision'] },
});
const LEASE_EVIDENCE: readonly EvidenceType[] = ['operator-decision'];

function createOperations(realm: TrustGateRealm, deps: { quarantine: IngestionQuarantineStore; audit: IngestionAuditStore; authorization: OperatorAuthorizationPort;
  recovery: PersistenceRecoveryPort; replayer: ResilientMeasurementIngestion; metrics: IngestionMetricsPort; alerts: IngestionAlertPort;
  timeAuthority: OperationsTimeAuthority; leasePolicy: ReplayLeasePolicy }): IngestionOperations {
  const { quarantine, audit, authorization, recovery, replayer, metrics, alerts, timeAuthority, leasePolicy } = deps;
  const appendReceiptSchema = z.object({ realm: z.literal(realm), auditId: z.string().regex(/^a_[0-9a-f]{64}$/), sequence: z.number().int().min(1) }).strict();
  const denied = (reason: OperationDenial) => Object.freeze({ status: 'denied' as const, reason });

  async function authorize(credential: unknown, capability: OperatorCapability, quarantineId: string | null): Promise<OperatorPrincipal | OperationDenial> {
    let decision: AuthorizationDecision | null = null;
    try {
      const raw = await runBounded(() => authorization.authorize(Object.freeze({ credential, realm, capability, quarantineId })), AUTHORITY_TIMEOUT_MS);
      const parsed = decisionSchema.safeParse(raw); decision = parsed.success ? parsed.data : null;
    } catch { decision = null; }
    let reason: OperationDenial | null = null;
    if (!decision) reason = 'forbidden';
    else if (decision.decision === 'deny') reason = decision.reason;
    else if (!decision.principal.realms.includes(realm)) reason = 'realm-out-of-scope';
    else if (!decision.principal.capabilities.includes(capability)) reason = 'forbidden'; // an "allow" without the capability is contradictory
    if (reason === null && decision?.decision === 'allow') return decision.principal;
    const finalReason = reason ?? 'forbidden';
    await auditBestEffort(audit, { realm, quarantineId, eventId: null, action: 'authorization-denied', actorId: 'unauthenticated', actorCapabilities: [],
      outcome: finalReason, reasonCode: null, evidence: null });
    await emitMetric(metrics, 'authorization_denied_total', { stage: 'operations', outcome: finalReason });
    return finalReason;
  }

  // Required (fail-closed) audit for administrative actions.
  // The store's answer is validated: only a well-formed receipt for THIS realm counts as durable.
  async function auditRequired(entry: AuditAppend): Promise<boolean> {
    try { return appendReceiptSchema.safeParse(await runBounded(() => audit.append(entry), AUTHORITY_TIMEOUT_MS)).success; } catch { return false; }
  }

  async function load(quarantineIdRaw: unknown) {
    try { const r = await quarantine.get(quarantineIdRaw as string); return r && r.realm === realm ? r : null; } catch { return null; }
  }

  async function view(credential: unknown, quarantineIdRaw: string) {
    const id = quarantineIdSchema.safeParse(quarantineIdRaw);
    if (!id.success) return denied('invalid-request');
    const principal = await authorize(credential, 'QUARANTINE_VIEW', id.data);
    if (typeof principal === 'string') return denied(principal);
    const record = await load(id.data);
    if (!record) return denied('quarantine-not-found');
    return Object.freeze({ status: 'done' as const, view: Object.freeze({ quarantineId: record.quarantineId, status: record.status, version: record.version, stage: record.stage,
      reasonCode: record.reasonCode, retryClass: record.retryClass, attemptCount: record.attemptCount, firstSeenAt: record.firstSeenAt, lastSeenAt: record.lastSeenAt }) });
  }

  async function transitionOp(op: Op, credential: unknown, input: { quarantineId: string; expectedVersion: number; evidence: ResolutionEvidenceInput }): Promise<OperationResult> {
    const rules = OP_RULES[op];
    const id = quarantineIdSchema.safeParse(input?.quarantineId), version = versionSchema.safeParse(input?.expectedVersion);
    if (!id.success || !version.success) return denied('invalid-request');
    const ev = evidenceSchema.safeParse(input?.evidence);
    const principal = await authorize(credential, rules.capability, id.data);
    if (typeof principal === 'string') return denied(principal);
    if (!ev.success) return denied('evidence-required');
    const record = await load(id.data);
    if (!record) return denied('quarantine-not-found');
    if (record.version !== version.data) return denied('stale-version');
    if (!rules.from.includes(record.status)) return denied('transition-not-allowed');
    if (!rules.evidence(record.retryClass).includes(ev.data.evidenceType)) return denied('evidence-type-not-accepted');
    const evidence = Object.freeze({ evidenceType: ev.data.evidenceType, reference: ev.data.reference, verification: 'DECLARED_UNVERIFIED' as const });
    const actor = { actorId: principal.operatorId, actorCapabilities: principal.capabilities };
    if (!(await auditRequired({ realm, quarantineId: record.quarantineId, eventId: record.eventId, action: 'transition-requested', ...actor, outcome: op, reasonCode: record.reasonCode, evidence })))
      return denied('audit-unavailable');
    if (op === 'resolve') {
      // RESOLVED is factual: only if recovery proves the measurement is committed with this exact fingerprint.
      let verified = false;
      if (record.sourceId && record.operation && record.eventId && record.field && record.fingerprint) {
        try {
          const report = await recovery.inspect(Object.freeze({ realm, sourceId: record.sourceId, operation: record.operation, eventId: record.eventId, field: record.field }));
          verified = report.state === 'committed' && report.realm === realm && report.fingerprint === record.fingerprint;
        } catch { verified = false; }
      }
      if (!verified) { await auditBestEffort(audit, { realm, quarantineId: record.quarantineId, eventId: record.eventId, action: 'transition-result', ...actor, outcome: 'resolve-not-verified', reasonCode: record.reasonCode, evidence });
        return denied('resolve-not-verified'); }
    }
    const result = await quarantine.transition({ quarantineId: record.quarantineId, from: record.status, to: rules.to, expectedVersion: record.version,
      evidence: `${evidence.evidenceType}:${evidence.reference}`.slice(0, 256), outcome: op });
    const outcome = result === 'transitioned' ? 'done' : result === 'stale' ? 'stale-version' : result === 'not-allowed' ? 'transition-not-allowed' : 'quarantine-not-found';
    const action = result === 'transitioned' && op === 'resolve' ? 'resolved' : result === 'transitioned' && op === 'discard' ? 'discarded' : 'transition-result';
    const auditComplete = await auditBestEffort(audit, { realm, quarantineId: record.quarantineId, eventId: record.eventId, action, ...actor, outcome, reasonCode: record.reasonCode, evidence });
    if (!auditComplete) await emitAlert(alerts, { type: 'AUDIT_RESULT_MISSING', severity: 'CRITICAL', reasonCode: null });
    await emitMetric(metrics, 'quarantine_transition_total', { stage: 'operations', outcome: result === 'transitioned' ? rules.to : outcome });
    if (result !== 'transitioned') return denied(outcome as OperationDenial);
    const after = await load(record.quarantineId);
    return Object.freeze({ status: 'done', quarantineId: record.quarantineId, quarantineStatus: after?.status ?? rules.to, version: after?.version ?? record.version + 1, auditComplete });
  }

  async function replay(credential: unknown, input: { quarantineId: string; expectedVersion: number; protectedDocument: unknown; provenanceEvidence: unknown; field: string }) {
    const id = quarantineIdSchema.safeParse(input?.quarantineId), version = versionSchema.safeParse(input?.expectedVersion);
    if (!id.success || !version.success) return denied('invalid-request');
    const principal = await authorize(credential, 'QUARANTINE_REPLAY', id.data);
    if (typeof principal === 'string') return denied(principal);
    const actor = { actorId: principal.operatorId, actorCapabilities: principal.capabilities };
    const record = await load(id.data);
    if (!record) return denied('quarantine-not-found');
    const deny = async (reason: OperationDenial) => {
      await auditBestEffort(audit, { realm, quarantineId: record.quarantineId, eventId: record.eventId, action: 'replay-denied', ...actor, outcome: reason, reasonCode: record.reasonCode, evidence: null });
      await emitMetric(metrics, 'replay_total', { stage: 'operations', outcome: reason });
      return denied(reason);
    };
    if (record.status !== 'RETRYABLE') return deny('transition-not-allowed');
    if (record.version !== version.data) return deny('stale-version');
    if (!(await auditRequired({ realm, quarantineId: record.quarantineId, eventId: record.eventId, action: 'replay-requested', ...actor, outcome: 'requested', reasonCode: record.reasonCode, evidence: null })))
      return denied('audit-unavailable');
    // BE13-10B lease: owner = the AUTHORIZED principal's operatorId; acquiredAt = TRUSTED time (never the caller, never a
    // wall-clock read). Without trusted time no lease is taken (fail-closed). ONE CAS: RETRYABLE(v) → REPLAYING + lease.
    const acquiredAt = await readTrustedTime(timeAuthority, realm);
    if (acquiredAt === null) return deny('time-authority-unavailable');
    let acquired: LeaseAcquireResult;
    try { acquired = await quarantine.acquireLease({ quarantineId: record.quarantineId, expectedVersion: record.version, ownerId: principal.operatorId, acquiredAt }); }
    catch { acquired = Object.freeze({ result: 'stale' as const }); }
    if (acquired.result !== 'acquired')
      return deny(acquired.result === 'stale' ? 'stale-version' : acquired.result === 'not-found' ? 'quarantine-not-found' : 'transition-not-allowed');
    const lease = Object.freeze({ ownerId: principal.operatorId, leaseToken: acquired.leaseToken });
    const holder = Object.freeze({ kind: 'lease' as const, ...lease });
    await auditBestEffort(audit, { realm, quarantineId: record.quarantineId, eventId: record.eventId, action: 'lease-acquired', ...actor, outcome: 'acquired', reasonCode: record.reasonCode, evidence: null });
    if (!(await auditRequired({ realm, quarantineId: record.quarantineId, eventId: record.eventId, action: 'replay-started', ...actor, outcome: 'started', reasonCode: record.reasonCode, evidence: null }))) {
      await quarantine.settleReplay({ quarantineId: record.quarantineId, holder, to: 'RETRYABLE', evidence: 'audit-unavailable', outcome: 'replay-aborted' }).catch(() => 'stale');
      return denied('audit-unavailable');
    }
    const result = await replayer.replay({ quarantineId: record.quarantineId, protectedDocument: input.protectedDocument, provenanceEvidence: input.provenanceEvidence,
      field: input.field, lease });
    if (result.status === 'replay-rejected' && result.reasonCode === 'replay-fence-unsupported') {
      // Nothing was attempted: give the lease back (owner CAS) and refuse.
      await quarantine.settleReplay({ quarantineId: record.quarantineId, holder, to: 'RETRYABLE', evidence: 'replay-fence-unsupported', outcome: 'replay-aborted' }).catch(() => 'stale');
      return deny('replay-fence-unsupported');
    }
    if (result.status === 'replay-rejected' && result.reasonCode === 'stale-replay-lease') {
      // S7: the lease was lost before the final write; the fence prevented the measurement. Nothing to settle: not ours any more.
      await auditBestEffort(audit, { realm, quarantineId: record.quarantineId, eventId: record.eventId, action: 'stale-replay-blocked', ...actor, outcome: 'stale-replay-lease', reasonCode: record.reasonCode, evidence: null });
      await emitMetric(metrics, 'replay_total', { stage: 'operations', outcome: 'stale-replay-lease' });
      return denied('stale-replay-lease');
    }
    const outcome = result.status === 'replayed' ? result.outcome.status : result.reasonCode;
    const auditComplete = await auditBestEffort(audit, { realm, quarantineId: record.quarantineId, eventId: record.eventId, action: 'replay-result', ...actor,
      outcome: outcome.replace(/[^a-z0-9-]/g, '-'), reasonCode: record.reasonCode, evidence: null });
    if (!auditComplete) await emitAlert(alerts, { type: 'AUDIT_RESULT_MISSING', severity: 'CRITICAL', reasonCode: null });
    await emitMetric(metrics, 'replay_total', { stage: 'operations', outcome: result.status === 'replayed' ? result.outcome.status : 'replay-rejected' });
    const after = await load(record.quarantineId);
    return Object.freeze({ status: 'done' as const, quarantineId: record.quarantineId, quarantineStatus: after?.status ?? record.status, version: after?.version ?? record.version,
      auditComplete, replay: result });
  }

  // BE13-10B — lease release (owner) and expired-lease recovery (non-owner). Both end the lease with ONE CAS on
  // (realm, id, REPLAYING, exact owner, exact token, exact version) back to RETRYABLE, after a REQUIRED audit.
  async function leaseOp(kind: 'owner-release' | 'expired-recovery', credential: unknown,
    input: { quarantineId: string; expectedVersion: number; evidence: ResolutionEvidenceInput }): Promise<OperationResult> {
    const id = quarantineIdSchema.safeParse(input?.quarantineId), version = versionSchema.safeParse(input?.expectedVersion);
    if (!id.success || !version.success) return denied('invalid-request');
    const ev = evidenceSchema.safeParse(input?.evidence);
    // Owner release is part of the replay lifecycle (QUARANTINE_REPLAY). Recovering SOMEONE ELSE's lease returns a stuck
    // entry to RETRYABLE: semantically an unblock (QUARANTINE_UNBLOCK), so SoD/mapping can separate it from replaying.
    const principal = await authorize(credential, kind === 'owner-release' ? 'QUARANTINE_REPLAY' : 'QUARANTINE_UNBLOCK', id.data);
    if (typeof principal === 'string') return denied(principal);
    if (!ev.success) return denied('evidence-required');
    const record = await load(id.data);
    if (!record) return denied('quarantine-not-found');
    const actor = { actorId: principal.operatorId, actorCapabilities: principal.capabilities };
    const evidence = Object.freeze({ evidenceType: ev.data.evidenceType, reference: ev.data.reference, verification: 'DECLARED_UNVERIFIED' as const });
    const refuse = async (reason: OperationDenial) => {
      await auditBestEffort(audit, { realm, quarantineId: record.quarantineId, eventId: record.eventId, action: 'lease-release-denied', ...actor, outcome: reason,
        reasonCode: record.reasonCode, evidence });
      await emitMetric(metrics, 'quarantine_transition_total', { stage: 'operations', outcome: reason });
      return denied(reason);
    };
    const lease = record.lease;
    if (record.status !== 'REPLAYING' || !lease) return refuse('transition-not-allowed');
    if (record.version !== version.data) return refuse('stale-version');
    if (!LEASE_EVIDENCE.includes(ev.data.evidenceType)) return refuse('evidence-type-not-accepted');
    if (kind === 'owner-release') {
      // Stable authorized identity, never an object reference or a request field.
      if (lease.ownerId !== principal.operatorId) return refuse('lease-owned-by-another-operator');
    } else {
      const expiry = await evaluateReplayLeaseExpiry({ realm, timeAuthority, leasePolicy, quarantineId: record.quarantineId, lease });
      if (expiry.status !== 'EXPIRED')
        return refuse(expiry.basis === 'time-untrusted' ? 'time-authority-unavailable' : expiry.basis === 'policy-unavailable' ? 'lease-policy-unavailable' : 'lease-active');
    }
    if (!(await auditRequired({ realm, quarantineId: record.quarantineId, eventId: record.eventId, action: kind === 'owner-release' ? 'lease-release-requested' : 'lease-recovery-requested',
      ...actor, outcome: kind, reasonCode: record.reasonCode, evidence }))) return denied('audit-unavailable');
    const ended = kind === 'owner-release' ? 'lease-released-owner' : 'lease-recovered-expired';
    let result: string;
    try {
      result = await quarantine.settleReplay({ quarantineId: record.quarantineId, holder: { kind: 'lease', ownerId: lease.ownerId, leaseToken: lease.token }, to: 'RETRYABLE',
        expectedVersion: record.version, outcome: ended, evidence: `${evidence.evidenceType}:${evidence.reference}`.slice(0, 256) });
    } catch { result = 'stale'; }
    if (result !== 'transitioned') return refuse('stale-version'); // a concurrent recovery/completion won the CAS
    const auditComplete = await auditBestEffort(audit, { realm, quarantineId: record.quarantineId, eventId: record.eventId, action: ended, ...actor, outcome: 'done',
      reasonCode: record.reasonCode, evidence });
    if (!auditComplete) await emitAlert(alerts, { type: 'AUDIT_RESULT_MISSING', severity: 'CRITICAL', reasonCode: null });
    await emitMetric(metrics, 'quarantine_transition_total', { stage: 'operations', outcome: 'RETRYABLE' });
    const after = await load(record.quarantineId);
    return Object.freeze({ status: 'done', quarantineId: record.quarantineId, quarantineStatus: after?.status ?? 'RETRYABLE', version: after?.version ?? record.version + 1, auditComplete });
  }

  return freeze<IngestionOperations>({
    view, replay,
    unblock: (c, i) => transitionOp('unblock', c, i),
    block: (c, i) => transitionOp('block', c, i),
    resolve: (c, i) => transitionOp('resolve', c, i),
    discard: (c, i) => transitionOp('discard', c, i),
    releaseLease: (c, i) => leaseOp('owner-release', c, i),
    recoverExpiredLease: (c, i) => leaseOp('expired-recovery', c, i),
  });
}

// ---------------------------------------------------------------- readiness & snapshot
const OPS_REQUIREMENTS: ReadonlyArray<readonly [string, (d: IngestionOperationsBootstrapDependencies) => unknown, readonly string[]]> = [
  ['authorization', d => d.authorization, ['authorize']],
  ['audit', d => d.audit, ['append', 'listForQuarantine', 'ping']],
  ['metrics', d => d.metrics, ['increment']],
  ['alerts', d => d.alerts, ['emit']],
  // BE13-10B lease governance
  ['timeAuthority', d => d.timeAuthority, ['now']],
  ['leasePolicy', d => d.leasePolicy, ['evaluate']],
];
const hasMethods = (v: unknown, methods: readonly string[]) => typeof v === 'object' && v !== null && methods.every(m => typeof (v as Record<string, unknown>)[m] === 'function');
const validRetention = (r: unknown): r is AuditRetentionPolicy => typeof r === 'object' && r !== null && ['retain-indefinitely', 'pending-decision'].includes((r as { mode?: unknown }).mode as string);

export function describeOperationsReadiness(input: unknown): OperationsReadiness {
  const deps = (typeof input === 'object' && input !== null ? input : {}) as IngestionOperationsBootstrapDependencies;
  const technical = describeIngestionRootReadiness(deps);
  const dependencies: Record<string, 'MISSING' | 'BLOCKED' | 'INJECTED_UNVERIFIED'> = { ...technical.dependencies };
  for (const [name, pick, methods] of OPS_REQUIREMENTS) {
    let v: unknown; try { v = pick(deps); } catch { v = undefined; }
    dependencies[name] = !hasMethods(v, methods) ? 'MISSING' : isBlockingPlaceholder(v) ? 'BLOCKED' : 'INJECTED_UNVERIFIED';
  }
  let retention: unknown; try { retention = deps.retention; } catch { retention = undefined; }
  dependencies.retention = !validRetention(retention) ? 'MISSING' : retention.mode === 'pending-decision' ? 'BLOCKED' : 'INJECTED_UNVERIFIED';
  const technicalTestReady = technical.overall === 'READY_FOR_TEST';
  const operationsTestReady = technicalTestReady && ['authorization', 'audit', 'metrics', 'alerts', 'retention', 'timeAuthority', 'leasePolicy']
    .every(n => dependencies[n] === 'INJECTED_UNVERIFIED');
  return Object.freeze({ technicalTestReady, operationsTestReady, productionReady: false as const, dependencies: Object.freeze(dependencies),
    limitations: Object.freeze(['DEVICE_STATUS_HISTORY_REQUIRED', 'AUDIT_RETENTION_PRODUCTION_PENDING', 'EVIDENCE_DECLARED_UNVERIFIED', 'OPERATOR_AUTHENTICATION_EXTERNAL',
      'NO_RUNTIME_NO_ENDPOINTS', 'LEASE_DURATION_PENDING', 'TIME_AUTHORITY_PENDING']) });
}

const STATUSES: readonly QuarantineStatus[] = ['OPEN', 'RETRYABLE', 'REPLAYING', 'BLOCKED', 'RESOLVED', 'DISCARDED'];
// Pure formatter: counts only, no identifiers, no PII.
export function describeIngestionOperationalState(input: { realm: TrustGateRealm; quarantine: OperationalState['quarantine']; auditHealthy: boolean; quarantineStoreHealthy: boolean }): OperationalState {
  const totals = Object.fromEntries(STATUSES.map(s => [s, 0])) as Record<QuarantineStatus, number>;
  for (const row of input.quarantine) if (STATUSES.includes(row.status)) totals[row.status] += row.count;
  return Object.freeze({ realm: input.realm, quarantine: Object.freeze(input.quarantine.map(r => Object.freeze({ status: r.status, reasonCode: r.reasonCode, retryClass: r.retryClass, count: r.count }))),
    totals: Object.freeze(totals), auditHealthy: input.auditHealthy, quarantineStoreHealthy: input.quarantineStoreHealthy, productionReady: false as const });
}

// ---------------------------------------------------------------- bootstrap (offline factory; never mounted)
export function createIngestionOperationsBootstrap(deps: IngestionOperationsBootstrapDependencies): IngestionOperationsBootstrap {
  if (typeof deps !== 'object' || deps === null) throw new TypeError('Operations bootstrap dependencies required');
  for (const [name, pick, methods] of OPS_REQUIREMENTS) {
    let v: unknown; try { v = pick(deps); } catch { v = undefined; }
    if (!hasMethods(v, methods)) throw new TypeError(`Missing operations dependency: ${name}`);
  }
  if (!validRetention(deps.retention)) throw new TypeError('Missing operations dependency: retention');
  if (typeof deps.quarantine?.summarize !== 'function') throw new TypeError('Missing operations dependency: quarantine.summarize');
  let realmValue: unknown;
  try { realmValue = deps.realmAuthority.authorizedRealm(); } catch { throw new TypeError('Realm authority failed'); }
  const realm = catalogueRealmSchema.parse(realmValue);
  const quarantine = decorateQuarantine(realm, deps.quarantine, deps.audit, deps.metrics, deps.alerts);
  const recovery = decorateRecovery(realm, deps.recovery, deps.audit, deps.metrics, deps.alerts);
  const root = createResilientMeasurementIngestionRoot({ ...deps, realmAuthority: { authorizedRealm: () => realm }, quarantine, recovery,
    retryPolicy: decorateRetryPolicy(deps.retryPolicy, deps.metrics) });
  const operations = createOperations(realm, { quarantine, audit: deps.audit, authorization: deps.authorization, recovery: deps.recovery, replayer: root,
    metrics: deps.metrics, alerts: deps.alerts, timeAuthority: deps.timeAuthority, leasePolicy: deps.leasePolicy });

  async function ingest(protectedDocument: unknown, provenanceEvidence: unknown, selection: { readonly field: string }) {
    const result = await root.ingest(protectedDocument, provenanceEvidence, selection);
    await emitMetric(deps.metrics, 'ingestion_total', { outcome: result.status });
    if (result.status === 'accepted') await emitMetric(deps.metrics, 'ingestion_accepted_total', { outcome: 'accepted' });
    if (result.status === 'duplicate' || result.status === 'recovered-committed') await emitMetric(deps.metrics, 'ingestion_duplicate_total', { outcome: result.status });
    return result;
  }

  async function operationalState(credential: unknown) {
    const principal = await (async () => {
      try {
        const raw = await runBounded(() => deps.authorization.authorize(Object.freeze({ credential, realm, capability: 'OPERATIONS_VIEW' as const, quarantineId: null })), AUTHORITY_TIMEOUT_MS);
        const d = decisionSchema.safeParse(raw);
        return d.success && d.data.decision === 'allow' && d.data.principal.realms.includes(realm) && d.data.principal.capabilities.includes('OPERATIONS_VIEW') ? d.data.principal : null;
      } catch { return null; }
    })();
    if (!principal) {
      await emitMetric(deps.metrics, 'authorization_denied_total', { stage: 'operations', outcome: 'forbidden' });
      return Object.freeze({ status: 'denied' as const, reason: 'forbidden' as const });
    }
    let rows: OperationalState['quarantine'] = [], quarantineStoreHealthy = true;
    try { rows = await deps.quarantine.summarize!(); } catch { quarantineStoreHealthy = false; }
    let auditHealthy = false; try { auditHealthy = (await runBounded(() => deps.audit.ping(), AUTHORITY_TIMEOUT_MS)) === true; } catch { auditHealthy = false; }
    return Object.freeze({ status: 'done' as const, state: describeIngestionOperationalState({ realm, quarantine: rows, auditHealthy, quarantineStoreHealthy }) });
  }

  return Object.freeze({ realm, ingest, operations, operationalState });
}
