import { randomBytes } from 'node:crypto';
import { mongo, type Connection } from 'mongoose';
import { z } from 'zod';
import { catalogueRealmSchema } from '../auth/identity-catalogue.schemas.js';
import type { BrokerInboxReconciliationStore, InboxClaim, InboxStateCounts } from '../iot/inbox-reconciliation.contracts.js';
import type { TrustGateRealm } from '../iot/trust-gate.contracts.js';
import { brokerInboxCollection } from '../models/broker-inbox.models.js';
import { brokerInboxStateCollection } from '../models/broker-inbox-state.models.js';

// BE13-11C — Mongo store for the operational state of inbox records. The raw inbox collection is only READ here.
// - Every filter carries the store's realm.
// - Time comparisons (minimum age, claim lease) use the DATABASE clock ($$NOW), never the process clock.
// - claim/complete are compare-and-set with a fence (token + version): a stale holder cannot complete.
// - No delete, no TTL, no raw payload ever read (projections exclude it).
const inboxId = z.string().regex(/^ib_[0-9a-f]{32}$/);
const bound = z.number().int().min(1).max(500);
const ms = z.number().int().min(0).max(30 * 24 * 3600 * 1000);
const writeConcern = { w: 'majority' as const, j: true, wtimeoutMS: 5000 };
const readConcern = { level: 'majority' as const };
const OUTCOMES = new Set(['recovered-and-processed', 'already-processed', 'integrity-failed', 'blocked', 'admission-processed']);
const lit = (value: unknown) => ({ $literal: value });

