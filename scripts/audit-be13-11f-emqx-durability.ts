// BE13-11F — EMQX local broker/session DURABILITY campaign (LOCAL_TEST_ONLY). Question: can a QoS 1 message that EMQX already CONFIRMED
// (PUBACK) to the publisher survive a broker restart / crash before it reaches the consumer? Everything is measured with an exact
// accounting oracle (publisher PUBACK set vs events the consumer eventually received). Four broker profiles are used:
//   NON-DURABLE     durable_sessions disabled (the BE13-11E situation)
//   DURABLE-TUNED   durable_sessions enabled, write buffer flush_interval=1 ms, max_items=1
//   DURABLE-DEFAULT durable_sessions enabled, EMQX defaults (flush_interval=100 ms)
//   DURABLE-WIDE    durable_sessions enabled, flush_interval=3 s  (negative control that widens the post-PUBACK window)
// No Atlas, no external broker, no hardware, no production; credentials are generated per run.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { type Connection } from 'mongoose';
import { chaos, validateMultiNodeRequest, verifyOwnedMultiNode } from './be13-07/guard.js';
import { connectMultiNode } from './be13-07/connect.js';
import { provisionSensorCollections, sensorCollections } from '../src/models/sensor.models.js';
import { ingestionCollections, provisionIngestionCollections } from '../src/models/ingestion-persistence.models.js';
import { provisionQuarantineCollection, quarantineCollection } from '../src/models/ingestion-quarantine.models.js';
import { provisionAuditCollections } from '../src/models/ingestion-audit.models.js';
import { brokerInboxCollection, provisionBrokerInboxCollection } from '../src/models/broker-inbox.models.js';
import { brokerInboxStateCollection, provisionBrokerInboxStateCollection } from '../src/models/broker-inbox-state.models.js';
import { loadMqttJsFactory } from '../src/adapters/emqx-mqtt-connect.js';
import { LAB_VERIFIED_TOPIC } from '../src/adapters/emqx-mqtt-broker.adapter.js';
import { EMQX_IMAGE, labContainersRemaining, labVolumesRemaining, startEmqxLab, type EmqxLab, type EmqxLabOptions } from './be13-11d/emqx-lab.js';
import { INGEST, BUSINESS, SENSOR, startLabConsumer, type LabConsumer, type MetricSink } from './be13-11d/lab-consumer.js';

// KNOWN_LIMITATION = a durability requirement the broker DEMONSTRABLY does not meet (documented, reproducible, expected here). A PUBACKed message that is
// not recovered in any OTHER scenario is a plain FAIL: it is never relabelled.
type Status = 'PASS' | 'FAIL' | 'NO_VERIFICABLE' | 'KNOWN_LIMITATION';
const EXPECTED_LIMITATION = new Set(['D04', 'D09d']);
const gaps: { id: string; lostAfterPuback: number; acked: number }[] = [];
const results: { id: string; name: string; status: Status; evidence?: unknown; note?: string }[] = [];
class NotVerifiable extends Error {}
let stage = 'bootstrap';
// BE13_11F_ONLY=D04,D05 runs just those scenarios (development aid).
const only = process.env.BE13_11F_ONLY ? new Set(process.env.BE13_11F_ONLY.split(',')) : null;
async function scenario(id: string, name: string, work: () => Promise<unknown>) {
  if (only && !only.has(id)) return;
  stage = id; const gapsBefore = gaps.length;
  try {
    const evidence = await Promise.race([work(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('SCENARIO_TIMEOUT_5MIN')), 300000))]);
    const grew = gaps.length > gapsBefore, status: Status = !grew ? 'PASS' : EXPECTED_LIMITATION.has(id) ? 'KNOWN_LIMITATION' : 'FAIL';
    results.push({ id, name, status, evidence }); console.log(status + ' ' + id + ' ' + name + (evidence ? ' ' + JSON.stringify(evidence).slice(0, 420) : ''));
    return;                                            // an unexpected gap is reported as FAIL but does not abort the rest of the campaign
  }
  catch (error) {
    if (error instanceof NotVerifiable) { results.push({ id, name, status: 'NO_VERIFICABLE', note: error.message }); console.log('NO_VERIFICABLE ' + id + ' ' + name + ' :: ' + error.message); return; }
    const msg = error instanceof Error ? error.message.slice(0, 400) : 'error';
    results.push({ id, name, status: 'FAIL', note: msg }); console.log('FAIL ' + id + ' ' + name + ' :: ' + msg); throw error;
  }
}
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function waitFor(what: string, cond: () => boolean | Promise<boolean>, ms = 30000) { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return; await sleep(100); } throw new Error('TIMEOUT_' + what); }
const r1 = (n: number) => Math.round(n * 10) / 10;
const pct = (v: number[], p: number) => { const s = [...v].sort((a, b) => a - b); return s.length ? r1(s[Math.min(s.length - 1, Math.floor(p * s.length))]!) : NaN; };

// ---------------------------------------------------------------- the accounting oracle
// lostAfterPuback = events the broker CONFIRMED to the publisher (PUBACK) that the consumer never received after recovery.
// An event that was merely SENT but never acknowledged is NOT a broker loss: the publisher still owns it and must retry.
export function account(sent: readonly string[], acked: ReadonlySet<string>, received: ReadonlyMap<string, number>) {
  const ackedIds = [...acked], sentSet = new Set(sent);
  const lost = ackedIds.filter(id => !received.has(id));
  const duplicates = [...received.values()].reduce((n, c) => n + Math.max(0, c - 1), 0);
  return { sent: sent.length, acked: acked.size, receivedUnique: received.size, lostAfterPuback: lost.length, lostSample: lost.slice(0, 3), duplicates, unackedButReceived: [...received.keys()].filter(id => sentSet.has(id) && !acked.has(id)).length,
    // STALE_REDELIVERY: events of a PREVIOUS cycle (already consumed and ACKed) delivered again. Not a loss: downstream idempotency absorbs it.
    staleRedelivery: [...received.keys()].filter(id => !sentSet.has(id)).length, staleSample: [...received.keys()].filter(id => !sentSet.has(id)).slice(0, 3) };
}

// A durability gap = a message the broker CONFIRMED (PUBACK) that was not recovered. Survival scenarios record gaps instead of aborting, so the
// campaign can state exactly where the broker keeps its promise and where it does not.
function noLoss(acc: { lostAfterPuback: number; acked: number }) { if (acc.lostAfterPuback > 0) gaps.push({ id: stage, lostAfterPuback: acc.lostAfterPuback, acked: acc.acked }); }

