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
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
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
import { createMongoMeasurementPersistence, idempotencyDocumentId, measurementDocumentId } from '../src/repositories/mongo-measurement-persistence.repository.js';
import { loadMqttJsFactory } from '../src/adapters/emqx-mqtt-connect.js';
import { LAB_VERIFIED_TOPIC } from '../src/adapters/emqx-mqtt-broker.adapter.js';
import { EMQX_IMAGE, labContainersRemaining, labVolumesRemaining, startEmqxLab, type EmqxLab, type EmqxLabOptions } from './be13-11d/emqx-lab.js';
import { LAB_PRINCIPALS, INGEST, BUSINESS, SENSOR, startLabConsumer, type LabConsumer, type MetricSink, type TimingMap } from './be13-11d/lab-consumer.js';
import { createTokenBucketRateLimiter, PROPOSED_TEST_RATE_LIMIT } from '../src/iot/confirmation-rate-limit.js';
import { createIngestConfirmationService } from '../src/services/ingest-confirmation.service.js';
import { createIngestConfirmationRouter } from '../src/routes/ingest-confirmation.routes.js';
import { createMongoIngestConfirmationEvidence } from '../src/repositories/mongo-ingest-confirmation.evidence.js';
import { reconcilePublish, type PublisherRetryPolicy, type ReconcileResult } from './be13-11j/publisher-reconciler.js';
import { createFileOutboxStore, createOutboxPublisher, sha256Hex, type OutboxPolicy } from './be13-11n/publisher-outbox.js';
import { createFileStore as createRefFileStore, createHttpReconciliationClient, createMemoryStore as createRefMemoryStore, createReferencePublisher, createTestOnlyAuth } from './be14-01/reference-publisher.js';
import { createMqttPublisherPort } from './be14-01/mqtt-port.js';
import { classifyEventualDelivery, classifyOutcome, deliveryTimeline, parseSessionResponses, scenarioOfEvent, type PacketRecord } from './be13-11i/delivery-order.js';

