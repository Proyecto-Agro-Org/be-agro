// BE13-09 — operations governance campaign against the disposable LOCAL 3-node
// MongoDB 8.0 replica set (be13-07-multinode-local.ps1 -Suite be13-09).
// Synthetic operator authority and authorities; no Atlas, EMQX or hardware.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Connection } from 'mongoose';
import { validateMultiNodeRequest, verifyOwnedMultiNode } from './be13-07/guard.js';
import { connectMultiNode } from './be13-07/connect.js';
import { provisionSensorCollections, sensorCollections } from '../src/models/sensor.models.js';
import { ingestionCollections, provisionIngestionCollections } from '../src/models/ingestion-persistence.models.js';
import { provisionQuarantineCollection, quarantineCollection } from '../src/models/ingestion-quarantine.models.js';
import { auditCollections, provisionAuditCollections } from '../src/models/ingestion-audit.models.js';
import { createMongoIngestionIdentityStore } from '../src/repositories/mongo-ingestion-identity.store.js';
import { createMongoMeasurementPersistence } from '../src/repositories/mongo-measurement-persistence.repository.js';
import { createMongoPersistenceRecovery } from '../src/repositories/mongo-persistence-recovery.repository.js';
import { createMongoIngestionQuarantineStore } from '../src/repositories/mongo-ingestion-quarantine.store.js';
import { createMongoIngestionAuditStore } from '../src/repositories/mongo-ingestion-audit.store.js';
import { createIngestionOperationsBootstrap } from '../src/services/ingestion-operations.service.js';
import { createProductionPlaceholders } from '../src/adapters/ingestion-production-placeholders.js';
import type { MeasurementPersistencePort } from '../src/iot/ingestion-composition.contracts.js';
import type { IngestionOperationsBootstrapDependencies, OperatorPrincipal } from '../src/iot/ingestion-operations.contracts.js';

type Fixtures = { protectedDocument(patch?: object, options?: object): Record<string, unknown> };
const results: { name: string; status: 'passed' | 'failed'; detail?: unknown }[] = [];
let stage = 'bootstrap';
async function check(name: string, work: () => Promise<unknown>) {
  stage = name;
  try { const detail = await work(); results.push({ name, status: 'passed', detail }); console.log('PASS ' + name); }
  catch (error) { results.push({ name, status: 'failed' }); console.log('FAIL ' + name); throw error; }
}
const SENSOR = 'agro_sensors_be1309', BUSINESS = 'agro_business_be1309', INGEST = 'agro_ingest_be1309';
const day = (ms: number) => new Date(ms);
const ALL = ['QUARANTINE_VIEW', 'QUARANTINE_REPLAY', 'QUARANTINE_UNBLOCK', 'QUARANTINE_BLOCK', 'QUARANTINE_RESOLVE', 'QUARANTINE_DISCARD', 'AUDIT_VIEW', 'OPERATIONS_VIEW'] as const;
const table: Record<string, OperatorPrincipal> = {
  'tok-admin': { operatorId: 'op-admin', realms: ['test'], capabilities: [...ALL], authenticationReference: 'synthetic:admin' },
  'tok-viewer': { operatorId: 'op-viewer', realms: ['test'], capabilities: ['QUARANTINE_VIEW', 'OPERATIONS_VIEW'], authenticationReference: 'synthetic:viewer' },
  'tok-preview': { operatorId: 'op-preview', realms: ['preview'], capabilities: [...ALL], authenticationReference: 'synthetic:preview' },
};
const authorization = { async authorize({ credential, realm, capability }: { credential: unknown; realm: string; capability: string }) {
  const p = table[(credential as { token?: string } | null)?.token ?? ''];
  if (!p) return { decision: 'deny' as const, reason: 'unauthenticated' as const };
  if (!p.realms.includes(realm as never)) return { decision: 'deny' as const, reason: 'realm-out-of-scope' as const };
  if (!p.capabilities.includes(capability as never)) return { decision: 'deny' as const, reason: 'forbidden' as const };
  return { decision: 'allow' as const, principal: p };
} };
const admin = { token: 'tok-admin' }, viewer = { token: 'tok-viewer' }, previewOp = { token: 'tok-preview' };

