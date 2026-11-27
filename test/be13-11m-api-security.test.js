// BE13-11M — security matrix of the reconciliation API (offline: in-memory evidence, real router/service/limiter).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createIngestConfirmationService } from '../dist/src/services/ingest-confirmation.service.js';
import * as routes from '../dist/src/routes/ingest-confirmation.routes.js';
import * as limit from '../dist/src/iot/confirmation-rate-limit.js';
import { quarantineEntrySchema, quarantineIdFor } from '../dist/src/repositories/mongo-ingestion-quarantine.store.js';
import { quarantineIndexes, quarantineValidator } from '../dist/src/models/ingestion-quarantine.models.js';
import { runWithQuarantineScope, currentQuarantineScope } from '../dist/src/iot/quarantine-reconcile-scope.js';
import { A, B, H, H2, createBackend } from '../test-support/be13-11j-invariants.js';
import { authority, withApi } from '../test-support/be13-11m-invariants.js';

const mods = { service: { createIngestConfirmationService }, routes, limit };
const P = { 'x-principal': 'p-a' };
const q = (id, sha = H) => `/ingest-confirmations/${id}?payloadSha256=${sha}`;
const rawGet = (base, path, headers = P) => fetch(base + path, { headers });

test('S1 auth: no principal => 401; unknown principal => 403; nothing reaches the evidence', async () => {
  const be = createBackend(); be.deliver(A, 'e1'); let reads = 0; const inner = be.evidence.claims; be.evidence.claims = async (...a) => { reads += 1; return inner(...a); };
  await withApi(mods, be, {}, async base => {
    assert.equal((await rawGet(base, q('e1'), {})).status, 401); assert.equal((await rawGet(base, q('e1'), { 'x-principal': 'ghost' })).status, 403); assert.equal(reads, 0);
    assert.equal((await rawGet(base, q('e1'))).status, 200); assert.equal(reads, 1);
  });
});

test('S2 productive defaults are BLOCKED: no authority, no rate-limit policy, no approved mode can be composed', () => {
  const service = createIngestConfirmationService({ evidence: createBackend().evidence }), rl = limit.createTokenBucketRateLimiter(limit.PROPOSED_TEST_RATE_LIMIT);
  assert.equal(limit.DEFAULT_RATE_LIMIT_POLICY.mode, 'BLOCKED'); assert.throws(() => limit.createTokenBucketRateLimiter(limit.DEFAULT_RATE_LIMIT_POLICY), /BLOCKED/);
  assert.throws(() => routes.createIngestConfirmationRouter({ mode: 'TEST_ONLY', service, authority: routes.BLOCKED_CONFIRMATION_AUTHORITY, rateLimiter: rl }), /AUTH_BLOCKED/);
  assert.throws(() => routes.createIngestConfirmationRouter({ mode: 'TEST_ONLY', service, authority, rateLimiter: { policy: limit.DEFAULT_RATE_LIMIT_POLICY, consume: () => ({ allowed: true, retryAfterMs: 0 }) } }), /RATE_POLICY_BLOCKED/);
  assert.throws(() => routes.createIngestConfirmationRouter({ mode: 'TEST_ONLY', service, authority, rateLimiter: undefined }), /RATE_POLICY_BLOCKED/);
  assert.throws(() => routes.createIngestConfirmationRouter({ mode: 'APPROVED', service, authority, rateLimiter: rl }), /NOT_APPROVED/);
  assert.throws(() => routes.createIngestConfirmationRouter({ mode: 'PRODUCTION', service, authority, rateLimiter: rl }), /TEST_ONLY/);
  assert.equal(limit.PROPOSED_TEST_RATE_LIMIT.mode, 'TEST_ONLY');                      // the 11K proposal is never an approved value
});

test('S3 input validation: malformed eventId / sha / hostile unicode / injection => 400, nothing is looked up', async () => {
  const be = createBackend(); let reads = 0; const inner = be.evidence.inbox; be.evidence.inbox = async (...a) => { reads += 1; return inner(...a); };
  const badIds = ['a%20b', 'a%2Fb', '..%2F..%2Fetc', 'a%00b', '%0d%0aSet-Cookie:x', '%E2%80%AEevent', '%EF%BC%A1%EF%BC%A2', '%C3%A9clair', 'a'.repeat(129), '%24ne', '%7B%22%24gt%22%3A%22%22%7D', 'x%27%20OR%201%3D1', '%3Cscript%3E'];
  await withApi(mods, be, { policy: { ...limit.PROPOSED_TEST_RATE_LIMIT, perPrincipalBurst: 1000, globalBurst: 1000 } }, async base => {
    for (const id of badIds) assert.equal((await rawGet(base, q(id))).status, 400, 'eventId ' + id);
    for (const sha of ['', 'xyz', 'G'.repeat(64), 'A'.repeat(64), H + '0', H.slice(1), '%00', '%24ne']) assert.equal((await rawGet(base, `/ingest-confirmations/ok-1?payloadSha256=${sha}`)).status, 400, 'sha ' + sha);
    assert.equal((await rawGet(base, '/ingest-confirmations/ok-1')).status, 400);                                                      // sha is mandatory
    assert.equal((await rawGet(base, q('ok-1') + '&payloadSha256=' + H)).status, 400);                                                   // a repeated parameter is an array, never a string
    for (const alone of ['payloadSha256[]=' + H, 'payloadSha256[$ne]=x', 'payloadSha256[$gt]=']) assert.equal((await rawGet(base, '/ingest-confirmations/ok-1?' + alone)).status, 400, alone);   // operator-style keys are not the parameter
    assert.equal(reads, 0);
  });
});

