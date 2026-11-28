// BE13-11J — offline tests of the publisher-side end-to-end confirmation (no broker, no Docker, no Mongo).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import express from 'express';
import { CONFIRMED_STATUSES, EVENT_ID_PATTERN } from '../dist/src/iot/ingest-confirmation.contracts.js';
import { createIngestConfirmationService } from '../dist/src/services/ingest-confirmation.service.js';
import { createIngestConfirmationRouter } from '../dist/src/routes/ingest-confirmation.routes.js';
import { createTokenBucketRateLimiter, PROPOSED_TEST_RATE_LIMIT } from '../dist/src/iot/confirmation-rate-limit.js';
import { DEFAULT_PUBLISHER_RETRY_POLICY, delayBefore, reconcilePublish } from '../dist/scripts/be13-11j/publisher-reconciler.js';
import { eventIdOfRawPayload } from '../dist/src/repositories/mongo-ingest-confirmation.evidence.js';
import { idempotencyDocumentId } from '../dist/src/repositories/mongo-measurement-persistence.repository.js';
import { A, B, H, H2, checkInvariants, createBackend, fastPolicy } from '../test-support/be13-11j-invariants.js';

const clock = () => { let n = 0; return { now: () => n, sleep: async ms => { n += ms; } }; };
const rig = (backend, scope, publishFn) => { const service = createIngestConfirmationService({ evidence: backend.evidence }), c = clock();
  return { service, deps: { publish: publishFn, confirm: async id => ({ ok: true, status: (await service.confirm(scope, id, H)).status }), sleep: c.sleep, now: c.now } }; };

test('J1 contract: closed status vocabulary, exactly three confirming statuses, eventId pattern', async () => {
  assert.deepEqual([...CONFIRMED_STATUSES].sort(), ['duplicate-confirmed', 'processed', 'received-durable']);
  for (const bad of ['', ' x', 'a/b', 'a'.repeat(129), '../x', 'x y']) assert.equal(EVENT_ID_PATTERN.test(bad), false, bad);
  const s = createIngestConfirmationService({ evidence: createBackend().evidence });
  await assert.rejects(() => s.confirm(A, '../x', H), TypeError);
  await assert.rejects(() => s.confirm(A, 'e1', 'xyz'), TypeError);
  await assert.rejects(() => s.confirm({ realm: 'test', sourceId: '' }, 'e1', H), TypeError);
  assert.throws(() => createIngestConfirmationService({ evidence: {} }), TypeError);
});

test('J2 success: a committed claim is `processed` with durable evidence and is frozen', async () => {
  const be = createBackend(); be.deliver(A, 'e1'); const r = await createIngestConfirmationService({ evidence: be.evidence }).confirm(A, 'e1', H);
  assert.equal(r.status, 'processed'); assert.equal(r.confirmed, true); assert.equal(r.evidence.claim, 'present'); assert.equal(r.evidenceVersion, 1);
  assert.ok(r.durableAt > 0); assert.equal(Object.isFrozen(r), true);
});

test('J3 pending (fail-closed): unavailable evidence is never confirmed; durable inbox evidence still counts', async () => {
  const be = createBackend(); const s = createIngestConfirmationService({ evidence: be.evidence });
  be.down.claims = be.down.inbox = be.down.quarantine = true;
  let r = await s.confirm(A, 'e2', H); assert.equal(r.status, 'pending'); assert.equal(r.confirmed, false); assert.equal(r.deliveries, null);
  be.down.inbox = be.down.quarantine = false; r = await s.confirm(A, 'e2', H); assert.equal(r.status, 'pending');           // claims unavailable + nothing else => still pending
  be.inbox.push({ realm: 'test', sourceId: A.sourceId, eventId: 'e2', persistedAt: 5, payloadSha256: H }); r = await s.confirm(A, 'e2', H);
  assert.equal(r.status, 'received-durable'); assert.equal(r.confirmed, true);                                           // durable inbox record is real backend evidence
});

