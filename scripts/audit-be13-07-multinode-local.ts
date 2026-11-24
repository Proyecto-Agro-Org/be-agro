// BE13-07 — Resilience campaign against a disposable LOCAL 3-node MongoDB 8.0
// replica set (scripts/be13-07-multinode-local.ps1). No Atlas, no EMQX, no hardware.
// Evidence classification per observation: REAL (caused by an actual server/network
// event), SIMULADO (injected error object), NO_VERIFICABLE (not reproduced).
import assert from 'node:assert/strict';
import { execFile, execFileSync, fork } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Connection } from 'mongoose';
import { chaos, validateMultiNodeRequest, verifyOwnedMultiNode, type MultiNodeRequest } from './be13-07/guard.js';
import { connectMultiNode } from './be13-07/connect.js';
import { provisionSensorCollections, sensorCollections } from '../src/models/sensor.models.js';
import { ingestionCollections, provisionIngestionCollections } from '../src/models/ingestion-persistence.models.js';
import { createMongoIngestionIdentityStore } from '../src/repositories/mongo-ingestion-identity.store.js';
import { createMongoMeasurementPersistence, type PersistenceTestSeams } from '../src/repositories/mongo-measurement-persistence.repository.js';
import { createMeasurementIngestionRoot } from '../src/services/measurement-ingestion-root.js';
import { technicalInputFingerprint } from '../src/iot/ingestion-event-fingerprint.js';
import type { PersistMeasurementInput } from '../src/iot/ingestion-composition.contracts.js';
import type { ProtectedMeasurementCandidate } from '../src/iot/protected-ingest.contracts.js';

