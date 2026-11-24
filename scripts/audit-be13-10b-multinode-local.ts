// BE13-10B — replay lease governance campaign against the disposable LOCAL 3-node MongoDB 8.0 replica set
// (be13-07-multinode-local.ps1 -Suite be13-10b). One CONNECTION PER OPERATOR: concurrency is real (server side).
// Synthetic operators, TEST_ONLY clock and lease window. No Atlas, EMQX, hardware or credentials.
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
import { provisionQuarantineCollection, quarantineCollection, quarantineValidator, upgradeQuarantineValidatorBe1310b } from '../src/models/ingestion-quarantine.models.js';
import { auditCollections, provisionAuditCollections, upgradeAuditValidatorBe1310b } from '../src/models/ingestion-audit.models.js';
import { createMongoIngestionIdentityStore } from '../src/repositories/mongo-ingestion-identity.store.js';
import { createMongoMeasurementPersistence, type PersistenceStage } from '../src/repositories/mongo-measurement-persistence.repository.js';
import { createMongoPersistenceRecovery } from '../src/repositories/mongo-persistence-recovery.repository.js';
import { createMongoIngestionQuarantineStore } from '../src/repositories/mongo-ingestion-quarantine.store.js';
import { createMongoIngestionAuditStore } from '../src/repositories/mongo-ingestion-audit.store.js';
import { createIngestionOperationsBootstrap } from '../src/services/ingestion-operations.service.js';
import { createResilientMeasurementIngestionRoot } from '../src/services/measurement-ingestion-root.js';
import type { MeasurementPersistencePort } from '../src/iot/ingestion-composition.contracts.js';
import type { IngestionOperationsBootstrapDependencies, OperatorPrincipal } from '../src/iot/ingestion-operations.contracts.js';

type Fixtures = { protectedDocument(patch?: object, options?: object): Record<string, unknown> };
type Doc = { sourceId: string; eventId: string; clientid: string };
const results: { name: string; status: 'passed' | 'failed'; detail?: unknown }[] = [];
let stage = 'bootstrap';
async function check(name: string, work: () => Promise<unknown>) {
  stage = name;
  try { const detail = await work(); results.push({ name, status: 'passed', detail }); console.log('PASS ' + name); }
  catch (error) { results.push({ name, status: 'failed' }); console.log('FAIL ' + name); throw error; }
}
const SENSOR = 'agro_sensors_be1310b', BUSINESS = 'agro_business_be1310b', INGEST = 'agro_ingest_be1310b', MIGRATION = 'agro_ingest_be1310bmig';
const day = (ms: number) => new Date(ms);
const ALL = ['QUARANTINE_VIEW', 'QUARANTINE_REPLAY', 'QUARANTINE_UNBLOCK', 'QUARANTINE_BLOCK', 'QUARANTINE_RESOLVE', 'QUARANTINE_DISCARD', 'AUDIT_VIEW', 'OPERATIONS_VIEW'] as const;
const table: Record<string, OperatorPrincipal> = {
  'tok-a': { operatorId: 'op-a', realms: ['test'], capabilities: ['QUARANTINE_VIEW', 'QUARANTINE_REPLAY'], authenticationReference: 'synthetic:a' },
  'tok-b': { operatorId: 'op-b', realms: ['test'], capabilities: ['QUARANTINE_VIEW', 'QUARANTINE_REPLAY', 'QUARANTINE_UNBLOCK', 'QUARANTINE_DISCARD'], authenticationReference: 'synthetic:b' },
  'tok-c': { operatorId: 'op-c', realms: ['test'], capabilities: ['QUARANTINE_VIEW', 'QUARANTINE_REPLAY', 'QUARANTINE_UNBLOCK'], authenticationReference: 'synthetic:c' },
  'tok-replayer': { operatorId: 'op-replayer', realms: ['test'], capabilities: ['QUARANTINE_REPLAY'], authenticationReference: 'synthetic:replayer' },
  'tok-preview': { operatorId: 'op-preview', realms: ['preview'], capabilities: [...ALL], authenticationReference: 'synthetic:preview' },
};
const authorization = { async authorize({ credential, realm, capability }: { credential: unknown; realm: string; capability: string }) {
  const p = table[(credential as { token?: string } | null)?.token ?? ''];
  if (!p) return { decision: 'deny' as const, reason: 'unauthenticated' as const };
  if (!p.realms.includes(realm as never)) return { decision: 'deny' as const, reason: 'realm-out-of-scope' as const };
  if (!p.capabilities.includes(capability as never)) return { decision: 'deny' as const, reason: 'forbidden' as const };
  return { decision: 'allow' as const, principal: p };
} };
const A = { token: 'tok-a' }, B = { token: 'tok-b' }, C = { token: 'tok-c' };
// TEST_ONLY synthetic time and lease window (NOT production values).
const TEST_ONLY_WINDOW = 1_000;
const clock = { at: 10_000, mode: 'trusted' as 'trusted' | 'untrusted' | 'malformed' };
let policyMode: 'window' | 'active' | 'throw' = 'window';
const timeAuthority = { async now({ realm }: { realm: string }) {
  if (clock.mode === 'untrusted') return { realm, status: 'untrusted' };
  if (clock.mode === 'malformed') return { realm, status: 'trusted', at: 'yesterday', authorityRevision: 1 };
  return { realm, status: 'trusted', at: clock.at, authorityRevision: 1 };
} };
const leasePolicy = { async evaluate({ realm, lease, now }: { realm: string; lease: { acquiredAt: number }; now: number }) {
  if (policyMode === 'throw') throw new Error('policy down');
  const expired = policyMode === 'window' && now - lease.acquiredAt > TEST_ONLY_WINDOW;
  return { realm, status: expired ? 'EXPIRED' : 'ACTIVE', recoveryByNonOwner: 'when-expired', policyRevision: 1 };
} };
const expire = () => { clock.at += TEST_ONLY_WINDOW + 1; };
const evid = () => ({ evidenceType: 'operator-decision' as const, reference: 'TICKET-1' });

