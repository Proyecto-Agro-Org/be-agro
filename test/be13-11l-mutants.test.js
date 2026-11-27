// BE13-11L — mutation check (5 mutants). One statement of the compiled module is rewritten, the mutated copy is imported and the invariants must flag it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { checkInboxInvariants } from '../test-support/be13-11l-invariants.js';

const SERVICE = 'dist/src/services/ingest-confirmation.service.js', EVIDENCE = 'dist/src/repositories/mongo-ingest-confirmation.evidence.js', MIGRATION = 'dist/scripts/be13-11l/inbox-eventid-migration.js';
const url = p => new URL('../' + p, import.meta.url);
const load = async (p, patch, tag) => {
  if (!patch) return import(url(p).href);
  const text = readFileSync(url(p), 'utf8'); assert.equal(text.split(patch[0]).length - 1, 1, 'mutation anchor must match exactly once: ' + patch[0].slice(0, 70));
  const copy = p.replace(/\.js$/, `.mut-${tag}.js`); writeFileSync(url(copy), text.replace(patch[0], patch[1]));
  try { return await import(url(copy).href); } finally { rmSync(url(copy), { force: true }); }
};
async function run(m) {
  const mods = { service: await load(SERVICE), evidence: await load(EVIDENCE), migration: await load(MIGRATION) };
  if (m) mods[m.module] = await load(m.path, m.patch, m.id);
  return checkInboxInvariants(mods.service, mods.evidence, mods.migration);
}
const MUTANTS = [
  { id: 'M1', what: 'a different payloadSha256 is not a conflict', module: 'service', path: SERVICE, kills: 'INV-1', patch: ["payloadHash === 'mismatch'", "payloadHash === 'never'"] },
  { id: 'M2', what: 'a legitimate retry (same hash twice) is flagged as conflict', module: 'service', path: SERVICE, kills: 'INV-2', patch: ['hashes.size === 1 && hashes.has(payloadSha256)', 'hashes.size === 0'] },
  { id: 'M3', what: 'the direct lookup drops the sourceId scope', module: 'evidence', path: EVIDENCE, kills: 'INV-3', patch: ['inbox.find({ realm, sourceId: scope.sourceId, eventId }', 'inbox.find({ realm, eventId }'] },
  { id: 'M4', what: 'legacy records are ignored', module: 'evidence', path: EVIDENCE, kills: 'INV-4', patch: ['if (legacyScan) {', 'if (false) {'] },
  { id: 'M5', what: 'the migration applies by default', module: 'migration', path: MIGRATION, kills: 'INV-5', patch: ["apply: argv.includes('--apply') && !argv.includes('--dry-run')", "apply: !argv.includes('--dry-run')"] },
];
test('L-MUT0 control: unmutated modules satisfy every invariant', async () => { assert.deepEqual(await run(null), []); });
for (const m of MUTANTS) test(`${m.id} killed — ${m.what}`, async () => { const v = await run(m); assert.ok(v.includes(m.kills), `${m.id} survived: ${JSON.stringify(v)}`); });
