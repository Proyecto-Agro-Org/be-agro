import { createHash } from 'node:crypto';
import type { Connection } from 'mongoose';
import { z } from 'zod';
import { catalogueRealmSchema } from '../auth/identity-catalogue.schemas.js';
import { initialQuarantineStatus, isTransitionAllowed } from '../iot/ingestion-failure-classification.js';
import type {
  IngestionQuarantineStore,
  QuarantineAuditEntry,
  QuarantineEntry,
  QuarantineRecord,
  QuarantineStatus,
  TransitionResult,
} from '../iot/ingestion-recovery.contracts.js';
import type { TrustGateRealm } from '../iot/trust-gate.contracts.js';
import { quarantineCollection } from '../models/ingestion-quarantine.models.js';

// BE13-08 — Mongo quarantine store. Realm is part of every filter AND of the
// quarantineId derivation. Dedupe: one document per (realm, stage, sourceId,
// operation, eventId, field, reasonCode[, documentDigest when no eventId]);
// repetitions increment attemptCount and append a bounded audit entry.

const code = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/);
const text = z.string().min(1).max(256).refine(v => !/[\p{Cc}]/u.test(v));
const hex = z.string().regex(/^[0-9a-f]{64}$/);
const evidence = z.string().min(1).max(256).regex(/^[A-Za-z0-9:_./-]+$/);
export const quarantineEntrySchema = z.object({
  realm: catalogueRealmSchema,
  stage: z.enum(['mapper', 'trust-gate', 'builder', 'be12', 'composition', 'persistence', 'recovery', 'retry']),
  sourceId: text.nullable(), operation: z.enum(['measurement', 'device-status']).nullable(), eventId: text.nullable(), field: text.nullable(),
  device: z.object({ kind: z.enum(['mqtt-clientid', 'device-id']), value: text }).strict().nullable(),
  reasonCode: code, cause: code.nullable(),
  retryClass: z.enum(['transient', 'ambiguous-commit', 'validation', 'security', 'conflict', 'policy-blocked', 'consistency', 'unknown']),
  fingerprint: hex.nullable(), documentDigest: hex.nullable(),
}).strict().refine(e => e.eventId !== null || e.documentDigest !== null, 'eventId or documentDigest required for dedupe');
const auditSchema = z.object({ action: z.enum(['recorded', 'transition', 'replay']), outcome: code, reasonCode: code.nullable(), evidence: evidence.nullable() }).strict();
const statusSchema = z.enum(['OPEN', 'RETRYABLE', 'REPLAYING', 'BLOCKED', 'RESOLVED', 'DISCARDED']);
const idSchema = z.string().regex(/^q_[0-9a-f]{64}$/);
const date = z.date().transform(d => d.getTime());
const storedSchema = z.object({ _id: idSchema, realm: catalogueRealmSchema, stage: quarantineEntrySchema.shape.stage,
  sourceId: text.nullable(), operation: z.enum(['measurement', 'device-status']).nullable(), eventId: text.nullable(), field: text.nullable(),
  device: z.object({ kind: z.enum(['mqtt-clientid', 'device-id']), value: text }).strict().nullable(), reasonCode: code, cause: code.nullable(),
  retryClass: quarantineEntrySchema.shape.retryClass, fingerprint: hex.nullable(), documentDigest: hex.nullable(), status: statusSchema,
  version: z.number().int().min(1), attemptCount: z.number().int().min(1), firstSeenAt: date, lastSeenAt: date, createdAt: date, updatedAt: date,
  audit: z.array(z.object({ action: z.enum(['recorded', 'transition', 'replay']), at: date, outcome: code, reasonCode: code.nullable(), evidence: evidence.nullable() }).strict()).max(100),
}).strict();

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
    const { _id, createdAt: _c, updatedAt: _u, ...doc } = storedSchema.parse(raw);
    return Object.freeze({ ...doc, quarantineId: _id, audit: Object.freeze(doc.audit.map(a => Object.freeze(a))) });
  }

  return Object.freeze({
    async record(rawEntry: unknown) {
      const entry = quarantineEntrySchema.parse(rawEntry);
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
