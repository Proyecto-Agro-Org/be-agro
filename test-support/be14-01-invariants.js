// BE14-01 — invariants shared by the regular tests and the mutation test. Returns the list of VIOLATED invariant ids.
import { A } from './be13-11j-invariants.js';
import { KEY, policy, rig } from './be14-01-rig.js';

const reading = { payload: { soil_temperature_c: 21.5 }, dataOrigin: 'simulated' };
export async function checkPublisherInvariants(mod) {
  const bad = [];
  // INV-P1: a PUBACK alone never confirms (state BROKER_ACCEPTED at most; the entry stays in the outbox).
  { const r = rig(mod, { mqttAs: () => ({ puback: true, deliver: false }), recAs: async () => ({ kind: 'no-answer', reason: 'unavailable' }) }); const { eventId } = r.pub.submitReading(reading); await r.pub.tick(); const e = r.pub.get(eventId); if (e.state === 'CONFIRMED' || e.state !== 'BROKER_ACCEPTED') bad.push('INV-P1'); }
  // INV-P2: every retry publishes the SAME eventId.
  { const r = rig(mod, { mqttAs: () => ({ puback: true, deliver: false }) }); const { eventId } = r.pub.submitReading(reading); await r.pump(r.pub, 3000); if (r.publishes.length < 2 || r.publishes.some(p => p.eventId !== eventId)) bad.push('INV-P2'); }
  // INV-P3: every retry publishes the SAME bytes (same hash as the stored payloadSha256).
  { const r = rig(mod, { mqttAs: () => ({ puback: true, deliver: false }) }); const { eventId } = r.pub.submitReading(reading); const sha = r.pub.get(eventId).payloadSha256; await r.pump(r.pub, 3000); if (r.publishes.length < 2 || r.publishes.some(p => p.sha !== sha)) bad.push('INV-P3'); }
  // INV-P4: a restart (new publisher over the same durable store) keeps the outbox and the eventId counter.
  { const r = rig(mod); const { eventId } = r.pub.submitReading(reading); const p2 = r.make(); if (!p2.get(eventId) || p2.nextSeq() !== 2) bad.push('INV-P4'); }
  // INV-P5: `pending` is never success and the entry is not finalized/deleted by it.
  { const r = rig(mod, { recAs: async () => ({ kind: 'status', status: 'pending' }) }); const { eventId } = r.pub.submitReading(reading); await r.pub.tick(); r.advance(10_000); await r.pub.tick(); const e = r.pub.get(eventId); if (e === null || e.state === 'CONFIRMED') bad.push('INV-P5'); }
  // INV-P6: `conflict` is terminal and never republished.
  { const r = rig(mod, { recAs: async () => ({ kind: 'status', status: 'conflict' }) }); const { eventId } = r.pub.submitReading(reading); await r.pump(r.pub, 5000); const e = r.pub.get(eventId); if (e.state !== 'CONFLICT_REQUIRES_REVIEW' || r.publishes.length !== 1) bad.push('INV-P6'); }
  // INV-P7: HTTP 429 + Retry-After is honoured: no republish and no query before the delay.
  { let n = 0; const r = rig(mod, { mqttAs: () => ({ puback: true, deliver: false }), recAs: async () => (++n === 1 ? { kind: 'throttled', retryAfterMs: 30_000 } : { kind: 'status', status: 'not-found' }) });
    const { eventId } = r.pub.submitReading(reading); await r.pub.tick(); r.advance(500); await r.pub.tick(); const tThrottle = r.t(), before = r.publishes.length, due = r.pub.get(eventId).nextAttemptAt; r.advance(10_000); await r.pub.tick();
    if (r.publishes.length !== before || r.queries.length !== 1 || due < tThrottle + 30_000) bad.push('INV-P7'); }
  // INV-P8: an answer about ANOTHER eventId never confirms (HTTP client validation).
  { const fetchImpl = async () => new Response(JSON.stringify({ eventId: 'other-event', status: 'processed', confirmed: true }), { status: 200 });
    const c = mod.createHttpReconciliationClient({ baseUrl: 'http://x', auth: mod.createTestOnlyAuth('p-a'), fetchImpl }); const a = await c.query('mine-1', 'a'.repeat(64)); if (a.kind === 'status') bad.push('INV-P8'); }
  void A; void KEY; void policy;
  return bad;
}
