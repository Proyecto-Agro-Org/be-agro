import type { Connection } from 'mongoose';
import { z } from 'zod';
import { catalogueRealmSchema } from '../auth/identity-catalogue.schemas.js';
import type { IdempotencyKey } from '../iot/ingestion-composition.contracts.js';
import { compositionAttributionSchema, fingerprintHex, idempotencyKeySchema, measurementIdSchema } from '../iot/ingestion-composition.schemas.js';
import type { PersistenceRecoveryPort, RecoveryInconsistency, RecoveryReport } from '../iot/ingestion-recovery.contracts.js';
import type { TrustGateRealm } from '../iot/trust-gate.contracts.js';
import { trustedMeasurementEventSchema } from '../measurements/schemas.js';
import { ingestionCollections } from '../models/ingestion-persistence.models.js';
import { idempotencyDocumentId, measurementDocumentId } from './mongo-measurement-persistence.repository.js';

// BE13-08 — read-only persistence recovery (R1). After an ambiguous outcome it
// determines, from MAJORITY-committed state only, whether the logical key is
// committed (claim + measurement coherent), not committed (neither exists) or
// inconsistent (partial or contradictory). It never repairs and never deletes.
const claimSchema = z.object({ _id: fingerprintHex, realm: catalogueRealmSchema, sourceId: z.string(), operation: z.enum(['measurement', 'device-status']),
  eventId: z.string(), field: z.string(), fingerprint: fingerprintHex, state: z.literal('committed'), measurementId: measurementIdSchema, committedAt: z.date() }).strict();
const measurementSchema = z.object({ _id: measurementIdSchema, realm: catalogueRealmSchema, sourceId: z.string(), operation: z.enum(['measurement', 'device-status']),
  eventId: z.string(), field: z.string(), fingerprint: fingerprintHex, event: trustedMeasurementEventSchema, attribution: compositionAttributionSchema, storedAt: z.date() }).strict();

export function createMongoPersistenceRecovery(options: { connection: Connection; prefix: string; realm: TrustGateRealm }): PersistenceRecoveryPort {
  const db = options.connection.db;
  if (!db) throw new TypeError('Connected MongoDB database required');
  const realm = catalogueRealmSchema.parse(options.realm);
  const names = ingestionCollections(options.prefix);
  const claims = db.collection(names.idempotency), measurements = db.collection(names.measurements);
  const read = { maxTimeMS: 3000, readConcern: { level: 'majority' }, readPreference: 'primary' } as never;

  async function inspect(raw: unknown): Promise<RecoveryReport> {
    const key: IdempotencyKey = idempotencyKeySchema.parse(raw);
    if (key.realm !== realm) throw new Error('RECOVERY_REALM_MISMATCH');
    const inconsistent = (inconsistency: RecoveryInconsistency): RecoveryReport => Object.freeze({ realm, state: 'inconsistent', inconsistency });
    const natural = { realm, sourceId: key.sourceId, operation: key.operation, eventId: key.eventId, field: key.field };
    const claimId = idempotencyDocumentId(key), measurementId = measurementDocumentId(key);
    // By natural key AND by derived id: a document under an unexpected id is itself evidence of inconsistency.
    const [claimRows, measurementRows, claimById, measurementById] = await Promise.all([
      claims.find(natural, read).limit(2).toArray(), measurements.find(natural, read).limit(2).toArray(),
      claims.findOne({ _id: claimId as never, realm }, read), measurements.findOne({ _id: measurementId as never, realm }, read),
    ]);
    if (claimRows.length > 1 || measurementRows.length > 1) return inconsistent('unexpected-identity');
    const claimRaw = claimRows[0] ?? null, measurementRaw = measurementRows[0] ?? null;
    if ((claimById && (!claimRaw || claimById._id !== claimRaw._id)) || (measurementById && (!measurementRaw || measurementById._id !== measurementRaw._id)))
      return inconsistent('unexpected-identity');
    if (!claimRaw && !measurementRaw) return Object.freeze({ realm, state: 'not-committed' });
    let claim: z.output<typeof claimSchema> | null = null, measurement: z.output<typeof measurementSchema> | null = null;
    if (claimRaw) { const p = claimSchema.safeParse(claimRaw); if (!p.success) return inconsistent('malformed-claim'); claim = p.data; }
    if (measurementRaw) { const p = measurementSchema.safeParse(measurementRaw); if (!p.success) return inconsistent('malformed-measurement'); measurement = p.data; }
    if (claim && !measurement) return inconsistent('orphan-claim');
    if (!claim && measurement) return inconsistent('orphan-measurement');
    if (!claim || !measurement) return inconsistent('unexpected-identity');
    if (claim._id !== claimId || measurement._id !== measurementId || claim.measurementId !== measurement._id) return inconsistent('claim-measurement-mismatch');
    if (claim.fingerprint !== measurement.fingerprint) return inconsistent('fingerprint-mismatch');
    if (measurement.event.eventId !== key.eventId || measurement.event.sourceId !== key.sourceId || measurement.attribution.realm !== realm) return inconsistent('unexpected-identity');
    return Object.freeze({ realm, state: 'committed', measurementId: measurement._id, fingerprint: claim.fingerprint });
  }

  return Object.freeze({ inspect }) as PersistenceRecoveryPort;
}
