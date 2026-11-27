// BE14-01 — reference publisher for the BE13 reconciliation contract (offline: fake clock/MQTT, REAL confirmation service + router, in-memory evidence).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as mod from '../dist/scripts/be14-01/reference-publisher.js';
import { createMqttPublisherPort } from '../dist/scripts/be14-01/mqtt-port.js';
import { DEFAULT_OUTBOX_POLICY } from '../dist/scripts/be13-11n/publisher-outbox.js';
import { parseBrokerPayload } from '../dist/src/iot/broker-payload.parser.js';
import { payloadSha256 } from '../dist/src/iot/broker-fingerprints.js';
import { eventIdOfBytes } from '../dist/src/repositories/mongo-broker-inbox.store.js';
import { createIngestConfirmationService } from '../dist/src/services/ingest-confirmation.service.js';
import * as routes from '../dist/src/routes/ingest-confirmation.routes.js';
import * as limit from '../dist/src/iot/confirmation-rate-limit.js';
import { A, H, createBackend } from '../test-support/be13-11j-invariants.js';
import { withApi } from '../test-support/be13-11m-invariants.js';
import { checkPublisherInvariants } from '../test-support/be14-01-invariants.js';
import { KEY, policy, rig } from '../test-support/be14-01-rig.js';

const VECTORS = JSON.parse(readFileSync(new URL('../test-support/be14-01-golden-vectors.json', import.meta.url), 'utf8')).vectors;
const reading = { payload: { soil_temperature_c: 21.5 }, dataOrigin: 'simulated' };
const LIMITS = { maxBytes: 4096, maxDepth: 8, maxKeys: 64, maxStringLength: 256 };

test('B1 golden vectors: publisher bytes == stored bytes, publisher hash == backend hash == expected, and the backend parser accepts every vector', () => {
  assert.ok(VECTORS.length >= 5);
  for (const v of VECTORS) {
    const bytes = Buffer.from(mod.encodeEvent(v.reading)); assert.equal(bytes.toString('utf8'), v.bytes, v.name);
    assert.equal(mod.sha256Hex(bytes), v.payloadSha256, v.name); assert.equal(payloadSha256(bytes), v.payloadSha256, v.name);                 // publisher == backend
    assert.equal(eventIdOfBytes(bytes), v.eventId, v.name);
    const parsed = parseBrokerPayload(bytes, LIMITS); assert.equal(parsed.ok, true, v.name + ' ' + JSON.stringify(parsed)); assert.equal(parsed.envelope.eventId, v.eventId); assert.equal(parsed.payloadFingerprint, v.payloadSha256);
    const r = rig(mod); assert.equal(r.pub.submitBytes(v.eventId, bytes).result, 'ACCEPTED'); assert.equal(r.pub.get(v.eventId).payloadSha256, v.payloadSha256);
  }
  assert.notEqual(JSON.stringify({ b: 1, a: 2 }), JSON.stringify({ a: 2, b: 1 }));                                                              // why bytes (not objects) are stored and hashed
});

test('B2 eventId: generated from the device key + a PERSISTED counter (never the clock), stable across retries and restarts, strict charset', async () => {
  const r = rig(mod, { mqttAs: () => ({ puback: true, deliver: false }) }); const a = r.pub.submitReading(reading), b = r.pub.submitReading(reading);
  assert.deepEqual([a.eventId, b.eventId], [KEY + ':1', KEY + ':2']); assert.match(a.eventId, mod.EVENT_ID_RE);
  await r.pump(r.pub, 4000); assert.ok(r.publishes.filter(p => p.eventId === a.eventId).length >= 2); assert.deepEqual([...new Set(r.publishes.map(p => p.eventId))].sort(), [a.eventId, b.eventId]);
  const again = r.make(); const c = again.submitReading(reading); assert.equal(c.eventId, KEY + ':3');                                              // restart: the counter continues
  assert.throws(() => mod.encodeEvent({ eventId: 'bad.id', sentAt: 1, clientid: KEY, payload: {} }), /INVALID_EVENT_ID/);                           // '.' passes the confirmation API but NOT the payload parser
  const sentAt = r.pub.get(a.eventId) && JSON.parse(Buffer.from(r.pub.get(a.eventId).payloadB64, 'base64').toString()).sentAt;
  assert.equal(r.pub.submitReading({ ...reading, eventId: a.eventId, sentAt }).result, 'ALREADY_PRESENT');                                       // same reading, same bytes: idempotent
  assert.equal(r.pub.submitReading({ ...reading, eventId: a.eventId, sentAt: sentAt + 1 }).result, 'REJECTED_EVENT_ID_REUSED_WITH_OTHER_BYTES');   // other bytes under the same id: refused
});

