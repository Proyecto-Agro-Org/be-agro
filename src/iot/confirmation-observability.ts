import { emitMetric } from './ingestion-observability.js';
import type { IngestionMetricsPort } from './ingestion-operations.contracts.js';
import { EVENT_ID_PATTERN, SOURCE_ID_PATTERN } from './ingest-confirmation.contracts.js';
import type { ConfirmationAuditEvent } from '../routes/ingest-confirmation.routes.js';

// BE13-11P — minimal pipeline observability for the reconciliation API and the publisher. Pure helpers, no I/O, nothing is configured in any environment.
//   * metrics: closed vocabularies only (`ingestion-observability`); an eventId/sourceId/hash is NEVER a label (unbounded cardinality + tenant leak);
//   * logs: an allowlist builder; whatever is not allowlisted is dropped, so a secret, a hash, a payload or a principal can never reach a log line;
//   * correlation: (sourceId, eventId) ties publish -> PUBACK -> delivery -> inbox -> processing -> confirmation across the existing audit/metric records.

/** Router observer -> metrics. Plug it as `onEvent` of createIngestConfirmationRouter. Includes `rate-limited` (rate-limit denied). Cross-tenant denial is NOT observable by design. */
export function confirmationRequestObserver(metrics: IngestionMetricsPort): (event: ConfirmationAuditEvent) => void {
  return event => { void emitMetric(metrics, 'ingest_confirmation_request_total', { outcome: event.outcome }); };
}

const SAFE_WORD = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,63}$/;
export type LogRecord = { readonly ts: number; readonly component: 'publisher' | 'confirmation-api' | 'boundary'; readonly event: string; readonly eventId?: string; readonly sourceId?: string;
  readonly from?: string; readonly to?: string; readonly lane?: 'fast' | 'slow'; readonly attempt?: number; readonly status?: string; readonly outcome?: string };
/** Structured log line from an allowlist. Unknown keys, malformed identifiers and non-finite numbers are dropped; values never carry hashes or payloads. */
export function structuredLogLine(input: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  const word = (k: string, re = SAFE_WORD) => { const v = input[k]; if (typeof v === 'string' && re.test(v)) out[k] = v; };
  if (typeof input.ts === 'number' && Number.isFinite(input.ts)) out.ts = input.ts;
  word('component'); word('event'); word('eventId', EVENT_ID_PATTERN); word('sourceId', SOURCE_ID_PATTERN); word('from'); word('to'); word('status'); word('outcome');
  if (input.lane === 'fast' || input.lane === 'slow') out.lane = input.lane;
  if (typeof input.attempt === 'number' && Number.isInteger(input.attempt) && input.attempt >= 0 && input.attempt < 1_000_000) out.attempt = input.attempt;
  return JSON.stringify(out);
}

export const PIPELINE_STAGES = ['published', 'broker-accepted', 'delivered', 'inbox-persisted', 'processed', 'confirmed'] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number] | 'retry' | 'unconfirmed' | 'quarantined' | 'conflict';
/** Groups records by (sourceId, eventId) and orders them by ts: the trail of one event across publisher, boundary and confirmation. */
export function correlate(records: readonly { ts: number; eventId?: string; sourceId?: string; stage: PipelineStage }[]) {
  const trails = new Map<string, { sourceId: string; eventId: string; stages: PipelineStage[] }>();
  for (const r of [...records].sort((a, b) => a.ts - b.ts)) {
    if (!r.eventId || !r.sourceId) continue; const key = r.sourceId + '\u0000' + r.eventId;
    const t = trails.get(key) ?? { sourceId: r.sourceId, eventId: r.eventId, stages: [] }; t.stages.push(r.stage); trails.set(key, t);
  }
  return [...trails.values()];
}

/** CANDIDATE thresholds only (BE13-11P). Nothing here is configured anywhere; they need human approval together with the retry policy. */
export const CANDIDATE_ALERT_THRESHOLDS = Object.freeze({ configured: false as const, approved: false as const, candidates: Object.freeze([
  Object.freeze({ metric: 'publisher_outbox_oldest_pending_age_ms', condition: '> fast lane maxElapsed (proposed 10 min)', severity: 'WARNING' }),
  Object.freeze({ metric: 'publisher_unconfirmed_total', condition: 'any increase', severity: 'WARNING' }),
  Object.freeze({ metric: 'publisher_retry_exhausted_total', condition: 'any increase (UNCONFIRMED_EXPLICIT)', severity: 'CRITICAL' }),
  Object.freeze({ metric: 'publisher_outbox_depth', condition: '> 80 % of outbox capacity', severity: 'WARNING' }),
  Object.freeze({ metric: 'ingest_confirmation_request_total{outcome=rate-limited}', condition: 'sustained > 1 % of requests', severity: 'WARNING' }),
  Object.freeze({ metric: 'ingest_confirmation_total{outcome=conflict}', condition: 'any increase (publisher reused an eventId)', severity: 'WARNING' }),
  Object.freeze({ metric: 'ingest_confirmation_evidence_unavailable_total', condition: 'any sustained increase (pending storm)', severity: 'CRITICAL' }),
]) });
