// BE13-06 — Real local MongoDB campaign (C3 identity store + C4 atomic persistence).
// Runs ONLY through scripts/be11-local.ps1 -Suite be13-06 -AuthorizeDisposable:
// owned Docker container, MongoDB 8.0 single-node replica set, 127.0.0.1 only,
// tmpfs storage, disposable database. No Atlas, no EMQX, no hardware.
import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mongo, type Connection } from 'mongoose';
import { db02Uri, validateDb02Request, verifyOwnedDocker, type LocalRequest } from './agro-db02/guard.js';
import { connectOwned } from './agro-db02/resources.js';
import { classifyBe11Failure, writeBe11Evidence } from './be11-diagnostics.js';
import { assertLocalMongoUri, assertLocalReplicaSetHello } from './be13-06/local-guard.js';
import { provisionSensorCollections, sensorCollections } from '../src/models/sensor.models.js';
import { ingestionCollections, provisionIngestionCollections } from '../src/models/ingestion-persistence.models.js';
import { createIngestionIdentityStoreFromCollections, createMongoIngestionIdentityStore, deviceFilter, associationAtFilter,
  type IdentityCollections } from '../src/repositories/mongo-ingestion-identity.store.js';
import { createMongoMeasurementPersistence, measurementDocumentId } from '../src/repositories/mongo-measurement-persistence.repository.js';
import { createBe12IdentityPorts, createIngestionIdentityPorts } from '../src/adapters/ingestion-identity.adapters.js';
import { createMeasurementAttributionService } from '../src/services/measurement-attribution.service.js';
import { createPersistentMeasurementIngestionComposition } from '../src/services/measurement-ingestion-composition.service.js';
import { createAttributionTrustGate } from '../src/services/attribution-trust-gate.service.js';
import { technicalInputFingerprint } from '../src/iot/ingestion-event-fingerprint.js';
import type { IngestionIdentityStore, MeasurementPersistencePort, PersistMeasurementInput } from '../src/iot/ingestion-composition.contracts.js';
import type { ProtectedMeasurementCandidate } from '../src/iot/protected-ingest.contracts.js';

type Fixtures = { candidate(patch?: object, options?: object): ProtectedMeasurementCandidate; RECEIVED: number };
let stage = 'bootstrap', run: string | undefined;
const results: { name: string; status: string }[] = [];
const check = async (name: string, work: () => Promise<void>) => {
  stage = name;
  try { await work(); results.push({ name, status: 'passed' }); console.log('PASS ' + name); }
  catch (error) { results.push({ name, status: 'failed' }); console.log('FAIL ' + name); throw error; }
};

const SENSOR = 'agro_sensors_be1306', BUSINESS = 'agro_business_be1306', INGEST = 'agro_ingest_be1306';
const day = (ms: number) => new Date(ms);

function validatedGitSha() {
  if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) throw Error('BE1306_GIT_TREE_NOT_CLEAN');
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (!/^[a-f0-9]{40}$/.test(sha)) throw Error('BE1306_GIT_SHA_INVALID');
  return sha;
}

const deviceDoc = (realm: string, id: string, patch: object = {}) => ({ _id: realm + ':' + id, realm, id, clientId: 'owner-' + realm, sourceId: 'synthetic-ingest',
  keyKind: 'mqtt-clientid', keyValue: 'synthetic-device-001', verification: 'verified', verificationAuthority: 'synthetic', lifecycle: 'active', version: 3,
  createdAt: day(1), updatedAt: day(2), ...patch });
const associationDoc = (realm: string, id: string, patch: object = {}) => ({ _id: realm + ':' + id, realm, id, revision: 1, clientId: 'client-A', sensorId: 'sensor-A',
  fieldId: 'field-A', areaId: 'area-A', validFrom: day(0), validTo: null, auditReason: 'synthetic', physicalDeviceId: 'device-1', sourceId: 'synthetic-ingest',
  keyKind: 'mqtt-clientid', keyValue: 'synthetic-device-001', state: 'active', ...patch });

