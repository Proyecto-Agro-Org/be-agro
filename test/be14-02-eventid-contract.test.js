// BE14-02 — ONE eventId definition for the whole pipeline. A single table drives every layer: canonical validator, payload parser, reconciliation API, Mongo validators,
// zod schemas, migration classifier, reference publisher and the real boundary pipeline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import * as eventIdMod from '../dist/src/iot/event-id.js';
import * as contracts from '../dist/src/iot/ingest-confirmation.contracts.js';
import * as parser from '../dist/src/iot/broker-payload.parser.js';
import * as service from '../dist/src/services/ingest-confirmation.service.js';
import * as routes from '../dist/src/routes/ingest-confirmation.routes.js';
import * as limit from '../dist/src/iot/confirmation-rate-limit.js';
import * as publisher from '../dist/scripts/be14-01/reference-publisher.js';
import { brokerInboxValidator } from '../dist/src/models/broker-inbox.models.js';
import { quarantineValidator } from '../dist/src/models/ingestion-quarantine.models.js';
import { quarantineEntrySchema } from '../dist/src/repositories/mongo-ingestion-quarantine.store.js';
import { classifyInboxRecord } from '../dist/scripts/be13-11l/inbox-eventid-migration.js';
import { idempotencyDocumentId } from '../dist/src/repositories/mongo-measurement-persistence.repository.js';
import { structuredLogLine } from '../dist/src/iot/confirmation-observability.js';
import { boundarySetup, delivery, envelope } from '../test-support/be13-11a-broker.fixtures.js';
import { A, H, createBackend } from '../test-support/be13-11j-invariants.js';
import { withApi } from '../test-support/be13-11m-invariants.js';
import { checkEventIdInvariants, envelopeBytes } from '../test-support/be14-02-invariants.js';

const LIMITS = { maxBytes: 4096, maxDepth: 8, maxKeys: 64, maxStringLength: 256 };
const VALID = ['a', 'Z', '0', '123', 'device-01:1', 'device_01:2', 'ESP32-AGRO-001:42', 'a:b_c-d', '550e8400-e29b-41d4-a716-446655440000', 'AbC:Def', 'x'.repeat(128)];
const INVALID = ['', ' ', ' a', 'a ', 'a b', 'a\tb', 'a\nb', 'a\r\nb', 'a\u0000b', 'a.b', '.a', 'a.', '..', 'a/b', 'a\\b', '../x', '..\\x', '%2e%2e', 'a%20b', 'é', 'ａbc', '日本', 'a‮b', 'a​b', 'x'.repeat(129), '-a', '_a', ':a', 'a;b', "a'b", 'a"b', '$ne', '{"$gt":""}', '<script>', "a'; DROP TABLE x;--", 'a%00b', 'a\u0085b'];
const ALL = [...VALID.map(id => [id, true]), ...INVALID.map(id => [id, false])];
const show = id => JSON.stringify(id).slice(0, 60);

test('E1 canonical validator: the table, exact identity (the SAME string comes back), stable input-free error', () => {
  assert.equal(eventIdMod.EVENT_ID_PATTERN_SOURCE, '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$'); assert.deepEqual([eventIdMod.EVENT_ID_MIN_LENGTH, eventIdMod.EVENT_ID_MAX_LENGTH], [1, 128]);
  for (const [id, ok] of ALL) {
    assert.equal(eventIdMod.isValidEventId(id), ok, show(id));
    if (ok) assert.equal(eventIdMod.validateEventId(id), id, 'no normalisation: ' + show(id));
    else { let msg = ''; try { eventIdMod.validateEventId(id); } catch (e) { msg = e.message; assert.ok(e instanceof TypeError); } assert.equal(msg, 'INVALID_EVENT_ID'); assert.equal(msg.includes(id) && id.length > 0, false); }
    assert.equal(eventIdMod.eventIdSchema.safeParse(id).success, ok, 'zod ' + show(id));
  }
  for (const nonString of [null, undefined, 5, {}, [], ['a']]) assert.equal(eventIdMod.isValidEventId(nonString), false);
  assert.equal(eventIdMod.isValidEventId('CASE'), true); assert.notEqual('CASE', 'case');                                                         // case sensitive
});

