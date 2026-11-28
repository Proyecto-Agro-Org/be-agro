import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createBe12IdentityPorts } from '../adapters/ingestion-identity.adapters.js';
import { isBlockingPlaceholder } from '../adapters/ingestion-production-placeholders.js';
import { createIngestProvenanceAuthority } from '../iot/ingest-provenance.authority.js';
import { createProtectedIngestMapper } from '../iot/protected-ingest.mapper.js';
import { catalogueRealmSchema } from '../auth/identity-catalogue.schemas.js';
import { logicalKey } from '../auth/validation.js';
import { technicalInputFingerprint } from '../iot/ingestion-event-fingerprint.js';
import { classifyIngestionFailure } from '../iot/ingestion-failure-classification.js';
import type {
  IngestionRootReadiness,
  DependencyReadiness,
  MeasurementIngestionRoot,
  MeasurementIngestionRootDependencies,
  MeasurementIngestionRootResult,
} from '../iot/ingestion-root.contracts.js';
import type {
  FailureClassification,
  QuarantineEntry,
  ReplayHolder,
  ReplayResult,
  ResilientIngestionDependencies,
  ResilientIngestionResult,
  ResilientMeasurementIngestion,
} from '../iot/ingestion-recovery.contracts.js';
import type { IdempotencyKey, MeasurementPersistencePort, PersistMeasurementInput } from '../iot/ingestion-composition.contracts.js';
import type { ProtectedMeasurementCandidate } from '../iot/protected-ingest.contracts.js';
import type { TrustGateRealm } from '../iot/trust-gate.contracts.js';
import { createMeasurementAttributionService } from './measurement-attribution.service.js';
import { createPersistentMeasurementIngestionComposition } from './measurement-ingestion-composition.service.js';

// BE13-07 — composition root. The ONLY high-level factory intended to assemble
// BE13-02 → BE13-06 for a future runtime. Not mounted in app.ts; no routes,
// consumers, workers or cron. It reads no environment variables and has no
// permissive mode: every dependency is mandatory and production placeholders
// block. It does not authenticate hardware, EMQX or anything else: it only
// decides which injected implementations are treated as authorities.
// BE13-08 adds the resilient variant (retry, recovery, quarantine, replay).

type Requirement = readonly [string, (d: ResilientIngestionDependencies) => unknown, string];
const requiredMethods: readonly Requirement[] = [
  ['realmAuthority', d => d.realmAuthority, 'authorizedRealm'],
  ['provenanceVerifier', d => d.provenanceVerifier, 'verify'],
  ['hardware', d => d.hardware, 'verify'],
  ['temporal', d => d.temporal, 'decide'],
  ['catalogue', d => d.catalogue, 'evaluate'],
  ['policies.declaredAt', d => d.policies?.declaredAt, 'decide'],
  ['policies.clock', d => d.policies?.clock, 'decide'],
  ['policies.missingReason', d => d.policies?.missingReason, 'decide'],
  ['policies.persistenceTime', d => d.policies?.persistenceTime, 'decide'],
  ['identityStore', d => d.identityStore, 'findDevicesByKey'],
  ['identityStore.associations', d => d.identityStore, 'findAssociationsAt'],
  ['persistence', d => d.persistence, 'persistAtomically'],
  ['persistence.lookup', d => d.persistence, 'lookup'],
  ['be12.temporal', d => d.be12?.temporal, 'select'],
  ['be12.catalogue', d => d.be12?.catalogue, 'accepts'],
];
const resilienceMethods: readonly Requirement[] = [
  ['retryPolicy', d => d.retryPolicy, 'decide'],
  ['retryScheduler', d => d.retryScheduler, 'wait'],
  ['recovery', d => d.recovery, 'inspect'],
  ['quarantine', d => d.quarantine, 'record'],
  ['quarantine.get', d => d.quarantine, 'get'],
  ['quarantine.transition', d => d.quarantine, 'transition'],
  ['quarantine.appendAudit', d => d.quarantine, 'appendAudit'],
];
const GROUPED = ['identityStore', 'persistence', 'quarantine'];

const hasMethod = (value: unknown, method: string) =>
  typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>)[method] === 'function';

function acknowledged(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as Record<string, unknown>).mode === 'current-state-only' &&
    (value as Record<string, unknown>).limitation === 'DEVICE_STATUS_HISTORY_REQUIRED' && Object.keys(value).length === 2;
}

