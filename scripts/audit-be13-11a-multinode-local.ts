// BE13-11A — broker provenance boundary E2E against the disposable LOCAL 3-node MongoDB 8.0 replica set
// (be13-07-multinode-local.ps1 -Suite be13-11a). SINTETICO: synthetic deliveries, principal, verifier and mapping.
// No broker, no network beyond the owned local replica set, no credentials, no Atlas/EMQX/hardware.
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
import { auditCollections, auditValidator, provisionAuditCollections, upgradeAuditValidatorBe1311a } from '../src/models/ingestion-audit.models.js';
import { createMongoIngestionIdentityStore } from '../src/repositories/mongo-ingestion-identity.store.js';
import { createMongoMeasurementPersistence } from '../src/repositories/mongo-measurement-persistence.repository.js';
import { createMongoPersistenceRecovery } from '../src/repositories/mongo-persistence-recovery.repository.js';
import { createMongoIngestionQuarantineStore } from '../src/repositories/mongo-ingestion-quarantine.store.js';
import { createMongoIngestionAuditStore } from '../src/repositories/mongo-ingestion-audit.store.js';
import { createDurableBrokerAdmissionService, createMqttIngestionBoundary } from '../src/services/mqtt-ingestion-boundary.service.js';
import { provisionBrokerInboxCollection } from '../src/models/broker-inbox.models.js';
import { createMongoBrokerInboxStore } from '../src/repositories/mongo-broker-inbox.store.js';
import type { MqttIngestionBoundaryDependencies } from '../src/iot/mqtt-ingestion-boundary.contracts.js';

type BrokerFixtures = {
  envelope(patch?: object): Record<string, unknown>; observed(patch?: object): Record<string, unknown>; bytesOf(v: unknown): Buffer;
  syntheticVerifier(mode?: object): { calls: unknown[]; verify(r: unknown): Promise<unknown> }; syntheticMapping(mode?: object): { resolve(r: unknown): Promise<unknown> };
  TEST_ONLY_LIMITS: object; TEST_ONLY_CONFIG: object;
};
const results: { name: string; status: 'passed' | 'failed'; detail?: unknown }[] = [];
let stage = 'bootstrap';
async function check(name: string, work: () => Promise<unknown>) {
  stage = name;
  try { const detail = await work(); results.push({ name, status: 'passed', detail }); console.log('PASS ' + name); }
  catch (error) { results.push({ name, status: 'failed' }); console.log('FAIL ' + name); throw error; }
}
const SENSOR = 'agro_sensors_be1311a', BUSINESS = 'agro_business_be1311a', INGEST = 'agro_ingest_be1311a', LEGACY = 'agro_ingest_be1311alegacy';
const day = (ms: number) => new Date(ms);

