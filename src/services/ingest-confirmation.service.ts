import {
  CONFIRMED_STATUSES, EVENT_ID_PATTERN, INGEST_CONFIRMATION_EVIDENCE_VERSION, SOURCE_ID_PATTERN,
  type ConfirmationEvidencePort, type ConfirmationScope, type EvidenceState, type IngestConfirmation, type IngestConfirmationService, type IngestConfirmationStatus,
} from '../iot/ingest-confirmation.contracts.js';

// BE13-11J — decides the confirmation status from durable evidence. Pure policy over an injected, read-only evidence port.
// Precedence: committed claim (processed / duplicate-confirmed) > quarantine (never a success) > durable inbox (received-durable)
// > any evidence source unavailable (pending) > nothing anywhere (not-found).

type Settled<T> = { readonly ok: true; readonly rows: readonly T[] } | { readonly ok: false };
async function settle<T>(work: () => Promise<readonly T[]>): Promise<Settled<T>> {
  try { const rows = await work(); return Array.isArray(rows) ? { ok: true, rows } : { ok: false }; } catch { return { ok: false }; }
}

export function createIngestConfirmationService(options: { evidence: ConfirmationEvidencePort; clock?: () => number }): IngestConfirmationService {
  const { evidence } = options;
  if (!evidence || typeof evidence.claims !== 'function' || typeof evidence.inbox !== 'function' || typeof evidence.quarantine !== 'function') throw new TypeError('Evidence port required');
  return {
    async confirm(scope: ConfirmationScope, eventId: string): Promise<IngestConfirmation> {
      if (typeof eventId !== 'string' || !EVENT_ID_PATTERN.test(eventId)) throw new TypeError('Invalid eventId');
      if (!scope || typeof scope.sourceId !== 'string' || !SOURCE_ID_PATTERN.test(scope.sourceId) || typeof scope.realm !== 'string') throw new TypeError('Invalid scope');
      const [claims, inbox, quarantine] = await Promise.all([settle(() => evidence.claims(scope, eventId)), settle(() => evidence.inbox(scope, eventId)), settle(() => evidence.quarantine(scope, eventId))]);
      // Defence in depth: only rows that carry EXACTLY the caller's scope and the asked eventId count. A foreign or malformed row is ignored, never confirmed.
      const mine = <T extends { realm: string; eventId: string; sourceId: string | null }>(rows: readonly T[]) =>
        rows.filter(r => r.realm === scope.realm && r.sourceId === scope.sourceId && r.eventId === eventId);
      const validClaims = claims.ok ? mine(claims.rows) : [], validInbox = inbox.ok ? mine(inbox.rows) : [], validQuarantine = quarantine.ok ? mine(quarantine.rows) : [];
      const state = (s: Settled<unknown>, valid: readonly unknown[]): EvidenceState => !s.ok ? 'unavailable' : valid.length > 0 ? 'present' : 'absent';
      let status: IngestConfirmationStatus;
      if (validClaims.length > 0) status = validInbox.length >= 2 ? 'duplicate-confirmed' : 'processed';
      else if (validQuarantine.length > 0) status = 'quarantined';
      else if (validInbox.length > 0) status = 'received-durable';
      else if (!claims.ok || !inbox.ok || !quarantine.ok) status = 'pending';
      else status = 'not-found';
      const times = validClaims.length > 0 ? validClaims.map(c => c.committedAt) : validInbox.map(i => i.persistedAt);
      return Object.freeze({
        eventId, realm: scope.realm, status, confirmed: CONFIRMED_STATUSES.includes(status), evidenceVersion: INGEST_CONFIRMATION_EVIDENCE_VERSION,
        evidence: Object.freeze({ claim: state(claims, validClaims), inbox: state(inbox, validInbox), quarantine: state(quarantine, validQuarantine) }),
        deliveries: inbox.ok ? validInbox.length : null,
        durableAt: times.length > 0 ? Math.min(...times) : null,
      });
    },
  };
}