// KNOWN_LIMITATION = a durability requirement the broker DEMONSTRABLY does not meet (documented, reproducible, expected here). A PUBACKed message that is
// not recovered in any OTHER scenario is a plain FAIL: it is never relabelled.
type Status = 'PASS' | 'FAIL' | 'NO_VERIFICABLE' | 'KNOWN_LIMITATION';
const EXPECTED_LIMITATION = new Set(['D04', 'D09d', 'D13b']);
const gaps: { id: string; lostAfterPuback: number; acked: number }[] = [];
const results: { id: string; name: string; status: Status; evidence?: unknown; note?: string }[] = [];
class NotVerifiable extends Error {}
// BE13-11H (TEST_ONLY): session-history counters, read by the D13b snapshot.
const sess = { brokerRestarts: 0, consumerOpens: 0, adapterStarts: 0 };
let stage = 'bootstrap';
// BE13_11F_ONLY=D04,D05 runs just those scenarios (development aid).
const only = process.env.BE13_11F_ONLY ? new Set(process.env.BE13_11F_ONLY.split(',')) : null;
async function scenario(id: string, name: string, work: () => Promise<unknown>) {
  if (only && !only.has(id)) return;
  stage = id; const gapsBefore = gaps.length;
  try {
    const evidence = await Promise.race([work(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('SCENARIO_TIMEOUT_8MIN')), 480000))]);
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
  for (let i = 0; i < 12; i += 1) { try { sess.adapterStarts += 1; return await startLabConsumer(o); } catch (e) { last = e; if (!/ECONNREFUSED|CLOSED_BEFORE_READY|ETIMEDOUT/.test(String((e as Error).message))) throw e; await new Promise(r => setTimeout(r, 1500)); } }
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
    const bounded = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('STATUS_TIMEOUT')), ms))]);   // a stuck driver selection must not eat the scenario budget
    const waitHealthy = async () => { for (let i = 0; i < 70; i += 1) { try { const s = await bounded(status(), 4000); if (s.members.filter(m => m.health === 1).length === 3 && s.members.filter(m => m.stateStr === 'PRIMARY').length === 1 && s.members.filter(m => m.stateStr === 'SECONDARY').length === 2) return; } catch { /* election */ } await sleep(500); } throw Error('MN_WAIT_TIMEOUT_healthy'); };
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
    // The idempotency identity of a reading is its CONTENT (source, device, declared time, field, value), not only its eventId: two scenarios that
    // publish the same value would be judged duplicates of each other (a harness collision, proven in D13). Every event of the campaign therefore carries a unique value.
    const valueByEvent = new Map<string, number>(); let nextValue = 1;
    const eventBody = (id: string, _seq: number) => { if (!valueByEvent.has(id)) valueByEvent.set(id, nextValue++); return fx.bytesOf(fx.envelope({ eventId: id, clientid: 'lab-device-a', payload: { temperature: valueByEvent.get(id)! } })); };
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
      sess.consumerOpens += 1; const received = new Map<string, number>(), order: string[] = [], bytes = new Map<string, Buffer>(); let connectedAt = 0, firstAt = 0, lastAt = 0;
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
    const withLab = async <T>(options: EmqxLabOptions, fn: () => Promise<T>) => { lab = await startEmqxLab(request.basePort, request.runId, [], options); for (const k of ['restart', 'stopStart', 'kill', 'recreate'] as const) { const orig = (lab[k] as (...a: never[]) => Promise<void>).bind(lab); (lab as unknown as Record<string, unknown>)[k] = async (...a: never[]) => { sess.brokerRestarts += 1; return orig(...a); }; } try { return await fn(); } finally { for (const c of [...rawClients]) { try { c.end(true); } catch { /* */ } } rawClients.clear(); for (const c of [...live]) { await c.stop().catch(() => {}); live.delete(c); } lab.stop(); lab = null; } };
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
    // BE13-11H: read-only snapshot of the durable session as the broker reports it (management API) + harness counters. Taken while the consumer is connected.
    const sessionSnapshot = async (rx: Rx) => {
      const get = async (path: string) => { try { const r = await L().api('GET', path); return { status: r.status, full: r.body, body: r.body.slice(0, 900) }; } catch (e) { return { error: (e as Error).message.slice(0, 80) }; } };
      const client = await get('/clients/' + consumerId()); let c: Record<string, unknown> = {}; try { c = JSON.parse((client as { full?: string }).full ?? '{}') as Record<string, unknown>; } catch { /* not JSON */ }
      return { clientId: consumerId(), sessionPresent: rx.sessionPresent, cleanStartRequested: false, sessionExpiryRequested: 3600, brokerRestartsSoFar: sess.brokerRestarts, rawConsumerOpensSoFar: sess.consumerOpens, adapterStartsSoFar: sess.adapterStarts,
        adapterConnectedMetric: metrics.filter(x => x.name === 'broker_adapter_connection_total' && (x.labels as { outcome?: string }).outcome === 'connected').length, scenariosBefore: results.map(r => r.id),
        broker: { connected: c.connected, clean_start: c.clean_start, expiry_interval: c.expiry_interval, inflight_cnt: c.inflight_cnt, mqueue_len: c.mqueue_len, mqueue_dropped: c.mqueue_dropped, subscriptions_cnt: c.subscriptions_cnt, created_at: c.created_at, connected_at: c.connected_at, recv_cnt: c.recv_cnt, send_cnt: c.send_cnt, rawStatus: (client as { status?: number }).status },
        subscriptions: await get('/subscriptions?clientid=' + consumerId()) };
    };
    // BE13-11I (TEST_ONLY, active only with BE13_11I_TAG): COMPLETE management-API snapshots of the durable session (S0..S5), a passive MQTT packet tap (DUP flag, order, CONNACK) and per-scenario D13 counters.
    const i11 = { on: Boolean(process.env.BE13_11I_TAG), t0: performance.now(), snapshots: [] as Record<string, unknown>[], packets: [] as (PacketRecord & { cmd?: string; sessionPresent?: boolean })[], d13: {} as Record<string, unknown>, d13Timings: new Map() as TimingMap };
    const deepSnapshot = async (point: string, extra: Record<string, unknown> = {}) => {
      if (!i11.on) return null;
      const id = consumerId(); const get = async (path: string) => { try { const r = await L().api('GET', path, undefined, { full: true }); return { status: r.status, body: r.body }; } catch (e) { return { error: (e as Error).message.slice(0, 80) }; } };
      const raw = { client: await get('/clients/' + id), subscriptions: await get('/subscriptions?clientid=' + id), inflight: await get('/clients/' + id + '/inflight_messages?limit=1000'), mqueue: await get('/clients/' + id + '/mqueue_messages?limit=1000') };
      const parsed = parseSessionResponses(raw); const f = (n: string) => parsed.fields.find(x => x.name === n);
      const snap = { point, tMs: Math.round(performance.now() - i11.t0), at: new Date().toISOString(), clientId: id, ...extra, parsed, raw };
      i11.snapshots.push(snap); console.log('  [11I] ' + point + ' client=' + String(parsed.clientHttpStatus) + ' connected=' + String(f('connected')?.value) + ' inflight_cnt=' + String(f('inflight_cnt')?.value ?? 'NOT_EXPOSED') + ' mqueue_len=' + String(f('mqueue_len')?.value ?? 'NOT_EXPOSED') + ' inflightMsgs=' + String(parsed.inflightMessages?.length ?? 'NOT_EXPOSED') + ' mqueueMsgs=' + String(parsed.mqueueMessages?.length ?? 'NOT_EXPOSED') + ' subs=' + String(parsed.subscriptions?.length ?? 'NOT_EXPOSED'));
      return snap;
    };
    const i11Tap = (scn: string) => i11.on ? { packetScenario: scn, packetSink: (r: PacketRecord & { cmd: string; sessionPresent?: boolean }) => { i11.packets.push(r); } } : {};
    // BE13-11N (TEST_ONLY, only with BE13_11N_TAG): durable publisher. ONE MQTT connection per publisher identity (the boundary binds the MQTT clientId to the device key),
    // a file outbox that survives a crash, confirmation through the reconciliation router over the real Mongo evidence.
    const pubStats = { opens: 0, maxConcurrent: 0, concurrent: 0 }; let pubConn: MqttClient | null = null, pubOpening: Promise<MqttClient | null> | null = null;
    const ensurePub = async (): Promise<MqttClient | null> => {
      if (pubConn && !(pubConn as MqttClient & { isClosed: () => boolean }).isClosed()) return pubConn;
      if (!pubOpening) pubOpening = (async () => { const c = await pubOpen('lab-device-a'); if (c) { pubStats.opens += 1; pubStats.concurrent += 1; pubStats.maxConcurrent = Math.max(pubStats.maxConcurrent, pubStats.concurrent); c.on('close', () => { pubStats.concurrent -= 1; }); } pubConn = c; pubOpening = null; return c; })();
      return pubOpening;
    };
    const closePub = async () => { const c = pubConn; pubConn = null; if (c) await new Promise<void>(res => { c.end(true, {}, () => res()); setTimeout(res, 1500); }); };
    const publishOne = async (_eventId: string, bytes: Uint8Array): Promise<boolean> => { try { const c = await ensurePub(); if (!c) return false;
      return await new Promise<boolean>(res => { const t = setTimeout(() => res(false), 8000); c.publish('agro/lab/in/a', Buffer.from(bytes), { qos: 1 }, e => { clearTimeout(t); res(!e); }); }); } catch { return false; } };
    const startOutboxPublisher = async (sent: string[]) => {
      mkdirSync('.local-evidence', { recursive: true }); const path = '.local-evidence/outbox-' + process.env.BE13_11N_TAG!.replace(/[^\w.-]/g, '_') + '.json'; writeFileSync(path, JSON.stringify({ version: 1, entries: [] }));
      const policy: OutboxPolicy = { mode: 'TEST_ONLY', capacity: 200, fast: { initialDelayMs: 2000, backoffFactor: 1.5, maxDelayMs: 6000, jitterRatio: 0.25, maxAttempts: 6, maxElapsedMs: 600000 }, slow: { intervalMs: 12000, confirmWaitMs: 2000, maxElapsedMs: 270000 } };
      const make = () => createOutboxPublisher({ store: createFileOutboxStore(path), policy, deps: { now: () => Date.now(), random: () => Math.random(), publish: publishOne, confirm: (eid, h) => confirmVia(eid, h) } });
      let pub = make(); const t0 = performance.now();
      const submitted = sent.map(id => pub.submit({ eventId: id, bytes: eventBody(id, 0) }).result);
      await pub.tick(8); pub.setGate(false);                                    // attempt 1 of every event = the original publication; confirmations are HELD until the original window is over
      const acked = new Set(pub.entries().filter(e => e.brokerAcceptedCount > 0).map(e => e.eventId));
      return { get pub() { return pub; }, rebuild() { pub = make(); return pub; }, path, policy, submitted, initial: { acked, lat: [] as number[], durationMs: performance.now() - t0, failed: sent.length - acked.size } };
    };
    let confirmVia: (eventId: string, payloadSha256: string) => Promise<{ ok: true; status: string } | { ok: false }> = async () => ({ ok: false });
    // BE14-01 (REFERENCE_IMPLEMENTATION_ONLY, only with BE14_01_TAG): the reference publisher with a REAL MQTT.js connection (one per identity, clientId = device key) and a file outbox.
    let refBase = '';
    const refClient = (principal = 'emqx-user:lab-device-a') => createHttpReconciliationClient({ baseUrl: refBase, auth: createTestOnlyAuth(principal), timeoutMs: 4000 });
    const startRefPublisher = async (sent: string[]) => {
      mkdirSync('.local-evidence', { recursive: true }); const path = '.local-evidence/ref-outbox-' + process.env.BE14_01_TAG!.replace(/[^\w.-]/g, '_') + '.json'; writeFileSync(path, JSON.stringify({ version: 1, nextSeq: 1, entries: [] }));
      const policy: OutboxPolicy = { mode: 'TEST_ONLY', capacity: 200, fast: { initialDelayMs: 2000, backoffFactor: 1.5, maxDelayMs: 6000, jitterRatio: 0.25, maxAttempts: 6, maxElapsedMs: 600000 }, slow: { intervalMs: 12000, confirmWaitMs: 2000, maxElapsedMs: 270000 } };
      const mqttPort = createMqttPublisherPort({ url: L().brokerUrl, technicalKey: 'lab-device-a', username: 'lab-device-a', password: L().secrets['lab-device-a']!, topic: 'agro/lab/in/a' });
      const make = (store = createRefFileStore(path)) => createReferencePublisher({ store, policy, technicalKey: 'lab-device-a', mqtt: mqttPort, reconciliation: { query: (eid, h) => refClient().query(eid, h) } });
      const holder = { pub: make() };
      const t0 = performance.now(); const submitted = sent.map((id, i) => holder.pub.submitReading({ eventId: id, payload: { temperature: 1000 + i }, topic: 'agro/lab/in/a', dataOrigin: 'simulated' }).result);
      await holder.pub.tick(8); holder.pub.setGate(false);                 // attempt 1 of every event = the original publication; confirmations are HELD until the original window is over
      const acked = new Set(holder.pub.entries().filter(e => e.brokerAcceptedCount > 0).map(e => e.eventId));
      return { holder, path, policy, mqttPort, make, submitted, initial: { acked, lat: [] as number[], durationMs: performance.now() - t0, failed: sent.length - acked.size } };
    };
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
      // BE13-11G (G01): is the idempotency PRE-CHECK safe against a claim that a majority does NOT hold? A claim written while the secondaries are
      // paused exists only on the primary. If the pre-check reads it (readConcern local) it answers "duplicate" for an event whose measurement may
      // later be rolled back: the event is then considered handled and is lost. The pre-check must never see data that is not majority-committed.
      await scenario('G01', 'idempotency pre-check does NOT trust a claim that only the primary holds (no majority)', async () => {
        const first = await consumerOpen(); await first.close(true);
        const pr = await primaryIndex(), sec = [0, 1, 2].filter(i => i !== pr);
        const store = createMongoMeasurementPersistence({ connection: conns[4]!, prefix: INGEST, realm: 'test' as never });
        const key = { realm: 'test', sourceId: 'lab-source-a', operation: 'measurement', eventId: 'e11f-g01-0', field: 'temperature' } as never;
        const claims = db.collection(inn.idempotency); const claimId = idempotencyDocumentId(key);
        const claimDoc = { _id: claimId, realm: 'test', sourceId: 'lab-source-a', operation: 'measurement', eventId: 'e11f-g01-0', field: 'temperature', fingerprint: 'a'.repeat(64), state: 'committed', measurementId: measurementDocumentId(key), committedAt: new Date() };
        let preCheck: string, majorityRead: string, localRead: string;
        for (const s of sec) chaos(request, 'pause', s);
        try {
          await claims.insertOne(claimDoc as never, { writeConcern: { w: 1 } });                              // exists on the primary only
          localRead = (await claims.findOne({ _id: claimId as never }, { maxTimeMS: 3000 })) ? 'visible' : 'absent';
          majorityRead = (await claims.findOne({ _id: claimId as never }, { readConcern: { level: 'majority' }, maxTimeMS: 3000 } as never).then(d => d ? 'visible' : 'absent').catch(e => 'error:' + (e as Error).name));
          preCheck = await bounded(store.lookup(key), 6000).then(r => (r as { status: string }).status).catch(e => 'error:' + (e as Error).message.slice(0, 40));
        } finally { for (const s of sec) chaos(request, 'unpause', s); }
        await waitHealthy();
        const after = await claims.findOne({ _id: claimId as never }, { readConcern: { level: 'majority' }, maxTimeMS: 5000 } as never).then(d => d ? 'survived' : 'rolled-back').catch(() => 'unreadable');
        await claims.deleteOne({ _id: claimId as never }, { writeConcern: { w: 'majority' } }).catch(() => {});
        assert.notEqual(preCheck, 'present', 'the pre-check answered "present" for a claim that no majority holds: ' + JSON.stringify({ localRead, majorityRead, preCheck, after }));
        return { localRead, majorityRead, preCheck, claimAfterHeal: after };
      });
      await scenario('D13', 'durable: broker restart + MONGO without majority (4 s, below the election timeout): the consumer cannot persist, does not ACK, the broker keeps the messages; after healing everything is processed', async () => {
        const mark = (m: string) => console.log('  [D13] ' + m); mark('start'); const first = await consumerOpen(); await deepSnapshot('S0', { sessionPresent: first.sessionPresent }); await first.close(true); await sleep(300);
        const sent = ids('d13', 60), p = await publish(sent, { window: 8 }); mark('publisher done, restarting broker'); await L().restart(); await sleep(1500); mark('broker back');
        await waitHealthy(); const pr = await primaryIndex(), sec = [0, 1, 2].filter(i => i !== pr);
        const mk = async () => { const c = await startConsumerRetrying({ conn: conns[2]!, brokerUrl: L().brokerUrl, password: L().secrets['lab-consumer']!, metricsSink: metrics, clientId: consumerId(), clean: false, durableSession: true, sessionExpirySeconds: 3600, ...(i11.on ? { timings: i11.d13Timings } : {}), ...i11Tap('d13') }); live.add(c); return c; };
        const termBefore = ((await status()) as { term?: number }).term; mark('mongo secondaries paused'); for (const s of sec) chaos(request, 'pause', s);
        let during = 0, unreadable = false;
        let started: Promise<LabConsumer | null> | null = null;
        // the pause lasts EXACTLY 4000 ms: the consumer is started in the background and every read is bounded (a blocked driver call must not stretch the outage)
        try { started = mk().catch(() => null); await sleep(4000); during = await bounded(mCountTag('d13'), 3000).catch(() => { unreadable = true; return 0; }); } finally { for (const s of sec) chaos(request, 'unpause', s); mark('unpaused'); }
        { const c = await started; if (c) { await c.stop().catch(() => {}); live.delete(c); } }
        await waitHealthy(); const termAfter0 = ((await status()) as { term?: number }).term; void termAfter0; const termAfter = ((await status()) as { term?: number }).term; assert.equal(during, 0, 'nothing was processed without a Mongo majority');
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
        const quarantineTotal = await quarantineRows.countDocuments({}), quarantineSample = (await quarantineRows.find({}).limit(2).toArray()).map(d => JSON.stringify(d).slice(0, 420)), measurementsTotal = await measurements.countDocuments({}), measurementsD13Local = await measurements.countDocuments({ eventId: { $regex: '^e11f-d13-' } }), metricTally = Object.entries(metrics.slice(mStart).reduce((a: Record<string, number>, x) => { const l = x.labels as Record<string, string>; const k = x.name + '|' + (l.outcome ?? '') + '|' + (l.reasonCode ?? ''); a[k] = (a[k] ?? 0) + 1; return a; }, {})).slice(0, 14), claimsD13 = await db.collection(inn.idempotency).countDocuments({ eventId: { $regex: '^e11f-d13-' } }), measurementsD13Nested = await measurements.countDocuments({ 'event.eventId': { $regex: '^e11f-d13-' } }), claimsTotal = await db.collection(inn.idempotency).countDocuments({}), claimSample = (await db.collection(inn.idempotency).find({}).sort({ _id: -1 }).limit(2).toArray()).map(d => JSON.stringify(d).slice(0, 600)), measurementSample = (await measurements.find({}).sort({ _id: -1 }).limit(2).toArray()).map(d => JSON.stringify(d).slice(0, 600)), d13Sample: string[] = [];
        const stateCounts = await stateRows.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray();
        mark('reconcile done'); const m = await mCountTag('d13'), q = await quarantineRows.countDocuments({ eventId: { $regex: '^e11f-d13-' } }), inboxN = await inboxRows.countDocuments({});
        if (i11.on) { const tm = [...i11.d13Timings.entries()].filter(([k]) => sent.includes(k)); i11.d13 = { published: sent.length, publisherPuback: p.acked.size, delivered: tm.filter(([, v]) => v.deliveries > 0).length, receipts: tm.filter(([, v]) => v.persisted !== undefined).length, consumerAcks: tm.filter(([, v]) => v.acked !== undefined).length, measurements: m, quarantined: q, supervisorRestarts: attempts }; }
        await c.stop(); live.delete(c);
        noLoss({ lostAfterPuback: Math.max(0, p.acked.size - m - q), acked: p.acked.size });
        return { acked: p.acked.size, processedWhileMongoDown: unreadable ? 'unreadable-without-majority (nothing could be committed either)' : during, measurementsAfterHealing: m, quarantined: q, inboxRecords: inboxN, supervisorRestarts: attempts, withheldDeliveries: withheld, stateCounts, quarantineTotal, quarantineSample, measurementsTotal, measurementsD13Local, metricTally, mongoTermBefore: termBefore, mongoTermAfter: termAfter, claimsD13, measurementsD13Nested, claimsTotal, claimSample, measurementSample, reconcileSamples: recon.slice(0, 2), lostAfterPuback: Math.max(0, p.acked.size - m - q) };
      });
      await scenario('D13b', 'durable: broker restart + MONGO without majority for 14 s (beyond the election timeout: primary steps down, an election happens): the consumer cannot persist, does not ACK, the broker keeps the messages; after healing everything is processed', async () => {
        const mark = (m: string) => console.log('  [D13b] ' + m); mark('start'); const first = await consumerOpen(); const snapshotBefore = await sessionSnapshot(first); await deepSnapshot('S1', { sessionPresent: first.sessionPresent }); await first.close(true); await sleep(300);
        // BE13-11G knobs (TEST_ONLY): BE13_11G_N events, BE13_11G_PAUSE_MS outage length (0 = healthy control).
        const N = Number(process.env.BE13_11G_N ?? 60), pauseMs = Number(process.env.BE13_11G_PAUSE_MS ?? 14000), t0 = performance.now(), rel = () => Math.round(performance.now() - t0);
        const timings: TimingMap = new Map(); const tl: Record<string, unknown>[] = [];
        const snap = async (e: string) => { try { const st = (await bounded(db.admin().command({ replSetGetStatus: 1 }, { readPreference: 'nearest' }), 4000)) as { term?: number; optimes?: { lastCommittedOpTime?: { ts?: { toString(): string }; t?: number } }; members: { name: string; stateStr: string }[] }; tl.push({ t: rel(), e, term: st.term, commitTs: String(st.optimes?.lastCommittedOpTime?.ts), commitTerm: st.optimes?.lastCommittedOpTime?.t, members: st.members.map(m => m.name.split(':')[1] + ':' + m.stateStr).join(',') }); } catch { tl.push({ t: rel(), e, unreadable: true }); } };
        const sent = ids('d13b', N); const j11n = process.env.BE13_11N_TAG ? await startOutboxPublisher(sent) : null; const j14 = process.env.BE14_01_TAG ? await startRefPublisher(sent) : null;
        const p = j14 ? j14.initial : j11n ? j11n.initial : await publish(sent, { window: 8 }); mark('publisher done, restarting broker'); await L().restart(); await sleep(1500); mark('broker back'); await deepSnapshot('S2', { note: 'after the broker restart, consumer NOT yet reconnected' });
        await waitHealthy(); const pr = await primaryIndex(), sec = [0, 1, 2].filter(i => i !== pr);
        const staleIds = ids('d13', 60); let s3p: Promise<unknown> | null = null, s4p: Promise<unknown> | null = null;
        const tap = i11.on ? { packetScenario: 'd13b', packetSink: (r: PacketRecord & { cmd: string; sessionPresent?: boolean }) => { i11.packets.push(r); if (r.cmd === 'connack' && !s3p) s3p = deepSnapshot('S3', { connackSessionPresent: r.sessionPresent ?? null, note: 'first CONNACK of D13b consumer, snapshot requested right after it (deliveries may already be in flight)' }); } } : {};
        const mk = async () => { const c = await startConsumerRetrying({ conn: conns[2]!, brokerUrl: L().brokerUrl, password: L().secrets['lab-consumer']!, metricsSink: metrics, clientId: consumerId(), clean: false, durableSession: true, sessionExpirySeconds: 3600, timings, ...tap }); live.add(c); return c; };
        // S4 = the instant every one of the 60 stale D13 events has had its ACK released
        const watcher = i11.on ? setInterval(() => { if (!s4p && staleIds.every(id => timings.get(id)?.acked !== undefined)) s4p = deepSnapshot('S4', { note: 'all 60 stale D13 events ACK-released' }); }, 150) : null;
        const ownStats = () => { const own = new Set(sent), ts = [...timings.entries()]; return { ownDelivered: sent.filter(id => (timings.get(id)?.deliveries ?? 0) > 0).length, ownReceipts: sent.filter(id => timings.get(id)?.persisted !== undefined).length, ownAcks: sent.filter(id => timings.get(id)?.acked !== undefined).length, staleDelivered: ts.filter(([k]) => !own.has(k)).length, staleAcked: staleIds.filter(id => timings.get(id)?.acked !== undefined).length }; };
        const termBefore = ((await status()) as { term?: number }).term; await snap('before-pause'); tl.push({ t: rel(), e: 'pause', nodes: sec, primary: pr }); mark('mongo secondaries paused'); if (pauseMs > 0) for (const s of sec) chaos(request, 'pause', s);
        let during = 0, unreadable = false;
        let started: Promise<LabConsumer | null> | null = null;
        // the pause lasts EXACTLY 14000 ms: the consumer is started in the background and every read is bounded (a blocked driver call must not stretch the outage)
        try { started = mk().catch(() => null); await sleep(pauseMs); during = await bounded(mCountTag('d13b'), 3000).catch(() => { unreadable = true; return 0; }); } finally { if (pauseMs > 0) for (const s of sec) chaos(request, 'unpause', s); tl.push({ t: rel(), e: 'unpause' }); mark('unpaused'); }
        { const c = await started; if (c) { await c.stop().catch(() => {}); live.delete(c); } }
        await waitHealthy(); await snap('healed'); const termAfter = ((await status()) as { term?: number }).term; assert.equal(during, 0, 'nothing was processed without a Mongo majority');
        // A consumer that withholds an ACK drops its connection (the adapter never reconnects by itself): a supervisor restarts it, as in 11E.
        const withheld0 = metrics.filter(x => x.name === 'broker_adapter_delivery_total' && (x.labels as { outcome?: string }).outcome === 'withheld').length; let attempts = 0;
        const accounted = async () => (await mCountTag('d13b')) + (await quarantineRows.countDocuments({ eventId: { $regex: '^e11f-d13b-' } }));
        mark('healthy again'); const mStart = metrics.length; let c = await mk();
        for (; attempts < 4 && (await accounted()) < p.acked.size; attempts += 1) {
          await waitFor('d13-accounted', async () => (await accounted()) >= p.acked.size, 15000).catch(() => {});
          if ((await accounted()) >= p.acked.size) break;
          await c.stop().catch(() => {}); live.delete(c); await sleep(1500); c = await mk();
        }
        mark('supervisor done after ' + attempts); const withheld = metrics.filter(x => x.name === 'broker_adapter_delivery_total' && (x.labels as { outcome?: string }).outcome === 'withheld').length - withheld0;
        await sleep(2000); await c.idle();
        const originalWindow = { ...ownStats(), atMs: rel(), supervisorRestarts: attempts }; let extension: Record<string, unknown> | null = null;
        // BE13-11I R2: ONLY the observation is extended (same consumer, same session, same supervisor policy: a dropped connection is restarted). Nothing about the broker or the adapter changes.
        const extendMs = Number(process.env.BE13_11I_EXTEND_MS ?? 0);
        if (extendMs > 0) {
          const tStart = performance.now(); let restarts = 0, timedOut = false; mark('extended window start (' + extendMs + ' ms)');
          for (;;) {
            if (ownStats().ownDelivered >= N && (await accounted()) >= p.acked.size) break;
            if (performance.now() - tStart > extendMs) { timedOut = true; break; }
            await sleep(2000);
            const st = await L().api('GET', '/clients/' + consumerId()).catch(() => null); let connected: boolean | null = null; try { connected = (JSON.parse(st?.body ?? '{}') as { connected?: boolean }).connected ?? null; } catch { /* */ }
            if (st && (st.status === 404 || connected === false)) { await c.stop().catch(() => {}); live.delete(c); await sleep(1500); c = await mk(); restarts += 1; }
          }
          await sleep(2000); await c.idle(); extension = { extendMs, elapsedMs: Math.round(performance.now() - tStart), supervisorRestartsInExtension: restarts, timedOut, ...ownStats() }; mark('extended window end ' + JSON.stringify(extension));
        }
        // BE14-01: the reference publisher resumes against the REAL backend pieces (router + service + Mongo evidence), with a backend restart and a publisher restart in the middle.
        if (j14) {
          mark('14-01 reference publisher reconciliation start'); const n0 = performance.now();
          const evidence = createMongoIngestConfirmationEvidence({ connection: conns[3]!, prefix: INGEST, realm: 'test' }), svc = createIngestConfirmationService({ evidence });
          const authority = { kind: 'TEST_ONLY' as const, authenticate: async (req: { get(h: string): string | undefined }) => req.get('x-principal') ?? null, scopeOf: async (pr: string) => { const m = LAB_PRINCIPALS[pr]; return m ? { realm: 'test' as const, sourceId: m.sourceId, principalReference: pr } : null; } };
          const limiter = createTokenBucketRateLimiter({ mode: 'TEST_ONLY', perPrincipalRatePerSecond: 200, perPrincipalBurst: 400, globalRatePerSecond: 1000, globalBurst: 2000, maxKeys: 100 });
          const app = express(); app.use(createIngestConfirmationRouter({ mode: 'TEST_ONLY', service: svc, authority: authority as never, rateLimiter: limiter }));
          let server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = (server.address() as { port: number }).port; refBase = 'http://127.0.0.1:' + port;
          let keep = true; const keeper = (async () => { while (keep) { await sleep(3000); const st = await L().api('GET', '/clients/' + consumerId()).catch(() => null); let cn: boolean | null = null; try { cn = (JSON.parse(st?.body ?? '{}') as { connected?: boolean }).connected ?? null; } catch { /* */ } if (keep && st && (st.status === 404 || cn === false)) { await c.stop().catch(() => {}); live.delete(c); await sleep(1500); c = await mk(); } } })();
          const before = j14.holder.pub.entries(); j14.holder.pub.setGate(true); let busy = false; const tickLoop = () => setInterval(() => { if (busy) return; busy = true; void j14.holder.pub.tick(8).finally(() => { busy = false; }); }, 400);
          let ticker = tickLoop(); const events: Record<string, unknown>[] = []; let countersBeforeCrash: Record<string, number> = {};
          // (1) the reconciliation API goes DOWN for 6 s (backend restart): the publisher must neither confirm nor lose anything
          await sleep(3000); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); events.push({ at: 'backend-down' }); await sleep(6000); server = app.listen(port, '127.0.0.1'); await once(server, 'listening'); events.push({ at: 'backend-up' });
          // (2) the PUBLISHER crashes/restarts: in-memory engine + MQTT connection dropped; a new engine is rebuilt ONLY from the file
          await sleep(2000); clearInterval(ticker); while (busy) await sleep(100); const pre = j14.holder.pub.entries(); countersBeforeCrash = j14.holder.pub.counters(); await j14.mqttPort.close(); j14.holder.pub = j14.make(); const post = j14.holder.pub.entries();
          const crashInfo = { entriesBefore: pre.length, entriesAfter: post.length, identical: JSON.stringify(pre.map(e => [e.eventId, e.payloadSha256, e.publishAttempts, e.state, e.lane])) === JSON.stringify(post.map(e => [e.eventId, e.payloadSha256, e.publishAttempts, e.state, e.lane])), restartRecovered: j14.holder.pub.counters().publisher_restart_recovered };
          ticker = tickLoop(); const deadline = Date.now() + 240000; const open = () => j14.holder.pub.stats().outbox_depth;
          while (Date.now() < deadline && open() > 0) await sleep(1000);
          // (3) NORMAL path: 10 new readings on a healthy system (first query, no retry expected)
          const normalIds: string[] = []; for (let i = 0; i < 10; i += 1) { const r = j14.holder.pub.submitReading({ eventId: 'e14-normal-' + i, payload: { temperature: 5000 + i }, topic: 'agro/lab/in/a', dataOrigin: 'simulated' }); assert.equal(r.result, 'ACCEPTED'); normalIds.push('e14-normal-' + i); }
          const nDeadline = Date.now() + 60000; while (Date.now() < nDeadline && open() > 0) await sleep(1000);
          // (4) CONFLICT: a firmware that lost its outbox reuses an eventId with DIFFERENT bytes (same identity, same connection)
          const rogue = createReferencePublisher({ store: createRefMemoryStore(), policy: j14.policy, technicalKey: 'lab-device-a', mqtt: j14.mqttPort, reconciliation: { query: (eid, h) => refClient().query(eid, h) } });
          const conflictId = sent[5]!; rogue.submitReading({ eventId: conflictId, payload: { temperature: 99999 }, topic: 'agro/lab/in/a', dataOrigin: 'simulated' });
          const cDeadline = Date.now() + 40000; const tickRogue = setInterval(() => { void rogue.tick(1); }, 400); while (Date.now() < cDeadline && rogue.stats().outbox_depth > 0) await sleep(1000); clearInterval(tickRogue);
          clearInterval(ticker); while (busy) await sleep(100); await sleep(1500); await c.idle(); keep = false; await keeper;
          const finalEntries = j14.holder.pub.entries(), rogueEntry = rogue.get(conflictId)!, counters = j14.holder.pub.counters(); const byState = j14.holder.pub.stats().byState;
          const probe = finalEntries.find(e => e.state === 'CONFIRMED')!; const cross = await refClient('emqx-user:lab-device-b').query(probe.eventId, probe.payloadSha256), own = await refClient().query(probe.eventId, probe.payloadSha256);
          const perEvent = await measurements.aggregate([{ $match: { $or: [{ 'event.eventId': { $regex: '^e11f-d13b-' } }, { 'event.eventId': { $regex: '^e14-normal-' } }] } }, { $group: { _id: '$event.eventId', n: { $sum: 1 } } }]).toArray(); const nByEvent = new Map(perEvent.map(d => [String(d._id), Number(d.n)]));
          const claimsNow = new Set((await db.collection(inn.idempotency).find({ $or: [{ eventId: { $regex: '^e11f-d13b-' } }, { eventId: { $regex: '^e14-normal-' } }] }).toArray()).map(d => String(d.eventId)));
          const inboxNow = new Set<string>(); for (const d of await inboxRows.find({}, { projection: { eventId: 1, rawPayloadSha256: 1 } }).toArray()) { const e = (d as { eventId?: string }).eventId, h = (d as { rawPayloadSha256?: string }).rawPayloadSha256; const m = finalEntries.find(x => x.eventId === e); if (e && m && m.payloadSha256 === h) inboxNow.add(e); }
          const confirmedNoEvidence = finalEntries.filter(e => e.state === 'CONFIRMED' && !claimsNow.has(e.eventId) && !inboxNow.has(e.eventId)).map(e => e.eventId);
          const normal = finalEntries.filter(e => normalIds.includes(e.eventId)), fe2 = finalEntries.filter(e => sent.includes(e.eventId));
          const total = (k: string) => (counters as Record<string, number>)[k]! + (countersBeforeCrash[k] ?? 0);
          const summary14 = { totalEvents: sent.length + normalIds.length + 1, f_e2_events: sent.length, normal_events: normalIds.length, submitted: j14.submitted.reduce((a: Record<string, number>, r) => { a[r] = (a[r] ?? 0) + 1; return a; }, {}), originalPubackedFirstPass: p.acked.size, byState, f_e2: { confirmed: fe2.filter(e => e.state === 'CONFIRMED').length, retried: fe2.filter(e => e.publishAttempts > 1).length, states: fe2.reduce((a: Record<string, number>, e) => { a[e.state] = (a[e.state] ?? 0) + 1; return a; }, {}) },
            normal: { confirmed: normal.filter(e => e.state === 'CONFIRMED').length, firstTryConfirmed: normal.filter(e => e.state === 'CONFIRMED' && e.publishAttempts === 1).length }, conflict: { eventId: conflictId, state: rogueEntry.state, republished: rogueEntry.publishAttempts, measurementsForEvent: nByEvent.get(conflictId) ?? 0 },
            counters: Object.fromEntries(Object.keys(counters).map(k => [k, total(k)])), brokerAcceptedAnyNotConfirmed: finalEntries.filter(e => e.brokerAcceptedCount > 0 && e.state !== 'CONFIRMED').length, confirmedWithoutBackendEvidence: confirmedNoEvidence,
            measurementsDistinctEvents: nByEvent.size, eventsWithMoreThanOneMeasurement: [...nByEvent.values()].filter(n => n > 1).length, publisherCrash: crashInfo, backendRestart: events, mqttConnectionsOpenNow: j14.mqttPort.connectionsOpen,
            crossTenantProbe: { eventId: probe.eventId, askedByB: cross, askedByOwner: own }, elapsedMs: Math.round(performance.now() - n0) };
          writeFileSync('.local-evidence/be14-01-' + process.env.BE14_01_TAG!.replace(/[^\w.-]/g, '_') + '.json', JSON.stringify({ label: 'LOCAL_LAB_EVIDENCE', tag: process.env.BE14_01_TAG, summary: summary14, originalWindow, before: before.map(e => ({ eventId: e.eventId, publishAttempts: e.publishAttempts, brokerAcceptedCount: e.brokerAcceptedCount })), entries: finalEntries.map(e => ({ ...e, payloadB64: undefined })) }, null, 1));
          server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await j14.mqttPort.close(); mark('14-01 done ' + JSON.stringify({ byState, f_e2: summary14.f_e2, normal: summary14.normal, conflict: summary14.conflict }));
          assert.equal(confirmedNoEvidence.length, 0, 'no entry CONFIRMED without backend evidence'); assert.equal(summary14.eventsWithMoreThanOneMeasurement, 0, 'no duplicate measurement'); assert.equal(crashInfo.identical, true, 'outbox rebuilt from disk is identical');
          assert.equal(rogueEntry.state, 'CONFLICT_REQUIRES_REVIEW', 'same eventId + different bytes => conflict'); assert.equal(rogueEntry.publishAttempts, 1, 'a conflict is never republished'); assert.equal(cross.kind === 'status' && cross.status, 'not-found', 'cross-tenant probe sees nothing');
          assert.equal(fe2.length, sent.length, 'every F-E2 event is in the outbox'); assert.ok(finalEntries.every(e => ['CONFIRMED', 'QUARANTINED', 'CONFLICT_REQUIRES_REVIEW', 'UNCONFIRMED_EXPLICIT'].includes(e.state) || e.lane === 'slow' || e.state !== 'CONFIRMED'), 'accounted'); assert.ok(summary14.mqttConnectionsOpenNow <= 1);
        }
        // BE13-11N: the durable publisher resumes. Confirmation = the real TEST_ONLY router over the real Mongo evidence; the PUBACKs it already holds are only BROKER_ACCEPTED.
        if (j11n) {
          mark('11N publisher reconciliation start'); const n0 = performance.now();
          const evidence = createMongoIngestConfirmationEvidence({ connection: conns[3]!, prefix: INGEST, realm: 'test' }), svc = createIngestConfirmationService({ evidence });
          const authority = { kind: 'TEST_ONLY' as const, authenticate: async (req: { get(h: string): string | undefined }) => req.get('x-principal') ?? null, scopeOf: async (pr: string) => { const m = LAB_PRINCIPALS[pr]; return m ? { realm: 'test' as const, sourceId: m.sourceId, principalReference: pr } : null; } };
          // campaign-local limits (NOT the 11K proposal): the campaign polls up to 60 events from one principal
          const limiter = createTokenBucketRateLimiter({ mode: 'TEST_ONLY', perPrincipalRatePerSecond: 200, perPrincipalBurst: 400, globalRatePerSecond: 1000, globalBurst: 2000, maxKeys: 100 });
          const app = express(); app.use(createIngestConfirmationRouter({ mode: 'TEST_ONLY', service: svc, authority: authority as never, rateLimiter: limiter }));
          const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
          const ask = async (id: string, hash: string, principal = 'emqx-user:lab-device-a') => { const r = await fetch(base + '/ingest-confirmations/' + id + '?payloadSha256=' + hash, { headers: { 'x-principal': principal }, signal: AbortSignal.timeout(8000) }); return r.status === 200 ? { ok: true as const, status: ((await r.json()) as { status: string }).status } : { ok: false as const }; };
          confirmVia = (eid, h) => ask(eid, h);
          let keep = true; const keeper = (async () => { while (keep) { await sleep(3000); const st = await L().api('GET', '/clients/' + consumerId()).catch(() => null); let cn: boolean | null = null; try { cn = (JSON.parse(st?.body ?? '{}') as { connected?: boolean }).connected ?? null; } catch { /* */ } if (keep && st && (st.status === 404 || cn === false)) { await c.stop().catch(() => {}); live.delete(c); await sleep(1500); c = await mk(); } } })();
          const before = j11n.pub.entries(); j11n.pub.setGate(true);
          let busy = false, crashed: Record<string, unknown> | null = null; const startedAt = Date.now();
          const ticker = setInterval(() => { if (busy) return; busy = true; void j11n.pub.tick(8).finally(() => { busy = false; }); }, 400);
          // simulated publisher CRASH/RESTART ~8 s into the reconciliation: the in-memory publisher and its connection are dropped; a new instance is rebuilt ONLY from the file
          await sleep(8000); clearInterval(ticker); while (busy) await sleep(100); const pre = j11n.pub.entries(); await closePub(); const post = j11n.rebuild().entries();
          crashed = { entriesBefore: pre.length, entriesAfter: post.length, identical: JSON.stringify(pre.map(e => [e.eventId, e.payloadSha256, e.attempts, e.status, e.lane, e.phase])) === JSON.stringify(post.map(e => [e.eventId, e.payloadSha256, e.attempts, e.status, e.lane, e.phase])), connectionsOpenedSoFar: pubStats.opens };
          const ticker2 = setInterval(() => { if (busy) return; busy = true; void j11n.pub.tick(8).finally(() => { busy = false; }); }, 400);
          const deadline = Date.now() + 240000;
          while (Date.now() < deadline && j11n.pub.stats().pending > 0) await sleep(1000);
          clearInterval(ticker2); while (busy) await sleep(100); await sleep(1500); await c.idle(); keep = false; await keeper;
          const finalEntries = j11n.pub.entries(), stats = j11n.pub.stats();
          const probeId = finalEntries.find(e => e.status === 'CONFIRMED')?.eventId ?? sent[0]!; const probeHash = sha256Hex(eventBody(probeId, 0)), cross = await ask(probeId, probeHash, 'emqx-user:lab-device-b'), own = await ask(probeId, probeHash);
          const perEvent = await measurements.aggregate([{ $match: { 'event.eventId': { $regex: '^e11f-d13b-' } } }, { $group: { _id: '$event.eventId', n: { $sum: 1 } } }]).toArray(); const nByEvent = new Map(perEvent.map(d => [String(d._id), Number(d.n)]));
          const claimsNow = new Set((await db.collection(inn.idempotency).find({ eventId: { $regex: '^e11f-d13b-' } }).toArray()).map(d => String(d.eventId)));
          const inboxNow = new Set<string>(); for (const d of await inboxRows.find({}, { projection: { eventId: 1, rawPayloadSha256: 1 } }).toArray()) { const e = (d as { eventId?: string }).eventId; if (e && e.startsWith('e11f-d13b-') && (d as { rawPayloadSha256?: string }).rawPayloadSha256 === sha256Hex(eventBody(e, 0))) inboxNow.add(e); }
          const byStatus = stats.byStatus, confirmedNoEvidence = finalEntries.filter(e => e.status === 'CONFIRMED' && !claimsNow.has(e.eventId) && !inboxNow.has(e.eventId)).map(e => e.eventId);
          const pubackNotConfirmed = finalEntries.filter(e => e.brokerAcceptedCount > 0 && e.status !== 'CONFIRMED').length;
          const summary11n = { events: sent.length, submitted: j11n.submitted.reduce((a: Record<string, number>, r) => { a[r] = (a[r] ?? 0) + 1; return a; }, {}), originalPubackedFirstPass: p.acked.size, byStatus, stillPending: stats.pending, pendingInSlowLane: stats.slow, unconfirmedAlertRaised: finalEntries.filter(e => e.unconfirmedSince !== null).length,
            retried: finalEntries.filter(e => e.attempts > 1).length, totalPublishAttempts: finalEntries.reduce((a, e) => a + e.attempts, 0), brokerAcceptedAnyButNotConfirmed: pubackNotConfirmed, confirmedWithoutBackendEvidence: confirmedNoEvidence,
            measurementsDistinctEvents: nByEvent.size, eventsWithMoreThanOneMeasurement: [...nByEvent.values()].filter(n => n > 1).length, publisherConnectionsOpened: pubStats.opens, publisherMaxConcurrentConnections: pubStats.maxConcurrent, crashRestart: crashed,
            crossTenantProbe: { eventId: probeId, askedByB: cross, askedByOwner: own }, policy: j11n.policy, elapsedMs: Math.round(performance.now() - n0), startedAt };
          writeFileSync('.local-evidence/be13-11n-' + process.env.BE13_11N_TAG!.replace(/[^\w.-]/g, '_') + '.json', JSON.stringify({ label: 'LOCAL_LAB_EVIDENCE', tag: process.env.BE13_11N_TAG, summary: summary11n, originalWindow, before: before.map(e => ({ eventId: e.eventId, attempts: e.attempts, brokerAcceptedCount: e.brokerAcceptedCount })), entries: finalEntries.map(e => ({ ...e, payloadB64: undefined })) }, null, 1));
          server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await closePub(); mark('11N publisher reconciliation done ' + JSON.stringify({ byStatus, stillPending: stats.pending, retried: summary11n.retried }));
          assert.equal(pubStats.maxConcurrent <= 1, true, 'one publisher identity = at most ONE connection at a time'); assert.equal(confirmedNoEvidence.length, 0, 'no entry was CONFIRMED without backend evidence'); assert.equal(summary11n.eventsWithMoreThanOneMeasurement, 0, 'a retried eventId never produced a second measurement');
          assert.equal((crashed as { identical: boolean }).identical, true, 'the outbox rebuilt from disk is identical to the in-memory one'); assert.equal(cross.ok && cross.status, 'not-found', 'cross-tenant probe must not see the event');
          assert.equal(Object.values(byStatus).reduce((a, b) => a + b, 0), sent.length, 'every event is accounted for in an explicit outbox state');
        }
        // BE13-11J (TEST_ONLY, only with BE13_11J_TAG): the publisher does NOT trust the PUBACK it already holds for every event. It asks the backend
        // (real HTTP router over the real Mongo evidence) and re-publishes the SAME eventId until it has backend evidence, quarantine, or the budget ends.
        if (process.env.BE13_11J_TAG) {
          mark('11J reconciliation start'); const j0 = performance.now();
          const policy: PublisherRetryPolicy = { mode: 'TEST_ONLY', initialDelayMs: 2000, maxAttempts: 4, backoffFactor: 1.5, maxDelayMs: 6000, maxElapsedMs: 60000 };
          const svc = createIngestConfirmationService({ evidence: createMongoIngestConfirmationEvidence({ connection: conns[3]!, prefix: INGEST, realm: 'test' }) });
          const authority = { authenticate: async (req: { get(h: string): string | undefined }) => req.get('x-principal') ?? null, scopeOf: async (pr: string) => { const m = LAB_PRINCIPALS[pr]; return m ? { realm: 'test' as const, sourceId: m.sourceId } : null; } };
          const app = express(); app.use(createIngestConfirmationRouter({ mode: 'TEST_ONLY', service: svc, authority: authority as never, rateLimiter: createTokenBucketRateLimiter(PROPOSED_TEST_RATE_LIMIT) }));
          const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
          const ask = async (id: string, principal = 'emqx-user:lab-device-a') => { const r = await fetch(base + '/ingest-confirmations/' + id + '?payloadSha256=' + createHash('sha256').update(eventBody(id, 0)).digest('hex'), { headers: { 'x-principal': principal }, signal: AbortSignal.timeout(8000) }); return r.status === 200 ? { ok: true as const, status: ((await r.json()) as { status: string }).status } : { ok: false as const }; };
          // keep the consumer connected while the publisher retries (same supervisor policy as the original window)
          let keep = true; const keeper = (async () => { while (keep) { await sleep(3000); const st = await L().api('GET', '/clients/' + consumerId()).catch(() => null); let cn: boolean | null = null; try { cn = (JSON.parse(st?.body ?? '{}') as { connected?: boolean }).connected ?? null; } catch { /* */ } if (keep && st && (st.status === 404 || cn === false)) { await c.stop().catch(() => {}); live.delete(c); await sleep(1500); c = await mk(); } } })();
          const results: ReconcileResult[] = []; let nextIdx = 0, republished = 0;
          const worker = async () => { for (;;) { const i = nextIdx++; if (i >= sent.length) return; const id = sent[i]!;
            results.push(await reconcilePublish(id, policy, { sleep, now: () => Date.now(), confirm: eid => ask(eid),
              // attempt 1 IS the original publish (already PUBACKed before the broker restart): the publisher keeps that PUBACK as BROKER_ACCEPTED only
              publish: async (eid, attempt) => { if (attempt === 1) return p.acked.has(eid); republished += 1; const r = await publish([eid], { window: 1 }); return r.acked.has(eid); } })); } };
          await Promise.all(Array.from({ length: 20 }, worker)); await sleep(2500); await c.idle(); keep = false; await keeper;
          // cross-tenant probe: device B asks about a confirmed event of device A
          const probeId = results.find(r => r.outcome === 'CONFIRMED')?.eventId ?? sent[0]!; const cross = await ask(probeId, 'emqx-user:lab-device-b'), own = await ask(probeId);
          const perEvent = await measurements.aggregate([{ $match: { 'event.eventId': { $regex: '^e11f-d13b-' } } }, { $group: { _id: '$event.eventId', n: { $sum: 1 } } }]).toArray();
          const nByEvent = new Map(perEvent.map(d => [String(d._id), Number(d.n)])), claimsNow = new Set((await db.collection(inn.idempotency).find({ eventId: { $regex: '^e11f-d13b-' } }).toArray()).map(d => String(d.eventId)));
          const outcomes = { CONFIRMED: 0, QUARANTINED: 0, UNCONFIRMED_EXPLICIT: 0 } as Record<string, number>; for (const r of results) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
          const byStatus = results.reduce((a: Record<string, number>, r) => { a[r.finalConfirmation] = (a[r.finalConfirmation] ?? 0) + 1; return a; }, {});
          const dupMeasurements = [...nByEvent.values()].filter(n => n > 1).length, confirmedWithoutEvidence = results.filter(r => r.outcome === 'CONFIRMED' && !claimsNow.has(r.eventId) && r.finalConfirmation === 'processed').length;
          const summary11j = { publisherPuback: p.acked.size, reconciled: results.length, outcomes, finalStatusCounts: byStatus, retried: results.filter(r => r.attempts > 1).length, republishedPublishes: republished, brokerAcceptedAny: results.filter(r => r.brokerAcceptedAny).length,
            confirmedAfterRetry: results.filter(r => r.outcome === 'CONFIRMED' && r.attempts > 1).length, unconfirmed: results.filter(r => r.outcome === 'UNCONFIRMED_EXPLICIT').map(r => r.eventId), measurementsDistinctEvents: nByEvent.size, measurementsTotalD13b: [...nByEvent.values()].reduce((a, b) => a + b, 0), eventsWithMoreThanOneMeasurement: dupMeasurements,
            confirmedProcessedWithoutClaim: confirmedWithoutEvidence, crossTenantProbe: { eventId: probeId, askedByB: cross, askedByOwner: own }, policy, elapsedMs: Math.round(performance.now() - j0) };
          writeFileSync('.local-evidence/be13-11j-' + process.env.BE13_11J_TAG.replace(/[^\w.-]/g, '_') + '.json', JSON.stringify({ label: 'LOCAL_LAB_EVIDENCE', tag: process.env.BE13_11J_TAG, summary: summary11j, originalWindow, results }, null, 1));
          server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); mark('11J reconciliation done ' + JSON.stringify({ outcomes, byStatus, retried: summary11j.retried }));
          assert.equal(results.length, sent.length, 'every PUBACKed event was reconciled'); assert.equal(outcomes.CONFIRMED! + outcomes.QUARANTINED! + outcomes.UNCONFIRMED_EXPLICIT!, sent.length, 'each event ends in exactly one explicit outcome');
          assert.equal(dupMeasurements, 0, 'a retried eventId never produced a second measurement'); assert.equal(confirmedWithoutEvidence, 0, 'no event was confirmed `processed` without a committed claim');
          assert.equal(cross.ok && cross.status, 'not-found', 'cross-tenant probe must not see the event');
        }
        // an attempt that hit the lost majority may sit RECEIPTED: the receipted recovery (TEST_ONLY policy) settles it, as in D14
        const recon: unknown[] = [];
        for (let i = 0; i < 6 && (await mCountTag('d13b')) < p.acked.size; i += 1) { await sleep(2000); const r = await c.reconciler.reconcileBrokerInbox({ mode: 'reconcile', limit: 100 }); recon.push(JSON.stringify(r).slice(0, 220)); }
        const quarantineTotal = await quarantineRows.countDocuments({}), quarantineSample = (await quarantineRows.find({}).limit(2).toArray()).map(d => JSON.stringify(d).slice(0, 420)), measurementsTotal = await measurements.countDocuments({}), measurementsD13Local = await measurements.countDocuments({ eventId: { $regex: '^e11f-d13b-' } }), metricTally = Object.entries(metrics.slice(mStart).reduce((a: Record<string, number>, x) => { const l = x.labels as Record<string, string>; const k = x.name + '|' + (l.outcome ?? '') + '|' + (l.reasonCode ?? ''); a[k] = (a[k] ?? 0) + 1; return a; }, {})).slice(0, 14), claimsD13 = await db.collection(inn.idempotency).countDocuments({ eventId: { $regex: '^e11f-d13b-' } }), measurementsD13Nested = await measurements.countDocuments({ 'event.eventId': { $regex: '^e11f-d13b-' } }), claimsTotal = await db.collection(inn.idempotency).countDocuments({}), claimSample = (await db.collection(inn.idempotency).find({}).sort({ _id: -1 }).limit(2).toArray()).map(d => JSON.stringify(d).slice(0, 600)), measurementSample = (await measurements.find({}).sort({ _id: -1 }).limit(2).toArray()).map(d => JSON.stringify(d).slice(0, 600)), d13Sample: string[] = [];
        const stateCounts = await stateRows.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray();
        mark('reconcile done'); const m = await mCountTag('d13b'), q = await quarantineRows.countDocuments({ eventId: { $regex: '^e11f-d13b-' } }), inboxN = await inboxRows.countDocuments({});
        await deepSnapshot('S5', { note: 'end of the D13b observation window, consumer still connected' }); if (watcher) clearInterval(watcher); await s3p; await s4p;
        await c.stop(); live.delete(c); await snap('end');
        const rawRows = await inboxRows.find({}).toArray(); const evOf = (d: { rawPayload?: { buffer?: Uint8Array } }) => { try { return String((JSON.parse(Buffer.from(d.rawPayload!.buffer!).toString('utf8')) as { eventId?: string }).eventId); } catch { return ''; } };
        const byEvent = new Map<string, { inboxId: string; persistedAt: unknown }[]>(); for (const d of rawRows) { const e = evOf(d as never); if (e.startsWith('e11f-d13b-')) byEvent.set(e, [...(byEvent.get(e) ?? []), { inboxId: String(d._id), persistedAt: (d as { rawPersistedAt?: unknown }).rawPersistedAt }]); }
        const stateById = new Map((await stateRows.find({}).toArray()).map(d => [String(d._id), String((d as { status?: unknown }).status) + ':' + String((d as { outcome?: unknown }).outcome ?? '')]));
        const claimSet = new Set((await db.collection(inn.idempotency).find({ eventId: { $regex: '^e11f-d13b-' } }).toArray()).map(d => String(d.eventId))), measSet = new Set((await measurements.find({ 'event.eventId': { $regex: '^e11f-d13b-' } }).toArray()).map(d => String((d as { event?: { eventId?: string } }).event?.eventId))), quarSet = new Set((await quarantineRows.find({ eventId: { $regex: '^e11f-d13b-' } }).toArray()).map(d => String(d.eventId)));
        const pauseAt = Number((tl.find(x => x.e === 'pause') ?? { t: 0 }).t), unpauseAt = Number((tl.find(x => x.e === 'unpause') ?? { t: 0 }).t);
        const matrix = sent.map(id => { const tm = timings.get(id); const rows = byEvent.get(id) ?? [];
          return { eventId: id, publisherPuback: p.acked.has(id), deliveries: tm?.deliveries ?? 0, receiptIssued: tm?.persisted !== undefined, mqttAckReleased: tm?.acked !== undefined, receiptDuringOutage: tm?.persisted !== undefined ? (tm.persisted - t0 >= pauseAt && tm.persisted - t0 <= unpauseAt) : null, inboxRowsAfterHeal: rows.length, states: rows.map(r => stateById.get(r.inboxId) ?? 'no-state'), claim: claimSet.has(id), measurement: measSet.has(id), quarantine: quarSet.has(id) }; });
        const summary = { events: N, pauseMs, publisherPuback: matrix.filter(x => x.publisherPuback).length, receiptIssued: matrix.filter(x => x.receiptIssued).length, mqttAckReleased: matrix.filter(x => x.mqttAckReleased).length, receiptDuringOutage: matrix.filter(x => x.receiptDuringOutage === true).length, withInboxRowAfterHeal: matrix.filter(x => x.inboxRowsAfterHeal > 0).length, withClaim: matrix.filter(x => x.claim).length, withMeasurement: matrix.filter(x => x.measurement).length, withQuarantine: matrix.filter(x => x.quarantine).length,
          // deliveries of events that are NOT part of this scenario = STALE redelivery of an earlier scenario's session state (the D04 family)
          neverDelivered: matrix.filter(x => x.deliveries === 0).length, staleDeliveredEvents: [...timings.keys()].filter(k => !sent.includes(k)).length, staleSample: [...timings.keys()].filter(k => !sent.includes(k)).slice(0, 3),
          staleByScenario: [...timings.keys()].filter(k => !sent.includes(k)).reduce((a: Record<string, number>, k) => { const t = k.split('-')[1] ?? '?'; a[t] = (a[t] ?? 0) + 1; return a; }, {}), deliveriesOfSent: matrix.reduce((n, x) => n + x.deliveries, 0) };
        writeFileSync('.local-evidence/be13-11g-event-matrix-' + pauseMs + '-' + N + '.json', JSON.stringify({ label: 'LOCAL_LAB_EVIDENCE', summary, timeline: tl, matrix }, null, 1));
        if (process.env.BE13_11H_TAG) writeFileSync('.local-evidence/be13-11h-' + process.env.BE13_11H_TAG.replace(/[^\w.-]/g, '_') + '.json', JSON.stringify({ label: 'LOCAL_LAB_EVIDENCE', tag: process.env.BE13_11H_TAG, only: process.env.BE13_11F_ONLY ?? null, snapshotBefore, sessionCountersAtEnd: { ...sess }, summary, timeline: tl, matrix }, null, 1));
        if (i11.on) {
          const rel0 = (t: number | null) => t === null ? null : Math.round(t - i11.t0), ownSet = new Set(sent);
          const pk = i11.packets.filter(x => x.cmd === 'publish' && x.scn === 'd13b');
          const firstPk = new Map<string, number>(); const order: string[] = []; for (const x of pk) if (!firstPk.has(x.eventId)) { firstPk.set(x.eventId, x.t); order.push(x.eventId); }
          const ackedAt = new Map<string, number>(); for (const [k, v] of timings) if (v.acked !== undefined) ackedAt.set(k, v.acked);
          const tlOut = deliveryTimeline(pk, ownSet, staleIds, ackedAt), fin = ownStats(), eventual = classifyEventualDelivery(fin.ownDelivered, N);
          const outcome = classifyOutcome({ n: N, ownDeliveredFinal: fin.ownDelivered, ownDeliveredAfterDrain: tlOut.ownDeliveredAfterStaleDrained, staleDelivered: fin.staleDelivered, staleDrained: tlOut.staleDrained, timedOut: extension ? extension.timedOut === true : false });
          const rowsBy = new Map<string, string[]>(); for (const d of rawRows) { const e = evOf(d as never); if (scenarioOfEvent(e)) rowsBy.set(e, [...(rowsBy.get(e) ?? []), stateById.get(String(d._id)) ?? 'no-state']); }
          const meas13 = new Set((await measurements.find({ 'event.eventId': { $regex: '^e11f-d13-' } }).toArray()).map(d => String((d as { event?: { eventId?: string } }).event?.eventId)));
          const row = (id: string, src: string, pub: boolean) => { const tm = timings.get(id), dups = pk.filter(x => x.eventId === id).map(x => x.dup); return { eventId: id, scenarioSource: src, publisherPuback: pub, delivered: (tm?.deliveries ?? 0) > 0, deliveryOrder: order.indexOf(id) >= 0 ? order.indexOf(id) + 1 : null, deliveryFirstAtMs: rel0(firstPk.get(id) ?? null), packetsReceived: dups.length, dupFlags: dups.length ? (dups.every(x => x === null) ? 'NO_VERIFICABLE' : dups) : null, receiptIssued: tm?.persisted !== undefined, consumerAck: tm?.acked !== undefined, duplicateResolution: (rowsBy.get(id) ?? []).join('|') || null, inboxRows: (rowsBy.get(id) ?? []).length, measurement: src === 'D13b' ? measSet.has(id) : meas13.has(id), quarantine: quarSet.has(id) }; };
          const matrix11i = [...staleIds.map(id => row(id, 'D13', true)), ...sent.map(id => row(id, 'D13b', p.acked.has(id)))].map(x => ({ ...x, finalClassification: x.scenarioSource === 'D13' ? (x.delivered ? (x.receiptIssued && x.consumerAck ? 'STALE_REDELIVERED_ACKED' : 'STALE_REDELIVERED_NOT_ACKED') : 'STALE_NOT_REDELIVERED') : (x.delivered ? (x.consumerAck ? 'OWN_DELIVERED_ACKED' : 'OWN_DELIVERED_NOT_ACKED') : 'OWN_NEVER_DELIVERED') }));
          writeFileSync('.local-evidence/be13-11i-' + process.env.BE13_11I_TAG!.replace(/[^\w.-]/g, '_') + '.json', JSON.stringify({ label: 'LOCAL_LAB_EVIDENCE', tag: process.env.BE13_11I_TAG, extendMs, d13: i11.d13, originalWindow, extension, final: fin, eventual, outcome, timeline: { ...tlOut, firstStaleAt: rel0(tlOut.firstStaleAt), lastStaleAt: rel0(tlOut.lastStaleAt), lastStaleAckAt: rel0(tlOut.lastStaleAckAt), firstOwnAt: rel0(tlOut.firstOwnAt), lastOwnAt: rel0(tlOut.lastOwnAt) },
            snapshotPoints: ['S0', 'S1', 'S2', 'S3', 'S4', 'S5'].map(pt => ({ point: pt, taken: i11.snapshots.some(x => x.point === pt) })), snapshots: i11.snapshots, packets: i11.packets.map(x => ({ ...x, t: Math.round(x.t - i11.t0) })), snapshotBefore, sessionCountersAtEnd: { ...sess }, summary, timeline11g: tl, matrix: matrix11i }, null, 1));
        }
        noLoss({ lostAfterPuback: Math.max(0, p.acked.size - m - q), acked: p.acked.size });
        // a loss here must come WITH an election (term change): any other loss is an unexpected FAIL, not the documented limitation
        if (p.acked.size - m - q > 0) assert.notEqual(termAfter, termBefore, 'loss without an election is unexplained');
        return { acked: p.acked.size, processedWhileMongoDown: unreadable ? 'unreadable-without-majority (nothing could be committed either)' : during, measurementsAfterHealing: m, quarantined: q, inboxRecords: inboxN, supervisorRestarts: attempts, withheldDeliveries: withheld, stateCounts, quarantineTotal, quarantineSample, measurementsTotal, measurementsD13Local, metricTally, mongoTermBefore: termBefore, mongoTermAfter: termAfter, claimsD13, g11Summary: summary, g11Timeline: tl, measurementsD13Nested, claimsTotal, claimSample, measurementSample, reconcileSamples: recon.slice(0, 2), lostAfterPuback: Math.max(0, p.acked.size - m - q) };
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