test('B3 state machine: explicit table; PUBACK can never reach CONFIRMED; terminal states have no exits', () => {
  const edges = mod.validTransitions(); assert.ok(edges.includes('PENDING_PUBLISH --publish-ok--> BROKER_ACCEPTED') && edges.includes('WAITING_CONFIRMATION --confirmed--> CONFIRMED'));
  for (const [from, ev] of [['PENDING_PUBLISH', 'confirmed'], ['BROKER_ACCEPTED', 'confirmed'], ['BROKER_ACCEPTED', 'conflict'], ['RETRY_REQUIRED', 'confirmed'], ['CONFIRMED', 'not-confirmed'], ['CONFLICT_REQUIRES_REVIEW', 'retry-due'], ['QUARANTINED', 'publish-ok'], ['UNCONFIRMED_EXPLICIT', 'confirmed']]) assert.throws(() => mod.transition(from, ev), /INVALID_TRANSITION/, from + ' ' + ev);
  assert.equal(mod.transition('PENDING_PUBLISH', 'publish-ok'), 'BROKER_ACCEPTED'); assert.equal(mod.transition('WAITING_CONFIRMATION', 'not-confirmed'), 'RETRY_REQUIRED'); assert.equal(mod.transition('RETRY_REQUIRED', 'retry-due'), 'PENDING_PUBLISH');
  for (const t of mod.TERMINAL_STATES) assert.equal(mod.validTransitions().some(e => e.startsWith(t + ' --')), false, t);
});

test('B4 PUBACK semantics: BROKER_ACCEPTED only; the entry stays in the outbox; success needs a backend confirmation', async () => {
  const r = rig(mod, { mqttAs: () => ({ puback: true, deliver: true }) }); const { eventId } = r.pub.submitReading(reading); await r.pub.tick();
  let e = r.pub.get(eventId); assert.equal(e.state, 'BROKER_ACCEPTED'); assert.equal(e.brokerAcceptedCount, 1); assert.equal(r.pub.stats().outbox_depth, 1); assert.equal(r.queries.length, 0);
  r.advance(500); await r.pub.tick(); e = r.pub.get(eventId); assert.equal(e.state, 'CONFIRMED'); assert.equal(r.queries.length, 1); assert.equal(r.pub.compact(), 1);
});

test('B5 confirmation table: processed/duplicate-confirmed/received-durable succeed; pending/not-found/unknown/no-answer never do', async () => {
  for (const [status, expect] of [['processed', 'CONFIRMED'], ['duplicate-confirmed', 'CONFIRMED'], ['received-durable', 'CONFIRMED'], ['quarantined', 'QUARANTINED'], ['conflict', 'CONFLICT_REQUIRES_REVIEW']]) {
    const r = rig(mod, { recAs: async () => ({ kind: 'status', status }) }); const { eventId } = r.pub.submitReading(reading); await r.pump(r.pub, 5000);
    assert.equal(r.pub.get(eventId).state, expect, status); assert.equal(r.publishes.length, 1, status + ' is terminal: no republish');
  }
  for (const rec of [{ kind: 'status', status: 'pending' }, { kind: 'status', status: 'not-found' }, { kind: 'status', status: 'brand-new-status' }, { kind: 'no-answer', reason: 'timeout' }, { kind: 'no-answer', reason: 'malformed' }]) {
    const r = rig(mod, { recAs: async () => rec, mqttAs: () => ({ puback: true, deliver: false }) }); const { eventId } = r.pub.submitReading(reading); await r.pump(r.pub, 3000);
    assert.notEqual(r.pub.get(eventId).state, 'CONFIRMED', JSON.stringify(rec)); assert.ok(r.publishes.length >= 2);
  }
});

test('B6 F-E2: PUBACK without delivery => not-found => republish the SAME id/bytes => confirmation; 1 measurement', async () => {
  const r = rig(mod, { mqttAs: (id, n) => ({ puback: true, deliver: n >= 3 }) }); const { eventId } = r.pub.submitReading(reading); await r.pump();
  const e = r.pub.get(eventId); assert.equal(e.state, 'CONFIRMED'); assert.equal(e.publishAttempts, 3); assert.equal(e.brokerAcceptedCount, 3); assert.equal(new Set(r.publishes.map(p => p.sha)).size, 1); assert.equal(r.backend.measurementCount(), 1);
});

