// BE13-11N — publisher outbox rig + invariants shared by the regular tests and the mutation test.
import { createHash } from 'node:crypto';
export const sha = b => createHash('sha256').update(b).digest('hex');
export const bytesOf = (id, v = 1) => Buffer.from(JSON.stringify({ eventId: id, v }));

export const FAST = { initialDelayMs: 100, backoffFactor: 2, maxDelayMs: 1000, jitterRatio: 0, maxAttempts: 3, maxElapsedMs: 10_000 };
export const SLOW = { intervalMs: 5000, confirmWaitMs: 50, maxElapsedMs: 30_000 };
export const policy = (o = {}) => ({ mode: 'TEST_ONLY', capacity: 100, fast: { ...FAST, ...(o.fast ?? {}) }, slow: { ...SLOW, ...(o.slow ?? {}) }, ...('capacity' in o ? { capacity: o.capacity } : {}) });

/** Deterministic rig: fake clock, scripted PUBACK/delivery/confirmation behaviour. */
export function rig(mod, { store = mod.createMemoryOutboxStore(), pol = policy(), confirmAs, publishAs } = {}) {
  let t = 1_000_000; const calls = [], delivered = new Map(), transitions = []; const R = { t: () => t };
  const deps = {
    now: () => t, random: () => 0.5,
    publish: async (eventId, bytes) => { calls.push({ eventId, sha: sha(bytes), at: t }); const ack = publishAs ? publishAs(eventId, calls.length) : { puback: true, deliver: true }; if (ack.deliver) delivered.set(eventId, sha(bytes)); return ack.puback; },
    confirm: async (eventId, hash) => { if (confirmAs) return confirmAs(eventId, hash, delivered, calls); const d = delivered.get(eventId); return { ok: true, status: d === undefined ? 'not-found' : d === hash ? 'processed' : 'conflict' }; },
    onTransition: e => transitions.push(e),
  };
  const pub = mod.createOutboxPublisher({ store, policy: pol, deps });
  /** Advances the clock to the next due entry and ticks, until nothing is pending or the horizon passes. */
  const pump = async (horizonMs = 120_000) => { const end = t + horizonMs; for (let i = 0; i < 10_000 && t <= end; i += 1) { const open = pub.entries().filter(e => e.status === 'PENDING'); if (open.length === 0) return; t = Math.max(t, Math.min(...open.map(e => e.nextAttemptAt))); await pub.tick(); } };
  return { ...R, pub, store, calls, delivered, transitions, pump, advance: ms => { t += ms; }, deps };
}

export async function checkOutboxInvariants(mod) {
  const bad = [];
  // INV-N1: a PUBACK is never success (backend never receives it): the entry must NOT become CONFIRMED.
  { const r = rig(mod, { publishAs: () => ({ puback: true, deliver: false }) }); r.pub.submit({ eventId: 'e-n1', bytes: bytesOf('e-n1') }); await r.pump(); const e = r.pub.get('e-n1'); if (e.status === 'CONFIRMED') bad.push('INV-N1'); }
  // INV-N2: the SAME eventId on every attempt.
  { const r = rig(mod, { publishAs: () => ({ puback: true, deliver: false }) }); r.pub.submit({ eventId: 'e-n2', bytes: bytesOf('e-n2') }); await r.pump(); if (r.calls.length < 2 || r.calls.some(c => c.eventId !== 'e-n2')) bad.push('INV-N2'); }
  // INV-N3: a full outbox rejects explicitly and loses nothing already accepted.
  { const r = rig(mod, { pol: policy({ capacity: 2 }) }); const ok = ['a', 'b'].map(i => r.pub.submit({ eventId: 'e-n3' + i, bytes: bytesOf(i) }).result); const third = r.pub.submit({ eventId: 'e-n3c', bytes: bytesOf('c') });
    const ids = r.pub.entries().map(e => e.eventId).sort().join(','); if (third.result !== 'REJECTED_OUTBOX_FULL' || ok.some(x => x !== 'ACCEPTED') || ids !== 'e-n3a,e-n3b') bad.push('INV-N3'); }
  // INV-N4: a restart (new publisher over the same durable store) keeps every entry.
  { const store = mod.createMemoryOutboxStore(); const r1 = rig(mod, { store }); r1.pub.submit({ eventId: 'e-n4', bytes: bytesOf('e-n4') }); r1.pub.persist(); const r2 = mod.createOutboxPublisher({ store, policy: policy(), deps: r1.deps }); if (!r2.get('e-n4')) bad.push('INV-N4'); }
  // INV-N5: the same eventId with OTHER bytes is refused (never overwritten, never reported as already present).
  { const r = rig(mod); r.pub.submit({ eventId: 'e-n5', bytes: bytesOf('e-n5', 1) }); const again = r.pub.submit({ eventId: 'e-n5', bytes: bytesOf('e-n5', 2) }); const same = r.pub.submit({ eventId: 'e-n5', bytes: bytesOf('e-n5', 1) });
    if (again.result !== 'REJECTED_EVENT_ID_REUSED_WITH_OTHER_BYTES' || same.result !== 'ALREADY_PRESENT' || r.pub.entries().length !== 1) bad.push('INV-N5'); }
  // INV-N6: a CONFLICT is terminal and is never retried.
  { const r = rig(mod, { confirmAs: async () => ({ ok: true, status: 'conflict' }) }); r.pub.submit({ eventId: 'e-n6', bytes: bytesOf('e-n6') }); await r.pump(); const e = r.pub.get('e-n6'); if (e.status !== 'CONFLICT' || r.calls.length !== 1) bad.push('INV-N6'); }
  // INV-N7: a spent slow lane is UNCONFIRMED_EXPLICIT (retained), never success.
  { const r = rig(mod, { confirmAs: async () => ({ ok: false }) }); r.pub.submit({ eventId: 'e-n7', bytes: bytesOf('e-n7') }); await r.pump(); const e = r.pub.get('e-n7'); if (e.status !== 'UNCONFIRMED_EXPLICIT' || e.unconfirmedSince === null) bad.push('INV-N7'); }
  // INV-N8: pending / not-found / unknown answers are never success.
  { for (const status of ['pending', 'not-found', 'weird']) { const r = rig(mod, { confirmAs: async () => ({ ok: true, status }) }); r.pub.submit({ eventId: 'e-n8', bytes: bytesOf('e-n8') }); await r.pump(); if (r.pub.get('e-n8').status === 'CONFIRMED') bad.push('INV-N8'); } }
  return bad;
}
