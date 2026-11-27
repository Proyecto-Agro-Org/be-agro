// BE13-11J — in-memory backend model + the invariant checker used by BOTH the regular tests and the mutation tests.
// The model mirrors the real idempotency key (realm, sourceId, eventId): one logical measurement per key however many times it is delivered.
export const REALM = 'test';
export const A = { realm: REALM, sourceId: 'lab-source-a' };
export const B = { realm: REALM, sourceId: 'lab-source-b' };

export function createBackend() {
  const claims = [], inbox = [], quarantine = [];
  const down = { claims: false, inbox: false, quarantine: false };
  const key = (s, id) => s.realm + '|' + s.sourceId + '|' + id;
  const measurements = new Map();
  let t = 1000;
  const evidence = {
    async claims(scope, id) { if (down.claims) throw new Error('down'); return claims.filter(c => c.realm === scope.realm && c.sourceId === scope.sourceId && c.eventId === id); },
    async inbox(scope, id) { if (down.inbox) throw new Error('down'); return inbox.filter(c => c.realm === scope.realm && c.sourceId === scope.sourceId && c.eventId === id); },
    async quarantine(scope, id) { if (down.quarantine) throw new Error('down'); return quarantine.filter(c => c.realm === scope.realm && c.sourceId === scope.sourceId && c.eventId === id); },
  };
  return {
    evidence, down, claims, inbox, quarantine, measurements,
    /** A delivery reaches the backend: durable inbox record + (first time only) the committed claim and ONE measurement. */
    deliver(scope, id) { t += 1; inbox.push({ realm: scope.realm, sourceId: scope.sourceId, eventId: id, persistedAt: t });
      if (!measurements.has(key(scope, id))) { measurements.set(key(scope, id), 1); claims.push({ realm: scope.realm, sourceId: scope.sourceId, eventId: id, committedAt: t }); } },
    quarantineEvent(scope, id) { quarantine.push({ realm: scope.realm, sourceId: scope.sourceId, eventId: id }); },
    measurementCount: () => [...measurements.values()].reduce((a, b) => a + b, 0),
  };
}

const fastPolicy = (o = {}) => ({ mode: 'TEST_ONLY', initialDelayMs: 1, maxAttempts: 3, backoffFactor: 2, maxDelayMs: 10, maxElapsedMs: 10_000, ...o });
export { fastPolicy };
const clock = () => { let n = 0; return { now: () => n, sleep: async ms => { n += ms; } }; };

/** Runs the 6 invariants against the given module set. Returns the list of VIOLATED invariant ids ([] = all hold). */
export async function checkInvariants({ createService, reconcilePublish, idempotencyDocumentId }) {
  const bad = [];
  const mk = (backend, scope, publishFn) => {
    const service = createService({ evidence: backend.evidence }), c = clock();
    return { c, deps: { publish: publishFn, confirm: async id => { const r = await service.confirm(scope, id); return { ok: true, status: r.status }; }, sleep: c.sleep, now: c.now } };
  };
  // INV-A: a broker PUBACK is never the final answer — PUBACK always, backend never receives => explicit UNCONFIRMED.
  { const be = createBackend(); const { deps } = mk(be, A, async () => true); const r = await reconcilePublish('e-a', fastPolicy(), deps); if (r.outcome !== 'UNCONFIRMED_EXPLICIT') bad.push('INV-A'); }
  // INV-B: every retry uses the SAME eventId.
  { const be = createBackend(); const seen = []; const { deps } = mk(be, A, async id => { seen.push(id); return true; }); await reconcilePublish('e-b', fastPolicy(), deps); if (seen.length < 2 || new Set(seen).size !== 1 || seen[0] !== 'e-b') bad.push('INV-B'); }
  // INV-C: tenant B cannot confirm tenant A's event, even if the store leaks foreign rows.
  { const be = createBackend(); be.deliver(A, 'e-c'); const leaky = { ...be.evidence, claims: async () => be.claims, inbox: async () => be.inbox };
    const svc = createService({ evidence: leaky }); const r = await svc.confirm(B, 'e-c'); if (r.status !== 'not-found' || r.confirmed) bad.push('INV-C'); }
  // INV-D: pending / not-found / unknown statuses are never success.
  { for (const status of ['pending', 'not-found', 'weird']) { const c = clock(); const r = await reconcilePublish('e-d', fastPolicy(), { publish: async () => true, confirm: async () => ({ ok: true, status }), sleep: c.sleep, now: c.now }); if (r.outcome === 'CONFIRMED') bad.push('INV-D'); } }
  // INV-E: a re-delivery / retry of the same event keeps ONE logical measurement (the real idempotency document id is stable per key, distinct per event).
  { const k = { realm: 'test', sourceId: 'lab-source-a', operation: 'measurement', eventId: 'e-e', field: 'temperature' };
    if (idempotencyDocumentId(k) !== idempotencyDocumentId({ ...k }) || idempotencyDocumentId(k) === idempotencyDocumentId({ ...k, eventId: 'e-e2' })) bad.push('INV-E'); }
  // INV-F: an exhausted budget is explicit UNCONFIRMED (not success) even when the backend answered, just never with evidence.
  { const be = createBackend(); const { deps } = mk(be, A, async () => false); const r = await reconcilePublish('e-f', fastPolicy({ maxAttempts: 2 }), deps); if (r.outcome !== 'UNCONFIRMED_EXPLICIT' || r.exhausted !== 'max-attempts') bad.push('INV-F'); }
  return bad;
}
