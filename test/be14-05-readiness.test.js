// BE14-05 — readiness gate checks: the consolidated requirement spec, the traceability matrix and the kit agree; the three real gaps found while consolidating stay closed; the capacity tool is arithmetic only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { CATALOG, loadVectors } from '../dist/scripts/be14-03/catalog.js';
import { createReferenceAdapter } from '../dist/scripts/be14-03/reference-adapter.js';
import { exitCodeFor, runConformance } from '../dist/scripts/be14-03/runner.js';
import { requiredTestIds } from '../dist/scripts/be14-04/verdict.js';
import { storageRequirement, networkRequirement } from '../dist/scripts/be14-05/capacity.js';

const url = p => new URL('../' + p, import.meta.url);
const read = p => readFileSync(url(p), 'utf8');
const vectors = loadVectors(url('test-support/publisher-conformance-vectors.json').pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/%C3%A1/g, 'á'));
const spec = read('ESPECIFICACION_BE14_FUTURE_PUBLISHER_REQUIREMENTS.md'), matrix = read('MATRIZ_BE14_REQUIREMENT_TO_CONFORMANCE.md');
const CLASSES = ['MUST', 'SHOULD', 'PENDING_PRODUCT_DECISION', 'PLATFORM_SPECIFIC'];
const specRows = [...spec.matchAll(/^\| (REQ-[A-Z]+-\d+) \| (.+?) \| (MUST|SHOULD|PENDING_PRODUCT_DECISION|PLATFORM_SPECIFIC)[^|]*\| (.+?) \|$/gm)].map(m => ({ id: m[1], cls: m[3], verification: m[4] }));
const matrixRows = [...matrix.matchAll(/^\| (REQ-[A-Z]+-\d+) \| (MUST|SHOULD|PENDING_PRODUCT_DECISION|PLATFORM_SPECIFIC) \|(.+)$/gm)].map(m => ({ id: m[1], cls: m[2], rest: m[3] }));
const catalogIds = new Set(CATALOG.map(t => t.id));

test('R1 every requirement has exactly ONE of the four classes (no ambiguous category) and a unique id', () => {
  assert.ok(specRows.length >= 70, 'spec rows parsed: ' + specRows.length); assert.equal(new Set(specRows.map(r => r.id)).size, specRows.length); assert.ok(specRows.every(r => CLASSES.includes(r.cls)));
  assert.ok(!/\|\s*(TBD|OPEN|MAYBE|OPTIONAL)\s*\|/.test(spec.split('## 2.')[0]));
});
test('R2 traceability is complete: same ids and classes in spec and matrix; every cited L*-** test exists in the catalogue', () => {
  assert.deepEqual(matrixRows.map(r => r.id).sort(), specRows.map(r => r.id).sort()); for (const r of matrixRows) assert.equal(r.cls, specRows.find(s => s.id === r.id).cls, r.id);
  for (const id of [...(spec + matrix).matchAll(/\bL[0-5]-\d\d\b/g)].map(m => m[0])) assert.ok(catalogIds.has(id), 'unknown test id ' + id);
});
test('R3 every MUST has a verification (KIT test, REF test or an explicit REVIEW); MUSTs without a kit test are exactly the manual-review ones', () => {
  const musts = specRows.filter(r => r.cls === 'MUST'); assert.ok(musts.length >= 50);
  for (const m of musts) assert.ok(/KIT:|REF:|REVIEW/.test(m.verification), m.id + ' has no verification: ' + m.verification);
  const manual = musts.filter(m => !/KIT:/.test(m.verification)).map(m => m.id).sort(); assert.deepEqual(manual, ['REQ-OBS-02', 'REQ-SEC-01']);
  const withKit = musts.filter(m => /KIT:/.test(m.verification)).length; assert.ok(matrix.includes(`**MUST con test del kit**: ${withKit} de ${musts.length}`), `matrix must state ${withKit} of ${musts.length}`);
});
test('R4 PENDING_PRODUCT_DECISION requirements carry no verification and no decision is marked DECIDED', () => {
  for (const r of specRows.filter(x => x.cls === 'PENDING_PRODUCT_DECISION')) assert.match(r.verification, /^—$/, r.id);
  assert.ok(!/\|\s*DECIDED\s*\|/.test(spec)); assert.ok(/productionReady=false/.test(spec));
});

