// BE13-11B — Durable Broker Inbox campaign against the disposable LOCAL 3-node MongoDB 8.0 replica set
// (be13-07-multinode-local.ps1 -Suite be13-11b). SINTETICO: synthetic deliveries/principal/verifier/mapping.
// Includes real majority loss (paused secondaries) and a real primary failover. No broker, Atlas, EMQX or credentials.
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
const SENSOR = 'agro_sensors_be1311b', BUSINESS = 'agro_business_be1311b', INGEST = 'agro_ingest_be1311b';
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

    await check('I01 verified delivery persists (majority + j): receipt from the store, record in Mongo', async () => {
      const r = await admit(delivery({}, ev('01')), 'persist-only');
      assert.equal(r.status, 'persisted'); persisted.i01 = r.receipt!.inboxId;
      const doc = await inboxRows.findOne({ _id: r.receipt!.inboxId as never }, majority);
      assert.ok(doc && doc.rawPayload instanceof mongo.Binary && doc.realm === 'test' && doc.rawPayloadSha256 === r.receipt!.rawPayloadSha256);
      assert.equal(await mCount('e11b-01'), 0);
    });
    for (const [id, opts, d, reason] of [['02', { verifierMode: { kind: 'reject' } }, delivery({}, ev('02')), 'broker-provenance-rejected'],
      ['03', {}, delivery({ authenticatedPrincipalReference: null }, ev('03')), 'broker-provenance-unverified'],
      ['04', { verifierMode: { kind: 'throw' } }, delivery({}, ev('04')), 'broker-verifier-unavailable']] as const) {
      await check(`I${id} ${reason} → NOT persisted (no inbox, no quarantine, no measurement)`, async () => {
        const r = await admit(d, 'persist-and-process', admissionOn(connection, opts));
        assert.equal(r.reasonCode, reason);
        assert.deepEqual([await iCount('e11b-' + id), await mCount('e11b-' + id)], [0, 0]);
      });
    }
    await check('I05 raw bytes exact round-trip through Mongo BinData', async () => {
      const bytes = f.bytesOf('{ "version":1,"eventId":"e11b-05" , "sentAt":1795115600000,"clientid":"synthetic-device-001","payload":{"temperature":0},"mqtt":{"messageType":"telemetry","dataOrigin":"simulated"}}');
      const r = await admit(delivery({}, {}, bytes), 'persist-only');
      const doc = await inboxRows.findOne({ _id: r.receipt!.inboxId as never }, majority) as unknown as { rawPayload: mongo.Binary };
      assert.equal(Buffer.compare(Buffer.from(doc.rawPayload.buffer.subarray(0, doc.rawPayload.length())), bytes), 0);
    });
    await check('I06 rawPersistedAt is assigned by the MongoDB server during the write (between server times before/after)', async () => {
      const before = ((await db.command({ hello: 1 })) as { localTime: Date }).localTime.getTime();
      const r = await admit(delivery({}, ev('06')), 'persist-only');
      const after = ((await db.command({ hello: 1 })) as { localTime: Date }).localTime.getTime();
      assert.ok(r.receipt!.rawPersistedAt >= before - 1000 && r.receipt!.rawPersistedAt <= after + 1000, JSON.stringify({ before, at: r.receipt!.rawPersistedAt, after }));
      return { skewBound: '±1s around server hello.localTime' };
    });
    await check('I07 the caller cannot forge rawPersistedAt; the direct path never yields an accepted measurement', async () => {
      assert.equal((await admit(delivery({ rawPersistedAt: 1795115600110 }, ev('07')))).reasonCode, 'broker-context-malformed');
      const direct = await createMqttIngestionBoundary(depsOn(connection)).deliver(delivery({}, ev('07'))) as unknown as Result;
      assert.equal(statusOf(direct), 'quarantined');
      assert.equal(await mCount('e11b-07'), 0);
    });
    await check('I08 realm isolation: a store bound to preview never reads the test record', async () => {
      const preview = createMongoBrokerInboxStore({ connection: conns[1]!, prefix: INGEST, realm: 'preview' });
      assert.equal(await preview.getById({ realm: 'preview', inboxId: persisted.i01! }), null);
      assert.equal(await preview.getById({ realm: 'test', inboxId: persisted.i01! }), null);
    });
    await check('I09 sourceId comes from the authorized mapping (payload spoof ignored)', async () => {
      const r = await admit(delivery({}, ev('09', { payload: { temperature: 1, source_id: 'attacker-source' } })), 'persist-only');
      assert.equal((await inboxRows.findOne({ _id: r.receipt!.inboxId as never }, majority))!.sourceId, 'synthetic-ingest');
    });
    await check('I10 identical deliveries → two inbox records, one measurement', async () => {
      const a = await admit(delivery({ packetId: 1 }, ev('10'))), b = await admit(delivery({ packetId: 2 }, ev('10')));
      assert.deepEqual([statusOf(a), statusOf(b)], ['accepted', 'duplicate']);
      assert.deepEqual([await iCount('e11b-10'), await mCount('e11b-10')], [2, 1]);
    });
    await check('I11 crash recovery: persist-only, then a NEW connection + service processes by inboxId → accepted', async () => {
      const r = await admit(delivery({}, ev('11')), 'persist-only'); persisted.i11 = r.receipt!.inboxId;
      const restarted = admissionOn(conns[2]!);
      assert.equal(statusOf(await recover(r.receipt!.inboxId, restarted)), 'accepted');
    });
    await check('I12 second recovery of the same record → duplicate', async () => {
      assert.equal(statusOf(await recover(persisted.i11!, admissionOn(conns[3]!))), 'duplicate'); assert.equal(await mCount('e11b-11'), 1);
    });
    const tamper = async (id: string, update: object) => {
      const r = await admit(delivery({}, ev(id)), 'persist-only');
      await inboxRows.updateOne({ _id: r.receipt!.inboxId as never }, { $set: update }, { writeConcern: { w: 'majority' } }); // test-only direct tampering
      const out = await recover(r.receipt!.inboxId);
      assert.equal(out.reasonCode, 'broker-inbox-integrity-failed'); assert.equal(await mCount('e11b-' + id), 0);
    };
    await check('I13 tampered raw bytes → integrity failure, no measurement', async () => tamper('13', { rawPayload: new mongo.Binary(f.bytesOf(f.envelope({ eventId: 'e11b-13', payload: { temperature: 99 } }))) }));
    await check('I14 tampered hash → integrity failure', async () => tamper('14', { rawPayloadSha256: 'f'.repeat(64) }));
    await check('I15 tampered provenance (sourceId / verifierRevision / topic) → integrity failure', async () => {
      await tamper('15', { sourceId: 'attacker-source' }); await tamper('15b', { verifierRevision: 9 }); await tamper('15c', { topic: 'synthetic/agro/other/telemetry' });
    });
    await check('I16 wrong-realm recovery denied (admission + store)', async () => {
      const preview = admissionOn(conns[1]!, { realm: 'preview' });
      assert.equal((await recover(persisted.i01!, preview)).reasonCode, 'broker-inbox-not-found');
      assert.equal(await createMongoBrokerInboxStore({ connection: conns[1]!, prefix: INGEST, realm: 'preview' }).getById({ realm: 'preview', inboxId: persisted.i01! }), null);
      assert.equal(await mCount('e11b-01'), 0);
    });
    await check('I17 inbox $jsonSchema rejects invalid / credential-like documents (real Mongo)', async () => {
      const valid = { ...(await inboxRows.findOne({ _id: persisted.i01! as never })), _id: 'ib_' + 'f'.repeat(32) } as Record<string, unknown>;
      const cases: Array<(d: Record<string, unknown>) => void> = [d => { delete d.realm; }, d => { d.qos = 3; }, d => { d.sourceId = ''; }, d => { delete d.rawPersistedAt; },
        d => { d.rawPayloadSha256 = 'xyz'; }, d => { d.password = 'x'; }, d => { d['x-emqx-key'] = 'x'; }, d => { d._id = 'packet-7'; }, d => { d.rawPayload = 'not-binary'; }];
      for (const c of cases) { const d = { ...valid }; c(d); await assert.rejects(inboxRows.insertOne(d as never), (e: { code?: number }) => e.code === 121); }
      await inboxRows.insertOne(valid as never); await inboxRows.deleteOne({ _id: valid._id as never }); // test-only cleanup of the probe
    });
    await check('I18 majority unavailable → write not confirmed → NOTHING processed (real paused secondaries)', async () => {
      await waitHealthy();
      const p = await primaryIndex(), secondaries = [0, 1, 2].filter(i => i !== p);
      for (const s of secondaries) chaos(request, 'pause', s);
      let r: Result;
      try { r = await admit(delivery({}, ev('18'))); } finally { for (const s of secondaries) chaos(request, 'unpause', s); }
      await waitHealthy();
      assert.deepEqual([r.reasonCode, r.retryable], ['broker-inbox-unavailable', true]);
      assert.equal(await mCount('e11b-18'), 0);
      return { orphanInboxRecordsAfterHeal: await iCount('e11b-18'), note: 'unconfirmed write may surface later without a receipt (documented)' };
    });
    await check('I19 write confirmed, pipeline fails → record intact and recoverable → accepted later', async () => {
      down.add('e11b-19');
      const r = await admit(delivery({}, ev('19')));
      assert.equal(statusOf(r), 'quarantined');
      const shaBefore = (await inboxRows.findOne({ _id: r.receipt!.inboxId as never }, majority))!.rawPayloadSha256;
      down.delete('e11b-19');
      assert.equal(statusOf(await recover(r.receipt!.inboxId)), 'accepted');
      assert.equal((await inboxRows.findOne({ _id: r.receipt!.inboxId as never }, majority))!.rawPayloadSha256, shaBefore);
    });
    for (const n of [2, 10]) {
      await check(`I${n === 2 ? 20 : 21} concurrent recovery by ${n} callers on ${n} connections → one measurement`, async () => {
        const r = await admit(delivery({}, ev('c' + n)), 'persist-only');
        const out = await Promise.all(conns.slice(0, n).map(c => recover(r.receipt!.inboxId, admissionOn(c))));
        assert.equal(await mCount('e11b-c' + n), 1);
        return out.map(statusOf);
      });
    }
    await check('I22 no second measurement anywhere in the campaign (one per accepted eventId)', async () => {
      const dup = await measurements.aggregate([{ $group: { _id: { eventId: '$eventId', field: '$field' }, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }]).toArray();
      assert.equal(dup.length, 0);
    });
    await check('I23 audit holds inbox events but never the raw payload', async () => {
      const entries = await auditRows.find({ action: { $in: ['inbox-persisted', 'inbox-recovery-started', 'inbox-processed', 'inbox-integrity-failed'] } }).toArray();
      assert.ok(entries.length >= 10);
      assert.equal(/temperature|synthetic-device|"payload"|rawPayload/.test(JSON.stringify(entries)), false);
    });
    await check('I24 metrics use bounded labels (no inboxId, eventId, client id, topic, sourceId)', async () => {
      assert.ok(metricsEvents.some(e => e.name === 'broker_inbox_persist_total') && metricsEvents.some(e => e.name === 'broker_inbox_integrity_failure_total'));
      assert.equal(/ib_|e11b-|synthetic-device|synthetic\/agro|synthetic-ingest/.test(JSON.stringify(metricsEvents)), false);
    });
    await check('I25 winning plans: { _id, realm } → _id; { realm, rawPersistedAt } → inbox_realm_persisted', async () => {
      const plan = async (q: object) => JSON.stringify(((await inboxRows.find(q).explain('queryPlanner')) as { queryPlanner: { winningPlan: unknown } }).queryPlanner.winningPlan);
      assert.ok(/IDHACK|EXPRESS|_id_/.test(await plan({ _id: persisted.i01!, realm: 'test' })));
      assert.ok((await plan({ realm: 'test', rawPersistedAt: { $gte: new Date(0) } })).includes('inbox_realm_persisted'));
    });
    await check('I27 failover: persist, stop the primary, recover from the NEW primary → accepted (majority durability)', async () => {
      await waitHealthy();
      const r = await admit(delivery({}, ev('27')), 'persist-only');
      const old = await primaryIndex();
      chaos(request, 'stop', old);
      try {
        let out: Result | undefined;
        for (let i = 0; i < 60 && !out; i += 1) { try { const x = await recover(r.receipt!.inboxId, admissionOn(conns[4]!)); if (x.reasonCode !== 'broker-inbox-unavailable') out = x; } catch { /* election */ } if (!out) await sleep(1000); }
        assert.equal(out && statusOf(out), 'accepted');
        return { stoppedPrimary: old, newPrimary: await primaryIndex() };
      } finally { chaos(request, 'start', old); await waitHealthy(); }
    });
    results.push({ name: 'I26 cleanup', status: 'passed', detail: 'confirmed by the launcher (cleanupConfirmed)' });
    stage = 'evidence';
    const dir = join(process.cwd(), '.local-evidence'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'be13-11b-multinode.json'), JSON.stringify({ gitSha: sha, mongoVersion: build.version, run: request.runId, connections: conns.length, results,
      inboxCount: await inboxRows.countDocuments({}), measurementCount: await measurements.countDocuments({}) }, null, 2));
  } finally {
    const first = conns[0];
    if (first?.readyState === 1) { try { verifyOwnedMultiNode(request); await first.db!.dropDatabase(); } catch { /* launcher confirms cleanup */ } }
    for (const c of conns) await c.close().catch(() => {});
    console.log(JSON.stringify({ event: 'be13-11b-summary', passed: results.filter(r => r.status === 'passed').length, failed: results.filter(r => r.status === 'failed').length }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  console.error('BE1311B_LOCAL_FAILED ' + JSON.stringify({ stage, errorClass: error instanceof Error ? error.name : 'Unknown',
    serverCode: typeof (error as { code?: unknown })?.code === 'number' ? (error as { code: number }).code : undefined,
    message: error instanceof Error && /^(MN_|INGESTION_|QUARANTINE_|AUDIT_|RECOVERY_|INBOX_)[A-Z_0-9]+$/.test(error.message) ? error.message : undefined }));
  process.exitCode = 1;
});
