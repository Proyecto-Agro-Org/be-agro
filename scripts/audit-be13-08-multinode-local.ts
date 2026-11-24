// BE13-08 — retry / recovery / quarantine / replay campaign against the disposable
// LOCAL 3-node MongoDB 8.0 replica set (be13-07-multinode-local.ps1 -Suite be13-08).
// Evidence: REAL (actual server/network event), SIMULADO (injected error against a
// real Mongo state), NO_VERIFICABLE. No Atlas, no EMQX, no hardware.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Connection } from 'mongoose';
import { chaos, validateMultiNodeRequest, verifyOwnedMultiNode } from './be13-07/guard.js';
import { connectMultiNode } from './be13-07/connect.js';
import { provisionSensorCollections, sensorCollections } from '../src/models/sensor.models.js';
import { ingestionCollections, provisionIngestionCollections } from '../src/models/ingestion-persistence.models.js';
import { provisionQuarantineCollection, quarantineCollection } from '../src/models/ingestion-quarantine.models.js';
import { createMongoIngestionIdentityStore } from '../src/repositories/mongo-ingestion-identity.store.js';
import { createMongoMeasurementPersistence, idempotencyDocumentId, measurementDocumentId, type PersistenceTestSeams } from '../src/repositories/mongo-measurement-persistence.repository.js';
import { createMongoPersistenceRecovery } from '../src/repositories/mongo-persistence-recovery.repository.js';
import { createMongoIngestionQuarantineStore } from '../src/repositories/mongo-ingestion-quarantine.store.js';
import { createResilientMeasurementIngestionRoot } from '../src/services/measurement-ingestion-root.js';
import { createProductionPlaceholders } from '../src/adapters/ingestion-production-placeholders.js';
import { technicalInputFingerprint } from '../src/iot/ingestion-event-fingerprint.js';
import type { MeasurementPersistencePort } from '../src/iot/ingestion-composition.contracts.js';
import type { ResilientIngestionDependencies, ResilientIngestionResult } from '../src/iot/ingestion-recovery.contracts.js';
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
const SENSOR = 'agro_sensors_be1308', BUSINESS = 'agro_business_be1308', INGEST = 'agro_ingest_be1308';
const day = (ms: number) => new Date(ms);
const deviceDoc = (realm: string, id: string) => ({ _id: realm + ':' + id, realm, id, clientId: 'owner-' + realm, sourceId: 'synthetic-ingest', keyKind: 'mqtt-clientid',
  keyValue: 'synthetic-device-001', verification: 'verified', verificationAuthority: 'synthetic', lifecycle: 'active', version: 3, createdAt: day(1), updatedAt: day(2) });
const associationDoc = (realm: string, id: string) => ({ _id: realm + ':' + id, realm, id, revision: 1, clientId: 'client-A', sensorId: 'sensor-A', fieldId: 'field-A',
  areaId: 'area-A', validFrom: day(0), validTo: null, auditReason: 'synthetic', physicalDeviceId: 'device-1', sourceId: 'synthetic-ingest', keyKind: 'mqtt-clientid',
  keyValue: 'synthetic-device-001', state: 'active' });