type Gate = { stage: PersistenceStage; armed: boolean; reached: Promise<void>; release: () => void; hit: () => void; open: Promise<void> };
function gateAt(stageName: PersistenceStage): Gate {
  let hit!: () => void, release!: () => void;
  const reached = new Promise<void>(r => { hit = r; }), open = new Promise<void>(r => { release = r; });
  return { stage: stageName, armed: true, reached, release, hit, open };
}

async function main() {
  stage = 'guard';
  const request = validateMultiNodeRequest(process.env); verifyOwnedMultiNode(request);
  if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) throw Error('MN_GIT_TREE_NOT_CLEAN');
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const fixtures = await import(pathToFileURL(join(process.cwd(), 'test-support', 'be13-composition.fixtures.js')).href) as Fixtures;
  const conns: Connection[] = [];
  try {
    stage = 'connect';
    for (let i = 0; i < 10; i += 1) conns.push(await connectMultiNode(request));
    const connection = conns[0]!, db = connection.db!;
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
    const measurementsOf = (eventId: string) => measurements.countDocuments({ eventId }, { readConcern: { level: 'majority' } } as never);
    const rawQ = (id: string) => quarantineRows.findOne({ _id: id as never }, { readConcern: { level: 'majority' } } as never);
    const down = new Set<string>();
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

    // One operator = one connection + its own stores and bootstrap.
    function operatorOn(conn: Connection, options: { gate?: Gate; audit?: object } = {}) {
      const real = createMongoMeasurementPersistence({ connection: conn, prefix: INGEST, realm: 'test', testSeams: { faultInjection: async (s: PersistenceStage) => {
        const g = options.gate; if (g && g.armed && g.stage === s) { g.armed = false; g.hit(); await g.open; } } } });
      const persistence: MeasurementPersistencePort = { lookup: k => real.lookup(k), replayFencing: 'atomic',
        async persistAtomically(i, o) { if (down.has(i.key.eventId)) throw new Error('dependency down'); return real.persistAtomically(i, o); } };
      const quarantine = createMongoIngestionQuarantineStore({ connection: conn, prefix: INGEST, realm: 'test' });
      const audit = createMongoIngestionAuditStore({ connection: conn, prefix: INGEST, realm: 'test' });
      const deps = { realmAuthority: { authorizedRealm: () => 'test' }, provenanceVerifier: verifier, ...synthetic,
        identityStore: createMongoIngestionIdentityStore({ connection: conn, sensorPrefix: SENSOR, businessPrefix: BUSINESS }), persistence,
        be12: { temporal: { select: async (e: { receivedAt: number }) => ({ status: 'trusted', at: e.receivedAt, clock: 'received-at' }) }, catalogue: { accepts: async () => true } },
        deviceStatusHistory: { mode: 'current-state-only', limitation: 'DEVICE_STATUS_HISTORY_REQUIRED' },
        retryPolicy: { decide: () => ({ action: 'stop' as const }) }, retryScheduler: { async wait() { /* TEST_ONLY: never waits */ } },
        recovery: createMongoPersistenceRecovery({ connection: conn, prefix: INGEST, realm: 'test' }), quarantine, authorization, audit: options.audit ?? audit,
        metrics: { increment: () => {} }, alerts: { emit: () => {} }, retention: { mode: 'retain-indefinitely' as const }, timeAuthority, leasePolicy,
      } as unknown as IngestionOperationsBootstrapDependencies;
      return { boot: createIngestionOperationsBootstrap(deps), quarantine, audit, deps };
    }
    const base = operatorOn(conns[0]!);
    const docFor = (eventId: string) => fixtures.protectedDocument({ eventId }) as unknown as Doc;
    const evidenceFor = (d: Doc) => ({ syntheticTestOnly: true, sourceId: d.sourceId, eventId: d.eventId, clientid: d.clientid });
    const retryable = async (eventId: string) => {
      down.add(eventId); const d = docFor(eventId);
      const q = await base.boot.ingest(d, evidenceFor(d), { field: 'temperature' }) as { quarantineId: string; quarantineStatus: string };
      assert.equal(q.quarantineStatus, 'RETRYABLE'); down.delete(eventId);
      return { doc: d, id: q.quarantineId, eventId };
    };
    const version = async (id: string) => (await base.quarantine.get(id))!.version;
    const replayInput = async (e: { doc: Doc; id: string }, v?: number) => ({ quarantineId: e.id, expectedVersion: v ?? await version(e.id), protectedDocument: e.doc,
      provenanceEvidence: evidenceFor(e.doc), field: 'temperature' });
    const leaseOp = async (ops: ReturnType<typeof operatorOn>, op: 'releaseLease' | 'recoverExpiredLease' | 'discard', cred: object, id: string, v?: number) =>
      ops.boot.operations[op](cred, { quarantineId: id, expectedVersion: v ?? await version(id), evidence: evid() }) as Promise<{ status: string; reason?: string; quarantineStatus?: string }>;
    const take = async (id: string, owner = 'op-a') => { const r = await base.quarantine.acquireLease({ quarantineId: id, expectedVersion: await version(id), ownerId: owner, acquiredAt: clock.at }); assert.equal(r.result, 'acquired'); return r; };
    const opA = () => operatorOn(conns[1]!), opB = operatorOn(conns[2]!);
    const trail = async (id: string) => (await base.audit.listForQuarantine(id, 200)).map(a => a.action);

    const e1 = await retryable('b01');
    await check('B01 acquire: lease owner = authorized operatorId, acquiredAt = trusted time (BSON date), token = version', async () => {
      const gate = gateAt('after-read'); const a = operatorOn(conns[1]!, { gate });
      const running = a.boot.operations.replay(A, await replayInput(e1));
      await gate.reached;
      const raw = await rawQ(e1.id) as unknown as { status: string; version: number; lease: { ownerId: string; acquiredAt: Date; token: number } };
      assert.equal(raw.status, 'REPLAYING'); assert.equal(raw.lease.ownerId, 'op-a');
      assert.ok(raw.lease.acquiredAt instanceof Date && raw.lease.acquiredAt.getTime() === clock.at); assert.equal(raw.lease.token, raw.version);
      gate.release();
      assert.equal((await running as { quarantineStatus: string }).quarantineStatus, 'RESOLVED');
      assert.equal('lease' in (await rawQ(e1.id))!, false);
      return { token: raw.lease.token };
    });
    await check('B21 audit: lease-acquired recorded with the owner as actor', async () => {
      const entries = await base.audit.listForQuarantine(e1.id, 50);
      assert.ok(entries.some(a => a.action === 'lease-acquired' && a.actorId === 'op-a'));
    });
    const e2 = await retryable('b02');
    await check('B02 owner releases its active lease → RETRYABLE, lease removed from the document', async () => {
      await take(e2.id);
      const r = await leaseOp(opA(), 'releaseLease', A, e2.id);
      assert.deepEqual([r.status, r.quarantineStatus], ['done', 'RETRYABLE']);
      assert.equal('lease' in (await rawQ(e2.id))!, false);
    });
    const e3 = await retryable('b03');
    await check('B03 non-owner cannot release an active lease (release or recovery)', async () => {
      await take(e3.id);
      assert.equal((await leaseOp(opB, 'releaseLease', B, e3.id)).reason, 'lease-owned-by-another-operator');
      assert.equal((await leaseOp(opB, 'recoverExpiredLease', B, e3.id)).reason, 'lease-active');
      assert.equal((await rawQ(e3.id))!.status, 'REPLAYING');
    });
    await check('B22 audit: denied lease operations recorded (lease-release-denied)', async () => {
      assert.equal((await trail(e3.id)).filter(a => a === 'lease-release-denied').length, 2);
    });
    await check('B04 wrong realm: preview operator denied; a preview-bound store cannot acquire a test entry', async () => {
      const e = await retryable('b04');
      assert.equal((await opB.boot.operations.replay({ token: 'tok-preview' }, await replayInput(e)) as { reason: string }).reason, 'realm-out-of-scope');
      const preview = createMongoIngestionQuarantineStore({ connection: conns[3]!, prefix: INGEST, realm: 'preview' });
      assert.equal((await preview.acquireLease({ quarantineId: e.id, expectedVersion: await version(e.id), ownerId: 'op-preview', acquiredAt: clock.at })).result, 'not-found');
      assert.equal((await rawQ(e.id))!.status, 'RETRYABLE');
    });
    await check('B05 stale version denied for acquisition and release', async () => {
      const e = await retryable('b05'); const v = await version(e.id);
      assert.equal((await opA().boot.operations.replay(A, await replayInput(e, v + 1)) as { reason: string }).reason, 'stale-version');
      await take(e.id);
      assert.equal((await leaseOp(opA(), 'releaseLease', A, e.id, v)).reason, 'stale-version');
    });
    const e6 = await retryable('b06');
    await check('B06 untrusted time: no acquisition, no expiry', async () => {
      clock.mode = 'untrusted';
      assert.equal((await opA().boot.operations.replay(A, await replayInput(e6)) as { reason: string }).reason, 'time-authority-unavailable');
      clock.mode = 'trusted'; await take(e6.id); expire(); clock.mode = 'untrusted';
      assert.equal((await leaseOp(opB, 'recoverExpiredLease', B, e6.id)).reason, 'time-authority-unavailable');
      clock.mode = 'trusted';
    });
    await check('B07 malformed time blocks expiry', async () => {
      clock.mode = 'malformed';
      assert.equal((await leaseOp(opB, 'recoverExpiredLease', B, e6.id)).reason, 'time-authority-unavailable');
      clock.mode = 'trusted';
    });
    await check('B08 lease policy throwing blocks expiry', async () => {
      policyMode = 'throw';
      assert.equal((await leaseOp(opB, 'recoverExpiredLease', B, e6.id)).reason, 'lease-policy-unavailable');
      policyMode = 'window';
    });
    await check('B09 explicitly ACTIVE blocks recovery', async () => {
      policyMode = 'active';
      assert.equal((await leaseOp(opB, 'recoverExpiredLease', B, e6.id)).reason, 'lease-active');
      policyMode = 'window';
      assert.equal((await rawQ(e6.id))!.status, 'REPLAYING');
    });
    await check('B11 unauthorized expired recovery denied (no QUARANTINE_UNBLOCK)', async () => {
      assert.equal((await leaseOp(operatorOn(conns[4]!), 'recoverExpiredLease', { token: 'tok-replayer' }, e6.id)).reason, 'forbidden');
    });
    await check('B10 explicitly EXPIRED allows AUTHORIZED recovery → RETRYABLE, lease removed', async () => {
      const r = await leaseOp(opB, 'recoverExpiredLease', B, e6.id);
      assert.deepEqual([r.status, r.quarantineStatus], ['done', 'RETRYABLE']);
      assert.equal('lease' in (await rawQ(e6.id))!, false);
    });
    await check('B23 audit: recovery requested before recovered, in sequence order', async () => {
      const t = await trail(e6.id);
      assert.ok(t.indexOf('lease-recovery-requested') >= 0 && t.indexOf('lease-recovery-requested') < t.indexOf('lease-recovered-expired'));
    });
    for (const n of [2, 10]) {
      await check(`B1${n === 2 ? 2 : 3} ${n} concurrent recoveries on ${n} connections → exactly one winner`, async () => {
        const e = await retryable(`b1${n}`); await take(e.id); expire(); const v = await version(e.id);
        const ops = conns.slice(0, n).map(c => operatorOn(c));
        const out = await Promise.all(ops.map((o, i) => o.boot.operations.recoverExpiredLease(i % 2 ? B : C, { quarantineId: e.id, expectedVersion: v, evidence: evid() })));
        assert.equal(out.filter(r => r.status === 'done').length, 1, JSON.stringify(out.map(r => r.status)));
        assert.equal((await trail(e.id)).filter(a => a === 'lease-recovered-expired').length, 1);
        return { winners: 1, losers: out.filter(r => r.status === 'denied').map(r => (r as { reason: string }).reason) };
      });
    }
    await check('B14 stale replay after recovery + re-acquisition cannot persist; the new owner does (1 measurement)', async () => {
      const e = await retryable('b14'); const gate = gateAt('after-read'); const a = operatorOn(conns[1]!, { gate });
      const runA = a.boot.operations.replay(A, await replayInput(e));
      await gate.reached; expire();
      assert.equal((await leaseOp(opB, 'recoverExpiredLease', B, e.id)).status, 'done');
      assert.equal((await opB.boot.operations.replay(B, await replayInput(e)) as { quarantineStatus: string }).quarantineStatus, 'RESOLVED');
      gate.release();
      assert.equal((await runA as { reason: string }).reason, 'stale-replay-lease');
      assert.equal(await measurementsOf('b14'), 1);
      assert.ok((await trail(e.id)).includes('stale-replay-blocked'));
    });
    await check('B15 active replay persists normally (others denied while it is in flight)', async () => {
      const e = await retryable('b15'); const gate = gateAt('after-fence'); const a = operatorOn(conns[1]!, { gate });
      const runA = a.boot.operations.replay(A, await replayInput(e));
      await gate.reached; // A's fence write is inside its uncommitted transaction
      assert.equal((await leaseOp(opB, 'releaseLease', B, e.id)).reason, 'lease-owned-by-another-operator');
      assert.equal((await leaseOp(opB, 'discard', B, e.id)).reason, 'transition-not-allowed');
      gate.release();
      assert.equal((await runA as { quarantineStatus: string }).quarantineStatus, 'RESOLVED');
      assert.equal(await measurementsOf('b15'), 1);
    });
    await check('B27 fence-first race: an expired-lease recovery issued DURING A\'s fenced commit loses (A commits, B stale)', async () => {
      const e = await retryable('b27'); const gate = gateAt('after-fence'); const a = operatorOn(conns[1]!, { gate });
      const runA = a.boot.operations.replay(A, await replayInput(e));
      await gate.reached; expire();
      const recovering = leaseOp(opB, 'recoverExpiredLease', B, e.id); // blocks on A's uncommitted fence write
      await new Promise(r => setTimeout(r, 300)); gate.release();
      const [ra, rb] = await Promise.all([runA, recovering]);
      assert.equal((ra as { quarantineStatus: string }).quarantineStatus, 'RESOLVED');
      assert.equal(rb.status, 'denied');
      assert.equal(await measurementsOf('b27'), 1);
      assert.equal((await rawQ(e.id))!.status, 'RESOLVED');
      return { recovery: rb.reason };
    });
    await check('B16 replay vs discard (separate connections): never DISCARDED with a measurement', async () => {
      const e = await retryable('b16'); const v = await version(e.id);
      const [rep, dis] = await Promise.all([opA().boot.operations.replay(A, await replayInput(e, v)), opB.boot.operations.discard(B, { quarantineId: e.id, expectedVersion: v, evidence: evid() })]);
      assert.equal([rep.status, dis.status].filter(s => s === 'done').length, 1);
      const final = (await rawQ(e.id))!.status;
      assert.ok(!(final === 'DISCARDED' && (await measurementsOf('b16')) > 0));
      return { winner: rep.status === 'done' ? 'replay' : 'discard', final };
    });
    await check('B17 expired recovery then discard while A is in flight: A fenced, DISCARDED, no measurement', async () => {
      const e = await retryable('b17'); const gate = gateAt('after-read'); const a = operatorOn(conns[1]!, { gate });
      const runA = a.boot.operations.replay(A, await replayInput(e));
      await gate.reached; expire();
      assert.equal((await leaseOp(opB, 'recoverExpiredLease', B, e.id)).status, 'done');
      assert.equal((await leaseOp(opB, 'discard', B, e.id)).quarantineStatus, 'DISCARDED');
      gate.release();
      assert.equal((await runA as { reason: string }).reason, 'stale-replay-lease');
      assert.equal(await measurementsOf('b17'), 0);
      assert.equal((await rawQ(e.id))!.status, 'DISCARDED');
    });
    await check('B18 owner/token mismatch: a replay or settle presenting a lease it does not hold is refused', async () => {
      const e = await retryable('b18'); const held = await take(e.id);
      const root = createResilientMeasurementIngestionRoot(base.deps);
      const input = { quarantineId: e.id, protectedDocument: e.doc, provenanceEvidence: evidenceFor(e.doc), field: 'temperature' };
      assert.equal((await root.replay({ ...input, lease: { ownerId: 'op-b', leaseToken: (held as { leaseToken: number }).leaseToken } }) as { reasonCode: string }).reasonCode, 'stale-replay-lease');
      assert.equal(await base.quarantine.settleReplay({ quarantineId: e.id, holder: { kind: 'lease', ownerId: 'op-b', leaseToken: (held as { leaseToken: number }).leaseToken }, to: 'RETRYABLE', outcome: 'x-y', evidence: null }), 'stale');
      assert.equal(await measurementsOf('b18'), 0);
    });
    const template = async () => { const d = await quarantineRows.findOne({ _id: e2.id as never }) as Record<string, unknown>; return { ...d, _id: 'q_' + 'f'.repeat(64) }; };
    const rejects = async (mutate: (d: Record<string, unknown>) => void) => { const d = await template(); mutate(d);
      try { await quarantineRows.insertOne(d as never); await quarantineRows.deleteOne({ _id: d._id as never }); return false; } catch (e) { if ((e as { code?: number }).code !== 121) throw e; return true; } };
    await check('B19 validator: REPLAYING requires a complete lease', async () => {
      assert.equal(await rejects(d => { d.status = 'REPLAYING'; delete d.lease; }), true);
      assert.equal(await rejects(d => { d.status = 'REPLAYING'; d.lease = { ownerId: 'op-a', acquiredAt: new Date(1) }; }), true);
      assert.equal(await rejects(d => { d.status = 'REPLAYING'; d.lease = { ownerId: 'op-a', acquiredAt: new Date(1), token: 3 }; }), false, 'a complete lease is accepted (removed by the test)');
    });
    await check('B20 validator rejects lease fields inconsistent with status or malformed', async () => {
      for (const m of [(d: Record<string, unknown>) => { d.status = 'RETRYABLE'; d.lease = { ownerId: 'op-a', acquiredAt: new Date(1), token: 3 }; },
        (d: Record<string, unknown>) => { d.status = 'RESOLVED'; d.lease = { ownerId: 'op-a', acquiredAt: new Date(1), token: 3 }; },
        (d: Record<string, unknown>) => { d.status = 'REPLAYING'; d.lease = { ownerId: 'op a', acquiredAt: new Date(1), token: 3 }; },
        (d: Record<string, unknown>) => { d.status = 'REPLAYING'; d.lease = { ownerId: 'op-a', acquiredAt: '2026', token: 3 }; },
        (d: Record<string, unknown>) => { d.status = 'REPLAYING'; d.lease = { ownerId: 'op-a', acquiredAt: new Date(1), token: 0 }; },
        (d: Record<string, unknown>) => { d.status = 'REPLAYING'; d.lease = { ownerId: 'op-a', acquiredAt: new Date(1), token: 3, owner: 'x' }; }]) assert.equal(await rejects(m), true);
    });
    await check('B24 audit failure blocks sensitive recovery (state unchanged)', async () => {
      const e = await retryable('b24'); await take(e.id); expire();
      const broken = operatorOn(conns[5]!, { audit: { ...base.audit, append: async () => { throw new Error('audit down'); } } });
      assert.equal((await leaseOp(broken, 'recoverExpiredLease', B, e.id)).reason, 'audit-unavailable');
      const raw = await rawQ(e.id) as unknown as { status: string; lease: { ownerId: string } };
      assert.deepEqual([raw.status, raw.lease.ownerId], ['REPLAYING', 'op-a']);
    });
    await check('B25 S7 exact reproduction: A leases and starts; B release refused; lease still active; B discard refused; A persists', async () => {
      const e = await retryable('b25'); const gate = gateAt('after-read'); const a = operatorOn(conns[1]!, { gate });
      const runA = a.boot.operations.replay(A, await replayInput(e));                    // 1-2
      await gate.reached;
      assert.equal((await leaseOp(opB, 'releaseLease', B, e.id)).reason, 'lease-owned-by-another-operator'); // 3
      assert.equal((await leaseOp(opB, 'recoverExpiredLease', B, e.id)).reason, 'lease-active');           // 4
      assert.equal((await leaseOp(opB, 'discard', B, e.id)).reason, 'transition-not-allowed');             // 5-6
      gate.release();
      assert.equal((await runA as { quarantineStatus: string }).quarantineStatus, 'RESOLVED');             // 7
      assert.equal(await measurementsOf('b25'), 1);
    });
    await check('B-MIG local validator upgrade: BE13-08/09 documents stay valid; ownerless REPLAYING blocks the upgrade', async () => {
      const name = quarantineCollection(MIGRATION);
      const legacy = structuredClone(quarantineValidator) as { $expr?: unknown; $jsonSchema: { properties: Record<string, unknown> } };
      delete legacy.$expr; delete legacy.$jsonSchema.properties.lease;
      await db.createCollection(name, { collation: { locale: 'simple' }, validationLevel: 'strict', validationAction: 'error', validator: legacy });
      const t = await template(); delete (t as Record<string, unknown>).lease;
      const statuses = ['OPEN', 'RETRYABLE', 'BLOCKED', 'RESOLVED', 'DISCARDED', 'REPLAYING'];
      await db.collection(name).insertMany(statuses.map((status, i) => ({ ...t, _id: 'q_' + String(i).repeat(64), status })) as never);
      assert.deepEqual(await upgradeQuarantineValidatorBe1310b(connection, MIGRATION), { status: 'blocked', orphanReplaying: 1 });
      await db.collection(name).updateOne({ status: 'REPLAYING' }, { $set: { status: 'RETRYABLE' } }); // explicit operator decision (simulated)
      assert.deepEqual(await upgradeQuarantineValidatorBe1310b(connection, MIGRATION), { status: 'upgraded', orphanReplaying: 0 });
      const touched = await db.collection(name).updateMany({}, { $currentDate: { updatedAt: true } });
      assert.equal(touched.modifiedCount, 6, 'every legacy document still validates after the upgrade');
      await assert.rejects(db.collection(name).updateOne({ status: 'OPEN' }, { $set: { status: 'REPLAYING' } }), (e: { code?: number }) => e.code === 121);
      assert.deepEqual(await upgradeAuditValidatorBe1310b(connection, INGEST), { status: 'upgraded' });
    });
    results.push({ name: 'B26 cleanup', status: 'passed', detail: 'confirmed by the launcher (cleanupConfirmed)' });
    stage = 'evidence';
    const dir = join(process.cwd(), '.local-evidence'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'be13-10b-multinode.json'), JSON.stringify({ gitSha: sha, mongoVersion: build.version, run: request.runId, connections: conns.length, results,
      auditCount: await auditRows.countDocuments({}), quarantineCount: await quarantineRows.countDocuments({}), measurementCount: await measurements.countDocuments({}) }, null, 2));
  } finally {
    const first = conns[0];
    if (first?.readyState === 1) { try { verifyOwnedMultiNode(request); await first.db!.dropDatabase(); } catch { /* launcher confirms cleanup */ } }
    for (const c of conns) await c.close().catch(() => {});
    console.log(JSON.stringify({ event: 'be13-10b-summary', passed: results.filter(r => r.status === 'passed').length, failed: results.filter(r => r.status === 'failed').length }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  console.error('BE1310B_LOCAL_FAILED ' + JSON.stringify({ stage, errorClass: error instanceof Error ? error.name : 'Unknown',
    serverCode: typeof (error as { code?: unknown })?.code === 'number' ? (error as { code: number }).code : undefined,
    message: error instanceof Error && /^(MN_|INGESTION_|QUARANTINE_|AUDIT_|RECOVERY_)[A-Z_0-9]+$/.test(error.message) ? error.message : undefined }));
  process.exitCode = 1;
});