async function main() {
  stage = 'guard';
  const request = validateMultiNodeRequest(process.env); verifyOwnedMultiNode(request);
  if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) throw Error('MN_GIT_TREE_NOT_CLEAN');
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const f = await import(pathToFileURL(join(process.cwd(), 'test-support', 'be13-11a-broker.fixtures.js')).href) as BrokerFixtures;
  const conns: Connection[] = [];
  try {
    stage = 'connect';
    for (let i = 0; i < 3; i += 1) conns.push(await connectMultiNode(request));
    const connection = conns[0]!, db = connection.db!;
    if ((await db.listCollections().toArray()).length !== 0) throw Error('MN_DATABASE_NOT_EMPTY');
    const build = await db.command({ buildInfo: 1 }); assert.match(String(build.version), /^8\.0\./);
    stage = 'provision';
    await provisionSensorCollections(connection, SENSOR, BUSINESS);
    await provisionIngestionCollections(connection, INGEST);
    await provisionQuarantineCollection(connection, INGEST);
    await provisionAuditCollections(connection, INGEST);
    await provisionBrokerInboxCollection(connection, INGEST); // BE13-11B: the accepted path is persist-before-ingest
    const sn = sensorCollections(SENSOR, BUSINESS), inn = ingestionCollections(INGEST);
    await db.collection(sn.devices).insertOne({ _id: 'test:device-1', realm: 'test', id: 'device-1', clientId: 'owner', sourceId: 'synthetic-ingest', keyKind: 'mqtt-clientid',
      keyValue: 'synthetic-device-001', verification: 'verified', verificationAuthority: 'synthetic', lifecycle: 'active', version: 3, createdAt: day(1), updatedAt: day(2) } as never, { writeConcern: { w: 'majority' } });
    await db.collection(sn.associations).insertOne({ _id: 'test:assoc-A', realm: 'test', id: 'assoc-A', revision: 1, clientId: 'client-A', sensorId: 'sensor-A', fieldId: 'field-A',
      areaId: 'area-A', validFrom: day(0), validTo: null, auditReason: 'synthetic', physicalDeviceId: 'device-1', sourceId: 'synthetic-ingest', keyKind: 'mqtt-clientid',
      keyValue: 'synthetic-device-001', state: 'active' } as never, { writeConcern: { w: 'majority' } });
    const measurements = db.collection(inn.measurements), quarantineRows = db.collection(quarantineCollection(INGEST)), auditRows = db.collection(auditCollections(INGEST).audit);
    const count = (eventId: string) => measurements.countDocuments({ eventId }, { readConcern: { level: 'majority' } } as never);
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
    const depsOn = (conn: Connection, verifierMode?: object) => ({
      realmAuthority: { authorizedRealm: () => 'test' }, ...synthetic,
      identityStore: createMongoIngestionIdentityStore({ connection: conn, sensorPrefix: SENSOR, businessPrefix: BUSINESS }),
      persistence: createMongoMeasurementPersistence({ connection: conn, prefix: INGEST, realm: 'test' }),
      be12: { temporal: { select: async (e: { receivedAt: number }) => ({ status: 'trusted', at: e.receivedAt, clock: 'received-at' }) }, catalogue: { accepts: async () => true } },
      deviceStatusHistory: { mode: 'current-state-only', limitation: 'DEVICE_STATUS_HISTORY_REQUIRED' },
      retryPolicy: { decide: () => ({ action: 'stop' as const }) }, retryScheduler: { async wait() { /* TEST_ONLY */ } },
      recovery: createMongoPersistenceRecovery({ connection: conn, prefix: INGEST, realm: 'test' }),
      quarantine: createMongoIngestionQuarantineStore({ connection: conn, prefix: INGEST, realm: 'test' }),
      authorization: { authorize: async () => ({ decision: 'deny', reason: 'unauthenticated' }) },
      audit: createMongoIngestionAuditStore({ connection: conn, prefix: INGEST, realm: 'test' }),
      metrics: { increment: () => {} }, alerts: { emit: () => {} }, retention: { mode: 'retain-indefinitely' },
      timeAuthority: { now: async ({ realm }: { realm: string }) => ({ realm, status: 'untrusted' }) }, leasePolicy: { evaluate: async ({ realm }: { realm: string }) => ({ realm, status: 'ACTIVE', recoveryByNonOwner: 'never', policyRevision: 1 }) },
      brokerProvenanceVerifier: f.syntheticVerifier(verifierMode), brokerIdentityMapping: f.syntheticMapping(), payloadLimits: f.TEST_ONLY_LIMITS, boundaryConfig: f.TEST_ONLY_CONFIG,
    } as unknown as MqttIngestionBoundaryDependencies);
    // BE13-11B: deliver = durable admission (verify → Mongo inbox majority+j → process from the record).
    const boundaryOn = (conn: Connection, verifierMode?: object) => {
      const admission = createDurableBrokerAdmissionService({ ...depsOn(conn, verifierMode), durableInbox: createMongoBrokerInboxStore({ connection: conn, prefix: INGEST, realm: 'test' }) });
      return { deliver: (raw: unknown) => admission.admit(raw, { mode: 'persist-and-process' }) };
    };
    const direct = createMqttIngestionBoundary(depsOn(connection));
    const delivery = (obs: object = {}, env: object = {}, payload?: Buffer) => ({ brokerObserved: f.observed(obs), payload: payload ?? f.bytesOf(f.envelope(env)) });
    const boundary = boundaryOn(connection);
    const ev = (id: string) => ({ eventId: 'e11a-' + id });
    type Ingested = { status: 'ingested'; results: { result: { status: string; reasonCode?: string; quarantineStatus?: string } }[] };
    type Rejected = { status: 'rejected'; reasonCode: string; retryable: boolean };

    await check('E01 verified delivery → accepted; sourceId from the mapping; business clientId from BE-12', async () => {
      const r = await boundary.deliver(delivery({}, ev('01'))) as unknown as Ingested;
      assert.equal(r.results[0]!.result.status, 'accepted');
      const m = await measurements.findOne({ eventId: 'e11a-01' }) as unknown as { sourceId: string; attribution: { clientId: string; realm: string } };
      assert.deepEqual([m.sourceId, m.attribution.clientId, m.attribution.realm], ['synthetic-ingest', 'client-A', 'test']);
    });
    await check('E02 exact QoS redelivery (new packet id) → duplicate; still one measurement', async () => {
      const r = await boundary.deliver(delivery({ packetId: 99, qos: 1 }, ev('01'))) as unknown as Ingested;
      assert.equal(r.results[0]!.result.status, 'duplicate'); assert.equal(await count('e11a-01'), 1);
    });
    await check('E03 concurrent redeliveries of one event on 3 connections → exactly one measurement', async () => {
      const bs = conns.map(c => boundaryOn(c));
      const out = await Promise.all(bs.map((b, i) => b.deliver(delivery({ packetId: 10 + i, qos: 2 }, ev('03'))))) as unknown as Ingested[];
      assert.equal(await count('e11a-03'), 1);
      return out.map(o => o.results[0]!.result.status);
    });
    const none = async (id: string, r: unknown, reason: string) => {
      assert.equal((r as Rejected).reasonCode, reason); assert.equal(await count('e11a-' + id), 0);
      assert.equal(await quarantineRows.countDocuments({ eventId: 'e11a-' + id }), 0, 'boundary rejections create no quarantine record');
    };
    await check('E04 rejected provenance → no measurement, no quarantine, audited', async () => {
      await none('04', await boundaryOn(connection, { kind: 'reject' }).deliver(delivery({}, ev('04'))), 'broker-provenance-rejected');
      assert.ok(await auditRows.countDocuments({ action: 'broker-provenance-rejected', eventId: 'e11a-04' }) >= 1);
    });
    await check('E05 no authenticated principal → unverified, nothing written', async () => {
      await none('05', await boundary.deliver(delivery({ authenticatedPrincipalReference: null }, ev('05'))), 'broker-provenance-unverified');
    });
    await check('E06 technical identity mismatch → nothing written; audited', async () => {
      await none('06', await boundary.deliver(delivery({}, { ...ev('06'), clientid: 'synthetic-device-002' })), 'technical-identity-mismatch');
      assert.equal(await auditRows.countDocuments({ action: 'technical-identity-mismatch', eventId: 'e11a-06' }), 1);
    });
    await check('E07 retained message → blocked; nothing written', async () => {
      await none('07', await boundary.deliver(delivery({ retain: true }, ev('07'))), 'retained-message-blocked');
    });
    await check('E08 malformed / dangerous-key / oversized payloads → nothing written; audit holds no payload', async () => {
      for (const [payload, reason] of [[f.bytesOf('{"__proto__":{"x":1}}'), 'payload-dangerous-key'], [Buffer.alloc(5000, 0x20), 'payload-too-large'], [f.bytesOf('{oops'), 'payload-malformed']] as const)
        assert.equal(((await boundary.deliver(delivery({}, {}, payload))) as Rejected).reasonCode, reason);
      const audits = await auditRows.find({ action: 'broker-delivery-malformed' }).toArray();
      assert.ok(audits.length >= 3);
      assert.equal(/__proto__|oops|"x":1/.test(JSON.stringify(audits)), false);
    });
    await check('E09 verifier unavailable → transient, nothing written', async () => {
      const r = await boundaryOn(connection, { kind: 'throw' }).deliver(delivery({}, ev('09'))) as Rejected;
      assert.equal(r.retryable, true); await none('09', r, 'broker-verifier-unavailable');
    });
    await check('E10 verified delivery on the direct (non-durable) path → no persisted instant → quarantined BLOCKED inside the pipeline (Mongo)', async () => {
      const r = await direct.deliver(delivery({}, ev('10'))) as unknown as Ingested;
      assert.deepEqual([r.results[0]!.result.status, r.results[0]!.result.reasonCode], ['quarantined', 'unresolved-persisted-at']);
      assert.equal(await count('e11a-10'), 0);
      assert.equal((await quarantineRows.findOne({ eventId: 'e11a-10' }))?.status, 'BLOCKED');
    });
    await check('E11 audit $jsonSchema accepts the broker actions and still rejects unknown actions / payload fields (real Mongo)', async () => {
      const base = { _id: 'a_' + 'c'.repeat(64), realm: 'test', stream: 'realm', sequence: 999_999, quarantineId: null, eventId: null, action: 'broker-delivery-malformed',
        actorId: 'broker-boundary', actorCapabilities: [], outcome: 'payload-malformed', reasonCode: 'payload-malformed', evidence: null, occurredAt: new Date(0) };
      await auditRows.insertOne(base as never); await auditRows.deleteOne({ _id: base._id as never });
      for (const bad of [{ ...base, action: 'broker-trusted' }, { ...base, rawPayload: 'x' }, { ...base, mqttClientId: 'synthetic-device-001' }])
        await assert.rejects(auditRows.insertOne(bad as never), (e: { code?: number }) => e.code === 121);
    });
    await check('E12 local audit validator upgrade from the pre-BE13-11A vocabulary (additive)', async () => {
      const n = auditCollections(LEGACY);
      const legacy = structuredClone(auditValidator) as { $jsonSchema: { properties: { action: { enum: string[] } } } };
      legacy.$jsonSchema.properties.action.enum = legacy.$jsonSchema.properties.action.enum.filter(a => !a.startsWith('broker-') && a !== 'technical-identity-mismatch');
      await db.createCollection(n.audit, { validator: legacy, validationLevel: 'strict', validationAction: 'error' });
      const doc = { _id: 'a_' + 'd'.repeat(64), realm: 'test', stream: 'realm', sequence: 1, quarantineId: null, eventId: null, action: 'broker-provenance-rejected',
        actorId: 'broker-boundary', actorCapabilities: [], outcome: 'broker-provenance-rejected', reasonCode: null, evidence: null, occurredAt: new Date(0) };
      await assert.rejects(db.collection(n.audit).insertOne(doc as never), (e: { code?: number }) => e.code === 121);
      assert.deepEqual(await upgradeAuditValidatorBe1311a(connection, LEGACY), { status: 'upgraded' });
      await db.collection(n.audit).insertOne(doc as never);
    });
    results.push({ name: 'E13 cleanup', status: 'passed', detail: 'confirmed by the launcher (cleanupConfirmed)' });
    stage = 'evidence';
    const dir = join(process.cwd(), '.local-evidence'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'be13-11a-multinode.json'), JSON.stringify({ gitSha: sha, mongoVersion: build.version, run: request.runId, results,
      measurementCount: await measurements.countDocuments({}), quarantineCount: await quarantineRows.countDocuments({}), auditCount: await auditRows.countDocuments({}) }, null, 2));
  } finally {
    const first = conns[0];
    if (first?.readyState === 1) { try { verifyOwnedMultiNode(request); await first.db!.dropDatabase(); } catch { /* launcher confirms cleanup */ } }
    for (const c of conns) await c.close().catch(() => {});
    console.log(JSON.stringify({ event: 'be13-11a-summary', passed: results.filter(r => r.status === 'passed').length, failed: results.filter(r => r.status === 'failed').length }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  console.error('BE1311A_LOCAL_FAILED ' + JSON.stringify({ stage, errorClass: error instanceof Error ? error.name : 'Unknown',
    serverCode: typeof (error as { code?: unknown })?.code === 'number' ? (error as { code: number }).code : undefined,
    message: error instanceof Error && /^(MN_|INGESTION_|QUARANTINE_|AUDIT_|RECOVERY_)[A-Z_0-9]+$/.test(error.message) ? error.message : undefined }));
  process.exitCode = 1;
});