// Static, local diagnosis (no IO, no secrets). Not a health endpoint. Reports
// the base pipeline AND the resilience dependencies (retry policy, retry
// scheduler, persistence recovery, quarantine store) separately.
export function describeIngestionRootReadiness(input: unknown): IngestionRootReadiness {
  const deps = (typeof input === 'object' && input !== null ? input : {}) as ResilientIngestionDependencies;
  const dependencies: Record<string, DependencyReadiness> = {};
  for (const [name, pick, method] of [...requiredMethods, ...resilienceMethods]) {
    let value: unknown;
    try { value = pick(deps); } catch { value = undefined; }
    const head = name.split('.')[0];
    const base = name.includes('.') && GROUPED.includes(head) ? head : name;
    if (!hasMethod(value, method)) dependencies[base] = 'MISSING';
    else if (dependencies[base] !== 'MISSING') dependencies[base] = isBlockingPlaceholder(value) || (name.startsWith('be12.') && isBlockingPlaceholder(deps.be12))
      ? 'BLOCKED' : 'INJECTED_UNVERIFIED';
  }
  let ack = false;
  try { ack = acknowledged(deps.deviceStatusHistory); } catch { ack = false; }
  dependencies.deviceStatusHistory = ack ? 'INJECTED_UNVERIFIED' : 'MISSING';
  const overall = Object.values(dependencies).some(state => state !== 'INJECTED_UNVERIFIED') ? 'BLOCKED' : 'READY_FOR_TEST';
  return Object.freeze({ overall, productionReady: false as const, dependencies: Object.freeze(dependencies), limitations: Object.freeze(['DEVICE_STATUS_HISTORY_REQUIRED'] as const) });
}

function requireAll(deps: unknown, list: readonly Requirement[]) {
  if (typeof deps !== 'object' || deps === null) throw new TypeError('Ingestion root dependencies required');
  for (const [name, pick, method] of list) {
    let value: unknown;
    try { value = pick(deps as ResilientIngestionDependencies); } catch { value = undefined; }
    if (!hasMethod(value, method)) throw new TypeError(`Missing ingestion root dependency: ${name}`);
  }
  if (!acknowledged((deps as MeasurementIngestionRootDependencies).deviceStatusHistory)) throw new TypeError('Missing ingestion root dependency: deviceStatusHistory acknowledgement');
}

// Private assembly shared by both factories (not exported).
function assemble(deps: MeasurementIngestionRootDependencies) {
  let realmValue: unknown;
  try { realmValue = deps.realmAuthority.authorizedRealm(); } catch { throw new TypeError('Realm authority failed'); }
  const realmResult = catalogueRealmSchema.safeParse(realmValue);
  if (!realmResult.success) throw new TypeError('Realm authority returned an invalid realm');
  const realm: TrustGateRealm = realmResult.data;
  const provenance = createIngestProvenanceAuthority(deps.provenanceVerifier);
  const mapper = createProtectedIngestMapper(provenance.authority);
  const composition = buildComposition(deps, realm, deps.persistence);
  const map = (protectedDocument: unknown, provenanceEvidence: unknown) => mapper.map(protectedDocument, provenance.attest(provenanceEvidence) ?? undefined);
  return { realm, map, composition };
}

// The realm is passed in (already fixed by the realm authority at construction): building a composition never
// consults the realm authority again (BE13-07 V6). BE13-10B uses it to build a FENCED composition per replay.
function buildComposition(deps: MeasurementIngestionRootDependencies, realm: TrustGateRealm, persistence: MeasurementPersistencePort) {
  const be12 = createMeasurementAttributionService({ ...createBe12IdentityPorts(deps.identityStore, realm),
    temporal: deps.be12.temporal, catalogue: deps.be12.catalogue } as never, { realm });
  return createPersistentMeasurementIngestionComposition({
    realmContext: { realm }, identityStore: deps.identityStore, temporal: deps.temporal, hardware: deps.hardware, catalogue: deps.catalogue,
    policies: { clock: deps.policies.clock, declaredAt: deps.policies.declaredAt, missingReason: deps.policies.missingReason, persistenceTime: deps.policies.persistenceTime },
    persistence, be12, ...(deps.authorityTimeoutMs === undefined ? {} : { authorityTimeoutMs: deps.authorityTimeoutMs }),
  });
}