test('B7 two lanes, UNCONFIRMED and exhaustion: fast lane spent => slow lane + alert counter; slow lane spent => UNCONFIRMED_EXPLICIT (retained)', async () => {
  const r = rig(mod, { mqttAs: () => ({ puback: true, deliver: false }) }); const { eventId } = r.pub.submitReading(reading);
  await r.pump(r.pub, 3000); let e = r.pub.get(eventId); assert.equal(e.lane, 'slow'); assert.ok(e.unconfirmedSince !== null); assert.equal(r.pub.counters().unconfirmed, 1);
  await r.pump(r.pub, 200_000); e = r.pub.get(eventId); assert.equal(e.state, 'UNCONFIRMED_EXPLICIT'); assert.ok(e.finishedAt !== null); assert.equal(r.pub.compact(), 0); assert.equal(new Set(r.publishes.map(p => p.eventId)).size, 1);
});

test('B8 saturation and eventId reuse are explicit; nothing is dropped', () => {
  const r = rig(mod, { pol: policy({ capacity: 2 }) }); assert.equal(r.pub.submitReading(reading).result, 'ACCEPTED'); assert.equal(r.pub.submitReading(reading).result, 'ACCEPTED');
  assert.equal(r.pub.submitReading(reading).result, 'REJECTED_OUTBOX_FULL'); assert.equal(r.pub.entries().length, 2); assert.equal(r.pub.nextSeq(), 3);                      // the rejected reading did NOT consume an id
  assert.equal(r.pub.submitBytes(KEY + ':1', Buffer.from('other')).result, 'REJECTED_EVENT_ID_REUSED_WITH_OTHER_BYTES');
});

test('B9 offline MQTT: the event is kept with the SAME eventId, never regenerated; converges after the network returns; long outage => slow lane', async () => {
  let up = false; const r = rig(mod, { mqttAs: () => ({ puback: up, deliver: up }) }); const { eventId } = r.pub.submitReading(reading);
  await r.pump(r.pub, 1500); assert.equal(r.pub.get(eventId).state, 'PENDING_PUBLISH'); assert.ok(r.pub.get(eventId).publishAttempts >= 2); assert.equal(new Set(r.publishes.map(p => p.eventId)).size, 1);
  r.advance(25_000); await r.pub.tick(); assert.equal(r.pub.get(eventId).lane, 'slow'); up = true; await r.pump(); assert.equal(r.pub.get(eventId).state, 'CONFIRMED'); assert.equal(r.backend.measurementCount(), 1);
});

test('B10 reconciliation API down: never success, entry kept; converges when it returns', async () => {
  let down = true; const r = rig(mod, { recAs: async (id, h) => down ? { kind: 'no-answer', reason: 'unavailable' } : { kind: 'status', status: (await r.service.confirm(A, id, h)).status } }); const { eventId } = r.pub.submitReading(reading);
  await r.pump(r.pub, 2000); assert.notEqual(r.pub.get(eventId).state, 'CONFIRMED'); assert.ok(r.pub.counters().no_answer >= 1); down = false; await r.pump(); assert.equal(r.pub.get(eventId).state, 'CONFIRMED'); assert.equal(r.backend.measurementCount(), 1);
});

test('B11 HTTP 429 + Retry-After: no republish, no early query, counter; resumes after the delay', async () => {
  let n = 0; const r = rig(mod, { recAs: async (id, h) => (++n === 1 ? { kind: 'throttled', retryAfterMs: 20_000 } : { kind: 'status', status: (await r.service.confirm(A, id, h)).status }) }); const { eventId } = r.pub.submitReading(reading);
  await r.pub.tick(); r.advance(500); await r.pub.tick(); const t0 = r.t(); assert.equal(r.pub.counters().throttled, 1); assert.equal(r.publishes.length, 1);
  r.advance(5000); await r.pub.tick(); assert.equal(r.queries.length, 1); r.advance(16_000); await r.pub.tick(); assert.equal(r.pub.get(eventId).state, 'CONFIRMED'); assert.ok(r.t() - t0 >= 20_000); assert.equal(r.publishes.length, 1);
});

