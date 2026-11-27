// BE13-11P — LOCAL_TEST_ONLY publisher observability over the 11N outbox. Closed metric names, no identifier as a label. Never imported by app code.
import type { OutboxEntry, OutboxStatus } from '../be13-11n/publisher-outbox.js';

export type PublisherMetricName = 'publisher_event_published_total' | 'publisher_broker_accepted_total' | 'publisher_retry_total' | 'publisher_unconfirmed_total' | 'publisher_retry_exhausted_total' | 'publisher_terminal_total';
export interface PublisherMetricsSink { counter(name: PublisherMetricName, labels?: Record<string, string>): void; gauge(name: 'publisher_outbox_depth' | 'publisher_outbox_oldest_pending_age_ms', value: number): void; observe(name: 'publisher_reconciliation_latency_ms', value: number): void }
const TERMINAL: ReadonlySet<string> = new Set(['CONFIRMED', 'QUARANTINED', 'CONFLICT', 'UNCONFIRMED_EXPLICIT']);

/** `onTransition` of the outbox publisher -> counters. States are a closed vocabulary; the eventId only ever goes to logs, never to a metric. */
export function outboxTransitionMetrics(sink: PublisherMetricsSink) {
  return (t: { eventId: string; from: string; to: string; attempt: number; lane: 'fast' | 'slow'; confirmation?: string | null }) => {
    if (t.from === 'needs-publish' && t.to === 'awaiting-confirm') {
      sink.counter('publisher_event_published_total'); if (t.confirmation === 'puback') sink.counter('publisher_broker_accepted_total'); if (t.attempt > 1) sink.counter('publisher_retry_total', { lane: t.lane });
    } else if (t.from === 'fast' && t.to === 'slow') sink.counter('publisher_unconfirmed_total');
    else if (TERMINAL.has(t.to)) { sink.counter('publisher_terminal_total', { status: t.to }); if (t.to === 'UNCONFIRMED_EXPLICIT') sink.counter('publisher_retry_exhausted_total'); }
  };
}
/** Gauges + the reconciliation latency of every finished CONFIRMED entry. */
export function sampleOutbox(sink: PublisherMetricsSink, entries: readonly OutboxEntry[], now: number) {
  const pending = entries.filter(e => e.status === 'PENDING');
  sink.gauge('publisher_outbox_depth', pending.length); sink.gauge('publisher_outbox_oldest_pending_age_ms', pending.length ? Math.max(...pending.map(e => now - e.createdAt)) : 0);
  for (const e of entries) if (e.status === ('CONFIRMED' satisfies OutboxStatus) && e.finishedAt !== null) sink.observe('publisher_reconciliation_latency_ms', e.finishedAt - e.createdAt);
}