test('E2 every layer agrees with the table: parser, API pattern, Mongo validators, quarantine schema, migration classifier, reference publisher', () => {
  const inboxRe = new RegExp(brokerInboxValidator.$jsonSchema.properties.eventId.pattern), qRe = new RegExp(quarantineValidator.$jsonSchema.properties.declaredEventId.anyOf[0].pattern);
  const entry = { realm: 'test', stage: 'mapper', sourceId: null, operation: null, eventId: null, field: null, device: null, reasonCode: 'mapper-rejected', cause: null, retryClass: 'validation', fingerprint: null, documentDigest: H };
  for (const [id, ok] of ALL) {
    assert.equal(parser.parseBrokerPayload(envelopeBytes(id), LIMITS).ok, ok, 'parser ' + show(id));
    assert.equal(contracts.EVENT_ID_PATTERN.test(id), ok, 'API pattern ' + show(id)); assert.equal(inboxRe.test(id), ok, 'inbox validator ' + show(id)); assert.equal(qRe.test(id), ok, 'quarantine validator ' + show(id));
    assert.equal(quarantineEntrySchema.safeParse({ ...entry, declaredEventId: id }).success, ok, 'quarantine zod ' + show(id));
    const bytes = Buffer.from(JSON.stringify({ eventId: id })); const c = classifyInboxRecord({ rawPayload: { buffer: bytes }, rawPayloadSha256: createHash('sha256').update(bytes).digest('hex') });
    assert.equal(c.kind === 'backfillable', ok, 'migration ' + show(id));
    let made = true; try { publisher.encodeEvent({ eventId: id, sentAt: 1, clientid: 'dev-1', payload: {} }); } catch { made = false; } assert.equal(made, ok, 'publisher ' + show(id));
  }
  assert.equal(eventIdMod.EVENT_ID_PATTERN_SOURCE, brokerInboxValidator.$jsonSchema.properties.eventId.pattern);
});

test('E3 the reconciliation API answers exactly the same set: 200 for valid, a stable 400 (no input echoed) for invalid, and NO lookup runs for invalid ids', async () => {
  const be = createBackend(); let lookups = 0; for (const k of ['claims', 'inbox', 'quarantine']) { const f = be.evidence[k]; be.evidence[k] = async (...a) => { lookups += 1; return f(...a); }; }
  const mods = { service, routes, limit }; const big = { ...limit.PROPOSED_TEST_RATE_LIMIT, perPrincipalBurst: 10_000, globalBurst: 10_000 };
  await withApi({ ...mods, service: { createIngestConfirmationService: service.createIngestConfirmationService } }, be, { policy: big }, async base => {
    for (const [id, ok] of ALL) {
      if (id === '') continue;                                                                    // an empty segment is not a route at all (404), covered below
      const before = lookups; if (id === '..') { const rr = await fetch(base + '/ingest-confirmations/..?payloadSha256=' + H, { headers: { 'x-principal': 'p-a' } }); assert.ok([400, 404].includes(rr.status)); assert.equal(lookups, before); continue; }   // WHATWG URL collapses '..' client-side
      const r = await fetch(base + '/ingest-confirmations/' + encodeURIComponent(id) + '?payloadSha256=' + H, { headers: { 'x-principal': 'p-a' } }); const text = await r.text();
      if (ok) { assert.equal(r.status, 200, show(id)); assert.ok(lookups > before); } else { assert.equal(r.status, 400, show(id)); assert.deepEqual(JSON.parse(text), { error: 'invalid-event-id' }); assert.equal(lookups, before, 'no lookup for ' + show(id)); assert.equal(text.includes(encodeURIComponent(id)) && id.length > 1, false); }
    }
    assert.equal((await fetch(base + '/ingest-confirmations/?payloadSha256=' + H, { headers: { 'x-principal': 'p-a' } })).status, 404);
    assert.equal((await fetch(base + '/ingest-confirmations/' + 'x'.repeat(128) + '?payloadSha256=' + H, { headers: { 'x-principal': 'p-a' } })).status, 200);       // the max length fits the URL budget
    assert.equal((await fetch(base + '/ingest-confirmations/%E0%A4%A?payloadSha256=' + H, { headers: { 'x-principal': 'p-a' } })).status, 400);                  // malformed percent-encoding: still no 500
  });
  for (const id of INVALID) await assert.rejects(() => service.createIngestConfirmationService({ evidence: be.evidence }).confirm(A, id, H), TypeError);
});

