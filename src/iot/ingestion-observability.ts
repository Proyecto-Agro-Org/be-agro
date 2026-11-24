import { runBounded } from '../services/authority-call.js';
import { isKnownReasonCode } from './ingestion-failure-classification.js';
import type { AlertEvent, IngestionAlertPort, IngestionMetricsPort, MetricLabels, MetricName } from './ingestion-operations.contracts.js';

// BE13-09 — observability helpers. Metrics and alerts are BEST-EFFORT: a failing,
// slow or hostile adapter can never change an ingestion or operations result.
// Labels are mapped onto closed vocabularies so no identifier (eventId, clientId,
// sensorId, deviceId, quarantineId, sourceId, realm) can ever become a label value.
const METRICS: ReadonlySet<string> = new Set(['ingestion_total', 'ingestion_accepted_total', 'ingestion_duplicate_total', 'ingestion_quarantined_total',
  'retry_attempt_total', 'recovery_outcome_total', 'quarantine_transition_total', 'replay_total', 'authorization_denied_total',
  'broker_delivery_total', 'provenance_result_total', 'mqtt_boundary_rejected_total',
  'broker_inbox_persist_total', 'broker_inbox_recovery_total', 'broker_inbox_integrity_failure_total',
  'broker_inbox_reconciliation_total', 'broker_inbox_orphan_candidate_total']);
const STAGES: ReadonlySet<string> = new Set(['mapper', 'trust-gate', 'builder', 'be12', 'composition', 'persistence', 'recovery', 'retry', 'operations', 'boundary']);
const CLASSES: ReadonlySet<string> = new Set(['transient', 'ambiguous-commit', 'validation', 'security', 'conflict', 'policy-blocked', 'consistency', 'unknown']);
const OUTCOMES: ReadonlySet<string> = new Set(['accepted', 'duplicate', 'recovered-committed', 'quarantined', 'uncertain', 'committed', 'not-committed', 'inconsistent',
  'done', 'denied', 'stale-version', 'transition-not-allowed', 'replayed', 'replay-rejected', 'retry', 'stop', 'unauthenticated', 'forbidden', 'realm-out-of-scope',
  'audit-unavailable', 'evidence-required', 'evidence-type-not-accepted', 'resolve-not-verified', 'quarantine-not-found', 'invalid-request',
  'RETRYABLE', 'REPLAYING', 'BLOCKED', 'RESOLVED', 'DISCARDED', 'OPEN',
  'ingested', 'rejected', 'verified', 'unverified', 'unavailable', 'persisted', 'processed', 'failed',
  'recovered-and-processed', 'already-processed', 'integrity-failed', 'blocked', 'stale-reconciliation', 'candidate']);
const ALERTS: ReadonlySet<string> = new Set(['QUARANTINE_BACKLOG_HIGH', 'RETRY_EXHAUSTED', 'PERSISTENCE_INCONSISTENT', 'AUTHORIZATION_DENIED_SPIKE',
  'RECOVERY_INCONSISTENT', 'REALM_ISOLATION_VIOLATION', 'AUDIT_RESULT_MISSING',
  'PROVENANCE_REJECTION_SPIKE', 'BROKER_VERIFIER_UNAVAILABLE', 'TECHNICAL_IDENTITY_MISMATCH',
  'BROKER_INBOX_PERSISTENCE_UNAVAILABLE', 'BROKER_INBOX_INTEGRITY_FAILURE', 'BROKER_INBOX_RECOVERY_FAILURE',
  'BROKER_INBOX_ORPHAN_DETECTED', 'BROKER_INBOX_RECONCILIATION_FAILED']);
const SEVERITIES: ReadonlySet<string> = new Set(['INFO', 'WARNING', 'CRITICAL']);
const OBSERVABILITY_TIMEOUT_MS = 1_000;

export function sanitizeMetricLabels(input: unknown): MetricLabels {
  const labels = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const pick = (value: unknown, allowed: (v: unknown) => boolean) => (value === undefined ? undefined : allowed(value) ? String(value) : 'other');
  const out: Record<string, string> = {};
  const stage = pick(labels.stage, v => typeof v === 'string' && STAGES.has(v));
  const reasonCode = pick(labels.reasonCode, isKnownReasonCode);
  const retryClass = pick(labels.retryClass, v => typeof v === 'string' && CLASSES.has(v));
  const outcome = pick(labels.outcome, v => typeof v === 'string' && OUTCOMES.has(v));
  if (stage) out.stage = stage; if (reasonCode) out.reasonCode = reasonCode; if (retryClass) out.retryClass = retryClass; if (outcome) out.outcome = outcome;
  return Object.freeze(out) as MetricLabels;
}

export async function emitMetric(port: IngestionMetricsPort, name: MetricName, labels: MetricLabels): Promise<void> {
  if (!METRICS.has(name)) return;
  try { await runBounded(() => port.increment(name, sanitizeMetricLabels(labels)), OBSERVABILITY_TIMEOUT_MS); } catch { /* best-effort */ }
}

export async function emitAlert(port: IngestionAlertPort, event: AlertEvent): Promise<void> {
  if (!ALERTS.has(event.type) || !SEVERITIES.has(event.severity)) return;
  const safe: AlertEvent = Object.freeze({ type: event.type, severity: event.severity, reasonCode: isKnownReasonCode(event.reasonCode) ? event.reasonCode : null });
  try { await runBounded(() => port.emit(safe), OBSERVABILITY_TIMEOUT_MS); } catch { /* best-effort */ }
}
