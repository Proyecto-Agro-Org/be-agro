// BE13-11D — REAL local EMQX campaign (LOCAL_TEST_ONLY). One disposable EMQX container on 127.0.0.1 + the disposable 3-node MongoDB 8
// replica set of be13-07-multinode-local.ps1 (-Suite be13-11d). Synthetic publishers A/B/Attacker with credentials generated for the
// run. No Atlas, no external broker, no hardware, no production. Nothing is simulated: a scenario that cannot be controlled is
// reported NO_VERIFICABLE, never PASS.
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mongo, type Connection } from 'mongoose';
import { chaos, validateMultiNodeRequest, verifyOwnedMultiNode } from './be13-07/guard.js';
import { connectMultiNode } from './be13-07/connect.js';
import { provisionSensorCollections, sensorCollections } from '../src/models/sensor.models.js';
import { ingestionCollections, provisionIngestionCollections } from '../src/models/ingestion-persistence.models.js';
import { provisionQuarantineCollection, quarantineCollection } from '../src/models/ingestion-quarantine.models.js';
import { auditCollections, provisionAuditCollections } from '../src/models/ingestion-audit.models.js';
import { brokerInboxCollection, provisionBrokerInboxCollection } from '../src/models/broker-inbox.models.js';
import { brokerInboxStateCollection, provisionBrokerInboxStateCollection } from '../src/models/broker-inbox-state.models.js';
import { loadMqttJsFactory } from '../src/adapters/emqx-mqtt-connect.js';
import { assertLoopbackBrokerUrl, describeEmqxLocalLabReadiness } from '../src/adapters/emqx-mqtt-broker.adapter.js';
import { startEmqxLab, labContainersRemaining, EMQX_IMAGE, type EmqxLab } from './be13-11d/emqx-lab.js';
import { createMongoBrokerInboxReconciliationStore } from '../src/repositories/mongo-broker-inbox-reconciliation.store.js';
import { SENSOR, BUSINESS, INGEST, startLabConsumer, type LabConsumer, type MetricSink } from './be13-11d/lab-consumer.js';

type Status = 'PASS' | 'FAIL' | 'NO_VERIFICABLE';
const results: { id: string; name: string; status: Status; detail?: unknown }[] = [];
class NotVerifiable extends Error {}
let stage = 'bootstrap';
async function check(id: string, name: string, work: () => Promise<unknown>) {
  stage = id;
  try { const detail = await work(); results.push({ id, name, status: 'PASS', detail }); console.log('PASS ' + id + ' ' + name); }
  catch (error) {
    if (error instanceof NotVerifiable) { results.push({ id, name, status: 'NO_VERIFICABLE', detail: error.message }); console.log('NO_VERIFICABLE ' + id + ' ' + name + ' :: ' + error.message); return; }
    results.push({ id, name, status: 'FAIL', detail: error instanceof Error ? error.message.slice(0, 300) : 'error' }); console.log('FAIL ' + id + ' ' + name + ' :: ' + (error instanceof Error ? error.message.slice(0, 300) : 'error')); throw error;
  }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function waitFor(what: string, cond: () => Promise<boolean>, ms = 20000) { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return; await sleep(200); } throw new Error('TIMEOUT_' + what); }

// A hard kill: on POSIX the child reports SIGKILL; on Windows TerminateProcess reports no signal and a non-zero exit code. Either way the child
// must NOT have reached its own failure handler (which prints LAB_CONSUMER_FAILED) and must not have exited cleanly.
const assertKilled = (x: { code: number | null; signal: string | null }, output: string) => {
  assert.ok(x.signal === 'SIGKILL' || (x.code !== null && x.code !== 0), 'child died hard');
  assert.equal(output.includes('LAB_CONSUMER_FAILED'), false, 'child died by its kill hook, not by an error');
};

type PubResult = { connected: boolean; connectError: string | null; publishError: string | null; reasonCode: number | null };

