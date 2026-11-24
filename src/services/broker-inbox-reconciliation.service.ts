import { z } from 'zod';
import { isBlockingPlaceholder } from '../adapters/ingestion-production-placeholders.js';
import { emitAlert, emitMetric } from '../iot/ingestion-observability.js';
import type { AuditAction, IngestionAlertPort, IngestionAuditStore, IngestionMetricsPort } from '../iot/ingestion-operations.contracts.js';
import {
  MAX_RECONCILE_LIMIT, type BrokerInboxReconciler, type BrokerInboxReconciliationStore, type InboxClaim, type InboxReconciliationPolicy, type ReconcileBlocked,
  type ReconcileOptions, type ReconcileReport, type ReconciliationOutcome, type ReconciliationResultCode,
} from '../iot/inbox-reconciliation.contracts.js';
import type { DurableBrokerAdmissionService } from '../iot/mqtt-ingestion-boundary.contracts.js';
import type { TrustGateRealm } from '../iot/trust-gate.contracts.js';
import { runBounded } from './authority-call.js';

// BE13-11C — manual, offline reconciliation of durable inbox records that were persisted without a receipt/marker (N4).
// - Explicit call only: no timer, no loop, no polling, no worker, not wired into app.ts.
// - The policy decides IF and WHEN a record may be claimed; the productive default is BLOCKED (nothing is decided here).
// - Integrity is recomputed by the durable admission service BEFORE anything reaches the pipeline.
// - The claim is a fenced CAS: only the holder of the current (token, version) can complete.
// - Duplicate work is bounded by the claim; downstream idempotency (BE13-06) still guarantees one measurement.
const inboxIdSchema = z.string().regex(/^ib_[0-9a-f]{32}$/);
const policySchema = z.object({ mode: z.enum(['TEST_ONLY', 'APPROVED']), minAgeMs: z.number().int().min(0), claimLeaseMs: z.number().int().min(0),
  maxBatch: z.number().int().min(1).max(MAX_RECONCILE_LIMIT) }).strict();
const optionsSchema = z.object({ mode: z.enum(['inspect-only', 'reconcile']), limit: z.number().int().min(1).max(MAX_RECONCILE_LIMIT) }).strict();
// Store answers are validated like any other authority answer (a hostile or malformed answer is never trusted).
const claimSchema = z.object({ inboxId: inboxIdSchema, token: z.string().regex(/^[0-9a-f]{32}$/), version: z.number().int().min(1) }).strict();
const candidateSchema = z.object({ inboxId: inboxIdSchema, rawPersistedAt: z.number().int().min(0) }).strict();
const stateSchema = z.object({ status: z.enum(['receipted', 'claimed', 'completed']), version: z.number().int().min(1), outcome: z.string().nullable() }).strict().nullable();
const countsSchema = z.object({ absent: z.number().int().min(0), receipted: z.number().int().min(0), claimed: z.number().int().min(0), completed: z.number().int().min(0) }).strict();
const BOUND_MS = 20_000; // operational ceiling per store call (not an SLO)
const freeze = <T>(v: T): T => Object.freeze(v);
const call = <T>(operation: () => Promise<T>, ms: number) => runBounded(operation, ms) as Promise<T>;

export interface BrokerInboxReconcilerDependencies {
  readonly realm: TrustGateRealm;
  readonly admission: DurableBrokerAdmissionService;
  readonly reconciliationStore: BrokerInboxReconciliationStore;
  readonly reconciliationPolicy: unknown;
  readonly audit: IngestionAuditStore;
  readonly metrics: IngestionMetricsPort;
  readonly alerts: IngestionAlertPort;
}

