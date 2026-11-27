import type { Connection } from 'mongoose';
import { catalogueRealmSchema } from '../auth/identity-catalogue.schemas.js';
import type { ClaimEvidence, ConfirmationEvidencePort, InboxEvidence, QuarantineEvidence } from '../iot/ingest-confirmation.contracts.js';
import type { TrustGateRealm } from '../iot/trust-gate.contracts.js';
import { brokerInboxCollection } from '../models/broker-inbox.models.js';
import { ingestionCollections } from '../models/ingestion-persistence.models.js';
import { quarantineCollection } from '../models/ingestion-quarantine.models.js';

// BE13-11J — READ-ONLY evidence lookups for the publisher-side confirmation. Every filter carries the AUTHORIZED realm and sourceId; every read
// uses readConcern majority (a claim/record that only the primary holds is not a fact). No write, no index change, no schema change.
//
// Known limit (documented, not hidden): the Durable Inbox record has no `eventId` column (the raw bytes are kept untouched), so the inbox lookup
// is a BOUNDED scan of the caller's most recent records, parsing the eventId out of the raw payload. A production-grade lookup needs an indexed
// eventId on the inbox record: that is an open human decision, not made here. A miss beyond the window is `absent` => `not-found`/retry, never success.
export const INBOX_SCAN_LIMIT = 5000;
export const INBOX_DIRECT_LIMIT = 64;
const READ = { readConcern: { level: 'majority' }, maxTimeMS: 3000 } as never;

export function eventIdOfRawPayload(raw: unknown): string | null {
  try {
    const bytes = raw && typeof raw === 'object' && 'buffer' in raw ? (raw as { buffer: Uint8Array }).buffer : null;
    if (!bytes) return null;
    const id = (JSON.parse(Buffer.from(bytes).toString('utf8')) as { eventId?: unknown }).eventId;
    return typeof id === 'string' ? id : null;
  } catch { return null; }
}

export function createMongoIngestConfirmationEvidence(options: { connection: Connection; prefix: string; realm: TrustGateRealm; legacyScan?: boolean }): ConfirmationEvidencePort {
  // `legacyScan` (default true): records written BEFORE 11L have no eventId; they are found by the bounded scan below. Turn it off once the migration has run everywhere.
  const legacyScan = options.legacyScan !== false;
  const db = options.connection.db;
  if (!db) throw new TypeError('Connected MongoDB database required');
  const realm = catalogueRealmSchema.parse(options.realm);
  const names = ingestionCollections(options.prefix);
  const claims = db.collection(names.idempotency), inbox = db.collection(brokerInboxCollection(options.prefix)), quarantine = db.collection(quarantineCollection(options.prefix));
  const sameRealm = (scopeRealm: string) => { if (scopeRealm !== realm) throw new Error('INGEST_CONFIRMATION_REALM_MISMATCH'); };
  const ms = (d: unknown) => d instanceof Date ? d.getTime() : 0;
  return {
    async claims(scope, eventId): Promise<readonly ClaimEvidence[]> {
      sameRealm(scope.realm);
      const rows = await claims.find({ realm, sourceId: scope.sourceId, eventId, operation: { $in: ['measurement', 'device-status'] }, state: 'committed' }, READ).limit(64).toArray();
      return rows.map(r => ({ realm: r.realm as TrustGateRealm, sourceId: String(r.sourceId), eventId: String(r.eventId), committedAt: ms(r.committedAt) }));
    },
    async inbox(scope, eventId): Promise<readonly InboxEvidence[]> {
      sameRealm(scope.realm);
      // 1. Direct, indexed lookup (inbox_realm_source_event): records written by 11L+ carry their eventId.
      const direct = await inbox.find({ realm, sourceId: scope.sourceId, eventId }, { ...(READ as object), projection: { rawPersistedAt: 1, rawPayloadSha256: 1, sourceId: 1, realm: 1, eventId: 1 } } as never).sort({ rawPersistedAt: -1 }).limit(INBOX_DIRECT_LIMIT).toArray();
      const out: InboxEvidence[] = direct.map(r => ({ realm: r.realm as TrustGateRealm, sourceId: String(r.sourceId), eventId: String(r.eventId), persistedAt: ms(r.rawPersistedAt), payloadSha256: String(r.rawPayloadSha256) }));
      // 2. LEGACY fallback: only records WITHOUT an eventId (missing or null), bounded; the eventId is parsed out of the immutable raw bytes.
      if (legacyScan) {
        const legacy = await inbox.find({ realm, sourceId: scope.sourceId, eventId: null }, { ...(READ as object), projection: { rawPayload: 1, rawPersistedAt: 1, rawPayloadSha256: 1, sourceId: 1, realm: 1 } } as never).sort({ rawPersistedAt: -1 }).limit(INBOX_SCAN_LIMIT).toArray();
        for (const r of legacy) if (eventIdOfRawPayload(r.rawPayload) === eventId) out.push({ realm: r.realm as TrustGateRealm, sourceId: String(r.sourceId), eventId, persistedAt: ms(r.rawPersistedAt), payloadSha256: String(r.rawPayloadSha256) });
      }
      return out;
    },
    async quarantine(scope, eventId): Promise<readonly QuarantineEvidence[]> {
      sameRealm(scope.realm);
      const shape = (r: Record<string, unknown>): QuarantineEvidence => ({ realm: r.realm as TrustGateRealm, sourceId: r.sourceId == null ? null : String(r.sourceId), eventId: r.eventId == null ? null : String(r.eventId),
        principalReference: r.principalReference == null ? null : String(r.principalReference), declaredEventId: r.declaredEventId == null ? null : String(r.declaredEventId), payloadSha256: r.payloadSha256 == null ? null : String(r.payloadSha256) });
      const out = (await quarantine.find({ realm, sourceId: scope.sourceId, eventId }, READ).limit(16).toArray()).map(shape);
      // BE13-11M: rows written before a sourceId was known are reachable ONLY through the caller's authenticated principal (index quarantine_realm_principal_event).
      if (typeof scope.principalReference === 'string') out.push(...(await quarantine.find({ realm, principalReference: scope.principalReference, declaredEventId: eventId }, READ).limit(16).toArray()).map(shape));
      return out;
    },
  };
}
