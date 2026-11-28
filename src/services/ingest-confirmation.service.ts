import { emitMetric } from '../iot/ingestion-observability.js';
import type { IngestionMetricsPort } from '../iot/ingestion-operations.contracts.js';
import {
  CONFIRMED_STATUSES, EVENT_ID_PATTERN, INGEST_CONFIRMATION_EVIDENCE_VERSION, PAYLOAD_SHA256_PATTERN, SOURCE_ID_PATTERN,
  type ConfirmationEvidencePort, type QuarantineEvidence, type ConfirmationScope, type EvidenceState, type IngestConfirmation, type IngestConfirmationService, type IngestConfirmationStatus,
} from '../iot/ingest-confirmation.contracts.js';

// BE13-11J — decides the confirmation status from durable evidence. Pure policy over an injected, read-only evidence port.
// Precedence: committed claim (processed / duplicate-confirmed) > quarantine (never a success) > durable inbox (received-durable)
// > any evidence source unavailable (pending) > nothing anywhere (not-found).

type Settled<T> = { readonly ok: true; readonly rows: readonly T[] } | { readonly ok: false };
// BE13-11Q: every evidence read is BOUNDED. With no primary (majority lost) a driver call can wait for server selection far longer than any publisher is willing to wait; a read that does not
// answer in time is an unavailable source => `pending` (fail-closed), never a long hang and never a confirmation.
export const DEFAULT_EVIDENCE_TIMEOUT_MS = 4000;
async function settle<T>(work: () => Promise<readonly T[]>, timeoutMs: number): Promise<Settled<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { const rows = await Promise.race([work(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('EVIDENCE_TIMEOUT')), timeoutMs); })]); return Array.isArray(rows) ? { ok: true, rows } : { ok: false }; }
  catch { return { ok: false }; } finally { if (timer) clearTimeout(timer); }
}

export function createIngestConfirmationService(options: { evidence: ConfirmationEvidencePort; clock?: () => number; metrics?: IngestionMetricsPort; evidenceTimeoutMs?: number }): IngestConfirmationService {
  const { evidence } = options; const timeoutMs = options.evidenceTimeoutMs ?? DEFAULT_EVIDENCE_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new TypeError('Invalid evidenceTimeoutMs');
  if (!evidence || typeof evidence.claims !== 'function' || typeof evidence.inbox !== 'function' || typeof evidence.quarantine !== 'function') throw new TypeError('Evidence port required');
  return {
    async confirm(scope: ConfirmationScope, eventId: string, payloadSha256: string): Promise<IngestConfirmation> {
      if (typeof eventId !== 'string' || !EVENT_ID_PATTERN.test(eventId)) throw new TypeError('Invalid eventId');
      if (typeof payloadSha256 !== 'string' || !PAYLOAD_SHA256_PATTERN.test(payloadSha256)) throw new TypeError('Invalid payloadSha256');
      if (!scope || typeof scope.sourceId !== 'string' || !SOURCE_ID_PATTERN.test(scope.sourceId) || typeof scope.realm !== 'string') throw new TypeError('Invalid scope');
      const [claims, inbox, quarantine] = await Promise.all([settle(() => evidence.claims(scope, eventId), timeoutMs), settle(() => evidence.inbox(scope, eventId), timeoutMs), settle(() => evidence.quarantine(scope, eventId, payloadSha256), timeoutMs)]);
      // Defence in depth: only rows that carry EXACTLY the caller's scope and the asked eventId count. A foreign or malformed row is ignored, never confirmed.
      const mine = <T extends { realm: string; eventId: string; sourceId: string | null }>(rows: readonly T[]) =>
        rows.filter(r => r.realm === scope.realm && r.sourceId === scope.sourceId && r.eventId === eventId);
      // Quarantine rows: owned by the caller's sourceId OR (rows written before a sourceId was known) by the caller's authenticated principal; about THIS event; and, when the row
      // recorded a hash, about THESE bytes (a conflict quarantine written for other content must not mask a processed event).
      const ownQuarantine = (r: QuarantineEvidence) => r.realm === scope.realm && (r.sourceId === scope.sourceId || (r.sourceId === null && typeof scope.principalReference === 'string' && r.principalReference === scope.principalReference))
        && (r.eventId === eventId || r.declaredEventId === eventId) && (r.payloadSha256 == null || r.payloadSha256 === payloadSha256);
      const validClaims = claims.ok ? mine(claims.rows) : [], validInbox = inbox.ok ? mine(inbox.rows) : [], validQuarantine = quarantine.ok ? quarantine.rows.filter(ownQuarantine) : [];
      const state = (s: Settled<unknown>, valid: readonly unknown[]): EvidenceState => !s.ok ? 'unavailable' : valid.length > 0 ? 'present' : 'absent';
      // BE13-11L: same eventId + same hash = legitimate retry/re-delivery; ANY other hash recorded for this (scope, eventId) = conflict (never a confirmation).
      const hashes = new Set(validInbox.map(i => i.payloadSha256));
      const payloadHash: IngestConfirmation['payloadHash'] = validInbox.length === 0 ? 'unverifiable' : hashes.size === 1 && hashes.has(payloadSha256) ? 'match' : 'mismatch';
      let status: IngestConfirmationStatus;
      if (payloadHash === 'mismatch') status = 'conflict';
      else if (validClaims.length > 0 && payloadHash === 'unverifiable') status = 'pending';       // a claim whose content cannot be tied to the asked bytes is not proof
      else if (validClaims.length > 0) status = validInbox.length >= 2 ? 'duplicate-confirmed' : 'processed';
      else if (validQuarantine.length > 0) status = 'quarantined';
      else if (validInbox.length > 0) status = 'received-durable';
      else if (!claims.ok || !inbox.ok || !quarantine.ok) status = 'pending';
      else status = 'not-found';
      // BE13-11P (best-effort, closed vocabulary): never an identifier as a label; an unavailable evidence source is visible BEFORE it becomes a pending storm.
      if (options.metrics) {
        await emitMetric(options.metrics, 'ingest_confirmation_total', { outcome: status });
        for (const [source, s] of [['claim', claims], ['inbox', inbox], ['quarantine', quarantine]] as const) if (!s.ok) await emitMetric(options.metrics, 'ingest_confirmation_evidence_unavailable_total', { outcome: ('evidence-' + source) as never });
      }
      const times = validClaims.length > 0 ? validClaims.map(c => c.committedAt) : validInbox.map(i => i.persistedAt);
      return Object.freeze({
        eventId, realm: scope.realm, status, confirmed: CONFIRMED_STATUSES.includes(status), evidenceVersion: INGEST_CONFIRMATION_EVIDENCE_VERSION,
        evidence: Object.freeze({ claim: state(claims, validClaims), inbox: state(inbox, validInbox), quarantine: state(quarantine, validQuarantine) }), payloadHash,
        deliveries: inbox.ok ? validInbox.length : null,
        durableAt: times.length > 0 ? Math.min(...times) : null,
      });
    },
  };
}