// Synthetic authorities/policies (explicit doubles, not productive decisions).
function synthetic(realm: string) {
  const temporal = { decide: async (q: { realm: string; timestamps: { receivedAt: number } }) => ({ realm: q.realm, status: 'trusted', at: q.timestamps.receivedAt, clock: 'received-at', policyRevision: 1 }) };
  const hardware = { verify: async (q: { realm: string; physicalDeviceId: string }) => ({ realm: q.realm, status: 'verified', physicalDeviceId: q.physicalDeviceId, origin: 'simulated', method: 'synthetic', attestationRevision: 1 }) };
  const catalogue = { evaluate: async (q: { realm: string; field: string }) => (q.field === 'temperature' || q.field === 'soil_moisture'
    ? { realm: q.realm, status: 'approved', field: q.field, magnitude: q.field, unit: 'synthetic-unit', catalogueRevision: 1 } : { realm: q.realm, status: 'unknown-magnitude' }) };
  const policies = {
    clock: { decide: async (q: { realm: string }) => ({ realm: q.realm, status: 'approved', clock: 'received-at', policyRevision: 1 }) },
    declaredAt: { decide: async (q: { realm: string; candidateClocks: { deviceTimestamp: unknown } }) => ({ realm: q.realm, status: 'approved', source: 'device-timestamp', declaredAt: q.candidateClocks.deviceTimestamp, policyRevision: 1 }) },
    missingReason: { decide: async (q: { realm: string }) => ({ realm: q.realm, status: 'approved', missingReason: 'absent', policyRevision: 1 }) },
    persistenceTime: { decide: async (q: { realm: string; persistedAt: number }) => ({ realm: q.realm, status: 'approved', persistedAt: q.persistedAt, policyRevision: 1 }) },
  };
  return { temporal, hardware, catalogue, policies, realm };
}

function composition(realm: 'test' | 'preview', store: IngestionIdentityStore, persistence: MeasurementPersistencePort, be12Wrap?: (resolve: (e: unknown) => Promise<unknown>) => (e: unknown) => Promise<unknown>) {
  const s = synthetic(realm);
  const be12 = createMeasurementAttributionService({ ...createBe12IdentityPorts(store, realm),
    temporal: { select: async (event: { receivedAt: number }) => ({ status: 'trusted', at: event.receivedAt, clock: 'received-at' }) },
    catalogue: { accepts: async () => true } } as never, { realm });
  const resolve = (e: unknown) => be12.resolve(e);
  return createPersistentMeasurementIngestionComposition({ realmContext: { realm }, identityStore: store, temporal: s.temporal as never, hardware: s.hardware as never,
    catalogue: s.catalogue as never, policies: s.policies as never, persistence, be12: { resolve: be12Wrap ? be12Wrap(resolve) : resolve } as never });
}

async function race(request: LocalRequest, count: number, inputs: PersistMeasurementInput[]) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(PATH|Path|SystemRoot|WINDIR|TEMP|TMP|HOME|USERPROFILE|DOCKER_HOST|DOCKER_CONTEXT|DOCKER_CONFIG|AGRO_DB02_.*)$/.test(key)));
  const workerPath = join(dirname(fileURLToPath(import.meta.url)), 'be13-06', 'worker.js');
  const children = Array.from({ length: count }, () => fork(workerPath, [], { env: environment, execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }));
  verifyOwnedDocker(request);
  try {
    let armed = 0;
    const outcomes = children.map((child, i) => new Promise<{ outcome: string; attempts: number; pid: number }>((resolve, reject) => {
      child.on('error', () => reject(new Error('BE1306_CHILD_FAILED')));
      child.on('exit', code => { if (code !== 0) reject(new Error('BE1306_CHILD_EXIT')); });
      child.on('message', (message: { status: string; pid: number; outcome?: string; attempts?: number }) => {
        if (message.pid !== child.pid || message.status === 'failed') { reject(new Error('BE1306_CHILD_PROTOCOL')); return; }
        if (message.status === 'ready') child.send({ prefix: INGEST, input: inputs[i % inputs.length] });
        if (message.status === 'armed' && ++armed === count) for (const c of children) c.send({ go: true });
        if (message.status === 'done') resolve({ outcome: String(message.outcome), attempts: Number(message.attempts), pid: message.pid });
      });
    }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.all(outcomes), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('BE1306_RACE_DEADLINE')), 60000); })]);
    } finally { clearTimeout(timer); }
  } finally {
    await Promise.all(children.map(child => new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      const t = setTimeout(() => child.kill(), 5000); child.once('exit', () => { clearTimeout(t); resolve(); });
    })));
  }
}

