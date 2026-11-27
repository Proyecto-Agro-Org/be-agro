// BE13-11L — offline tests: eventId persisted in the Durable Inbox, payloadSha256 + conflict, indexed lookup with LEGACY compatibility, migration (dry-run by default).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { boundarySetup, delivery } from '../test-support/be13-11a-broker.fixtures.js';
import { createMongoIngestConfirmationEvidence, INBOX_DIRECT_LIMIT } from '../dist/src/repositories/mongo-ingest-confirmation.evidence.js';
import { createIngestConfirmationService } from '../dist/src/services/ingest-confirmation.service.js';
import { eventIdOfBytes } from '../dist/src/repositories/mongo-broker-inbox.store.js';
import { INBOX_EVENT_INDEX_NAME, brokerInboxIndexes, brokerInboxValidator, brokerInboxCollection } from '../dist/src/models/broker-inbox.models.js';
import { ingestionCollections } from '../dist/src/models/ingestion-persistence.models.js';
import { quarantineCollection } from '../dist/src/models/ingestion-quarantine.models.js';
import { assertLocalOnly, classifyInboxRecord, parseArgs } from '../dist/scripts/be13-11l/inbox-eventid-migration.js';
import { bin, fakeConnection } from '../test-support/be13-11l-fake-db.js';
import { checkInboxInvariants } from '../test-support/be13-11l-invariants.js';

const sha = text => createHash('sha256').update(text).digest('hex');
const PREFIX = 'agro_ingest_x';
const rec = (o, body = { eventId: o.eventId }) => { const text = typeof body === 'string' ? body : JSON.stringify(body); return { realm: 'test', rawPersistedAt: new Date(1000 + (o.t ?? 0)), rawPayload: bin(text), rawPayloadSha256: o.sha ?? sha(text), ...o }; };
const A = { realm: 'test', sourceId: 'lab-source-a' }, B = { realm: 'test', sourceId: 'lab-source-b' };
const mk = (inbox, claims = [], quarantine = [], extra = {}) => { const f = fakeConnection({ [brokerInboxCollection(PREFIX)]: inbox, [ingestionCollections(PREFIX).idempotency]: claims, [quarantineCollection(PREFIX)]: quarantine });
  return { ...f, evidence: createMongoIngestConfirmationEvidence({ connection: f.connection, prefix: PREFIX, realm: 'test', ...extra }) }; };

test('L1 the boundary persists the VALIDATED eventId with the verified delivery (never invented)', async () => {
  const s = await boundarySetup(); const r = await s.admission.admit(delivery(), { mode: 'persist-only' });
  assert.equal(r.status, 'persisted'); const row = [...s.inbox.rows.values()][0];
  assert.equal(row.eventId, 'synthetic-telemetry-001'); assert.equal(eventIdOfBytes(row.rawPayload), row.eventId);
});

test('L2 eventIdOfBytes reads the id out of the exact bytes and fails closed', () => {
  assert.equal(eventIdOfBytes(Buffer.from('{"eventId":"a-1","x":1}')), 'a-1');
  for (const bad of ['', 'nope', '{"eventId":7}', '{"x":1}']) assert.equal(eventIdOfBytes(Buffer.from(bad)), null);
});

test('L3 model: validator admits an optional eventId and the compound lookup index exists (non unique)', () => {
  const p = brokerInboxValidator.$jsonSchema; assert.ok(p.properties.eventId); assert.equal(p.required.includes('eventId'), false);
  const ix = brokerInboxIndexes.find(i => i.name === INBOX_EVENT_INDEX_NAME);
  assert.deepEqual(ix.key, { realm: 1, sourceId: 1, eventId: 1, rawPersistedAt: -1 }); assert.equal('unique' in ix, false);
});

test('L4 the lookup is DIRECT (realm + sourceId + eventId) and scoped: a foreign tenant row is never returned', async () => {
  const m = mk([rec({ eventId: 'e1', sourceId: A.sourceId }), rec({ eventId: 'e1', sourceId: B.sourceId, t: 5 }), rec({ eventId: 'e2', sourceId: A.sourceId })]);
  const rows = await m.evidence.inbox(A, 'e1');
  assert.deepEqual(rows.map(r => [r.sourceId, r.eventId]), [[A.sourceId, 'e1']]);
  const direct = m.queries.find(q => q.filter.eventId === 'e1'); assert.deepEqual(Object.keys(direct.filter).sort(), ['eventId', 'realm', 'sourceId']); assert.equal(INBOX_DIRECT_LIMIT, 64);
});

test('L5 LEGACY compatibility: records without eventId are found by the bounded fallback; legacyScan:false disables it', async () => {
  const legacy = rec({ sourceId: A.sourceId, t: 1 }, { eventId: 'old-1' }); delete legacy.eventId;
  const m = mk([legacy]); const rows = await m.evidence.inbox(A, 'old-1'); assert.equal(rows.length, 1); assert.equal(rows[0].payloadSha256, legacy.rawPayloadSha256);
  assert.equal((await mk([legacy], [], [], { legacyScan: false }).evidence.inbox(A, 'old-1')).length, 0);
  const other = mk([{ ...legacy, sourceId: B.sourceId }]); assert.equal((await other.evidence.inbox(A, 'old-1')).length, 0);       // legacy fallback is scoped too
  const withId = mk([rec({ eventId: 'new-1', sourceId: A.sourceId })]); assert.equal(withId.queries.length, 0); await withId.evidence.inbox(A, 'new-1');
  assert.equal(withId.queries.filter(q => q.filter.eventId === null).length, 1);                                                      // the fallback only ever asks for records WITHOUT an eventId
});

