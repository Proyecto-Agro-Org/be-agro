// BE13-11E — LOCAL throughput / concurrency / session / resilience benchmark for the EMQX lab consumer.
// Every number printed or stored is LOCAL_LAB_EVIDENCE (one machine, Docker loopback, synthetic publishers): it is NOT an SLO,
// not a sizing and not a production limit. Functional invariants (no unexpected loss, no second measurement, no ACK before the
// durable receipt) are asserted; performance figures are only measured and reported.
// Profile: BE13_11E_PROFILE=full (default) | quick (mutation runs: T01, T05, T19, T20).
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
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
import { createMongoBrokerInboxReconciliationStore } from '../src/repositories/mongo-broker-inbox-reconciliation.store.js';
import { createMongoIngestionAuditStore } from '../src/repositories/mongo-ingestion-audit.store.js';
import { loadMqttJsFactory } from '../src/adapters/emqx-mqtt-connect.js';
import { EMQX_IMAGE, labContainersRemaining, startEmqxLab, type EmqxLab } from './be13-11d/emqx-lab.js';
import { INGEST, BUSINESS, SENSOR, LOAD_PUBLISHERS, loadName, startLabConsumer, type LabConsumer, type MetricSink, type TimingMap, type LabDepsExtras } from './be13-11d/lab-consumer.js';

type Status = 'PASS' | 'FAIL' | 'NO_VERIFICABLE';
const results: { id: string; name: string; status: Status; metrics?: unknown; note?: string }[] = [];
const profile = process.env.BE13_11E_PROFILE === 'quick' ? 'quick' : 'full';
const only = profile === 'quick' ? new Set(['T01', 'T05', 'T19', 'T20']) : null;
class NotVerifiable extends Error {}
let stage = 'bootstrap';
async function scenario(id: string, name: string, work: () => Promise<unknown>) {
  if (only && !only.has(id)) return;
  stage = id;
  try { const metrics = await work(); results.push({ id, name, status: 'PASS', metrics }); console.log('PASS ' + id + ' ' + name + (metrics ? ' ' + JSON.stringify(metrics).slice(0, 400) : '')); }
  catch (error) {
    if (error instanceof NotVerifiable) { results.push({ id, name, status: 'NO_VERIFICABLE', note: error.message }); console.log('NO_VERIFICABLE ' + id + ' ' + name + ' :: ' + error.message); return; }
    const msg = error instanceof Error ? error.message.slice(0, 300) : 'error';
    results.push({ id, name, status: 'FAIL', note: msg }); console.log('FAIL ' + id + ' ' + name + ' :: ' + msg); throw error;
  }
}
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function waitFor(what: string, cond: () => boolean | Promise<boolean>, ms = 30000) { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return; await sleep(100); } throw new Error('TIMEOUT_' + what); }
const r1 = (n: number) => Math.round(n * 10) / 10;
function dist(values: number[]) {
  const v = values.filter(x => Number.isFinite(x)).sort((a, b) => a - b); if (v.length === 0) return { n: 0 };
  const at = (p: number) => v[Math.min(v.length - 1, Math.floor(p * v.length))]!;
  return { n: v.length, p50: r1(at(0.5)), p95: r1(at(0.95)), p99: r1(at(0.99)), max: r1(v[v.length - 1]!) };
}

type PubClient = { on(e: string, l: (...a: any[]) => void): void; publish(t: string, p: Buffer, o: object, cb: (e: Error | null) => void): void; end(force?: boolean, o?: object, cb?: () => void): void };

