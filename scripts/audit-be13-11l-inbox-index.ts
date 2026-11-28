// BE13-11L — Durable Inbox eventId + lookup index + migration rehearsal against the disposable LOCAL 3-node MongoDB 8.0 replica set
// (be13-07-multinode-local.ps1 -Suite be13-11l). SINTETICO: no broker, no Atlas, no credentials. Answers one question: is the reconciliation lookup direct (IXSCAN),
// scoped, conflict-aware and compatible with LEGACY records, and does the migration (dry-run by default) behave on a legacy collection?
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { mongo, type Connection } from 'mongoose';
import { validateMultiNodeRequest, verifyOwnedMultiNode } from './be13-07/guard.js';
import { connectMultiNode } from './be13-07/connect.js';
import { brokerInboxCollection, brokerInboxIndexes, brokerInboxValidator, INBOX_EVENT_INDEX_NAME, provisionBrokerInboxCollection } from '../src/models/broker-inbox.models.js';
import { brokerContextFingerprint } from '../src/iot/broker-fingerprints.js';
import { createMongoBrokerInboxStore } from '../src/repositories/mongo-broker-inbox.store.js';
import { createMongoIngestConfirmationEvidence } from '../src/repositories/mongo-ingest-confirmation.evidence.js';
import { createIngestConfirmationService } from '../src/services/ingest-confirmation.service.js';
import { runMigration } from './be13-11l/inbox-eventid-migration.js';

const INGEST = 'agro_ingest_be1311l', LEGACY = 'agro_ingest_be1311lg';
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const results: { name: string; status: 'passed' | 'failed'; detail?: unknown }[] = [];
async function check(name: string, work: () => Promise<unknown>) {
  try { const detail = await work(); results.push({ name, status: 'passed', detail }); console.log('PASS ' + name + (detail ? ' ' + JSON.stringify(detail).slice(0, 300) : '')); }
  catch (error) { results.push({ name, status: 'failed', detail: (error as Error).message.slice(0, 300) }); console.log('FAIL ' + name + ' :: ' + (error as Error).message.slice(0, 300)); throw error; }
}
const stages = (plan: unknown): string[] => { const out: string[] = []; const walk = (n: unknown) => { if (n && typeof n === 'object') { const o = n as Record<string, unknown>; if (typeof o.stage === 'string') out.push(o.stage + (o.indexName ? ':' + String(o.indexName) : '')); for (const v of Object.values(o)) walk(v); } }; walk(plan); return out; };

