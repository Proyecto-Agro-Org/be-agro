// BE13-11M — API security invariants shared by the regular tests and the mutation test. Returns the list of VIOLATED invariant ids.
import { once } from 'node:events';
import express from 'express';
import { A, B, H, H2, createBackend } from './be13-11j-invariants.js';

const PRINCIPALS = { 'p-a': { ...A, principalReference: 'emqx-user:lab-device-a' }, 'p-b': { ...B, principalReference: 'emqx-user:lab-device-b' } };
export const authority = { kind: 'TEST_ONLY', authenticate: async req => req.get('x-principal') ?? null, scopeOf: async p => PRINCIPALS[p] ?? null };
export async function withApi(mods, backend, o, fn) {
  const service = mods.service.createIngestConfirmationService({ evidence: backend.evidence });
  const limiter = mods.limit.createTokenBucketRateLimiter(o.policy ?? mods.limit.PROPOSED_TEST_RATE_LIMIT, o.clock);
  const events = [];
  const app = express(); app.use(mods.routes.createIngestConfirmationRouter({ mode: 'TEST_ONLY', service, authority: o.authority ?? authority, rateLimiter: limiter, onEvent: e => events.push(e) }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { return await fn(`http://127.0.0.1:${server.address().port}`, events); } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
}
const get = (base, path, headers = {}) => fetch(base + path, { headers });

export async function checkApiInvariants(mods) {
  const bad = [];
  // INV-S1: the scope comes ONLY from the authenticated principal (query/header "scope" parameters change nothing).
  { const be = createBackend(); be.deliver(A, 'e-s1');
    await withApi(mods, be, {}, async base => { const r = await (await get(base, `/ingest-confirmations/e-s1?payloadSha256=${H}&sourceId=${A.sourceId}&realm=test`, { 'x-principal': 'p-b', 'x-source-id': A.sourceId, 'x-realm': 'test' })).json(); if (r.status !== 'not-found') bad.push('INV-S1'); }); }
  // INV-S2: rate limiting is enforced (burst exhausted => 429 + Retry-After).
  { const be = createBackend(); const policy = { mode: 'TEST_ONLY', perPrincipalRatePerSecond: 1, perPrincipalBurst: 2, globalRatePerSecond: 100, globalBurst: 100, maxKeys: 10 };
    await withApi(mods, be, { policy, clock: () => 0 }, async base => { const codes = []; let ra = null; for (let i = 0; i < 4; i += 1) { const r = await get(base, `/ingest-confirmations/e-s2?payloadSha256=${H}`, { 'x-principal': 'p-a' }); codes.push(r.status); ra = r.headers.get('retry-after') ?? ra; }
      if (!(codes[0] === 200 && codes[1] === 200 && codes[2] === 429 && ra !== null)) bad.push('INV-S2'); }); }
  // INV-S3: a malformed payloadSha256 is rejected as input (400), never forwarded to the service.
  { const be = createBackend();
    await withApi(mods, be, {}, async base => { for (const sha of ['xyz', 'A'.repeat(64), H.slice(1)]) { const r = await get(base, `/ingest-confirmations/e-s3?payloadSha256=${sha}`, { 'x-principal': 'p-a' }); if (r.status !== 400) bad.push('INV-S3'); } }); }
  // INV-S4: a BLOCKED authority (the productive default) can never be composed.
  { let threw = false; try { mods.routes.createIngestConfirmationRouter({ mode: 'TEST_ONLY', service: {}, authority: mods.routes.BLOCKED_CONFIRMATION_AUTHORITY, rateLimiter: mods.limit.createTokenBucketRateLimiter(mods.limit.PROPOSED_TEST_RATE_LIMIT) }); } catch { threw = true; } if (!threw) bad.push('INV-S4'); }
  // INV-S5: a principal-scoped quarantine row (no sourceId yet) is visible to its owner and to nobody else.
  { const be = createBackend(); be.evidence.quarantine = async () => be.quarantine;      // a store that leaks every row: the service must still filter by owner
    be.quarantine.push({ realm: 'test', sourceId: null, principalReference: PRINCIPALS['p-a'].principalReference, eventId: null, declaredEventId: 'e-s5', payloadSha256: H });
    await withApi(mods, be, {}, async base => { const own = await (await get(base, `/ingest-confirmations/e-s5?payloadSha256=${H}`, { 'x-principal': 'p-a' })).json(), other = await (await get(base, `/ingest-confirmations/e-s5?payloadSha256=${H}`, { 'x-principal': 'p-b' })).json();
      if (own.status !== 'quarantined' || other.status !== 'not-found') bad.push('INV-S5'); }); }
  // INV-S6: malformed requests never surface a stack trace or HTML.
  { const be = createBackend();
    await withApi(mods, be, {}, async base => { const r = await get(base, `/ingest-confirmations/%E0%A4%A?payloadSha256=${H}`, { 'x-principal': 'p-a' }); const t = await r.text(); if (r.status !== 400 || /at .*\.js|<html|Error:/i.test(t)) bad.push('INV-S6'); }); }
  void H2;
  return bad;
}
