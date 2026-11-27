// BE13-11M — reconcilable quarantine scope against the disposable LOCAL 3-node MongoDB 8.0 replica set (be13-07-multinode-local.ps1 -Suite be13-11m). SINTETICO.
// Question: can a NEW quarantine row (written with the boundary's proven context) be reconciled by its owner, never by another principal, without changing dedupe,
// and does the LOCAL validator upgrade keep legacy rows valid?
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { Connection } from 'mongoose';
import { validateMultiNodeRequest, verifyOwnedMultiNode } from './be13-07/guard.js';
import { connectMultiNode } from './be13-07/connect.js';
import { provisionQuarantineCollection, quarantineCollection, quarantineValidator, quarantineIndexes, upgradeQuarantineScopeBe1311m } from '../src/models/ingestion-quarantine.models.js';
import { createMongoIngestionQuarantineStore } from '../src/repositories/mongo-ingestion-quarantine.store.js';
import { createMongoIngestConfirmationEvidence } from '../src/repositories/mongo-ingest-confirmation.evidence.js';
import { createIngestConfirmationService } from '../src/services/ingest-confirmation.service.js';
import { runWithQuarantineScope } from '../src/iot/quarantine-reconcile-scope.js';

const NEW = 'agro_ingest_be1311m', OLD = 'agro_ingest_be1311mg';
const sha = (t: string) => createHash('sha256').update(t).digest('hex');
const results: { name: string; status: 'passed' | 'failed'; detail?: unknown }[] = [];
async function check(name: string, work: () => Promise<unknown>) {
  try { const detail = await work(); results.push({ name, status: 'passed', detail }); console.log('PASS ' + name + (detail ? ' ' + JSON.stringify(detail).slice(0, 280) : '')); }
  catch (error) { results.push({ name, status: 'failed', detail: (error as Error).message.slice(0, 300) }); console.log('FAIL ' + name + ' :: ' + (error as Error).message.slice(0, 300)); throw error; }
}
const stages = (plan: unknown): string[] => { const out: string[] = []; const walk = (n: unknown) => { if (n && typeof n === 'object') { const o = n as Record<string, unknown>; if (typeof o.stage === 'string') out.push(o.stage + (o.indexName ? ':' + String(o.indexName) : '')); for (const v of Object.values(o)) walk(v); } }; walk(plan); return out; };