export function createMongoBrokerInboxReconciliationStore(options: { connection: Connection; prefix: string; realm: TrustGateRealm }): BrokerInboxReconciliationStore {
  const db = options.connection.db;
  if (!db) throw new TypeError('Connected MongoDB database required');
  const realm = catalogueRealmSchema.parse(options.realm);
  const raw = db.collection(brokerInboxCollection(options.prefix));
  const state = db.collection(brokerInboxStateCollection(options.prefix));
  const stateName = brokerInboxStateCollection(options.prefix);
  const sameRealm = (value: unknown) => { if (catalogueRealmSchema.parse(value) !== realm) throw new Error('RECONCILIATION_REALM_MISMATCH'); };
  const rawExists = async (id: string) => (await raw.findOne({ _id: id as never, realm }, { projection: { _id: 1 }, readConcern, maxTimeMS: 5000 } as never)) !== null;

  async function markReceipted(request: { realm: TrustGateRealm; inboxId: string }) {
    sameRealm(request.realm); const id = inboxId.parse(request.inboxId);
    if (!(await rawExists(id))) throw new Error('RECONCILIATION_RAW_NOT_FOUND');
    // Insert-only: an existing state (claimed/completed) is never touched.
    await state.updateOne({ _id: id as never, realm }, { $setOnInsert: { status: 'receipted', version: new mongo.Int32(1) } }, { upsert: true, writeConcern, maxTimeMS: 5000 } as never);
  }

  async function completeFromReceipt(request: { realm: TrustGateRealm; inboxId: string }) {
    sameRealm(request.realm); const id = inboxId.parse(request.inboxId);
    const r = await state.updateOne({ _id: id as never, realm, status: 'receipted', version: 1 }, [{ $set: { status: 'completed', version: { $add: ['$version', 1] },
      completedAt: '$$NOW', outcome: lit('admission-processed') } }], { writeConcern, maxTimeMS: 5000 } as never);
    return r.modifiedCount === 1;
  }

  async function listCandidates(request: { realm: TrustGateRealm; minAgeMs: number; limit: number }) {
    sameRealm(request.realm); const minAge = ms.parse(request.minAgeMs), limit = bound.parse(request.limit);
    const rows = await raw.aggregate([
      { $match: { realm, $expr: { $lte: ['$rawPersistedAt', { $subtract: ['$$NOW', minAge] }] } } },
      { $sort: { rawPersistedAt: 1 } },
      { $lookup: { from: stateName, localField: '_id', foreignField: '_id', as: 's', pipeline: [{ $match: { realm } }, { $project: { _id: 1 } }] } },
      { $match: { s: { $size: 0 } } },
      { $limit: limit },
      { $project: { _id: 1, rawPersistedAt: 1 } }, // never the payload
    ], { readConcern, maxTimeMS: 10_000 } as never).toArray();
    return Object.freeze(rows.map(r => Object.freeze({ inboxId: inboxId.parse(r._id), rawPersistedAt: (r.rawPersistedAt as Date).getTime() })));
  }

  async function count(request: { realm: TrustGateRealm; limit: number }): Promise<InboxStateCounts> {
    sameRealm(request.realm); const limit = bound.parse(request.limit);
    const rows = await raw.aggregate([
      { $match: { realm } }, { $sort: { rawPersistedAt: 1 } }, { $limit: limit },
      { $lookup: { from: stateName, localField: '_id', foreignField: '_id', as: 's', pipeline: [{ $match: { realm } }, { $project: { status: 1 } }] } },
      { $group: { _id: { $ifNull: [{ $first: '$s.status' }, 'absent'] }, n: { $sum: 1 } } },
    ], { readConcern, maxTimeMS: 10_000 } as never).toArray();
    const c = { absent: 0, receipted: 0, claimed: 0, completed: 0 } as Record<string, number>;
    for (const r of rows) if (typeof r._id === 'string' && r._id in c) c[r._id] = Number(r.n);
    return Object.freeze(c) as unknown as InboxStateCounts;
  }

  async function claim(request: { realm: TrustGateRealm; inboxId: string; claimLeaseMs: number }): Promise<InboxClaim | null> {
    sameRealm(request.realm); const id = inboxId.parse(request.inboxId), lease = ms.parse(request.claimLeaseMs);
    if (!(await rawExists(id))) return null; // a state document only ever exists for a real raw record of THIS realm
    const token = randomBytes(16).toString('hex');
    try {
      // First claim: succeeds only when NO state document exists (the upsert's insert collides on _id otherwise).
      const r = await state.updateOne({ _id: id as never, realm, status: { $exists: false } }, [{ $set: { realm: lit(realm), status: lit('claimed'),
        version: lit(new mongo.Int32(1)), token: lit(token), claimedAt: '$$NOW' } }], { upsert: true, writeConcern, maxTimeMS: 5000 } as never);
      if (r.upsertedCount === 1) return Object.freeze({ inboxId: id, token, version: 1 });
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error; // exists: fall through to the takeover attempt
    }
    // Takeover: ONLY a claim whose lease already expired on the database clock; the version is bumped, so the old holder is fenced out.
    const t = await state.findOneAndUpdate({ _id: id as never, realm, status: 'claimed', $expr: { $lte: [{ $add: ['$claimedAt', lease] }, '$$NOW'] } },
      [{ $set: { version: { $add: ['$version', 1] }, token: lit(token), claimedAt: '$$NOW' } }], { returnDocument: 'after', writeConcern, maxTimeMS: 5000 } as never);
    // The driver answers the updated document itself (or null when the CAS filter matched nothing).
    const version = t !== null && typeof (t as { version?: unknown }).version === 'number' ? (t as unknown as { version: number }).version : null;
    return version === null ? null : Object.freeze({ inboxId: id, token, version });
  }

  async function complete(request: { realm: TrustGateRealm; claim: InboxClaim; outcome: string }) {
    sameRealm(request.realm); const c = z.object({ inboxId, token: z.string().regex(/^[0-9a-f]{32}$/), version: z.number().int().min(1) }).strict().parse(request.claim);
    if (!OUTCOMES.has(request.outcome)) throw new Error('RECONCILIATION_OUTCOME_INVALID');
    const r = await state.updateOne({ _id: c.inboxId as never, realm, status: 'claimed', token: c.token, version: c.version }, [{ $set: { status: lit('completed'),
      version: { $add: ['$version', 1] }, completedAt: '$$NOW', outcome: lit(request.outcome) } }], { writeConcern, maxTimeMS: 5000 } as never);
    return r.modifiedCount === 1;
  }

  async function getState(request: { realm: TrustGateRealm; inboxId: string }) {
    sameRealm(request.realm); const id = inboxId.parse(request.inboxId);
    const d = await state.findOne({ _id: id as never, realm }, { projection: { status: 1, version: 1, outcome: 1 }, readConcern, maxTimeMS: 5000 } as never) as
      { status?: unknown; version?: unknown; outcome?: unknown } | null;
    if (d === null) return null;
    if ((d.status !== 'receipted' && d.status !== 'claimed' && d.status !== 'completed') || typeof d.version !== 'number') throw new Error('RECONCILIATION_STATE_MALFORMED');
    return Object.freeze({ status: d.status, version: d.version, outcome: typeof d.outcome === 'string' ? d.outcome : null });
  }

  return Object.freeze({ markReceipted, completeFromReceipt, listCandidates, count, claim, complete, getState }) as unknown as BrokerInboxReconciliationStore;
}