test('S4 oversized input: a long URL is refused (414) before authentication or lookup', async () => {
  const be = createBackend(); let auth = 0; const a2 = { ...authority, authenticate: async r => { auth += 1; return authority.authenticate(r); } };
  await withApi(mods, be, { authority: a2 }, async base => {
    const r = await rawGet(base, q('a'.repeat(5000))); assert.equal(r.status, 414); assert.equal(auth, 0);
    assert.equal((await rawGet(base, q('ok') + '&pad=' + 'x'.repeat(2000))).status, 414);
  });
});

test('S5 forged headers/params never change the scope; only the authenticated principal does', async () => {
  const be = createBackend(); be.deliver(A, 'e-forge');
  await withApi(mods, be, {}, async base => {
    const forged = { 'x-principal': 'p-b', 'x-source-id': A.sourceId, 'x-realm': 'production', 'x-forwarded-for': '10.0.0.1', 'x-forwarded-user': 'p-a', authorization: 'Bearer p-a', cookie: 'principal=p-a' };
    assert.equal((await (await rawGet(base, q('e-forge') + '&sourceId=' + A.sourceId + '&realm=test&principal=p-a', forged)).json()).status, 'not-found');
    assert.equal((await (await rawGet(base, q('e-forge'))).json()).status, 'processed');
  });
});

test('S6 enumeration: foreign, inexistent and wrong-hash-for-other-tenant answers have the same shape; a conflict is a 200 domain answer without the stored hash', async () => {
  const be = createBackend(); be.deliver(A, 'e-enum', H);
  await withApi(mods, be, {}, async base => {
    const PB = { 'x-principal': 'p-b' };
    const foreign = await (await rawGet(base, q('e-enum'), PB)).json(), never = await (await rawGet(base, q('never-existed'), PB)).json();
    assert.deepEqual({ ...foreign, eventId: 'x' }, { ...never, eventId: 'x' });
    const r = await rawGet(base, q('e-enum', H2)); const body = await r.json(); const text = JSON.stringify(body);
    assert.equal(r.status, 200); assert.equal(body.status, 'conflict'); assert.equal(body.confirmed, false); assert.equal(text.includes(H), false); assert.equal(text.includes(H2), false);
  });
});

test('S7 rate limiting: per-principal and global caps, Retry-After, unauthenticated floods share one bucket, refills with time', async () => {
  let t = 0; const be = createBackend();
  const policy = { mode: 'TEST_ONLY', perPrincipalRatePerSecond: 2, perPrincipalBurst: 3, globalRatePerSecond: 100, globalBurst: 5, maxKeys: 4 };
  await withApi(mods, be, { policy, clock: () => t }, async base => {
    const codes = []; for (let i = 0; i < 5; i += 1) codes.push((await rawGet(base, q('e'))).status); assert.deepEqual(codes, [200, 200, 200, 429, 429]);
    const r = await rawGet(base, q('e')); assert.equal(r.status, 429); assert.ok(Number(r.headers.get('retry-after')) >= 1);
    assert.equal((await rawGet(base, q('e'), { 'x-principal': 'p-b' })).status, 200);                          // another principal has its own bucket
    t += 1000; assert.equal((await rawGet(base, q('e'))).status, 200);                                           // refilled
    const unauth = []; for (let i = 0; i < 6; i += 1) unauth.push((await rawGet(base, q('e'), {})).status); assert.ok(unauth.includes(429) && unauth.includes(401));
  });
});

test('S8 token bucket unit: burst, refill, global refusal refunds the principal, bounded keys, invalid policy rejected', () => {
  let t = 0; const l = limit.createTokenBucketRateLimiter({ mode: 'TEST_ONLY', perPrincipalRatePerSecond: 1, perPrincipalBurst: 2, globalRatePerSecond: 1, globalBurst: 3, maxKeys: 2 }, () => t);
  assert.deepEqual([l.consume('a').allowed, l.consume('a').allowed, l.consume('a').allowed], [true, true, false]);
  assert.equal(l.consume('b').allowed, true); assert.equal(l.consume('c').allowed, false);                       // global (3) exhausted by a,a,b => c refused...
  t += 5000; assert.equal(l.consume('c').allowed, true);
  for (const bad of [{ perPrincipalRatePerSecond: 0 }, { perPrincipalBurst: 0 }, { maxKeys: 0 }, { globalBurst: -1 }, { perPrincipalRatePerSecond: NaN }]) assert.throws(() => limit.createTokenBucketRateLimiter({ ...limit.PROPOSED_TEST_RATE_LIMIT, ...bad }), /INVALID/);
  const small = limit.createTokenBucketRateLimiter({ ...limit.PROPOSED_TEST_RATE_LIMIT, maxKeys: 2 }, () => 0); for (const k of ['k1', 'k2', 'k3', 'k4']) assert.equal(small.consume(k).allowed, true);
});

