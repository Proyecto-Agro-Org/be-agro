// BE13-11M — mutation check (6 mutants) over the compiled router, limiter and confirmation service.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { checkApiInvariants } from '../test-support/be13-11m-invariants.js';

const SERVICE = 'dist/src/services/ingest-confirmation.service.js', ROUTES = 'dist/src/routes/ingest-confirmation.routes.js', LIMIT = 'dist/src/iot/confirmation-rate-limit.js';
const url = p => new URL('../' + p, import.meta.url);
const load = async (p, patch, tag) => {
  if (!patch) return import(url(p).href);
  const text = readFileSync(url(p), 'utf8'); assert.equal(text.split(patch[0]).length - 1, 1, 'mutation anchor must match exactly once: ' + patch[0].slice(0, 70));
  const copy = p.replace(/\.js$/, `.mut-${tag}.js`); writeFileSync(url(copy), text.replace(patch[0], patch[1]));
  try { return await import(url(copy).href); } finally { rmSync(url(copy), { force: true }); }
};
async function run(m) {
  const mods = { service: await load(SERVICE), routes: await load(ROUTES), limit: await load(LIMIT) };
  if (m) mods[m.module] = await load(m.path, m.patch, m.id);
  return checkApiInvariants(mods);
}
const MUTANTS = [
  { id: 'M1', what: 'scope taken from the request (query sourceId)', module: 'routes', path: ROUTES, kills: 'INV-S1', patch: ['const scope = await options.authority.scopeOf(principal);', 'const scope0 = await options.authority.scopeOf(principal); const scope = scope0 && typeof request.query.sourceId === \'string\' ? { ...scope0, sourceId: request.query.sourceId } : scope0;'] },
  { id: 'M2', what: 'rate limit not enforced', module: 'routes', path: ROUTES, kills: 'INV-S2', patch: ['if (!limit.allowed) {', 'if (false) {'] },
  { id: 'M3', what: 'payloadSha256 format not validated', module: 'routes', path: ROUTES, kills: 'INV-S3', patch: ["typeof sha !== 'string' || !PAYLOAD_SHA256_PATTERN.test(sha)", "typeof sha !== 'string'"] },
  { id: 'M4', what: 'a BLOCKED authority can be composed', module: 'routes', path: ROUTES, kills: 'INV-S4', patch: ["options.authority.kind === 'BLOCKED'", 'false'] },
  { id: 'M5', what: 'a principal-scoped quarantine row is visible to any principal', module: 'service', path: SERVICE, kills: 'INV-S5', patch: ['r.principalReference === scope.principalReference', 'true'] },
  { id: 'M6', what: 'malformed requests leak the default error page', module: 'routes', path: ROUTES, kills: 'INV-S6', patch: ["response.status(400).json({ error: 'invalid-request' });", '_next(_error);'] },
];
test('S-MUT0 control: unmutated modules satisfy every invariant', async () => { assert.deepEqual(await run(null), []); });
for (const m of MUTANTS) test(`${m.id} killed — ${m.what}`, async () => { const v = await run(m); assert.ok(v.includes(m.kills), `${m.id} survived: ${JSON.stringify(v)}`); });