async function main() {
  const request = validateMultiNodeRequest(process.env); verifyOwnedMultiNode(request);
  if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) throw Error('MN_GIT_TREE_NOT_CLEAN');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const conns: Connection[] = [await connectMultiNode(request)];
  try {
    const connection = conns[0]!, db = connection.db!;
    if ((await db.listCollections().toArray()).length !== 0) throw Error('MN_DATABASE_NOT_EMPTY');
    await provisionQuarantineCollection(connection, NEW);
    const store = createMongoIngestionQuarantineStore({ connection, prefix: NEW, realm: 'test' });
    const rows = db.collection(quarantineCollection(NEW));
    const base = (digest: string) => ({ realm: 'test' as const, stage: 'mapper' as const, sourceId: null, operation: null, eventId: null, field: null, device: null, reasonCode: 'mapper-rejected', cause: null, retryClass: 'validation' as const, fingerprint: null, documentDigest: sha(digest) });
    const A = { realm: 'test' as const, sourceId: 'lab-source-a', principalReference: 'emqx-user:lab-source-a' }, B = { realm: 'test' as const, sourceId: 'lab-source-b', principalReference: 'emqx-user:lab-source-b' };
    const svc = createIngestConfirmationService({ evidence: createMongoIngestConfirmationEvidence({ connection, prefix: NEW, realm: 'test' }) });
    const H = sha('bytes-of-ev-1');
    let idWith = '', idWithout = '';
    await check('a NEW quarantine row keeps the proven principal + hash + declared eventId (mapper stage: sourceId and eventId unknown)', async () => {
      const r = await runWithQuarantineScope({ principalReference: A.principalReference, payloadSha256: H, declaredEventId: 'ev-1' }, () => store.record(base('doc-1'))); idWith = r.quarantineId;
      const doc = await rows.findOne({ _id: idWith as never }) as Record<string, unknown>; assert.equal(doc.principalReference, A.principalReference); assert.equal(doc.payloadSha256, H); assert.equal(doc.declaredEventId, 'ev-1'); assert.equal(doc.sourceId, null);
      return { stored: { principalReference: doc.principalReference, declaredEventId: doc.declaredEventId } };
    });
    await check('dedupe identity is unchanged: the same entry without scope hits the SAME row (first write keeps its scope)', async () => {
      const r = await store.record(base('doc-1')); idWithout = r.quarantineId; assert.equal(idWithout, idWith); assert.equal(r.attemptCount, 2);
      assert.equal((await rows.findOne({ _id: idWith as never }) as Record<string, unknown>).principalReference, A.principalReference);
    });
    await check('reconciliation: the OWNER sees `quarantined`; another principal and a legacy-shaped row see nothing', async () => {
      await store.record(base('legacy-row'));                                                                       // no ambient scope: a legacy-shaped row (sourceId null, no principal)
      assert.equal((await svc.confirm(A, 'ev-1', H)).status, 'quarantined'); assert.equal((await svc.confirm(A, 'ev-1', H)).confirmed, false);
      assert.equal((await svc.confirm(B, 'ev-1', H)).status, 'not-found');
      assert.equal((await svc.confirm({ realm: 'test', sourceId: A.sourceId }, 'ev-1', H)).status, 'not-found');     // without the principal the null-sourceId row is unreachable (fail closed)
      assert.equal((await svc.confirm(A, 'ev-1', sha('other bytes'))).status, 'not-found');                          // a row about other bytes does not mask this content
    });
    await check('the principal lookup is an IXSCAN on quarantine_realm_principal_event', async () => {
      const ex = await rows.find({ realm: 'test', principalReference: A.principalReference, declaredEventId: 'ev-1' }).explain('executionStats') as { queryPlanner: { winningPlan: unknown }; executionStats: { totalDocsExamined: number } };
      const st = stages(ex.queryPlanner.winningPlan); assert.ok(st.includes('IXSCAN:quarantine_realm_principal_event'), st.join(',')); assert.equal(st.includes('COLLSCAN'), false); return { stages: st, docs: ex.executionStats.totalDocsExamined };
    });
    await check('LOCAL UPGRADE of a legacy collection: old validator refuses the new fields; after the upgrade they are accepted and old rows stay valid', async () => {
      const oldValidator = JSON.parse(JSON.stringify(quarantineValidator)); for (const k of ['principalReference', 'payloadSha256', 'declaredEventId']) delete oldValidator.$jsonSchema.properties[k];
      const name = quarantineCollection(OLD);
      await db.createCollection(name, { collation: { locale: 'simple' }, validationLevel: 'strict', validationAction: 'error', validator: oldValidator });
      await db.collection(name).createIndexes(quarantineIndexes.slice(0, 2).map(i => ({ ...i, collation: { locale: 'simple' } })) as never);
      const oldStore = createMongoIngestionQuarantineStore({ connection, prefix: OLD, realm: 'test' });
      await oldStore.record(base('legacy-before'));
      await assert.rejects(() => runWithQuarantineScope({ principalReference: A.principalReference, payloadSha256: H, declaredEventId: 'ev-9' }, () => oldStore.record(base('new-before-upgrade'))), /./);   // code must not be deployed before the upgrade
      const up = await upgradeQuarantineScopeBe1311m(connection, OLD); assert.equal(up.status, 'upgraded');
      const r = await runWithQuarantineScope({ principalReference: A.principalReference, payloadSha256: H, declaredEventId: 'ev-9' }, () => oldStore.record(base('new-after-upgrade'))); assert.equal(r.attemptCount, 1);
      assert.equal(await db.collection(name).countDocuments({}), 2); assert.ok((await db.collection(name).indexes()).some(i => i.name === 'quarantine_realm_principal_event'));
      const legacyDoc = await db.collection(name).findOne({ documentDigest: sha('legacy-before') }) as Record<string, unknown>; assert.equal('principalReference' in legacyDoc, false);
      const again = await upgradeQuarantineScopeBe1311m(connection, OLD); assert.equal(again.status, 'upgraded');                                                   // idempotent
      return { upgrade: up.status };
    });
    mkdirSync('.local-evidence', { recursive: true });
    writeFileSync('.local-evidence/be13-11m-quarantine-scope.json', JSON.stringify({ label: 'LOCAL_LAB_EVIDENCE', head, results }, null, 1));
    console.log('BE1311M_LOCAL_OK ' + JSON.stringify({ passed: results.filter(r => r.status === 'passed').length, failed: results.filter(r => r.status === 'failed').length }));
  } finally { await Promise.all(conns.map(c => c.close().catch(() => undefined))); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error('BE1311M_LOCAL_FAILED', JSON.stringify({ message: error instanceof Error ? error.message.slice(0, 400) : 'error' })); process.exit(1); });