export function createMeasurementIngestionRoot(deps: MeasurementIngestionRootDependencies): MeasurementIngestionRoot {
  requireAll(deps, requiredMethods);
  const { realm, map, composition } = assemble(deps);
  async function ingest(protectedDocument: unknown, provenanceEvidence: unknown, selection: { readonly field: string }): Promise<MeasurementIngestionRootResult> {
    const mapped = map(protectedDocument, provenanceEvidence);
    if (mapped.status !== 'candidate') return Object.freeze({ status: 'quarantined', reason: 'mapper-rejected', cause: mapped.reason, eventId: null });
    return composition.ingest(mapped, selection);
  }
  return Object.freeze({ ingest, realm });
}

// ---------------------------------------------------------------- BE13-08 resilient root
// Safety net independent of any policy: never more attempts than this in one
// call, whatever the injected policy says. Not an SLO.
const HARD_ATTEMPT_CEILING = 10;

// Injected recovery and quarantine stores are dependencies: their answers are validated, never trusted.
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const recoveryReportSchema = z.discriminatedUnion('state', [
  z.object({ realm: catalogueRealmSchema, state: z.literal('committed'), measurementId: z.string().regex(/^m_[0-9a-f]{64}$/), fingerprint: hex64 }).strict(),
  z.object({ realm: catalogueRealmSchema, state: z.literal('not-committed') }).strict(),
  z.object({ realm: catalogueRealmSchema, state: z.literal('inconsistent'), inconsistency: z.enum(['orphan-claim', 'orphan-measurement', 'claim-measurement-mismatch',
    'fingerprint-mismatch', 'malformed-claim', 'malformed-measurement', 'unexpected-identity']) }).strict(),
]);
const recordedSchema = z.object({ realm: catalogueRealmSchema, quarantineId: z.string().regex(/^q_[0-9a-f]{64}$/),
  status: z.enum(['OPEN', 'RETRYABLE', 'REPLAYING', 'BLOCKED', 'RESOLVED', 'DISCARDED']), attemptCount: z.number().int().min(1) }).strict();
const replayRecordSchema = z.object({ quarantineId: z.string().regex(/^q_[0-9a-f]{64}$/), realm: catalogueRealmSchema,
  status: z.enum(['OPEN', 'RETRYABLE', 'REPLAYING', 'BLOCKED', 'RESOLVED', 'DISCARDED']), reasonCode: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
  sourceId: z.string().nullable(), operation: z.enum(['measurement', 'device-status']).nullable(), eventId: z.string().nullable(), field: z.string().nullable(),
  device: z.object({ kind: z.enum(['mqtt-clientid', 'device-id']), value: z.string() }).strict().nullable(), fingerprint: hex64.nullable(),
  lease: z.object({ ownerId: z.string(), acquiredAt: z.number(), token: z.number().int() }).strict().nullable().optional() }).passthrough();