test('L6 same eventId + same hash = legitimate retry; different hash = conflict (never a confirmation); mixed = conflict', async () => {
  const H1 = sha('A'), H2 = sha('B');
  const claim = { realm: 'test', sourceId: A.sourceId, eventId: 'e9', state: 'committed', committedAt: new Date(2000), operation: 'measurement' };
  const one = mk([rec({ eventId: 'e9', sourceId: A.sourceId, sha: H1 })], [claim]), svc = m => createIngestConfirmationService({ evidence: m.evidence });
  assert.equal((await svc(one).confirm(A, 'e9', H1)).status, 'processed');
  const retry = mk([rec({ eventId: 'e9', sourceId: A.sourceId, sha: H1 }), rec({ eventId: 'e9', sourceId: A.sourceId, sha: H1, t: 3 })], [claim]);
  const r = await svc(retry).confirm(A, 'e9', H1); assert.equal(r.status, 'duplicate-confirmed'); assert.equal(r.payloadHash, 'match');
  const c = await svc(one).confirm(A, 'e9', H2); assert.equal(c.status, 'conflict'); assert.equal(c.confirmed, false); assert.equal(c.payloadHash, 'mismatch');
  const mixed = mk([rec({ eventId: 'e9', sourceId: A.sourceId, sha: H1 }), rec({ eventId: 'e9', sourceId: A.sourceId, sha: H2, t: 4 })], [claim]);
  assert.equal((await svc(mixed).confirm(A, 'e9', H1)).status, 'conflict');
  assert.equal((await svc(mk([], [claim])).confirm(A, 'e9', H1)).status, 'pending');                  // a claim with no inbox record cannot be tied to the asked bytes
  assert.equal(JSON.stringify(c).includes(H1), false);                                                 // the conflict answer never reveals the stored hash
});

test('L7 invariants hold on the real modules (and the mutation test kills each mutant)', async () => { assert.deepEqual(await checkInboxInvariants(await import('../dist/src/services/ingest-confirmation.service.js'), await import('../dist/src/repositories/mongo-ingest-confirmation.evidence.js'), await import('../dist/scripts/be13-11l/inbox-eventid-migration.js')), []); });

test('L8 migration: classification never guesses and requires a proven hash', () => {
  const ok = rec({ sourceId: 'x' }, { eventId: 'ok-1' }); delete ok.eventId;
  assert.deepEqual(classifyInboxRecord(ok), { kind: 'backfillable', eventId: 'ok-1' });
  assert.deepEqual(classifyInboxRecord({ ...ok, eventId: 'already-1' }), { kind: 'has-eventid', eventId: 'already-1' });
  assert.equal(classifyInboxRecord({ ...ok, rawPayloadSha256: 'f'.repeat(64) }).reason, 'hash-mismatch');
  assert.equal(classifyInboxRecord(rec({}, 'not json')).reason, 'payload-not-json');
  assert.equal(classifyInboxRecord(rec({}, { x: 1 })).reason, 'eventid-missing');
  assert.equal(classifyInboxRecord(rec({}, { eventId: '../bad' })).reason, 'eventid-invalid');
  assert.equal(classifyInboxRecord({}).reason, 'payload-unreadable');
});

test('L9 migration: DRY-RUN is the default; apply is explicit, enabled by env and loopback-only (Atlas forbidden)', () => {
  assert.equal(parseArgs([]).apply, false); assert.equal(parseArgs(['--apply']).apply, true); assert.equal(parseArgs(['--apply', '--dry-run']).apply, false);
  const env = { AGRO_MIGRATION_ENABLE: 'LOCAL_DISPOSABLE_ONLY' };
  assert.doesNotThrow(() => assertLocalOnly('mongodb://127.0.0.1:27071,127.0.0.1:27072/db?replicaSet=x', env));
  assert.throws(() => assertLocalOnly('mongodb://127.0.0.1:27071/db', {}), /NOT_ENABLED/);
  for (const bad of ['mongodb+srv://u:p@cluster0.mongodb.net/db', 'mongodb://cluster0-shard-00-00.abcde.mongodb.net:27017/db', 'mongodb://10.0.0.5:27017/db', 'mongodb://example.com/db', 'mongodb://127.0.0.1,evil.com/db']) assert.throws(() => assertLocalOnly(bad, env), /FORBIDDEN/);
  assert.throws(() => assertLocalOnly(null, env), /URI_REQUIRED/);
  const src = readFileSync(new URL('../scripts/be13-11l/inbox-eventid-migration.ts', import.meta.url), 'utf8');
  assert.equal(/\$unset|deleteMany|deleteOne|dropIndex|drop\(\)/.test(src), false);                  // never removes anything
});