test('J4 missing: every source answered and none holds the event => not-found (not success)', async () => {
  const r = await createIngestConfirmationService({ evidence: createBackend().evidence }).confirm(A, 'nope', H);
  assert.equal(r.status, 'not-found'); assert.equal(r.confirmed, false);
});

test('J5 duplicate: the same event admitted twice keeps ONE measurement and is `duplicate-confirmed`', async () => {
  const be = createBackend(); be.deliver(A, 'e3'); assert.equal((await createIngestConfirmationService({ evidence: be.evidence }).confirm(A, 'e3', H)).status, 'processed');
  be.deliver(A, 'e3'); const r = await createIngestConfirmationService({ evidence: be.evidence }).confirm(A, 'e3', H);
  assert.equal(r.status, 'duplicate-confirmed'); assert.equal(r.confirmed, true); assert.equal(r.deliveries, 2); assert.equal(be.measurementCount(), 1);
});

test('J6 quarantine: a quarantined event is a controlled non-success and wins over a durable inbox record', async () => {
  const be = createBackend(); be.inbox.push({ realm: 'test', sourceId: A.sourceId, eventId: 'e4', persistedAt: 1, payloadSha256: H }); be.quarantineEvent(A, 'e4');
  const r = await createIngestConfirmationService({ evidence: be.evidence }).confirm(A, 'e4', H); assert.equal(r.status, 'quarantined'); assert.equal(r.confirmed, false);
});

test('J7 cross-tenant: B asking about A\'s event gets the SAME answer as for an event that never existed (no existence leak), also against a leaky store', async () => {
  const be = createBackend(); be.deliver(A, 'secret-1'); const s = createIngestConfirmationService({ evidence: be.evidence });
  const foreign = await s.confirm(B, 'secret-1', H), never = await s.confirm(B, 'never-existed', H);
  assert.deepEqual({ ...foreign, eventId: 'x' }, { ...never, eventId: 'x' }); assert.equal(foreign.status, 'not-found');
  const leaky = createIngestConfirmationService({ evidence: { ...be.evidence, claims: async () => be.claims, inbox: async () => be.inbox, quarantine: async () => be.quarantine } });
  assert.equal((await leaky.confirm(B, 'secret-1', H)).status, 'not-found');
});

test('J8 reconciliation: baseline = one publish, PUBACK, confirmation, no retry', async () => {
  const be = createBackend(), calls = []; const { deps } = rig(be, A, async id => { calls.push(id); be.deliver(A, id); return true; });
  const r = await reconcilePublish('base-1', fastPolicy(), deps);
  assert.equal(r.outcome, 'CONFIRMED'); assert.equal(r.attempts, 1); assert.equal(calls.length, 1); assert.equal(be.measurementCount(), 1);
});

test('J9 F-E2 simulated: PUBACK but the backend never receives it => not-found, retry with the SAME eventId, then durable confirmation', async () => {
  const be = createBackend(), calls = []; const { deps } = rig(be, A, async (id, attempt) => { calls.push(id); if (attempt >= 2) be.deliver(A, id); return true; });
  const r = await reconcilePublish('fe2-1', fastPolicy(), deps);
  assert.equal(r.outcome, 'CONFIRMED'); assert.equal(r.attempts, 2); assert.deepEqual(calls, ['fe2-1', 'fe2-1']);
  assert.deepEqual(r.trail.map(t => [t.brokerAccepted, t.confirmation]), [[true, 'not-found'], [true, 'processed']]); assert.equal(be.measurementCount(), 1);
});

test('J10 duplicate after a lost confirmation: the first publish arrived, the answer did not; the retry creates NO second measurement', async () => {
  const be = createBackend(), service = createIngestConfirmationService({ evidence: be.evidence }); let q = 0, c = clock();
  const r = await reconcilePublish('dup-1', fastPolicy(), { publish: async id => { be.deliver(A, id); return true; }, sleep: c.sleep, now: c.now,
    confirm: async id => { q += 1; if (q === 1) throw new Error('timeout'); return { ok: true, status: (await service.confirm(A, id, H)).status }; } });
  assert.equal(r.outcome, 'CONFIRMED'); assert.equal(r.attempts, 2); assert.equal(r.finalConfirmation, 'duplicate-confirmed'); assert.equal(be.measurementCount(), 1);
});

