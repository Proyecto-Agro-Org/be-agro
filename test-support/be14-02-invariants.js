// BE14-02 — eventId alignment invariants shared by the regular tests and the mutation test. Returns the list of VIOLATED invariant ids.
import { A, H, createBackend } from './be13-11j-invariants.js';
import { rig } from './be14-01-rig.js';

const LIMITS = { maxBytes: 4096, maxDepth: 8, maxKeys: 64, maxStringLength: 256 };
export const envelopeBytes = eventId => Buffer.from(JSON.stringify({ version: 1, eventId, sentAt: 1, payload: { t: 1 }, mqtt: { messageType: 'telemetry', dataOrigin: 'unknown' } }));

export async function checkEventIdInvariants({ eventIdMod, contracts, parser, service, publisher }) {
  const bad = [];
  // INV-E1: the reconciliation API accepts EXACTLY what the canonical definition accepts ('.' must not slip in).
  for (const id of ['a.b', 'a-b', 'a b', 'Device-01:1']) if (contracts.EVENT_ID_PATTERN.test(id) !== eventIdMod.isValidEventId(id)) bad.push('INV-E1');
  // INV-E2: the payload parser accepts EXACTLY what the canonical definition accepts.
  for (const id of ['a.b', 'a_b', 'a/b', 'x'.repeat(129), 'ok:1']) if (parser.parseBrokerPayload(envelopeBytes(id), LIMITS).ok !== eventIdMod.isValidEventId(id)) bad.push('INV-E2');
  // INV-E3: identity is exact: validation never normalises (case, whitespace, '.', unicode).
  { let same = true; for (const id of ['AbC:1', 'Device_01:2']) { try { if (eventIdMod.validateEventId(id) !== id) same = false; } catch { same = false; } } if (!same) bad.push('INV-E3'); }
  // INV-E4: an invalid eventId fails BEFORE any evidence lookup.
  { const be = createBackend(); let calls = 0; const count = f => async (...a) => { calls += 1; return f(...a); };
    const svc = service.createIngestConfirmationService({ evidence: { claims: count(be.evidence.claims), inbox: count(be.evidence.inbox), quarantine: count(be.evidence.quarantine) } });
    let threw = false; try { await svc.confirm(A, 'bad.id', H); } catch { threw = true; } if (!threw || calls !== 0) bad.push('INV-E4'); }
  // INV-E5: the publisher only ever generates canonical ids.
  { try { const r = rig(publisher); const ids = [r.pub.submitReading({ payload: { t: 1 } }).eventId, r.pub.submitReading({ payload: { t: 2 } }).eventId]; if (!ids.every(id => eventIdMod.isValidEventId(id))) bad.push('INV-E5'); } catch { bad.push('INV-E5'); } }      // a publisher that cannot produce a canonical id is a violation
  return bad;
}