test('E4 the REAL boundary pipeline: a canonical id is persisted EXACTLY (case preserved) and processed once; an invalid id is rejected before anything is stored or quarantined', async () => {
  const f = envelope();
  for (const id of ['Device-01:1', 'device_01:2', 'x'.repeat(128)]) {
    const s = await boundarySetup(); const bytes = Buffer.from(JSON.stringify({ ...f, eventId: id })); const d = delivery({ payload: bytes });
    const r1 = await s.admission.admit(d, { mode: 'persist-and-process' }), r2 = await s.admission.admit(d, { mode: 'persist-and-process' });          // retry: same eventId, same payload
    assert.deepEqual(r1.results.map(x => x.result.status), ['accepted']); assert.equal([...s.inbox.rows.values()].every(row => row.eventId === id), true); assert.equal(s.persistence.measurements.size, 1, 'retry never duplicates: ' + show(id));
    assert.equal(r2.results[0].result.status, 'duplicate');
  }
  for (const id of ['bad.id', 'a b', 'x'.repeat(129), 'é', 'a/b', '../x']) {
    const s = await boundarySetup(); const r = await s.admission.admit(delivery({ payload: Buffer.from(JSON.stringify({ ...f, eventId: id })) }), { mode: 'persist-and-process' });
    assert.equal(r.status, 'rejected'); assert.equal(r.reasonCode, 'payload-malformed'); assert.deepEqual([s.inbox.rows.size, s.quarantine.rows.size, s.persistence.measurements.size], [0, 0, 0], show(id));    // never a reconcilable identity
  }
});

test('E5 idempotency identity is untouched: the claim id still derives from the exact eventId (golden value), different case = different identity', () => {
  const k = { realm: 'test', sourceId: 'lab-source-a', operation: 'measurement', eventId: 'device-01:1', field: 'temperature' };
  assert.equal(idempotencyDocumentId(k), createHash('sha256').update(JSON.stringify(['be13-06/v1', 'test', 'lab-source-a', 'measurement', 'device-01:1', 'temperature']), 'utf8').digest('hex'));
  assert.notEqual(idempotencyDocumentId(k), idempotencyDocumentId({ ...k, eventId: 'Device-01:1' }));
});

test('E6 BE14-01 publisher: generated ids are canonical, golden vectors keep their ids and hashes', () => {
  const vectors = JSON.parse(readFileSync(new URL('../test-support/be14-01-golden-vectors.json', import.meta.url), 'utf8')).vectors;
  assert.ok(vectors.length >= 5); for (const v of vectors) { assert.equal(eventIdMod.isValidEventId(v.eventId), true, v.name); assert.equal(createHash('sha256').update(Buffer.from(v.bytes, 'utf8')).digest('hex'), v.payloadSha256, v.name); assert.equal(parser.parseBrokerPayload(Buffer.from(v.bytes, 'utf8'), LIMITS).ok, true, v.name); }
  assert.equal(eventIdMod.isValidEventId('ESP32-AGRO-001:1'), true); assert.equal(eventIdMod.isValidEventId('device-01:1'), true);
});

test('E7 logs never echo a hostile eventId; only canonical ids reach a log line', () => {
  for (const id of INVALID) { const line = structuredLogLine({ ts: 1, component: 'confirmation-api', event: 'x', eventId: id }); assert.equal('eventId' in JSON.parse(line), false, show(id)); assert.equal(/[\u0000-\u001f]/.test(line), false); }
  assert.equal(JSON.parse(structuredLogLine({ ts: 1, event: 'x', eventId: 'device-01:1' })).eventId, 'device-01:1');
});

test('E8 ONE definition: no source or script defines an eventId charset of its own (the old permissive literal is gone everywhere)', () => {
  const walk = d => readdirSync(new URL('../' + d, import.meta.url), { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(d + '/' + e.name) : [d + '/' + e.name]);
  for (const f of [...walk('src'), ...walk('scripts')].filter(f => f.endsWith('.ts'))) {
    const text = readFileSync(new URL('../' + f, import.meta.url), 'utf8'); assert.equal(text.includes('A-Za-z0-9:_.-]{0,127}'), false, f + ' still carries the permissive eventId pattern');         // (SAFE_WORD of the log helper is a different, shorter word pattern)
    if (f !== 'src/iot/event-id.ts') for (const line of text.split('\n')) if (/eventId/i.test(line) && /regex\(|new RegExp\(|\.test\(/.test(line) && /A-Za-z0-9/.test(line)) assert.fail(f + ' redefines an eventId pattern: ' + line.trim().slice(0, 120));
  }
});

test('E9 invariants hold on the real modules (the mutation test kills each mutant)', async () => { assert.deepEqual(await checkEventIdInvariants({ eventIdMod, contracts, parser, service, publisher }), []); });