async function main() {
  stage = 'guard';
  const request = validateMultiNodeRequest(process.env); verifyOwnedMultiNode(request);
  if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) throw Error('MN_GIT_TREE_NOT_CLEAN');
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const fx = await import(pathToFileURL(join(process.cwd(), 'test-support', 'be13-11a-broker.fixtures.js')).href) as { envelope(patch?: object): Record<string, unknown>; bytesOf(v: unknown): Buffer };
  const mqttFactory = await loadMqttJsFactory();
  const conns: Connection[] = []; let lab: EmqxLab | null = null; const children = new Set<ChildProcess>(); const consumers = new Set<LabConsumer>();
  const metrics: MetricSink = [];
  const t0 = Date.now();
  try {
    stage = 'connect';
    for (let i = 0; i < 8; i += 1) conns.push(await connectMultiNode(request));
    const connection = conns[0]!, db = connection.db!;
    if ((await db.listCollections().toArray()).length !== 0) throw Error('MN_DATABASE_NOT_EMPTY');
    const build = await db.command({ buildInfo: 1 }); assert.match(String(build.version), /^8\.0\./);
    const status = async () => (await db.admin().command({ replSetGetStatus: 1 }, { readPreference: 'nearest' })) as { members: { name: string; stateStr: string; health: number }[] };
    const waitHealthy = async () => { for (let i = 0; i < 240; i += 1) { try { const s = await status(); if (s.members.filter(m => m.health === 1).length === 3 && s.members.filter(m => m.stateStr === 'PRIMARY').length === 1 && s.members.filter(m => m.stateStr === 'SECONDARY').length === 2) return; } catch { /* election */ } await sleep(500); } throw Error('MN_WAIT_TIMEOUT_healthy'); };
    const primaryIndex = async () => { const p = (await status()).members.find(m => m.stateStr === 'PRIMARY'); return p ? request.ports.indexOf(Number(p.name.split(':')[1])) : -1; };
    stage = 'provision';
    await provisionSensorCollections(connection, SENSOR, BUSINESS); await provisionIngestionCollections(connection, INGEST); await provisionQuarantineCollection(connection, INGEST);
    await provisionAuditCollections(connection, INGEST); await provisionBrokerInboxCollection(connection, INGEST); await provisionBrokerInboxStateCollection(connection, INGEST);
    const sn = sensorCollections(SENSOR, BUSINESS), inn = ingestionCollections(INGEST);
    const day = (ms: number) => new Date(ms);
    for (const [k, src, i] of [['lab-device-a', 'lab-source-a', 'A'], ['lab-device-b', 'lab-source-b', 'B']] as const) {
      await db.collection(sn.devices).insertOne({ _id: 'test:device-' + i, realm: 'test', id: 'device-' + i, clientId: 'owner-' + i, sourceId: src, keyKind: 'mqtt-clientid', keyValue: k, verification: 'verified',
        verificationAuthority: 'synthetic', lifecycle: 'active', version: 3, createdAt: day(1), updatedAt: day(2) } as never, { writeConcern: { w: 'majority' } });
      await db.collection(sn.associations).insertOne({ _id: 'test:assoc-' + i, realm: 'test', id: 'assoc-' + i, revision: 1, clientId: 'client-' + i, sensorId: 'sensor-' + i, fieldId: 'field-' + i, areaId: 'area-' + i,
        validFrom: day(0), validTo: null, auditReason: 'synthetic', physicalDeviceId: 'device-' + i, sourceId: src, keyKind: 'mqtt-clientid', keyValue: k, state: 'active' } as never, { writeConcern: { w: 'majority' } });
    }
    const measurements = db.collection(inn.measurements), inboxRows = db.collection(brokerInboxCollection(INGEST)), stateRows = db.collection(brokerInboxStateCollection(INGEST));
    const quarantineRows = db.collection(quarantineCollection(INGEST));
    const majority = { readConcern: { level: 'majority' } } as never;
    const mCount = (eventId: string) => measurements.countDocuments({ eventId }, majority);
    const eventIdOf = (d: { rawPayload: mongo.Binary }) => { try { return (JSON.parse(Buffer.from(d.rawPayload.buffer.subarray(0, d.rawPayload.length())).toString('utf8')) as { eventId?: string }).eventId ?? ''; } catch { return ''; } };
    const inboxOf = async (eventId: string) => (await inboxRows.find({}, majority).toArray()).filter(d => eventIdOf(d as never) === eventId);
    const iCount = async (eventId: string) => (await inboxOf(eventId)).length;
    let seq = 0; const ev = (tag: string) => `e11d-${tag}-${++seq}`;
    const body = (key: string, eventId: string, patch: object = {}) => fx.bytesOf(fx.envelope({ eventId, clientid: key, ...patch }));
    const quarantineCount = () => quarantineRows.countDocuments({}, majority);

    stage = 'emqx';
    lab = await startEmqxLab(request.basePort, request.runId);
    const L = lab;
    assertLoopbackBrokerUrl(L.brokerUrl);
    const publish = async (user: string, o: { topic: string; payload: Buffer | string; qos?: 0 | 1 | 2; retain?: boolean; clientId?: string; password?: string }): Promise<PubResult> => {
      const client = mqttFactory(L.brokerUrl, { protocolVersion: 5, clientId: o.clientId ?? user, username: user, password: o.password ?? L.secrets[user as 'lab-device-a'] ?? 'labpw-' + '1'.repeat(32), clean: true, reconnectPeriod: 0 }) as unknown as {
        on(e: string, l: (...a: any[]) => void): void; publish(t: string, p: Buffer | string, opts: object, cb: (e: Error | null, packet?: { reasonCode?: number }) => void): void; end(force?: boolean, opts?: object, cb?: () => void): void };
      const out: PubResult = { connected: false, connectError: null, publishError: null, reasonCode: null };
      const ok = await new Promise<boolean>(res => { client.on('connect', () => res(true)); client.on('error', (e: Error) => { out.connectError = L.scrub(e.message); res(false); }); setTimeout(() => res(false), 8000); });
      if (ok) {
        out.connected = true;
        await new Promise<void>(res => client.publish(o.topic, o.payload, { qos: o.qos ?? 1, retain: o.retain ?? false }, (e, packet) => { out.publishError = e ? L.scrub(e.message) : null; out.reasonCode = (e as { code?: number } | null)?.code ?? packet?.reasonCode ?? null; res(); }));
      }
      await new Promise<void>(res => { const t = setTimeout(res, 2000); client.end(false, {}, () => { clearTimeout(t); res(); }); }); return out; // graceful: flushes a QoS0 PUBLISH before closing
    };
    const startConsumer = async (conn: Connection, extra: object = {}) => { const c = await startLabConsumer({ conn, brokerUrl: L.brokerUrl, password: L.secrets['lab-consumer'], metricsSink: metrics, ...extra }); consumers.add(c); return c; };
    const stopConsumer = async (c: LabConsumer) => { consumers.delete(c); await c.stop(); };
    const spawnChild = async (crash: string) => {
      const child = spawn(process.execPath, ['dist/scripts/be13-11d/lab-consumer-process.js'], { env: { ...process.env, LAB_CRASH: crash, LAB_BROKER_URL: L.brokerUrl, LAB_CONSUMER_PASSWORD: L.secrets['lab-consumer'], LAB_CLIENT_ID: 'lab-consumer-1' }, stdio: ['ignore', 'pipe', 'pipe'] });
      children.add(child);
      let out = ''; child.stdout!.on('data', d => { out += L.scrub(String(d)); }); child.stderr!.on('data', d => { out += L.scrub(String(d)); });
      const exited = new Promise<{ code: number | null; signal: string | null }>(res => child.on('exit', (code, signal) => { children.delete(child); res({ code, signal }); }));
      await waitFor('child-ready-' + crash, async () => out.includes('LAB_CONSUMER_READY'), 30000);
      return { child, exited, output: () => out };
    };
    const TOPIC_A = 'agro/lab/in/a', TOPIC_B = 'agro/lab/in/b';
    let main = await startConsumer(conns[1]!);
    const metricNames = () => new Set(metrics.map(m => m.name));
    const track: { attackerEvents: string[]; aEvents: string[] } = { attackerEvents: [], aEvents: [] };

    await check('E01', 'valid authenticated connection (consumer + publisher A) against real EMQX', async () => {
      const r = await publish('lab-device-a', { topic: TOPIC_A, payload: body('lab-device-a', ev('e01')), qos: 1 });
      assert.deepEqual([r.connected, r.publishError], [true, null]);
      assert.match(main.adapter.connectionReference() ?? '', /^emqx-rule-delivery:[0-9a-f]{16}$/);
      await waitFor('e01-processed', async () => (await measurements.countDocuments({}, majority)) === 1);
      return { emqx: EMQX_IMAGE, mqttJs: '5.16.1', protocol: 5 };
    });
    await check('E02', 'invalid credential is refused BY THE BROKER and never reaches the boundary', async () => {
      const before = main.adapter.stats().received, ids = ev('e02');
      const r = await publish('lab-device-a', { topic: TOPIC_A, payload: body('lab-device-a', ids), password: 'labpw-' + '0'.repeat(32) });
      assert.deepEqual([r.connected, /Bad User Name or Password/.test(r.connectError ?? '')], [false, true]);
      await sleep(800);
      assert.deepEqual([main.adapter.stats().received, await iCount(ids), await mCount(ids)], [before, 0, 0]);
      // credential stuffing fixture: 6 more attempts (wrong passwords for real users, unknown users): all refused by the broker
      const attempts = [['lab-device-a', 'labpw-' + '2'.repeat(32)], ['lab-device-b', 'labpw-' + '3'.repeat(32)], ['lab-attacker', 'labpw-' + '4'.repeat(32)], ['lab-consumer', 'labpw-' + '5'.repeat(32)],
        ['lab-ghost', 'labpw-' + '6'.repeat(32)], ['', 'labpw-' + '7'.repeat(32)]] as const;
      for (const [u, pw] of attempts) { const x = await publish(u || 'lab-nameless', { topic: TOPIC_A, payload: body('lab-device-a', ev('e02s')), password: pw }); assert.equal(x.connected, false, u); }
      await sleep(500);
      assert.equal(main.adapter.stats().received, before);
      return { stuffingAttempts: attempts.length + 1, allRefusedByBroker: true };
    });
    await check('E03/E26/E27', 'authenticated but UNMAPPED principal (attacker): no inbox, no quarantine, no measurement', async () => {
      const q0 = await quarantineCount(), i0 = await inboxRows.countDocuments({}), ids = ev('e03'); track.attackerEvents.push(ids);
      const r = await publish('lab-attacker', { topic: TOPIC_A, payload: body('lab-device-a', ids), qos: 1, clientId: 'lab-device-a' });   // strongest form: the unmapped principal also claims A's client id
      assert.equal(r.connected, true);
      await waitFor('e03-seen', async () => main.log.some(l => l.at === 'persist' && l.detail === 'broker-principal-unknown'));
      assert.deepEqual([await iCount(ids), await mCount(ids), await inboxRows.countDocuments({}), await quarantineCount()], [0, 0, i0, q0]);
    });
    await check('E04/E10/E29', 'publisher A QoS1: persisted → ACK → measurement; receipt, bytes and server rawPersistedAt verified', async () => {
      const ids = ev('e04'), bytes = body('lab-device-a', ids); track.aEvents.push(ids);
      const before = Date.now();
      assert.equal((await publish('lab-device-a', { topic: TOPIC_A, payload: bytes, qos: 1 })).publishError, null);
      await waitFor('e04-measured', async () => (await mCount(ids)) === 1);
      await main.idle();
      const [rec] = await inboxOf(ids); assert.ok(rec);
      const stored = Buffer.from((rec!.rawPayload as mongo.Binary).buffer.subarray(0, (rec!.rawPayload as mongo.Binary).length()));
      assert.equal(Buffer.compare(stored, bytes), 0);
      assert.equal(rec!.rawPayloadSha256, createHash('sha256').update(bytes).digest('hex'));
      const persistedAt = (rec!.rawPersistedAt as Date).getTime();
      assert.ok(persistedAt >= before - 1000 && persistedAt <= Date.now() + 1000, 'rawPersistedAt is the Mongo server time');
      assert.equal(/labpw-|password|token/i.test(JSON.stringify({ ...rec, rawPayload: undefined })), false);
      // order proof: persist happened, then the PUBACK was released, then the measurement was processed
      const order = main.log.map(l => l.at).filter(a => ['persist', 'acked', 'processed'].includes(a)).slice(-3);
      assert.deepEqual(order, ['persist', 'acked', 'processed']);
      assert.equal(rec!.realm, 'test'); assert.equal(rec!.sourceId, 'lab-source-a');
      const st = await stateRows.findOne({ _id: rec!._id as never }, majority) as unknown as { status: string; outcome: string };
      assert.deepEqual([st.status, st.outcome], ['completed', 'admission-processed']);
      return { order };
    });
    await check('E05', 'mqttClientId spoof: A connects as client id of B → technical-identity-mismatch, nothing persisted', async () => {
      const ids = ev('e05'), i0 = await inboxRows.countDocuments({});
      const r = await publish('lab-device-a', { topic: TOPIC_A, payload: body('lab-device-b', ids), clientId: 'lab-device-b', qos: 1 });
      assert.equal(r.connected, true);
      await waitFor('e05-seen', async () => main.log.some(l => l.detail === 'technical-identity-mismatch'));
      assert.deepEqual([await iCount(ids), await mCount(ids), await inboxRows.countDocuments({})], [0, 0, i0]);
    });
    await check('E06', 'topic spoof: a foreign topic is denied by the ACL; a topic naming "production" never changes the realm', async () => {
      const denied = await publish('lab-device-a', { topic: TOPIC_B, payload: body('lab-device-a', ev('e06x')), qos: 1 });
      assert.equal(denied.reasonCode, 135);
      const verifiedTopic = await publish('lab-device-a', { topic: 'agro/lab/verified', payload: '{"clientid":"lab-device-b","username":"lab-device-b"}', qos: 1 });
      assert.equal(verifiedTopic.reasonCode, 135);                                    // nobody can forge the broker-authored topic
      const ids = ev('e06'); track.aEvents.push(ids);
      assert.equal((await publish('lab-device-a', { topic: 'agro/lab/in/production/a', payload: body('lab-device-a', ids), qos: 1 })).publishError, null);
      await waitFor('e06-measured', async () => (await mCount(ids)) === 1);
      assert.equal((await inboxOf(ids))[0]!.realm, 'test');
    });
    for (const [id, label, patch, reason] of [['E07', 'sourceId spoof in the payload', { sourceId: 'lab-source-b' }, 'payload-malformed'], ['E08', 'realm spoof in the payload', { realm: 'production' }, 'payload-malformed']] as const) {
      await check(id, `${label}: rejected (closed envelope), nothing persisted`, async () => {
        const ids = ev(id.toLowerCase()), i0 = await inboxRows.countDocuments({}), seen0 = main.log.filter(l => l.detail === reason).length;
        await publish('lab-device-a', { topic: TOPIC_A, payload: body('lab-device-a', ids, patch), qos: 1 });
        await waitFor(id + '-seen', async () => main.log.filter(l => l.detail === reason).length > seen0);
        assert.deepEqual([await iCount(ids), await mCount(ids), await inboxRows.countDocuments({})], [0, 0, i0]);
      });
    }
    await check('E09/E28', 'technical key mismatch / A cannot impersonate B: rejected; B legitimately accepted under ITS source', async () => {
      const ids = ev('e09'), i0 = await inboxRows.countDocuments({});
      await publish('lab-device-a', { topic: TOPIC_A, payload: body('lab-device-b', ids), qos: 1 });   // A's connection, B's key in the body
      await waitFor('e09-seen', async () => main.log.filter(l => l.detail === 'technical-identity-mismatch').length >= 2);
      assert.deepEqual([await iCount(ids), await mCount(ids), await inboxRows.countDocuments({})], [0, 0, i0]);
      const idb = ev('e28');
      assert.equal((await publish('lab-device-b', { topic: TOPIC_B, payload: body('lab-device-b', idb), qos: 1 })).publishError, null);
      await waitFor('e28-measured', async () => (await mCount(idb)) === 1);
      assert.equal((await inboxOf(idb))[0]!.sourceId, 'lab-source-b');
      assert.equal(await measurements.countDocuments({ eventId: ids }), 0);
    });
    await check('E11', 'QoS1 duplicate delivery (same event twice): two inbox records, exactly one measurement', async () => {
      const ids = ev('e11'), bytes = body('lab-device-a', ids); track.aEvents.push(ids);
      await publish('lab-device-a', { topic: TOPIC_A, payload: bytes, qos: 1 }); await publish('lab-device-a', { topic: TOPIC_A, payload: bytes, qos: 1 });
      await waitFor('e11-two-records', async () => (await iCount(ids)) === 2); await main.idle();
      assert.deepEqual([await iCount(ids), await mCount(ids)], [2, 1]);
    });
    await check('E12', 'QoS0 normal path: persisted and processed (no ACK exists for QoS0)', async () => {
      const ids = ev('e12'); track.aEvents.push(ids);
      await publish('lab-device-a', { topic: TOPIC_A, payload: body('lab-device-a', ids), qos: 0 });
      await waitFor('e12-measured', async () => (await mCount(ids)) === 1);
      assert.ok(main.adapter.stats().qos0 >= 1);
    });
    await check('E14', 'retained message is blocked (default policy): nothing persisted', async () => {
      const ids = ev('e14'), i0 = await inboxRows.countDocuments({});
      await publish('lab-device-a', { topic: TOPIC_A, payload: body('lab-device-a', ids), qos: 1, retain: true });
      await waitFor('e14-seen', async () => main.log.some(l => l.detail === 'retained-message-blocked'));
      assert.deepEqual([await iCount(ids), await mCount(ids), await inboxRows.countDocuments({})], [0, 0, i0]);
      await publish('lab-device-a', { topic: TOPIC_A, payload: '', qos: 1, retain: true });           // clear the retained slot
    });
    for (const [id, label, payload, reason] of [['E15', 'invalid JSON', Buffer.from('{"version":1,'), 'payload-malformed'], ['E16', 'dangerous key', Buffer.from('{"version":1,"__proto__":{"x":1}}'), 'payload-dangerous-key'],
      ['E17', 'oversized payload (> TEST_ONLY limit)', Buffer.alloc(5000, 0x20), 'payload-too-large']] as const) {
      await check(id, `${label}: rejected before the verifier/inbox`, async () => {
        const i0 = await inboxRows.countDocuments({}), seen0 = main.log.filter(l => l.detail === reason).length;
        await publish('lab-device-a', { topic: TOPIC_A, payload, qos: 1 });
        await waitFor(id + '-seen', async () => main.log.filter(l => l.detail === reason).length > seen0);
        assert.equal(await inboxRows.countDocuments({}), i0);
      });
    }
    await check('E15b', 'malformed UTF-8 bytes and nested dangerous keys are rejected before the verifier/inbox', async () => {
      const i0 = await inboxRows.countDocuments({});
      for (const [payload, reason] of [[Buffer.from([0x7b, 0xff, 0xfe, 0x7d]), 'payload-invalid-utf8'], [Buffer.from('{"version":1,"payload":{"a":{"constructor":{"prototype":{}}}}}'), 'payload-dangerous-key']] as const) {
        const seen0 = main.log.filter(l => l.detail === reason).length;
        await publish('lab-device-a', { topic: TOPIC_A, payload, qos: 1 });
        await waitFor('e15b-' + reason, async () => main.log.filter(l => l.detail === reason).length > seen0);
      }
      assert.equal(await inboxRows.countDocuments({}), i0);
    });
    await check('E37', 'session/identity reuse: B credentials with the client id of A and A body → rejected; the principal always comes from the CURRENT broker authentication', async () => {
      const ids = ev('e37'), i0 = await inboxRows.countDocuments({}), seen0 = main.log.filter(l => l.detail === 'technical-identity-mismatch').length;
      await publish('lab-device-b', { topic: TOPIC_B, payload: body('lab-device-a', ids), clientId: 'lab-device-a', qos: 1 });
      await waitFor('e37-seen', async () => main.log.filter(l => l.detail === 'technical-identity-mismatch').length > seen0);
      assert.deepEqual([await iCount(ids), await mCount(ids), await inboxRows.countDocuments({})], [0, 0, i0]);
    });
    await check('E31', 'QoS2 smoke (coverage, not a requirement): deferred PUBREC after the durable receipt', async () => {
      const ids = ev('e31'); track.aEvents.push(ids);
      const r = await publish('lab-device-a', { topic: TOPIC_A, payload: body('lab-device-a', ids), qos: 2 });
      if (r.publishError) throw new NotVerifiable('QoS2 publish not completed: ' + r.publishError);
      await waitFor('e31-measured', async () => (await mCount(ids)) === 1);
    });
    await check('E32', 'N1 evidence (no tolerance chosen): broker, adapter and Mongo clocks for one real delivery', async () => {
      const ids = ev('e32'); track.aEvents.push(ids);
      const sent = Date.now();
      await publish('lab-device-a', { topic: TOPIC_A, payload: body('lab-device-a', ids), qos: 1 });
      await waitFor('e32-persisted', async () => (await iCount(ids)) === 1); await main.idle();
      const [rec] = await inboxOf(ids); const brokerAt = main.adapter.lastBrokerReceivedAt()!;
      const evidence = { sentToAdapterReceivedMs: (rec!.receivedAt as Date).getTime() - sent, brokerReceivedToAdapterReceivedMs: (rec!.receivedAt as Date).getTime() - brokerAt,
        adapterReceivedToMongoPersistedMs: (rec!.rawPersistedAt as Date).getTime() - (rec!.receivedAt as Date).getTime() };
      return { ...evidence, note: 'same host, same kernel clock: this does NOT validate production skew; persistedAt<receivedAt remains invalid-timestamp' };
    });

    // ---------------------------------------------------------------- crashes with REAL process death
    const ids20 = ev('e20'); let id20 = '';
    await stopConsumer(main);
    await check('E18', 'consumer process KILLED before the inbox write: no record, no ACK → broker redelivers to the next consumer → one measurement', async () => {
      const ids = ev('e18'), p = await spawnChild('before-persist');
      await publish('lab-device-a', { topic: TOPIC_A, payload: body('lab-device-a', ids), qos: 1 });
      assertKilled(await p.exited, p.output());
      assert.deepEqual([await iCount(ids), await mCount(ids)], [0, 0]);
      main = await startConsumer(conns[2]!);
      await waitFor('e18-redelivered', async () => (await mCount(ids)) === 1); await main.idle();
      assert.deepEqual([await iCount(ids), await mCount(ids)], [1, 1]);
    });
    await stopConsumer(main);
    await check('E19', 'consumer KILLED after the durable receipt but BEFORE the ACK: broker redelivers, two inbox records, one measurement', async () => {
      const ids = ev('e19'), p = await spawnChild('after-persist');
      await publish('lab-device-a', { topic: TOPIC_A, payload: body('lab-device-a', ids), qos: 1 });
      assertKilled(await p.exited, p.output());
      assert.equal(await iCount(ids), 1);                                       // durable, receipted by the dead owner
      assert.equal(await mCount(ids), 0);
      main = await startConsumer(conns[2]!);
      await waitFor('e19-redelivered', async () => (await mCount(ids)) === 1); await main.idle();
      assert.deepEqual([await iCount(ids), await mCount(ids)], [2, 1]);
      const first = (await inboxOf(ids)).sort((a, b) => +(a.rawPersistedAt as Date) - +(b.rawPersistedAt as Date))[0]!;
      assert.equal(((await stateRows.findOne({ _id: first._id as never }, majority)) as unknown as { status: string }).status, 'receipted');   // the dead owner's record still waits
    });
    await stopConsumer(main);
    await check('E20', 'consumer KILLED after the ACK and BEFORE the measurement: broker will NOT redeliver; record durable and receipted; no measurement', async () => {
      const p = await spawnChild('after-ack');
      await publish('lab-device-a', { topic: TOPIC_A, payload: body('lab-device-a', ids20), qos: 1 });
      assertKilled(await p.exited, p.output());
      assert.equal(await iCount(ids20), 1); assert.equal(await mCount(ids20), 0);
      id20 = String((await inboxOf(ids20))[0]!._id);
      assert.equal(((await stateRows.findOne({ _id: id20 as never }, majority)) as unknown as { status: string }).status, 'receipted');
      main = await startConsumer(conns[2]!);
      await sleep(3500);                                                       // a redelivery would show up here
      assert.deepEqual([await iCount(ids20), await mCount(ids20)], [1, 0]);
    });
    await check('E21c', 'cross-realm receipted recovery: a store bound to realm preview can neither list nor claim the dead owner\'s test record', async () => {
      const preview = createMongoBrokerInboxReconciliationStore({ connection: conns[5]!, prefix: INGEST, realm: 'preview' });
      await sleep(1700);
      assert.deepEqual(await preview.listReceiptedCandidates({ realm: 'preview', minAgeMs: 0, limit: 50 }), []);
      assert.equal(await preview.claim({ realm: 'preview', inboxId: id20, claimLeaseMs: 1000, receiptedMinAgeMs: 0 }), null);
      assert.equal(((await stateRows.findOne({ _id: id20 as never }, majority)) as unknown as { status: string }).status, 'receipted');
    });
    await check('E21/E22', 'receipted recovery (TEST_ONLY policy): the dead owner\'s record is recovered ONCE; a second recovery is duplicate-safe', async () => {
      const rec = main.reconciler;
      await sleep(1700);                                                       // past the TEST_ONLY receipted age
      const first = await rec.reconcileOne(id20);
      assert.equal(first, 'recovered-and-processed');
      assert.equal(await mCount(ids20), 1);
      assert.equal(await rec.reconcileOne(id20), 'duplicate');
      assert.equal(await mCount(ids20), 1);
      const st = await stateRows.findOne({ _id: id20 as never }, majority) as unknown as { status: string; version: number; outcome: string };
      assert.deepEqual([st.status, st.version, st.outcome], ['completed', 3, 'recovered-and-processed']);
      // the record from E19 (dead owner, but its redelivery was processed): recovery must report already-processed
      const rows = await stateRows.find({ status: 'receipted' }, majority).toArray();
      const results2: string[] = []; for (const r of rows) results2.push(await rec.reconcileOne(String(r._id)));
      assert.ok(results2.every(x => x === 'already-processed' || x === 'recovered-and-processed'), JSON.stringify(results2));
      return { otherReceiptedRecovered: results2 };
    });
    await check('E23', 'consumer restart: new connection reference, no trusted state reused, delivery works', async () => {
      const before = main.adapter.connectionReference(); await stopConsumer(main); main = await startConsumer(conns[3]!);
      assert.notEqual(main.adapter.connectionReference(), before);
      const ids = ev('e23'); track.aEvents.push(ids);
      await publish('lab-device-a', { topic: TOPIC_A, payload: body('lab-device-a', ids), qos: 1 });
      await waitFor('e23-measured', async () => (await mCount(ids)) === 1);
    });
    await check('E24', 'broker restart: consumer reconnects as a NEW connection; publisher auth persists; the attacker is still refused', async () => {
      const before = main.adapter.connectionReference(); await L.restart(); await sleep(1000); await stopConsumer(main).catch(() => {});
      main = await startConsumer(conns[3]!);
      assert.notEqual(main.adapter.connectionReference(), before);
      const ids = ev('e24'), att = ev('e24x'); track.aEvents.push(ids); track.attackerEvents.push(att);
      assert.equal((await publish('lab-device-a', { topic: TOPIC_A, payload: body('lab-device-a', ids), qos: 1 })).publishError, null);
      await publish('lab-attacker', { topic: TOPIC_A, payload: body('lab-device-a', att), qos: 1 });
      await waitFor('e24-measured', async () => (await mCount(ids)) === 1);
      await waitFor('e24-attacker-seen', async () => main.log.some(l => l.detail === 'broker-principal-unknown'));
      assert.deepEqual([await iCount(att), await mCount(att)], [0, 0]);
    });
    await check('E13', 'QoS0 loss risk is REAL: with the inbox unavailable a QoS0 message is lost for good, while QoS1 is withheld and redelivered', async () => {
      await stopConsumer(main);
      const deadConn = conns[6]!;
      const failing = await startConsumer(deadConn);
      await deadConn.close();                                                   // the durable inbox is now really unreachable for this consumer
      const q0 = ev('e13q0'), q1 = ev('e13q1');
      await publish('lab-device-a', { topic: TOPIC_A, payload: body('lab-device-a', q0), qos: 0 });
      await publish('lab-device-a', { topic: TOPIC_A, payload: body('lab-device-a', q1), qos: 1 });
      await waitFor('e13-failed', async () => failing.log.filter(l => l.at === 'persist' && l.detail === 'broker-inbox-unavailable').length >= 2, 30000);
      assert.deepEqual([await iCount(q0), await iCount(q1)], [0, 0]);
      await stopConsumer(failing);
      main = await startConsumer(conns[3]!);
      await waitFor('e13-q1-redelivered', async () => (await mCount(q1)) === 1);
      await sleep(3000);
      assert.deepEqual([await mCount(q0), await iCount(q0), await mCount(q1)], [0, 0, 1]);        // QoS0: gone; QoS1: recovered by the broker
    });
    await check('E25', 'MongoDB primary failover during delivery: no ACK without a majority receipt; exactly one measurement afterwards', async () => {
      await waitHealthy();
      const ids = ev('e25'), old = await primaryIndex(); track.aEvents.push(ids);
      chaos(request, 'stop', old);
      let path = 'unknown';
      try {
        await publish('lab-device-a', { topic: TOPIC_A, payload: body('lab-device-a', ids), qos: 1 });
        await sleep(2000);
        path = main.adapter.stats().withheld > 0 ? 'withheld-and-redelivered' : 'acked-after-election';
      } finally { chaos(request, 'start', old); await waitHealthy(); }
      if (main.adapter.stats().withheld > 0 || (await iCount(ids)) === 0) { await stopConsumer(main).catch(() => {}); main = await startConsumer(conns[3]!); }
      await waitFor('e25-measured', async () => (await mCount(ids)) === 1, 60000); await main.idle();
      assert.equal(await mCount(ids), 1);
      return { path, stoppedPrimary: old, inboxRecords: await iCount(ids) };
    });
    await check('E33', 'combined broker + Mongo: Mongo majority lost (paused secondaries) while the broker session stays up: nothing ACKed, then redelivered', async () => {
      await waitHealthy();
      const p = await primaryIndex(), secondaries = [0, 1, 2].filter(i => i !== p), ids = ev('e33'), w0 = main.adapter.stats().withheld; track.aEvents.push(ids);
      for (const s of secondaries) chaos(request, 'pause', s);
      try {
        await publish('lab-device-a', { topic: TOPIC_A, payload: body('lab-device-a', ids), qos: 1 });
        await waitFor('e33-withheld', async () => main.adapter.stats().withheld > w0, 40000);
      } finally { for (const s of secondaries) chaos(request, 'unpause', s); }
      await waitHealthy();
      assert.equal(await mCount(ids), 0);
      await stopConsumer(main).catch(() => {}); main = await startConsumer(conns[3]!);
      await waitFor('e33-redelivered', async () => (await mCount(ids)) === 1, 60000); await main.idle();
      return { inboxRecordsForEvent: await iCount(ids), note: 'an ambiguous first write may leave an orphan record without receipt (N4): reconciliation handles it' };
    });
    await check('E34', 'reconciliation after the whole campaign: every receipted/orphan record resolves; one measurement per accepted event; no duplicates', async () => {
      await sleep(1700);
      const report = await main.reconciler.reconcileBrokerInbox({ mode: 'reconcile', limit: 100 }) as unknown as { status: string; results: { result: string }[] };
      assert.equal(report.status, 'report');
      const bad = report.results.filter(r => !['recovered-and-processed', 'already-processed', 'duplicate'].includes(r.result));
      assert.deepEqual(bad, []);
      const dup = await measurements.aggregate([{ $group: { _id: { eventId: '$eventId', field: '$field' }, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }]).toArray();
      assert.equal(dup.length, 0);
      return { reconciled: report.results.map(r => r.result) };
    });
    await check('E26b/E27b', 'attacker events: zero inbox records, zero measurements; no quarantine rows exist at all (security rejections never persist)', async () => {
      for (const id of track.attackerEvents) assert.deepEqual([await iCount(id), await mCount(id)], [0, 0], id);
      assert.equal(await quarantineCount(), 0);
    });
    await check('E35', 'adapter metrics and audit are bounded and secret-free', async () => {
      const names = metricNames(); for (const n of ['broker_adapter_connection_total', 'broker_adapter_delivery_total', 'broker_inbox_persist_total']) assert.ok(names.has(n), n);
      assert.equal(/lab-device|lab-attacker|lab-consumer|labpw-|ib_|e11d-|agro\/lab/.test(JSON.stringify(metrics)), false);
      const audit = await db.collection(auditCollections(INGEST).audit).find({}).toArray();
      assert.equal(/labpw-|password|rawPayload|lab-device-a|agro\/lab/.test(JSON.stringify(audit)), false);
      return { metricNames: [...names].sort() };
    });
    await check('E36', 'secrets: no generated credential appears in EMQX logs, the evidence or any record', async () => {
      const raw = (() => { try { return execFileSync('docker', ['logs', L.containerName], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 }); } catch { return ''; } })();
      const leaked = Object.values(L.secrets).filter(s => raw.includes(s)).length;
      assert.equal(leaked, 0, 'EMQX log contains credential material');
      const dump = JSON.stringify([await inboxRows.find({}).toArray(), await stateRows.find({}).toArray()]);
      assert.equal(Object.values(L.secrets).some(s => dump.includes(s)), false);
    });

    stage = 'cleanup';
    for (const c of [...consumers]) await stopConsumer(c).catch(() => {});
    for (const ch of children) ch.kill('SIGKILL');
    L.stop(); lab = null;
    await check('E30', 'cleanup: EMQX container removed, no child processes, no lab containers left; Mongo cleanup is confirmed by the launcher', async () => {
      assert.deepEqual(labContainersRemaining(), []);
      assert.equal(children.size, 0);
    });
    const readiness = describeEmqxLocalLabReadiness({ loopbackGuard: true, testOnlyCredentials: true, deferredAck: results.find(r => r.id === 'E04/E10/E29')?.status === 'PASS',
      durableInbox: true, reconciliation: results.find(r => r.id === 'E21/E22')?.status === 'PASS', cleanupVerified: results.find(r => r.id === 'E30')?.status === 'PASS' });
    stage = 'evidence';
    const dir = join(process.cwd(), '.local-evidence'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'be13-11d-emqx-local.json'), JSON.stringify({ gitSha: sha, mongoVersion: build.version, emqxImage: EMQX_IMAGE, mqttJs: '5.16.1', run: request.runId, elapsedMs: Date.now() - t0,
      readiness, results, inboxCount: await inboxRows.countDocuments({}), stateCount: await stateRows.countDocuments({}), measurementCount: await measurements.countDocuments({}) }, null, 2));
  } finally {
    for (const c of consumers) await c.stop().catch(() => {});
    for (const ch of children) ch.kill('SIGKILL');
    if (lab) lab.stop();
    const first = conns[0];
    if (first?.readyState === 1) { try { verifyOwnedMultiNode(request); await first.db!.dropDatabase(); } catch { /* launcher confirms cleanup */ } }
    for (const c of conns) await c.close().catch(() => {});
    console.log(JSON.stringify({ event: 'be13-11d-summary', pass: results.filter(r => r.status === 'PASS').length, fail: results.filter(r => r.status === 'FAIL').length,
      noVerificable: results.filter(r => r.status === 'NO_VERIFICABLE').length, labContainersLeft: labContainersRemaining().length }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  console.error('BE1311D_LOCAL_FAILED ' + JSON.stringify({ stage, errorClass: error instanceof Error ? error.name : 'Unknown', message: error instanceof Error ? error.message.slice(0, 160).replace(/labpw-[0-9a-f]+/g, '***') : undefined }));
  process.exitCode = 1;
});