test('J11 stale replay: re-delivering a processed eventId resolves idempotently and the publisher can still confirm', async () => {
  const be = createBackend(); be.deliver(A, 'old-1'); be.deliver(A, 'old-1'); be.deliver(A, 'old-1');
  const { deps } = rig(be, A, async () => true); const r = await reconcilePublish('old-1', fastPolicy(), deps);
  assert.equal(r.outcome, 'CONFIRMED'); assert.equal(be.measurementCount(), 1);
});

test('J12 quarantine: ends the loop as QUARANTINED (never success, no endless retry)', async () => {
  const be = createBackend(); be.quarantineEvent(A, 'q-1'); const { deps } = rig(be, A, async () => true);
  const r = await reconcilePublish('q-1', fastPolicy({ maxAttempts: 5 }), deps); assert.equal(r.outcome, 'QUARANTINED'); assert.equal(r.attempts, 1);
});

test('J13 backend unavailable: an unreachable confirmation endpoint is never success; the budget decides', async () => {
  const c = clock(); let published = 0;
  const r = await reconcilePublish('down-1', fastPolicy({ maxAttempts: 3 }), { publish: async () => { published += 1; return true; }, confirm: async () => { throw new Error('ECONNREFUSED'); }, sleep: c.sleep, now: c.now });
  assert.equal(r.outcome, 'UNCONFIRMED_EXPLICIT'); assert.equal(r.finalConfirmation, 'unreachable'); assert.equal(published, 3); assert.equal(r.brokerAcceptedAny, true);
});

test('J14 retry exhausted: by attempts and by elapsed time => UNCONFIRMED_EXPLICIT (not success, not declared lost)', async () => {
  const be = createBackend(); let { deps } = rig(be, A, async () => true);
  let r = await reconcilePublish('x-1', fastPolicy({ maxAttempts: 2 }), deps); assert.equal(r.outcome, 'UNCONFIRMED_EXPLICIT'); assert.equal(r.exhausted, 'max-attempts'); assert.equal(r.attempts, 2);
  ({ deps } = rig(be, A, async () => true));
  r = await reconcilePublish('x-2', fastPolicy({ maxAttempts: 10, initialDelayMs: 100, backoffFactor: 1, maxDelayMs: 100, maxElapsedMs: 250 }), deps);
  assert.equal(r.outcome, 'UNCONFIRMED_EXPLICIT'); assert.equal(r.exhausted, 'max-elapsed'); assert.ok(r.attempts < 10);
});

test('J15 retry policy: productive default is BLOCKED, invalid values are rejected, backoff is capped', async () => {
  assert.equal(DEFAULT_PUBLISHER_RETRY_POLICY.mode, 'BLOCKED');
  const be = createBackend(); const { deps } = rig(be, A, async () => true);
  await assert.rejects(() => reconcilePublish('p-1', DEFAULT_PUBLISHER_RETRY_POLICY, deps), /PUBLISHER_RETRY_POLICY_BLOCKED/);
  for (const bad of [{ maxAttempts: 0 }, { maxAttempts: 1.5 }, { maxAttempts: 99 }, { initialDelayMs: -1 }, { backoffFactor: 0.5 }, { maxElapsedMs: 0 }]) await assert.rejects(() => reconcilePublish('p-2', fastPolicy(bad), deps), /INVALID/);
  const p = fastPolicy({ initialDelayMs: 100, backoffFactor: 2, maxDelayMs: 300 }); assert.deepEqual([1, 2, 3, 4].map(n => delayBefore(p, n)), [100, 200, 300, 300]);
});

test('J16 same eventId on every attempt, never a derived one', async () => {
  const be = createBackend(), seen = []; const { deps } = rig(be, A, async id => { seen.push(id); return true; });
  await reconcilePublish('same-1', fastPolicy({ maxAttempts: 4 }), deps); assert.deepEqual(seen, ['same-1', 'same-1', 'same-1', 'same-1']);
});