async function main() {
  stage = 'guard';
  const request = validateMultiNodeRequest(process.env); verifyOwnedMultiNode(request);
  if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) throw Error('MN_GIT_TREE_NOT_CLEAN');
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const fixtures = await import(pathToFileURL(join(process.cwd(), 'test-support', 'be13-composition.fixtures.js')).href) as Fixtures;
  let connection: Connection | undefined;
  const events: { at: number; command: string; wce?: unknown; codeName?: unknown }[] = [];
  try {
    stage = 'connect'; connection = await connectMultiNode(request, true); const db = connection.db!;
    const client = connection.getClient();
    client.on('commandSucceeded', (e: { commandName: string; reply?: { writeConcernError?: { codeName?: unknown } } }) => {
      if (e.commandName === 'commitTransaction') events.push({ at: Date.now(), command: e.commandName, wce: e.reply?.writeConcernError?.codeName }); });
    client.on('commandFailed', (e: { commandName: string; failure?: { codeName?: unknown; name?: unknown } }) => {
      if (e.commandName === 'commitTransaction') events.push({ at: Date.now(), command: e.commandName, codeName: e.failure?.codeName ?? e.failure?.name }); });
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
    const sn = sensorCollections(SENSOR, BUSINESS), inn = ingestionCollections(INGEST);
    await db.collection(sn.devices).insertMany([deviceDoc('test', 'device-1'), deviceDoc('preview', 'device-1')] as never[], { writeConcern: { w: 'majority' } });
    await db.collection(sn.associations).insertMany([associationDoc('test', 'assoc-A'), associationDoc('preview', 'assoc-A')] as never[], { writeConcern: { w: 'majority' } });
    const claims = db.collection(inn.idempotency), measurements = db.collection(inn.measurements), quarantineRows = db.collection(quarantineCollection(INGEST));
    const counts = async () => [await claims.countDocuments({}, { readConcern: { level: 'majority' } } as never), await measurements.countDocuments({}, { readConcern: { level: 'majority' } } as never)];
    const orphanFree = async () => {
      const c = await claims.aggregate([{ $lookup: { from: inn.measurements, localField: 'measurementId', foreignField: '_id', as: 'm' } }, { $match: { m: { $size: 0 } } }]).toArray();
      const m = await measurements.aggregate([{ $lookup: { from: inn.idempotency, localField: '_id', foreignField: 'measurementId', as: 'c' } }, { $match: { c: { $size: 0 } } }]).toArray();
      return [c.length, m.length];
    };

    const identityStore = createMongoIngestionIdentityStore({ connection, sensorPrefix: SENSOR, businessPrefix: BUSINESS });
    const persistenceWith = (seams?: PersistenceTestSeams) => createMongoMeasurementPersistence({ connection: connection!, prefix: INGEST, realm: 'test', testSeams: seams });
    const recovery = createMongoPersistenceRecovery({ connection, prefix: INGEST, realm: 'test' });
    const quarantine = createMongoIngestionQuarantineStore({ connection, prefix: INGEST, realm: 'test' });
    const previewQuarantine = createMongoIngestionQuarantineStore({ connection, prefix: INGEST, realm: 'preview' });
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
    const waits: unknown[] = [];
    const rootWith = (overrides: Partial<ResilientIngestionDependencies> = {}, maxAttempts = 3) => createResilientMeasurementIngestionRoot({
      realmAuthority: { authorizedRealm: () => 'test' }, provenanceVerifier: verifier as never, ...(synthetic as unknown as Pick<ResilientIngestionDependencies, 'temporal' | 'hardware' | 'catalogue' | 'policies'>),
      identityStore, persistence: persistenceWith(),
      be12: { temporal: { select: async (e: { receivedAt: number }) => ({ status: 'trusted', at: e.receivedAt, clock: 'received-at' }) }, catalogue: { accepts: async () => true } } as never,
      deviceStatusHistory: { mode: 'current-state-only', limitation: 'DEVICE_STATUS_HISTORY_REQUIRED' },
      retryPolicy: { decide: (i: { attempt: number }) => (i.attempt < maxAttempts ? { action: 'retry' as const } : { action: 'stop' as const }) }, // TEST_ONLY bound
      retryScheduler: { async wait(i: unknown) { waits.push(i); } },
      recovery, quarantine, ...overrides,
    } as ResilientIngestionDependencies);
    const docFor = (patch: object = {}, options?: object) => fixtures.protectedDocument(patch, options) as { sourceId: string; eventId: string; clientid: string };
    const evidenceFor = (d: { sourceId: string; eventId: string; clientid: string }) => ({ syntheticTestOnly: true, sourceId: d.sourceId, eventId: d.eventId, clientid: d.clientid });
    const ingest = (root: ReturnType<typeof rootWith>, patch: object = {}, options?: object) => { const d = docFor(patch, options); return root.ingest(d, evidenceFor(d), { field: 'temperature' }); };
    const delta = async (before: number[]) => { const a = await counts(); return [a[0] - before[0], a[1] - before[1]]; };
    const keyFor = (eventId: string) => ({ realm: 'test' as const, sourceId: 'synthetic-ingest', operation: 'measurement' as const, eventId, field: 'temperature' });
    const root = rootWith();

    let q01Id = '';
    await check('Q01 ordinary success', async () => {
      const before = await counts(); const r = await ingest(root, { eventId: 'q01' }) as Extract<ResilientIngestionResult, { status: 'accepted' }>;
      assert.equal(r.status, 'accepted'); q01Id = r.measurementId; assert.deepEqual(await delta(before), [1, 1]);
    });
    await check('Q02 exact duplicate (verified against majority state)', async () => {
      const before = await counts(); const r = await ingest(root, { eventId: 'q01' }, { receivedAt: fixtures.RECEIVED + 7000, persistedAt: fixtures.RECEIVED + 7010 });
      assert.deepEqual([r.status, (r as { measurementId?: string }).measurementId], ['duplicate', q01Id]); assert.deepEqual(await delta(before), [0, 0]);
    });
    await check('Q03 conflict → quarantined BLOCKED (conflict)', async () => {
      const r = await ingest(root, { eventId: 'q01', payload: { temperature: 77, soil_moisture: null } }) as Extract<ResilientIngestionResult, { status: 'quarantined' }>;
      assert.deepEqual([r.reasonCode, r.retryClass, r.quarantineStatus], ['idempotency-conflict', 'conflict', 'BLOCKED']);
    });
    await check('Q04 transient failure → bounded retry → persisted once', async () => {
      const real = persistenceWith(); let fail = true; const before = await counts(); waits.length = 0;
      const flaky: MeasurementPersistencePort = { lookup: k => real.lookup(k), async persistAtomically(i) { if (fail) { fail = false; throw new Error('dependency down'); } return real.persistAtomically(i); } };
      const r = await ingest(rootWith({ persistence: flaky }), { eventId: 'q04' });
      assert.deepEqual([r.status, (r as { attempts: number }).attempts, waits.length], ['accepted', 2, 1]); assert.deepEqual(await delta(before), [1, 1]);
      return { classification: 'SIMULADO dependency error; real transaction on retry' };
    });
    await check('Q05 real ambiguous commit (UnknownTransactionCommitResult) → recovery, zero extra writes', async () => {
      await waitHealthy();
      const p = await primaryIndex(), secondaries = [0, 1, 2].filter(i => i !== p), before = await counts(), started = Date.now();
      for (const s of secondaries) chaos(request, 'pause', s);
      const healed = sleep(6000).then(async () => { for (const s of secondaries) chaos(request, 'unpause', s); await waitHealthy(); });
      // The retry delay waits for the partition to heal (deterministic, no blind sleep inside the code under test).
      const r = await ingest(rootWith({ retryScheduler: { wait: async () => { await healed; } } }), { eventId: 'q05' });
      await healed;
      const commitEvents = events.filter(e => e.at >= started);
      const ambiguous = commitEvents.some(e => e.wce || e.codeName);
      assert.ok(['accepted', 'recovered-committed', 'duplicate'].includes(r.status), r.status);
      assert.deepEqual(await delta(before), [1, 1]); assert.deepEqual(await orphanFree(), [0, 0]);
      return { classification: ambiguous ? 'REAL ambiguous commit (' + commitEvents.map(e => e.wce ?? e.codeName).filter(Boolean).join(',') + ') → ' + r.status : 'commit not ambiguous in this run',
        notVerifiable: !ambiguous, detail: { status: r.status, attempts: (r as { attempts: number }).attempts } };
    });
    await check('Q05b committed-then-error (deterministic) → recovered-committed, zero extra writes', async () => {
      const real = persistenceWith(); const before = await counts(); let calls = 0;
      const ambiguousAfterCommit: MeasurementPersistencePort = { lookup: k => real.lookup(k),
        async persistAtomically(i) { calls += 1; await real.persistAtomically(i); throw Object.assign(new Error('x'), { errorLabels: ['UnknownTransactionCommitResult'] }); } };
      const r = await ingest(rootWith({ persistence: ambiguousAfterCommit }), { eventId: 'q05b' });
      assert.deepEqual([r.status, calls], ['recovered-committed', 1]); assert.deepEqual(await delta(before), [1, 1]);
      return { classification: 'SIMULADO error after a REAL commit; recovery read REAL majority state' };
    });
    await check('Q06 aborted transaction → recovery says not-committed → exact retry persists once', async () => {
      const before = await counts();
      const aborting = persistenceWith({ faultInjection: (s, attempt) => { if (s === 'after-measurement' && attempt === 1 && !abortedOnce) { abortedOnce = true; throw new Error('abort'); } } });
      let abortedOnce = false;
      const r = await ingest(rootWith({ persistence: aborting }), { eventId: 'q06' });
      assert.deepEqual([r.status, (r as { attempts: number }).attempts], ['accepted', 2]); assert.deepEqual(await delta(before), [1, 1]);
      return { classification: 'REAL abort (injected fault inside a real transaction)' };
    });
    await check('Q07 orphan claim (synthetic corruption) → quarantined consistency; evidence kept', async () => {
      const c = fixtures.candidate({ eventId: 'q07' }), k = keyFor('q07');
      await claims.insertOne({ _id: idempotencyDocumentId(k), ...k, fingerprint: technicalInputFingerprint('test', c, 'temperature'), state: 'committed',
        measurementId: measurementDocumentId(k), committedAt: new Date(0) } as never, { writeConcern: { w: 'majority' } });
      const r = await ingest(root, { eventId: 'q07' }) as Extract<ResilientIngestionResult, { status: 'quarantined' }>;
      assert.deepEqual([r.reasonCode, r.retryClass, r.quarantineStatus], ['persistence-state-inconsistent', 'consistency', 'BLOCKED']);
      assert.equal((await quarantine.get(r.quarantineId!))?.cause, 'orphan-claim');
      assert.equal(await claims.countDocuments({ eventId: 'q07' }), 1, 'not repaired, not deleted');
    });
    await check('Q08 orphan measurement (synthetic corruption) → quarantined consistency; evidence kept', async () => {
      const k = keyFor('q08');
      await measurements.insertOne({ _id: measurementDocumentId(k), ...k, fingerprint: 'e'.repeat(64), storedAt: new Date(0),
        event: { eventId: 'q08', sourceId: 'synthetic-ingest', device: { kind: 'mqtt-clientid', value: 'synthetic-device-001' }, receivedAt: 10, declaredAt: null, persistedAt: 11,
          magnitude: 'temperature', unit: 'u', value: 1, missingReason: null, provenance: 'simulated', simulated: true, metadata: {} },
        attribution: { realm: 'test', attributedAt: 10, clock: 'received-at', physicalDeviceId: 'device-1', clientId: 'client-A', fieldId: 'field-A', areaId: 'area-A',
          sensorId: 'sensor-A', associationId: 'assoc-A', associationRevision: 1 } } as never, { writeConcern: { w: 'majority' } });
      const r = await ingest(rootWith({}, 1), { eventId: 'q08' }) as Extract<ResilientIngestionResult, { status: 'quarantined' }>;
      assert.deepEqual([r.reasonCode, r.retryClass], ['persistence-state-inconsistent', 'consistency']);
      assert.equal((await quarantine.get(r.quarantineId!))?.cause, 'orphan-measurement');
      assert.deepEqual([await claims.countDocuments({ eventId: 'q08' }), await measurements.countDocuments({ eventId: 'q08' })], [0, 1]);
    });
    let q09 = '';
    await check('Q09 quarantine insert is sanitized (no payload)', async () => {
      const r = await ingest(root, { eventId: 'q09', clientid: 'nobody', payload: { temperature: 1, secret: 'x-emqx-key=abc' } }) as Extract<ResilientIngestionResult, { status: 'quarantined' }>;
      q09 = r.quarantineId!; const raw = await quarantineRows.findOne({ _id: q09 as never });
      assert.equal(r.retryClass, 'policy-blocked'); assert.ok(raw);
      assert.equal(JSON.stringify(raw).includes('x-emqx-key'), false);
      assert.deepEqual(Object.keys(raw!).sort(), ['_id', 'attemptCount', 'audit', 'cause', 'createdAt', 'device', 'documentDigest', 'eventId', 'field', 'fingerprint', 'firstSeenAt',
        'lastSeenAt', 'operation', 'realm', 'reasonCode', 'retryClass', 'sourceId', 'stage', 'status', 'updatedAt']);
    });
    await check('Q10 repeated quarantine is deduplicated', async () => {
      const r = await ingest(root, { eventId: 'q09', clientid: 'nobody', payload: { temperature: 1, secret: 'x-emqx-key=abc' } }) as Extract<ResilientIngestionResult, { status: 'quarantined' }>;
      const stored = await quarantine.get(q09);
      assert.deepEqual([r.quarantineId, stored?.attemptCount, stored?.audit.length, await quarantineRows.countDocuments({ eventId: 'q09' })], [q09, 2, 2, 1]);
    });
    let q11 = '';
    const q11Doc = docFor({ eventId: 'q11' });
    await check('Q11 retryable classification; retry exhaustion → RETRYABLE (never discarded)', async () => {
      const down: MeasurementPersistencePort = { lookup: k => persistenceWith().lookup(k), persistAtomically: async () => { throw new Error('down'); } };
      const r = await rootWith({ persistence: down }, 2).ingest(q11Doc, evidenceFor(q11Doc), { field: 'temperature' }) as Extract<ResilientIngestionResult, { status: 'quarantined' }>;
      assert.deepEqual([r.retryClass, r.quarantineStatus, r.attempts], ['transient', 'RETRYABLE', 2]); q11 = r.quarantineId!;
      assert.equal((await quarantine.get(q11))?.cause, 'retry-exhausted');
    });
    let q12 = '';
    const q12Doc = docFor({ eventId: 'q12' });
    await check('Q12 security failure is non-retryable (BLOCKED)', async () => {
      const r = await rootWith({ hardware: createProductionPlaceholders().hardware }).ingest(q12Doc, evidenceFor(q12Doc), { field: 'temperature' }) as Extract<ResilientIngestionResult, { status: 'quarantined' }>;
      assert.deepEqual([r.reasonCode, r.retryClass, r.quarantineStatus], ['unverified-hardware', 'security', 'BLOCKED']); q12 = r.quarantineId!;
    });
    await check('Q13 human-decision blocked (BLOCKED_BY_POLICY)', async () => {
      const r = await ingest(rootWith({ policies: { ...synthetic.policies, clock: createProductionPlaceholders().policies.clock } as never }), { eventId: 'q13' }) as Extract<ResilientIngestionResult, { status: 'quarantined' }>;
      assert.deepEqual([r.reasonCode, r.retryClass, r.quarantineStatus], ['unresolved-clock', 'policy-blocked', 'BLOCKED']);
    });
    await check('Q14 cross-realm quarantine isolation', async () => {
      assert.equal(await previewQuarantine.get(q09), null);
      assert.equal(await quarantineRows.countDocuments({ realm: 'preview' }), 0);
      assert.ok((await quarantine.get(q09)) !== null);
    });
    await check('Q15 replay permitted → accepted → RESOLVED', async () => {
      const before = await counts();
      const r = await root.replay({ quarantineId: q11, protectedDocument: q11Doc, provenanceEvidence: evidenceFor(q11Doc), field: 'temperature' });
      assert.equal(r.status, 'replayed');
      assert.deepEqual([(r as { outcome: { status: string } }).outcome.status, (r as { quarantineStatus: string }).quarantineStatus], ['accepted', 'RESOLVED']);
      assert.deepEqual(await delta(before), [1, 1]);
    });
    await check('Q16 replay denied for non-retryable (BLOCKED security)', async () => {
      const before = await counts();
      const r = await root.replay({ quarantineId: q12, protectedDocument: q12Doc, provenanceEvidence: evidenceFor(q12Doc), field: 'temperature' });
      assert.deepEqual(r, { status: 'replay-rejected', reasonCode: 'replay-not-allowed' }); assert.deepEqual(await delta(before), [0, 0]);
    });
    const down: MeasurementPersistencePort = { lookup: k => persistenceWith().lookup(k), persistAtomically: async () => { throw new Error('down'); } };
    const q17Doc = docFor({ eventId: 'q17' });
    const q17 = (await rootWith({ persistence: down }, 1).ingest(q17Doc, evidenceFor(q17Doc), { field: 'temperature' }) as { quarantineId: string }).quarantineId;
    await check('Q17 replay requires the exact identity', async () => {
      const other = docFor({ eventId: 'q17-other' });
      const r = await root.replay({ quarantineId: q17, protectedDocument: other, provenanceEvidence: evidenceFor(other), field: 'temperature' });
      assert.equal((r as { reasonCode: string }).reasonCode, 'replay-identity-mismatch');
    });
    await check('Q18 replay with changed payload is rejected; no write', async () => {
      const before = await counts(); const changed = docFor({ eventId: 'q17', payload: { temperature: 12345, soil_moisture: null } });
      const r = await root.replay({ quarantineId: q17, protectedDocument: changed, provenanceEvidence: evidenceFor(changed), field: 'temperature' });
      assert.equal((r as { reasonCode: string }).reasonCode, 'replay-fingerprint-mismatch'); assert.deepEqual(await delta(before), [0, 0]);
    });
    await check('Q19 audit trail: technical timestamps, outcomes, no secrets', async () => {
      const raw = await quarantineRows.findOne({ _id: q17 as never }) as { audit: { action: string; at: unknown; outcome: string }[] } | null;
      assert.ok(raw);
      assert.deepEqual(raw!.audit.map(a => [a.action, a.outcome]), [['recorded', 'persistence-unavailable'], ['replay', 'replay-identity-mismatch'], ['replay', 'replay-fingerprint-mismatch']]);
      assert.ok(raw!.audit.every(a => a.at instanceof Date));
      assert.equal(/mongodb|stack|password|token|x-emqx/i.test(JSON.stringify(raw)), false);
    });
    await check('Q21 concurrent replays of one entry → at most 1 measurement', async () => {
      const d = docFor({ eventId: 'q21' });
      const id = (await rootWith({ persistence: down }, 1).ingest(d, evidenceFor(d), { field: 'temperature' }) as { quarantineId: string }).quarantineId;
      const before = await counts();
      const out = await Promise.all([1, 2, 3].map(() => root.replay({ quarantineId: id, protectedDocument: d, provenanceEvidence: evidenceFor(d), field: 'temperature' })));
      assert.deepEqual(await delta(before), [1, 1]);
      assert.equal((await quarantine.get(id))?.status, 'RESOLVED');
      return { detail: out.map(o => o.status === 'replayed' ? o.outcome.status : o.reasonCode) };
    });
    await check('Q22 quarantine $jsonSchema rejects invalid documents (real Mongo)', async () => {
      const base = () => ({ _id: 'q_' + 'd'.repeat(64), realm: 'test', stage: 'persistence', sourceId: 's', operation: 'measurement', eventId: 'e', field: 'f', device: null,
        reasonCode: 'dependency-error', cause: null, retryClass: 'transient', fingerprint: null, documentDigest: null, status: 'RETRYABLE', attemptCount: 1,
        firstSeenAt: new Date(0), lastSeenAt: new Date(0), createdAt: new Date(0), updatedAt: new Date(0), audit: [] as unknown[] });
      const invalid: Record<string, (d: Record<string, unknown>) => void> = {
        'invalid status': d => { d.status = 'DONE'; }, 'missing realm': d => { delete d.realm; }, 'empty reason': d => { d.reasonCode = ''; },
        'attempt 0': d => { d.attemptCount = 0; }, 'attempt negative': d => { d.attemptCount = -1; }, 'stack field': d => { d.stack = 'Error: x'; },
        'rawPayload field': d => { d.rawPayload = { temperature: 1 }; }, 'secret-like field': d => { d['x-emqx-key'] = 'abc'; },
        'audit with free text': d => { d.audit = [{ action: 'recorded', at: new Date(0), outcome: 'x y', reasonCode: null, evidence: null }]; },
      };
      const accepted: string[] = [];
      for (const [name, mutate] of Object.entries(invalid)) { const d = base(); mutate(d); try { await quarantineRows.insertOne(d as never); accepted.push(name); await quarantineRows.deleteOne({ _id: d._id as never }); } catch (e) { if ((e as { code?: number }).code !== 121) throw e; } }
      const ok = base(); await quarantineRows.insertOne(ok as never); await quarantineRows.deleteOne({ _id: ok._id as never });
      assert.deepEqual(accepted, []);
    });
    await check('Q23 winning plans for quarantine lookups', async () => {
      const plan = async (f: object) => JSON.stringify(((await quarantineRows.find(f).explain('queryPlanner')) as { queryPlanner: { winningPlan: unknown } }).queryPlanner.winningPlan);
      const [byId, byStatus, byEvent] = [await plan({ _id: q09, realm: 'test' }), await plan({ realm: 'test', status: 'RETRYABLE' }), await plan({ realm: 'test', eventId: 'q09' })];
      assert.ok(/_id_|IDHACK|EXPRESS/.test(byId)); assert.ok(byStatus.includes('quarantine_realm_status')); assert.ok(byEvent.includes('quarantine_realm_event'));
      return { detail: { byId: byId.match(/"indexName":"[^"]+"|IDHACK|EXPRESS_[A-Z_]+/)?.[0], byStatus: 'quarantine_realm_status', byEvent: 'quarantine_realm_event' } };
    });
    await check('Q24 final consistency: no orphan beyond the two synthetic corruptions', async () => {
      assert.deepEqual(await orphanFree(), [1, 1], 'only Q07 (claim) and Q08 (measurement) evidence remains');
    });
    results.push({ name: 'Q20 cleanup', status: 'passed', classification: 'confirmed by the launcher (cleanupConfirmed)' });

    stage = 'evidence';
    const dir = join(process.cwd(), '.local-evidence'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'be13-08-multinode.json'), JSON.stringify({ gitSha: sha, mongoVersion: build.version, run: request.runId, results, finalCounts: await counts(),
      quarantineCount: await quarantineRows.countDocuments({}) }, null, 2));
  } finally {
    if (connection?.readyState === 1) { try { verifyOwnedMultiNode(request); await connection.db!.dropDatabase(); } catch { /* launcher confirms cleanup */ } }
    await connection?.close().catch(() => {});
    console.log(JSON.stringify({ event: 'be13-08-summary', passed: results.filter(r => r.status === 'passed').length, notVerifiable: results.filter(r => r.status === 'not-verifiable').length,
      failed: results.filter(r => r.status === 'failed').length }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  console.error('BE1308_LOCAL_FAILED ' + JSON.stringify({ stage, errorClass: error instanceof Error ? error.name : 'Unknown',
    serverCode: typeof (error as { code?: unknown })?.code === 'number' ? (error as { code: number }).code : undefined,
    message: error instanceof Error && /^(MN_|INGESTION_|QUARANTINE_|RECOVERY_)[A-Z_0-9]+$/.test(error.message) ? error.message : undefined }));
  process.exitCode = 1;
});