// BE13-10B — the lease handed over by the operations service (owner = authorized principal id, token = fencing token).
const replayLeaseSchema = z.object({ ownerId: z.string().min(1).max(128).regex(/^[A-Za-z0-9:_./-]+$/), leaseToken: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict();
// Internal sentinel: the fence reported the lease lost; the run stops without any further side effect.
const FENCE_LOST: unique symbol = Symbol('be13-10b/fence-lost');

function canonical(value: unknown, depth = 0): unknown {
  if (depth > 32) throw new Error('too deep');
  if (value instanceof Date) return { $date: Number.isNaN(value.getTime()) ? 'invalid' : value.toISOString() };
  if (Array.isArray(value)) return value.map(v => canonical(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) out[k] = canonical((value as Record<string, unknown>)[k], depth + 1);
    return out;
  }
  return typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean' || value === null ? value : String(typeof value);
}
// Technical digest used as dedupe identity when no eventId exists. The document itself is never stored.
function documentDigest(document: unknown): string {
  let text: string;
  try { text = JSON.stringify(canonical(document)); } catch { text = 'be13-08/unserializable-document'; }
  return createHash('sha256').update('be13-08/doc:' + text, 'utf8').digest('hex');
}

export function createResilientMeasurementIngestionRoot(deps: ResilientIngestionDependencies): ResilientMeasurementIngestion {
  requireAll(deps, [...requiredMethods, ...resilienceMethods]);
  const { realm, map, composition } = assemble(deps);
  const decide = deps.retryPolicy.decide.bind(deps.retryPolicy);
  const wait = deps.retryScheduler.wait.bind(deps.retryScheduler);
  const inspect = deps.recovery.inspect.bind(deps.recovery);
  const quarantine = deps.quarantine;

  const keyOf = (c: ProtectedMeasurementCandidate, field: string): IdempotencyKey =>
    Object.freeze({ realm, sourceId: c.sourceId, operation: c.storeOperation, eventId: c.eventId, field });
  const entryOf = (c: ProtectedMeasurementCandidate | null, field: string | null, cls: FailureClassification, cause: string | null,
    fingerprint: string | null, digest: string | null): QuarantineEntry => Object.freeze({
    realm, stage: cls.stage, sourceId: c?.sourceId ?? null, operation: c?.storeOperation ?? null, eventId: c?.eventId ?? null, field,
    device: c ? Object.freeze({ kind: c.device.kind, value: c.device.value }) : null, reasonCode: cls.reasonCode, cause,
    retryClass: cls.retryClass, fingerprint, documentDigest: digest });

  async function toQuarantine(entry: QuarantineEntry, attempts: number): Promise<ResilientIngestionResult> {
    try {
      const recorded = recordedSchema.parse(await quarantine.record(entry));
      if (recorded.realm !== realm) throw new Error('QUARANTINE_REALM_MISMATCH');
      return Object.freeze({ status: 'quarantined', quarantineId: recorded.quarantineId, quarantineStatus: recorded.status, reasonCode: entry.reasonCode,
        retryClass: entry.retryClass, eventId: entry.eventId, attempts });
    } catch {
      // Nothing could be recorded: the outcome is uncertain; the caller must retry with the same input.
      return Object.freeze({ status: 'uncertain', reasonCode: 'quarantine-unavailable', eventId: entry.eventId, attempts });
    }
  }
  const cls = (reasonCode: string, retryClass: FailureClassification['retryClass'], stage: FailureClassification['stage']): FailureClassification =>
    Object.freeze({ retryClass, stage, reasonCode, retryable: retryClass === 'transient' });

  // Same candidate (same identity) on every attempt: retries never create a new eventId, field, realm or fingerprint.
  // BE13-10B: a fenced replay passes its own composition; when the fence reports the lease was lost, the run stops
  // IMMEDIATELY (no classification, recovery, retry or new quarantine record): nothing was written.
  async function run(candidate: ProtectedMeasurementCandidate, field: string,
    fenced?: { readonly composition: typeof composition; readonly lost: () => boolean }): Promise<ResilientIngestionResult | typeof FENCE_LOST> {
    const activeComposition = fenced?.composition ?? composition;
    const key = keyOf(candidate, field), fingerprint = technicalInputFingerprint(realm, candidate, field);
    // One read per decision; the report already read is classified (no second read that could race).
    const tryInspect = async () => { try { const r = recoveryReportSchema.safeParse(await inspect(key)); return r.success ? r.data : null; } catch { return null; } };
    const fromReport = (report: z.output<typeof recoveryReportSchema> | null, attempts: number, committedStatus: 'duplicate' | 'recovered-committed'): Promise<ResilientIngestionResult> => {
      if (!report) return toQuarantine(entryOf(candidate, field, cls('persistence-uncertain', 'transient', 'recovery'), null, fingerprint, null), attempts);
      if (report.realm !== realm) return toQuarantine(entryOf(candidate, field, cls('realm-mismatch', 'security', 'recovery'), 'recovery', fingerprint, null), attempts);
      if (report.state === 'committed') {
        if (report.fingerprint !== fingerprint) return toQuarantine(entryOf(candidate, field, cls('idempotency-conflict', 'conflict', 'recovery'), null, fingerprint, null), attempts);
        return Promise.resolve(Object.freeze({ status: committedStatus, measurementId: report.measurementId, eventId: candidate.eventId, attempts }));
      }
      // 'inconsistent', or 'not-committed' where a commit was claimed (duplicate): never repaired, quarantined with evidence.
      const detail = report.state === 'inconsistent' ? report.inconsistency : 'orphan-claim';
      return toQuarantine(entryOf(candidate, field, cls('persistence-state-inconsistent', 'consistency', 'recovery'), detail, fingerprint, null), attempts);
    };
    for (let attempt = 1; attempt <= HARD_ATTEMPT_CEILING; attempt += 1) {
      const result = await activeComposition.ingest(candidate, { field });
      if (fenced?.lost()) return FENCE_LOST;
      if (result.status === 'accepted') return Object.freeze({ status: 'accepted', measurementId: result.measurementId, eventId: candidate.eventId, attempts: attempt });
      let classification: FailureClassification;
      let cause: string | null = null;
      if (result.status === 'duplicate') {
        // A duplicate is confirmed against MAJORITY-committed state, never trusted from the claim alone.
        const report = await tryInspect();
        if (!report || report.state !== 'not-committed') return fromReport(report, attempt, 'duplicate');
        // The claim was visible to the lookup but is not majority-committed yet (replication lag /
        // partition): this is uncertainty, not corruption. Real orphans are reported as 'inconsistent'.
        classification = cls('persistence-uncertain', 'transient', 'recovery');
      } else {
        classification = classifyIngestionFailure(result.reason, result.cause);
        cause = result.cause ?? null;
        if (classification.retryClass === 'ambiguous-commit') {
          // R1: recover before deciding anything; never blindly re-run with a new identity.
          const report = await tryInspect();
          if (!report || report.state !== 'not-committed') return fromReport(report, attempt, 'recovered-committed');
          classification = cls('persistence-unavailable', 'transient', 'persistence');
        }
      }
      if (!classification.retryable) return toQuarantine(entryOf(candidate, field, classification, cause, fingerprint, null), attempt);
      let decision: { action?: unknown } | undefined;
      try { decision = decide(Object.freeze({ realm, attempt, retryClass: 'transient', reasonCode: classification.reasonCode })); } catch { decision = undefined; }
      if (decision?.action !== 'retry' || attempt === HARD_ATTEMPT_CEILING)
        return toQuarantine(entryOf(candidate, field, classification, 'retry-exhausted', fingerprint, null), attempt);
      try { await wait(Object.freeze({ attempt, reasonCode: classification.reasonCode })); }
      catch { return toQuarantine(entryOf(candidate, field, classification, 'retry-exhausted', fingerprint, null), attempt); }
    }
    return toQuarantine(entryOf(candidate, field, cls('retry-exhausted', 'transient', 'retry'), null, fingerprint, null), HARD_ATTEMPT_CEILING);
  }

  async function ingest(protectedDocument: unknown, provenanceEvidence: unknown, selection: { readonly field: string }): Promise<ResilientIngestionResult> {
    const fieldResult = logicalKey.safeParse((selection as { field?: unknown } | null)?.field);
    const field = fieldResult.success ? fieldResult.data : null;
    const mapped = map(protectedDocument, provenanceEvidence);
    if (mapped.status !== 'candidate') {
      const classification = classifyIngestionFailure('mapper-rejected', mapped.reason);
      return toQuarantine(entryOf(null, field, classification, null, null, documentDigest(protectedDocument)), 1);
    }
    if (field === null) return toQuarantine(entryOf(mapped, null, classifyIngestionFailure('invalid-selection', null), null, null, null), 1);
    return run(mapped, field) as Promise<ResilientIngestionResult>; // never FENCE_LOST without a fence
  }

  async function replay(input: { readonly quarantineId: string; readonly protectedDocument: unknown; readonly provenanceEvidence: unknown; readonly field: string;
    readonly lease?: { readonly ownerId: string; readonly leaseToken: number } }): Promise<ReplayResult> {
    const reject = (reasonCode: Extract<ReplayResult, { status: 'replay-rejected' }>['reasonCode']): ReplayResult => Object.freeze({ status: 'replay-rejected', reasonCode });
    const idOk = typeof input?.quarantineId === 'string' && /^q_[0-9a-f]{64}$/.test(input.quarantineId);
    const fieldOk = logicalKey.safeParse(input?.field).success;
    const leaseInput = input?.lease === undefined ? null : replayLeaseSchema.safeParse(input.lease);
    if (!idOk || !fieldOk || (leaseInput !== null && !leaseInput.success)) return reject('invalid-replay-input');
    // BE13-10B: a replay writes ONLY through an adapter that fences atomically; otherwise nothing is attempted.
    if (deps.persistence.replayFencing !== 'atomic') return reject('replay-fence-unsupported');
    let record: z.output<typeof replayRecordSchema> | null = null;
    try { const raw = await quarantine.get(input.quarantineId); if (raw !== null) record = replayRecordSchema.parse(raw); } catch { record = null; }
    if (!record || record.realm !== realm || record.quarantineId !== input.quarantineId) return reject('quarantine-not-found');
    const current = record;
    const audit = async (outcome: string) => { try { await quarantine.appendAudit(current.quarantineId, { action: 'replay', outcome, reasonCode: current.reasonCode, evidence: null }); } catch { /* best effort */ } };
    const holder: ReplayHolder = leaseInput?.success
      ? Object.freeze({ kind: 'lease' as const, ownerId: leaseInput.data.ownerId, leaseToken: leaseInput.data.leaseToken })
      : Object.freeze({ kind: 'unleased' as const });
    if (holder.kind === 'lease') {
      // The caller must hold THIS lease right now (owner + token): otherwise it is a stale replay.
      if (record.status !== 'REPLAYING' || record.lease?.ownerId !== holder.ownerId || record.lease?.token !== holder.leaseToken) {
        await audit('stale-replay-lease'); return reject('stale-replay-lease');
      }
    } else if (record.status !== 'RETRYABLE') { await audit('replay-not-allowed'); return reject('replay-not-allowed'); }
    // 'error' (store unreachable) is kept apart from 'stale' (someone else holds/settled the entry).
    const settle = async (to: 'RESOLVED' | 'RETRYABLE' | 'BLOCKED', outcome: string): Promise<string> => {
      try { return await quarantine.settleReplay({ quarantineId: current.quarantineId, holder, to, outcome, evidence: 'replay' }); } catch { return 'error'; }
    };
    const releaseLease = async (outcome: string) => { if (holder.kind === 'lease') await settle('RETRYABLE', outcome); };
    const mapped = map(input.protectedDocument, input.provenanceEvidence);
    if (mapped.status !== 'candidate' || record.sourceId !== mapped.sourceId || record.operation !== mapped.storeOperation || record.eventId !== mapped.eventId ||
      record.field !== input.field || record.device?.kind !== mapped.device.kind || record.device?.value !== mapped.device.value) {
      await audit('replay-identity-mismatch'); await releaseLease('replay-identity-mismatch'); return reject('replay-identity-mismatch');
    }
    if (record.fingerprint === null || record.fingerprint !== technicalInputFingerprint(realm, mapped, input.field)) {
      await audit('replay-fingerprint-mismatch'); await releaseLease('replay-fingerprint-mismatch'); return reject('replay-fingerprint-mismatch');
    }
    // FENCE: "measurement written" and "this holder still holds the entry" are ONE atomic unit. The fence CAS settles the
    // entry to RESOLVED inside the persistence transaction; if the lease was recovered/released/changed meanwhile, the CAS
    // matches nothing, the transaction aborts and no measurement exists. A store failure inside the fence also aborts it.
    const fence: { state: 'unset' | 'held' | 'lost' } = { state: 'unset' };
    const fencedPersistence: MeasurementPersistencePort = Object.freeze({
      lookup: (key: IdempotencyKey) => deps.persistence.lookup(key),
      persistAtomically: (persistInput: PersistMeasurementInput) => deps.persistence.persistAtomically(persistInput, Object.freeze({
        fence: async (transaction: unknown) => {
          const result = await quarantine.settleReplay({ quarantineId: current.quarantineId, holder, to: 'RESOLVED', outcome: 'replay-persisted', evidence: 'replay' }, transaction);
          fence.state = result === 'transitioned' ? 'held' : 'lost';
          return fence.state === 'held';
        },
      })),
      replayFencing: 'atomic' as const,
    });
    const outcome = await run(mapped, input.field, { composition: buildComposition(deps, realm, fencedPersistence), lost: () => fence.state === 'lost' });
    if (outcome === FENCE_LOST) { await audit('stale-replay-lease'); return reject('stale-replay-lease'); }
    const done = outcome.status === 'accepted' || outcome.status === 'duplicate' || outcome.status === 'recovered-committed';
    const blocked = outcome.status === 'quarantined' && outcome.quarantineStatus === 'BLOCKED';
    // Settling is CAS on the same holder. If the fenced commit already settled RESOLVED (fence === 'held'), the CAS is
    // simply stale. Otherwise a stale CAS means this replay LOST its hold before completing: it wrote nothing under its
    // lease (an existing measurement, if any, was written by someone else) and is reported as stale, never as done.
    const lostHold = async () => { await audit('stale-replay-lease'); return reject('stale-replay-lease'); };
    if (done) {
      if ((await settle('RESOLVED', outcome.status)) === 'stale' && fence.state !== 'held') return lostHold();
    } else if (blocked) {
      if ((await settle('BLOCKED', outcome.reasonCode)) === 'stale' && holder.kind === 'lease') return lostHold();
    } else {
      await audit(outcome.reasonCode);
      if (holder.kind === 'lease' && (await settle('RETRYABLE', outcome.reasonCode)) === 'stale') return lostHold();
    }
    let after;
    try { after = await quarantine.get(current.quarantineId); } catch { after = null; }
    return Object.freeze({ status: 'replayed', quarantineId: current.quarantineId, outcome, quarantineStatus: after?.status ?? record.status });
  }

  return Object.freeze({ realm, ingest, replay });
}