type MqttClient = { on(e: string, l: (...a: any[]) => void): void; publish(t: string, p: Buffer, o: object, cb: (e: Error | null) => void): void; subscribe(t: string, o: object, cb: (e: Error | null, g?: { qos: number }[]) => void): void; end(force?: boolean, o?: object, cb?: () => void): void }; // eslint-disable-line @typescript-eslint/no-explicit-any
// The broker's HTTP API can answer before its MQTT listener is back after a restart: a refused CONNECT is retried (bounded), any other error is not.
async function startConsumerRetrying(o: Parameters<typeof startLabConsumer>[0]): Promise<LabConsumer> {
  let last: unknown;
  for (let i = 0; i < 12; i += 1) { try { return await startLabConsumer(o); } catch (e) { last = e; if (!/ECONNREFUSED|CLOSED_BEFORE_READY|ETIMEDOUT/.test(String((e as Error).message))) throw e; await new Promise(r => setTimeout(r, 1500)); } }
  throw last;
}
const consumerId = () => 'lab-consumer-durable';                    // a STABLE client id: a durable session can only be reclaimed with the same id

async function main() {
  stage = 'guard';
  const request = validateMultiNodeRequest(process.env); verifyOwnedMultiNode(request);
  if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) throw Error('MN_GIT_TREE_NOT_CLEAN');
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const fx = await import(pathToFileURL(join(process.cwd(), 'test-support', 'be13-11a-broker.fixtures.js')).href) as { envelope(patch?: object): Record<string, unknown>; bytesOf(v: unknown): Buffer };
  const mqttFactory = await loadMqttJsFactory();
  const conns: Connection[] = []; let lab: EmqxLab | null = null; const live = new Set<LabConsumer>(); const rawClients = new Set<MqttClient>();
  const metrics: MetricSink = [], t0 = Date.now(), perf: Record<string, { acksPerS: number; p50: number; p95: number; p99: number }> = {}, storage: Record<string, number | null> = {};
  try {
    stage = 'connect';
    for (let i = 0; i < 5; i += 1) conns.push(await connectMultiNode(request));
    const connection = conns[0]!, db = connection.db!;
    if ((await db.listCollections().toArray()).length !== 0) throw Error('MN_DATABASE_NOT_EMPTY');
    const build = await db.command({ buildInfo: 1 });
    const status = async () => (await db.admin().command({ replSetGetStatus: 1 }, { readPreference: 'nearest' })) as { members: { name: string; stateStr: string; health: number }[] };
    const waitHealthy = async () => { for (let i = 0; i < 240; i += 1) { try { const s = await status(); if (s.members.filter(m => m.health === 1).length === 3 && s.members.filter(m => m.stateStr === 'PRIMARY').length === 1 && s.members.filter(m => m.stateStr === 'SECONDARY').length === 2) return; } catch { /* election */ } await sleep(500); } throw Error('MN_WAIT_TIMEOUT_healthy'); };
    const primaryIndex = async () => { const p = (await status()).members.find(m => m.stateStr === 'PRIMARY'); return p ? request.ports.indexOf(Number(p.name.split(':')[1])) : -1; };
    await provisionSensorCollections(connection, SENSOR, BUSINESS); await provisionIngestionCollections(connection, INGEST); await provisionQuarantineCollection(connection, INGEST);
    await provisionAuditCollections(connection, INGEST); await provisionBrokerInboxCollection(connection, INGEST); await provisionBrokerInboxStateCollection(connection, INGEST);
    const sn = sensorCollections(SENSOR, BUSINESS), inn = ingestionCollections(INGEST), day = (ms: number) => new Date(ms);
    await db.collection(sn.devices).insertOne({ _id: 'test:device-A', realm: 'test', id: 'device-A', clientId: 'owner-A', sourceId: 'lab-source-a', keyKind: 'mqtt-clientid', keyValue: 'lab-device-a', verification: 'verified', verificationAuthority: 'synthetic', lifecycle: 'active', version: 3, createdAt: day(1), updatedAt: day(2) } as never, { writeConcern: { w: 'majority' } });
    await db.collection(sn.associations).insertOne({ _id: 'test:assoc-A', realm: 'test', id: 'assoc-A', revision: 1, clientId: 'client-A', sensorId: 'sensor-A', fieldId: 'field-A', areaId: 'area-A', validFrom: day(0), validTo: null, auditReason: 'synthetic', physicalDeviceId: 'device-A', sourceId: 'lab-source-a', keyKind: 'mqtt-clientid', keyValue: 'lab-device-a', state: 'active' } as never, { writeConcern: { w: 'majority' } });
    const measurements = db.collection(inn.measurements), inboxRows = db.collection(brokerInboxCollection(INGEST)), stateRows = db.collection(brokerInboxStateCollection(INGEST)), quarantineRows = db.collection(quarantineCollection(INGEST));
    const majority = { readConcern: { level: 'majority' } } as never;
    const mCountTag = (tag: string) => measurements.countDocuments({ eventId: { $regex: '^e11f-' + tag + '-' } }, majority);

    // ---------------------------------------------------------------- helpers over the CURRENT lab
    const L = () => lab!;
    const pubOpen = async (user = 'lab-device-a', clientId = user, password?: string): Promise<MqttClient | null> => {
      const c = mqttFactory(L().brokerUrl, { protocolVersion: 5, clientId, username: user, password: password ?? L().secrets[user], clean: true, reconnectPeriod: 0 }) as unknown as MqttClient;
      let closed = false; c.on('close', () => { closed = true; }); (c as MqttClient & { isClosed: () => boolean }).isClosed = () => closed;
      const ok = await new Promise<boolean>(res => { c.on('connect', () => res(true)); c.on('error', () => res(false)); setTimeout(() => res(false), 8000); });
      if (!ok) { c.end(true); return null; } rawClients.add(c); return c;
    };
    const eventBody = (id: string, seq: number) => fx.bytesOf(fx.envelope({ eventId: id, clientid: 'lab-device-a', payload: { temperature: seq } }));
    // Publishes ids from ONE connection; the oracle only credits an id when its PUBACK callback fired without error.
    async function publish(ids: string[], o: { window?: number; payloadOf?: (id: string, seq: number) => Buffer; topic?: string; user?: string; stopAfterAcks?: number; onFirstAcks?: { count: number; run: () => void } } = {}) {
      const acked = new Set<string>(), lat: number[] = []; let client = await pubOpen(o.user ?? 'lab-device-a'); let next = 0, failed = 0, fired = false;
      const t = performance.now();
      const worker = async () => { for (;;) {
        const i = next++; if (i >= ids.length) return; const id = ids[i]!;
        if (!client || (client as MqttClient & { isClosed: () => boolean }).isClosed()) { failed += 1; return; }
        const s = performance.now();
        // A PUBACK that never arrives (broker died mid-batch) must not hang the campaign: after 8 s the publish counts as NOT acknowledged.
        try { await new Promise<void>((res, rej) => { const t = setTimeout(() => rej(new Error('PUBACK_TIMEOUT')), 8000); client!.publish(o.topic ?? 'agro/lab/in/a', (o.payloadOf ?? eventBody)(id, i), { qos: 1 }, e => { clearTimeout(t); if (e) rej(e); else res(); }); });
          acked.add(id); lat.push(performance.now() - s);
          if (o.onFirstAcks && !fired && acked.size >= o.onFirstAcks.count) { fired = true; o.onFirstAcks.run(); } }
        catch { failed += 1; return; }                       // a failed publish is NOT acknowledged: the publisher still owns it
      } };
      await Promise.all(Array.from({ length: o.window ?? 8 }, worker));
      const durationMs = performance.now() - t;
      await new Promise<void>(res => { if (!client) return res(); client.end(false, {}, () => res()); setTimeout(res, 1500); });
      return { acked, lat, durationMs, failed };
    }
    // A raw (no pipeline) consumer: records every delivery, decoded from the broker-authored envelope. `hold` never ACKs (deliveries pile up in-flight).
    type Rx = { received: Map<string, number>; order: string[]; bytes: Map<string, Buffer>; client: MqttClient; sessionPresent: boolean; latencyMs(): { firstMs: number | null; lastMs: number | null }; close(graceful?: boolean): Promise<void> };
    async function consumerOpen(o: { clientId?: string; clean?: boolean; expiry?: number; hold?: boolean } = {}): Promise<Rx> {
      const received = new Map<string, number>(), order: string[] = [], bytes = new Map<string, Buffer>(); let connectedAt = 0, firstAt = 0, lastAt = 0;
      const record = (msg: Buffer) => { const now = performance.now(); if (firstAt === 0) firstAt = now; lastAt = now; try { const env = JSON.parse(msg.toString('utf8')) as { payload_b64: string }; const raw = Buffer.from(env.payload_b64, 'base64'); let id = '';
        try { id = String((JSON.parse(raw.toString('utf8')) as { eventId?: string }).eventId ?? ''); } catch { id = 'raw:' + raw.toString('hex'); }
        received.set(id, (received.get(id) ?? 0) + 1); if (received.get(id) === 1) { order.push(id); bytes.set(id, raw); } } catch { /* not an envelope */ } };
      const c = mqttFactory(L().brokerUrl, { protocolVersion: 5, clientId: o.clientId ?? consumerId(), username: 'lab-consumer', password: L().secrets['lab-consumer'], clean: o.clean ?? false, reconnectPeriod: 0,
        properties: { sessionExpiryInterval: o.expiry ?? 3600 },
        customHandleAcks: (_t: string, msg: Buffer, _p: unknown, cb: (e: Error | null, code?: number) => void) => { record(msg); if (!o.hold) cb(null, 0); } }) as unknown as MqttClient;
      rawClients.add(c);
      const sessionPresent = await new Promise<boolean>((res, rej) => { c.on('connect', (p: { sessionPresent: boolean }) => { connectedAt = performance.now(); res(p.sessionPresent); }); c.on('error', rej); setTimeout(() => rej(new Error('consumer connect timeout')), 15000); });
      await new Promise<void>((res, rej) => c.subscribe(LAB_VERIFIED_TOPIC, { qos: 1 }, e => e ? rej(e) : res()));
      return { received, order, bytes, client: c, sessionPresent, latencyMs: () => ({ firstMs: firstAt ? r1(firstAt - connectedAt) : null, lastMs: lastAt ? r1(lastAt - connectedAt) : null }), close: async (graceful = true) => { await new Promise<void>(res => { c.end(!graceful, {}, () => res()); setTimeout(res, 1500); }); rawClients.delete(c); } };
    }
    const settle = async (rx: Rx, expect: number, quietMs = 3500, maxMs = 30000) => { const end = Date.now() + maxMs; let last = -1, since = Date.now(); while (Date.now() < end) { if (rx.received.size >= expect) break; if (rx.received.size !== last) { last = rx.received.size; since = Date.now(); } else if (Date.now() - since > quietMs) break; await sleep(150); } };
    // wait until the measurement count reaches `target` OR stops growing for 20 s (a durability gap means it may never reach it)
    const settleCount = async (tag: string, target: number) => { let last = -1, since = Date.now(); const end = Date.now() + 150000; while (Date.now() < end) { const m = await mCountTag(tag); if (m >= target) return; if (m !== last) { last = m; since = Date.now(); } else if (Date.now() - since > 20000) return; await sleep(500); } };
    const ids = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `e11f-${tag}-${i}`);
    const withLab = async <T>(options: EmqxLabOptions, fn: () => Promise<T>) => { lab = await startEmqxLab(request.basePort, request.runId, [], options); try { return await fn(); } finally { for (const c of [...rawClients]) { try { c.end(true); } catch { /* */ } } rawClients.clear(); for (const c of [...live]) { await c.stop().catch(() => {}); live.delete(c); } lab.stop(); lab = null; } };
    const disrupt = async (how: 'restart' | 'stopStart' | 'kill' | 'recreateSame' | 'recreateNew') => { const l = L(); if (how === 'restart') return l.restart(); if (how === 'stopStart') return l.stopStart(); if (how === 'kill') return l.kill(); return l.recreate({ keepVolume: how === 'recreateSame' }); };
    // THE canonical F-E2 flow: a persistent consumer session goes offline; the publisher gets PUBACKs; the broker is disrupted; the SAME consumer returns.
    async function offlineQueue(tag: string, n: number, how: Parameters<typeof disrupt>[0], opts: { reconnect?: Parameters<typeof consumerOpen>[0]; payloadOf?: (id: string, seq: number) => Buffer; immediate?: boolean } = {}) {
      const first = await consumerOpen(); await first.close(true); await sleep(400);               // creates the session (subscription), then goes offline
      const sent = ids(tag, n), p = await publish(sent, { window: 8, ...(opts.payloadOf ? { payloadOf: opts.payloadOf } : {}) });
      if (!opts.immediate) await sleep(400);                                                         // (kept short: the write-buffer window is what the WIDE profile measures)
      await disrupt(how); await sleep(1500);
      const rx = await consumerOpen(opts.reconnect ?? {}); await settle(rx, p.acked.size); const acc = account(sent, p.acked, rx.received);
      const out = { how, ...acc, sessionPresent: rx.sessionPresent, recoveryLatencyAfterReconnectMs: rx.latencyMs(), pubAckMs: { p50: pct(p.lat, .5), p95: pct(p.lat, .95) } }; await rx.close(false);
      return { out, rx, p, sent };
    }
    const perfProbe = async (label: string) => { const l = await publish(ids('perf' + label.replace(/\W/g, ''), 400), { window: 16 }); perf[label] = { acksPerS: r1(l.acked.size / (l.durationMs / 1000)), p50: pct(l.lat, .5), p95: pct(l.lat, .95), p99: pct(l.lat, .99) }; return perf[label]; };

    // ================================================================ GROUP 1: NON-DURABLE (the BE13-11E situation)
    await withLab({}, async () => {
      await scenario('D01', 'F-E2 reproduced (non-durable broker): PUBACKed messages queued for an OFFLINE persistent session are lost by a restart', async () => {
        const { out } = await offlineQueue('d01a', 200, 'restart');
        assert.ok(out.acked > 0 && out.lostAfterPuback === out.acked, 'every PUBACKed message was lost: ' + JSON.stringify(out));
        assert.equal(out.sessionPresent, false, 'the whole session (subscription included) is gone');
        return { ...out, lostWhat: 'the session itself (subscription + offline queue) lives only in broker memory: session_present=false after the restart' };
      });
      await scenario('D01b', 'F-E2 reproduced, slow consumer flavour: ACK-less in-flight and queued messages are lost by a restart', async () => {
        const c = await consumerOpen({ hold: true }); const sent = ids('d01b', 200); const p = await publish(sent, { window: 8 }); await sleep(600);
        const heldBefore = c.received.size; await c.close(false);
        await L().restart(); await sleep(1500);
        const rx = await consumerOpen(); await settle(rx, p.acked.size, 9000, 60000); const acc = account(sent, p.acked, rx.received);
        assert.ok(acc.lostAfterPuback > 0, 'messages PUBACKed but not yet ACKed by the consumer were lost: ' + JSON.stringify(acc)); await rx.close(false);
        return { ...acc, deliveredButUnackedBeforeRestart: heldBefore, sessionPresent: rx.sessionPresent };
      });
      perf['non-durable'] = await perfProbe('non-durable');
    });

    // ================================================================ GROUP 2: DURABLE-TUNED
    await withLab({ durable: true, flushIntervalMs: 1, writeBufferMaxItems: 1 }, async () => {
      await scenario('D02', 'durable sessions are really enabled (config as code, no dashboard) with the tuned write buffer', async () => {
        const enabled = L().evalErl('emqx_config:get([durable_sessions, enable])'), flush = L().evalErl('maps:get(flush_interval, maps:get(local_write_buffer, maps:get(messages, emqx_config:get([durable_storage]))))'),
          backend = L().evalErl('maps:get(backend, maps:get(messages, emqx_config:get([durable_storage])))'), strategy = L().evalErl('emqx_config:get([cluster, discovery_strategy])');
        assert.deepEqual([enabled, flush, backend, strategy], ['true', '1', 'builtin_local', 'singleton']);
        return { durable_sessions_enable: enabled, flush_interval_ms: Number(flush), backend, discovery_strategy: strategy, image: EMQX_IMAGE, edition: L().evalErl('emqx_release:edition().') };
      });
      storage['empty'] = L().volumeBytes();
      await scenario('D03', 'durable: PUBACKed messages for an OFFLINE session survive `docker restart`', async () => {
        const { out } = await offlineQueue('d03', 200, 'restart');
        noLoss(out); assert.equal(out.sessionPresent, true);
        return out;
      });
      await scenario('D04', 'durable: messages DELIVERED-but-UNACKED (slow consumer) at the restart: PUBACKed-but-lost and stale redelivery, 3 consecutive cycles', async () => {
        const cycles: object[] = []; let totalLost = 0, totalStale = 0;
        for (let k = 0; k < 3; k += 1) {
          const c = await consumerOpen({ hold: true }); const sent = ids('d04c' + k, 100); const p = await publish(sent, { window: 8 }); await sleep(600);
          const heldBefore = c.received.size; await c.close(false); await L().restart(); await sleep(1500);
          const rx = await consumerOpen(); await settle(rx, p.acked.size, 9000, 60000); const acc = account(sent, p.acked, rx.received); await rx.close(false);
          noLoss(acc); totalLost += acc.lostAfterPuback; totalStale += acc.staleRedelivery;
          cycles.push({ cycle: k, sent: acc.sent, publisherAcked: acc.acked, deliveredButUnackedBeforeRestart: heldBefore, recovered: acc.receivedUnique - acc.unackedButReceived, PUBACKED_BUT_NOT_RECOVERED: acc.lostAfterPuback, lostSample: acc.lostSample, STALE_REDELIVERY: acc.staleRedelivery, staleSample: acc.staleSample, duplicates: acc.duplicates });
        }
        // the two numbers move together in every observation: what is lost is the in-flight window, what is replayed is the already-ACKed tail
        if (totalLost > 0) assert.ok(totalStale > 0, 'a PUBACKed loss comes with stale redelivery of already-consumed events');
        return { cycles, PUBACKED_BUT_NOT_RECOVERED: totalLost, STALE_REDELIVERY: totalStale, note: 'confirmed to the publisher, not recovered; component: session in-flight / ACK-position state (the offline queue itself is intact: D03)' };
      });
      await scenario('D05', 'durable: restart WITH the consumer online and consuming', async () => {
        const rx = await consumerOpen(); const sent = ids('d05', 300);
        const p = await publish(sent, { window: 8, onFirstAcks: { count: 100, run: () => { void L().restart(); } } });
        await sleep(2000); await waitFor('broker-back', async () => { try { return (await L().api('GET', '/status')).status === 200; } catch { return false; } }, 90000).catch(() => {});
        await rx.close(false); await sleep(1000);
        const rx2 = await consumerOpen(); await settle(rx2, p.acked.size, 4000, 45000);
        const merged = new Map<string, number>(rx.received); for (const [k, v] of rx2.received) merged.set(k, (merged.get(k) ?? 0) + v);
        const acc = account(sent, p.acked, merged); await rx2.close(false);
        noLoss(acc);
        return { ...acc, publisherFailedDuringRestart: p.failed, note: 'events sent but not PUBACKed during the restart are the PUBLISHER\'s to retry; they are not counted as broker loss' };
      });
      await scenario('D06', 'durable: graceful stop → start (same container, same volume)', async () => { const { out } = await offlineQueue('d06', 200, 'stopStart'); noLoss(out); return out; });
      await scenario('D07', 'durable: container RECREATED with the SAME volume (new container, same data)', async () => {
        const { out } = await offlineQueue('d07', 200, 'recreateSame'); noLoss(out); assert.equal(out.sessionPresent, true); return out;
      });
      await scenario('D19', 'durable: authenticator, ACL and rule are RESTORED from the volume after recreate (no reconfiguration)', async () => {
        console.log('D19 step: connecting publisher'); const ok = await pubOpen('lab-device-a', 'lab-device-a-acl-probe'); assert.ok(ok, 'the lab-device-a credential still authenticates after the recreate'); console.log('D19 step: publisher connected');
        const rx = await consumerOpen(); const sent = ids('d19', 5); const p = await publish(sent, { window: 1 }); await settle(rx, 5, 9000, 30000);
        // what exactly survived a recreate with the same volume? (read-only diagnostics through the management API)
        const persisted = { rules: (await L().api('GET', '/rules')).body.slice(0, 160), authn: (await L().api('GET', '/authentication')).body.slice(0, 140), authzSources: (await L().api('GET', '/authorization/sources')).body.slice(0, 160),
          consumerAclRules: (await L().api('GET', '/authorization/sources/built_in_database/rules/users/lab-consumer')).body.slice(0, 160) };
        const ruleMetrics = (await L().api('GET', '/rules/lab_verify/metrics')).body.slice(0, 260);
        console.log('D19 recoveryLatencyAfterResume=' + JSON.stringify(rx.latencyMs()) + ' publisherAcked=' + p.acked.size + ' publisherFailed=' + p.failed + ' consumerReceived=' + rx.received.size + ' sessionPresent=' + rx.sessionPresent + ' ruleMetrics=' + ruleMetrics);
        console.log('D19 persisted-after-recreate: ' + JSON.stringify(persisted));
        assert.equal(rx.received.size, 5, 'the broker rule still republishes');
        const denied = await new Promise<number | null>(res => { const t = setTimeout(() => res(-1), 8000); ok!.publish(LAB_VERIFIED_TOPIC, Buffer.from('{}'), { qos: 1 }, e => { clearTimeout(t); res((e as { code?: number } | null)?.code ?? null); }); });
        console.log('D19 step: denied-publish result ' + denied);
        const bad = await pubOpen('lab-device-a', 'lab-device-a', 'labpw-' + '0'.repeat(32));
        await rx.close(false); ok!.end(true);
        assert.equal(denied, 135, 'the ACL still denies publishing to the verified topic'); assert.equal(bad, null, 'a wrong password is still refused');
        return { authenticated: true, ruleRepublishes: true, firstNewMessageDelayAfterSessionResumeMs: rx.latencyMs(), aclDeniesVerifiedTopic: denied, wrongPasswordRefused: true, acked: p.acked.size };
      });
      await scenario('D09', 'durable-tuned: HARD KILL (docker kill, SIGKILL) right after the last PUBACK', async () => {
        const rows: object[] = [];
        for (let i = 0; i < 3; i += 1) { const { out } = await offlineQueue('d09r' + i, 200, 'kill', { immediate: true }); rows.push(out); noLoss(out); }
        return { runs: rows, runsWithLossAfterPuback: (rows as { lostAfterPuback: number }[]).filter(r => r.lostAfterPuback > 0).length, note: 'the window is NOT zero by construction (see D27)' };
      });
      await scenario('D09b', 'durable-tuned: broker KILLED while the publisher is mid-batch (exact PUBACK accounting)', async () => {
        const first = await consumerOpen(); await first.close(true); await sleep(300);
        const sent = ids('d09b', 400);
        const kill = new Promise<void>(res => { void res; });
        let killed: Promise<void> | null = null;
        const p = await publish(sent, { window: 16, onFirstAcks: { count: 150, run: () => { killed = L().kill(); } } });
        void kill; if (killed) await killed; await sleep(1500);
        const rx = await consumerOpen(); await settle(rx, p.acked.size, 4000, 45000); const acc = account(sent, p.acked, rx.received); await rx.close(false);
        assert.ok(acc.acked < acc.sent, 'the kill interrupted the batch: some events were SENT but never PUBACKed (publisher must retry them)');
        noLoss(acc);
        return { ...acc, sentButNeverAcked: acc.sent - acc.acked };
      });
      await scenario('D20', 'durable: payload bytes are EXACT after a hard kill and recovery (binary payload, topic and QoS preserved)', async () => {
        const payloadOf = (id: string) => Buffer.concat([Buffer.from('BIN:' + id + ':'), Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x7f, 0x0a, 0x0d]), Buffer.from(id)]);
        const first = await consumerOpen(); await first.close(true); await sleep(300);
        const sent = ids('d20', 40); const p = await publish(sent, { window: 4, payloadOf });
        await L().kill(); await sleep(1500);
        const rx = await consumerOpen(); await settle(rx, p.acked.size);
        // the consumer decodes `raw:<hex>` keys for non-JSON bytes: compare the exact bytes through the order list
        const got = [...rx.bytes.values()]; const want = new Set(sent.map(id => payloadOf(id).toString('hex'))); const matched = got.filter(b => want.delete(b.toString('hex'))).length;
        await rx.close(false);
        assert.equal(matched, p.acked.size, 'every recovered payload is byte-identical to what was sent');
        return { acked: p.acked.size, byteIdentical: matched };
      });
      await scenario('D21', 'durable: ordering observed after recovery (same publisher / same topic)', async () => {
        const { out, rx, sent } = await offlineQueue('d21', 120, 'restart');
        const pos = new Map(sent.map((id, i) => [id, i])); const seq = rx.order.map(id => pos.get(id) ?? -1).filter(i => i >= 0);
        const inversions = seq.reduce((n, v, i) => n + (i > 0 && v < seq[i - 1]! ? 1 : 0), 0);
        return { ...out, orderInversions: inversions, note: 'no global ordering is promised; this is the observed order for one publisher on one topic' };
      });
      await scenario('D11', 'durable: broker killed mid-flight + END-TO-END durable inbox: duplicates tolerated, EXACTLY ONE measurement per event', async () => {
        const mk = async () => { const c = await startConsumerRetrying({ conn: conns[1]!, brokerUrl: L().brokerUrl, password: L().secrets['lab-consumer']!, metricsSink: metrics, clientId: consumerId(), clean: false, durableSession: true, sessionExpirySeconds: 3600 }); live.add(c); return c; };
        const c1 = await mk(); await c1.stop(); live.delete(c1); await sleep(300);                      // session created, consumer offline
        const sent = ids('d11', 150), p = await publish(sent, { window: 8 }); await L().kill(); await sleep(1500);
        const c2 = await mk(); await settleCount('d11', p.acked.size); await c2.idle(); await sleep(1500);
        const m = await mCountTag('d11'), inbox = await inboxRows.countDocuments({}), dup = await measurements.aggregate([{ $group: { _id: { e: '$eventId', f: '$field' }, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }]).toArray();
        await c2.stop(); live.delete(c2);
        noLoss({ lostAfterPuback: Math.max(0, p.acked.size - m), acked: p.acked.size }); assert.ok(m <= sent.length, 'never more measurements than events SENT (an event whose PUBACK was lost may still have been stored)'); assert.equal(dup.length, 0, 'no second measurement');
        return { acked: p.acked.size, measurements: m, inboxRecords: inbox, duplicateMeasurements: dup.length, lostAfterPuback: Math.max(0, p.acked.size - m) };
      });
      await scenario('D12', 'durable: broker restart + consumer restart together (persistent session): no loss', async () => {
        const mk = async () => { const c = await startConsumerRetrying({ conn: conns[1]!, brokerUrl: L().brokerUrl, password: L().secrets['lab-consumer']!, metricsSink: metrics, clientId: consumerId(), clean: false, durableSession: true, sessionExpirySeconds: 3600 }); live.add(c); return c; };
        const c1 = await mk(); const sent = ids('d12', 200);
        const p = await publish(sent, { window: 8, onFirstAcks: { count: 80, run: () => { void c1.stop(); void L().restart(); } } });
        await sleep(2500); live.delete(c1); await waitFor('broker-back', async () => { try { return (await L().api('GET', '/status')).status === 200; } catch { return false; } }, 90000).catch(() => {});
        const c2 = await mk(); await settleCount('d12', p.acked.size); await c2.idle(); await sleep(1500);
        const m = await mCountTag('d12'); await c2.stop(); live.delete(c2);
        noLoss({ lostAfterPuback: Math.max(0, p.acked.size - m), acked: p.acked.size }); assert.ok(m <= sent.length);
        return { acked: p.acked.size, measurements: m, lostAfterPuback: Math.max(0, p.acked.size - m), publisherFailedDuringRestart: p.failed };
      });
      await scenario('D13', 'durable: broker restart + MONGO without majority: the consumer cannot persist, does not ACK, the broker keeps the messages; after healing everything is processed', async () => {
        const mark = (m: string) => console.log('  [D13] ' + m); mark('start'); const first = await consumerOpen(); await first.close(true); await sleep(300);
        const sent = ids('d13', 60), p = await publish(sent, { window: 8 }); mark('publisher done, restarting broker'); await L().restart(); await sleep(1500); mark('broker back');
        await waitHealthy(); const pr = await primaryIndex(), sec = [0, 1, 2].filter(i => i !== pr);
        const mk = async () => { const c = await startConsumerRetrying({ conn: conns[2]!, brokerUrl: L().brokerUrl, password: L().secrets['lab-consumer']!, metricsSink: metrics, clientId: consumerId(), clean: false, durableSession: true, sessionExpirySeconds: 3600 }); live.add(c); return c; };
        mark('mongo secondaries paused'); for (const s of sec) chaos(request, 'pause', s);
        let during = 0, unreadable = false;
        try { const c = await mk().catch(() => null); await sleep(9000); during = await mCountTag('d13').catch(() => { unreadable = true; return 0; }); if (c) { await c.stop().catch(() => {}); live.delete(c); } } finally { for (const s of sec) chaos(request, 'unpause', s); mark('unpaused'); }
        await waitHealthy(); assert.equal(during, 0, 'nothing was processed without a Mongo majority');
        // A consumer that withholds an ACK drops its connection (the adapter never reconnects by itself): a supervisor restarts it, as in 11E.
        const withheld0 = metrics.filter(x => x.name === 'broker_adapter_delivery_total' && (x.labels as { outcome?: string }).outcome === 'withheld').length; let attempts = 0;
        const accounted = async () => (await mCountTag('d13')) + (await quarantineRows.countDocuments({ eventId: { $regex: '^e11f-d13-' } }));
        mark('healthy again'); const mStart = metrics.length; let c = await mk();
        for (; attempts < 4 && (await accounted()) < p.acked.size; attempts += 1) {
          await waitFor('d13-accounted', async () => (await accounted()) >= p.acked.size, 15000).catch(() => {});
          if ((await accounted()) >= p.acked.size) break;
          await c.stop().catch(() => {}); live.delete(c); await sleep(1500); c = await mk();
        }
        mark('supervisor done after ' + attempts); const withheld = metrics.filter(x => x.name === 'broker_adapter_delivery_total' && (x.labels as { outcome?: string }).outcome === 'withheld').length - withheld0;
        await sleep(2000); await c.idle();
        // an attempt that hit the lost majority may sit RECEIPTED: the receipted recovery (TEST_ONLY policy) settles it, as in D14
        const recon: unknown[] = [];
        for (let i = 0; i < 6 && (await mCountTag('d13')) < p.acked.size; i += 1) { await sleep(2000); const r = await c.reconciler.reconcileBrokerInbox({ mode: 'reconcile', limit: 100 }); recon.push(JSON.stringify(r).slice(0, 220)); }
        const quarantineTotal = await quarantineRows.countDocuments({}), quarantineSample = (await quarantineRows.find({}).limit(2).toArray()).map(d => JSON.stringify(d).slice(0, 420)), measurementsTotal = await measurements.countDocuments({}), measurementsD13Local = await measurements.countDocuments({ eventId: { $regex: '^e11f-d13-' } }), metricTally = Object.entries(metrics.slice(mStart).reduce((a: Record<string, number>, x) => { const l = x.labels as Record<string, string>; const k = x.name + '|' + (l.outcome ?? '') + '|' + (l.reasonCode ?? ''); a[k] = (a[k] ?? 0) + 1; return a; }, {})).slice(0, 14), claimsTotal = await db.collection(inn.idempotency).countDocuments({}), claimSample = (await db.collection(inn.idempotency).find({}).sort({ _id: -1 }).limit(2).toArray()).map(d => JSON.stringify(d).slice(0, 600)), measurementSample = (await measurements.find({}).sort({ _id: -1 }).limit(2).toArray()).map(d => JSON.stringify(d).slice(0, 600)), d13Sample: string[] = [];
        const stateCounts = await stateRows.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray();
        mark('reconcile done'); const m = await mCountTag('d13'), q = await quarantineRows.countDocuments({ eventId: { $regex: '^e11f-d13-' } }), inboxN = await inboxRows.countDocuments({});
        await c.stop(); live.delete(c);
        noLoss({ lostAfterPuback: Math.max(0, p.acked.size - m - q), acked: p.acked.size });
        return { acked: p.acked.size, processedWhileMongoDown: unreadable ? 'unreadable-without-majority (nothing could be committed either)' : during, measurementsAfterHealing: m, quarantined: q, inboxRecords: inboxN, supervisorRestarts: attempts, withheldDeliveries: withheld, stateCounts, quarantineTotal, quarantineSample, measurementsTotal, measurementsD13Local, metricTally, claimsTotal, claimSample, measurementSample, reconcileSamples: recon.slice(0, 2), lostAfterPuback: Math.max(0, p.acked.size - m - q) };
      });
      await scenario('D14', 'durable: broker recovered, THEN a Mongo primary failover: exactly one measurement per event', async () => {
        const first = await consumerOpen(); await first.close(true); await sleep(300);
        const sent = ids('d14', 80), p = await publish(sent, { window: 8 }); await L().kill(); await sleep(1500); await waitHealthy();
        const mk = async () => { const c = await startConsumerRetrying({ conn: conns[3]!, brokerUrl: L().brokerUrl, password: L().secrets['lab-consumer']!, metricsSink: metrics, clientId: consumerId(), clean: false, durableSession: true, sessionExpirySeconds: 3600 }); live.add(c); return c; };
        const c = await mk(); const old = await primaryIndex(); chaos(request, 'stop', old);
        try { await sleep(12000); } finally { chaos(request, 'start', old); } await waitHealthy();
        await c.stop().catch(() => {}); live.delete(c); const c2 = await mk();
        await waitFor('d14-accounted', async () => { const m = await mCountTag('d14'); const q = await quarantineRows.countDocuments({ eventId: { $regex: '^e11f-d14-' } }); return m + q >= p.acked.size; }, 150000);
        await sleep(2500); await c2.idle();
        // a processing attempt that hit the election may sit RECEIPTED: the receipted recovery (TEST_ONLY policy) settles it
        for (let i = 0; i < 6 && (await mCountTag('d14')) < p.acked.size; i += 1) { await sleep(2000); await c2.reconciler.reconcileBrokerInbox({ mode: 'reconcile', limit: 100 }); }
        const m = await mCountTag('d14'), q = await quarantineRows.countDocuments({ eventId: { $regex: '^e11f-d14-' } });
        await c2.stop(); live.delete(c2);
        noLoss({ lostAfterPuback: Math.max(0, p.acked.size - m - q), acked: p.acked.size }); const dup = await measurements.aggregate([{ $group: { _id: { e: '$eventId', f: '$field' }, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }]).toArray(); assert.equal(dup.length, 0);
        return { acked: p.acked.size, measurements: m, quarantined: q, lostAfterPuback: Math.max(0, p.acked.size - m - q), stoppedMongoPrimary: old };
      });
      await scenario('D15', 'misconfiguration: clean start after the queue was built DISCARDS the session (loss is expected and the lab guard refuses this config)', async () => {
        const first = await consumerOpen(); await first.close(true); await sleep(300);
        const sent = ids('d15', 100), p = await publish(sent, { window: 8 }); await L().restart(); await sleep(1500);
        const rx = await consumerOpen({ clean: true }); await settle(rx, p.acked.size, 2500); const acc = account(sent, p.acked, rx.received); await rx.close(false);
        assert.ok(acc.lostAfterPuback > 0, 'cleanStart=true recovers nothing: ' + JSON.stringify(acc));
        return { ...acc, cleanStart: true, sessionPresent: rx.sessionPresent };
      });
      await scenario('D16', 'misconfiguration: sessionExpiryInterval=0 never creates a durable session (loss is expected)', async () => {
        const c0 = await consumerOpen({ expiry: 0 }); await c0.close(true); await sleep(400);          // the session ends with the connection
        const sent = ids('d16', 100), p = await publish(sent, { window: 8 }); await sleep(300);
        const rx = await consumerOpen({ expiry: 3600 }); await settle(rx, p.acked.size, 2500); const acc = account(sent, p.acked, rx.received); await rx.close(false);
        assert.ok(acc.lostAfterPuback > 0, JSON.stringify(acc)); return { ...acc, sessionExpiryInterval: 0 };
      });
      await scenario('D17/D18', 'client id stability: a DIFFERENT clientId cannot reclaim the old session; the SAME clientId recovers everything', async () => {
        const first = await consumerOpen({ clientId: 'lab-consumer-owner' }); await first.close(true); await sleep(300);
        const sent = ids('d17', 80), p = await publish(sent, { window: 8 }); await L().restart(); await sleep(1500);
        const other = await consumerOpen({ clientId: 'lab-consumer-intruder' }); await settle(other, p.acked.size, 2500);
        const same = await consumerOpen({ clientId: 'lab-consumer-owner' }); await settle(same, p.acked.size);
        const accOther = account(sent, p.acked, other.received), accSame = account(sent, p.acked, same.received); await other.close(false); await same.close(false);
        assert.equal(accOther.receivedUnique, 0, 'a new client id receives nothing from the old session'); noLoss(accSame);
        return { differentClientIdReceived: accOther.receivedUnique, sameClientIdRecovered: accSame.receivedUnique, acked: p.acked.size, sameClientSessionPresent: same.sessionPresent };
      });
      await scenario('D26', 'session expiry (LAB_ONLY_SESSION_EXPIRY): recoverable before the expiry, gone after it (not a bug)', async () => {
        const a = await consumerOpen({ clientId: 'lab-consumer-exp', expiry: 4 }); await a.close(true); await sleep(300);
        const early = ids('d26a', 20), pe = await publish(early, { window: 4 }); await sleep(1000);
        const r1x = await consumerOpen({ clientId: 'lab-consumer-exp', expiry: 4 }); await settle(r1x, pe.acked.size); const before = account(early, pe.acked, r1x.received); await r1x.close(true);
        await sleep(7000);                                                                                    // longer than the 4 s expiry
        const late = ids('d26b', 20), pl = await publish(late, { window: 4 });
        const r2 = await consumerOpen({ clientId: 'lab-consumer-exp', expiry: 4 }); await settle(r2, pl.acked.size, 2500); const after = account(late, pl.acked, r2.received); await r2.close(false);
        noLoss(before); assert.ok(after.lostAfterPuback > 0 && r2.sessionPresent === false, 'the expired session is gone: ' + JSON.stringify(after));
        return { sessionExpiryIntervalSeconds: 4, recoveredBeforeExpiry: before.receivedUnique, recoveredAfterExpiry: after.receivedUnique, sessionPresentAfterExpiry: r2.sessionPresent };
      });
      storage['afterQueue'] = L().volumeBytes();
      perf['durable-tuned'] = await perfProbe('durable-tuned'); storage['afterPerf'] = L().volumeBytes();
    });

    // ================================================================ GROUP 3: DURABLE-DEFAULT write buffer (100 ms)
    await withLab({ durable: true }, async () => {
      await scenario('D08', 'durable: container recreated with a NEW (empty) volume loses everything (negative control: durability lives in the volume)', async () => {
        const { out } = await offlineQueue('d08', 200, 'recreateNew');
        assert.ok(out.acked > 0 && out.lostAfterPuback === out.acked && out.sessionPresent === false, JSON.stringify(out)); return out;
      });
      await scenario('D09d', 'durable with the EMQX DEFAULT write buffer (100 ms): a kill right after the PUBACKs', async () => {
        const rows: object[] = []; let lostRuns = 0;
        for (let i = 0; i < 3; i += 1) { const { out } = await offlineQueue('d09d' + i, 100, 'kill', { immediate: true }); rows.push(out); noLoss(out); if (out.lostAfterPuback > 0) lostRuns += 1; }
        return { runs: rows, runsWithLossAfterPuback: lostRuns, note: 'PUBACK is sent BEFORE the buffered durable write: a crash inside the flush window loses confirmed messages' };
      });
      perf['durable-default-100ms'] = await perfProbe('durable-default-100ms');
    });

    // ================================================================ GROUP 4: DURABLE-WIDE (flush 3 s) — the exact PUBACK-vs-durable-commit semantics
    await withLab({ durable: true, flushIntervalMs: 3000 }, async () => {
      await scenario('D27', 'PUBACK semantics: with a 3 s write buffer a kill right after the PUBACKs loses EVERY confirmed message (PUBACK precedes the durable write)', async () => {
        await L().restart(); await sleep(2000);       // the API bootstrap (users, ACL, rule) is persisted by a graceful stop first: a SIGKILL seconds after bootstrap is a different experiment
        const { out } = await offlineQueue('d27', 50, 'kill', { immediate: true });
        assert.ok(out.acked > 0 && out.lostAfterPuback > 0, 'PUBACKed => NOT recovered: ' + JSON.stringify(out));
        return { ...out, pubAckLatencyIsMs: out.pubAckMs.p50, flushIntervalMs: 3000, conclusion: 'PUBACK latency stays ~1 ms while the durable flush takes up to 3 s: the broker confirms BEFORE the durable commit. The loss window equals the flush interval.' };
      });
    });

    // ================================================================ reports
    await scenario('D22', 'throughput impact of durability (publisher PUBACK rate, 400 QoS1 events, window 16)', async () => ({ label: 'LOCAL_LAB_EVIDENCE', ...perf, baseline11E: 'consumer pipeline ~20-24 events/s (different measurement: this is the broker publish path only)' }));
    await scenario('D23', 'publisher PUBACK latency impact of durability (p50/p95/p99 ms)', async () => ({ label: 'LOCAL_LAB_EVIDENCE', ...Object.fromEntries(Object.entries(perf).map(([k, v]) => [k, { p50: v.p50, p95: v.p95, p99: v.p99 }])) }));
    await scenario('D24', 'durable storage footprint and cleanup (approximate; not a sizing)', async () => ({ label: 'LOCAL_LAB_EVIDENCE', dataDirBytes: storage, volumesLeftAfterLabs: labVolumesRemaining().length, note: 'the volume is removed with the lab; nothing outlives the campaign' }));
    await scenario('D28', 'storage unavailable / read-only: would the broker still confirm?', async () => { throw new NotVerifiable('no safe way to make the Docker volume read-only or unavailable without risking the host; NOT simulated'); });
    await scenario('D29', 'disk full', async () => { throw new NotVerifiable('filling a disk is not done on the host; a size-limited volume driver is not available in this environment; NOT simulated'); });
    await scenario('D25', 'no residual EMQX containers, networks or lab volumes', async () => {
      const containers = labContainersRemaining(), volumes = labVolumesRemaining();
      assert.deepEqual([containers, volumes], [[], []]); return { containers: 0, volumes: 0 };
    });

    stage = 'evidence';
    const windowDemonstrated = results.find(r => r.id === 'D27')?.status === 'PASS';
    const f2 = gaps.length === 0;
    const dir = join(process.cwd(), '.local-evidence'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'be13-11f-durability.json'), JSON.stringify({ label: 'LOCAL_LAB_EVIDENCE', gitSha: sha, mongoVersion: build.version, emqxImage: EMQX_IMAGE, run: request.runId, elapsedS: r1((Date.now() - t0) / 1000),
      fE2: { survivalScenariosWithoutAnyLossAfterPuback: f2, gaps, hardCrashWindowDemonstrated: windowDemonstrated,
        knownLimitations: results.filter(r => r.status === 'KNOWN_LIMITATION').map(r => r.id), unexpectedFailures: results.filter(r => r.status === 'FAIL').map(r => r.id),
        classification: results.some(r => r.status === 'KNOWN_LIMITATION') ? 'BLOCKED_BY_BROKER_CAPABILITY (EMQX 5.8.6 CE: PUBACKed messages delivered-but-unacked at the restart are not recovered; PUBACK precedes the durable write)'
          : (f2 && !windowDemonstrated) ? 'CLOSED_LOCAL_CANDIDATE' : 'OPEN (a PUBACKed message was not recovered' + (windowDemonstrated ? '; PUBACK precedes the durable write' : '') + ')' },
      perf, storage, results }, null, 2));
    if (results.some(r => r.status === 'FAIL')) process.exitCode = 1;     // an unexpected loss or broken invariant is never hidden by a green exit code
  } finally {
    for (const c of [...rawClients]) { try { c.end(true); } catch { /* */ } }
    for (const c of live) await c.stop().catch(() => {});
    (lab as EmqxLab | null)?.stop();
    const first = conns[0];
    if (first?.readyState === 1) { try { verifyOwnedMultiNode(request); await first.db!.dropDatabase(); } catch { /* launcher confirms cleanup */ } }
    for (const c of conns) await c.close().catch(() => {});
    console.log(JSON.stringify({ event: 'be13-11f-summary', pass: results.filter(r => r.status === 'PASS').length, fail: results.filter(r => r.status === 'FAIL').length,
      noVerificable: results.filter(r => r.status === 'NO_VERIFICABLE').length, knownLimitation: results.filter(r => r.status === 'KNOWN_LIMITATION').length, labContainersLeft: labContainersRemaining().length, labVolumesLeft: labVolumesRemaining().length }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  console.error('BE1311F_LOCAL_FAILED ' + JSON.stringify({ stage, errorClass: error instanceof Error ? error.name : 'Unknown', message: error instanceof Error ? error.message.slice(0, 240).replace(/labpw-[0-9a-f]+/g, '***') : undefined }));
  process.exitCode = 1;
});