async function main() {
  stage = 'validate-owned-docker';
  const request = validateDb02Request(process.env); run = request.runId; verifyOwnedDocker(request);
  if (request.topology !== 'single-node-replica-set') throw Error('BE1306_REQUIRES_REPLICA_SET');
  const database = 'agro_db02_test_' + request.runId;
  stage = 'local-destination-guard'; assertLocalMongoUri(db02Uri(request, database), request.port);
  const sha = validatedGitSha();
  const fixtures = await import(pathToFileURL(join(process.cwd(), 'test-support', 'be13-composition.fixtures.js')).href) as Fixtures;
  let connection: Connection | undefined, owned = false;
  try {
    stage = 'connect'; connection = await connectOwned(request, database); const db = connection.db!;
    assertLocalReplicaSetHello(await db.command({ hello: 1 }));
    assert.equal(connection.host, '127.0.0.1'); assert.equal(connection.port, request.port);
    assert.equal((await db.listCollections().toArray()).length, 0); owned = true;
    const build = await db.command({ buildInfo: 1 }); assert.match(String(build.version), /^8\.0\./);

    stage = 'provision';
    await provisionSensorCollections(connection, SENSOR, BUSINESS);
    await provisionIngestionCollections(connection, INGEST);
    const sn = sensorCollections(SENSOR, BUSINESS), inn = ingestionCollections(INGEST);
    const devices = db.collection(sn.devices), associations = db.collection(sn.associations);
    const claims = db.collection(inn.idempotency), measurements = db.collection(inn.measurements);
    await devices.insertMany([deviceDoc('test', 'device-1') as never, deviceDoc('preview', 'device-1', { clientId: 'owner-preview' }) as never]);
    await associations.insertMany([associationDoc('test', 'assoc-A') as never, associationDoc('preview', 'assoc-A', { clientId: 'client-preview' }) as never]);
    // A→B→A history on a dedicated device: A [100,200), B [200,300), A [300,null)
    await devices.insertOne(deviceDoc('test', 'device-h', { keyValue: 'device-history' }) as never);
    await associations.insertMany([
      associationDoc('test', 'h-A1', { physicalDeviceId: 'device-h', keyValue: 'device-history', validFrom: day(100), validTo: day(200), state: 'closed' }),
      associationDoc('test', 'h-B', { physicalDeviceId: 'device-h', keyValue: 'device-history', clientId: 'client-B', validFrom: day(200), validTo: day(300), state: 'closed' }),
      associationDoc('test', 'h-A2', { physicalDeviceId: 'device-h', keyValue: 'device-history', validFrom: day(300) }),
    ] as never[]);
    const store = createMongoIngestionIdentityStore({ connection, sensorPrefix: SENSOR, businessPrefix: BUSINESS });
    const persistence = createMongoMeasurementPersistence({ connection, prefix: INGEST, realm: 'test' });
    const counts = async () => [await claims.countDocuments({}), await measurements.countDocuments({})];
    const key = { kind: 'mqtt-clientid' as const, value: 'synthetic-device-001' };

    await check('M01 device resolution by realm + sourceId + technical key', async () => {
      const r = await store.findDevicesByKey({ realm: 'test', sourceId: 'synthetic-ingest', key, limit: 2 });
      assert.deepEqual(r.rows.map(x => [x.realm, x.id, x.version]), [['test', 'device-1', 3]]);
      const plan = JSON.stringify(await devices.find(deviceFilter('test', 'synthetic-ingest', key)).explain('queryPlanner'));
      assert.ok(plan.includes('device_technical_identity_unique'), 'query uses the realm-prefixed BE-11 unique index');
    });
    await check('M02 unknown device', async () => {
      assert.equal((await store.findDevicesByKey({ realm: 'test', sourceId: 'synthetic-ingest', key: { kind: 'mqtt-clientid', value: 'nobody' }, limit: 2 })).rows.length, 0);
      const r = await composition('test', store, persistence).ingest(fixtures.candidate({ clientid: 'nobody', eventId: 'm02' }), { field: 'temperature' });
      assert.deepEqual([r.status, (r as { cause?: string }).cause], ['quarantined', 'unresolved-device']);
      assert.deepEqual(await counts(), [0, 0]);
    });
    await check('M03 ambiguous device: rejected by BE-11 unique index; reported (never picked) without it', async () => {
      await assert.rejects(devices.insertOne(deviceDoc('test', 'device-dup') as never), (e: { code?: number }) => e.code === 11000);
      const raw = db.collection('agro_be1306_unindexed_devices');
      await raw.insertMany([deviceDoc('test', 'x1'), deviceDoc('test', 'x2')] as never[]);
      const unindexed = createIngestionIdentityStoreFromCollections({ devices: raw as unknown as IdentityCollections['devices'], associations: associations as unknown as IdentityCollections['associations'] });
      assert.equal((await unindexed.findDevicesByKey({ realm: 'test', sourceId: 'synthetic-ingest', key, limit: 2 })).rows.length, 2);
      const ports = createIngestionIdentityPorts(unindexed, 'test');
      const s = synthetic('test');
      const gate = createAttributionTrustGate({ ...ports, temporal: s.temporal as never, hardware: s.hardware as never, catalogue: s.catalogue as never }, { realm: 'test' });
      const ready = await gate.evaluate(fixtures.candidate({ eventId: 'm03' }), { field: 'temperature' });
      assert.deepEqual([ready.status, (ready as { reason?: string }).reason], ['quarantined', 'ambiguous-device']);
      await raw.drop();
    });
    await check('M04 realm isolation for the same device key and association identity', async () => {
      const t = await store.findDevicesByKey({ realm: 'test', sourceId: 'synthetic-ingest', key, limit: 2 });
      const p = await store.findDevicesByKey({ realm: 'preview', sourceId: 'synthetic-ingest', key, limit: 2 });
      assert.deepEqual([t.rows.map(r => r.realm), p.rows.map(r => r.realm)], [['test'], ['preview']]);
      const at = await store.findAssociationsAt({ realm: 'test', physicalDeviceId: 'device-1', at: 5, limit: 2 });
      const ap = await store.findAssociationsAt({ realm: 'preview', physicalDeviceId: 'device-1', at: 5, limit: 2 });
      assert.deepEqual([at.rows.map(r => r.clientId), ap.rows.map(r => r.clientId)], [['client-A'], ['client-preview']]);
      const plan = JSON.stringify(await associations.find(associationAtFilter('test', 'device-1', 5)).explain('queryPlanner'));
      assert.ok(plan.includes('"realm"') && plan.includes('device_timeline_unique'), 'realm is part of the filter and of the index bounds');
    });
    await check('M05 historical association (closed window)', async () => {
      const r = await store.findAssociationsAt({ realm: 'test', physicalDeviceId: 'device-h', at: 150, limit: 2 });
      assert.deepEqual(r.rows.map(x => [x.id, x.state, x.validTo]), [['h-A1', 'closed', 200]]);
    });
    await check('M06 A→B→A at 199, 200, 299, 300', async () => {
      const owners = [];
      for (const at of [199, 200, 299, 300]) owners.push((await store.findAssociationsAt({ realm: 'test', physicalDeviceId: 'device-h', at, limit: 2 })).rows.map(x => x.clientId));
      assert.deepEqual(owners, [['client-A'], ['client-B'], ['client-B'], ['client-A']]);
    });
    await check('M07 [validFrom, validTo) borders', async () => {
      const at = async (t: number) => (await store.findAssociationsAt({ realm: 'test', physicalDeviceId: 'device-h', at: t, limit: 2 })).rows.map(x => x.id);
      assert.deepEqual([await at(99), await at(100), await at(199), await at(200)], [[], ['h-A1'], ['h-A1'], ['h-B']]);
    });

    const ingestTest = composition('test', store, persistence);
    const base = fixtures.candidate();
    let firstMeasurementId = '';
    await check('M08 first event persists claim + measurement in one transaction', async () => {
      const r = await ingestTest.ingest(base, { field: 'temperature' }) as { status: string; persisted?: boolean; measurementId?: string };
      assert.deepEqual([r.status, r.persisted], ['accepted', true]);
      firstMeasurementId = String(r.measurementId);
      assert.deepEqual(await counts(), [1, 1]);
      const stored = await measurements.findOne({ _id: firstMeasurementId as never });
      assert.ok(stored && stored.storedAt instanceof Date, 'technical storedAt is server time');
      assert.equal((stored as unknown as { event: { persistedAt: number } }).event.persistedAt, base.timestamps.persistedAt.value, 'semantic persistedAt is not the store time');
    });
    await check('M09 exact retry returns duplicate with the persisted reference', async () => {
      const retry = fixtures.candidate({}, { receivedAt: fixtures.RECEIVED + 9_000, persistedAt: fixtures.RECEIVED + 9_010 });
      const r = await ingestTest.ingest(retry, { field: 'temperature' }) as { status: string; measurementId?: string };
      assert.deepEqual([r.status, r.measurementId], ['duplicate', firstMeasurementId]);
      assert.deepEqual(await counts(), [1, 1]);
    });
    await check('M10 altered retry conflicts without writing', async () => {
      const r = await ingestTest.ingest(fixtures.candidate({ payload: { temperature: 7, soil_moisture: null } }), { field: 'temperature' });
      assert.deepEqual([r.status, (r as { reason?: string }).reason], ['quarantined', 'idempotency-conflict']);
      assert.deepEqual(await counts(), [1, 1]);
    });

    // Concurrency with real processes (separate connections).
    const inputFor = (eventId: string, value: number): PersistMeasurementInput => {
      const c = fixtures.candidate({ eventId, payload: { temperature: value } });
      const k = { realm: 'test' as const, sourceId: c.sourceId, operation: 'measurement' as const, eventId, field: 'temperature' };
      return { key: k, fingerprint: technicalInputFingerprint('test', c, 'temperature'),
        event: { eventId, sourceId: c.sourceId, device: { kind: 'mqtt-clientid', value: 'synthetic-device-001' }, receivedAt: fixtures.RECEIVED, declaredAt: null,
          persistedAt: fixtures.RECEIVED + 10, magnitude: 'temperature', unit: 'synthetic-unit', value, missingReason: null, provenance: 'simulated', simulated: true, metadata: {} },
        attribution: { realm: 'test', attributedAt: fixtures.RECEIVED, clock: 'received-at', physicalDeviceId: 'device-1', clientId: 'client-A', fieldId: 'field-A',
          areaId: 'area-A', sensorId: 'sensor-A', associationId: 'assoc-A', associationRevision: 1 } };
    };
    const raceEvidence: Record<string, unknown> = {};
    for (const [label, n] of [['M11a 2', 2], ['M11 4', 4], ['M12 10', 10]] as const) {
      await check(`${label.split(' ')[0]} ${n} concurrent exact retries → exactly 1 persisted`, async () => {
        const before = await counts();
        const outcomes = await race(request, n, [inputFor('race-' + n, 1)]);
        assert.equal(new Set(outcomes.map(o => o.pid)).size, n);
        assert.deepEqual(outcomes.map(o => o.outcome).sort(), ['persisted', ...Array(n - 1).fill('duplicate')].sort());
        const after = await counts();
        assert.deepEqual([after[0] - before[0], after[1] - before[1]], [1, 1]);
        raceEvidence[label] = { processes: n, attempts: outcomes.map(o => o.attempts) };
      });
    }
    await check('M12b 10 concurrent writers with different fingerprints → 1 persisted, 9 conflicts', async () => {
      const before = await counts();
      const outcomes = await race(request, 10, Array.from({ length: 10 }, (_, i) => inputFor('race-conflict', i + 1)));
      assert.deepEqual(outcomes.map(o => o.outcome).sort(), ['persisted', ...Array(9).fill('conflict')].sort());
      const after = await counts();
      assert.deepEqual([after[0] - before[0], after[1] - before[1]], [1, 1]);
    });

    await check('M13 abort after claim, before measurement insert → nothing survives', async () => {
      const before = await counts();
      const faulty = createMongoMeasurementPersistence({ connection: connection!, prefix: INGEST, realm: 'test',
        testSeams: { faultInjection: stage => { if (stage === 'after-claim') throw new Error('injected'); } } });
      await assert.rejects(faulty.persistAtomically(inputFor('abort-claim', 1) as never));
      assert.deepEqual(await counts(), before);
      assert.equal(await claims.countDocuments({ eventId: 'abort-claim' }), 0);
    });
    await check('M14 abort after insert / pre-commit, manual abort and transient retry', async () => {
      const before = await counts();
      const faulty = createMongoMeasurementPersistence({ connection: connection!, prefix: INGEST, realm: 'test',
        testSeams: { faultInjection: stage => { if (stage === 'after-measurement') throw new Error('injected'); } } });
      await assert.rejects(faulty.persistAtomically(inputFor('abort-measurement', 1) as never));
      assert.deepEqual(await counts(), before);
      const session = await connection!.startSession();
      try {
        session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
        await claims.insertOne({ _id: 'f'.repeat(64), realm: 'test', sourceId: 's', operation: 'measurement', eventId: 'manual', field: 'f', fingerprint: 'f'.repeat(64),
          state: 'committed', measurementId: 'm_' + 'f'.repeat(64), committedAt: new Date(0) } as never, { session });
        await session.abortTransaction();
      } finally { await session.endSession(); }
      assert.deepEqual(await counts(), before, 'manual abort leaves nothing');
      let attempts = 0;
      const transient = createMongoMeasurementPersistence({ connection: connection!, prefix: INGEST, realm: 'test', testSeams: {
        onAttempt: n => { attempts = n; },
        faultInjection: (stage, attempt) => { if (stage === 'after-measurement' && attempt === 1)
          throw new mongo.MongoServerError({ message: 'injected transient', code: 112, errorLabels: ['TransientTransactionError'] } as never); } } });
      const r = await transient.persistAtomically(inputFor('transient', 1) as never);
      assert.deepEqual([r.status, attempts], ['persisted', 2], 'the driver retried the whole transaction once');
      const after = await counts();
      assert.deepEqual([after[0] - before[0], after[1] - before[1]], [1, 1], 'retry did not duplicate writes');
    });
    await check('M15 same eventId in another realm is an independent key', async () => {
      const previewPersistence = createMongoMeasurementPersistence({ connection: connection!, prefix: INGEST, realm: 'preview' });
      const r = await composition('preview', store, previewPersistence).ingest(base, { field: 'temperature' }) as { status: string; attribution?: { clientId: string } };
      assert.deepEqual([r.status, r.attribution?.clientId], ['accepted', 'client-preview']);
      assert.equal(await claims.countDocuments({ eventId: base.eventId, field: 'temperature' }), 2);
      assert.deepEqual((await persistence.lookup({ realm: 'test', sourceId: base.sourceId, operation: 'measurement', eventId: base.eventId, field: 'temperature' })).status, 'present');
      await assert.rejects(persistence.lookup({ realm: 'preview', sourceId: base.sourceId, operation: 'measurement', eventId: base.eventId, field: 'temperature' }));
    });
    await check('M16 same eventId, different field → separate measurement', async () => {
      const r = await ingestTest.ingest(base, { field: 'soil_moisture' }) as { status: string; event?: { value: unknown } };
      assert.deepEqual([r.status, r.event?.value], ['accepted', null]);
      assert.equal(await measurements.countDocuments({ realm: 'test', eventId: base.eventId }), 2);
    });
    await check('M17 same eventId and field from another source → separate key', async () => {
      await devices.insertOne(deviceDoc('test', 'device-9', { sourceId: 'other-source' }) as never);
      await associations.insertOne(associationDoc('test', 'assoc-9', { physicalDeviceId: 'device-9', sourceId: 'other-source' }) as never);
      const r = await ingestTest.ingest(fixtures.candidate({ sourceId: 'other-source' }), { field: 'temperature' });
      assert.equal(r.status, 'accepted');
      assert.equal(await claims.countDocuments({ realm: 'test', eventId: base.eventId, field: 'temperature' }), 2);
    });
    await check('M18 attribution drift aborts before any claim or measurement', async () => {
      const before = await counts();
      const drifting = composition('test', store, persistence, resolve => async event => {
        await associations.updateOne({ realm: 'test', id: 'assoc-A' }, { $set: { clientId: 'client-intruder' } });
        try { return await resolve(event); } finally { await associations.updateOne({ realm: 'test', id: 'assoc-A' }, { $set: { clientId: 'client-A' } }); }
      });
      const r = await drifting.ingest(fixtures.candidate({ eventId: 'drift-event' }), { field: 'temperature' });
      assert.deepEqual([r.status, (r as { reason?: string }).reason, (r as { cause?: string }).cause], ['quarantined', 'attribution-drift', 'clientId']);
      assert.deepEqual(await counts(), before);
    });
    await check('M19 no orphan claims', async () => {
      const orphans = await claims.aggregate([{ $lookup: { from: inn.measurements, localField: 'measurementId', foreignField: '_id', as: 'm' } },
        { $match: { m: { $size: 0 } } }]).toArray();
      assert.equal(orphans.length, 0);
    });
    await check('M20 no orphan measurements (and every pair agrees on key and fingerprint)', async () => {
      const orphans = await measurements.aggregate([{ $lookup: { from: inn.idempotency, localField: '_id', foreignField: 'measurementId', as: 'c' } },
        { $match: { c: { $size: 0 } } }]).toArray();
      assert.equal(orphans.length, 0);
      for (const m of await measurements.find({}).toArray()) {
        const c = await claims.findOne({ measurementId: m._id });
        assert.ok(c && c.fingerprint === m.fingerprint && c.eventId === m.eventId && c.field === m.field && c.realm === m.realm);
        assert.equal(m._id, measurementDocumentId({ realm: m.realm, sourceId: m.sourceId, operation: m.operation, eventId: m.eventId, field: m.field }));
      }
    });

    // Adversarial vectors against the real store.
    await check('A01 malformed claim document fails closed', async () => {
      const k = { realm: 'test' as const, sourceId: 'synthetic-ingest', operation: 'measurement' as const, eventId: 'tampered', field: 'temperature' };
      const { idempotencyDocumentId } = await import('../src/repositories/mongo-measurement-persistence.repository.js');
      await claims.insertOne({ _id: idempotencyDocumentId(k), realm: 'test', sourceId: 'synthetic-ingest', operation: 'measurement', eventId: 'other-event', field: 'temperature',
        fingerprint: 'a'.repeat(64), state: 'committed', measurementId: 'm_' + 'a'.repeat(64), committedAt: new Date(0) } as never);
      await assert.rejects(persistence.lookup(k), /INGESTION_CLAIM_IDENTITY_MISMATCH/);
      const r = await ingestTest.ingest(fixtures.candidate({ eventId: 'tampered' }), { field: 'temperature' });
      assert.deepEqual([r.status, (r as { reason?: string }).reason], ['quarantined', 'persistence-unavailable']);
      await claims.deleteOne({ eventId: 'other-event' });
    });
    await check('A02 validator rejects a measurement without required fields; nothing is half-written', async () => {
      await assert.rejects(measurements.insertOne({ _id: 'm_' + 'b'.repeat(64), realm: 'test' } as never), (e: { code?: number }) => e.code === 121);
    });
    await check('A03 malformed BE-11 device document fails closed', async () => {
      await devices.insertOne(deviceDoc('development', 'bad', { keyValue: 'malformed-dev' }) as never);
      await devices.updateOne({ _id: 'development:bad' as never }, { $set: { version: -1 } }, { bypassDocumentValidation: true });
      await assert.rejects(store.findDevicesByKey({ realm: 'development', sourceId: 'synthetic-ingest', key: { kind: 'mqtt-clientid', value: 'malformed-dev' }, limit: 2 }));
    });
    await check('A04 overlapping associations are reported, never picked', async () => {
      await associations.insertOne(associationDoc('test', 'assoc-overlap', { clientId: 'client-X', validFrom: day(1) }) as never);
      const r = await store.findAssociationsAt({ realm: 'test', physicalDeviceId: 'device-1', at: 5, limit: 2 });
      assert.equal(r.rows.length, 2);
      const q = await ingestTest.ingest(fixtures.candidate({ eventId: 'overlap-event' }), { field: 'temperature' });
      assert.deepEqual([(q as { reason?: string }).reason, (q as { cause?: string }).cause], ['trust-gate-rejected', 'overlapping-association']);
      await associations.deleteOne({ id: 'assoc-overlap' });
    });
    await check('A05 forged realm in persistence input is refused before any write', async () => {
      const before = await counts();
      const forged = inputFor('forged', 1); (forged.key as { realm: string }).realm = 'preview';
      await assert.rejects(persistence.persistAtomically(forged as never), /INGESTION_REALM_MISMATCH/);
      assert.deepEqual(await counts(), before);
    });

    const validatorEvidence: Record<string, unknown> = {};
    await check('A06 measurement validator enforces the BE-12 contract (0 ≠ null ≠ absent; no NaN/Infinity; cross-field invariants)', async () => {
      const base = () => ({ _id: 'm_' + 'c'.repeat(64), realm: 'test', sourceId: 'synthetic-ingest', operation: 'measurement', eventId: 'v-event', field: 'temperature',
        fingerprint: 'c'.repeat(64), storedAt: new Date(0),
        event: { eventId: 'v-event', sourceId: 'synthetic-ingest', device: { kind: 'mqtt-clientid', value: 'd' }, receivedAt: 10, declaredAt: null, persistedAt: 11,
          magnitude: 'temperature', unit: 'u', value: 1, missingReason: null, provenance: 'simulated', simulated: true, metadata: {} },
        attribution: { realm: 'test', attributedAt: 10, clock: 'received-at', physicalDeviceId: 'd1', clientId: 'c', fieldId: 'f', areaId: 'a', sensorId: 's',
          associationId: 'as', associationRevision: 1 } });
      type Doc = ReturnType<typeof base>;
      const invalid: Record<string, (d: Doc) => void> = {
        'value NaN': d => { d.event.value = Number.NaN; },
        'value Infinity': d => { d.event.value = Number.POSITIVE_INFINITY; },
        'value -Infinity': d => { d.event.value = Number.NEGATIVE_INFINITY; },
        'value absent': d => { delete (d.event as Partial<Doc['event']>).value; },
        'value null without missingReason': d => { (d.event as { value: unknown }).value = null; },
        'value 0 with missingReason': d => { d.event.value = 0; (d.event as { missingReason: unknown }).missingReason = 'absent'; },
        'missingReason absent': d => { delete (d.event as Partial<Doc['event']>).missingReason; },
        'receivedAt Infinity': d => { d.event.receivedAt = Number.POSITIVE_INFINITY; },
        'receivedAt fractional': d => { d.event.receivedAt = 10.5; },
        'persistedAt before receivedAt': d => { d.event.persistedAt = 9; },
        'simulated true with physical provenance': d => { d.event.provenance = 'physical'; },
        'empty magnitude': d => { d.event.magnitude = ''; },
        'metadata nested object': d => { (d.event.metadata as Record<string, unknown>).x = { y: 1 }; },
        'associationRevision fractional': d => { d.attribution.associationRevision = 1.5; },
        'attribution realm differs': d => { d.attribution.realm = 'preview'; },
        'event eventId differs from key': d => { d.event.eventId = 'other'; },
        'event sourceId differs from key': d => { d.event.sourceId = 'other'; },
        'attributedAt Infinity': d => { d.attribution.attributedAt = Number.POSITIVE_INFINITY; },
      };
      const accepted: string[] = [];
      for (const [name, mutate] of Object.entries(invalid)) {
        const doc = base(); mutate(doc);
        try { await measurements.insertOne(doc as never); accepted.push(name); await measurements.deleteOne({ _id: doc._id as never }); }
        catch (error) { if ((error as { code?: number }).code !== 121) throw error; }
      }
      const valid: Record<string, (d: Doc) => void> = {
        'value 0': d => { d.event.value = 0; },
        'value null with missingReason': d => { (d.event as { value: unknown }).value = null; (d.event as { missingReason: unknown }).missingReason = 'absent'; },
        'physical provenance': d => { d.event.provenance = 'physical'; d.event.simulated = false; },
        'metadata scalars': d => { Object.assign(d.event.metadata as Record<string, unknown>, { a: 'x', b: 1, c: true, d: null }); },
      };
      const rejected: string[] = [];
      for (const [name, mutate] of Object.entries(valid)) {
        const doc = base(); mutate(doc);
        try { await measurements.insertOne(doc as never); await measurements.deleteOne({ _id: doc._id as never }); }
        catch { rejected.push(name); }
      }
      validatorEvidence.acceptedInvalid = accepted; validatorEvidence.rejectedValid = rejected;
      console.log('A06 ' + JSON.stringify(validatorEvidence));
      assert.deepEqual(accepted, [], 'validator accepted contract violations');
      assert.deepEqual(rejected, [], 'validator rejected valid documents');
    });
    await check('A07 winning plans for idempotency and measurement lookups', async () => {
      const k = { realm: 'test' as const, sourceId: base.sourceId, operation: 'measurement' as const, eventId: base.eventId, field: 'temperature' };
      const { idempotencyDocumentId } = await import('../src/repositories/mongo-measurement-persistence.repository.js');
      const plan = async (c: typeof claims, filter: object) => { const e = await c.find(filter).explain('queryPlanner') as { queryPlanner: { winningPlan: unknown } };
        return JSON.stringify(e.queryPlanner.winningPlan); };
      const claimPlan = await plan(claims, { _id: idempotencyDocumentId(k), realm: 'test' });
      const keyPlan = await plan(claims, { ...k });
      const measurementPlan = await plan(measurements, { ...k });
      validatorEvidence.plans = { claimLookup: claimPlan, claimByKey: keyPlan, measurementByKey: measurementPlan };
      assert.ok(/IDHACK|EXPRESS|_id_/.test(claimPlan), 'claim lookup uses the _id index');
      assert.ok(keyPlan.includes('idempotency_key_unique'));
      assert.ok(measurementPlan.includes('measurement_key_unique'));
    });

    stage = 'write-evidence';
    writeBe11Evidence(process.cwd(), 'be13-06-mongodb.json', { gitSha: sha, mongoVersion: build.version, topology: request.topology, run: request.runId, results, race: raceEvidence, validator: validatorEvidence,
      indexes: { idempotency: await claims.listIndexes().toArray(), measurements: await measurements.listIndexes().toArray() },
      finalCounts: await counts(), limitations: ['single node; no failover', 'synthetic authorities and policies', 'no Atlas, EMQX or production data'] });
  } finally {
    if (owned && connection?.readyState === 1) { verifyOwnedDocker(request); await connection.db!.dropDatabase(); }
    await connection?.close();
    console.log(JSON.stringify({ event: 'be13-06-summary', passed: results.filter(x => x.status === 'passed').length, failed: results.filter(x => x.status === 'failed').length }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  const failure = classifyBe11Failure(stage, error);
  writeBe11Evidence(process.cwd(), 'be13-06-mongodb-failure.json', { run: run ?? null, failure, results });
  console.error('BE1306_LOCAL_FAILED ' + JSON.stringify(failure)); process.exitCode = 1;
});
