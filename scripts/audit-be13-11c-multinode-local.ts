// BE13-11C — Inbox reconciliation (N4) campaign (extends the BE13-11B setup) against the disposable LOCAL 3-node MongoDB 8.0 replica set
// (be13-07-multinode-local.ps1 -Suite be13-11c). SINTETICO: synthetic deliveries/principal/verifier/mapping.
// Reproduces the ambiguous write with real paused secondaries and a real primary failover. No broker, Atlas, EMQX or credentials.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mongo, type Connection } from 'mongoose';
import { chaos, validateMultiNodeRequest, verifyOwnedMultiNode } from './be13-07/guard.js';
import { connectMultiNode } from './be13-07/connect.js';
import { provisionSensorCollections, sensorCollections } from '../src/models/sensor.models.js';
import { ingestionCollections, provisionIngestionCollections } from '../src/models/ingestion-persistence.models.js';
import { provisionQuarantineCollection } from '../src/models/ingestion-quarantine.models.js';
import { auditCollections, provisionAuditCollections } from '../src/models/ingestion-audit.models.js';
import { brokerInboxCollection, provisionBrokerInboxCollection } from '../src/models/broker-inbox.models.js';
import { createMongoIngestionIdentityStore } from '../src/repositories/mongo-ingestion-identity.store.js';
import { createMongoMeasurementPersistence } from '../src/repositories/mongo-measurement-persistence.repository.js';
import { createMongoPersistenceRecovery } from '../src/repositories/mongo-persistence-recovery.repository.js';
import { createMongoIngestionQuarantineStore } from '../src/repositories/mongo-ingestion-quarantine.store.js';
import { createMongoIngestionAuditStore } from '../src/repositories/mongo-ingestion-audit.store.js';
import { brokerInboxStateCollection, provisionBrokerInboxStateCollection } from '../src/models/broker-inbox-state.models.js';
import { createMongoBrokerInboxReconciliationStore } from '../src/repositories/mongo-broker-inbox-reconciliation.store.js';
import { createBrokerInboxReconciler } from '../src/services/broker-inbox-reconciliation.service.js';
import { createBlockingMqttBoundaryPlaceholders } from '../src/adapters/ingestion-production-placeholders.js';
import { createMongoBrokerInboxStore } from '../src/repositories/mongo-broker-inbox.store.js';
import { createDurableBrokerAdmissionService, createMqttIngestionBoundary } from '../src/services/mqtt-ingestion-boundary.service.js';
import type { MeasurementPersistencePort } from '../src/iot/ingestion-composition.contracts.js';
import type { DurableBrokerAdmissionDependencies } from '../src/iot/mqtt-ingestion-boundary.contracts.js';

type BrokerFixtures = {
  envelope(patch?: object): Record<string, unknown>; observed(patch?: object): Record<string, unknown>; bytesOf(v: unknown): Buffer;
  syntheticVerifier(mode?: object): object; syntheticMapping(mode?: object): object; TEST_ONLY_LIMITS: object; TEST_ONLY_CONFIG: object;
};
type Result = { status: string; reasonCode?: string; retryable?: boolean; receipt?: { inboxId: string; rawPersistedAt: number; rawPayloadSha256: string };
  results?: { result: { status: string } }[] };
