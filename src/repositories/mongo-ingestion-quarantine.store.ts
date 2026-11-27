import { createHash } from 'node:crypto';
import type { ClientSession, Connection } from 'mongoose';
import { z } from 'zod';
import { catalogueRealmSchema } from '../auth/identity-catalogue.schemas.js';
import { initialQuarantineStatus, isTransitionAllowed } from '../iot/ingestion-failure-classification.js';
import type {
  IngestionQuarantineStore,
  QuarantineAuditEntry,
  LeaseAcquireResult,
  QuarantineEntry,
  QuarantineRecord,
  ReplayHolder,
  QuarantineStatus,
  TransitionResult,
} from '../iot/ingestion-recovery.contracts.js';
import type { TrustGateRealm } from '../iot/trust-gate.contracts.js';
import { quarantineCollection } from '../models/ingestion-quarantine.models.js';
import { currentQuarantineScope } from '../iot/quarantine-reconcile-scope.js';

// BE13-08 — Mongo quarantine store. Realm is part of every filter AND of the
// quarantineId derivation. Dedupe: one document per (realm, stage, sourceId,
// operation, eventId, field, reasonCode[, documentDigest when no eventId]);
// repetitions increment attemptCount and append a bounded audit entry.

const code = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/);
const text = z.string().min(1).max(256).refine(v => !/[\p{Cc}]/u.test(v));
const hex = z.string().regex(/^[0-9a-f]{64}$/);
const evidence = z.string().min(1).max(256).regex(/^[A-Za-z0-9:_./-]+$/);
const principalRef = z.string().min(1).max(128).regex(/^[A-Za-z0-9:_./@-]+$/);
export const quarantineEntrySchema = z.object({
  realm: catalogueRealmSchema,
  stage: z.enum(['mapper', 'trust-gate', 'builder', 'be12', 'composition', 'persistence', 'recovery', 'retry']),
  sourceId: text.nullable(), operation: z.enum(['measurement', 'device-status']).nullable(), eventId: text.nullable(), field: text.nullable(),
  device: z.object({ kind: z.enum(['mqtt-clientid', 'device-id']), value: text }).strict().nullable(),
  reasonCode: code, cause: code.nullable(),
  retryClass: z.enum(['transient', 'ambiguous-commit', 'validation', 'security', 'conflict', 'policy-blocked', 'consistency', 'unknown']),
  fingerprint: hex.nullable(), documentDigest: hex.nullable(),
  principalReference: principalRef.nullable().optional(), payloadSha256: hex.nullable().optional(), declaredEventId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/).nullable().optional(),
}).strict().refine(e => e.eventId !== null || e.documentDigest !== null, 'eventId or documentDigest required for dedupe');
const auditSchema = z.object({ action: z.enum(['recorded', 'transition', 'replay']), outcome: code, reasonCode: code.nullable(), evidence: evidence.nullable() }).strict();
const statusSchema = z.enum(['OPEN', 'RETRYABLE', 'REPLAYING', 'BLOCKED', 'RESOLVED', 'DISCARDED']);
const idSchema = z.string().regex(/^q_[0-9a-f]{64}$/);
const date = z.date().transform(d => d.getTime());
const storedSchema = z.object({ _id: idSchema, realm: catalogueRealmSchema, stage: quarantineEntrySchema.shape.stage,
  sourceId: text.nullable(), operation: z.enum(['measurement', 'device-status']).nullable(), eventId: text.nullable(), field: text.nullable(),
  device: z.object({ kind: z.enum(['mqtt-clientid', 'device-id']), value: text }).strict().nullable(), reasonCode: code, cause: code.nullable(),
  retryClass: quarantineEntrySchema.shape.retryClass, fingerprint: hex.nullable(), documentDigest: hex.nullable(),
  principalReference: principalRef.nullable().optional(), payloadSha256: hex.nullable().optional(), declaredEventId: z.string().nullable().optional(), status: statusSchema,
  version: z.number().int().min(1), attemptCount: z.number().int().min(1), firstSeenAt: date, lastSeenAt: date, createdAt: date, updatedAt: date,
  audit: z.array(z.object({ action: z.enum(['recorded', 'transition', 'replay']), at: date, outcome: code, reasonCode: code.nullable(), evidence: evidence.nullable() }).strict()).max(100),
  lease: z.object({ ownerId: evidence.max(128), acquiredAt: date, token: z.number().int().min(1) }).strict().optional(),
}).strict().refine(d => (d.status === 'REPLAYING') === (d.lease !== undefined), 'lease present iff REPLAYING');
const leaseOwner = z.string().min(1).max(128).regex(/^[A-Za-z0-9:_./-]+$/);
const leaseToken = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const holderSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('lease'), ownerId: leaseOwner, leaseToken }).strict(),
  z.object({ kind: z.literal('unleased') }).strict(),
]);

