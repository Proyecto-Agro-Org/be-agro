// BE14-02 — mutation check (5 mutants) over the compiled modules that touch eventId.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { checkEventIdInvariants } from '../test-support/be14-02-invariants.js';

const P = { eventId: 'dist/src/iot/event-id.js', contracts: 'dist/src/iot/ingest-confirmation.contracts.js', parser: 'dist/src/iot/broker-payload.parser.js', service: 'dist/src/services/ingest-confirmation.service.js', publisher: 'dist/scripts/be14-01/reference-publisher.js' };
const url = p => new URL('../' + p, import.meta.url);
const load = async (key, patch, id) => {
  if (!patch) return import(url(P[key]).href);
  const text = readFileSync(url(P[key]), 'utf8'); assert.equal(text.split(patch[0]).length - 1, 1, 'mutation anchor must match exactly once: ' + patch[0].slice(0, 80));
  const copy = P[key].replace(/\.js$/, `.mut-${id}.js`); writeFileSync(url(copy), text.replace(patch[0], patch[1]));
  try { return await import(url(copy).href); } finally { rmSync(url(copy), { force: true }); }
};
async function run(m) {
  const mods = {}; for (const k of Object.keys(P)) mods[k] = await load(k);
  if (m) mods[m.module] = await load(m.module, m.patch, m.id);
  return checkEventIdInvariants({ eventIdMod: mods.eventId, contracts: mods.contracts, parser: mods.parser, service: mods.service, publisher: mods.publisher });
}
const MUTANTS = [
  { id: 'M1', what: 'the API accepts "." again (more permissive than the parser)', module: 'contracts', kills: 'INV-E1', patch: ["export { EVENT_ID_PATTERN } from './event-id.js';", 'export const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/;'] },
  { id: 'M2', what: 'the parser uses its own (permissive) regex', module: 'parser', kills: 'INV-E2', patch: ['eventId: eventIdSchema,', 'eventId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/),'] },
  { id: 'M3', what: 'the eventId is silently normalised', module: 'eventId', kills: 'INV-E3', patch: ["throw new TypeError('INVALID_EVENT_ID'); return value; }", "throw new TypeError('INVALID_EVENT_ID'); return value.toLowerCase(); }"] },
  { id: 'M4', what: 'the lookup ignores the validation', module: 'service', kills: 'INV-E4', patch: ["if (typeof eventId !== 'string' || !EVENT_ID_PATTERN.test(eventId))", 'if (false)'] },
  { id: 'M5', what: 'the publisher generates a non-canonical id', module: 'publisher', kills: 'INV-E5', patch: ['`${o.technicalKey}:${snap.nextSeq}`', '`${o.technicalKey}.${snap.nextSeq}`'] },
];
test('EID-MUT0 control: the unmutated modules satisfy every invariant', async () => { assert.deepEqual(await run(null), []); });
for (const m of MUTANTS) test(`${m.id} killed — ${m.what}`, async () => { const v = await run(m); assert.ok(v.includes(m.kills), `${m.id} survived: ${JSON.stringify(v)}`); });