// ---- the three real gaps found while consolidating (G1-G3)
const certify = async (adapterFactory, only) => runConformance({ vectors, mode: 'reference', adapterFactory, only, perTestTimeoutMs: 30000 });
test('G1 QoS 1 is verified: a publisher using QoS 0 FAILS L1-01 (QOS_NOT_1); the reference passes', async () => {
  const ok = await certify(w => createReferenceAdapter(w), ['L1-01']); assert.equal(ok.totals.fail, 0, JSON.stringify(ok.results));
  const qos0 = w => createReferenceAdapter({ mqttFactory: (u, o) => { const c = w.mqttFactory(u, o), p = c.publish; c.publish = (t, b, opt, cb) => p(t, b, { ...opt, qos: 0 }, cb); return c; } });
  const bad = await certify(qos0, ['L1-01']); assert.equal(bad.results[0].failureCode, 'QOS_NOT_1'); assert.equal(exitCodeFor(bad), 1);
});
test('G2 eventId reuse with other bytes is verified: a publisher that accepts it FAILS L0-09 (EVENTID_REUSED_WITH_OTHER_BYTES)', async () => {
  const LIB = 'dist/scripts/be14-01/reference-publisher.js', text = read(LIB), anchor = "{ result: 'REJECTED_EVENT_ID_REUSED_WITH_OTHER_BYTES' }"; assert.equal(text.split(anchor).length - 1, 1);
  const copy = LIB.replace(/\.js$/, '.mut-g2.js'); writeFileSync(url(copy), text.replace(anchor, "{ result: 'ALREADY_PRESENT', eventId }"));
  let ref; try { ref = await import(url(copy).href); } finally { rmSync(url(copy), { force: true }); }
  const ok = await certify(w => createReferenceAdapter(w), ['L0-09']); assert.equal(ok.totals.fail, 0, JSON.stringify(ok.results));
  const bad = await certify(w => createReferenceAdapter(w, ref), ['L0-09']); assert.ok(['EVENTID_REUSED_WITH_OTHER_BYTES', 'REUSE_NOT_IDEMPOTENT'].includes(bad.results[0].failureCode), JSON.stringify(bad.results[0]));
});
test('G3 every non-optional test (incl. L4-03 / L4-04) is required for PASS EXTERNAL', () => { const req = requiredTestIds(CATALOG); for (const id of ['L4-03', 'L4-04', 'L2-04', 'L3-02']) assert.ok(req.includes(id), id); assert.ok(!req.includes('L0-05')); });

// ---- capacity tool: arithmetic only, no hardware, no default values
test('C1 storage formula = eventsPerDay × offlineDays × (payload + metadata) × safetyFactor', () => {
  const r = storageRequirement({ eventsPerDay: 1000, avgPayloadBytes: 200, offlineDays: 2, metadataOverheadBytes: 100, safetyFactor: 1.5 }); assert.equal(r.requiredBytes, 1000 * 2 * 300 * 1.5); assert.equal(r.estimatedRecordCount, 3000); assert.equal(r.requiredMiB, Math.round((900000 / 1048576) * 1000) / 1000);
});
test('C2 network formula includes publish + reconciliation overhead and the retry factor', () => {
  const r = networkRequirement({ eventsPerDay: 86400, avgPayloadBytes: 200, publishOverheadBytes: 50, reconciliationOverheadBytes: 250, retryFactor: 0.5 }); assert.equal(r.bytesPerEvent, 750); assert.equal(r.bytesPerSecondAverage, 750);
});
test('C3 invalid inputs are rejected; there are no default values', () => {
  for (const bad of [{ eventsPerDay: -1 }, { avgPayloadBytes: NaN }, { offlineDays: 'x' }, { safetyFactor: 0.5 }]) assert.throws(() => storageRequirement({ eventsPerDay: 1, avgPayloadBytes: 1, offlineDays: 1, metadataOverheadBytes: 0, safetyFactor: 1, ...bad }), RangeError);
  assert.throws(() => storageRequirement({}), RangeError); assert.throws(() => networkRequirement({ eventsPerDay: 1 }), RangeError);
});
