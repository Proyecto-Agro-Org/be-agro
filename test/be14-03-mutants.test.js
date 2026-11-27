// BE14-03 — mutation check OF THE KIT: a publisher with a known defect (a mutated copy of the BE14-01 reference) must be REJECTED by the conformance kit with a clear failure code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { loadVectors } from '../dist/scripts/be14-03/catalog.js';
import { createReferenceAdapter } from '../dist/scripts/be14-03/reference-adapter.js';
import { exitCodeFor, EXIT, runConformance } from '../dist/scripts/be14-03/runner.js';

const LIB = 'dist/scripts/be14-01/reference-publisher.js';
const url = p => new URL('../' + p, import.meta.url);
const vectors = loadVectors(new URL('../test-support/publisher-conformance-vectors.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/%C3%A1/g, 'á'));
const load = async (patch, id) => {
  if (!patch) return import(url(LIB).href);
  const text = readFileSync(url(LIB), 'utf8'); assert.equal(text.split(patch[0]).length - 1, 1, 'mutation anchor must match exactly once: ' + patch[0].slice(0, 80));
  const copy = LIB.replace(/\.js$/, `.mut-${id}.js`); writeFileSync(url(copy), text.replace(patch[0], patch[1]));
  try { return await import(url(copy).href); } finally { rmSync(url(copy), { force: true }); }
};
const certify = async (patch, id, only) => { const ref = await load(patch, id); return runConformance({ vectors, mode: 'reference', adapterFactory: w => createReferenceAdapter(w, ref), only, perTestTimeoutMs: 30000 }); };
const FULL_ANCHOR = 'if (active() >= policy.capacity)' + String.fromCharCode(10) + ' '.repeat(12) + "return { result: 'REJECTED_OUTBOX_FULL' };", FULL_MUTANT = 'if (active() >= policy.capacity)' + String.fromCharCode(10) + ' '.repeat(12) + 'snap.entries.shift();';
const MUTANTS = [
  { id: 'M1', what: 'PUBACK counts as success', only: ['L1-02'], codes: ['PUBACK_AS_SUCCESS'], patch: ["move(e, 'publish-ok');", "move(e, 'publish-ok'); e.state = 'CONFIRMED';"] },
  { id: 'M2', what: 'a retry generates a new eventId (inside the published bytes)', only: ['L2-01'], codes: ['RETRY_CHANGED_IDENTITY', 'NOT_CONFIRMED'], patch: ["o.mqtt.publish(e.eventId, Buffer.from(e.payloadB64, 'base64'))", "o.mqtt.publish(e.eventId, e.publishAttempts > 0 ? Buffer.from(Buffer.from(e.payloadB64, 'base64').toString().replace(e.eventId, e.eventId + 'x')) : Buffer.from(e.payloadB64, 'base64'))"] },
  { id: 'M3', what: 'a retry modifies the bytes (new hash)', only: ['L2-01'], codes: ['RETRY_CHANGED_IDENTITY', 'NOT_CONFIRMED'], patch: ["o.mqtt.publish(e.eventId, Buffer.from(e.payloadB64, 'base64'))", "o.mqtt.publish(e.eventId, e.publishAttempts > 0 ? Buffer.concat([Buffer.from(e.payloadB64, 'base64'), Buffer.from(' ')]) : Buffer.from(e.payloadB64, 'base64'))"] },
  { id: 'M4', what: 'restart clears the outbox', only: ['L3-01'], codes: ['OUTBOX_LOST_ON_RESTART', 'RESTART_FAILED'], patch: ['let snap = o.store.load();', 'let snap = { nextSeq: 1, entries: [] };'] },
  { id: 'M5', what: '`pending` confirms', only: ['L1-03'], codes: ['NON_CONFIRMING_STATUS_ACCEPTED'], patch: ['counters.reconciliation_pending += 1;', "{ counters.reconciliation_pending += 1; finish(e, 'confirmed', label); persist(); return; }"] },
  { id: 'M6', what: 'conflict is retried indefinitely', only: ['L2-06'], codes: ['CONFLICT_NOT_TERMINAL', 'CONFLICT_RETRIED'], patch: ["a.status === 'conflict'", "a.status === 'never-conflict'"] },
  { id: 'M7', what: 'a confirmation about another eventId is accepted', only: ['L5-01'], codes: ['FOREIGN_CONFIRMATION_ACCEPTED'], patch: ['b.eventId !== eventId || ', ''] },
  { id: 'M8', what: 'a full outbox silently drops the oldest entry', only: ['L4-03'], codes: ['SILENT_DROP', 'NO_BACKPRESSURE'], patch: [FULL_ANCHOR, FULL_MUTANT] },
];
test('KMUT0 control: the unmutated reference passes the same selected tests', async () => { const r = await certify(null, 'c0', MUTANTS.flatMap(m => m.only)); assert.equal(r.totals.fail, 0, JSON.stringify(r.results.filter(x => x.status === 'FAIL'))); assert.equal(exitCodeFor(r), EXIT.OK); });
for (const m of MUTANTS) test(`${m.id} rejected by the kit — ${m.what}`, async () => {
  const r = await certify(m.patch, m.id, m.only); const failed = r.results.filter(x => x.status === 'FAIL');
  assert.ok(failed.length >= 1, `${m.id} survived: the kit certified a defective publisher`); assert.ok(failed.some(x => m.codes.includes(x.failureCode)), `${m.id}: unexpected failure codes ${JSON.stringify(failed.map(x => x.failureCode))}`);
  assert.equal(exitCodeFor(r), EXIT.FAIL); assert.match(r.verdict, /^CONFORMANCE FAIL/); assert.ok(failed.every(x => x.evidence && x.testId && x.level >= 0));          // clear, machine-readable evidence
});
