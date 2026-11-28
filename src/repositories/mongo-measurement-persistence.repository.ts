import { createHash } from 'node:crypto';
import type { ClientSession, Connection } from 'mongoose';
import { z } from 'zod';
import { catalogueRealmSchema } from '../auth/identity-catalogue.schemas.js';
import type {
  IdempotencyKey,
  MeasurementPersistencePort,
  PersistenceLookup,
  PersistenceOutcome,
  PersistMeasurementInput,
} from '../iot/ingestion-composition.contracts.js';
import { compositionAttributionSchema, fingerprintHex, idempotencyKeySchema, measurementIdSchema } from '../iot/ingestion-composition.schemas.js';
import type { TrustGateRealm } from '../iot/trust-gate.contracts.js';
import { trustedMeasurementEventSchema } from '../measurements/schemas.js';
import { ingestionCollections } from '../models/ingestion-persistence.models.js';

// BE13-06 (C4) — persistMeasurementAtomically: idempotency claim + measurement
// insert inside ONE MongoDB transaction (snapshot read, majority/journaled
// commit). If the measurement write fails the claim is rolled back; if the
// claim cannot be created nothing is written. Requires a replica set.
// The guarantee is local to this store; it is not global exactly-once.

export type PersistenceStage = 'after-read' | 'after-fence' | 'after-claim' | 'after-measurement';
export interface PersistenceTestSeams {
  // TEST SEAM ONLY. Never set by the composition. Throwing aborts the transaction.
  readonly faultInjection?: (stage: PersistenceStage, attempt: number) => void | Promise<void>;
  readonly onAttempt?: (attempt: number) => void;
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
export function idempotencyDocumentId(key: IdempotencyKey): string {
  return sha256(JSON.stringify(['be13-06/v1', key.realm, key.sourceId, key.operation, key.eventId, key.field]));
}
export function measurementDocumentId(key: IdempotencyKey): string {
  return 'm_' + sha256('measurement:' + idempotencyDocumentId(key));
}

const claimDocumentSchema = z.object({ _id: fingerprintHex, realm: catalogueRealmSchema, sourceId: z.string(), operation: z.enum(['measurement', 'device-status']),
  eventId: z.string(), field: z.string(), fingerprint: fingerprintHex, state: z.literal('committed'), measurementId: measurementIdSchema,
  committedAt: z.date() }).strict();
const inputSchema = z.object({ key: idempotencyKeySchema, fingerprint: fingerprintHex, event: trustedMeasurementEventSchema,
  attribution: compositionAttributionSchema }).strict();

function isDuplicateKey(error: unknown): boolean {
  try { return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000; } catch { return false; }
}

export function createMongoMeasurementPersistence(options: { connection: Connection; prefix: string; realm: TrustGateRealm; testSeams?: PersistenceTestSeams }): MeasurementPersistencePort {
  const db = options.connection.db;
  if (!db) throw new TypeError('Connected MongoDB database required');
  const realm = catalogueRealmSchema.parse(options.realm);
  const names = ingestionCollections(options.prefix);
  const claims = db.collection(names.idempotency), measurements = db.collection(names.measurements);
  const seams = options.testSeams ?? {};

  // Reads the committed claim and checks it really belongs to this key (a hash
  // collision or a tampered document fails closed instead of matching).
  async function readClaim(key: IdempotencyKey, session?: ClientSession) {
    // BE13-11G (F-F7): the PRE-CHECK (no session) must only trust what a majority holds. A claim that exists on the primary alone (a commit whose
    // majority acknowledgement timed out) is not a fact: answering `duplicate` from it marks the event handled and the claim can later be rolled back.
    // Inside a transaction (session) the snapshot read is already consistent with the transaction's own majority-committed commit.
    const raw = await claims.findOne({ _id: idempotencyDocumentId(key) as never, realm: key.realm }, { session, ...(session === undefined ? { readConcern: { level: 'majority' } } : {}), maxTimeMS: 3000 } as never);
    if (raw === null) return null;
    const claim = claimDocumentSchema.parse(raw);
    if (claim.sourceId !== key.sourceId || claim.operation !== key.operation || claim.eventId !== key.eventId || claim.field !== key.field ||
      claim.measurementId !== measurementDocumentId(key)) throw new Error('INGESTION_CLAIM_IDENTITY_MISMATCH');
    return claim;
  }

  const classify = (claim: z.output<typeof claimDocumentSchema>, fingerprint: string): PersistenceOutcome =>
    claim.fingerprint === fingerprint ? { realm, status: 'duplicate', measurementId: claim.measurementId } : { realm, status: 'conflict' };

  async function lookup(input: unknown): Promise<PersistenceLookup> {
    const key = idempotencyKeySchema.parse(input);
    if (key.realm !== realm) throw new Error('INGESTION_REALM_MISMATCH');
    const claim = await readClaim(key);
    return claim ? { realm, status: 'present', fingerprint: claim.fingerprint, measurementId: claim.measurementId } : { realm, status: 'absent' };
  }

  async function persistAtomically(raw: unknown, rawOptions?: unknown): Promise<PersistenceOutcome> {
    const input: PersistMeasurementInput = inputSchema.parse(raw);
    // BE13-10B: optional fence, executed inside THIS transaction with THIS session.
    if (rawOptions !== undefined && (typeof rawOptions !== 'object' || rawOptions === null)) throw new TypeError('Invalid persistence options');
    const fence = (rawOptions as { fence?: unknown } | undefined)?.fence;
    if (fence !== undefined && typeof fence !== 'function') throw new TypeError('Invalid persistence fence');
    const { key, fingerprint } = input;
    if (key.realm !== realm || input.attribution.realm !== realm) throw new Error('INGESTION_REALM_MISMATCH');
    if (input.event.eventId !== key.eventId || input.event.sourceId !== key.sourceId) throw new Error('INGESTION_EVENT_KEY_MISMATCH');
    const claimId = idempotencyDocumentId(key), measurementId = measurementDocumentId(key);
    const session = await options.connection.startSession();
    let attempt = 0;
    try {
      let outcome: PersistenceOutcome | undefined;
      try {
        await session.withTransaction(async () => {
          attempt += 1; outcome = undefined; seams.onAttempt?.(attempt);
          // 1. Verify claim inside the snapshot.
          const existing = await readClaim(key, session);
          if (existing) { outcome = classify(existing, fingerprint); return; }
          await seams.faultInjection?.('after-read', attempt);
          // 1b. BE13-10B fence: the replay lease must still be held. Its CAS write joins this transaction, so the
          // measurement is committed only together with the lease being consumed; a concurrent recovery/discard on the
          // same quarantine document write-conflicts and exactly one side commits. Not held → abort, nothing written.
          if (fence !== undefined && (await (fence as (t: unknown) => Promise<unknown>)(session)) !== true) throw new Error('INGESTION_REPLAY_FENCE_STALE');
          await seams.faultInjection?.('after-fence', attempt);
          // 2. Create the claim (reversible until commit).
          const claimed = await claims.updateOne({ _id: claimId as never }, {
            $setOnInsert: { realm, sourceId: key.sourceId, operation: key.operation, eventId: key.eventId, field: key.field, fingerprint, state: 'committed', measurementId },
            $currentDate: { committedAt: true },
          }, { upsert: true, session, maxTimeMS: 3000 });
          if (claimed.upsertedCount !== 1) throw new Error('INGESTION_CLAIM_NOT_CREATED');
          await seams.faultInjection?.('after-claim', attempt);
          // 3. Insert the measurement bound to the claim.
          const written = await measurements.updateOne({ _id: measurementId as never }, {
            $setOnInsert: { realm, sourceId: key.sourceId, operation: key.operation, eventId: key.eventId, field: key.field, fingerprint,
              event: { ...input.event, device: { ...input.event.device }, metadata: { ...input.event.metadata } }, attribution: { ...input.attribution } },
            $currentDate: { storedAt: true },
          }, { upsert: true, session, maxTimeMS: 3000 });
          if (written.upsertedCount !== 1) throw new Error('INGESTION_MEASUREMENT_NOT_CREATED');
          await seams.faultInjection?.('after-measurement', attempt);
          outcome = { realm, status: 'persisted', measurementId };
          // 4. Commit happens when the callback resolves.
        }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority', j: true, wtimeoutMS: 3000 }, maxCommitTimeMS: 3000, timeoutMS: 15000 });
      } catch (error) {
        // A concurrent transaction committed the same key first: classify against it.
        if (!isDuplicateKey(error)) throw error;
        const winner = await readClaim(key);
        if (!winner) throw error;
        return Object.freeze(classify(winner, fingerprint));
      }
      if (!outcome) throw new Error('INGESTION_TRANSACTION_WITHOUT_OUTCOME');
      return Object.freeze(outcome);
    } finally { await session.endSession(); }
  }

  return Object.freeze({ lookup, persistAtomically, replayFencing: 'atomic' as const }) as MeasurementPersistencePort;
}