type Fixtures = { candidate(patch?: object, options?: object): ProtectedMeasurementCandidate; protectedDocument(patch?: object, options?: object): Record<string, unknown>; RECEIVED: number };
type Status = 'passed' | 'failed' | 'not-verifiable';
const results: { name: string; status: Status; classification?: string; detail?: unknown }[] = [];
let stage = 'bootstrap';
async function check(name: string, work: () => Promise<{ classification?: string; detail?: unknown; notVerifiable?: boolean } | void>) {
  stage = name;
  try {
    const out = (await work()) ?? {};
    const status: Status = out.notVerifiable ? 'not-verifiable' : 'passed';
    results.push({ name, status, classification: out.classification, detail: out.detail });
    console.log((status === 'passed' ? 'PASS ' : 'NOT-VERIFIABLE ') + name + (out.classification ? ' [' + out.classification + ']' : ''));
  } catch (error) { results.push({ name, status: 'failed' }); console.log('FAIL ' + name); throw error; }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const SENSOR = 'agro_sensors_be1307', BUSINESS = 'agro_business_be1307', INGEST = 'agro_ingest_be1307';
const day = (ms: number) => new Date(ms);
const deviceDoc = (realm: string, id: string, patch: object = {}) => ({ _id: realm + ':' + id, realm, id, clientId: 'owner-' + realm, sourceId: 'synthetic-ingest',
  keyKind: 'mqtt-clientid', keyValue: 'synthetic-device-001', verification: 'verified', verificationAuthority: 'synthetic', lifecycle: 'active', version: 3,
  createdAt: day(1), updatedAt: day(2), ...patch });
const associationDoc = (realm: string, id: string, patch: object = {}) => ({ _id: realm + ':' + id, realm, id, revision: 1, clientId: realm === 'test' ? 'client-A' : 'client-preview',
  sensorId: 'sensor-A', fieldId: 'field-A', areaId: 'area-A', validFrom: day(0), validTo: null, auditReason: 'synthetic', physicalDeviceId: 'device-1',
  sourceId: 'synthetic-ingest', keyKind: 'mqtt-clientid', keyValue: 'synthetic-device-001', state: 'active', ...patch });

function gitSha() {
  if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) throw Error('MN_GIT_TREE_NOT_CLEAN');
  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

async function main() {
  stage = 'guard';
  const request = validateMultiNodeRequest(process.env); verifyOwnedMultiNode(request);
  const sha = gitSha();
  const fixtures = await import(pathToFileURL(join(process.cwd(), 'test-support', 'be13-composition.fixtures.js')).href) as Fixtures;
  let connection: Connection | undefined;
  const events: { at: number; kind: string; command: string; code?: unknown; codeName?: unknown; labels?: unknown; wce?: unknown }[] = [];
  try {
    stage = 'connect'; connection = await connectMultiNode(request, true); const db = connection.db!;
    const client = connection.getClient();
    client.on('commandFailed', (e: { commandName: string; failure?: { code?: unknown; codeName?: unknown; name?: unknown; errorLabels?: unknown } }) => {
      let labels: unknown; try { labels = e.failure?.errorLabels; } catch { labels = undefined; }
      events.push({ at: Date.now(), kind: 'failed', command: e.commandName, code: e.failure?.code, codeName: e.failure?.codeName ?? e.failure?.name, labels });
    });
    client.on('commandSucceeded', (e: { commandName: string; reply?: { writeConcernError?: { code?: unknown; codeName?: unknown }; errorLabels?: unknown } }) => {
      if (e.commandName === 'commitTransaction' || e.reply?.writeConcernError) events.push({ at: Date.now(), kind: 'succeeded', command: e.commandName,
        wce: e.reply?.writeConcernError ? { code: e.reply.writeConcernError.code, codeName: e.reply.writeConcernError.codeName } : undefined, labels: e.reply?.errorLabels });
    });
    const commitListeners: Array<() => void> = [];
    client.on('commandStarted', (e: { commandName: string }) => { if (e.commandName === 'commitTransaction') events.push({ at: Date.now(), kind: 'started', command: 'commitTransaction' });
      if (e.commandName === 'commitTransaction') commitListeners.splice(0).forEach(fn => fn()); });
    if ((await db.listCollections().toArray()).length !== 0) throw Error('MN_DATABASE_NOT_EMPTY');
    const build = await db.command({ buildInfo: 1 }); assert.match(String(build.version), /^8\.0\./);

    const status = async () => (await db.admin().command({ replSetGetStatus: 1 }, { readPreference: 'nearest' })) as { set: string; members: { name: string; stateStr: string; health: number }[] };
    const primaryIndex = async () => { const s = await status(); const p = s.members.filter(m => m.stateStr === 'PRIMARY'); return p.length === 1 ? request.ports.indexOf(Number(p[0].name.split(':')[1])) : -1; };
    const waitFor = async (label: string, cond: () => Promise<boolean>, timeoutMs: number) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) { try { if (await cond()) return Date.now() - start; } catch { /* election in progress */ } await sleep(500); }
      throw Error('MN_WAIT_TIMEOUT_' + label);
    };
    const waitHealthy = () => waitFor('healthy', async () => { const s = await status();
      return s.members.filter(m => m.health === 1).length === 3 && s.members.filter(m => m.stateStr === 'PRIMARY').length === 1 && s.members.filter(m => m.stateStr === 'SECONDARY').length === 2; }, 120000);
    const waitNewPrimary = (old: number) => waitFor('new-primary', async () => { const p = await primaryIndex(); return p >= 0 && p !== old; }, 90000);

    stage = 'provision';
    await provisionSensorCollections(connection, SENSOR, BUSINESS);
    await provisionIngestionCollections(connection, INGEST);
    const sn = sensorCollections(SENSOR, BUSINESS), inn = ingestionCollections(INGEST);
    const devices = db.collection(sn.devices), associations = db.collection(sn.associations), claims = db.collection(inn.idempotency), measurements = db.collection(inn.measurements);
    await devices.insertMany([deviceDoc('test', 'device-1'), deviceDoc('preview', 'device-1')] as never[], { writeConcern: { w: 'majority' } });
    await associations.insertMany([associationDoc('test', 'assoc-A'), associationDoc('preview', 'assoc-A')] as never[], { writeConcern: { w: 'majority' } });
    const counts = async () => [await claims.countDocuments({}, { readConcern: { level: 'majority' } } as never), await measurements.countDocuments({}, { readConcern: { level: 'majority' } } as never)];
    const persistenceWith = (seams?: PersistenceTestSeams, realm: 'test' | 'preview' = 'test') => createMongoMeasurementPersistence({ connection: connection!, prefix: INGEST, realm, testSeams: seams });
    const persistence = persistenceWith();
    const inputFor = (eventId: string, value: number, realm: 'test' | 'preview' = 'test'): PersistMeasurementInput => {
      const c = fixtures.candidate({ eventId, payload: { temperature: value } });
      return { key: { realm, sourceId: c.sourceId, operation: 'measurement', eventId, field: 'temperature' }, fingerprint: technicalInputFingerprint(realm, c, 'temperature'),
        event: { eventId, sourceId: c.sourceId, device: { kind: 'mqtt-clientid', value: 'synthetic-device-001' }, receivedAt: fixtures.RECEIVED, declaredAt: null,
          persistedAt: fixtures.RECEIVED + 10, magnitude: 'temperature', unit: 'synthetic-unit', value, missingReason: null, provenance: 'simulated', simulated: true, metadata: {} },
        attribution: { realm, attributedAt: fixtures.RECEIVED, clock: 'received-at', physicalDeviceId: 'device-1', clientId: realm === 'test' ? 'client-A' : 'client-preview',
          fieldId: 'field-A', areaId: 'area-A', sensorId: 'sensor-A', associationId: 'assoc-A', associationRevision: 1 } };
    };
    const orphanFree = async () => {
      const c = await claims.aggregate([{ $lookup: { from: inn.measurements, localField: 'measurementId', foreignField: '_id', as: 'm' } }, { $match: { m: { $size: 0 } } }]).toArray();
      const m = await measurements.aggregate([{ $lookup: { from: inn.idempotency, localField: '_id', foreignField: 'measurementId', as: 'c' } }, { $match: { c: { $size: 0 } } }]).toArray();
      assert.deepEqual([c.length, m.length], [0, 0], 'no orphan claims or measurements');
    };
    const restore = async (index: number) => { chaos(request, 'start', index); await waitHealthy(); };
    const evSince = (t: number) => events.filter(e => e.at >= t);

    await check('MN01 topology: 3 members, 1 primary, 2 secondaries, majority available', async () => {
      const s = await status();
      assert.equal(s.set, 'agro_mn');
      assert.deepEqual(s.members.map(m => m.name).sort(), request.ports.map(p => '127.0.0.1:' + p).sort());
      assert.deepEqual([s.members.filter(m => m.stateStr === 'PRIMARY').length, s.members.filter(m => m.stateStr === 'SECONDARY').length], [1, 2]);
      return { detail: { version: build.version, members: s.members.map(m => [m.name, m.stateStr, m.health]) } };
    });

    // Root E2E on the real multi-node store (synthetic authorities and verifier).
    await check('MN-E2E composition root over the multi-node store: accepted, duplicate, conflict, quarantine', async () => {
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
      const root = createMeasurementIngestionRoot({ realmAuthority: { authorizedRealm: () => 'test' }, provenanceVerifier: verifier as never, ...(synthetic as unknown as Pick<Parameters<typeof createMeasurementIngestionRoot>[0], "temporal" | "hardware" | "catalogue" | "policies">),
        identityStore: createMongoIngestionIdentityStore({ connection: connection!, sensorPrefix: SENSOR, businessPrefix: BUSINESS }), persistence,
        be12: { temporal: { select: async (e: { receivedAt: number }) => ({ status: 'trusted', at: e.receivedAt, clock: 'received-at' }) }, catalogue: { accepts: async () => true } } as never,
        deviceStatusHistory: { mode: 'current-state-only', limitation: 'DEVICE_STATUS_HISTORY_REQUIRED' } });
      const run = async (patch: object, options?: object) => { const doc = fixtures.protectedDocument(patch, options) as { sourceId: string; eventId: string; clientid: string };
        return root.ingest(doc, { syntheticTestOnly: true, sourceId: doc.sourceId, eventId: doc.eventId, clientid: doc.clientid }, { field: 'temperature' }) as Promise<{ status: string; reason?: string; cause?: string; persisted?: boolean }>; };
      const before = await counts();
      const a = await run({ eventId: 'root-e2e' });
      const d = await run({ eventId: 'root-e2e' }, { receivedAt: fixtures.RECEIVED + 9000, persistedAt: fixtures.RECEIVED + 9010 });
      const c = await run({ eventId: 'root-e2e', payload: { temperature: 42, soil_moisture: null } });
      const q = await run({ eventId: 'root-unknown', clientid: 'nobody' });
      assert.deepEqual([a.status, a.persisted, d.status, c.reason, q.cause], ['accepted', true, 'duplicate', 'idempotency-conflict', 'unresolved-device']);
      const after = await counts(); assert.deepEqual([after[0] - before[0], after[1] - before[1]], [1, 1]);
    });

    await check('MN02 normal transaction (majority across 3 nodes)', async () => {
      const r = await persistence.persistAtomically(inputFor('mn02', 1));
      assert.equal(r.status, 'persisted'); await orphanFree();
    });

    let electionMs = 0;
    await check('MN03 failover: stop primary, new primary elected, writes continue', async () => {
      const old = await primaryIndex(); assert.ok(old >= 0);
      chaos(request, 'stop', old);
      electionMs = await waitNewPrimary(old);
      const r = await persistence.persistAtomically(inputFor('mn03', 1));
      assert.equal(r.status, 'persisted');
      await restore(old);
      return { classification: 'REAL', detail: { stoppedNode: old + 1, electionMs, newPrimary: (await primaryIndex()) + 1 } };
    });
    await check('MN04 exact retry after failover → duplicate (majority-committed claim survived)', async () => {
      assert.equal((await persistence.persistAtomically(inputFor('mn02', 1))).status, 'duplicate');
    });
    await check('MN05 conflict after failover', async () => {
      assert.equal((await persistence.persistAtomically(inputFor('mn02', 2))).status, 'conflict');
    });
    await check('MN06 abort before commit leaves nothing', async () => {
      const before = await counts();
      await assert.rejects(persistenceWith({ faultInjection: s => { if (s === 'after-measurement') throw new Error('injected'); } }).persistAtomically(inputFor('mn06', 1)));
      assert.deepEqual(await counts(), before);
    });
    await check('MN07 orphan detection', async () => { await orphanFree(); });

    const race = async (n: number, inputs: PersistMeasurementInput[]) => {
      const environment = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(PATH|Path|SystemRoot|WINDIR|TEMP|TMP|HOME|USERPROFILE|DOCKER_HOST|DOCKER_CONTEXT|DOCKER_CONFIG|AGRO_MN_.*)$/.test(k)));
      const workerPath = join(dirname(fileURLToPath(import.meta.url)), 'be13-07', 'worker.js');
      const children = Array.from({ length: n }, () => fork(workerPath, [], { env: environment, execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }));
      try {
        let armed = 0;
        const outcomes = children.map((child, i) => new Promise<{ outcome: string; attempts: number }>((resolve, reject) => {
          child.on('error', () => reject(new Error('MN_CHILD_FAILED')));
          child.on('exit', code => { if (code !== 0) reject(new Error('MN_CHILD_EXIT')); });
          child.on('message', (m: { status: string; pid: number; outcome?: string; attempts?: number }) => {
            if (m.pid !== child.pid || m.status === 'failed') { reject(new Error('MN_CHILD_PROTOCOL')); return; }
            if (m.status === 'ready') child.send({ prefix: INGEST, input: inputs[i % inputs.length] });
            if (m.status === 'armed' && ++armed === n) for (const c of children) c.send({ go: true });
            if (m.status === 'done') resolve({ outcome: String(m.outcome), attempts: Number(m.attempts) });
          });
        }));
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { return await Promise.race([Promise.all(outcomes), new Promise<never>((_, j) => { timer = setTimeout(() => j(new Error('MN_RACE_DEADLINE')), 120000); })]); }
        finally { clearTimeout(timer); }
      } finally {
        await Promise.all(children.map(c => new Promise<void>(r => { if (c.exitCode !== null || c.signalCode !== null) { r(); return; } const t = setTimeout(() => c.kill(), 5000); c.once('exit', () => { clearTimeout(t); r(); }); })));
      }
    };
    const raceEvidence: Record<string, unknown> = {};
    for (const [id, n] of [['MN08a', 2], ['MN08', 4], ['MN09', 10]] as const) {
      await check(`${id} ${n} concurrent processes, same key and fingerprint → exactly 1 persisted`, async () => {
        const before = await counts();
        const out = await race(n, [inputFor('race-' + n, 1)]);
        assert.deepEqual(out.map(o => o.outcome).sort(), ['persisted', ...Array(n - 1).fill('duplicate')].sort());
        const after = await counts(); assert.deepEqual([after[0] - before[0], after[1] - before[1]], [1, 1]);
        raceEvidence[id] = out.map(o => o.attempts);
      });
    }
    await check('MN09b 10 concurrent processes, different fingerprints → 1 persisted, 9 conflicts', async () => {
      const out = await race(10, Array.from({ length: 10 }, (_, i) => inputFor('race-conflict', i + 1)));
      assert.deepEqual(out.map(o => o.outcome).sort(), ['persisted', ...Array(9).fill('conflict')].sort());
    });
    await check('MN10 cross-realm: same technical key, eventId and field in test and preview are independent', async () => {
      const preview = persistenceWith(undefined, 'preview');
      assert.equal((await preview.persistAtomically(inputFor('mn02', 1, 'preview'))).status, 'persisted');
      assert.equal((await persistence.persistAtomically(inputFor('mn02', 1))).status, 'duplicate');
      assert.equal(await claims.countDocuments({ eventId: 'mn02' }), 2);
      assert.equal(await claims.countDocuments({ eventId: 'mn02', realm: 'test' }), 1);
    });

    // Failover around the claim (F01–F06). Each stops the CURRENT primary at a precise point.
    const fault = async (id: string, label: string, at: 'before-call' | 'after-read' | 'after-claim' | 'after-measurement') => {
      await check(`${id} failover ${label}`, async () => {
        await waitHealthy();
        const before = await counts(), started = Date.now();
        const victim = await primaryIndex(); let attempts = 0;
        const stopPrimary = () => { chaos(request, 'stop', victim); };
        if (at === 'before-call') { stopPrimary(); await waitNewPrimary(victim); }
        const p = persistenceWith({ onAttempt: n => { attempts = n; }, faultInjection: (stage, attempt) => { if (stage === at && attempt === 1) stopPrimary(); } });
        const r = await p.persistAtomically(inputFor(id.toLowerCase(), 1));
        assert.equal(r.status, 'persisted');
        const after = await counts(); assert.deepEqual([after[0] - before[0], after[1] - before[1]], [1, 1]); await orphanFree();
        const failed = evSince(started).filter(e => e.kind === 'failed');
        await restore(victim);
        const transientReal = at !== 'before-call' && attempts >= 2 && failed.length > 0;
        const commitFailures = failed.filter(e => e.command === 'commitTransaction');
        const commitRetried = commitFailures.length >= 2 || (commitFailures.length >= 1 && failed.some(e => e.command === 'commitTransaction' && e.codeName === 'NoSuchTransaction'));
        return { classification: at === 'before-call' ? 'REAL (failover before the operation)'
          : commitRetried ? 'REAL UnknownTransactionCommitResult path (network error on commitTransaction, commit retried, then TransientTransactionError NoSuchTransaction → whole transaction retried)'
          : transientReal ? 'REAL TransientTransactionError path (actual primary loss; whole transaction retried)' : 'REAL failover; retry not required',
          detail: { victim: victim + 1, attempts, failedCommands: failed.map(e => [e.command, e.codeName, e.labels]) } };
      });
    };
    await fault('F01', 'before the claim', 'before-call');
    await fault('F02', 'after reading the claim', 'after-read');
    await fault('F03', 'after inserting the claim (MN13 transient handling)', 'after-claim');
    await fault('F04', 'after inserting the measurement, before commit', 'after-measurement');

    await check('F05 failover during commit (race; best effort)', async () => {
      await waitHealthy();
      const before = await counts(), started = Date.now(), victim = await primaryIndex();
      commitListeners.push(() => { execFile('docker', ['stop', '-t', '10', request.nodes[victim]], () => {}); });
      const r = await persistence.persistAtomically(inputFor('f05', 1));
      assert.ok(r.status === 'persisted');
      await waitFor('victim-stopped', async () => (await primaryIndex()) !== victim, 90000);
      const after = await counts(); assert.deepEqual([after[0] - before[0], after[1] - before[1]], [1, 1]); await orphanFree();
      const ev = evSince(started);
      const commits = ev.filter(e => e.command === 'commitTransaction' && e.kind === 'started').length;
      const ambiguous = ev.some(e => e.command === 'commitTransaction' && (e.kind === 'failed' || e.wce));
      await restore(victim);
      return { classification: ambiguous ? 'REAL commit interrupted' : 'commit completed before the stop (ambiguity not reproduced in this run)', notVerifiable: !ambiguous,
        detail: { commits, events: ev.filter(e => e.command === 'commitTransaction').map(e => [e.kind, e.codeName, e.labels, e.wce]) } };
    });

    await check('MN14 commit ambiguity (UnknownTransactionCommitResult via majority write-concern timeout)', async () => {
      await waitHealthy();
      const before = await counts(), started = Date.now(), primary = await primaryIndex();
      const secondaries = [0, 1, 2].filter(i => i !== primary);
      for (const s of secondaries) chaos(request, 'pause', s);
      let unpaused = false;
      const unpause = sleep(5000).then(() => { for (const s of secondaries) chaos(request, 'unpause', s); unpaused = true; });
      let r: { status: string } | undefined, error: unknown;
      try { r = await persistence.persistAtomically(inputFor('mn14', 1)); } catch (e) { error = e; }
      await unpause; assert.ok(unpaused);
      await waitHealthy();
      const ev = evSince(started).filter(e => e.command === 'commitTransaction');
      const wce = ev.filter(e => e.wce || (e.kind === 'failed'));
      const commits = ev.filter(e => e.kind === 'started').length;
      // Consistency regardless of the client-side outcome: exactly one committed measurement.
      const after = await counts(); assert.deepEqual([after[0] - before[0], after[1] - before[1]], [1, 1]); await orphanFree();
      const retry = await persistence.persistAtomically(inputFor('mn14', 1));
      assert.equal(retry.status, 'duplicate');
      let labels: unknown; try { labels = (error as { errorLabels?: unknown })?.errorLabels; } catch { labels = undefined; }
      const surfaced = Array.isArray(labels) && labels.includes('UnknownTransactionCommitResult');
      const real = wce.length > 0 && (commits >= 2 || surfaced);
      return { classification: real ? (surfaced
          ? 'REAL UnknownTransactionCommitResult surfaced to the caller (write-concern MaxTimeMSExpired on commit; data committed; idempotent retry → duplicate)'
          : 'REAL UnknownTransactionCommitResult (write-concern failure on commit, driver retried commitTransaction)') : 'not reproduced',
        notVerifiable: !real, detail: { outcome: r?.status ?? 'error', errorLabels: (error as { errorLabels?: unknown })?.errorLabels, commits, commitEvents: ev.map(e => [e.kind, e.codeName, e.wce, e.labels]) } };
    });

    await check('MN11 primary restart (stop + start) keeps writes consistent', async () => {
      await waitHealthy();
      const p = await primaryIndex(); chaos(request, 'stop', p); await waitNewPrimary(p); chaos(request, 'start', p); await waitHealthy();
      assert.equal((await persistence.persistAtomically(inputFor('mn11', 1))).status, 'persisted'); await orphanFree();
      return { classification: 'REAL' };
    });
    await check('MN12 secondary restart while writing with majority', async () => {
      await waitHealthy();
      const p = await primaryIndex(), s = [0, 1, 2].find(i => i !== p)!;
      chaos(request, 'stop', s);
      assert.equal((await persistence.persistAtomically(inputFor('mn12', 1))).status, 'persisted');
      await restore(s); await orphanFree();
      return { classification: 'REAL' };
    });
    await check('MN16 pause/unpause primary (unresponsive primary) → election, consistent writes', async () => {
      await waitHealthy();
      const p = await primaryIndex(); chaos(request, 'pause', p);
      const ms = await waitNewPrimary(p);
      assert.equal((await persistence.persistAtomically(inputFor('mn16', 1))).status, 'persisted');
      chaos(request, 'unpause', p); await waitHealthy(); await orphanFree();
      assert.equal((await persistence.persistAtomically(inputFor('mn16', 1))).status, 'duplicate');
      return { classification: 'REAL', detail: { electionMs: ms } };
    });
    await check('F06 retry after every failover scenario → duplicate; final consistency', async () => {
      for (const id of ['mn02', 'mn03', 'f01', 'f02', 'f03', 'f04', 'f05', 'mn11', 'mn12', 'mn14', 'mn16']) {
        assert.equal((await persistence.persistAtomically(inputFor(id, 1))).status, 'duplicate', id);
      }
      await orphanFree();
      const [c, m] = await counts(); assert.equal(c, m);
    });
    results.push({ name: 'MN-NET network disconnect/reconnect of a single member', status: 'not-verifiable',
      classification: 'NO_VERIFICABLE: members share the holder network namespace, so one member cannot be disconnected alone; pause/unpause (MN16) is used instead' });

    stage = 'evidence';
    const dir = join(process.cwd(), '.local-evidence'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'be13-07-multinode.json'), JSON.stringify({ gitSha: sha, mongoVersion: build.version, run: request.runId, electionMs, results, race: raceEvidence,
      finalCounts: await counts(), limitations: ['local Docker, not Atlas', 'tmpfs: a stopped member restarts empty and resyncs', 'synthetic authorities'] }, null, 2));
  } finally {
    if (connection?.readyState === 1) { try { verifyOwnedMultiNode(request); await connection.db!.dropDatabase(); } catch { /* cleanup is confirmed by the launcher */ } }
    await connection?.close().catch(() => {});
    console.log(JSON.stringify({ event: 'be13-07-summary', passed: results.filter(r => r.status === 'passed').length, notVerifiable: results.filter(r => r.status === 'not-verifiable').length,
      failed: results.filter(r => r.status === 'failed').length }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  console.error('BE1307_LOCAL_FAILED ' + JSON.stringify({ stage, errorClass: error instanceof Error ? error.name : 'Unknown', code: error instanceof Error && /^MN_[A-Z_0-9]+$/.test(error.message) ? error.message : undefined,
    serverCode: typeof (error as { code?: unknown })?.code === 'number' ? (error as { code: number }).code : undefined,
    codeName: typeof (error as { codeName?: unknown })?.codeName === 'string' && /^[A-Za-z]+$/.test((error as { codeName: string }).codeName) ? (error as { codeName: string }).codeName : undefined }));
  process.exitCode = 1;
});
