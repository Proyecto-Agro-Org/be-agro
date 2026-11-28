// BE14-01 — REFERENCE_IMPLEMENTATION_ONLY publisher for the BE13 reconciliation contract (CONTRATO_BE13_RECONCILIACION_E2E.md).
// No real firmware / publisher exists in the workspace (iot-ingest is an HTTP ingest service, fe-agro a frontend): this module is an executable specification and test harness
// to be ported to the real device. It is NEVER imported by the productive backend and every productive default is BLOCKED.
//
//   submit(reading) -> stable eventId + exact bytes + payloadSha256 persisted in the outbox -> publish (PUBACK = BROKER_ACCEPTED only) -> wait -> reconciliation query
//   -> CONFIRMED | QUARANTINED | CONFLICT_REQUIRES_REVIEW | RETRY_REQUIRED (republish the SAME eventId and bytes) | UNCONFIRMED_EXPLICIT.
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseBrokerPayload } from '../../src/iot/broker-payload.parser.js';
import { EVENT_ID_PATTERN } from '../../src/iot/event-id.js';
import { structuredLogLine } from '../../src/iot/confirmation-observability.js';
import { CONFIRMED_STATUSES } from '../../src/iot/ingest-confirmation.contracts.js';
import { validateOutboxPolicy, type OutboxPolicy } from '../be13-11n/publisher-outbox.js';

// ---------------------------------------------------------------- state machine
export type OutboxState = 'PENDING_PUBLISH' | 'BROKER_ACCEPTED' | 'WAITING_CONFIRMATION' | 'RETRY_REQUIRED' | 'CONFIRMED' | 'QUARANTINED' | 'CONFLICT_REQUIRES_REVIEW' | 'UNCONFIRMED_EXPLICIT';
export type OutboxEvent = 'publish-ok' | 'publish-failed' | 'query-start' | 'confirmed' | 'quarantined' | 'conflict' | 'not-confirmed' | 'throttled' | 'retry-due' | 'lane-exhausted' | 'slow-exhausted';
export const TERMINAL_STATES: readonly OutboxState[] = Object.freeze(['CONFIRMED', 'QUARANTINED', 'CONFLICT_REQUIRES_REVIEW', 'UNCONFIRMED_EXPLICIT']);
// CREATED is the instant before the first durable write: `submit` persists straight into PENDING_PUBLISH.
// There is NO edge from PENDING_PUBLISH / BROKER_ACCEPTED to CONFIRMED: a PUBACK can only move an event to BROKER_ACCEPTED.
const TABLE: Readonly<Record<OutboxState, Readonly<Partial<Record<OutboxEvent, OutboxState>>>>> = Object.freeze({
  PENDING_PUBLISH: { 'publish-ok': 'BROKER_ACCEPTED', 'publish-failed': 'PENDING_PUBLISH', 'slow-exhausted': 'UNCONFIRMED_EXPLICIT' },
  BROKER_ACCEPTED: { 'query-start': 'WAITING_CONFIRMATION' },
  WAITING_CONFIRMATION: { confirmed: 'CONFIRMED', quarantined: 'QUARANTINED', conflict: 'CONFLICT_REQUIRES_REVIEW', 'not-confirmed': 'RETRY_REQUIRED', throttled: 'BROKER_ACCEPTED' },
  RETRY_REQUIRED: { 'retry-due': 'PENDING_PUBLISH', 'lane-exhausted': 'RETRY_REQUIRED', 'slow-exhausted': 'UNCONFIRMED_EXPLICIT' },
  CONFIRMED: {}, QUARANTINED: {}, CONFLICT_REQUIRES_REVIEW: {}, UNCONFIRMED_EXPLICIT: {},
});
export function transition(from: OutboxState, event: OutboxEvent): OutboxState {
  const to = TABLE[from][event]; if (to === undefined) throw new Error(`INVALID_TRANSITION ${from} --${event}-->`); return to;
}
export const validTransitions = () => Object.entries(TABLE).flatMap(([from, edges]) => Object.entries(edges).map(([ev, to]) => `${from} --${ev}--> ${to}`));

