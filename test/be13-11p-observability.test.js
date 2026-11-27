// BE13-11P — offline tests of the pipeline observability (closed vocabularies, safe logs, correlation, candidate thresholds).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createIngestConfirmationService } from '../dist/src/services/ingest-confirmation.service.js';
import { CANDIDATE_ALERT_THRESHOLDS, PIPELINE_STAGES, confirmationRequestObserver, correlate, structuredLogLine } from '../dist/src/iot/confirmation-observability.js';
import { sanitizeMetricLabels } from '../dist/src/iot/ingestion-observability.js';
import * as mod from '../dist/scripts/be13-11n/publisher-outbox.js';
import { outboxTransitionMetrics, sampleOutbox } from '../dist/scripts/be13-11p/publisher-observability.js';
import { A, H, H2, createBackend } from '../test-support/be13-11j-invariants.js';
import { bytesOf, rig } from '../test-support/be13-11n-invariants.js';

const sink = () => { const rows = []; return { rows, increment: (name, labels) => rows.push({ name, labels }) }; };

test('P1 confirmation statuses are counted with a CLOSED label vocabulary (no eventId, no sourceId, no hash)', async () => {
  const be = createBackend(), m = sink(); const svc = createIngestConfirmationService({ evidence: be.evidence, metrics: m });
  be.deliver(A, 'p-proc'); be.deliver(A, 'p-dup'); be.deliver(A, 'p-dup'); be.inbox.push({ realm: 'test', sourceId: A.sourceId, eventId: 'p-dur', persistedAt: 1, payloadSha256: H }); be.quarantineEvent(A, 'p-q');
  const asked = [['p-proc', H], ['p-dup', H], ['p-dur', H], ['p-q', H], ['p-proc', H2], ['p-none', H]]; for (const [id, h] of asked) await svc.confirm(A, id, h);
  be.down.claims = true; await svc.confirm(A, 'p-none', H);
  const statuses = m.rows.filter(r => r.name === 'ingest_confirmation_total').map(r => r.labels.outcome);
  assert.deepEqual(statuses, ['processed', 'duplicate-confirmed', 'received-durable', 'quarantined', 'conflict', 'not-found', 'pending']);
  assert.deepEqual(m.rows.filter(r => r.name === 'ingest_confirmation_evidence_unavailable_total').map(r => r.labels.outcome), ['evidence-claim']);
  for (const r of m.rows) { assert.deepEqual(Object.keys(r.labels), ['outcome']); assert.equal(JSON.stringify(r).includes('p-proc') || JSON.stringify(r).includes(H) || JSON.stringify(r).includes(A.sourceId), false); }
  assert.equal(sanitizeMetricLabels({ outcome: 'p-proc' }).outcome, 'other');                                   // an arbitrary value collapses to `other`
});

test('P2 the router observer feeds request outcomes (including rate-limit denied); a failing metrics port changes nothing', async () => {
  const m = sink(), obs = confirmationRequestObserver(m);
  for (const outcome of ['ok', 'unauthenticated', 'forbidden', 'invalid-input', 'rate-limited', 'uri-too-long', 'error']) obs({ outcome, sourceId: 'lab-source-a', eventId: 'x-1' });
  await new Promise(r => setTimeout(r, 5)); assert.deepEqual(m.rows.map(r => r.labels.outcome), ['ok', 'unauthenticated', 'forbidden', 'invalid-input', 'rate-limited', 'uri-too-long', 'error']);
  assert.ok(m.rows.every(r => r.name === 'ingest_confirmation_request_total' && Object.keys(r.labels).join() === 'outcome'));
  assert.doesNotThrow(() => confirmationRequestObserver({ increment: () => { throw new Error('metrics down'); } })({ outcome: 'ok' }));
});