async function main() {
  const request = validateMultiNodeRequest(process.env); verifyOwnedMultiNode(request);
  if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) throw Error('MN_GIT_TREE_NOT_CLEAN');
  const sha0 = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const conns: Connection[] = [await connectMultiNode(request)];
  try {
    const connection = conns[0]!, db = connection.db!;
    if ((await db.listCollections().toArray()).length !== 0) throw Error('MN_DATABASE_NOT_EMPTY');
    await provisionBrokerInboxCollection(connection, INGEST);
    const store = createMongoBrokerInboxStore({ connection, prefix: INGEST, realm: 'test' });
    const rows = db.collection(brokerInboxCollection(INGEST));
    const body = (eventId: string, v = 1) => Buffer.from(JSON.stringify({ version: 1, eventId, sentAt: 1795115600000, payload: { temperature: v } }));
    const persist = async (sourceId: string, eventId: string | undefined, bytes: Buffer, n: number) => {
      const rawPayloadSha256 = sha(bytes), receivedAt = 1795115600000 + n;
      const observed = { connectionReference: 'conn-' + n, authenticatedPrincipalReference: 'emqx-user:' + sourceId, mqttClientId: sourceId, topic: 'agro/lab/in/a', qos: 1 as const, retain: false, packetId: (n % 60000) + 1, receivedAt };
      const contextFingerprint = brokerContextFingerprint('test', observed, rawPayloadSha256);
      return store.persistVerifiedDelivery({ ...(eventId === undefined ? {} : { eventId }), realm: 'test', sourceId, principalReference: 'emqx-user:' + sourceId, technicalDeviceKey: sourceId, connectionReference: observed.connectionReference,
        mqttClientId: sourceId, topic: observed.topic, qos: 1, retain: false, packetId: observed.packetId, receivedAt, verifiedAt: receivedAt + 1, verifierRevision: 1, mappingRevision: 1, contextFingerprint, rawPayloadSha256, rawPayload: bytes } as never);
    };
    const A = { realm: 'test' as const, sourceId: 'lab-source-a' }, B = { realm: 'test' as const, sourceId: 'lab-source-b' };
    let n = 0; const N = 400;
    await check('seed: real store persists eventId for both tenants (2 x 400 records, same eventIds in both tenants)', async () => {
      for (let i = 0; i < N; i += 1) { await persist(A.sourceId, 'ev-' + i, body('ev-' + i), n++); await persist(B.sourceId, 'ev-' + i, body('ev-' + i, 2), n++); }
      assert.equal(await rows.countDocuments({ eventId: { $exists: true } }), 2 * N); return { records: 2 * N };
    });
    await check('store refuses an eventId that is not the one inside the persisted bytes', async () => {
      await assert.rejects(() => persist(A.sourceId, 'forged-id', body('real-id'), n++), /INBOX_EVENTID_MISMATCH/);
      assert.equal(await rows.countDocuments({ eventId: 'forged-id' }), 0);
    });
    await check('index + validator: provisioned collection has inbox_realm_source_event and admits eventId', async () => {
      const names = (await rows.indexes()).map(i => i.name); assert.ok(names.includes(INBOX_EVENT_INDEX_NAME) && names.includes('inbox_realm_persisted'), JSON.stringify(names));
      return { indexes: names };
    });
    let explain: unknown;
    await check('EXPLAIN: the reconciliation lookup is an IXSCAN on inbox_realm_source_event (no collection scan, no in-memory sort)', async () => {
      const ex = await rows.find({ realm: 'test', sourceId: A.sourceId, eventId: 'ev-123' }).sort({ rawPersistedAt: -1 }).limit(64).explain('executionStats') as { queryPlanner: { winningPlan: unknown }; executionStats: { totalKeysExamined: number; totalDocsExamined: number; nReturned: number } };
      const st = stages(ex.queryPlanner.winningPlan); assert.ok(st.includes('IXSCAN:' + INBOX_EVENT_INDEX_NAME), st.join(','));
      assert.equal(st.includes('COLLSCAN'), false); assert.equal(st.includes('SORT'), false);
      const old = await rows.find({ realm: 'test', sourceId: A.sourceId }).sort({ rawPersistedAt: -1 }).limit(5000).explain('executionStats') as { executionStats: { totalKeysExamined: number; totalDocsExamined: number } };
      explain = { direct: { stages: st, keys: ex.executionStats.totalKeysExamined, docs: ex.executionStats.totalDocsExamined, returned: ex.executionStats.nReturned }, previousScan: { keys: old.executionStats.totalKeysExamined, docs: old.executionStats.totalDocsExamined } };
      assert.ok(ex.executionStats.totalDocsExamined <= 2, 'direct lookup must touch ~1 document'); return explain;
    });
    const evidence = createMongoIngestConfirmationEvidence({ connection, prefix: INGEST, realm: 'test' }), svc = createIngestConfirmationService({ evidence });
    await check('confirmation semantics over the real inbox', async () => {
      const h = sha(body('ev-7')), hB = sha(body('ev-7', 2));
      const ok = await svc.confirm(A, 'ev-7', h); assert.equal(ok.status, 'received-durable'); assert.equal(ok.payloadHash, 'match');
      await persist(A.sourceId, 'ev-7', body('ev-7'), n++);                                       // legitimate retry: same eventId, same bytes
      const retry = await svc.confirm(A, 'ev-7', h); assert.equal(retry.deliveries, 2); assert.equal(retry.payloadHash, 'match'); assert.equal(retry.confirmed, true);
      assert.equal((await svc.confirm(B, 'ev-7', hB)).status, 'received-durable');                  // B's own record, B's own content
      assert.equal((await svc.confirm(B, 'ev-7', h)).status, 'conflict');                         // B asking with A's content hash: the id exists in B with another hash
      assert.equal((await svc.confirm(A, 'ev-7', hB)).status, 'conflict');
      await persist(A.sourceId, 'ev-8', body('ev-8', 9), n++); await persist(A.sourceId, 'ev-8', body('ev-8', 10), n++);  // same eventId, DIFFERENT bytes in the same tenant
      const c = await svc.confirm(A, 'ev-8', sha(body('ev-8', 9))); assert.equal(c.status, 'conflict'); assert.equal(c.confirmed, false);
      assert.equal((await svc.confirm(A, 'never-published', h)).status, 'not-found');
      return { retryDeliveries: retry.deliveries };
    });
    await check('MIGRATION REHEARSAL on a LEGACY collection (old validator, no eventId, old index only)', async () => {
      const oldValidator = JSON.parse(JSON.stringify(brokerInboxValidator)); delete oldValidator.$jsonSchema.properties.eventId;
      const lname = brokerInboxCollection(LEGACY);
      await db.createCollection(lname, { collation: { locale: 'simple' }, validationLevel: 'strict', validationAction: 'error', validator: oldValidator });
      await db.collection(lname).createIndex({ realm: 1, rawPersistedAt: 1 }, { name: 'inbox_realm_persisted' });
      const legacyRows = db.collection(lname);
      const base = (i: number, bytes: Buffer, overrideSha?: string) => ({ _id: 'ib_' + String(i).padStart(32, '0'), realm: 'test', sourceId: 'lab-source-a', principalReference: 'emqx-user:lab-source-a', technicalDeviceKey: 'lab-source-a', connectionReference: 'c' + i,
        mqttClientId: 'lab-source-a', topic: 'agro/lab/in/a', qos: new mongo.Int32(1), retain: false, packetId: new mongo.Int32(i + 1), receivedAt: new Date(1795115600000 + i), verifiedAt: new Date(1795115600001 + i), rawPersistedAt: new Date(1795115600002 + i),
        verifierRevision: 1, mappingRevision: 1, contextFingerprint: 'a'.repeat(64), rawPayloadSha256: overrideSha ?? sha(bytes), provenanceFingerprint: 'b'.repeat(64), rawPayload: new mongo.Binary(bytes), rawPayloadBytes: bytes.byteLength });
      await legacyRows.insertMany([base(1, body('leg-1')), base(2, body('leg-2')), base(3, body('leg-3')), base(4, Buffer.from('not json at all')), base(5, Buffer.from(JSON.stringify({ x: 1 }))), base(6, body('leg-6'), 'f'.repeat(64)), base(7, Buffer.from(JSON.stringify({ eventId: '../bad' })))] as never);
      const before = await legacyRows.find({}).sort({ _id: 1 }).toArray();
      const dry = await runMigration(db, LEGACY, { apply: false });
      assert.equal(dry.mode, 'dry-run'); assert.equal(dry.total, 7); assert.equal(dry.backfillable, 3); assert.equal(dry.legacy, 7); assert.equal(dry.validatorAllowsEventId, false); assert.equal(dry.indexPresent, false); assert.equal(dry.applied, null);
      assert.deepEqual(dry.unbackfillable, { 'payload-not-json': 1, 'eventid-missing': 1, 'hash-mismatch': 1, 'eventid-invalid': 1 }); assert.equal(dry.proposals.length, 3);
      assert.deepEqual(await legacyRows.find({}).sort({ _id: 1 }).toArray(), before, 'dry-run wrote NOTHING');
      assert.equal((await legacyRows.indexes()).some(i => i.name === INBOX_EVENT_INDEX_NAME), false);
      // legacy compatibility BEFORE the migration: the bounded fallback finds legacy records
      const legacyEvidence = createMongoIngestConfirmationEvidence({ connection, prefix: LEGACY, realm: 'test' });
      assert.equal((await legacyEvidence.inbox(A, 'leg-2')).length, 1);
      const applied = await runMigration(db, LEGACY, { apply: true, batch: 2 });
      assert.deepEqual(applied.applied, { collMod: true, index: true, backfilled: 3 }); assert.equal(applied.validatorAllowsEventId, true); assert.equal(applied.indexPresent, true);
      const after = await legacyRows.find({}).sort({ _id: 1 }).toArray();
      for (let i = 0; i < before.length; i += 1) { const { eventId, ...rest } = after[i] as Record<string, unknown>; void eventId; assert.deepEqual(rest, before[i] as never, 'raw evidence untouched on record ' + i); }
      assert.deepEqual(after.map(d => (d as { eventId?: string }).eventId ?? null), ['leg-1', 'leg-2', 'leg-3', null, null, null, null]);
      const again = await runMigration(db, LEGACY, { apply: true }); assert.deepEqual(again.applied, { collMod: false, index: false, backfilled: 0 }); assert.equal(again.withEventId, 3);
      const ex = await legacyRows.find({ realm: 'test', sourceId: 'lab-source-a', eventId: 'leg-2' }).sort({ rawPersistedAt: -1 }).limit(64).explain('executionStats') as { queryPlanner: { winningPlan: unknown } };
      assert.ok(stages(ex.queryPlanner.winningPlan).includes('IXSCAN:' + INBOX_EVENT_INDEX_NAME));
      assert.equal((await legacyEvidence.inbox(A, 'leg-2')).length, 1, 'backfilled record is found directly');
      assert.equal((await createIngestConfirmationService({ evidence: legacyEvidence }).confirm(A, 'leg-2', sha(body('leg-2'))).then(r => r.payloadHash)), 'match');
      // a new record can now carry an eventId in the migrated collection (validator evolved)
      await createMongoBrokerInboxStore({ connection, prefix: LEGACY, realm: 'test' }).persistVerifiedDelivery({ eventId: 'post-1', realm: 'test', sourceId: 'lab-source-a', principalReference: 'emqx-user:lab-source-a', technicalDeviceKey: 'lab-source-a', connectionReference: 'cx', mqttClientId: 'lab-source-a', topic: 'agro/lab/in/a', qos: 1, retain: false, packetId: 9, receivedAt: 1795115700000, verifiedAt: 1795115700001, verifierRevision: 1, mappingRevision: 1,
        contextFingerprint: brokerContextFingerprint('test', { connectionReference: 'cx', authenticatedPrincipalReference: 'emqx-user:lab-source-a', mqttClientId: 'lab-source-a', topic: 'agro/lab/in/a', qos: 1, retain: false, packetId: 9, receivedAt: 1795115700000 }, sha(body('post-1'))), rawPayloadSha256: sha(body('post-1')), rawPayload: body('post-1') } as never);
      return { dry: { total: dry.total, backfillable: dry.backfillable, unbackfillable: dry.unbackfillable, proposals: dry.proposals }, applied: applied.applied, rerun: again.applied };
    });
    void brokerInboxIndexes;
    mkdirSync('.local-evidence', { recursive: true });
    writeFileSync('.local-evidence/be13-11l-index.json', JSON.stringify({ label: 'LOCAL_LAB_EVIDENCE', head: sha0, explain, results }, null, 1));
    console.log('BE1311L_LOCAL_OK ' + JSON.stringify({ passed: results.filter(r => r.status === 'passed').length, failed: results.filter(r => r.status === 'failed').length }));
  } finally { await Promise.all(conns.map(c => c.close().catch(() => undefined))); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error('BE1311L_LOCAL_FAILED', JSON.stringify({ message: error instanceof Error ? error.message.slice(0, 400) : 'error' })); process.exit(1); });