test('S9 backend failures are safe: 503 without internals, audit events carry no secrets, an observer cannot break the answer', async () => {
  const be = createBackend(); be.deliver(A, 'e-safe'); const events = [];
  await withApi(mods, be, { authority: { ...authority, scopeOf: async () => { throw new Error('SECRET_DSN mongodb://u:p@h'); } } }, async base => {
    const r = await rawGet(base, q('e-safe')); const t = await r.text(); assert.equal(r.status, 503); assert.equal(/SECRET|mongodb|at /.test(t), false); assert.deepEqual(JSON.parse(t), { error: 'unavailable' });
  });
  await withApi(mods, be, {}, async (base, evs) => { await rawGet(base, q('e-safe')); await rawGet(base, q('e-safe', 'zz')); await rawGet(base, q('e-safe'), {}); events.push(...evs); });
  assert.deepEqual(events.map(e => e.outcome), ['ok', 'invalid-input', 'unauthenticated']);
  for (const e of events) { const t = JSON.stringify(e); assert.equal(t.includes(H), false); assert.equal(/principal|payload/i.test(t), false); }
  const service = createIngestConfirmationService({ evidence: be.evidence });
  const app = (await import('express')).default(); app.use(routes.createIngestConfirmationRouter({ mode: 'TEST_ONLY', service, authority, rateLimiter: limit.createTokenBucketRateLimiter(limit.PROPOSED_TEST_RATE_LIMIT), onEvent: () => { throw new Error('observer down'); } }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  try { assert.equal((await rawGet(`http://127.0.0.1:${server.address().port}`, q('e-safe'))).status, 200); } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});

test('S10 quarantine scope: new fields are optional + validated, never part of the dedupe identity; ambient scope is context-local', async () => {
  const entry = { realm: 'test', stage: 'mapper', sourceId: null, operation: null, eventId: null, field: null, device: null, reasonCode: 'mapper-rejected', cause: null, retryClass: 'validation', fingerprint: null, documentDigest: H };
  const legacy = quarantineEntrySchema.parse(entry); assert.equal('principalReference' in legacy, false);
  const scoped = quarantineEntrySchema.parse({ ...entry, principalReference: 'emqx-user:lab-device-a', payloadSha256: H, declaredEventId: 'e-1' });
  assert.equal(quarantineIdFor(legacy), quarantineIdFor(scoped));
  for (const bad of [{ payloadSha256: 'xyz' }, { declaredEventId: '../x' }, { principalReference: 'a b' }, { principalReference: '' }]) assert.throws(() => quarantineEntrySchema.parse({ ...entry, ...bad }));
  assert.equal(currentQuarantineScope(), undefined);
  const seen = await Promise.all([1, 2].map(n => runWithQuarantineScope({ principalReference: 'p' + n, payloadSha256: H, declaredEventId: 'e' + n }, async () => { await new Promise(r => setTimeout(r, 5 * (3 - n))); return currentQuarantineScope().principalReference; })));
  assert.deepEqual(seen, ['p1', 'p2']); assert.equal(currentQuarantineScope(), undefined);
  const p = quarantineValidator.$jsonSchema.properties; assert.ok(p.principalReference && p.payloadSha256 && p.declaredEventId);
  assert.deepEqual(quarantineIndexes.find(i => i.name === 'quarantine_realm_principal_event').key, { realm: 1, principalReference: 1, declaredEventId: 1 });
  const boundary = readFileSync(new URL('../src/services/mqtt-ingestion-boundary.service.ts', import.meta.url), 'utf8'); assert.match(boundary, /runWithQuarantineScope\(\{ principalReference: provenance\.principalReference, payloadSha256: payloadFingerprint, declaredEventId: eventId \}/);
});

test('S11 the endpoint is not composed anywhere productive and the router file never reads scope-bearing request fields', () => {
  for (const f of ['../src/app.ts', '../src/http/infrastructure.ts', '../src/http/protect-application.ts']) assert.equal(/ingest-confirmation|confirmation-rate-limit/.test(readFileSync(new URL(f, import.meta.url), 'utf8')), false, f);
  const src = readFileSync(new URL('../src/routes/ingest-confirmation.routes.ts', import.meta.url), 'utf8');
  assert.equal(/request\.(headers|get\(|body|cookies|ip)\b/.test(src), false);                                  // only params.eventId and query.payloadSha256 are read from the request
  assert.equal(/request\.query\.(?!payloadSha256)/.test(src), false);
});