test('P3 publisher metrics: published, brokerAccepted, retry, unconfirmed, retry exhausted, terminal states, depth, oldest age, reconciliation latency', async () => {
  const counters = [], gauges = [], observed = []; const sinkP = { counter: (n, l) => counters.push([n, l?.status ?? l?.lane ?? null]), gauge: (n, v) => gauges.push([n, v]), observe: (n, v) => observed.push([n, v]) };
  const ok = rig(mod, { publishAs: (id, n) => ({ puback: true, deliver: n >= 2 }) }); ok.deps.onTransition = outboxTransitionMetrics(sinkP);
  const pub = mod.createOutboxPublisher({ store: mod.createMemoryOutboxStore(), policy: (await import('../test-support/be13-11n-invariants.js')).policy(), deps: ok.deps });
  pub.submit({ eventId: 'p3-ok', bytes: bytesOf('p3-ok') }); for (let i = 0; i < 20 && pub.stats().pending > 0; i += 1) { ok.advance(200); await pub.tick(); }
  const bad = rig(mod, { confirmAs: async () => ({ ok: false }) }); bad.deps.onTransition = outboxTransitionMetrics(sinkP);
  const pub2 = mod.createOutboxPublisher({ store: mod.createMemoryOutboxStore(), policy: (await import('../test-support/be13-11n-invariants.js')).policy(), deps: bad.deps });
  pub2.submit({ eventId: 'p3-bad', bytes: bytesOf('p3-bad') }); for (let i = 0; i < 200 && pub2.stats().pending > 0; i += 1) { bad.advance(1000); await pub2.tick(); }
  const names = new Set(counters.map(c => c[0])); for (const n of ['publisher_event_published_total', 'publisher_broker_accepted_total', 'publisher_retry_total', 'publisher_unconfirmed_total', 'publisher_retry_exhausted_total', 'publisher_terminal_total']) assert.ok(names.has(n), n);
  assert.ok(counters.some(c => c[0] === 'publisher_terminal_total' && c[1] === 'CONFIRMED')); assert.ok(counters.some(c => c[0] === 'publisher_terminal_total' && c[1] === 'UNCONFIRMED_EXPLICIT'));
  sampleOutbox(sinkP, pub.entries(), ok.t()); assert.deepEqual(gauges.slice(-2).map(g => g[0]), ['publisher_outbox_depth', 'publisher_outbox_oldest_pending_age_ms']); assert.ok(observed.some(o => o[0] === 'publisher_reconciliation_latency_ms' && o[1] >= 0));
  const open = rig(mod, { publishAs: () => ({ puback: true, deliver: false }) }); open.pub.submit({ eventId: 'p3-open', bytes: bytesOf('x') }); open.advance(7000); sampleOutbox(sinkP, open.pub.entries(), open.t()); assert.deepEqual(gauges.slice(-2), [['publisher_outbox_depth', 1], ['publisher_outbox_oldest_pending_age_ms', 7000]]);
  assert.equal(JSON.stringify([counters, gauges]).includes('p3-ok'), false);                                  // no eventId in any metric
});

test('P4 structured logs: allowlist only; secrets, hashes, payloads, principals and malformed identifiers never reach a line', () => {
  const line = JSON.parse(structuredLogLine({ ts: 5, component: 'publisher', event: 'publisher.transition', eventId: 'e-1', sourceId: 'lab-source-a', from: 'needs-publish', to: 'awaiting-confirm', lane: 'fast', attempt: 2,
    payloadSha256: H, payload: { t: 1 }, password: 'hunter2', token: 'abc', principalReference: 'emqx-user:x', connectionString: 'mongodb://u:p@h' }));
  assert.deepEqual(Object.keys(line).sort(), ['attempt', 'component', 'eventId', 'event', 'from', 'lane', 'sourceId', 'to', 'ts'].sort());
  const t = structuredLogLine({ ts: 1, component: 'x', event: 'e', eventId: '../bad\nline', sourceId: 'a b', status: 'x'.repeat(100), attempt: -1, lane: 'medium', outcome: 'ok' });
  assert.deepEqual(JSON.parse(t), { ts: 1, component: 'x', event: 'e', outcome: 'ok' }); assert.equal(t.includes('\n'), false);
  const benign = structuredLogLine({ ts: 1, event: 'e', password: 'hunter2', token: 'tok-9', payloadSha256: H, connection: 'mongodb://u:p@h' }); for (const secret of ['hunter2', 'tok-9', 'mongodb', H]) assert.equal(benign.includes(secret), false);
});

test('P5 correlation: publish -> PUBACK -> delivery -> inbox -> processing -> confirmation is reconstructable per (sourceId, eventId); tenants never mix', () => {
  const recs = [['A', 'e1', 5, 'broker-accepted'], ['A', 'e1', 1, 'published'], ['B', 'e1', 2, 'published'], ['A', 'e1', 9, 'confirmed'], ['A', 'e1', 7, 'processed'], ['A', 'e1', 6, 'inbox-persisted'], ['A', 'e1', 6.5, 'delivered'], ['B', 'e1', 3, 'quarantined']]
    .map(([sourceId, eventId, ts, stage]) => ({ sourceId, eventId, ts, stage }));
  const trails = correlate([...recs, { ts: 1, stage: 'published' }]);                                          // a record without ids is ignored
  const a = trails.find(t => t.sourceId === 'A'), b = trails.find(t => t.sourceId === 'B');
  assert.deepEqual(a.stages, ['published', 'broker-accepted', 'inbox-persisted', 'delivered', 'processed', 'confirmed'].filter(s => s !== 'delivered' || true).sort((x, y) => recs.find(r => r.sourceId === 'A' && r.stage === x).ts - recs.find(r => r.sourceId === 'A' && r.stage === y).ts));
  assert.deepEqual(b.stages, ['published', 'quarantined']); assert.equal(trails.length, 2); assert.deepEqual(PIPELINE_STAGES, ['published', 'broker-accepted', 'delivered', 'inbox-persisted', 'processed', 'confirmed']);
});

test('P6 alert thresholds are CANDIDATES: not configured, not approved', () => {
  assert.equal(CANDIDATE_ALERT_THRESHOLDS.configured, false); assert.equal(CANDIDATE_ALERT_THRESHOLDS.approved, false); assert.ok(CANDIDATE_ALERT_THRESHOLDS.candidates.length >= 6);
  assert.ok(Object.isFrozen(CANDIDATE_ALERT_THRESHOLDS) && Object.isFrozen(CANDIDATE_ALERT_THRESHOLDS.candidates));
});
