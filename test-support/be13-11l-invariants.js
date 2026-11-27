// BE13-11L — invariants shared by the regular test and the mutation test. Returns the list of VIOLATED invariant ids.
import { createHash } from 'node:crypto';
import { bin, fakeConnection } from './be13-11l-fake-db.js';
const sha = t => createHash('sha256').update(t).digest('hex');
const A = { realm: 'test', sourceId: 'lab-source-a' }, B = { realm: 'test', sourceId: 'lab-source-b' };
const row = (sourceId, eventId, text, t = 0) => ({ realm: 'test', sourceId, eventId, rawPersistedAt: new Date(1000 + t), rawPayload: bin(text), rawPayloadSha256: sha(text) });

export async function checkInboxInvariants(serviceMod, evidenceMod, migrationMod) {
  const bad = [];
  const build = (inbox, claims = [], extra = {}) => { const f = fakeConnection({ agro_x_broker_inbox: inbox, agro_x_idempotency: claims, agro_x_quarantine: [] });
    return createServicePair(f, extra); };
  const createServicePair = (f, extra) => { const evidence = evidenceMod.createMongoIngestConfirmationEvidence({ connection: f.connection, prefix: 'agro_ingest_x', realm: 'test', ...extra });
    return { evidence, service: serviceMod.createIngestConfirmationService({ evidence }) }; };
  // names of the three collections for prefix `agro_x` are resolved by the real models: use them through a Proxy-free approach (same functions the adapter uses)
  const names = await import('../dist/src/models/broker-inbox.models.js'), idem = await import('../dist/src/models/ingestion-persistence.models.js'), quar = await import('../dist/src/models/ingestion-quarantine.models.js');
  const mkReal = (inbox, claims = [], extra = {}) => { const f = fakeConnection({ [names.brokerInboxCollection('agro_ingest_x')]: inbox, [idem.ingestionCollections('agro_ingest_x').idempotency]: claims, [quar.quarantineCollection('agro_ingest_x')]: [] }); return createServicePair(f, extra); };
  const H1 = sha('{"eventId":"e1","v":1}'), H2 = sha('{"eventId":"e1","v":2}');
  const claim = { realm: 'test', sourceId: A.sourceId, eventId: 'e1', state: 'committed', committedAt: new Date(2000), operation: 'measurement' };
  // INV-1: same eventId, DIFFERENT payload hash => conflict, never a confirmation.
  { const { service } = mkReal([row(A.sourceId, 'e1', '{"eventId":"e1","v":1}')], [claim]); const r = await service.confirm(A, 'e1', H2); if (r.status !== 'conflict' || r.confirmed) bad.push('INV-1'); }
  // INV-2: same eventId + same hash delivered twice is a legitimate retry (duplicate-confirmed), not a conflict.
  { const { service } = mkReal([row(A.sourceId, 'e1', '{"eventId":"e1","v":1}'), row(A.sourceId, 'e1', '{"eventId":"e1","v":1}', 5)], [claim]); const r = await service.confirm(A, 'e1', H1); if (r.status !== 'duplicate-confirmed') bad.push('INV-2'); }
  // INV-3: the direct lookup never returns another tenant's record.
  { const { evidence } = mkReal([row(B.sourceId, 'e1', '{"eventId":"e1","v":1}')]); const rows = await evidence.inbox(A, 'e1'); if (rows.length !== 0) bad.push('INV-3'); }
  // INV-4: a LEGACY record (no eventId stored) is still found by the bounded fallback.
  { const legacy = row(A.sourceId, undefined, '{"eventId":"e1","v":1}'); delete legacy.eventId; const { evidence } = mkReal([legacy]); const rows = await evidence.inbox(A, 'e1'); if (rows.length !== 1) bad.push('INV-4'); }
  // INV-5: the migration never writes unless --apply is explicit.
  { if (migrationMod.parseArgs([]).apply !== false || migrationMod.parseArgs(['--uri', 'x']).apply !== false) bad.push('INV-5'); }
  return bad;
}