export function quarantineIdFor(entry: QuarantineEntry): string {
  const key = ['be13-08/q1', entry.realm, entry.stage, entry.sourceId, entry.operation, entry.eventId, entry.field, entry.reasonCode,
    entry.eventId === null ? entry.documentDigest : null];
  return 'q_' + createHash('sha256').update(JSON.stringify(key), 'utf8').digest('hex');
}

const literal = (value: unknown) => ({ $literal: value });
const auditPush = (entry: QuarantineAuditEntry) => ({ $slice: [{ $concatArrays: [{ $ifNull: ['$audit', []] },
  [{ action: literal(entry.action), at: '$$NOW', outcome: literal(entry.outcome), reasonCode: literal(entry.reasonCode), evidence: literal(entry.evidence) }]] }, -100] });

export function createMongoIngestionQuarantineStore(options: { connection: Connection; prefix: string; realm: TrustGateRealm }): IngestionQuarantineStore {
  const db = options.connection.db;
  if (!db) throw new TypeError('Connected MongoDB database required');
  const realm = catalogueRealmSchema.parse(options.realm);
  const rows = db.collection(quarantineCollection(options.prefix));
  const writeConcern = { w: 'majority' as const, j: true, wtimeoutMS: 5000 };

  async function get(rawId: unknown): Promise<QuarantineRecord | null> {
    const id = idSchema.parse(rawId);
    const raw = await rows.findOne({ _id: id as never, realm }, { maxTimeMS: 3000, readConcern: { level: 'majority' } } as never);
    if (raw === null) return null;
    const { _id, createdAt: _c, updatedAt: _u, lease, ...doc } = storedSchema.parse(raw);
    return Object.freeze({ ...doc, quarantineId: _id, audit: Object.freeze(doc.audit.map(a => Object.freeze(a))), lease: lease ? Object.freeze({ ...lease }) : null });
  }

  return Object.freeze({
    async record(rawEntry: unknown) {
      // BE13-11M: a NEW row keeps the authenticated scope + hash + declared eventId the boundary proved (ambient context). The dedupe identity (quarantineId) ignores them.
      const ambient = currentQuarantineScope();
      const entry = quarantineEntrySchema.parse(ambient && rawEntry && typeof rawEntry === 'object' ? { ...(rawEntry as object), principalReference: ambient.principalReference, payloadSha256: ambient.payloadSha256, declaredEventId: ambient.declaredEventId } : rawEntry);
      if (entry.realm !== realm) throw new Error('QUARANTINE_REALM_MISMATCH');
      const id = quarantineIdFor(entry);
      const fixed = Object.fromEntries(Object.entries(entry).map(([k, v]) => [k, { $ifNull: ['$' + k, literal(v)] }]));
      await rows.updateOne({ _id: id as never, realm }, [{ $set: {
        ...fixed,
        status: { $ifNull: ['$status', literal(initialQuarantineStatus(entry.retryClass))] },
        attemptCount: { $add: [{ $ifNull: ['$attemptCount', 0] }, 1] },
        version: { $add: [{ $ifNull: ['$version', 0] }, 1] },
        firstSeenAt: { $ifNull: ['$firstSeenAt', '$$NOW'] }, createdAt: { $ifNull: ['$createdAt', '$$NOW'] }, lastSeenAt: '$$NOW', updatedAt: '$$NOW',
        audit: auditPush({ action: 'recorded', outcome: entry.reasonCode, reasonCode: entry.reasonCode, evidence: null }),
      } }], { upsert: true, writeConcern, maxTimeMS: 3000 } as never);
      const stored = await get(id);
      if (!stored) throw new Error('QUARANTINE_NOT_PERSISTED');
      return Object.freeze({ realm, quarantineId: id, status: stored.status, attemptCount: stored.attemptCount });
    },
    get,
    async transition(input: { quarantineId: string; from: QuarantineStatus; to: QuarantineStatus; evidence: string | null; outcome: string; expectedVersion?: number }): Promise<TransitionResult> {
      const parsed = z.object({ quarantineId: idSchema, from: statusSchema, to: statusSchema, evidence: evidence.nullable(), outcome: code,
        expectedVersion: z.number().int().min(1).optional() }).strict().parse(input);
      // BE13-10B: REPLAYING is entered and left ONLY through the lease CAS (acquireLease / settleReplay).
      if (parsed.from === 'REPLAYING' || parsed.to === 'REPLAYING') return 'not-allowed';
      const current = await get(parsed.quarantineId);
      if (!current) return 'not-found';
      if (current.status !== parsed.from || (parsed.expectedVersion !== undefined && current.version !== parsed.expectedVersion)) return 'stale';
      if (!isTransitionAllowed(parsed.from, parsed.to, current.retryClass)) return 'not-allowed';
      // Unblocking requires explicit evidence that the blocker was corrected.
      if (parsed.from === 'BLOCKED' && parsed.to === 'RETRYABLE' && parsed.evidence === null) return 'not-allowed';
      const filter = { _id: parsed.quarantineId as never, realm, status: parsed.from, ...(parsed.expectedVersion === undefined ? {} : { version: parsed.expectedVersion }) };
      const result = await rows.updateOne(filter, [{ $set: { status: literal(parsed.to), updatedAt: '$$NOW', version: { $add: ['$version', 1] },
        audit: auditPush({ action: 'transition', outcome: parsed.outcome, reasonCode: null, evidence: parsed.evidence }) } }], { writeConcern, maxTimeMS: 3000 } as never);
      return result.modifiedCount === 1 ? 'transitioned' : 'stale';
    },
    async acquireLease(input: { quarantineId: string; expectedVersion: number; ownerId: string; acquiredAt: number }): Promise<LeaseAcquireResult> {
      const parsed = z.object({ quarantineId: idSchema, expectedVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1), ownerId: leaseOwner,
        acquiredAt: z.number().int().min(0).max(8.64e15) }).strict().parse(input);
      const token = parsed.expectedVersion + 1;
      // ONE conditional write: realm + id + RETRYABLE + exact version. No read-then-write.
      const result = await rows.updateOne({ _id: parsed.quarantineId as never, realm, status: 'RETRYABLE', version: parsed.expectedVersion }, [{ $set: {
        status: literal('REPLAYING'), version: literal(token), updatedAt: '$$NOW',
        lease: { ownerId: literal(parsed.ownerId), acquiredAt: literal(new Date(parsed.acquiredAt)), token: literal(token) },
        audit: auditPush({ action: 'transition', outcome: 'lease-acquired', reasonCode: null, evidence: null }) } }], { writeConcern, maxTimeMS: 3000 } as never);
      if (result.modifiedCount === 1) return Object.freeze({ result: 'acquired' as const, leaseToken: token });
      const current = await get(parsed.quarantineId);
      return Object.freeze({ result: !current ? 'not-found' as const : current.status === 'RETRYABLE' || current.status === 'REPLAYING' ? 'stale' as const : 'not-allowed' as const });
    },
    async settleReplay(input: { quarantineId: string; holder: ReplayHolder; to: 'RESOLVED' | 'RETRYABLE' | 'BLOCKED'; outcome: string; evidence: string | null; expectedVersion?: number },
      transaction?: unknown): Promise<TransitionResult> {
      const parsed = z.object({ quarantineId: idSchema, holder: holderSchema, to: z.enum(['RESOLVED', 'RETRYABLE', 'BLOCKED']), outcome: code, evidence: evidence.nullable(),
        expectedVersion: z.number().int().min(1).optional() }).strict().parse(input);
      if (parsed.holder.kind === 'unleased' && parsed.to === 'RETRYABLE') return 'not-allowed';
      const filter: Record<string, unknown> = { _id: parsed.quarantineId, realm, ...(parsed.expectedVersion === undefined ? {} : { version: parsed.expectedVersion }) };
      if (parsed.holder.kind === 'lease') Object.assign(filter, { status: 'REPLAYING', 'lease.ownerId': parsed.holder.ownerId, 'lease.token': parsed.holder.leaseToken });
      else filter.status = 'RETRYABLE';
      const update = [{ $set: { status: literal(parsed.to), updatedAt: '$$NOW', version: { $add: ['$version', 1] },
        audit: auditPush({ action: 'transition', outcome: parsed.outcome, reasonCode: null, evidence: parsed.evidence }) } }, { $unset: 'lease' }];
      // Inside a transaction the write concern belongs to the transaction (setting it per operation is an error).
      const options = transaction === undefined ? { writeConcern, maxTimeMS: 3000 } : { session: transaction as ClientSession, maxTimeMS: 3000 };
      const result = await rows.updateOne(filter as never, update, options as never);
      return result.modifiedCount === 1 ? 'transitioned' : 'stale';
    },
    async appendAudit(rawId: string, rawEntry: QuarantineAuditEntry) {
      const id = idSchema.parse(rawId), entry = auditSchema.parse(rawEntry);
      const result = await rows.updateOne({ _id: id as never, realm }, [{ $set: { updatedAt: '$$NOW', audit: auditPush(entry) } }], { writeConcern, maxTimeMS: 3000 } as never);
      return result.matchedCount === 1;
    },
    async summarize() {
      const rowsOut = await rows.aggregate([{ $match: { realm } }, { $group: { _id: { status: '$status', reasonCode: '$reasonCode', retryClass: '$retryClass' }, count: { $sum: 1 } } },
        { $sort: { '_id.status': 1, '_id.reasonCode': 1 } }], { maxTimeMS: 3000, readConcern: { level: 'majority' } } as never).toArray();
      return Object.freeze(rowsOut.map(r => Object.freeze(z.object({ status: statusSchema, reasonCode: code, retryClass: quarantineEntrySchema.shape.retryClass, count: z.number().int().min(0) })
        .parse({ ...(r._id as object), count: r.count }))));
    },
  }) as IngestionQuarantineStore;
}
