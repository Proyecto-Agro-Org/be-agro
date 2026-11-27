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
const READ = { readConcern: { level: 'majority' }, maxTimeMS: 3000 } as never;

export function eventIdOfRawPayload(raw: unknown): string | null {
  try {
    const bytes = raw && typeof raw === 'object' && 'buffer' in raw ? (raw as { buffer: Uint8Array }).buffer : null;
    if (!bytes) return null;
    const id = (JSON.parse(Buffer.from(bytes).toString('utf8')) as { eventId?: unknown }).eventId;
    return typeof id === 'string' ? id : null;
  } catch { return null; }
}

export function createMongoIngestConfirmationEvidence(options: { connection: Connection; prefix: string; realm: TrustGateRealm }): ConfirmationEvidencePort {
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
      const rows = await inbox.find({ realm, sourceId: scope.sourceId }, { ...(READ as object), projection: { rawPayload: 1, rawPersistedAt: 1, sourceId: 1, realm: 1 } } as never).sort({ rawPersistedAt: -1 }).limit(INBOX_SCAN_LIMIT).toArray();
      return rows.filter(r => eventIdOfRawPayload(r.rawPayload) === eventId).map(r => ({ realm: r.realm as TrustGateRealm, sourceId: String(r.sourceId), eventId, persistedAt: ms(r.rawPersistedAt) }));
    },
    async quarantine(scope, eventId): Promise<readonly QuarantineEvidence[]> {
      sameRealm(scope.realm);
      const rows = await quarantine.find({ realm, sourceId: scope.sourceId, eventId }, READ).limit(16).toArray();
      return rows.map(r => ({ realm: r.realm as TrustGateRealm, sourceId: r.sourceId === null ? null : String(r.sourceId), eventId: String(r.eventId) }));
    },
  };
}
