import { createHash } from 'node:crypto';
import type { Connection } from 'mongoose';
import { z } from 'zod';
import { catalogueRealmSchema } from '../auth/identity-catalogue.schemas.js';
import type { AuditAppend, AuditRecord, IngestionAuditStore } from '../iot/ingestion-operations.contracts.js';
import type { TrustGateRealm } from '../iot/trust-gate.contracts.js';
import { auditCollections } from '../models/ingestion-audit.models.js';

// BE13-09 — Mongo append-only audit store. The ONLY write is `append`: there is
// no update and no delete method. Mongo by itself does not make documents
// immutable (an account with write privileges could still update them); WORM
// is NOT claimed. Order is (realm, stream, sequence), assigned by a counter in
// the SAME transaction as the insert: no gaps, no dependency on clocks.
const code = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/);
const safeRef = z.string().min(1).max(128).regex(/^[A-Za-z0-9:_./-]+$/);
const capability = z.enum(['QUARANTINE_VIEW', 'QUARANTINE_REPLAY', 'QUARANTINE_UNBLOCK', 'QUARANTINE_BLOCK', 'QUARANTINE_RESOLVE', 'QUARANTINE_DISCARD', 'AUDIT_VIEW', 'OPERATIONS_VIEW']);
const action = z.enum(['quarantine-created', 'quarantine-recurred', 'classification-changed', 'recovery-outcome', 'replay-requested', 'replay-denied', 'replay-started',
  'replay-result', 'transition-requested', 'transition-result', 'resolved', 'discarded', 'authorization-denied',
  'lease-acquired', 'lease-release-requested', 'lease-released-owner', 'lease-recovery-requested', 'lease-recovered-expired', 'lease-release-denied', 'stale-replay-blocked']);
const quarantineId = z.string().regex(/^q_[0-9a-f]{64}$/);
const evidence = z.object({ evidenceType: z.enum(['policy-approval', 'authority-restored', 'dependency-restored', 'data-verified', 'operator-decision']),
  reference: safeRef, verification: z.literal('DECLARED_UNVERIFIED') }).strict();
export const auditAppendSchema = z.object({ realm: catalogueRealmSchema, quarantineId: quarantineId.nullable(), eventId: z.string().min(1).max(256).nullable(),
  action, actorId: safeRef, actorCapabilities: z.array(capability).max(8).refine(a => new Set(a).size === a.length), outcome: code, reasonCode: code.nullable(),
  evidence: evidence.nullable() }).strict();
const storedSchema = auditAppendSchema.extend({ _id: z.string().regex(/^a_[0-9a-f]{64}$/), stream: z.string(), sequence: z.number().int().min(1),
  occurredAt: z.date().transform(d => d.getTime()) }).strict();

export function createMongoIngestionAuditStore(options: { connection: Connection; prefix: string; realm: TrustGateRealm }): IngestionAuditStore {
  const db = options.connection.db;
  if (!db) throw new TypeError('Connected MongoDB database required');
  const realm = catalogueRealmSchema.parse(options.realm);
  const names = auditCollections(options.prefix);
  const rows = db.collection(names.audit), sequences = db.collection(names.sequences);

  async function append(raw: unknown) {
    const entry = auditAppendSchema.parse(raw);
    if (entry.realm !== realm) throw new Error('AUDIT_REALM_MISMATCH');
    const stream = entry.quarantineId ?? 'realm';
    const session = await options.connection.startSession();
    try {
      let result: { realm: TrustGateRealm; auditId: string; sequence: number } | undefined;
      await session.withTransaction(async () => {
        result = undefined;
        const counter = await sequences.findOneAndUpdate({ _id: realm + ':' + stream as never }, { $inc: { sequence: 1 }, $setOnInsert: { realm, stream } },
          { upsert: true, returnDocument: 'after', session, maxTimeMS: 3000 });
        const sequence = z.number().int().min(1).parse(counter?.sequence);
        const auditId = 'a_' + createHash('sha256').update(JSON.stringify(['be13-09/audit', realm, stream, sequence]), 'utf8').digest('hex');
        const literal = (v: unknown) => ({ $literal: v });
        const created = await rows.updateOne({ _id: auditId as never }, [{ $set: { realm: literal(realm), stream: literal(stream), sequence: literal(sequence),
          quarantineId: literal(entry.quarantineId), eventId: literal(entry.eventId), action: literal(entry.action), actorId: literal(entry.actorId),
          actorCapabilities: literal(entry.actorCapabilities), outcome: literal(entry.outcome), reasonCode: literal(entry.reasonCode), evidence: literal(entry.evidence),
          occurredAt: '$$NOW' } }], { upsert: true, session, maxTimeMS: 3000 });
        if (created.upsertedCount !== 1) throw new Error('AUDIT_NOT_APPENDED');
        result = { realm, auditId, sequence };
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority', j: true, wtimeoutMS: 5000 }, maxCommitTimeMS: 3000, timeoutMS: 15000 });
      if (!result) throw new Error('AUDIT_NOT_APPENDED');
      return Object.freeze(result);
    } finally { await session.endSession(); }
  }

  async function listForQuarantine(rawId: unknown, rawLimit: unknown): Promise<readonly AuditRecord[]> {
    const id = quarantineId.parse(rawId), limit = z.number().int().min(1).max(500).parse(rawLimit);
    const docs = await rows.find({ realm, stream: id }, { maxTimeMS: 3000, readConcern: { level: 'majority' } } as never).sort({ sequence: 1 }).limit(limit).toArray();
    return Object.freeze(docs.map(d => { const { _id, ...rest } = storedSchema.parse(d); return Object.freeze({ ...rest, auditId: _id }) as AuditRecord; }));
  }

  async function ping() {
    try { return (await db!.command({ ping: 1 })).ok === 1; } catch { return false; }
  }

  return Object.freeze({ append, listForQuarantine, ping }) as IngestionAuditStore;
}