// ---------------------------------------------------------------- entry + store
export interface OutboxRecord {
  readonly eventId: string; readonly payloadSha256: string; readonly payloadB64: string; readonly createdAt: number;
  publishAttempts: number; reconciliationAttempts: number; lastPublishAt: number | null; lastReconciliationAt: number | null; nextAttemptAt: number;
  state: OutboxState; lane: 'fast' | 'slow'; brokerAcceptedCount: number; unconfirmedSince: number | null; lastReconciliation: string | null; finishedAt: number | null; version: number;
}
export interface OutboxSnapshot { nextSeq: number; entries: OutboxRecord[] }
export interface DurableOutboxStore { load(): OutboxSnapshot; save(snapshot: OutboxSnapshot): void }
export function createMemoryStore(): DurableOutboxStore & { snapshot(): OutboxSnapshot } { let s: OutboxSnapshot = { nextSeq: 1, entries: [] }; return { load: () => structuredClone(s), save: n => { s = structuredClone(n); }, snapshot: () => structuredClone(s) }; }
/** TEST_ONLY local file store: temp file + fsync + atomic rename. The real device store (flash/SQLite/...) is a product decision. */
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** Atomic rename with a BOUNDED retry: on Windows a rename over an existing file can fail transiently (EPERM/EBUSY/EACCES) while an AV scanner or another handle holds it (found by the BE14-01 campaign). */
export function renameWithRetry(rename: (from: string, to: string) => void, from: string, to: string, attempts = 12): void {
  for (let i = 1; ; i += 1) { try { rename(from, to); return; } catch (e) { const code = (e as NodeJS.ErrnoException).code; if (i >= attempts || !['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '')) throw e; sleepSync(Math.min(200, 10 * i)); } }
}
export function createFileStore(path: string, ops: { rename?: (from: string, to: string) => void } = {}): DurableOutboxStore {
  return {
    load() { if (!existsSync(path)) return { nextSeq: 1, entries: [] }; const p = JSON.parse(readFileSync(path, 'utf8')) as { version: 1; nextSeq: number; entries: OutboxRecord[] }; if (p.version !== 1 || !Array.isArray(p.entries) || !Number.isInteger(p.nextSeq)) throw new Error('OUTBOX_FILE_CORRUPT'); return { nextSeq: p.nextSeq, entries: p.entries }; },
    save(s) { mkdirSync(dirname(path), { recursive: true }); const tmp = path + '.tmp'; writeFileSync(tmp, JSON.stringify({ version: 1, ...s }), 'utf8'); const fd = openSync(tmp, 'r+'); try { fsyncSync(fd); } finally { closeSync(fd); } renameWithRetry(ops.rename ?? renameSync, tmp, path); },
  };
}

// ---------------------------------------------------------------- identity, bytes, hash
export const EVENT_ID_RE = EVENT_ID_PATTERN;     // BE14-02: the ONE canonical definition (src/iot/event-id.ts); a device ports this exact pattern
export const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** Deterministic bytes: fixed key order, no re-serialization later. The hash is ALWAYS taken over these exact bytes (what is stored is what is published). */
export function encodeEvent(e: { eventId: string; sentAt: number; clientid: string; payload: Record<string, number | string | boolean | null>; deviceTimestamp?: string | number | null; topic?: string; dataOrigin?: 'simulated' | 'physical-unverified' | 'unknown' }): Uint8Array {
  if (!EVENT_ID_RE.test(e.eventId)) throw new TypeError('INVALID_EVENT_ID');
  const body: Record<string, unknown> = { version: 1, eventId: e.eventId, sentAt: e.sentAt, clientid: e.clientid };
  if (e.deviceTimestamp !== undefined) body.deviceTimestamp = e.deviceTimestamp;
  body.payload = e.payload; body.mqtt = { ...(e.topic === undefined ? {} : { topic: e.topic }), messageType: 'telemetry', dataOrigin: e.dataOrigin ?? 'unknown' };
  // BE14-03 (found by the conformance kit): the pipeline only processes a deviceTimestamp that is a NON-NEGATIVE INTEGER epoch (strings, null, floats and negatives are parseable but get quarantined),
  // and the backend parser rejects readings with invalid keys/values. A publisher must refuse such a reading LOCALLY instead of publishing something that can never be confirmed.
  if (body.deviceTimestamp !== undefined && !(typeof body.deviceTimestamp === 'number' && Number.isSafeInteger(body.deviceTimestamp) && body.deviceTimestamp >= 0)) throw new TypeError('INVALID_DEVICE_TIMESTAMP');
  const bytes = Buffer.from(JSON.stringify(body), 'utf8'); const parsed = parseBrokerPayload(bytes, { maxBytes: 1 << 20, maxDepth: 8, maxKeys: 64, maxStringLength: 256 });
  if (!parsed.ok) throw new TypeError('INVALID_READING:' + parsed.reasonCode);
  return bytes;
}

// ---------------------------------------------------------------- ports
export interface MqttPublisherPort { /** true = broker PUBACK (BROKER_ACCEPTED). false/throw = no PUBACK. */ publish(eventId: string, bytes: Uint8Array): Promise<boolean> }
export type ReconciliationAnswer =
  | { readonly kind: 'status'; readonly status: string }
  | { readonly kind: 'throttled'; readonly retryAfterMs: number }
  | { readonly kind: 'no-answer'; readonly reason: 'auth-denied' | 'unavailable' | 'malformed' | 'timeout' | 'auth-blocked' };
export interface ReconciliationClient { query(eventId: string, payloadSha256: string): Promise<ReconciliationAnswer> }
export interface ReconciliationAuthProvider { /** Request headers proving the publisher identity. Throws AUTH_BLOCKED when nothing is approved. */ headers(): Promise<Record<string, string>> }
/** Productive default: no authentication technology is approved, so nothing can authenticate. */
export const BLOCKED_RECONCILIATION_AUTH: ReconciliationAuthProvider = Object.freeze({ headers: async () => { throw new Error('AUTH_BLOCKED'); } });
/** TEST_ONLY synthetic principal (matches the TEST_ONLY router authority of the lab). Never a real credential. */
export const createTestOnlyAuth = (principal: string): ReconciliationAuthProvider => Object.freeze({ headers: async () => ({ 'x-principal': principal }) });

/** HTTP client of the reconciliation API: bounded, never throws, never invents a status. 404 is a MISSING ROUTE (no-answer), not the domain `not-found` (that arrives as 200). */
export function createHttpReconciliationClient(o: { baseUrl: string; auth: ReconciliationAuthProvider; timeoutMs?: number; fetchImpl?: typeof fetch; now?: () => number }): ReconciliationClient {
  const f = o.fetchImpl ?? fetch, timeout = o.timeoutMs ?? 5000, now = o.now ?? Date.now;
  return { async query(eventId, payloadSha256) {
    let headers: Record<string, string>; try { headers = await o.auth.headers(); } catch { return { kind: 'no-answer', reason: 'auth-blocked' }; }
    let r: Response;
    try { r = await f(`${o.baseUrl}/ingest-confirmations/${encodeURIComponent(eventId)}?payloadSha256=${payloadSha256}`, { headers, signal: AbortSignal.timeout(timeout) }); }
    catch (e) { return { kind: 'no-answer', reason: (e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError' ? 'timeout' : 'unavailable' }; }   // reset, refused, DNS...
    if (r.status === 429) { const h = r.headers.get('retry-after'); let ms = 1000; if (h !== null) { const n = Number(h); ms = Number.isFinite(n) ? n * 1000 : Math.max(0, Date.parse(h) - now()) || 1000; } return { kind: 'throttled', retryAfterMs: Math.min(ms, 3_600_000) }; }
    if (r.status === 401 || r.status === 403) return { kind: 'no-answer', reason: 'auth-denied' };
    if (r.status !== 200) return { kind: 'no-answer', reason: 'unavailable' };                                    // 404 (missing route), 5xx, 414, 400...
    try { const b = await r.json() as { eventId?: unknown; status?: unknown; confirmed?: unknown };
      if (b.eventId !== eventId || typeof b.status !== 'string' || typeof b.confirmed !== 'boolean') return { kind: 'no-answer', reason: 'malformed' };   // an answer about ANOTHER event never counts
      return { kind: 'status', status: b.status }; } catch { return { kind: 'no-answer', reason: 'malformed' }; }
  } };
}

// ---------------------------------------------------------------- MQTT identity rule
/** ONE connection per publisher identity. The MQTT clientId IS the device technical key (the backend boundary rejects any other value) and is never randomized or shared. */
export function createSingleConnectionGuard(technicalKey: string) {
  if (!EVENT_ID_RE.test(technicalKey)) throw new TypeError('INVALID_TECHNICAL_KEY'); let open = 0;
  return { clientId: technicalKey, acquire() { if (open > 0) throw new Error('CLIENT_ID_COLLISION'); open += 1; return () => { open = Math.max(0, open - 1); }; }, get open() { return open; } };
}

// ---------------------------------------------------------------- observability (closed names)
export type PublisherCounter = 'publish_attempts' | 'puback_received' | 'reconciliation_queries' | 'reconciliation_confirmed' | 'reconciliation_pending' | 'reconciliation_not_found' | 'reconciliation_conflict' | 'reconciliation_quarantined' | 'unconfirmed' | 'retries' | 'publisher_restart_recovered' | 'throttled' | 'no_answer';
export const COUNTERS: readonly PublisherCounter[] = ['publish_attempts', 'puback_received', 'reconciliation_queries', 'reconciliation_confirmed', 'reconciliation_pending', 'reconciliation_not_found', 'reconciliation_conflict', 'reconciliation_quarantined', 'unconfirmed', 'retries', 'publisher_restart_recovered', 'throttled', 'no_answer'];

export type SubmitResult = { readonly result: 'ACCEPTED' | 'ALREADY_PRESENT'; readonly eventId: string } | { readonly result: 'REJECTED_OUTBOX_FULL' } | { readonly result: 'REJECTED_EVENT_ID_REUSED_WITH_OTHER_BYTES' };

export function createReferencePublisher(o: { store: DurableOutboxStore; policy: OutboxPolicy; technicalKey: string; mqtt: MqttPublisherPort; reconciliation: ReconciliationClient; now?: () => number; random?: () => number; log?: (line: string) => void; hooks?: { crashAt?: (point: string) => void } }) {
  validateOutboxPolicy(o.policy); const policy = o.policy; const now = o.now ?? Date.now, random = o.random ?? Math.random;
  let snap = o.store.load(); const counters = Object.fromEntries(COUNTERS.map(c => [c, 0])) as Record<PublisherCounter, number>; const inFlight = new Set<string>(); let gate = true;
  const persist = () => o.store.save(snap); const crash = (p: string) => o.hooks?.crashAt?.(p);
  const log = (e: Record<string, unknown>) => o.log?.(structuredLogLine({ ts: now(), component: 'publisher', sourceId: o.technicalKey, ...e }));
  counters.publisher_restart_recovered = snap.entries.filter(e => !TERMINAL_STATES.includes(e.state)).length;       // state rebuilt from durable storage
  const delay = (attempt: number) => Math.max(0, Math.round(Math.min(policy.fast.maxDelayMs, policy.fast.initialDelayMs * policy.fast.backoffFactor ** (attempt - 1)) * (1 + (random() * 2 - 1) * policy.fast.jitterRatio)));
  const active = () => snap.entries.filter(e => e.state !== 'CONFIRMED').length;
  const move = (e: OutboxRecord, ev: OutboxEvent, extra: Record<string, unknown> = {}) => { const from = e.state; e.state = transition(from, ev); e.version += 1; log({ event: 'publisher.transition', eventId: e.eventId, from, to: e.state, lane: e.lane, attempt: e.publishAttempts, ...extra }); };
  const finish = (e: OutboxRecord, ev: OutboxEvent, label: string) => { move(e, ev, { status: label }); e.finishedAt = now(); e.lastReconciliation = label; };

  /** Reading -> stable eventId (persisted counter, never the clock) -> deterministic bytes -> hash -> durable outbox entry. The eventId is fixed HERE and never regenerated. */
  function submitReading(r: { payload: Record<string, number | string | boolean | null>; eventId?: string; sentAt?: number; deviceTimestamp?: string | number | null; topic?: string; dataOrigin?: 'simulated' | 'physical-unverified' | 'unknown' }): SubmitResult {
    const explicit = r.eventId !== undefined, eventId = r.eventId ?? `${o.technicalKey}:${snap.nextSeq}`;
    // deviceTimestamp is REQUIRED by the backend pipeline (a reading without it is quarantined: found by the BE14-01 integration). It is DECLARED by the device, fixed here at creation and never regenerated on retry; it is not identity.
    const t = now(); const bytes = encodeEvent({ eventId, sentAt: r.sentAt ?? t, clientid: o.technicalKey, payload: r.payload, deviceTimestamp: r.deviceTimestamp === undefined ? t : r.deviceTimestamp, ...(r.topic === undefined ? {} : { topic: r.topic }), ...(r.dataOrigin === undefined ? {} : { dataOrigin: r.dataOrigin }) });
    return submitBytes(eventId, bytes, !explicit);
  }
  function submitBytes(eventId: string, bytes: Uint8Array, consumeSeq = false): SubmitResult {
    const sha = sha256Hex(bytes), existing = snap.entries.find(e => e.eventId === eventId);
    if (existing) return existing.payloadSha256 === sha ? { result: 'ALREADY_PRESENT', eventId } : { result: 'REJECTED_EVENT_ID_REUSED_WITH_OTHER_BYTES' };
    if (active() >= policy.capacity) return { result: 'REJECTED_OUTBOX_FULL' };                // explicit; the caller still owns the reading
    const t = now(); if (consumeSeq) snap.nextSeq += 1;
    snap.entries.push({ eventId, payloadSha256: sha, payloadB64: Buffer.from(bytes).toString('base64'), createdAt: t, publishAttempts: 0, reconciliationAttempts: 0, lastPublishAt: null, lastReconciliationAt: null, nextAttemptAt: t, state: 'PENDING_PUBLISH', lane: 'fast', brokerAcceptedCount: 0, unconfirmedSince: null, lastReconciliation: null, finishedAt: null, version: 1 });
    persist(); return { result: 'ACCEPTED', eventId };
  }

  async function publishStep(e: OutboxRecord) {
    crash('C1:before-publish'); let ok = false; counters.publish_attempts += 1; if (e.publishAttempts > 0) counters.retries += 1;
    try { ok = (await o.mqtt.publish(e.eventId, Buffer.from(e.payloadB64, 'base64'))) === true; } catch { ok = false; }
    crash('C2:after-publish-before-persist'); const t = now(); e.publishAttempts += 1; e.lastPublishAt = t;
    if (ok) { counters.puback_received += 1; e.brokerAcceptedCount += 1; move(e, 'publish-ok'); e.nextAttemptAt = t + (e.lane === 'fast' ? delay(e.publishAttempts) : policy.slow.confirmWaitMs); }   // PUBACK = BROKER_ACCEPTED, nothing more
    else {
      move(e, 'publish-failed'); e.nextAttemptAt = t + Math.max(delay(e.publishAttempts), 1);                                  // MQTT/network down: the event stays, with the SAME eventId
      if (e.lane === 'fast' && t - e.createdAt >= policy.fast.maxElapsedMs) { e.lane = 'slow'; e.unconfirmedSince = t; e.nextAttemptAt = t + policy.slow.intervalMs; counters.unconfirmed += 1; log({ event: 'publisher.lane', eventId: e.eventId, lane: 'slow', status: 'UNCONFIRMED' }); }
      else if (e.lane === 'slow' && t - e.createdAt >= policy.slow.maxElapsedMs) { finish(e, 'slow-exhausted', 'publish-failed'); }
    }
    persist(); crash('C3:after-puback');
  }
  async function queryStep(e: OutboxRecord) {
    if (e.state === 'BROKER_ACCEPTED') { move(e, 'query-start'); persist(); }                       // durable BEFORE the query (a crash here re-queries; the query is read-only)
    counters.reconciliation_queries += 1; e.reconciliationAttempts += 1; e.lastReconciliationAt = now();
    const a = await o.reconciliation.query(e.eventId, e.payloadSha256); crash('C4:after-backend-answer'); const t = now();
    if (a.kind === 'throttled') { counters.throttled += 1; move(e, 'throttled', { status: 'throttled' }); e.nextAttemptAt = t + Math.max(a.retryAfterMs, 1); e.lastReconciliation = 'throttled'; persist(); return; }      // 429: honour Retry-After, no republish
    const label = a.kind === 'status' ? a.status : 'no-answer:' + a.reason; if (a.kind === 'no-answer') counters.no_answer += 1;
    if (a.kind === 'status' && (CONFIRMED_STATUSES as readonly string[]).includes(a.status)) { counters.reconciliation_confirmed += 1; finish(e, 'confirmed', label); crash('C5:after-confirmation-before-delete'); persist(); return; }
    if (a.kind === 'status' && a.status === 'quarantined') { counters.reconciliation_quarantined += 1; finish(e, 'quarantined', label); persist(); return; }
    if (a.kind === 'status' && a.status === 'conflict') { counters.reconciliation_conflict += 1; finish(e, 'conflict', label); persist(); return; }                 // never republished
    if (a.kind === 'status' && a.status === 'pending') counters.reconciliation_pending += 1; else if (a.kind === 'status' && a.status === 'not-found') counters.reconciliation_not_found += 1;
    move(e, 'not-confirmed', { status: label }); e.lastReconciliation = label;                    // pending / not-found / unknown status / no answer: NEVER success
    if (e.lane === 'fast') {
      if (e.reconciliationAttempts >= policy.fast.maxAttempts || t - e.createdAt >= policy.fast.maxElapsedMs) { e.lane = 'slow'; e.unconfirmedSince = t; e.nextAttemptAt = t + policy.slow.intervalMs; counters.unconfirmed += 1; move(e, 'lane-exhausted', { status: 'UNCONFIRMED' }); }
      else e.nextAttemptAt = t;
    } else if (t - e.createdAt >= policy.slow.maxElapsedMs) finish(e, 'slow-exhausted', label); else e.nextAttemptAt = t + policy.slow.intervalMs;
    persist();
  }
  async function step(e: OutboxRecord) {
    if (inFlight.has(e.eventId)) return; inFlight.add(e.eventId);
    try {
      if (e.state === 'RETRY_REQUIRED') { move(e, 'retry-due'); persist(); }
      if (e.state === 'PENDING_PUBLISH') await publishStep(e); else if (e.state === 'BROKER_ACCEPTED' || e.state === 'WAITING_CONFIRMATION') await queryStep(e);
    } finally { inFlight.delete(e.eventId); }
  }
  async function tick(concurrency = 8): Promise<number> {
    if (!gate) return 0; const t = now(), due = snap.entries.filter(e => !TERMINAL_STATES.includes(e.state) && e.nextAttemptAt <= t); let i = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, due.length) }, async () => { for (;;) { const e = due[i++]; if (!e) return; await step(e); } })); return due.length;
  }
  return { submitReading, submitBytes, tick, setGate(v: boolean) { gate = v; }, entries: () => structuredClone(snap.entries) as OutboxRecord[], get: (id: string) => { const e = snap.entries.find(x => x.eventId === id); return e ? structuredClone(e) as OutboxRecord : null; }, counters: () => ({ ...counters }),
    stats(t = now()) { const open = snap.entries.filter(e => !TERMINAL_STATES.includes(e.state)); return { outbox_depth: open.length, outbox_oldest_age: open.length ? Math.max(...open.map(e => t - e.createdAt)) : 0, byState: snap.entries.reduce((a: Record<string, number>, e) => { a[e.state] = (a[e.state] ?? 0) + 1; return a; }, {}) }; },
    compact() { const n = snap.entries.length; snap.entries = snap.entries.filter(e => e.state !== 'CONFIRMED'); if (snap.entries.length !== n) persist(); return n - snap.entries.length; }, nextSeq: () => snap.nextSeq };
}