test('B12 crash at every critical moment (C1-C5): a new publisher over the same durable store converges with the same eventId/hash and ONE measurement', async () => {
  const points = ['C1:before-publish', 'C2:after-publish-before-persist', 'C3:after-puback', 'C4:after-backend-answer', 'C5:after-confirmation-before-delete'];
  for (const point of points) {
    const backend = createBackend(), store = (await import('../dist/scripts/be14-01/reference-publisher.js')).createMemoryStore(); let armed = true;
    const r1 = rig(mod, { backend, store, hooks: { crashAt: p => { if (armed && p === point) { armed = false; throw new Error('CRASH ' + p); } } } });
    const { eventId } = r1.pub.submitReading(reading); const sha = r1.pub.get(eventId).payloadSha256;
    await assert.rejects(async () => { for (let i = 0; i < 20; i += 1) { r1.advance(500); await r1.pub.tick(); } }, /CRASH/, point);
    const r2 = rig(mod, { backend, store }); const p2 = r2.make(); assert.ok(p2.get(eventId), point); assert.equal(p2.get(eventId).payloadSha256, sha);
    assert.equal(p2.counters().publisher_restart_recovered, 1, point);
    for (let i = 0; i < 30 && p2.stats().outbox_depth > 0; i += 1) { r2.advance(500); await p2.tick(); }
    assert.equal(p2.get(eventId).state, 'CONFIRMED', point); assert.equal(backend.measurementCount(), 1, point + ': at-least-once publish, ONE measurement');
    assert.ok([...r1.publishes, ...r2.publishes].every(p => p.eventId === eventId && p.sha === sha), point);
  }
});

test('B13 restart recovery with the FILE store: eventId, hash, counters and lanes survive', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pub-')), path = join(dir, 'outbox.json'); const store = mod.createFileStore(path);
  const r1 = rig(mod, { store, mqttAs: () => ({ puback: true, deliver: false }) }); for (let i = 0; i < 3; i += 1) r1.pub.submitReading(reading); await r1.pub.tick();
  const before = r1.pub.entries(); const r2 = rig(mod, { store: mod.createFileStore(path) }); const p2 = r2.make();
  assert.deepEqual(p2.entries().map(e => [e.eventId, e.payloadSha256, e.publishAttempts, e.state]), before.map(e => [e.eventId, e.payloadSha256, e.publishAttempts, e.state])); assert.equal(p2.nextSeq(), 4);
  assert.equal(p2.counters().publisher_restart_recovered, 3);
  assert.throws(() => mod.createFileStore(join(dir, 'bad.json')).load() && (() => { throw new Error('x'); })(), /x/);
});

test('B14 concurrency: 20 events, answers matched per eventId, no event removed by another event\'s answer, no double processing of one entry', async () => {
  const r = rig(mod); for (let i = 0; i < 20; i += 1) r.pub.submitReading({ payload: { soil_temperature_c: i } }); const ids = r.pub.entries().map(e => e.eventId);
  await Promise.all([r.pub.tick(8), r.pub.tick(8)]); r.advance(500); await Promise.all([r.pub.tick(8), r.pub.tick(8)]);
  assert.equal(r.pub.entries().filter(e => e.state === 'CONFIRMED').length, 20); assert.equal(r.publishes.length, 20); assert.deepEqual(new Set(r.publishes.map(p => p.eventId)), new Set(ids)); assert.equal(r.backend.measurementCount(), 20);
  const w = rig(mod, { mqttAs: () => ({ puback: true, deliver: false }), recAs: async eventId => ({ kind: 'status', status: eventId.endsWith(':1') ? 'processed' : 'not-found' }) }); for (let i = 0; i < 3; i += 1) w.pub.submitReading(reading);
  await w.pub.tick(); w.advance(500); await w.pub.tick(); assert.deepEqual(w.pub.entries().map(e => e.state), ['CONFIRMED', 'RETRY_REQUIRED', 'RETRY_REQUIRED']);
});

test('B15 observability: the closed counter set, gauges and structured logs (no payload, no hash, no secrets)', async () => {
  const r = rig(mod, { mqttAs: (id, n) => ({ puback: true, deliver: n >= 2 }) }); const { eventId } = r.pub.submitReading({ payload: { note: 'secret-reading-value' } }); await r.pump();
  assert.deepEqual(Object.keys(r.pub.counters()).sort(), [...mod.COUNTERS].sort()); const c = r.pub.counters();
  assert.ok(c.publish_attempts >= 2 && c.puback_received >= 2 && c.reconciliation_queries >= 2 && c.reconciliation_confirmed === 1 && c.reconciliation_not_found >= 1 && c.retries >= 1);
  const s = r.pub.stats(); assert.deepEqual([s.outbox_depth, s.outbox_oldest_age], [0, 0]); assert.ok(r.logs.length >= 4);
  for (const l of r.logs) { const rec = JSON.parse(l); assert.ok(Object.keys(rec).every(k => ['ts', 'component', 'event', 'eventId', 'sourceId', 'from', 'to', 'lane', 'attempt', 'status', 'outcome'].includes(k))); assert.equal(l.includes('secret-reading-value'), false); assert.equal(l.includes(r.pub.get(eventId).payloadSha256), false); }
});