async function main() {
  stage = 'guard';
  const request = validateMultiNodeRequest(process.env); verifyOwnedMultiNode(request);
  if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) throw Error('MN_GIT_TREE_NOT_CLEAN');
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const fx = await import(pathToFileURL(join(process.cwd(), 'test-support', 'be13-11a-broker.fixtures.js')).href) as { envelope(patch?: object): Record<string, unknown>; bytesOf(v: unknown): Buffer };
  const mqttFactory = await loadMqttJsFactory();
  const conns: Connection[] = []; let lab: EmqxLab | null = null; const children = new Set<ChildProcess>(); const live = new Set<LabConsumer>();
  const metrics: MetricSink = [], timings: TimingMap = new Map(), publishAt = new Map<string, number>();
  const eld = monitorEventLoopDelay({ resolution: 5 }); eld.enable();
  const mem: { t: number; rss: number; heap: number }[] = [];
  const memTimer = setInterval(() => { const m = process.memoryUsage(); mem.push({ t: Date.now(), rss: m.rss, heap: m.heapUsed }); }, 500);
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
    const sn = sensorCollections(SENSOR, BUSINESS), inn = ingestionCollections(INGEST), day = (ms: number) => new Date(ms);
    const fixed = [['lab-device-a', 'lab-source-a', 'A'], ['lab-device-b', 'lab-source-b', 'B']] as const;
    const devs: object[] = [], assocs: object[] = [];
    const addDevice = (key: string, src: string, tag: string) => {
      devs.push({ _id: 'test:device-' + tag, realm: 'test', id: 'device-' + tag, clientId: 'owner-' + tag, sourceId: src, keyKind: 'mqtt-clientid', keyValue: key, verification: 'verified', verificationAuthority: 'synthetic', lifecycle: 'active', version: 3, createdAt: day(1), updatedAt: day(2) });
      assocs.push({ _id: 'test:assoc-' + tag, realm: 'test', id: 'assoc-' + tag, revision: 1, clientId: 'client-' + tag, sensorId: 'sensor-' + tag, fieldId: 'field-' + tag, areaId: 'area-' + tag, validFrom: day(0), validTo: null, auditReason: 'synthetic', physicalDeviceId: 'device-' + tag, sourceId: src, keyKind: 'mqtt-clientid', keyValue: key, state: 'active' });
    };
    for (const [k, s, t] of fixed) addDevice(k, s, t);
    for (let i = 1; i <= LOAD_PUBLISHERS; i += 1) addDevice(loadName(i), 'lab-load-source-' + String(i).padStart(2, '0'), 'L' + i);
    await db.collection(sn.devices).insertMany(devs as never, { writeConcern: { w: 'majority' } }); await db.collection(sn.associations).insertMany(assocs as never, { writeConcern: { w: 'majority' } });
    const measurements = db.collection(inn.measurements), inboxRows = db.collection(brokerInboxCollection(INGEST)), stateRows = db.collection(brokerInboxStateCollection(INGEST)), quarantineRows = db.collection(quarantineCollection(INGEST));
    const majority = { readConcern: { level: 'majority' } } as never;
    const mCountTag = (tag: string) => measurements.countDocuments({ eventId: { $regex: '^e11e-' + tag + '-' } }, majority);
    const quarantineCount = () => quarantineRows.countDocuments({}, majority);
    const loadUsers = Array.from({ length: LOAD_PUBLISHERS }, (_, i) => loadName(i + 1));

    stage = 'emqx';
    lab = await startEmqxLab(request.basePort, request.runId, loadUsers);
    const L = lab, auditTimings: number[] = [];
    // ---------------------------------------------------------------- consumers (lab supervisor: NOT a production worker)
    let connRR = 1;
    const nextConn = () => conns[1 + ((connRR++) % 3)]!;
    const startConsumer = async (o: { clientId?: string; handlerDelayMs?: number; inboxDelayMs?: number; clean?: boolean; subscribeTopic?: string; receiveMaximum?: number; poisonPolicy?: 'ack-and-drop' | 'withhold' } = {}) => {
      const extras: LabDepsExtras = { auditTimings, ...(o.inboxDelayMs ? { inboxDelayMs: o.inboxDelayMs } : {}) };
      const c = await startLabConsumer({ conn: nextConn(), brokerUrl: L.brokerUrl, password: L.secrets['lab-consumer']!, metricsSink: metrics, timings, extras,
        ...(o.clientId ? { clientId: o.clientId } : {}), ...(o.handlerDelayMs ? { handlerDelayMs: o.handlerDelayMs } : {}), ...(o.clean !== undefined ? { clean: o.clean } : {}),
        ...(o.subscribeTopic ? { subscribeTopic: o.subscribeTopic } : {}), ...(o.receiveMaximum ? { receiveMaximum: o.receiveMaximum } : {}), ...(o.poisonPolicy ? { poisonPolicy: o.poisonPolicy } : {}) });
      live.add(c); return c;
    };
    const stopConsumer = async (c: LabConsumer) => { live.delete(c); await c.stop().catch(() => {}); };
    class Supervisor {
      current: LabConsumer | null = null; restarts = 0; downMs: number[] = []; private timer: NodeJS.Timeout | null = null; private busy = false; private stopped = false; private dead = 0;
      constructor(private o: Parameters<typeof startConsumer>[0] = {}) {}
      async start() { this.current = await startConsumer(this.o); this.timer = setInterval(() => { void this.tick(); }, 250); return this; }
      private async tick() {
        if (this.busy || this.stopped || !this.current?.adapter.closed()) return;
        this.busy = true; const downAt = Date.now(); const old = this.current;
        this.dead += old.adapter.stats().received;
        await stopConsumer(old);
        for (let i = 0; i < 120 && !this.stopped; i += 1) { try { this.current = await startConsumer(this.o); this.restarts += 1; this.downMs.push(Date.now() - downAt); break; } catch { await sleep(1000); } }
        this.busy = false;
      }
      async restartNow() { const old = this.current!; await stopConsumer(old); await sleep(300); this.current = await startConsumer(this.o); this.restarts += 1; }
      async stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); if (this.current) await stopConsumer(this.current); }
      get received() { return this.dead + (this.current?.adapter.stats().received ?? 0); }
    }
    const discardSession = async (clientId: string) => { const c = mqttFactory(L.brokerUrl, { protocolVersion: 5, clientId, username: 'lab-consumer', password: L.secrets['lab-consumer'], clean: true, reconnectPeriod: 0 });
      await new Promise<void>(res => { c.on('connect', () => res()); c.on('error', () => res()); setTimeout(res, 4000); }); await new Promise<void>(res => { c.end(true, {}, () => res()); setTimeout(res, 1000); }); };
    // ---------------------------------------------------------------- publishers
    const openPub = async (user: string, clientId = user, password = L.secrets[user] ?? ''): Promise<PubClient | null> => {
      const c = mqttFactory(L.brokerUrl, { protocolVersion: 5, clientId, username: user, password, clean: true, reconnectPeriod: 0 }) as unknown as PubClient;
      let ok = false; let closed = false; c.on('close', () => { closed = true; });
      ok = await new Promise<boolean>(res => { c.on('connect', () => res(true)); c.on('error', () => res(false)); setTimeout(() => res(false), 8000); });
      if (!ok || closed) { c.end(true); return null; }
      (c as PubClient & { isClosed?: () => boolean }).isClosed = () => closed; return c;
    };
    const publishOnce = (c: PubClient, topic: string, payload: Buffer, qos: 0 | 1 | 2) => new Promise<void>((res, rej) => { c.publish(topic, payload, { qos }, e => e ? rej(e) : res()); });
    const bodyOf = (key: string, eventId: string, seq: number, pad = 0) => {
      const payload: Record<string, unknown> = { temperature: seq }; for (let i = 0; i < pad; i += 1) payload['pad' + i] = 'x'.repeat(250);
      return fx.bytesOf(fx.envelope({ eventId, clientid: key, payload }));
    };
    type Ev = { eventId: string; bytes: Buffer; seq: number };
    // publishes a list of events from ONE publisher with a bounded window and retry on connection failure (an at-least-once publisher)
    async function publishEvents(user: string, topic: string, events: Ev[], opt: { qos?: 0 | 1 | 2; window?: number; sequential?: boolean } = {}) {
      let client = await openPub(user); let next = 0, ackedAt = 0, errors = 0; const window = opt.sequential ? 1 : (opt.window ?? 16), qos = opt.qos ?? 1;
      const worker = async () => {
        for (;;) {
          const i = next++; if (i >= events.length) return; const e = events[i]!;
          if (!publishAt.has(e.eventId)) publishAt.set(e.eventId, performance.now());
          for (let attempt = 0; attempt < 8; attempt += 1) {
            try { if (!client || (client as PubClient & { isClosed?: () => boolean }).isClosed?.()) client = await openPub(user); if (!client) throw new Error('no-conn'); await publishOnce(client, topic, e.bytes, qos); ackedAt = performance.now(); break; }
            catch { errors += 1; client = null; await sleep(300); }
          }
        }
      };
      await Promise.all(Array.from({ length: window }, worker));
      await new Promise<void>(res => { if (!client) return res(); client.end(false, {}, () => res()); setTimeout(res, 1500); });
      return { errors, ackedAt };
    }
    const mkEvents = (tag: string, user: string, count: number, pad = 0, offset = 0): Ev[] => Array.from({ length: count }, (_, i) => { const eventId = `e11e-${tag}-${user.replace('lab-', '')}-${offset + i}`; return { eventId, seq: offset + i, bytes: bodyOf(user, eventId, offset + i, pad) }; });
    const topicOf = (user: string) => user.startsWith('lab-load-') ? 'agro/lab/in/load/' + user : user === 'lab-device-b' ? 'agro/lab/in/b' : 'agro/lab/in/a';
    const processedAll = (ids: string[]) => ids.every(id => timings.get(id)?.processed !== undefined);
    const report = (ids: string[], startedAt: number, endedAt: number, extra: object = {}) => {
      const ts = ids.map(id => ({ t: timings.get(id), p: publishAt.get(id) })).filter(x => x.t && x.p !== undefined) as { t: NonNullable<ReturnType<TimingMap['get']>>; p: number }[];
      const secs = (endedAt - startedAt) / 1000, done = ts.filter(x => x.t.processed !== undefined);
      return { unique: ids.length, processed: done.length, durationS: r1(secs), processedPerS: r1(done.length / secs),
        publishToAdapterMs: dist(ts.map(x => x.t.received - x.p)), adapterToInboxMs: dist(ts.map(x => (x.t.persisted ?? NaN) - x.t.received)), inboxToAckMs: dist(ts.map(x => (x.t.acked ?? NaN) - (x.t.persisted ?? NaN))),
        ackToMeasurementMs: dist(ts.map(x => (x.t.processed ?? NaN) - (x.t.acked ?? NaN))), endToEndMs: dist(ts.map(x => (x.t.processed ?? NaN) - x.p)),
        redelivered: ts.filter(x => x.t.deliveries > 1).length, ...extra };
    };
    const noDuplicateMeasurements = async () => { const dup = await measurements.aggregate([{ $group: { _id: { eventId: '$eventId', field: '$field' }, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }]).toArray(); assert.equal(dup.length, 0, 'a second measurement exists'); };
    const mem0 = () => process.memoryUsage();
    const withProbe = async <T>(fn: () => Promise<T>) => { eld.reset(); const c0 = process.cpuUsage(), m0 = mem0(), w0 = performance.now(); const out = await fn(); const c1 = process.cpuUsage(c0), wall = performance.now() - w0;
      return { out, probe: { cpuPct: r1(((c1.user + c1.system) / 1000) / wall * 100), eventLoopDelayMs: { p50: r1(eld.percentile(50) / 1e6), p99: r1(eld.percentile(99) / 1e6), max: r1(eld.max / 1e6) }, rssMB: Math.round(process.memoryUsage().rss / 1048576), rssDeltaMB: Math.round((process.memoryUsage().rss - m0.rss) / 1048576), heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1048576) } }; };

    // load runner: N publishers (distinct mapped principals), a set of events each, optional duplicate share
    async function load(tag: string, pubs: number, total: number, o: { dupRatio?: number; pad?: number; window?: number; qos?: 0 | 1 | 2; timeoutMs?: number; allowLoss?: boolean; during?: (progress: () => number) => Promise<void> } = {}) {
      const users = loadUsers.slice(0, pubs), per = Math.ceil(total * (1 - (o.dupRatio ?? 0)) / pubs), qos = o.qos ?? 1;
      const all = users.map(u => ({ u, events: mkEvents(tag, u, per, o.pad ?? 0) })); const ids = all.flatMap(a => a.events.map(e => e.eventId));
      const sent0 = performance.now(); let progressed = 0;
      const progress = () => ids.filter(id => timings.get(id)?.persisted !== undefined).length;
      const duringP = o.during ? o.during(progress) : Promise.resolve();
      const outs = await Promise.all(all.map(async a => { const first = await publishEvents(a.u, topicOf(a.u), a.events, { qos, ...(o.window ? { window: o.window } : {}) });
        let dupErrors = 0;
        if (o.dupRatio) { const dups = a.events.slice(0, Math.floor(a.events.length * o.dupRatio / (1 - o.dupRatio))); const d = await publishEvents(a.u, topicOf(a.u), dups.length ? dups : a.events.slice(0, 1), { qos }); dupErrors = d.errors; }
        return first.errors + dupErrors; }));
      await duringP;
      if (o.allowLoss) {   // a scenario that may legitimately lose broker-side queued messages: wait until nothing more arrives for 15 s
        let last = -1, since = Date.now(); const end = Date.now() + (o.timeoutMs ?? 90000);
        while (!processedAll(ids) && Date.now() < end) { const n = ids.filter(id => timings.get(id)?.processed !== undefined).length; if (n !== last) { last = n; since = Date.now(); } else if (Date.now() - since > 15000) break; await sleep(250); }
      } else await waitFor(tag + '-processed', () => processedAll(ids), o.timeoutMs ?? 90000);
      const ended = performance.now(); void progressed;
      return { ids, started: sent0, ended, errors: outs.reduce((a, b) => a + b, 0) };
    }
    // Accounting: every unique event must end as exactly one measurement OR as an open quarantine entry (never missing, never twice).
    const accounting = new Map<string, { unique: number; measurements: number; quarantinedAfterAck: number; missing: number }>();
    const verifyTag = async (tag: string, ids: string[]) => {
      const re = { $regex: '^e11e-' + tag + '-' };
      const m = new Set(await measurements.distinct('eventId', { eventId: re }, majority) as string[]), q = new Set(await quarantineRows.distinct('eventId', { eventId: re }) as string[]);
      const missing = ids.filter(id => !m.has(id) && !q.has(id)); const quarantined = ids.filter(id => !m.has(id) && q.has(id));
      accounting.set(tag, { unique: ids.length, measurements: ids.filter(id => m.has(id)).length, quarantinedAfterAck: quarantined.length, missing: missing.length });
      assert.equal(missing.length, 0, 'no event is lost: ' + JSON.stringify(accounting.get(tag)));
      assert.equal(await mCountTag(tag), ids.length - quarantined.length, 'exactly one measurement per materialized event');
      await noDuplicateMeasurements();
    };

    let main: LabConsumer | null = await startConsumer();
    const quickTag = (id: string) => id.toLowerCase();

    // ---------------------------------------------------------------- T01-T05: baseline, publisher scaling, duplicate load
    const TOTAL = profile === 'quick' ? 100 : 400;
    for (const [id, pubs] of [['T01', 1], ['T02', 2], ['T03', 5], ['T04', 10]] as const) {
      await scenario(id, `${pubs} publisher(s) x QoS1, ${TOTAL} events: LOCAL_LAB_EVIDENCE`, async () => {
        const tag = quickTag(id), q0 = await quarantineCount();
        const { out, probe } = await withProbe(() => load(tag, pubs, TOTAL));
        await verifyTag(tag, out.ids); assert.equal(await quarantineCount(), q0);
        return { label: 'LOCAL_LAB_EVIDENCE', ...report(out.ids, out.started, out.ended, { publisherErrors: out.errors, maxConcurrentHandlers: main!.concurrency.max }), probe };
      });
    }
    await scenario('T04b', '25 publishers x QoS1 (if the machine stays stable)', async () => {
      const tag = 't04b', { out, probe } = await withProbe(() => load(tag, 25, TOTAL, { timeoutMs: 120000 }));
      await verifyTag(tag, out.ids);
      return { label: 'LOCAL_LAB_EVIDENCE', ...report(out.ids, out.started, out.ended), probe };
    });
    await scenario('T05', 'duplicate-heavy load: 50% new events / 50% redeliveries', async () => {
      const tag = 't05', before = await inboxRows.countDocuments({});
      const { out, probe } = await withProbe(() => load(tag, 5, TOTAL, { dupRatio: 0.5 }));
      await sleep(1500); await main!.idle();
      await verifyTag(tag, out.ids);
      const inboxWrites = (await inboxRows.countDocuments({})) - before;
      assert.ok(inboxWrites > out.ids.length, 'duplicates were persisted as separate inbox records (the inbox is insert-only)');
      return { label: 'LOCAL_LAB_EVIDENCE', uniqueEvents: out.ids.length, messagesPublished: inboxWrites, inboxWrites, measurements: await mCountTag(tag), ...report(out.ids, out.started, out.ended), probe };
    });

    // ---------------------------------------------------------------- T06: serialization of customHandleAcks
    await scenario('T06', 'ACK pending serialization: handler delay 40 ms, 1 connection, QoS1, window 64 (+ receiveMaximum profiles)', async () => {
      await stopConsumer(main!); main = null;
      const rows: object[] = [];
      for (const rm of [undefined, 1, 10, 100]) {
        const c = await startConsumer({ handlerDelayMs: 40, ...(rm ? { receiveMaximum: rm } : {}) });
        const tag = 't06' + (rm ?? 'd'), users = loadUsers.slice(0, 1), events = mkEvents(tag, users[0]!, 40); const ids = events.map(e => e.eventId);
        const s0 = performance.now(); let inflight: unknown = null;
        const pub = publishEvents(users[0]!, topicOf(users[0]!), events, { window: 64 });
        await sleep(600); const info = await L.api('GET', '/clients/lab-consumer-1'); inflight = info.body.match(/"inflight_cnt":\s*\d+/)?.[0] ?? null;
        await pub; await waitFor(tag, () => processedAll(ids), 60000); const dur = (performance.now() - s0) / 1000;
        const inbox = ids.map(id => timings.get(id)!.persisted! - timings.get(id)!.received);
        rows.push({ receiveMaximum: rm ?? 'default', maxConcurrentHandlers: c.concurrency.max, durationS: r1(dur), eventsPerS: r1(ids.length / dur), theoreticalSerialPerS: r1(1000 / 40), brokerInflightSample: inflight, handlerToInboxMs: dist(inbox) });
        assert.equal(c.concurrency.max, 1, 'customHandleAcks serializes the connection');
        await verifyTag(tag, ids); await stopConsumer(c);
      }
      main = await startConsumer();
      return { label: 'LOCAL_LAB_EVIDENCE', conclusion: 'one delivery at a time per connection regardless of receiveMaximum or window', profiles: rows };
    });
    await scenario('T07', 'slow Mongo (artificial 25 ms at the inbox boundary; the write is still real majority)', async () => {
      await stopConsumer(main!); const c = await startConsumer({ inboxDelayMs: 25 }); main = c;
      const tag = 't07', { out, probe } = await withProbe(() => load(tag, 2, 100)); await verifyTag(tag, out.ids);
      return { label: 'LOCAL_LAB_EVIDENCE', injectedInboxDelayMs: 25, ...report(out.ids, out.started, out.ended), probe };
    });
    if (main) { await stopConsumer(main); }
    main = await startConsumer();

    // ---------------------------------------------------------------- failures under load (T08-T11)
    const underLoad = async (tag: string, inject: (progress: () => number, sup: Supervisor) => Promise<void>, o: { pubs?: number; total?: number; allowLoss?: boolean } = {}) => {
      await stopConsumer(main!); main = null;
      const sup = await new Supervisor().start(); const total = o.total ?? 240;
      let result;
      try { result = await load(tag, o.pubs ?? 4, total, { window: 8, timeoutMs: 180000, ...(o.allowLoss ? { allowLoss: true } : {}), during: progress => inject(progress, sup) }); }
      finally { /* keep the supervisor until verified */ }
      await sleep(1500);
      const rep = report(result.ids, result.started, result.ended, { publisherErrors: result.errors, consumerRestarts: sup.restarts, reconnectMs: dist(sup.downMs) });
      const lost = result.ids.filter(id => timings.get(id)?.persisted === undefined).length;   // events that never got a durable receipt at all
      const inboxRecords = await inboxRows.countDocuments({ rawPayloadSha256: { $exists: true } });
      await noDuplicateMeasurements();
      await sup.stop(); main = await startConsumer();
      return { result, rep, lost, inboxRecords };
    };
    await scenario('T08', 'Mongo MAJORITY LOSS under load (paused secondaries ~8 s): no ACK without a receipt, redelivery after healing, no loss', async () => {
      const x = await underLoad('t08', async progress => { await waitFor('t08-30pct', () => progress() >= 60, 120000); const p = await primaryIndex(), sec = [0, 1, 2].filter(i => i !== p);
        for (const s of sec) chaos(request, 'pause', s); try { await sleep(8000); } finally { for (const s of sec) chaos(request, 'unpause', s); } await waitHealthy(); });
      assert.equal(x.lost, 0, 'no event lost'); await verifyTag('t08', x.result.ids);
      return { label: 'LOCAL_LAB_EVIDENCE', lost: x.lost, accounting: accounting.get('t08'), ...x.rep, note: 'withheld ACKs were redelivered after healing; ambiguous writes may leave orphan inbox records (N4) resolved by reconciliation' };
    });
    await scenario('T09', 'Mongo PRIMARY FAILOVER under load', async () => {
      const x = await underLoad('t09', async progress => { await waitFor('t09-30pct', () => progress() >= 60, 120000); const old = await primaryIndex(); chaos(request, 'stop', old); try { await sleep(15000); } finally { chaos(request, 'start', old); } await waitHealthy(); });
      assert.equal(x.lost, 0); await verifyTag('t09', x.result.ids);
      return { label: 'LOCAL_LAB_EVIDENCE', lost: x.lost, accounting: accounting.get('t09'), ...x.rep, note: 'events ACKed before the failover whose post-ACK processing hit the election end as an open QUARANTINE entry (retryable via replay), never as a loss' };
    });
    await scenario('T10', 'EMQX BROKER RESTART under load (publishers retry; the broker session is NOT durable)', async () => {
      const x = await underLoad('t10', async progress => { await waitFor('t10-30pct', () => progress() >= 50, 120000); await L.restart(); await sleep(1000); }, { total: 200, allowLoss: true });
      // The publisher retries what the broker never acknowledged. Messages ACKed to the publisher but still queued in the broker session can be lost by a restart.
      const lostBeforeReceipt = x.result.ids.filter(id => timings.get(id)?.persisted === undefined).length;
      return { label: 'LOCAL_LAB_EVIDENCE', lostAfterBrokerRestart: lostBeforeReceipt, uniqueEvents: x.result.ids.length, ...x.rep, finding: lostBeforeReceipt > 0 ? 'BROKER_RESTART_LOSES_QUEUED_QOS1_WITHOUT_DURABLE_SESSIONS' : 'no loss observed in this run' };
    });
    await scenario('T11', 'consumer RESTART under load (persistent session): zero loss', async () => {
      const x = await underLoad('t11', async (progress, sup) => { await waitFor('t11-30pct', () => progress() >= 40, 120000); for (let i = 0; i < 3; i += 1) { await sleep(1200); await sup.restartNow(); } });
      assert.equal(x.lost, 0); await verifyTag('t11', x.result.ids);
      return { label: 'LOCAL_LAB_EVIDENCE', lost: x.lost, accounting: accounting.get('t11'), ...x.rep };
    });

    // ---------------------------------------------------------------- T12: sessions
    await scenario('T12', 'session profiles: S1 clean start vs S2 persistent session while the consumer is offline', async () => {
      await stopConsumer(main!); main = null; const rows: object[] = [];
      for (const [name, clean] of [['S1-clean-start', true], ['S2-persistent', false]] as const) {
        await discardSession('lab-consumer-1');
        const warm = await startConsumer({ clean }); await sleep(300); await stopConsumer(warm);          // establishes the session shape, then the consumer goes offline
        const tag = 't12' + name.slice(0, 2).toLowerCase(), events = mkEvents(tag, loadUsers[0]!, 20); const ids = events.map(e => e.eventId);
        await publishEvents(loadUsers[0]!, topicOf(loadUsers[0]!), events);                                // published while OFFLINE
        const back = await startConsumer({ clean }); await sleep(4000);
        const delivered = ids.filter(id => timings.get(id)?.processed !== undefined).length; await stopConsumer(back);
        rows.push({ profile: name, publishedWhileOffline: ids.length, deliveredAfterReconnect: delivered });
        if (!clean) assert.equal(delivered, ids.length, 'persistent session keeps queued QoS1');
      }
      await discardSession('lab-consumer-1'); main = await startConsumer();
      return { label: 'LOCAL_LAB_EVIDENCE', profiles: rows, note: 'S3 (consumer restart with session) is T11; S4 (broker restart) is T10' };
    });
    await scenario('T13', 'reconnect burst: 10 publishers x 5 connect/publish/close cycles + 3 consumer restarts; identity stays tied to each live connection', async () => {
      const sup0 = main!; await stopConsumer(sup0); main = null; const sup = await new Supervisor().start(); const tag = 't13'; const ids: string[] = [];
      const { out: _o, probe } = await withProbe(async () => {
        const bursts = loadUsers.slice(0, 10).map(async u => { for (let c = 0; c < 5; c += 1) { const evs = mkEvents(tag, u, 4, 0, c * 4); ids.push(...evs.map(e => e.eventId)); await publishEvents(u, topicOf(u), evs); } });
        const restarts = (async () => { for (let i = 0; i < 3; i += 1) { await sleep(1500); await sup.restartNow(); } })();
        await Promise.all([...bursts, restarts]); await waitFor('t13', () => processedAll(ids), 90000);
      });
      void _o; await verifyTag(tag, ids);
      const wrong = (await inboxRows.find({}, majority).toArray()).filter(d => { const e = (() => { try { return JSON.parse(Buffer.from((d.rawPayload as mongo.Binary).buffer.subarray(0, (d.rawPayload as mongo.Binary).length())).toString()) as { eventId?: string }; } catch { return {}; } })();
        const m = /^e11e-t13-load-(\d\d)-/.exec(e.eventId ?? ''); return m ? d.principalReference !== 'emqx-user:lab-load-' + m[1] : false; }).length;
      assert.equal(wrong, 0, 'no event was attributed to another principal'); const restarts = sup.restarts; await sup.stop(); main = await startConsumer();
      return { label: 'LOCAL_LAB_EVIDENCE', events: ids.length, consumerRestarts: restarts, wrongPrincipal: wrong, probe };
    });

    // ---------------------------------------------------------------- multiple consumers (T14, T15)
    await scenario('T14', 'two consumers with DIFFERENT clientIds, same topic (no shared subscription): every message is delivered to both', async () => {
      await stopConsumer(main!); main = null;
      const c1 = await startConsumer({ clientId: 'lab-consumer-1' }), c2 = await startConsumer({ clientId: 'lab-consumer-2' }); const tag = 't14';
      const events = mkEvents(tag, loadUsers[0]!, 60); const ids = events.map(e => e.eventId); const before = await inboxRows.countDocuments({});
      await publishEvents(loadUsers[0]!, topicOf(loadUsers[0]!), events); await waitFor(tag, () => processedAll(ids), 60000); await sleep(1500);
      const records = (await inboxRows.countDocuments({})) - before, deliveries = ids.reduce((a, id) => a + (timings.get(id)?.deliveries ?? 0), 0);
      await verifyTag(tag, ids); assert.ok(deliveries >= ids.length * 2 - 2, 'duplicated deliveries across consumer clientIds');
      await stopConsumer(c1); await stopConsumer(c2); await discardSession('lab-consumer-2'); main = await startConsumer();
      return { label: 'LOCAL_LAB_EVIDENCE', uniqueEvents: ids.length, deliveries, inboxRecords: records, measurements: await mCountTag(tag), conclusion: 'more clientIds DUPLICATE work; idempotency keeps one measurement; this is not a scaling strategy' };
    });
    await scenario('T15', 'EMQX SHARED SUBSCRIPTION ($share/lab/...): 2 consumers share the load without duplicating; one dies mid-run', async () => {
      await stopConsumer(main!); main = null; await discardSession('lab-consumer-1');
      const share = '$share/lab/agro/lab/verified';
      let c1: LabConsumer, c2: LabConsumer;
      try { c1 = await startConsumer({ clientId: 'lab-consumer-s1', subscribeTopic: share, clean: true }); c2 = await startConsumer({ clientId: 'lab-consumer-s2', subscribeTopic: share, clean: true }); }
      catch (e) { main = await startConsumer(); throw new NotVerifiable('shared subscription could not be established under the lab ACL: ' + (e instanceof Error ? e.message.slice(0, 100) : 'error')); }
      const tag = 't15', before = await inboxRows.countDocuments({});
      const users = loadUsers.slice(0, 4), all = users.map(u => ({ u, events: mkEvents(tag, u, 40) })), ids = all.flatMap(a => a.events.map(e => e.eventId));
      const kill = (async () => { await waitFor('t15-half', () => ids.filter(id => timings.get(id)?.persisted !== undefined).length >= 60, 60000); await stopConsumer(c2); })();
      await Promise.all(all.map(a => publishEvents(a.u, topicOf(a.u), a.events, { window: 8 }))); await kill;
      await waitFor(tag, () => processedAll(ids), 90000).catch(() => {}); await sleep(1500);
      const processed = ids.filter(id => timings.get(id)?.processed !== undefined).length, deliveries = ids.reduce((a, id) => a + (timings.get(id)?.deliveries ?? 0), 0);
      const lost = ids.length - processed; await noDuplicateMeasurements();
      await stopConsumer(c1); await discardSession('lab-consumer-s1'); await discardSession('lab-consumer-s2'); main = await startConsumer();
      return { label: 'LOCAL_LAB_EVIDENCE', uniqueEvents: ids.length, processed, lostWhenAMemberDied: lost, deliveries, inboxRecords: (await inboxRows.countDocuments({})) - before,
        consumer1Received: c1.adapter.stats().received, consumer2Received: c2.adapter.stats().received, semantics: 'each message goes to ONE member; with clean-start members, a dying member can lose its unacknowledged/queued messages' };
    });

    // ---------------------------------------------------------------- poison / attacker / mismatch load (T16-T18)
    await scenario('T16', 'poison messages: invalid JSON x50 (ack-and-drop) and the withhold-loop hazard', async () => {
      const a = loadUsers[0]!, before = await inboxRows.countDocuments({}); const rx0 = main!.adapter.stats().received;
      const pub = await openPub(a)!; for (let i = 0; i < 50; i += 1) await publishOnce(pub!, topicOf(a), Buffer.from('{"version":1,'), 1); await sleep(2500);
      pub!.end(true);
      const rx = main!.adapter.stats().received - rx0; assert.deepEqual([rx, (await inboxRows.countDocuments({})) - before], [50, 0]);
      await sleep(2500); assert.equal(main!.adapter.stats().received - rx0, 50, 'ack-and-drop: the broker never redelivers a poison message');
      // hazard: with the `withhold` lab policy a permanent rejection is NEVER acknowledged, so the broker redelivers it forever
      await stopConsumer(main!); main = null; const sup = await new Supervisor({ poisonPolicy: 'withhold' }).start();
      const pub2 = await openPub(a); await publishOnce(pub2!, topicOf(a), Buffer.from('{"version":1,'), 1); pub2!.end(true);
      await sleep(9000); const loopDeliveries = sup.received, restarts = sup.restarts; await sup.stop();
      await discardSession('lab-consumer-1'); main = await startConsumer();      // drains the poison message with ack-and-drop (a fresh clean-start session)
      assert.ok(loopDeliveries >= 3, 'withhold policy loops on a poison message');
      return { label: 'LOCAL_LAB_EVIDENCE', ackAndDrop: { sent: 50, received: rx, inbox: 0, redelivered: 0 }, withholdPolicy: { deliveriesOfASinglePoisonMessageIn9s: loopDeliveries, consumerRestarts: restarts },
        finding: 'POISON_LOOP_UNDER_WITHHOLD', rejectedBy: 'boundary payload parser (before verifier and inbox); broker redelivers only if the ACK is withheld' };
    });
    await scenario('T17', 'technical mismatch x100 (A connection, B key in body): rejected before the inbox, repeated', async () => {
      const before = await inboxRows.countDocuments({}), q0 = await quarantineCount(), pub = await openPub('lab-device-a'); const s0 = performance.now(); const rx0 = main!.adapter.stats().received;
      for (let i = 0; i < 100; i += 1) await publishOnce(pub!, 'agro/lab/in/a', bodyOf('lab-device-b', 'e11e-t17-' + i, i), 1);
      await waitFor('t17', () => main!.adapter.stats().received - rx0 >= 100, 60000); const dur = (performance.now() - s0) / 1000; pub!.end(true);
      assert.deepEqual([(await inboxRows.countDocuments({})) - before, (await quarantineCount()) - q0, await mCountTag('t17')], [0, 0, 0]);
      return { label: 'LOCAL_LAB_EVIDENCE', messages: 100, durationS: r1(dur), perS: r1(100 / dur), inbox: 0, quarantine: 0, measurements: 0 };
    });
    await scenario('T18', 'authenticated-but-UNMAPPED principal x200 (attacker): 0 inbox, 0 quarantine, 0 measurements, overhead measured', async () => {
      const before = await inboxRows.countDocuments({}), q0 = await quarantineCount(), pub = await openPub('lab-attacker', 'lab-device-a'); const rx0 = main!.adapter.stats().received;
      const { probe } = await withProbe(async () => { for (let i = 0; i < 200; i += 1) await publishOnce(pub!, 'agro/lab/in/a', bodyOf('lab-device-a', 'e11e-t18-' + i, i), 1); await waitFor('t18', () => main!.adapter.stats().received - rx0 >= 200, 60000); });
      pub!.end(true);
      assert.deepEqual([(await inboxRows.countDocuments({})) - before, (await quarantineCount()) - q0, await mCountTag('t18')], [0, 0, 0]);
      return { label: 'LOCAL_LAB_EVIDENCE', messages: 200, inbox: 0, quarantine: 0, measurements: 0, probe };
    });
    await scenario('T18b', 'invalid-credential load: 40 refused attempts never reach the adapter', async () => {
      const rx0 = main!.adapter.stats().received; let refused = 0;
      for (let i = 0; i < 40; i += 1) { const p = await openPub('lab-device-a', 'lab-device-a', 'labpw-' + String(i).padStart(32, '0')); if (p === null) refused += 1; else p.end(true); }
      assert.equal(refused, 40); await sleep(500); assert.equal(main!.adapter.stats().received, rx0);
      return { label: 'LOCAL_LAB_EVIDENCE', attempts: 40, refusedByBroker: refused };
    });

    // ---------------------------------------------------------------- recovery batches (T19, T20)
    await scenario('T19', 'receipted recovery BATCH: consumer process frozen after ACK and killed; recovery of K records by 3 parallel executors', async () => {
      const K = profile === 'quick' ? 8 : 30; await stopConsumer(main!); main = null; await discardSession('lab-consumer-batch');
      await discardSession('lab-consumer-1');           // an offline persistent session would ALSO queue these messages (fan-out across clientIds, finding F-D7) and process them itself
      const child = spawn(process.execPath, ['dist/scripts/be13-11d/lab-consumer-process.js'], { env: { ...process.env, LAB_CRASH: 'freeze-processing', LAB_BROKER_URL: L.brokerUrl, LAB_CONSUMER_PASSWORD: L.secrets['lab-consumer'], LAB_CLIENT_ID: 'lab-consumer-batch' }, stdio: ['ignore', 'pipe', 'pipe'] });
      children.add(child); let out = ''; child.stdout!.on('data', d => { out += L.scrub(String(d)); }); await waitFor('child-ready', () => out.includes('LAB_CONSUMER_READY'), 30000);
      const tag = 't19', events = mkEvents(tag, 'lab-device-a', K); const ids = events.map(e => e.eventId);
      await publishEvents('lab-device-a', 'agro/lab/in/a', events, { window: 4 });
      await waitFor('receipted', async () => (await stateRows.countDocuments({ status: 'receipted' }, majority)) >= K, 60000);
      child.kill('SIGKILL'); children.delete(child); await sleep(800); await discardSession('lab-consumer-batch');
      assert.equal(await mCountTag(tag), 0, 'no measurement was created by the dead process');
      main = await startConsumer(); await sleep(2000);                                          // ages the receipted records past the TEST_ONLY policy
      const t1 = performance.now();
      const sweeps = await Promise.all([1, 2, 3].map(() => main!.reconciler.reconcileBrokerInbox({ mode: 'reconcile', limit: 100 }))) as unknown as { results: { result: string }[] }[];
      const dur = (performance.now() - t1) / 1000, tally: Record<string, number> = {};
      for (const s of sweeps) for (const r of s.results) tally[r.result] = (tally[r.result] ?? 0) + 1;
      assert.equal(tally['recovered-and-processed'], K, 'each record recovered exactly once across 3 executors (claim/CAS): ' + JSON.stringify(tally));
      assert.equal(await mCountTag(tag), K); await noDuplicateMeasurements();
      const states = await stateRows.find({ status: 'completed', outcome: 'recovered-and-processed' }, majority).toArray(); assert.ok(states.every(s => s.version === 3));
      return { label: 'LOCAL_LAB_EVIDENCE', records: K, recoveryDurationS: r1(dur), recoveredPerS: r1(K / dur), executors: 3, resultTally: tally, measurements: await mCountTag(tag) };
    });
    await scenario('T20', 'orphan reconciliation BATCH (real ambiguous writes via paused secondaries), 3 parallel reconcilers', async () => {
      const K = profile === 'quick' ? 6 : 20; const tag = 't20'; await waitHealthy();
      const p = await primaryIndex(), sec = [0, 1, 2].filter(i => i !== p), ids = Array.from({ length: K }, (_, i) => `e11e-${tag}-${i}`);
      const mkDelivery = (id: string, i: number) => ({ brokerObserved: { connectionReference: 'lab:orphan', authenticatedPrincipalReference: 'emqx-user:lab-device-a', mqttClientId: 'lab-device-a', topic: 'agro/lab/in/a', qos: 1, retain: false, packetId: null, receivedAt: Date.now() }, payload: bodyOf('lab-device-a', id, i) });
      for (const s of sec) chaos(request, 'pause', s);
      try { const outs = await Promise.all(ids.map((id, i) => main!.admission.admit(mkDelivery(id, i), { mode: 'persist-and-process' }))); assert.ok(outs.every(o => o.status === 'rejected')); } finally { for (const s of sec) chaos(request, 'unpause', s); }
      await waitHealthy(); await waitFor('orphans-appear', async () => (await inboxRows.countDocuments({ rawPayloadSha256: { $exists: true }, receivedAt: { $exists: true }, connectionReference: 'lab:orphan' }, majority)) >= K, 30000); await sleep(2000);
      const t1 = performance.now();
      const sweeps = await Promise.all([1, 2, 3].map(() => main!.reconciler.reconcileBrokerInbox({ mode: 'reconcile', limit: 100 }))) as unknown as { results: { result: string }[] }[];
      const dur = (performance.now() - t1) / 1000, tally: Record<string, number> = {};
      for (const s of sweeps) for (const r of s.results) tally[r.result] = (tally[r.result] ?? 0) + 1;
      assert.equal(await mCountTag(tag), K); await noDuplicateMeasurements();
      assert.ok((tally['recovered-and-processed'] ?? 0) + (tally['already-processed'] ?? 0) >= K && (tally['recovered-and-processed'] ?? 0) <= K, 'unique claims');
      return { label: 'LOCAL_LAB_EVIDENCE', orphans: K, reconcileDurationS: r1(dur), perS: r1(K / dur), executors: 3, resultTally: tally, measurements: await mCountTag(tag) };
    });

    // ---------------------------------------------------------------- audit, payload size, ordering
    await scenario('T21', 'audit contention: concurrent audit appends to the SAME realm stream + audit latency observed under load', async () => {
      const audit = createMongoIngestionAuditStore({ connection: conns[5]!, prefix: INGEST, realm: 'test' }), rows: object[] = [];
      for (const conc of [1, 5, 10, 20]) {
        const total = 100; let errors = 0; const lat: number[] = []; let next = 0; const s0 = performance.now();
        await Promise.all(Array.from({ length: conc }, async () => { for (;;) { const i = next++; if (i >= total) return; const t = performance.now();
          try { await audit.append({ realm: 'test', quarantineId: null, eventId: null, action: 'inbox-persisted', actorId: 'bench', actorCapabilities: [], outcome: 'persisted', reasonCode: 'persisted', evidence: null } as never); } catch { errors += 1; } lat.push(performance.now() - t); } }));
        rows.push({ concurrency: conc, appendsPerS: r1(total / ((performance.now() - s0) / 1000)), latencyMs: dist(lat), errors });
      }
      return { label: 'LOCAL_LAB_EVIDENCE', microbenchmark: rows, auditLatencyDuringTheRun: dist(auditTimings), note: 'every append to one realm stream increments one sequence: measured, not redesigned' };
    });
    await scenario('T22', 'near-limit payload (~3.9 KB of a 4 KB TEST_ONLY limit) vs small payload', async () => {
      const small = await load('t22s', 2, 100), big = await load('t22b', 2, 100, { pad: 15 });
      await verifyTag('t22s', small.ids); await verifyTag('t22b', big.ids);
      const doc = await inboxRows.aggregate([{ $match: { rawPayloadBytes: { $gt: 3000 } } }, { $limit: 1 }, { $project: { b: '$rawPayloadBytes', s: { $bsonSize: '$$ROOT' } } }]).toArray();
      return { label: 'LOCAL_LAB_EVIDENCE', small: report(small.ids, small.started, small.ended), nearLimit: report(big.ids, big.started, big.ended), nearLimitRawBytes: doc[0]?.b, nearLimitInboxDocBytes: doc[0]?.s };
    });
    await scenario('T23', 'ordering, SAME source: sequential events from one publisher through one consumer', async () => {
      const u = loadUsers[0]!, evs = mkEvents('t23', u, 80); const ids = evs.map(e => e.eventId);
      await publishEvents(u, topicOf(u), evs, { sequential: true }); await waitFor('t23', () => processedAll(ids), 60000);
      const persisted = ids.map(id => timings.get(id)!.persisted!), processed = ids.map(id => timings.get(id)!.processed!);
      const inv = (a: number[]) => a.reduce((n, x, i) => n + (i > 0 && x < a[i - 1]! ? 1 : 0), 0);
      return { label: 'LOCAL_LAB_EVIDENCE', events: ids.length, persistOrderViolations: inv(persisted), measurementOrderViolations: inv(processed), note: 'persist order follows publish order; post-ACK processing is asynchronous and is NOT guaranteed to preserve it' };
    });
    await scenario('T24', 'ordering, MULTIPLE sources interleaved (5 publishers)', async () => {
      const users = loadUsers.slice(0, 5), all = users.map(u => ({ u, events: mkEvents('t24', u, 40) })), ids = all.flatMap(a => a.events.map(e => e.eventId));
      await Promise.all(all.map(a => publishEvents(a.u, topicOf(a.u), a.events, { sequential: true }))); await waitFor('t24', () => processedAll(ids), 60000);
      const perSource = (stageName: 'persisted' | 'processed') => all.reduce((n, a) => { const t = a.events.map(e => timings.get(e.eventId)![stageName]!); return n + t.reduce((m, x, i) => m + (i > 0 && x < t[i - 1]! ? 1 : 0), 0); }, 0);
      const global = ids.map(id => timings.get(id)!.persisted!).reduce((n, x, i, a) => n + (i > 0 && x < a[i - 1]! ? 1 : 0), 0);
      return { label: 'LOCAL_LAB_EVIDENCE', perSourcePersistOrderViolations: perSource('persisted'), perSourceProcessOrderViolations: perSource('processed'), globalPersistOrderViolationsVsPublisherConcatenation: global, note: 'no global ordering exists or is promised' };
    });

    // ---------------------------------------------------------------- dataset: explain at scale + storage rate
    await scenario('T26', 'inbox dataset at scale: explain, scan cost and storage rate (synthetic rows, dropped at cleanup)', async () => {
      const N = 30000, hex = (n: number) => n.toString(16).padStart(64, '0'), batch: object[] = []; const base = Date.now() - 3600_000;
      for (let i = 0; i < N; i += 1) {
        batch.push({ _id: 'ib_' + (0x7e000000 + i).toString(16).padStart(32, '0'), realm: 'test', sourceId: 'lab-source-a', principalReference: 'emqx-user:lab-device-a', technicalDeviceKey: 'lab-device-a', connectionReference: 'lab:dataset', mqttClientId: 'lab-device-a',
          topic: 'agro/lab/in/a', qos: new mongo.Int32(1), retain: false, packetId: null, receivedAt: new Date(base + i), verifiedAt: new Date(base + i), rawPersistedAt: new Date(base + i + 1), verifierRevision: 1, mappingRevision: 1,
          contextFingerprint: hex(i), rawPayloadSha256: hex(i + 1), provenanceFingerprint: hex(i + 2), rawPayload: new mongo.Binary(Buffer.alloc(600, 7)), rawPayloadBytes: 600 });
      }
      for (let i = 0; i < batch.length; i += 1000) await inboxRows.insertMany(batch.slice(i, i + 1000) as never, { ordered: false });
      const states = Array.from({ length: 10000 }, (_, i) => ({ _id: 'ib_' + (0x7e000000 + i).toString(16).padStart(32, '0'), realm: 'test', status: 'receipted', version: new mongo.Int32(1), receiptedAt: new Date(base + i) }));
      for (let i = 0; i < states.length; i += 1000) await stateRows.insertMany(states.slice(i, i + 1000) as never, { ordered: false });
      const store = createMongoBrokerInboxReconciliationStore({ connection: conns[5]!, prefix: INGEST, realm: 'test' });
      const time = async <T>(fn: () => Promise<T>) => { const t = performance.now(); const v = await fn(); return { v, ms: r1(performance.now() - t) }; };
      const cand = await time(() => store.listCandidates({ realm: 'test', minAgeMs: 1500, limit: 100 })), rec = await time(() => store.listReceiptedCandidates({ realm: 'test', minAgeMs: 1500, limit: 100 })), cnt = await time(() => store.count({ realm: 'test', limit: 500 }));
      const plan = (p: unknown) => { const s = JSON.stringify(p); return { usesInboxRealmPersisted: s.includes('inbox_realm_persisted'), usesReceiptedIndex: s.includes('state_realm_status_receipted'), collscan: /COLLSCAN/.test(s) }; };
      const explainRaw = await inboxRows.aggregate([{ $match: { realm: 'test', $expr: { $lte: ['$rawPersistedAt', { $subtract: ['$$NOW', 1500] }] } } }, { $sort: { rawPersistedAt: 1 } }, { $limit: 100 }]).explain('executionStats') as { stages?: { $cursor?: { executionStats?: { totalDocsExamined?: number; nReturned?: number } } }[]; executionStats?: { totalDocsExamined?: number } };
      const explainState = await stateRows.find({ realm: 'test', status: 'receipted', receiptedAt: { $lte: new Date() } }).limit(100).explain('executionStats') as { executionStats?: { totalDocsExamined?: number; nReturned?: number } };
      const sizes = await inboxRows.aggregate([{ $group: { _id: null, avgDoc: { $avg: { $bsonSize: '$$ROOT' } }, n: { $sum: 1 } } }]).toArray();
      const avg = Math.round(sizes[0]!.avgDoc as number);
      return { label: 'LOCAL_LAB_EVIDENCE', rows: { inbox: N, receiptedStates: states.length }, listCandidatesMs: cand.ms, listReceiptedMs: rec.ms, countMs: cnt.ms, candidatesReturned: cand.v.length,
        rawScan: { ...plan(explainRaw), docsExamined: explainRaw.stages?.[0]?.$cursor?.executionStats?.totalDocsExamined ?? explainRaw.executionStats?.totalDocsExamined }, receiptedScan: { ...plan(explainState), docsExamined: explainState.executionStats?.totalDocsExamined, returned: explainState.executionStats?.nReturned },
        storage: { avgInboxDocBytes: avg, illustration: `${avg} B/event x 100 ev/s x 86400 s = ${r1(avg * 100 * 86400 / 1048576)} MB/day (ILLUSTRATION, not sizing; excludes indexes, journal and audit)` } };
    });
    await scenario('T27', 'resource summary: memory samples over the whole run (no leak claim from RSS alone)', async () => {
      const rss = mem.map(m => m.rss / 1048576), heap = mem.map(m => m.heap / 1048576);
      return { label: 'LOCAL_LAB_EVIDENCE', samples: mem.length, rssMB: { min: r1(Math.min(...rss)), max: r1(Math.max(...rss)), last: r1(rss[rss.length - 1]!) }, heapUsedMB: { min: r1(Math.min(...heap)), max: r1(Math.max(...heap)), last: r1(heap[heap.length - 1]!) },
        eventLoopDelayMs: { p50: r1(eld.percentile(50) / 1e6), p99: r1(eld.percentile(99) / 1e6), max: r1(eld.max / 1e6) }, note: 'RSS growth is not a leak by itself; processed-event maps and logs grow by design in this lab harness' };
    });

    stage = 'cleanup';
    clearInterval(memTimer); eld.disable();
    for (const c of [...live]) await stopConsumer(c);
    for (const ch of children) ch.kill('SIGKILL');
    L.stop(); lab = null;
    await scenario('T25', 'cleanup: EMQX removed, no child processes, no lab containers; Mongo cleanup confirmed by the launcher', async () => {
      assert.deepEqual(labContainersRemaining(), []); assert.equal(children.size, 0); return { labContainersLeft: 0 };
    });
    stage = 'evidence';
    const dir = join(process.cwd(), '.local-evidence'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'be13-11e-bench.json'), JSON.stringify({ label: 'LOCAL_LAB_EVIDENCE', profile, gitSha: sha, mongoVersion: build.version, emqxImage: EMQX_IMAGE, mqttJs: '5.16.1', node: process.version,
      machine: { platform: os.platform(), cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, totalMemGB: r1(os.totalmem() / 1073741824) }, run: request.runId, elapsedS: r1((Date.now() - t0) / 1000), results }, null, 2));
  } finally {
    clearInterval(memTimer);
    for (const c of live) await c.stop().catch(() => {});
    for (const ch of children) ch.kill('SIGKILL');
    if (lab) lab.stop();
    const first = conns[0];
    if (first?.readyState === 1) { try { verifyOwnedMultiNode(request); await first.db!.dropDatabase(); } catch { /* launcher confirms cleanup */ } }
    for (const c of conns) await c.close().catch(() => {});
    console.log(JSON.stringify({ event: 'be13-11e-summary', profile, pass: results.filter(r => r.status === 'PASS').length, fail: results.filter(r => r.status === 'FAIL').length,
      noVerificable: results.filter(r => r.status === 'NO_VERIFICABLE').length, labContainersLeft: labContainersRemaining().length }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  console.error('BE1311E_LOCAL_FAILED ' + JSON.stringify({ stage, errorClass: error instanceof Error ? error.name : 'Unknown', message: error instanceof Error ? error.message.slice(0, 200).replace(/labpw-[0-9a-f]+/g, '***') : undefined }));
  process.exitCode = 1;
});