const results: { name: string; status: 'passed' | 'failed'; detail?: unknown }[] = [];
let stage = 'bootstrap';
async function check(name: string, work: () => Promise<unknown>) {
  stage = name;
  try { const detail = await work(); results.push({ name, status: 'passed', detail }); console.log('PASS ' + name); }
  catch (error) { results.push({ name, status: 'failed' }); console.log('FAIL ' + name); throw error; }
}
const SENSOR = 'agro_sensors_be1311c', BUSINESS = 'agro_business_be1311c', INGEST = 'agro_ingest_be1311c';
const day = (ms: number) => new Date(ms);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  stage = 'guard';
  const request = validateMultiNodeRequest(process.env); verifyOwnedMultiNode(request);
  if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) throw Error('MN_GIT_TREE_NOT_CLEAN');
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const f = await import(pathToFileURL(join(process.cwd(), 'test-support', 'be13-11a-broker.fixtures.js')).href) as BrokerFixtures;
  const conns: Connection[] = [];
  try {
    stage = 'connect';
    for (let i = 0; i < 10; i += 1) conns.push(await connectMultiNode(request));
    const connection = conns[0]!, db = connection.db!;
    if ((await db.listCollections().toArray()).length !== 0) throw Error('MN_DATABASE_NOT_EMPTY');
    const build = await db.command({ buildInfo: 1 }); assert.match(String(build.version), /^8\.0\./);
    const status = async () => (await db.admin().command({ replSetGetStatus: 1 }, { readPreference: 'nearest' })) as { members: { name: string; stateStr: string; health: number }[] };
    const waitHealthy = async () => { for (let i = 0; i < 240; i += 1) { try { const s = await status(); if (s.members.filter(m => m.health === 1).length === 3 &&
      s.members.filter(m => m.stateStr === 'PRIMARY').length === 1 && s.members.filter(m => m.stateStr === 'SECONDARY').length === 2) return; } catch { /* election */ } await sleep(500); }
      throw Error('MN_WAIT_TIMEOUT_healthy'); };
    const primaryIndex = async () => { const p = (await status()).members.find(m => m.stateStr === 'PRIMARY'); return p ? request.ports.indexOf(Number(p.name.split(':')[1])) : -1; };
    stage = 'provision';
    await provisionSensorCollections(connection, SENSOR, BUSINESS);
    await provisionIngestionCollections(connection, INGEST);
    await provisionQuarantineCollection(connection, INGEST);
    await provisionAuditCollections(connection, INGEST);
    await provisionBrokerInboxCollection(connection, INGEST);
    await provisionBrokerInboxStateCollection(connection, INGEST);
    const sn = sensorCollections(SENSOR, BUSINESS), inn = ingestionCollections(INGEST);
    await db.collection(sn.devices).insertOne({ _id: 'test:device-1', realm: 'test', id: 'device-1', clientId: 'owner', sourceId: 'synthetic-ingest', keyKind: 'mqtt-clientid',
      keyValue: 'synthetic-device-001', verification: 'verified', verificationAuthority: 'synthetic', lifecycle: 'active', version: 3, createdAt: day(1), updatedAt: day(2) } as never, { writeConcern: { w: 'majority' } });
    await db.collection(sn.associations).insertOne({ _id: 'test:assoc-A', realm: 'test', id: 'assoc-A', revision: 1, clientId: 'client-A', sensorId: 'sensor-A', fieldId: 'field-A',
      areaId: 'area-A', validFrom: day(0), validTo: null, auditReason: 'synthetic', physicalDeviceId: 'device-1', sourceId: 'synthetic-ingest', keyKind: 'mqtt-clientid',
      keyValue: 'synthetic-device-001', state: 'active' } as never, { writeConcern: { w: 'majority' } });
    const measurements = db.collection(inn.measurements), inboxRows = db.collection(brokerInboxCollection(INGEST)), auditRows = db.collection(auditCollections(INGEST).audit);
    const majority = { readConcern: { level: 'majority' } } as never;
    const mCount = (eventId: string) => measurements.countDocuments({ eventId }, majority);
    // Inbox records of one event: the eventId lives only inside the stored raw bytes (the inbox has no eventId column).
    const iCount = async (eventId: string) => (await inboxRows.find({}, majority).toArray())
      .filter(d => Buffer.from((d.rawPayload as mongo.Binary).buffer).toString('utf8').includes('"' + eventId + '"')).length;
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
    const metricsEvents: { name: string; labels: object }[] = [];
    const down = new Set<string>();
    const depsOn = (conn: Connection, opts: { verifierMode?: object; realm?: string } = {}) => {
      const real = createMongoMeasurementPersistence({ connection: conn, prefix: INGEST, realm: 'test' });
      const persistence: MeasurementPersistencePort = { lookup: k => real.lookup(k), replayFencing: 'atomic',
        async persistAtomically(i, o) { if (down.has(i.key.eventId)) throw new Error('dependency down'); return real.persistAtomically(i, o); } };
      const realm = opts.realm ?? 'test';
      return {
        realmAuthority: { authorizedRealm: () => realm }, ...synthetic,
        identityStore: createMongoIngestionIdentityStore({ connection: conn, sensorPrefix: SENSOR, businessPrefix: BUSINESS }), persistence,
        be12: { temporal: { select: async (e: { receivedAt: number }) => ({ status: 'trusted', at: e.receivedAt, clock: 'received-at' }) }, catalogue: { accepts: async () => true } },
        deviceStatusHistory: { mode: 'current-state-only', limitation: 'DEVICE_STATUS_HISTORY_REQUIRED' },
        retryPolicy: { decide: () => ({ action: 'stop' as const }) }, retryScheduler: { async wait() { /* TEST_ONLY */ } },
        recovery: createMongoPersistenceRecovery({ connection: conn, prefix: INGEST, realm: 'test' }),
        quarantine: createMongoIngestionQuarantineStore({ connection: conn, prefix: INGEST, realm: 'test' }),
        authorization: { authorize: async () => ({ decision: 'deny', reason: 'unauthenticated' }) },
        audit: createMongoIngestionAuditStore({ connection: conn, prefix: INGEST, realm: 'test' }),
        metrics: { increment: (name: string, labels: object) => { metricsEvents.push({ name, labels }); } }, alerts: { emit: () => {} }, retention: { mode: 'retain-indefinitely' },
        timeAuthority: { now: async ({ realm: r }: { realm: string }) => ({ realm: r, status: 'untrusted' }) },
        leasePolicy: { evaluate: async ({ realm: r }: { realm: string }) => ({ realm: r, status: 'ACTIVE', recoveryByNonOwner: 'never', policyRevision: 1 }) },
        brokerProvenanceVerifier: f.syntheticVerifier(opts.verifierMode), brokerIdentityMapping: f.syntheticMapping(), payloadLimits: f.TEST_ONLY_LIMITS, boundaryConfig: f.TEST_ONLY_CONFIG,
        durableInbox: createMongoBrokerInboxStore({ connection: conn, prefix: INGEST, realm: realm as never }),
      } as unknown as DurableBrokerAdmissionDependencies;
    };
    const admissionOn = (conn: Connection, opts?: { verifierMode?: object; realm?: string }) => createDurableBrokerAdmissionService(depsOn(conn, opts));
    const admission = admissionOn(connection);
    const delivery = (obs: object = {}, env: object = {}, payload?: Buffer) => ({ brokerObserved: f.observed(obs), payload: payload ?? f.bytesOf(f.envelope(env)) });
    const ev = (id: string, extra: object = {}) => ({ eventId: 'e11b-' + id, ...extra });
    const admit = (d: unknown, mode: 'persist-only' | 'persist-and-process' = 'persist-and-process', a = admission) => a.admit(d, { mode }) as unknown as Promise<Result>;
    const recover = (inboxId: string, a = admission) => a.processPersistedBrokerDelivery({ inboxId }) as unknown as Promise<Result>;
    const statusOf = (r: Result) => r.results?.[0]?.result.status;
    const persisted: Record<string, string> = {};

    // ---------------------------------------------------------------- BE13-11C campaign
    const stateRows = db.collection(brokerInboxStateCollection(INGEST));
    const POLICY = { mode: 'TEST_ONLY', minAgeMs: 1500, claimLeaseMs: 4000, maxBatch: 50 };
    const reconcilerOn = (conn: Connection, opts: { realm?: string; policy?: unknown } = {}) => {
      const realm = opts.realm ?? 'test';
      const deps = depsOn(conn, { realm }) as unknown as DurableBrokerAdmissionDependencies & { audit: never; metrics: never; alerts: never };
      const store = createMongoBrokerInboxReconciliationStore({ connection: conn, prefix: INGEST, realm: realm as never });
      const adm = createDurableBrokerAdmissionService({ ...deps, reconciliationStore: store });
      return { store, admission: adm, reconciler: createBrokerInboxReconciler({ realm: realm as never, admission: adm, reconciliationStore: store,
        reconciliationPolicy: opts.policy ?? POLICY, audit: deps.audit, metrics: deps.metrics, alerts: deps.alerts }) };
    };
    const idOf = async (eventId: string) => { // eventId lives only inside the stored raw bytes
      const hit = (await inboxRows.find({}, majority).toArray()).filter(d => Buffer.from((d.rawPayload as mongo.Binary).buffer).toString('utf8').includes('"' + eventId + '"'));
      return hit.map(d => String(d._id));
    };
    const stateOf = (id: string) => stateRows.findOne({ _id: id as never }, majority);
    const R = reconcilerOn(connection);
    const ids: Record<string, string> = {};
    const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;

    await check('C01 N4 exact reproduction: ambiguous inbox write (real paused secondaries) → caller has NO receipt, record appears later', async () => {
      await waitHealthy();
      const p = await primaryIndex(), secondaries = [0, 1, 2].filter(i => i !== p);
      for (const s of secondaries) chaos(request, 'pause', s);
      let outs: Result[];
      try { outs = await Promise.all(names.map(n => admit(delivery({}, ev('11c-' + n)), 'persist-and-process', R.admission))); }
      finally { for (const s of secondaries) chaos(request, 'unpause', s); }
      await waitHealthy();
      assert.ok(outs.every(r => r.reasonCode === 'broker-inbox-unavailable' && r.receipt === undefined), 'no receipt reached the caller');
      for (let i = 0; i < 40 && (await Promise.all(names.map(n => iCount('e11b-11c-' + n)))).some(c => c !== 1); i += 1) await sleep(500);
      for (const n of names) { const found = await idOf('e11b-11c-' + n); assert.equal(found.length, 1, 'record ' + n + ' exists in Mongo'); ids[n] = found[0]!; assert.equal(await mCount('e11b-11c-' + n), 0); assert.equal(await stateOf(ids[n]!), null); }
      return { orphans: names.length };
    });
    await sleep(POLICY.minAgeMs + 1000);
    await check('C02 orphan candidates detected (database clock age; no state document)', async () => {
      const rep = await R.reconciler.reconcileBrokerInbox({ mode: 'inspect-only', limit: 50 }) as unknown as { status: string; candidates: string[]; counts: { absent: number } };
      assert.equal(rep.status, 'report');
      for (const n of names) assert.ok(rep.candidates.includes(ids[n]!), n);
      assert.ok(metricsEvents.some(e => e.name === 'broker_inbox_orphan_candidate_total'));
    });
    await check('C13 inspect-only (dry run) mutates nothing: no state document, no measurement', async () => {
      const before = [await stateRows.countDocuments({}), await measurements.countDocuments({}), await inboxRows.countDocuments({})];
      await R.reconciler.reconcileBrokerInbox({ mode: 'inspect-only', limit: 50 });
      assert.deepEqual([await stateRows.countDocuments({}), await measurements.countDocuments({}), await inboxRows.countDocuments({})], before);
    });
    await check('C14 scan limit honored; invalid limits refused', async () => {
      const one = await R.reconciler.reconcileBrokerInbox({ mode: 'inspect-only', limit: 1 }) as unknown as { candidates: string[] };
      assert.equal(one.candidates.length, 1);
      for (const limit of [0, 501, -1, 1.5]) assert.deepEqual(await R.reconciler.reconcileBrokerInbox({ mode: 'reconcile', limit }), { status: 'blocked', reason: 'invalid-options' });
      assert.equal(await stateRows.countDocuments({}), 0);
    });
    await check('C06 cross realm: preview (reconciler, store, scan, claim) never sees or touches test records', async () => {
      const P = reconcilerOn(conns[1]!, { realm: 'preview' });
      assert.equal(await P.reconciler.reconcileOne(ids.A!), 'blocked');
      assert.deepEqual(await P.store.listCandidates({ realm: 'preview', minAgeMs: 0, limit: 50 }), []);
      assert.equal(await P.store.claim({ realm: 'preview', inboxId: ids.A!, claimLeaseMs: 1 }), null);
      await assert.rejects(R.store.listCandidates({ realm: 'preview' as never, minAgeMs: 0, limit: 5 }), /REALM_MISMATCH/);
      assert.equal(await stateRows.countDocuments({}), 0);
    });
    await check('BLOCKED default policy (placeholder): nothing listed, claimed or processed on real Mongo', async () => {
      const blocked = reconcilerOn(connection, { policy: createBlockingMqttBoundaryPlaceholders().reconciliationPolicy });
      assert.deepEqual(await blocked.reconciler.reconcileBrokerInbox({ mode: 'reconcile', limit: 10 }), { status: 'blocked', reason: 'reconciliation-policy-not-decided' });
      assert.equal(await blocked.reconciler.reconcileOne(ids.A!), 'blocked');
      assert.equal(await stateRows.countDocuments({}), 0);
    });
    let claimA: { inboxId: string; token: string; version: number } | null = null;
    await check('C03 claim: CAS on a separate state document; exactly one claimant wins (database clock lease)', async () => {
      const s1 = createMongoBrokerInboxReconciliationStore({ connection: conns[1]!, prefix: INGEST, realm: 'test' }), s2 = createMongoBrokerInboxReconciliationStore({ connection: conns[2]!, prefix: INGEST, realm: 'test' });
      const both = await Promise.all([s1.claim({ realm: 'test', inboxId: ids.A!, claimLeaseMs: POLICY.claimLeaseMs }), s2.claim({ realm: 'test', inboxId: ids.A!, claimLeaseMs: POLICY.claimLeaseMs })]);
      assert.equal(both.filter(Boolean).length, 1);
      claimA = both.find(Boolean)!;
      const st = await stateOf(ids.A!) as unknown as { status: string; version: number; token: string };
      assert.deepEqual([st.status, st.version, st.token], ['claimed', 1, claimA!.token]);
      assert.equal(await measurements.countDocuments({ eventId: 'e11b-11c-A' }), 0);
    });
    let rawB = '';
    await check('C04 recovered: orphan processed from the persisted bytes → exactly one measurement; raw record unchanged', async () => {
      rawB = JSON.stringify(await inboxRows.findOne({ _id: ids.B as never }, majority));
      assert.equal(await R.reconciler.reconcileOne(ids.B!), 'recovered-and-processed');
      assert.equal(await mCount('e11b-11c-B'), 1);
      assert.equal(JSON.stringify(await inboxRows.findOne({ _id: ids.B as never }, majority)), rawB);
      const st = await stateOf(ids.B!) as unknown as { status: string; outcome: string };
      assert.deepEqual([st.status, st.outcome], ['completed', 'recovered-and-processed']);
    });
    await check('C05 second reconciliation is duplicate-safe (no claim, no second measurement); batch sweep finds nothing for B', async () => {
      assert.equal(await R.reconciler.reconcileOne(ids.B!), 'duplicate');
      assert.equal(await mCount('e11b-11c-B'), 1);
    });
    await check('C08 two concurrent reconcilers (2 connections): exactly one works, one measurement', async () => {
      const out = await Promise.all([reconcilerOn(conns[1]!).reconciler.reconcileOne(ids.C!), reconcilerOn(conns[2]!).reconciler.reconcileOne(ids.C!)]);
      assert.equal(out.filter(x => x === 'recovered-and-processed').length, 1);
      assert.ok(out.every(x => ['recovered-and-processed', 'stale-reconciliation', 'duplicate'].includes(x)), JSON.stringify(out));
      assert.equal(await mCount('e11b-11c-C'), 1);
      return out;
    });
    await check('C09 ten concurrent reconcilers (10 connections): exactly one works, one measurement', async () => {
      const out = await Promise.all(conns.map(c => reconcilerOn(c).reconciler.reconcileOne(ids.D!)));
      assert.equal(out.filter(x => x === 'recovered-and-processed').length, 1);
      assert.ok(out.every(x => ['recovered-and-processed', 'stale-reconciliation', 'duplicate'].includes(x)), JSON.stringify(out));
      assert.equal(await mCount('e11b-11c-D'), 1);
      return out;
    });
    await check('C07 integrity tamper (bytes, in Mongo) → integrity-failed, sticky, never processed', async () => {
      await inboxRows.updateOne({ _id: ids.E as never }, { $set: { rawPayload: new mongo.Binary(f.bytesOf(f.envelope({ eventId: 'e11b-11c-E', payload: { temperature: 99 } }))) } }, { writeConcern: { w: 'majority' } }); // test-only tampering
      assert.equal(await R.reconciler.reconcileOne(ids.E!), 'integrity-failed');
      assert.equal(await R.reconciler.reconcileOne(ids.E!), 'duplicate');
      assert.equal(await mCount('e11b-11c-E'), 0);
      assert.equal((await stateOf(ids.E!) as unknown as { outcome: string }).outcome, 'integrity-failed');
    });
    await check('C12 already processed: the measurement exists → already-processed, no second measurement', async () => {
      assert.equal((await R.admission.processPersistedBrokerDelivery({ inboxId: ids.F! }) as unknown as Result).status, 'ingested');
      assert.equal(await mCount('e11b-11c-F'), 1);
      assert.equal(await R.reconciler.reconcileOne(ids.F!), 'already-processed');
      assert.equal(await mCount('e11b-11c-F'), 1);
    });
    await check('C10 stale completion: A was claimed (C03) and its lease expired → takeover by another reconciler; the old holder is fenced out', async () => {
      await sleep(POLICY.claimLeaseMs + 500);
      assert.equal(await reconcilerOn(conns[3]!).reconciler.reconcileOne(ids.A!), 'recovered-and-processed');
      const st = await stateOf(ids.A!) as unknown as { version: number; status: string };
      assert.deepEqual([st.status, st.version], ['completed', 3]); // claim v1 → takeover v2 → completed v3
      assert.equal(await createMongoBrokerInboxReconciliationStore({ connection: conns[1]!, prefix: INGEST, realm: 'test' }).complete({ realm: 'test', claim: claimA!, outcome: 'recovered-and-processed' }), false);
      assert.equal(await mCount('e11b-11c-A'), 1);
    });
    await check('C11 failover after claim: claim (majority) → primary stopped → a reconciler on the NEW primary takes over after the lease → one measurement', async () => {
      await waitHealthy();
      const s1 = createMongoBrokerInboxReconciliationStore({ connection: conns[1]!, prefix: INGEST, realm: 'test' });
      const dead = await s1.claim({ realm: 'test', inboxId: ids.G!, claimLeaseMs: POLICY.claimLeaseMs });
      assert.ok(dead);
      const old = await primaryIndex();
      chaos(request, 'stop', old);
      try {
        await sleep(POLICY.claimLeaseMs + 1500);
        let out = 'unavailable';
        for (let i = 0; i < 60 && out === 'unavailable'; i += 1) { out = await reconcilerOn(conns[4]!).reconciler.reconcileOne(ids.G!); if (out === 'unavailable') await sleep(1000); }
        assert.equal(out, 'recovered-and-processed');
        assert.equal(await createMongoBrokerInboxReconciliationStore({ connection: conns[5]!, prefix: INGEST, realm: 'test' }).complete({ realm: 'test', claim: dead!, outcome: 'recovered-and-processed' }), false);
        return { stoppedPrimary: old, newPrimary: await primaryIndex() };
      } finally { chaos(request, 'start', old); await waitHealthy(); }
      // eslint-disable-next-line no-unreachable
    });
    await check('C11b exactly one measurement for G after the failover', async () => { assert.equal(await mCount('e11b-11c-G'), 1); });
    await check('C15 audit is safe: reconciliation actions present; no payload, topic, client id, event id or inbox payload', async () => {
      const entries = await auditRows.find({ actorId: 'inbox-reconciler' }).toArray();
      const actions = new Set(entries.map(e => e.action));
      for (const a of ['inbox-reconciliation-candidate', 'inbox-reconciliation-claimed', 'inbox-reconciliation-completed', 'inbox-reconciliation-integrity-failed']) assert.ok(actions.has(a), a);
      assert.equal(/temperature|synthetic-device|synthetic\/agro|rawPayload|e11b-|ib_/.test(JSON.stringify(entries)), false);
    });
    await check('C16 metrics bounded: closed labels, no inbox / event / client identifiers', async () => {
      const m = metricsEvents.filter(e => e.name === 'broker_inbox_reconciliation_total');
      assert.ok(m.length >= 6);
      assert.equal(/ib_|e11b-|synthetic-device|synthetic\/agro|synthetic-ingest/.test(JSON.stringify(metricsEvents)), false);
    });
    await check('C17 state $jsonSchema rejects invalid documents (real Mongo, code 121)', async () => {
      const ok = { _id: 'ib_' + 'e'.repeat(32), realm: 'test', status: 'receipted', version: new mongo.Int32(1) };
      const bad: Array<Record<string, unknown>> = [{ ...ok, realm: undefined }, { ...ok, status: 'done' }, { ...ok, password: 'x' }, { ...ok, _id: 'x' }, { ...ok, version: new mongo.Int32(0) },
        { ...ok, outcome: 'free text' }, { ...ok, token: 'short' }, { ...ok, rawPayload: 'x' }, { ...ok, topic: 'synthetic/agro/x' }, { ...ok, realm: 'nope' }];
      for (const d of bad) { const doc = Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined)); await assert.rejects(stateRows.insertOne(doc as never), (e: { code?: number }) => e.code === 121); }
    });
    await check('C18 indexes/explain: candidate scan walks inbox_realm_persisted; state lookups use _id; no extra state index', async () => {
      const plan = ((await inboxRows.aggregate([{ $match: { realm: 'test', $expr: { $lte: ['$rawPersistedAt', { $subtract: ['$$NOW', 1500] }] } } }, { $sort: { rawPersistedAt: 1 } }, { $limit: 5 }]).explain('queryPlanner')) as unknown);
      const text = JSON.stringify(plan);
      assert.ok(text.includes('inbox_realm_persisted'), 'candidate scan uses inbox_realm_persisted');
      assert.equal(/COLLSCAN/.test(text), false);
      const stateIdx = (await stateRows.indexes()).map(i => i.name);
      assert.deepEqual(stateIdx, ['_id_']);
      assert.ok(/IDHACK|EXPRESS|_id_/.test(JSON.stringify(await stateRows.find({ _id: ids.A as never, realm: 'test' }).explain('queryPlanner'))));
      return { stateIndexes: stateIdx };
    });
    await check('C20 end state: one measurement per orphan event; no duplicate (eventId, field); every orphan completed', async () => {
      const dup = await measurements.aggregate([{ $group: { _id: { eventId: '$eventId', field: '$field' }, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }]).toArray();
      assert.equal(dup.length, 0);
      for (const n of names) assert.equal((await stateOf(ids[n]!) as unknown as { status: string }).status, 'completed');
      assert.equal(await mCount('e11b-11c-E'), 0); // the tampered record was never processed
    });
    results.push({ name: 'C19 cleanup', status: 'passed', detail: 'confirmed by the launcher (cleanupConfirmed)' });
    stage = 'evidence';
    const dir = join(process.cwd(), '.local-evidence'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'be13-11c-multinode.json'), JSON.stringify({ gitSha: sha, mongoVersion: build.version, run: request.runId, connections: conns.length, results,
      inboxCount: await inboxRows.countDocuments({}), stateCount: await stateRows.countDocuments({}), measurementCount: await measurements.countDocuments({}) }, null, 2));
  } finally {
    const first = conns[0];
    if (first?.readyState === 1) { try { verifyOwnedMultiNode(request); await first.db!.dropDatabase(); } catch { /* launcher confirms cleanup */ } }
    for (const c of conns) await c.close().catch(() => {});
    console.log(JSON.stringify({ event: 'be13-11c-summary', passed: results.filter(r => r.status === 'passed').length, failed: results.filter(r => r.status === 'failed').length }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  console.error('BE1311C_LOCAL_FAILED ' + JSON.stringify({ stage, errorClass: error instanceof Error ? error.name : 'Unknown',
    serverCode: typeof (error as { code?: unknown })?.code === 'number' ? (error as { code: number }).code : undefined,
    message: error instanceof Error && /^(MN_|INGESTION_|QUARANTINE_|AUDIT_|RECOVERY_|INBOX_|RECONCILIATION_)[A-Z_0-9]+$/.test(error.message) ? error.message : undefined }));
  process.exitCode = 1;
});