test('B16 HTTP client: status mapping, malformed answers, 429 Retry-After, auth, 404/5xx/reset/timeout never become a domain status; BLOCKED auth never calls the network', async () => {
  const H64 = 'a'.repeat(64); const mk = (fetchImpl, auth = mod.createTestOnlyAuth('p-a')) => mod.createHttpReconciliationClient({ baseUrl: 'http://x', auth, fetchImpl, timeoutMs: 50, now: () => Date.parse('2026-01-01T00:00:00Z') });
  const json = (status, body, headers = {}) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
  assert.deepEqual(await mk(json(200, { eventId: 'e1', status: 'processed', confirmed: true })).query('e1', H64), { kind: 'status', status: 'processed' });
  for (const bad of ['not json', '{}', JSON.stringify({ eventId: 'e1', status: 5, confirmed: true }), JSON.stringify({ eventId: 'other', status: 'processed', confirmed: true }), JSON.stringify({ eventId: 'e1', status: 'processed', confirmed: 'yes' })]) assert.deepEqual(await mk(json(200, bad)).query('e1', H64), { kind: 'no-answer', reason: 'malformed' });
  assert.deepEqual(await mk(json(429, {}, { 'retry-after': '7' })).query('e1', H64), { kind: 'throttled', retryAfterMs: 7000 }); assert.deepEqual(await mk(json(429, {}, { 'retry-after': 'Thu, 01 Jan 2026 00:00:20 GMT' })).query('e1', H64), { kind: 'throttled', retryAfterMs: 20_000 });
  assert.equal((await mk(json(429, {})).query('e1', H64)).retryAfterMs, 1000);
  for (const code of [401, 403]) assert.deepEqual(await mk(json(code, {})).query('e1', H64), { kind: 'no-answer', reason: 'auth-denied' });
  for (const code of [400, 404, 414, 500, 502, 503]) assert.deepEqual(await mk(json(code, { status: 'not-found' })).query('e1', H64), { kind: 'no-answer', reason: 'unavailable' }, 'HTTP ' + code);   // 404 = missing route, NOT the domain not-found
  assert.deepEqual(await mk(async () => { throw new TypeError('ECONNRESET'); }).query('e1', H64), { kind: 'no-answer', reason: 'unavailable' });
  assert.deepEqual(await mk(() => new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('t'), { name: 'TimeoutError' })), 5))).query('e1', H64), { kind: 'no-answer', reason: 'timeout' });
  let called = 0; assert.deepEqual(await mk(async () => { called += 1; return new Response('{}'); }, mod.BLOCKED_RECONCILIATION_AUTH).query('e1', H64), { kind: 'no-answer', reason: 'auth-blocked' }); assert.equal(called, 0);
});

test('B17 HTTP client against the REAL router + service: confirmed, cross-tenant not-found, conflict (same eventId, different bytes), quarantine', async () => {
  const be = createBackend(); const sha = b => mod.sha256Hex(b); const b1 = Buffer.from(mod.encodeEvent({ eventId: 'x:1', sentAt: 1, clientid: 'x', payload: { v: 1 } })), b2 = Buffer.from(mod.encodeEvent({ eventId: 'x:1', sentAt: 1, clientid: 'x', payload: { v: 2 } }));
  be.deliver(A, 'x:1', sha(b1)); be.quarantineEvent(A, 'x:2');
  const service = createIngestConfirmationService({ evidence: be.evidence }); const mods = { service: { createIngestConfirmationService }, routes, limit };
  await withApi(mods, be, {}, async base => {
    const mine = mod.createHttpReconciliationClient({ baseUrl: base, auth: mod.createTestOnlyAuth('p-a') }), other = mod.createHttpReconciliationClient({ baseUrl: base, auth: mod.createTestOnlyAuth('p-b') }), ghost = mod.createHttpReconciliationClient({ baseUrl: base, auth: mod.createTestOnlyAuth('nobody') });
    assert.deepEqual(await mine.query('x:1', sha(b1)), { kind: 'status', status: 'processed' }); assert.deepEqual(await other.query('x:1', sha(b1)), { kind: 'status', status: 'not-found' });
    assert.deepEqual(await mine.query('x:1', sha(b2)), { kind: 'status', status: 'conflict' }); assert.deepEqual(await mine.query('x:2', H), { kind: 'status', status: 'quarantined' });
    assert.deepEqual(await ghost.query('x:1', sha(b1)), { kind: 'no-answer', reason: 'auth-denied' });
  });
  void service;
});