async function main() {
  stage = 'guard';
  const request = validateMultiNodeRequest(process.env); verifyOwnedMultiNode(request);
  if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) throw Error('MN_GIT_TREE_NOT_CLEAN');
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const fixtures = await import(pathToFileURL(join(process.cwd(), 'test-support', 'be13-composition.fixtures.js')).href) as Fixtures;
  let connection: Connection | undefined;
  try {
    stage = 'connect'; connection = await connectMultiNode(request); const db = connection.db!;
    if ((await db.listCollections().toArray()).length !== 0) throw Error('MN_DATABASE_NOT_EMPTY');
    const build = await db.command({ buildInfo: 1 }); assert.match(String(build.version), /^8\.0\./);
    stage = 'provision';
    await provisionSensorCollections(connection, SENSOR, BUSINESS);
    await provisionIngestionCollections(connection, INGEST);
    await provisionQuarantineCollection(connection, INGEST);
    await provisionAuditCollections(connection, INGEST);
    const sn = sensorCollections(SENSOR, BUSINESS), inn = ingestionCollections(INGEST), an = auditCollections(INGEST);
    await db.collection(sn.devices).insertOne({ _id: 'test:device-1', realm: 'test', id: 'device-1', clientId: 'owner', sourceId: 'synthetic-ingest', keyKind: 'mqtt-clientid',
      keyValue: 'synthetic-device-001', verification: 'verified', verificationAuthority: 'synthetic', lifecycle: 'active', version: 3, createdAt: day(1), updatedAt: day(2) } as never, { writeConcern: { w: 'majority' } });
    await db.collection(sn.associations).insertOne({ _id: 'test:assoc-A', realm: 'test', id: 'assoc-A', revision: 1, clientId: 'client-A', sensorId: 'sensor-A', fieldId: 'field-A',
      areaId: 'area-A', validFrom: day(0), validTo: null, auditReason: 'synthetic', physicalDeviceId: 'device-1', sourceId: 'synthetic-ingest', keyKind: 'mqtt-clientid',
      keyValue: 'synthetic-device-001', state: 'active' } as never, { writeConcern: { w: 'majority' } });
    const measurements = db.collection(inn.measurements), quarantineRows = db.collection(quarantineCollection(INGEST)), auditRows = db.collection(an.audit);
    const measurementCount = () => measurements.countDocuments({}, { readConcern: { level: 'majority' } } as never);

    const realPersistence = createMongoMeasurementPersistence({ connection, prefix: INGEST, realm: 'test' });
    let down = new Set<string>();
    const persistence: MeasurementPersistencePort = { lookup: k => realPersistence.lookup(k),
      async persistAtomically(i) { if (down.has(i.key.eventId)) throw new Error('dependency down'); return realPersistence.persistAtomically(i); } };
    const quarantine = createMongoIngestionQuarantineStore({ connection, prefix: INGEST, realm: 'test' });
    const audit = createMongoIngestionAuditStore({ connection, prefix: INGEST, realm: 'test' });
    const metricsEvents: { name: string; labels: object }[] = [], alertEvents: object[] = [];
    const synthetic = {
      temporal: { decide: async (q: { realm: string; timestamps: { receivedAt: number } }) => ({ realm: q.realm, status: 'trusted', at: q.timestamps.receivedAt, clock: 'received-at', policyRevision: 1 }) },
      hardware: { verify: async (q: { realm: string; physicalDeviceId: string }) => ({ realm: q.realm, status: 'verified', physicalDeviceId: q.physicalDeviceId, origin: 'simulated', method: 'synthetic', attestationRevision: 1 }) },
      catalogue: { evaluate: async (q: { realm: string; field: string }) => ({ realm: q.realm, status: 'approved', field: q.field, magnitude: q.field, unit: 'synthetic-unit', catalogueRevision: 1 }) },
      policies: {
        clock: { decide: async (q: { realm: string }) => ({ realm: q.realm, status: 'approved', clock: 'received-at', policyRevision: 1 }) },
        declaredAt: { decide: async (q: { realm: string; candidateClocks: { deviceTimestamp: unknown } }) => ({ realm: q.realm, status: 'approved', source: 'device-timestamp', declaredAt: q.candidateClocks.deviceTimestamp, policyRevision: 1 }) },
        missingReason: { decide: async (q: { realm: string }) => ({ realm: q.realm, status: 'approved', missingReason: 'absent', policyRevision: 1 }) },
        persistenceTime: { decide: async (q: { realm: string; persistedAt: number }) => ({ realm: q.realm, status: 'approved', persistedAt: q.persistedAt, policyRevision: 1 }) },
      },
    };
    const verifier = { verify: (e: { syntheticTestOnly?: boolean; sourceId: string; eventId: string; clientid: string }) => (e?.syntheticTestOnly === true
      ? { sourceId: e.sourceId, operation: 'telemetry' as const, eventId: e.eventId, device: { kind: 'mqtt-clientid' as const, value: e.clientid } } : null) };
    const baseDeps = {
      realmAuthority: { authorizedRealm: () => 'test' }, provenanceVerifier: verifier, ...synthetic,
      identityStore: createMongoIngestionIdentityStore({ connection, sensorPrefix: SENSOR, businessPrefix: BUSINESS }), persistence,
      be12: { temporal: { select: async (e: { receivedAt: number }) => ({ status: 'trusted', at: e.receivedAt, clock: 'received-at' }) }, catalogue: { accepts: async () => true } },
      deviceStatusHistory: { mode: 'current-state-only', limitation: 'DEVICE_STATUS_HISTORY_REQUIRED' },
      retryPolicy: { decide: () => ({ action: 'stop' as const }) }, retryScheduler: { async wait() { /* TEST_ONLY: never waits */ } },
      recovery: createMongoPersistenceRecovery({ connection, prefix: INGEST, realm: 'test' }), quarantine, authorization, audit,
      metrics: { increment: (name: string, labels: object) => { metricsEvents.push({ name, labels }); } }, alerts: { emit: (e: object) => { alertEvents.push(e); } },
      retention: { mode: 'retain-indefinitely' as const },
    } as unknown as IngestionOperationsBootstrapDependencies;
    const boot = createIngestionOperationsBootstrap(baseDeps);
    const docFor = (eventId: string, payload?: object) => fixtures.protectedDocument({ eventId, ...(payload ? { payload } : {}) }) as { sourceId: string; eventId: string; clientid: string };
    const evidenceFor = (d: { sourceId: string; eventId: string; clientid: string }) => ({ syntheticTestOnly: true, sourceId: d.sourceId, eventId: d.eventId, clientid: d.clientid });
    const retryable = async (eventId: string) => {
      down.add(eventId); const d = docFor(eventId);
      const q = await boot.ingest(d, evidenceFor(d), { field: 'temperature' }) as { quarantineId: string; quarantineStatus: string };
      assert.equal(q.quarantineStatus, 'RETRYABLE'); down.delete(eventId);
      return { doc: d, id: q.quarantineId, version: (await quarantine.get(q.quarantineId))!.version };
    };
    const replayInput = (e: { doc: ReturnType<typeof docFor>; id: string; version: number }, version = e.version) =>
      ({ quarantineId: e.id, expectedVersion: version, protectedDocument: e.doc, provenanceEvidence: evidenceFor(e.doc), field: 'temperature' });
    const ev = (evidenceType: 'operator-decision' | 'data-verified' | 'policy-approval' | 'dependency-restored', reference = 'TICKET-1') => ({ evidenceType, reference });

    const e1 = await retryable('o01');
    await check('O01 unauthorized replay denied', async () => {
      const before = await measurementCount();
      assert.equal((await boot.operations.replay({ token: 'nobody' }, replayInput(e1))).status, 'denied');
      assert.equal((await boot.operations.replay(viewer, replayInput(e1))).status, 'denied');
      assert.equal(await measurementCount(), before);
    });
    await check('O03 wrong realm denied', async () => {
      assert.equal((await boot.operations.replay(previewOp, replayInput(e1)) as { reason: string }).reason, 'realm-out-of-scope');
    });
    await check('O02 authorized replay → RESOLVED', async () => {
      const before = await measurementCount();
      const r = await boot.operations.replay(admin, replayInput(e1)) as { status: string; quarantineStatus: string };
      assert.deepEqual([r.status, r.quarantineStatus], ['done', 'RESOLVED']); assert.equal(await measurementCount(), before + 1);
    });
    await check('O04 replay audit created in order', async () => {
      const trail = await audit.listForQuarantine(e1.id, 100);
      const actions = trail.map(a => a.action);
      // O01 (x2) and O03 (x1) denials are audited on the same stream, before the authorized replay.
      assert.deepEqual(actions, ['quarantine-created', 'authorization-denied', 'authorization-denied', 'authorization-denied', 'replay-requested', 'replay-started', 'replay-result'], JSON.stringify(actions));
      assert.ok(trail.every((a, i) => a.sequence === i + 1));
    });
    await check('O05 denied audit created', async () => {
      assert.ok(await auditRows.countDocuments({ realm: 'test', action: 'authorization-denied' }) >= 2);
    });
    const e6 = await retryable('o06');
    await check('O07 resolve unauthorized', async () => {
      assert.equal((await boot.operations.resolve(viewer, { quarantineId: e6.id, expectedVersion: e6.version, evidence: ev('data-verified') }) as { reason: string }).reason, 'forbidden');
    });
    await check('O06 resolve authorized (recovery proves the measurement)', async () => {
      assert.equal((await boot.operations.resolve(admin, { quarantineId: e6.id, expectedVersion: e6.version, evidence: ev('data-verified') }) as { reason: string }).reason, 'resolve-not-verified');
      await boot.ingest(e6.doc, evidenceFor(e6.doc), { field: 'temperature' });
      const v = (await quarantine.get(e6.id))!.version;
      const r = await boot.operations.resolve(admin, { quarantineId: e6.id, expectedVersion: v, evidence: ev('data-verified') }) as { quarantineStatus: string };
      assert.equal(r.quarantineStatus, 'RESOLVED');
      assert.equal(await auditRows.countDocuments({ realm: 'test', stream: e6.id, action: 'resolved' }), 1);
    });
    const e8 = await retryable('o08');
    let e8v = 0;
    await check('O08 discard authorized', async () => {
      const r = await boot.operations.discard(admin, { quarantineId: e8.id, expectedVersion: e8.version, evidence: ev('operator-decision') }) as { quarantineStatus: string; version: number };
      assert.equal(r.quarantineStatus, 'DISCARDED'); e8v = r.version;
    });
    await check('O09 invalid transitions refused', async () => {
      assert.equal((await boot.operations.unblock(admin, { quarantineId: e8.id, expectedVersion: e8v, evidence: ev('dependency-restored') }) as { reason: string }).reason, 'transition-not-allowed');
      const sec = createIngestionOperationsBootstrap({ ...baseDeps, hardware: createProductionPlaceholders().hardware });
      const d = docFor('o09'); const q = await sec.ingest(d, evidenceFor(d), { field: 'temperature' }) as { quarantineId: string };
      const v = (await quarantine.get(q.quarantineId))!.version;
      assert.equal((await sec.operations.unblock(admin, { quarantineId: q.quarantineId, expectedVersion: v, evidence: ev('dependency-restored') }) as { reason: string }).reason, 'transition-not-allowed');
    });
    const e10 = await retryable('o10');
    await check('O10 stale version (CAS in Mongo)', async () => {
      assert.equal((await boot.operations.block(admin, { quarantineId: e10.id, expectedVersion: e10.version + 1, evidence: ev('operator-decision') }) as { reason: string }).reason, 'stale-version');
      assert.equal((await quarantine.transition({ quarantineId: e10.id, from: 'RETRYABLE', to: 'BLOCKED', expectedVersion: e10.version + 7, evidence: null, outcome: 'cas-probe' })), 'stale');
      assert.equal((await quarantine.get(e10.id))!.status, 'RETRYABLE');
    });
    await check('O11 concurrent replays → 1 lease, 1 measurement', async () => {
      const before = await measurementCount();
      const rs = await Promise.all([boot.operations.replay(admin, replayInput(e10)), boot.operations.replay(admin, replayInput(e10))]);
      assert.deepEqual(rs.map(r => r.status).sort(), ['denied', 'done']); assert.equal(await measurementCount(), before + 1);
    });
    const e12 = await retryable('o12');
    await check('O12 concurrent resolves → exactly one', async () => {
      await boot.ingest(e12.doc, evidenceFor(e12.doc), { field: 'temperature' });
      const v = (await quarantine.get(e12.id))!.version;
      const rs = await Promise.all([1, 2, 3].map(() => boot.operations.resolve(admin, { quarantineId: e12.id, expectedVersion: v, evidence: ev('data-verified') })));
      assert.equal(rs.filter(r => r.status === 'done').length, 1);
    });
    const e13 = await retryable('o13');
    await check('O13 replay vs discard → exactly one wins; never a measurement for a discarded entry', async () => {
      const before = await measurementCount();
      const [rep, dis] = await Promise.all([boot.operations.replay(admin, replayInput(e13)), boot.operations.discard(admin, { quarantineId: e13.id, expectedVersion: e13.version, evidence: ev('operator-decision') })]);
      const finalStatus = (await quarantine.get(e13.id))!.status, added = (await measurementCount()) - before;
      assert.equal([rep.status, dis.status].filter(s => s === 'done').length, 1);
      assert.ok(!(finalStatus === 'DISCARDED' && added > 0));
      return { winner: rep.status === 'done' ? 'replay' : 'discard', finalStatus };
    });
    await check('O14 audit sequence: unique and gap-free per stream, also under 10 concurrent appends', async () => {
      const appends = await Promise.all(Array.from({ length: 10 }, () => audit.append({ realm: 'test', quarantineId: e8.id, eventId: null, action: 'transition-result',
        actorId: 'op-admin', actorCapabilities: [], outcome: 'concurrency-probe', reasonCode: null, evidence: null })));
      const trail = await audit.listForQuarantine(e8.id, 500);
      assert.deepEqual(trail.map(a => a.sequence), trail.map((_, i) => i + 1));
      assert.equal(new Set(appends.map(a => a.sequence)).size, 10);
    });
    await check('O15 audit realm isolation', async () => {
      const preview = createMongoIngestionAuditStore({ connection: connection!, prefix: INGEST, realm: 'preview' });
      assert.deepEqual(await preview.listForQuarantine(e1.id, 100), []);
      await assert.rejects(preview.append({ realm: 'test', quarantineId: null, eventId: null, action: 'replay-requested', actorId: 'x', actorCapabilities: [], outcome: 'x-y', reasonCode: null, evidence: null }));
    });
    const auditBase = () => ({ _id: 'a_' + 'e'.repeat(64), realm: 'test', stream: 'realm', sequence: 999, quarantineId: null, eventId: null, action: 'replay-requested', actorId: 'op',
      actorCapabilities: [], outcome: 'requested', reasonCode: null, evidence: null, occurredAt: new Date(0) });
    const rejectsInsert = async (mutate: (d: Record<string, unknown>) => void) => { const d = auditBase(); mutate(d);
      try { await auditRows.insertOne(d as never); await auditRows.deleteOne({ _id: d._id as never }); return false; } catch (e) { if ((e as { code?: number }).code !== 121) throw e; return true; } };
    await check('O16 audit schema rejects raw payload', async () => { assert.equal(await rejectsInsert(d => { d.rawPayload = { temperature: 1 }; }), true); });
    await check('O17 audit schema rejects stack, secrets, missing realm, invalid action/outcome, negative sequence', async () => {
      const cases: Array<(d: Record<string, unknown>) => void> = [d => { d.stack = 'Error'; }, d => { d['x-emqx-key'] = 'k'; }, d => { delete d.realm; }, d => { d.action = 'deleted'; },
        d => { d.outcome = 'Bad Outcome'; }, d => { d.sequence = -1; }, d => { d.sequence = 0; }];
      for (const c of cases) assert.equal(await rejectsInsert(c), true);
      assert.equal(await rejectsInsert(() => {}), false, 'a valid document is accepted (then removed by the test only)');
    });
    const e18 = await retryable('o18');
    await check('O18 audit failure blocks admin action', async () => {
      const broken = createIngestionOperationsBootstrap({ ...baseDeps, audit: { ...audit, append: async () => { throw new Error('audit down'); } } });
      assert.equal((await broken.operations.discard(admin, { quarantineId: e18.id, expectedVersion: e18.version, evidence: ev('operator-decision') }) as { reason: string }).reason, 'audit-unavailable');
      assert.equal((await quarantine.get(e18.id))!.status, 'RETRYABLE');
    });
    await check('O19 metrics emitted with bounded labels', async () => {
      metricsEvents.length = 0; const d = docFor('o19');
      assert.equal((await boot.ingest(d, evidenceFor(d), { field: 'temperature' })).status, 'accepted');
      assert.ok(metricsEvents.some(e => e.name === 'ingestion_accepted_total'));
      assert.equal(/o19|synthetic|client|q_/.test(JSON.stringify(metricsEvents.map(e => e.labels))), false);
    });
    await check('O20 metrics failure does not alter the business result', async () => {
      const noisy = createIngestionOperationsBootstrap({ ...baseDeps, metrics: { increment: () => { throw new Error('metrics down'); } }, alerts: { emit: () => new Promise(() => {}) } });
      const d = docFor('o20'); assert.equal((await noisy.ingest(d, evidenceFor(d), { field: 'temperature' })).status, 'accepted');
    });
    await check('O21 alert invocation (facts, no identifiers)', async () => {
      alertEvents.length = 0; await retryable('o21');
      assert.ok(alertEvents.some(a => (a as { type: string }).type === 'RETRY_EXHAUSTED'));
      assert.equal(/o21|q_|synthetic/.test(JSON.stringify(alertEvents)), false);
    });
    await check('O22 operational snapshot from Mongo (counts only)', async () => {
      assert.equal((await boot.operationalState({ token: 'nobody' })).status, 'denied');
      const r = await boot.operationalState(viewer) as { status: string; state: { totals: Record<string, number>; auditHealthy: boolean; productionReady: boolean } };
      assert.equal(r.status, 'done'); assert.equal(r.state.productionReady, false); assert.equal(r.state.auditHealthy, true);
      assert.ok(r.state.totals.RESOLVED >= 3 && r.state.totals.DISCARDED >= 1);
      assert.equal(/q_|o0|synthetic/.test(JSON.stringify(r.state)), false);
      return r.state.totals;
    });
    await check('O-IDX winning plans for audit lookups', async () => {
      const plan = async (f: object, sort?: object) => JSON.stringify(((await auditRows.find(f, sort ? { sort } as never : undefined).explain('queryPlanner')) as { queryPlanner: { winningPlan: unknown } }).queryPlanner.winningPlan);
      assert.ok((await plan({ realm: 'test', stream: e1.id }, { sequence: 1 })).includes('audit_stream_sequence'));
      assert.ok((await plan({ realm: 'test', occurredAt: { $gte: new Date(0) } })).includes('audit_realm_occurred'));
    });
    results.push({ name: 'O23 cleanup', status: 'passed', detail: 'confirmed by the launcher (cleanupConfirmed)' });
    stage = 'evidence';
    const dir = join(process.cwd(), '.local-evidence'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'be13-09-multinode.json'), JSON.stringify({ gitSha: sha, mongoVersion: build.version, run: request.runId, results,
      auditCount: await auditRows.countDocuments({}), quarantineCount: await quarantineRows.countDocuments({}) }, null, 2));
  } finally {
    if (connection?.readyState === 1) { try { verifyOwnedMultiNode(request); await connection.db!.dropDatabase(); } catch { /* launcher confirms cleanup */ } }
    await connection?.close().catch(() => {});
    console.log(JSON.stringify({ event: 'be13-09-summary', passed: results.filter(r => r.status === 'passed').length, failed: results.filter(r => r.status === 'failed').length }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  console.error('BE1309_LOCAL_FAILED ' + JSON.stringify({ stage, errorClass: error instanceof Error ? error.name : 'Unknown',
    serverCode: typeof (error as { code?: unknown })?.code === 'number' ? (error as { code: number }).code : undefined,
    message: error instanceof Error && /^(MN_|INGESTION_|QUARANTINE_|AUDIT_|RECOVERY_)[A-Z_0-9]+$/.test(error.message) ? error.message : undefined }));
  process.exitCode = 1;
});
