// BE14-03 — maps the summary of the ONE integrated campaign (real EMQX + real Mongo + real router, harness tag BE14_01_TAG) onto the conformance result format.
import type { TestResult } from './runner.js';

type S = { f_e2_events: number; normal_events: number; f_e2: { confirmed: number; retried: number }; normal: { confirmed: number; firstTryConfirmed: number }; conflict: { state: string; republished: number; measurementsForEvent: number };
  brokerAcceptedAnyNotConfirmed: number; confirmedWithoutBackendEvidence: string[]; eventsWithMoreThanOneMeasurement: number; publisherCrash: { identical: boolean; entriesBefore: number; entriesAfter: number }; backendRestart: unknown[]; mqttConnectionsOpenNow: number;
  crossTenantProbe: { askedByB: { kind?: string; status?: string } }; counters: Record<string, number> };
export function integratedResults(s: S): Omit<TestResult, 'group'>[] {
  const mk = (testId: string, level: 0 | 1 | 2 | 3 | 4 | 5, title: string, ok: boolean, failureCode: string, evidence: unknown): Omit<TestResult, 'group'> => ({ testId, level, title, status: ok ? 'PASS' : 'FAIL', evidence, durationMs: 0, failureCode: ok ? null : failureCode, skipReason: null });
  return [
    mk('INT-L1-01', 1, 'real EMQX/Mongo: healthy events are confirmed at the first query', s.normal.firstTryConfirmed === s.normal_events && s.normal_events > 0, 'NORMAL_NOT_CONFIRMED', s.normal),
    mk('INT-L1-02', 1, 'real EMQX: PUBACK never counted as success, nothing confirmed without backend evidence', s.brokerAcceptedAnyNotConfirmed === 0 && s.confirmedWithoutBackendEvidence.length === 0, 'PUBACK_AS_SUCCESS', { brokerAcceptedAnyNotConfirmed: s.brokerAcceptedAnyNotConfirmed, confirmedWithoutBackendEvidence: s.confirmedWithoutBackendEvidence.length }),
    mk('INT-L1-03', 1, 'real EMQX: a single MQTT connection per identity', s.mqttConnectionsOpenNow <= 1, 'CLIENTID_COLLISION', { open: s.mqttConnectionsOpenNow }),
    mk('INT-L2-01', 2, 'real F-E2 (PUBACK without delivery): every event converges through retries of the same identity', s.f_e2.confirmed === s.f_e2_events && s.f_e2.retried >= 1, 'FE2_NOT_RECOVERED', s.f_e2),
    mk('INT-L2-02', 2, 'real pipeline: no duplicate measurement across all retries', s.eventsWithMoreThanOneMeasurement === 0, 'DUPLICATE_MEASUREMENT', { events: s.eventsWithMoreThanOneMeasurement }),
    mk('INT-L2-03', 2, 'real pipeline: same eventId with other bytes is a terminal conflict, never republished', s.conflict.state === 'CONFLICT_REQUIRES_REVIEW' && s.conflict.republished === 1, 'CONFLICT_NOT_TERMINAL', s.conflict),
    mk('INT-L3-01', 3, 'publisher restart: the outbox rebuilt from disk is identical', s.publisherCrash.identical && s.publisherCrash.entriesBefore === s.publisherCrash.entriesAfter, 'OUTBOX_NOT_IDENTICAL', s.publisherCrash),
    mk('INT-L4-01', 4, 'reconciliation API outage during the run: no false success and convergence afterwards', s.backendRestart.length >= 2 && (s.counters.no_answer ?? 0) > 0 && s.f_e2.confirmed === s.f_e2_events, 'OUTAGE_NOT_RECOVERED', { outageEvents: s.backendRestart.length, noAnswer: s.counters.no_answer }),
    mk('INT-L5-01', 5, 'real backend: another tenant sees an existing event as not-found', s.crossTenantProbe.askedByB.status === 'not-found', 'CROSS_TENANT_LEAK', s.crossTenantProbe),
  ];
}