test('B18 MQTT port: clientId = device technical key on every connection, one connection at a time, PUBACK only as BROKER_ACCEPTED, lazy reopen', async () => {
  const seen = []; const clients = []; const factory = (url, opts) => { seen.push(opts); const h = {}; const c = { on: (e, l) => { h[e] = l; if (e === 'connect') setTimeout(() => l(), 0); }, publish: (t, p, o, cb) => setTimeout(() => cb(c.failNext ? new Error('x') : null), 0), end: (f, o, cb) => { h.close?.(); cb?.(); }, fire: e => h[e]?.() }; clients.push(c); return c; };
  const port = createMqttPublisherPort({ url: 'mqtt://x', technicalKey: KEY, username: 'u', password: 'TEST_ONLY', topic: 't', factory, ackTimeoutMs: 200, connectTimeoutMs: 200 });
  assert.equal(await port.publish('e1', Buffer.from('a')), true); assert.equal(port.connectionsOpen, 1); assert.equal(await port.publish('e1', Buffer.from('a')), true); assert.equal(seen.length, 1);
  clients[0].fire('close'); assert.equal(port.connectionsOpen, 0); assert.equal(await port.publish('e1', Buffer.from('a')), true); assert.equal(seen.length, 2);
  assert.ok(seen.every(o => o.clientId === KEY)); assert.equal(await Promise.all([port.publish('e2', Buffer.from('b')), port.publish('e3', Buffer.from('c'))]).then(r => r.every(Boolean)), true); assert.equal(seen.length, 2);
  clients[1].failNext = true; assert.equal(await port.publish('e4', Buffer.from('d')), false);
  const guard = mod.createSingleConnectionGuard(KEY); const rel = guard.acquire(); assert.throws(() => guard.acquire(), /CLIENT_ID_COLLISION/); rel(); assert.doesNotThrow(() => guard.acquire()); assert.throws(() => mod.createSingleConnectionGuard('bad id'), /INVALID_TECHNICAL_KEY/);
});

test('B19 productive defaults are BLOCKED: outbox policy, reconciliation auth; the reference is not composed in the backend', () => {
  assert.equal(DEFAULT_OUTBOX_POLICY.mode, 'BLOCKED'); assert.throws(() => mod.createReferencePublisher({ store: mod.createMemoryStore(), policy: DEFAULT_OUTBOX_POLICY, technicalKey: KEY, mqtt: {}, reconciliation: {} }), /BLOCKED/);
  for (const f of ['src/app.ts', 'src/http/infrastructure.ts']) assert.equal(/be14-01|reference-publisher/.test(readFileSync(new URL('../' + f, import.meta.url), 'utf8')), false, f);
  const src = readFileSync(new URL('../scripts/be14-01/reference-publisher.ts', import.meta.url), 'utf8'); assert.equal(/password\s*[:=]\s*['"][^'"]{4,}|Bearer [A-Za-z0-9]|mongodb\+srv/i.test(src), false); assert.match(src, /REFERENCE_IMPLEMENTATION_ONLY/);
});

test('B20 invariants hold on the real module (the mutation test kills each mutant)', async () => { assert.deepEqual(await checkPublisherInvariants(mod), []); });

test('B21 the E2E campaign wiring: real MQTT port, file outbox, backend restart, publisher restart from disk, conflict with a rogue outbox, cross-tenant probe, backend evidence cross-check', () => {
  const h = readFileSync(new URL('../scripts/audit-be13-11f-emqx-durability.ts', import.meta.url), 'utf8');
  for (const needle of ['BE14_01_TAG', 'createMqttPublisherPort', 'createRefFileStore(path)', "events.push({ at: 'backend-down' })", 'j14.holder.pub = j14.make()', 'CONFLICT_REQUIRES_REVIEW', 'confirmedWithoutBackendEvidence', 'eventsWithMoreThanOneMeasurement', "'emqx-user:lab-device-b'", 'e14-normal-']) assert.ok(h.includes(needle), needle);
  assert.match(h, /withLab\(\{ durable: true, flushIntervalMs: 1, writeBufferMaxItems: 1 \}/);
});