test('J17 PUBACK never decides: a publisher that only ever sees PUBACK ends UNCONFIRMED', async () => {
  const be = createBackend(); const { deps } = rig(be, A, async () => true); const r = await reconcilePublish('puback-1', fastPolicy(), deps);
  assert.equal(r.outcome, 'UNCONFIRMED_EXPLICIT'); assert.equal(r.brokerAcceptedAny, true);
});

test('J18 invariants hold on the real modules', async () => {
  assert.deepEqual(await checkInvariants({ createService: createIngestConfirmationService, reconcilePublish, idempotencyDocumentId }), []);
});

// ---- HTTP reconciliation endpoint (TEST_ONLY router, mounted on a throwaway app — never on app.ts)
const HEADERS = { 'x-principal': 'emqx-user:lab-device-a' };
async function withServer(be, fn, authorityOverrides = {}) {
  const service = createIngestConfirmationService({ evidence: be.evidence });
  const principals = { 'emqx-user:lab-device-a': A, 'emqx-user:lab-device-b': B };
  const authority = { authenticate: async req => req.get('x-principal') ?? null, scopeOf: async p => principals[p] ?? null, ...authorityOverrides };
  const app = express(); app.use(createIngestConfirmationRouter({ mode: 'TEST_ONLY', service, authority, rateLimiter: createTokenBucketRateLimiter(PROPOSED_TEST_RATE_LIMIT) }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
}

test('J19 HTTP: 401 unauthenticated, 403 without scope, 400 bad eventId, 200 otherwise, no-store', async () => {
  const be = createBackend(); be.deliver(A, 'h-1');
  await withServer(be, async base => {
    assert.equal((await fetch(base + '/ingest-confirmations/h-1?payloadSha256=' + H)).status, 401);
    assert.equal((await fetch(base + '/ingest-confirmations/h-1?payloadSha256=' + H, { headers: { 'x-principal': 'emqx-user:unknown' } })).status, 403);
    assert.equal((await fetch(base + '/ingest-confirmations/..%2Fx?payloadSha256=' + H, { headers: HEADERS })).status, 400);
    const ok = await fetch(base + '/ingest-confirmations/h-1?payloadSha256=' + H, { headers: HEADERS }); assert.equal(ok.status, 200); assert.equal(ok.headers.get('cache-control'), 'no-store');
    const body = await ok.json(); assert.equal(body.status, 'processed'); assert.equal(body.confirmed, true); assert.equal('measurementId' in body, false);
  });
});

test('J20 HTTP cross-tenant: B gets the same 200/not-found body for A\'s event as for an unknown one; the scope cannot be widened from the request', async () => {
  const be = createBackend(); be.deliver(A, 'h-2');
  await withServer(be, async base => {
    const B_HEADERS = { 'x-principal': 'emqx-user:lab-device-b' };
    const foreign = await (await fetch(base + '/ingest-confirmations/h-2?payloadSha256=' + H, { headers: B_HEADERS })).json(), unknown = await (await fetch(base + '/ingest-confirmations/zzz?payloadSha256=' + H, { headers: B_HEADERS })).json();
    assert.equal(foreign.status, 'not-found'); assert.deepEqual({ ...foreign, eventId: 'x' }, { ...unknown, eventId: 'x' });
    const widened = await (await fetch(base + '/ingest-confirmations/h-2?sourceId=lab-source-a&realm=test&payloadSha256=' + H, { headers: B_HEADERS })).json(); assert.equal(widened.status, 'not-found');
    const own = await (await fetch(base + '/ingest-confirmations/h-2?payloadSha256=' + H, { headers: HEADERS })).json(); assert.equal(own.status, 'processed');
  });
});

test('J21 HTTP backend unavailable: 503 (never a confirming answer) and evidence failure => pending', async () => {
  const be = createBackend(); be.deliver(A, 'h-3');
  await withServer(be, async base => { assert.equal((await fetch(base + '/ingest-confirmations/h-3?payloadSha256=' + H, { headers: HEADERS })).status, 503); }, { scopeOf: async () => { throw new Error('authority down'); } });
  be.down.claims = be.down.inbox = be.down.quarantine = true;
  await withServer(be, async base => { const b = await (await fetch(base + '/ingest-confirmations/h-3?payloadSha256=' + H, { headers: HEADERS })).json(); assert.equal(b.status, 'pending'); assert.equal(b.confirmed, false); });
});

test('J22 the router refuses to exist outside TEST_ONLY and is not composed anywhere in the productive app', () => {
  const service = createIngestConfirmationService({ evidence: createBackend().evidence });
  for (const mode of ['PRODUCTION', undefined]) assert.throws(() => createIngestConfirmationRouter({ mode, service, authority: {}, rateLimiter: createTokenBucketRateLimiter(PROPOSED_TEST_RATE_LIMIT) }), /TEST_ONLY/);
  assert.throws(() => createIngestConfirmationRouter({ mode: 'APPROVED', service, authority: {}, rateLimiter: createTokenBucketRateLimiter(PROPOSED_TEST_RATE_LIMIT) }), /NOT_APPROVED/);
  for (const f of ['../src/app.ts', '../src/http/infrastructure.ts', '../src/http/protect-application.ts']) assert.equal(/ingest-confirmation/.test(readFileSync(new URL(f, import.meta.url), 'utf8')), false, f);
});

test('J23 the Mongo evidence adapter scopes every read by realm + sourceId, reads with majority, and never writes', () => {
  const src = readFileSync(new URL('../src/repositories/mongo-ingest-confirmation.evidence.ts', import.meta.url), 'utf8');
  assert.ok((src.match(/sourceId: scope\.sourceId/g) ?? []).length >= 4);
  assert.match(src, /readConcern: \{ level: 'majority' \}/);
  assert.equal(/insertOne|updateOne|deleteOne|replaceOne|bulkWrite|createIndex|\.drop\(/.test(src), false);
  assert.equal(eventIdOfRawPayload({ buffer: Buffer.from('{"eventId":"abc-1"}') }), 'abc-1');
  assert.equal(eventIdOfRawPayload({ buffer: Buffer.from('not json') }), null); assert.equal(eventIdOfRawPayload(null), null);
});

test('J24 the EMQX campaign wiring: real router + real Mongo evidence, original PUBACK kept as BROKER_ACCEPTED only, retries re-publish the same id, policy is bounded', () => {
  const h = readFileSync(new URL('../scripts/audit-be13-11f-emqx-durability.ts', import.meta.url), 'utf8');
  assert.match(h, /BE13_11J_TAG/); assert.match(h, /createIngestConfirmationRouter\(\{ mode: 'TEST_ONLY'/); assert.match(h, /createMongoIngestConfirmationEvidence/);
  assert.match(h, /if \(attempt === 1\) return p\.acked\.has\(eid\)/); assert.match(h, /publish\(\[eid\], \{ window: 1 \}\)/);
  assert.match(h, /maxAttempts: 4/); assert.match(h, /maxElapsedMs: 60000/);
  assert.match(h, /exactly one explicit outcome/); assert.match(h, /eventsWithMoreThanOneMeasurement/);
  assert.match(h, /withLab\(\{ durable: true, flushIntervalMs: 1, writeBufferMaxItems: 1 \}/);     // historical broker config untouched
});

test('J25 (11Q) a hung evidence source is bounded: it answers `pending` within the timeout, never confirms, never hangs', async () => {
  const be = createBackend(); be.deliver(A, 'hang-1'); const hang = () => new Promise(() => {});
  const svc = createIngestConfirmationService({ evidence: { ...be.evidence, claims: hang, inbox: hang }, evidenceTimeoutMs: 60 });
  const t = Date.now(); const r = await svc.confirm(A, 'hang-1', H); assert.ok(Date.now() - t < 1500); assert.equal(r.status, 'pending'); assert.equal(r.confirmed, false); assert.deepEqual([r.evidence.claim, r.evidence.inbox], ['unavailable', 'unavailable']);
  assert.throws(() => createIngestConfirmationService({ evidence: be.evidence, evidenceTimeoutMs: 0 }), TypeError);
});