export function createBrokerInboxReconciler(deps: BrokerInboxReconcilerDependencies): BrokerInboxReconciler {
  if (typeof deps !== 'object' || deps === null) throw new TypeError('Reconciler dependencies required');
  const { admission, reconciliationStore: store, audit, metrics, alerts } = deps;
  if (typeof admission?.processPersistedBrokerDelivery !== 'function') throw new TypeError('Missing reconciler dependency: admission');
  for (const m of ['listCandidates', 'count', 'claim', 'complete', 'getState'] as const)
    if (typeof store?.[m] !== 'function') throw new TypeError('Missing reconciler dependency: reconciliationStore');
  const realm = admission.realm;
  if (deps.realm !== realm) throw new TypeError('Reconciler realm must equal the admission realm (authorized bootstrap)');

  // The policy is snapshotted once. A placeholder, a missing or an invalid policy is BLOCKED.
  const parsed = !isBlockingPlaceholder(deps.reconciliationPolicy) ? policySchema.safeParse(deps.reconciliationPolicy) : null;
  const policy: InboxReconciliationPolicy = parsed?.success ? freeze({ ...parsed.data })
    : freeze({ mode: 'BLOCKED' as const, reason: 'reconciliation-policy-not-decided' as const });

  async function audited(action: AuditAction, outcome: string) {
    try {
      await call(() => audit.append(freeze({ realm, quarantineId: null, eventId: null, action, actorId: 'inbox-reconciler', actorCapabilities: freeze([]),
        outcome, reasonCode: outcome, evidence: null })), 5_000);
    } catch { /* best effort: never changes a durable fact */ }
  }
  const result = async (code: ReconciliationResultCode, reasonCode?: string): Promise<ReconciliationResultCode> => {
    await emitMetric(metrics, 'broker_inbox_reconciliation_total', { stage: 'boundary', outcome: code, ...(reasonCode ? { reasonCode } : {}) });
    return code;
  };
  const finish = async (claim: InboxClaim, outcome: ReconciliationOutcome, code: ReconciliationResultCode, reasonCode?: string): Promise<ReconciliationResultCode> => {
    let done = false;
    try { done = (await call(() => store.complete(freeze({ realm, claim, outcome })), BOUND_MS)) === true; } catch { return result('unavailable', 'broker-inbox-unavailable'); }
    if (!done) { await audited('inbox-reconciliation-stale', 'stale-reconciliation'); return result('stale-reconciliation'); } // fenced out: nothing final recorded
    await audited('inbox-reconciliation-completed', outcome);
    return result(code, reasonCode);
  };

  async function reconcileOne(inboxIdRaw: string): Promise<ReconciliationResultCode> {
    if (policy.mode === 'BLOCKED') return result('blocked');
    const id = inboxIdSchema.safeParse(inboxIdRaw);
    if (!id.success) return result('blocked');
    let claim: InboxClaim | null;
    try {
      const answer = await call(() => store.claim(freeze({ realm, inboxId: id.data, claimLeaseMs: policy.claimLeaseMs })), BOUND_MS);
      const c = answer === null ? null : claimSchema.parse(answer);
      if (c !== null && c.inboxId !== id.data) throw new Error('claim answer for another record');
      claim = c === null ? null : freeze({ ...c });
    } catch { return result('unavailable', 'broker-inbox-unavailable'); }
    if (claim === null) {
      let state;
      try { state = stateSchema.parse(await call(() => store.getState(freeze({ realm, inboxId: id.data })), BOUND_MS)); } catch { return result('unavailable', 'broker-inbox-unavailable'); }
      if (state?.status === 'completed') return result('duplicate');          // already reconciled or processed through its receipt: nothing to do
      if (state?.status === 'claimed') return result('stale-reconciliation'); // another reconciler holds a live claim
      return result('blocked');                                              // receipted (the receipt holder owns it) or no such record in this realm
    }
    await audited('inbox-reconciliation-claimed', 'claimed');
    // Integrity (bytes, context, provenance fingerprints) is recomputed inside processPersistedBrokerDelivery BEFORE ingestion.
    const processed = await admission.processPersistedBrokerDelivery(freeze({ inboxId: id.data }));
    if (processed.status === 'rejected') {
      if (processed.reasonCode === 'broker-inbox-integrity-failed') {
        await audited('inbox-reconciliation-integrity-failed', 'integrity-failed');
        await emitAlert(alerts, { type: 'BROKER_INBOX_RECONCILIATION_FAILED', severity: 'CRITICAL', reasonCode: 'broker-inbox-integrity-failed' });
        // Sticky and NEVER retryable: the record is not repaired and not processed again.
        return finish(claim, 'integrity-failed', 'integrity-failed', 'broker-inbox-integrity-failed');
      }
      if (processed.reasonCode === 'broker-inbox-unavailable' || processed.reasonCode === 'broker-inbox-not-found') {
        await emitAlert(alerts, { type: 'BROKER_INBOX_RECONCILIATION_FAILED', severity: 'WARNING', reasonCode: 'broker-inbox-unavailable' });
        return result('unavailable', 'broker-inbox-unavailable'); // claim is left to expire; nothing final recorded
      }
      return finish(claim, 'blocked', 'blocked', processed.reasonCode);
    }
    const statuses = processed.results.map(r => r.result.status);
    if (statuses.some(s => s === 'uncertain')) {
      await emitAlert(alerts, { type: 'BROKER_INBOX_RECONCILIATION_FAILED', severity: 'WARNING', reasonCode: 'broker-inbox-unavailable' });
      return result('unavailable', 'broker-inbox-unavailable');
    }
    if (statuses.some(s => s === 'quarantined')) return finish(claim, 'blocked', 'blocked');
    if (statuses.every(s => s === 'duplicate')) return finish(claim, 'already-processed', 'already-processed');
    return finish(claim, 'recovered-and-processed', 'recovered-and-processed');
  }

  async function reconcileBrokerInbox(raw: ReconcileOptions): Promise<ReconcileReport | ReconcileBlocked> {
    const o = optionsSchema.safeParse(raw);
    if (!o.success) return freeze({ status: 'blocked' as const, reason: 'invalid-options' as const });
    const limit = policy.mode === 'BLOCKED' ? o.data.limit : Math.min(o.data.limit, policy.maxBatch);
    let counts, candidates: readonly { inboxId: string }[] = [];
    try {
      counts = countsSchema.parse(await call(() => store.count(freeze({ realm, limit })), BOUND_MS));
      // Without a decided policy there is no definition of "old enough": no candidates are listed and nothing is claimed.
      if (policy.mode !== 'BLOCKED') {
        const answer = await call(() => store.listCandidates(freeze({ realm, minAgeMs: policy.minAgeMs, limit })), BOUND_MS);
        if (!Array.isArray(answer) || answer.length > limit) throw new Error('invalid candidates answer');
        candidates = answer.map(c => candidateSchema.parse(c));
      }
    } catch { return freeze({ status: 'blocked' as const, reason: 'unavailable' as const }); }
    for (const c of candidates) { await emitMetric(metrics, 'broker_inbox_orphan_candidate_total', { stage: 'boundary', outcome: 'candidate' }); await audited('inbox-reconciliation-candidate', 'candidate'); }
    if (candidates.length > 0) await emitAlert(alerts, { type: 'BROKER_INBOX_ORPHAN_DETECTED', severity: 'WARNING', reasonCode: null });
    if (o.data.mode === 'inspect-only' || policy.mode === 'BLOCKED') {
      if (o.data.mode === 'reconcile' && policy.mode === 'BLOCKED') return freeze({ status: 'blocked' as const, reason: 'reconciliation-policy-not-decided' as const });
      return freeze({ status: 'report' as const, mode: o.data.mode, realm, policy: policy.mode, scanned: candidates.length, counts, candidates: freeze(candidates.map(c => c.inboxId)), results: freeze([]) });
    }
    const results = [];
    for (const c of candidates) results.push(freeze({ inboxId: c.inboxId, result: await reconcileOne(c.inboxId) })); // sequential: bounded and deterministic
    return freeze({ status: 'report' as const, mode: o.data.mode, realm, policy: policy.mode, scanned: candidates.length, counts, candidates: freeze(candidates.map(c => c.inboxId)), results: freeze(results) });
  }

  return freeze({ realm, reconcileBrokerInbox, reconcileOne });
}
