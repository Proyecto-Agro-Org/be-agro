// BE14-04 — ExternalMqttObserver: sees the publisher's MQTT behaviour FROM OUTSIDE, without touching its internals. Pure core (offline testable) + observation sources.
//   * the core consumes raw observations (connect / disconnect / publish) and builds the machine-readable timeline, per-event retry/equality checks, hashing and sanitisation;
//   * the EMQX source feeds it from (a) a subscriber on the broker's verification rule (clientid, topic, qos and the EXACT bytes as base64) and (b) a management-API poller (connection state).
// It never claims what MQTT cannot show: publisher-side DUP is NOT_OBSERVABLE through the broker rule, PUBACK is only observable indirectly.
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { parseBrokerPayload } from '../../src/iot/broker-payload.parser.js';
import { loadMqttJsFactory } from '../../src/adapters/emqx-mqtt-connect.js';

export type ObserverCode = 'MQTT_OBSERVER_START_FAILED' | 'MQTT_CONNECTION_NOT_SEEN' | 'MQTT_PUBLISH_NOT_SEEN' | 'MQTT_CLIENT_ID_COLLISION' | 'MQTT_RETRY_BYTES_CHANGED' | 'MQTT_EVENT_ID_CHANGED' | 'MQTT_HASH_CHANGED' | 'MQTT_TOPIC_INVALID' | 'MQTT_TIMEOUT' | 'PAYLOAD_CONTRACT_FAIL';
export class ObserverError extends Error { constructor(readonly code: ObserverCode, message: string, readonly detail: unknown = null) { super(message); } }
export type ObservationType = 'CONNECT_SEEN' | 'DISCONNECT_SEEN' | 'RECONNECT_SEEN' | 'CONNECTION_LOST' | 'PUBLISH_SEEN' | 'DUP_PUBLISH_SEEN' | 'PAYLOAD_CONTRACT_FAIL' | 'TOPIC_INVALID_SEEN' | 'COLLISION_SUSPECTED';
export interface ObserverEvent {
  runId: string; observerEventId: number; timestamp: number; technicalIdentity: string; clientId: string | null; type: ObservationType; topic: string | null; qos: number | null;
  dup: boolean | 'NOT_OBSERVABLE' | null; eventId: string | null; payloadSha256: string | null; payloadLength: number | null;
}
export interface ObservedPublish { clientId: string; topic: string; qos: number | null; dup: boolean | null; bytes: Buffer }
export interface ObservationSink { connect(clientId: string): void; disconnect(clientId: string): void; publish(p: ObservedPublish): void }
export interface ObservationSource { start(sink: ObservationSink): Promise<void>; stop(): Promise<void>; /** true while the source is actually able to see publishes (connected AND subscribed) */ isReady?(): boolean }
const LIMITS = { maxBytes: 1 << 20, maxDepth: 8, maxKeys: 64, maxStringLength: 256 };
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export function createObserver(o: { runId: string; technicalIdentity: string; storePayloadBytes?: boolean; topicRule?: (topic: string) => boolean; now?: () => number; onPublish?: (p: ObservedPublish & { eventId: string | null; sha: string }) => void }) {
  const t0 = (o.now ?? (() => performance.now()))(), clock = () => Math.round(((o.now ?? (() => performance.now()))() - t0) * 100) / 100;
  const events: ObserverEvent[] = [], kept: { bytes: Buffer; eventId: string | null; sha: string; clientId: string; topic: string; at: number }[] = [];
  const open = new Map<string, number>(); let opens = 0, closes = 0, reconnects = 0, collisions = 0, maxConcurrent = 0, seq = 0, everConnected = false; const flaps: number[] = [];
  const topicOk = o.topicRule ?? ((t: string) => t.length >= 1 && Buffer.byteLength(t) <= 1024 && !/[\u0000+#]/.test(t));
  const push = (type: ObservationType, extra: Partial<ObserverEvent> = {}) => { const e: ObserverEvent = { runId: o.runId, observerEventId: ++seq, timestamp: clock(), technicalIdentity: o.technicalIdentity, clientId: null, type, topic: null, qos: null, dup: null, eventId: null, payloadSha256: null, payloadLength: null, ...extra }; events.push(e); return e; };
  const mine = (clientId: string) => clientId === o.technicalIdentity;
  const sink: ObservationSink = {
    connect(clientId) {
      if (!mine(clientId)) return push('CONNECT_SEEN', { clientId });
      const n = open.get(clientId) ?? 0; opens += 1; if (everConnected) reconnects += 1; everConnected = true;
      if (n > 0) { collisions += 1; push('COLLISION_SUSPECTED', { clientId }); }                       // a second CONNECT for the same identity with no DISCONNECT in between
      open.set(clientId, n + 1); maxConcurrent = Math.max(maxConcurrent, n + 1); push(opens > 1 ? 'RECONNECT_SEEN' : 'CONNECT_SEEN', { clientId }); flaps.push(clock());
    },
    disconnect(clientId) { if (!mine(clientId)) return void push('DISCONNECT_SEEN', { clientId }); const n = open.get(clientId) ?? 0; if (n > 0) { open.set(clientId, n - 1); closes += 1; } push('DISCONNECT_SEEN', { clientId }); },
    publish(p) {
      const hash = sha(p.bytes), parsed = parseBrokerPayload(p.bytes, LIMITS); const eventId = parsed.ok ? parsed.envelope.eventId : null;      // canonical parser only; no heuristics
      push(p.dup === true ? 'DUP_PUBLISH_SEEN' : 'PUBLISH_SEEN', { clientId: p.clientId, topic: p.topic, qos: p.qos, dup: p.dup === null ? 'NOT_OBSERVABLE' : p.dup, eventId, payloadSha256: hash, payloadLength: p.bytes.length });
      if (!parsed.ok) push('PAYLOAD_CONTRACT_FAIL', { clientId: p.clientId, topic: p.topic, payloadSha256: hash, payloadLength: p.bytes.length });
      if (!topicOk(p.topic)) push('TOPIC_INVALID_SEEN', { clientId: p.clientId, topic: p.topic });
      kept.push({ bytes: Buffer.from(p.bytes), eventId, sha: hash, clientId: p.clientId, topic: p.topic, at: clock() }); o.onPublish?.({ ...p, eventId, sha: hash });
    },
  };
  const publishes = () => kept.filter(k => mine(k.clientId) || true);
  return {
    sink, runId: o.runId, events: () => events.map(e => ({ ...e })),
    /** Publish records in the shape the conformance world expects. */
    publishRecords: () => kept.map(k => ({ clientId: k.clientId, topic: k.topic, bytes: k.bytes, eventId: k.eventId ?? '', sha: k.sha, delivered: true })),
    connectRecords: () => events.filter(e => (e.type === 'CONNECT_SEEN' || e.type === 'RECONNECT_SEEN') && e.clientId !== null).map(e => ({ clientId: e.clientId!, at: e.timestamp })),
    connections: () => ({ opens, closes, reconnects, collisions, maxConcurrent, currentlyOpen: [...open.values()].reduce((a, b) => a + b, 0) }),
    /** Heuristic for sources that can only poll (EMQX API): many CONNECTs inside a short window = takeover flapping = a shared clientId. */
    flapping(thresholdPerWindow = 3, windowMs = 2000) { const w = flaps.filter(t => t >= (flaps.at(-1) ?? 0) - windowMs); return w.length >= thresholdPerWindow; },
    /** Exact-bytes retry equality per eventId + identity checks against what the adapter says it owns. Returns violations (empty = OK). */
    verify(o2: { knownEventIds?: readonly string[]; knownHashes?: Readonly<Record<string, string>> } = {}): { code: ObserverCode; message: string; detail?: unknown }[] {
      const v: { code: ObserverCode; message: string; detail?: unknown }[] = []; const byId = new Map<string, typeof kept>();
      for (const k of kept) if (k.eventId) byId.set(k.eventId, [...(byId.get(k.eventId) ?? []), k]);
      for (const [id, list] of byId) { if (new Set(list.map(l => l.sha)).size > 1) v.push({ code: 'MQTT_RETRY_BYTES_CHANGED', message: 'retries of the same eventId carried different bytes', detail: id });
        const exp = o2.knownHashes?.[id]; if (exp && list.some(l => l.sha !== exp)) v.push({ code: 'MQTT_HASH_CHANGED', message: 'observed bytes do not hash to the payloadSha256 the publisher owns', detail: id }); }
      if (o2.knownEventIds) for (const k of kept) if (mine(k.clientId) && k.eventId && !o2.knownEventIds.includes(k.eventId)) v.push({ code: 'MQTT_EVENT_ID_CHANGED', message: 'an eventId was published that the publisher does not own (a retry generated a new id?)', detail: k.eventId });
      if (events.some(e => e.type === 'TOPIC_INVALID_SEEN')) v.push({ code: 'MQTT_TOPIC_INVALID', message: 'a publish used an invalid topic' });
      if (events.some(e => e.type === 'PAYLOAD_CONTRACT_FAIL')) v.push({ code: 'PAYLOAD_CONTRACT_FAIL', message: 'a published payload does not parse with the canonical parser' });
      if (collisions > 0) v.push({ code: 'MQTT_CLIENT_ID_COLLISION', message: 'the same technical identity was connected more than once simultaneously', detail: collisions });
      return v;
    },
    /** Condition-based wait. Always bounded: a timeout becomes an ObserverError, never a hang. */
    async waitFor(cond: () => boolean | Promise<boolean>, w: { timeoutMs: number; pollMs?: number; code?: ObserverCode; what?: string }): Promise<void> {
      const end = Date.now() + w.timeoutMs; for (;;) { if (await cond()) return; if (Date.now() >= end) throw new ObserverError(w.code ?? 'MQTT_TIMEOUT', 'timed out waiting for ' + (w.what ?? 'condition') + ' (' + w.timeoutMs + ' ms)'); await sleep(w.pollMs ?? 50); }
    },
    /** Sanitised, machine-readable summary. Payload bytes are NEVER included (hash + length only) unless storePayloadBytes was explicitly requested for TEST_ONLY evidence. */
    summary() {
      const per = new Map<string, { eventId: string; publishes: number; distinctHashes: number; firstAt: number; lastAt: number; payloadLength: number }>();
      for (const k of kept) if (k.eventId) { const p = per.get(k.eventId) ?? { eventId: k.eventId, publishes: 0, distinctHashes: 0, firstAt: k.at, lastAt: k.at, payloadLength: k.bytes.length }; p.publishes += 1; p.lastAt = k.at; per.set(k.eventId, p); }
      for (const [id, p] of per) p.distinctHashes = new Set(kept.filter(k => k.eventId === id).map(k => k.sha)).size;
      return { runId: o.runId, technicalIdentity: o.technicalIdentity, connections: { opens, closes, reconnects, collisions, maxConcurrent }, publishCount: kept.length, retries: [...per.values()].reduce((a, p) => a + Math.max(0, p.publishes - 1), 0), dup: 'NOT_OBSERVABLE (publisher-side DUP is not visible through the broker rule)', perEvent: [...per.values()], timeline: events.map(e => ({ ...e })),
        ...(o.storePayloadBytes ? { payloadBytesB64: kept.map(k => k.bytes.toString('base64')) } : {}) };
    },
  };
}
export type Observer = ReturnType<typeof createObserver>;

/** EMQX source: subscriber on the broker's verification rule + management-API poller. Both are infrastructure; nothing inside the publisher is touched. */
export function createEmqxObservationSource(o: { mqttUrl: string; username: string; password: string; topicFilter: string; technicalIdentity: string; api: (method: string, path: string) => Promise<{ status: number; body: string }>; pollMs?: number; clientId?: string; factory?: (url: string, opts: object) => unknown; startTimeoutMs?: number }): ObservationSource {
  type C = { on(e: string, l: (...a: unknown[]) => void): void; subscribe(t: string, o: object, cb: (e: Error | null) => void): void; end(f?: boolean, o?: object, cb?: () => void): void };
  let subscribed = false; const stopFlag = { set: () => {} }; let client: C | null = null, timer: NodeJS.Timeout | null = null; let state: { connected: boolean; at: string | null } = { connected: false, at: null }; let polling = false;
  return {
    async start(sink) {
      try {
        const factory = o.factory ?? (await loadMqttJsFactory()) as unknown as (url: string, opts: object) => unknown;
        const c = factory(o.mqttUrl, { protocolVersion: 5, clientId: o.clientId ?? 'be14-04-observer', username: o.username, password: o.password, clean: true, reconnectPeriod: 300 }) as C;
        // the observer must SURVIVE a broker outage it is observing: mqtt.js reconnects, and (clean session) we re-subscribe on every connect
        let first = true, stopped = false; stopFlag.set = () => { stopped = true; }; await new Promise<void>((res, rej) => { const t = setTimeout(() => rej(new Error('connect timeout')), o.startTimeoutMs ?? 8000); // a denied SUBACK is cached by the broker per connection: retrying on the same connection keeps being denied, so we drop the connection and let mqtt.js reconnect with a fresh channel
          const sub = (): void => { c.subscribe(o.topicFilter, { qos: 1 }, ((e: Error | null, granted?: { qos: number }[]) => { const ok = !e && (granted ?? []).length > 0 && (granted ?? []).every(g => g.qos < 128); if (!ok) { if (!stopped) setTimeout(() => { try { (c as unknown as { stream?: { destroy(): void } }).stream?.destroy(); } catch { /* */ } }, 300); return; }  subscribed = true; if (first) { first = false; clearTimeout(t); res(); } }) as never); };      // a SUBACK refusal while the broker is still booting must be retried, never left blind
          c.on('connect', sub); c.on('close', () => { subscribed = false; }); c.on('offline', () => { subscribed = false; }); c.on('error', e => { if (first) { clearTimeout(t); rej(e as Error); } }); });
        c.on('message', (...a: unknown[]) => { try { const msg = a[1] as Buffer, pkt = a[2] as { qos?: number; dup?: boolean }; const env = JSON.parse(msg.toString('utf8')) as { clientid?: string; topic?: string; qos?: number; payload_b64?: string };
          if (typeof env.clientid === 'string' && typeof env.topic === 'string' && typeof env.payload_b64 === 'string') sink.publish({ clientId: env.clientid, topic: env.topic, qos: typeof env.qos === 'number' ? env.qos : pkt?.qos ?? null, dup: null, bytes: Buffer.from(env.payload_b64, 'base64') }); } catch { /* a non-envelope message is not an observation */ } });
        client = c;
      } catch (e) { throw new ObserverError('MQTT_OBSERVER_START_FAILED', 'the MQTT observer could not start: ' + (e as Error).message); }
      const poll = async () => { if (polling) return; polling = true; try {
        const r = await o.api('GET', '/clients/' + encodeURIComponent(o.technicalIdentity)); let connected = false, at: string | null = null;
        if (r.status === 200) { try { const j = JSON.parse(r.body) as { connected?: boolean; connected_at?: string }; connected = j.connected === true; at = j.connected_at ?? null; } catch { /* partial body */ const m = /"connected":(true|false)/.exec(r.body), a = /"connected_at":"([^"]+)"/.exec(r.body); connected = m?.[1] === 'true'; at = a?.[1] ?? null; } }
        if (connected && (!state.connected || state.at !== at)) { if (state.connected) sink.disconnect(o.technicalIdentity); sink.connect(o.technicalIdentity); }      // connected_at changed while "connected": a reconnect between two polls
        else if (!connected && state.connected) sink.disconnect(o.technicalIdentity);
        state = { connected, at };
      } catch { /* a failed poll is not an observation */ } finally { polling = false; } };
      timer = setInterval(() => { void poll(); }, o.pollMs ?? 100); await poll();
    },
    isReady: () => subscribed,
    async stop() { stopFlag.set(); if (timer) clearInterval(timer); timer = null; const c = client; client = null; if (c) await new Promise<void>(res => { try { c.end(true, {}, () => res()); } catch { res(); } setTimeout(res, 1000); }); },
  };
}
