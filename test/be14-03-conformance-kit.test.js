// BE14-03 — tests of the publisher conformance kit itself (vectors, runner semantics, CLI, external config/bridge, report).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isValidEventId } from '../dist/src/iot/event-id.js';
import { parseBrokerPayload } from '../dist/src/iot/broker-payload.parser.js';
import { CATALOG, loadVectors } from '../dist/scripts/be14-03/catalog.js';
import { createReferenceAdapter } from '../dist/scripts/be14-03/reference-adapter.js';
import { EXIT, exitCodeFor, humanSummary, runConformance } from '../dist/scripts/be14-03/runner.js';
import { createStdioBridgeAdapter } from '../dist/scripts/be14-03/adapter.js';
import { validateExternalConfig } from '../dist/scripts/be14-03/external-config.js';
import { integratedResults } from '../dist/scripts/be14-03/integrated.js';
import { main, parseCliArgs } from '../dist/scripts/be14-03/cli.js';

const VEC = new URL('../test-support/publisher-conformance-vectors.json', import.meta.url), vectors = loadVectors(VEC.pathname.replace(/^\/([A-Za-z]:)/, '$1').replaceAll('%20', ' ').replace(/%C3%A1/g, 'á'));
const BRIDGE = new URL('../test-support/be14-03-mock-bridge.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/%C3%A1/g, 'á');
const tmp = () => mkdtempSync(join(tmpdir(), 'kit-'));
const run = async (o = {}) => runConformance({ vectors, mode: 'reference', adapterFactory: w => createReferenceAdapter(w), ...o });
const logger = () => { const lines = []; return { lines, out: s => lines.push(s) }; };

test('K1 vectors: machine-readable, independent hash, parser results, and the required eventId categories', () => {
  assert.equal(vectors.version, 1); assert.ok(vectors.payloads.length >= 5); assert.equal(vectors.eventIdPattern, '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$');
  for (const p of vectors.payloads) { const b = Buffer.from(p.bytes, 'utf8'); assert.equal(createHash('sha256').update(b).digest('hex'), p.payloadSha256, p.caseId); assert.equal(parseBrokerPayload(b, { maxBytes: 4096, maxDepth: 8, maxKeys: 64, maxStringLength: 256 }).ok, p.expectedParser.ok); assert.equal(isValidEventId(p.eventId), p.valid); assert.equal(p.pipelineAccepted, true); assert.ok(p.technicalKey); }
  const ids = new Map(vectors.eventIds.map(e => [e.caseId.split('-').slice(1).join('-'), e]));
  for (const need of ['min', 'max-128', 'letters', 'digits', 'colon', 'underscore', 'hyphen', 'technicalKey-seq', 'dot', 'slash', 'backslash', 'space', 'unicode', 'leading-colon', 'leading-underscore', 'leading-hyphen', '129', 'empty']) assert.ok(ids.has(need), 'missing eventId vector: ' + need);
  for (const e of vectors.eventIds) assert.equal(isValidEventId(e.eventId), e.valid, e.caseId);
  assert.ok(vectors.invalidPayloads.length >= 5 && vectors.deviceTimestamps.some(d => d.value === 'OMIT') && vectors.topics.some(t => t.valid) && vectors.topics.some(t => !t.valid));
});

test('K2 MODE A: the reference publisher passes the whole catalog (L0-L5) and the report is machine-readable', async () => {
  const progress = []; const r = await run({ onProgress: x => progress.push(x.testId) });
  assert.equal(r.totals.fail, 0, JSON.stringify(r.results.filter(x => x.status === 'FAIL'))); assert.equal(r.totals.notRun, 0); assert.equal(r.totals.pass, CATALOG.length); assert.equal(progress.length, CATALOG.length);
  assert.deepEqual(r.levels, { L0: 'PASS', L1: 'PASS', L2: 'PASS', L3: 'PASS', L4: 'PASS', L5: 'PASS' }); assert.match(r.verdict, /^CONFORMANCE PASS LOCAL \(L0-L5\)/); assert.equal(r.productionCertified, false); assert.equal(exitCodeFor(r), EXIT.OK);
  for (const x of r.results) { assert.ok(x.testId && [0, 1, 2, 3, 4, 5].includes(x.level) && ['PASS', 'FAIL', 'SKIP', 'NOT_RUN'].includes(x.status) && typeof x.durationMs === 'number' && 'evidence' in x && 'failureCode' in x && x.group === 'offline'); }
  assert.ok(new Set(r.results.map(x => x.testId)).size === r.results.length); assert.match(humanSummary(r), /PASS \d+ · FAIL 0/); assert.match(r.disclaimer, /NOT production certification/);
  assert.equal(/password|secret|token/i.test(JSON.stringify(r)), false);
});

test('K3 runner semantics: SKIP only for an optional capability or a pending human decision; a missing REQUIRED capability is a FAIL; hangs are bounded', async () => {
  const noCaps = w => { const a = createReferenceAdapter(w); return { ...a, capabilities: async () => [] }; };
  const r = await run({ adapterFactory: noCaps, only: ['L0-05', 'L0-06', 'L3-02', 'L4-03', 'L4-04'] }); const by = Object.fromEntries(r.results.map(x => [x.testId, x]));
  assert.deepEqual([by['L0-05'].status, by['L0-05'].skipReason], ['SKIP', 'OPTIONAL_CAPABILITY_ABSENT:explicit-event-input,canonical-serialization']);
  assert.deepEqual([by['L0-06'].status, by['L0-06'].failureCode], ['FAIL', 'CAPABILITY_REQUIRED:explicit-event-input']); assert.equal(by['L3-02'].status, 'FAIL');
  assert.deepEqual([by['L4-03'].status, by['L4-03'].skipReason], ['SKIP', 'DECISION_PENDING:outbox-capacity']); assert.equal(by['L4-04'].skipReason, 'DECISION_PENDING:retry-policy-values');
  assert.equal(r.totals.fail, 2); assert.equal(exitCodeFor(r), EXIT.FAIL); assert.equal(r.verdict, 'CONFORMANCE FAIL');
  for (const x of r.results.filter(x => x.status === 'SKIP')) assert.match(x.skipReason, /^(OPTIONAL_CAPABILITY_ABSENT|DECISION_PENDING)/);
  const hang = w => { const a = createReferenceAdapter(w); return { ...a, advance: () => new Promise(() => {}) }; };
  const h = await run({ adapterFactory: hang, only: ['L1-01'], perTestTimeoutMs: 300 }); assert.equal(h.results[0].failureCode, 'TEST_TIMEOUT'); assert.equal(h.results[0].status, 'FAIL');
  const boom = w => { const a = createReferenceAdapter(w); return { ...a, boot: async () => ({ ok: false, failure: 'DEAD' }) }; };
  await assert.rejects(() => run({ adapterFactory: boom, only: ['L1-01'] }), /INFRASTRUCTURE_UNAVAILABLE|BOOT_FAILED/);
});

test('K4 MODE B is prepared but never pretends: external mode marks world-dependent tests NOT_RUN and the verdict is INCOMPLETE (exit 4)', async () => {
  const r = await run({ mode: 'external', only: ['L0-02', 'L0-03', 'L1-01', 'L3-02'] }); const by = Object.fromEntries(r.results.map(x => [x.testId, x]));
  assert.equal(by['L1-01'].status, 'NOT_RUN'); assert.match(by['L1-01'].skipReason, /^EXTERNAL_MQTT_WORLD_NOT_IMPLEMENTED/); assert.equal(by['L3-02'].status, 'NOT_RUN'); assert.equal(by['L0-02'].status, 'PASS');
  assert.equal(r.verdict, 'CONFORMANCE INCOMPLETE'); assert.equal(exitCodeFor(r), EXIT.INCOMPLETE); assert.equal(r.levels.L1, 'INCOMPLETE');
});

test('K5 external config: no inline secrets, local MQTT only, canonical identity, env variables must exist', () => {
  const ok = { technicalKey: 'ESP32-AGRO-001', mqtt: { url: 'mqtt://127.0.0.1:1883', usernameEnv: 'KIT_USER', passwordEnv: 'KIT_PASS' }, reconciliation: { principal: 'p-a', tokenEnv: 'KIT_TOKEN' }, scope: { foreignPrincipal: 'p-b' }, bridge: { command: 'node', args: ['bridge.mjs'] } };
  const env = { KIT_USER: 'u', KIT_PASS: 'x', KIT_TOKEN: 't' }; assert.equal(validateExternalConfig(ok, env).technicalKey, 'ESP32-AGRO-001');
  const bads = [[{ ...ok, mqtt: { ...ok.mqtt, password: 'hunter2' } }, /inline secret/], [{ ...ok, reconciliation: { ...ok.reconciliation, token: 'abc' } }, /inline secret/], [{ ...ok, mqtt: { url: 'mqtt://broker.example.com:1883' } }, /LOCAL/], [{ ...ok, technicalKey: 'bad.key' }, /technicalKey/], [{ ...ok, mqtt: { ...ok.mqtt, passwordEnv: 'NOT_SET' } }, /environment variable/],
    [{ ...ok, bridge: {} }, /bridge/], [{ ...ok, reconciliation: {} }, /principal/], [null, /not an object/], [{ ...ok, mqtt: { url: 'not a url' } }, /URL/]];
  for (const [cfg, re] of bads) assert.throws(() => validateExternalConfig(cfg, env), re);
  try { validateExternalConfig({ ...ok, mqtt: { ...ok.mqtt, password: 'hunter2' } }, env); } catch (e) { assert.equal(e.message.includes('hunter2'), false); }              // the error never echoes the secret
  assert.equal(/password"\s*:\s*"[^E"]/.test(readFileSync(new URL('../be14-03.external.example.json', import.meta.url), 'utf8')), false);
});

test('K6 stdio bridge protocol: capabilities handshake, boot/create/inspect over a real child process, timeouts and exits are bounded errors', async () => {
  const a = createStdioBridgeAdapter({ command: process.execPath, args: [BRIDGE], timeoutMs: 800 });
  try { assert.deepEqual(await a.capabilities(), ['explicit-event-input']); assert.deepEqual(await a.boot({ technicalKey: 'ESP32-AGRO-001', mqttUrl: 'x', reconciliationUrl: 'y', principal: 'p', topic: 't' }), { ok: true });
    const c = await a.createEvent({ payload: { t: 1 } }); assert.deepEqual(c, { result: 'accepted', eventId: 'ESP32-AGRO-001:1' }); assert.equal((await a.inspectPending())[0].eventId, 'ESP32-AGRO-001:1'); assert.equal((await a.createEvent({ payload: { t: 1 }, eventId: 'a.b' })).result, 'rejected'); } finally { a.close(); }
  const hung = createStdioBridgeAdapter({ command: process.execPath, args: [BRIDGE], timeoutMs: 300 }); process.env.MOCK_BRIDGE_HANG = 'capabilities';
  try { await assert.rejects(() => hung.capabilities(), /BRIDGE_TIMEOUT/); } finally { delete process.env.MOCK_BRIDGE_HANG; hung.close(); }
  const dead = createStdioBridgeAdapter({ command: 'definitely-not-a-command-xyz', timeoutMs: 500 }); await assert.rejects(() => dead.capabilities()); dead.close();
});

test('K7 external run through the mock bridge: world-independent tests run, the rest is NOT_RUN, nothing is faked (exit 4)', async () => {
  const bridges = []; const factory = () => { const b = createStdioBridgeAdapter({ command: process.execPath, args: [BRIDGE], timeoutMs: 3000 }); bridges.push(b); return b; };
  try { const r = await run({ mode: 'external', adapterFactory: factory, levels: [0] }); const by = Object.fromEntries(r.results.map(x => [x.testId, x]));
    assert.equal(by['L0-01'].status, 'PASS'); assert.equal(by['L0-02'].status, 'PASS'); assert.equal(by['L0-03'].status, 'PASS'); assert.equal(by['L0-06'].status, 'PASS'); assert.equal(by['L0-09'].status, 'PASS'); assert.equal(by['L0-04'].status, 'NOT_RUN'); assert.equal(by['L0-08'].status, 'NOT_RUN'); assert.equal(by['L0-05'].status, 'SKIP');
    assert.equal(exitCodeFor(r), EXIT.INCOMPLETE); assert.notEqual(r.verdict.startsWith('CONFORMANCE PASS'), true); } finally { bridges.forEach(b => b.close()); }
});

test('K8 CLI: exit codes for invalid configuration, missing external config, unreadable vectors/integrated report, infrastructure; report file and subsets', async () => {
  const L = logger(); assert.equal(await main(['--mode', 'bogus'], {}, L.out), EXIT.INVALID_CONFIG); assert.equal(await main(['--levels', '9'], {}, L.out), EXIT.INVALID_CONFIG);
  const ext = logger(); assert.equal(await main(['--mode', 'external'], {}, ext.out), EXIT.INVALID_CONFIG); assert.match(ext.lines.join('\n'), /nothing was run/);
  const dir = tmp(), badCfg = join(dir, 'c.json'); writeFileSync(badCfg, JSON.stringify({ technicalKey: 'ESP32-AGRO-001', mqtt: { url: 'mqtt://127.0.0.1:1', password: 'hunter2' }, reconciliation: { principal: 'p' }, bridge: { command: 'x' } }));
  const b = logger(); assert.equal(await main(['--mode', 'external', '--config', badCfg], {}, b.out), EXIT.INVALID_CONFIG); assert.equal(b.lines.join('\n').includes('hunter2'), false);
  const corrupt = join(dir, 'v.json'); writeFileSync(corrupt, '{ not json'); assert.equal(await main(['--vectors', corrupt, '--report', join(dir, 'r.json')], {}, logger().out), EXIT.INVALID_CONFIG);
  const badInt = join(dir, 'i.json'); writeFileSync(badInt, '{"results":5}'); assert.equal(await main(['--integrated', badInt, '--report', join(dir, 'r.json')], {}, logger().out), EXIT.INVALID_CONFIG);
  const okCfg = join(dir, 'ok.json'); writeFileSync(okCfg, JSON.stringify({ technicalKey: 'ESP32-AGRO-001', mqtt: { url: 'mqtt://127.0.0.1:1883' }, reconciliation: { principal: 'p-a' }, bridge: { command: 'definitely-not-a-command-xyz' } }));
  const inf = logger(); assert.equal(await main(['--mode', 'external', '--config', okCfg, '--report', join(dir, 'r.json')], {}, inf.out), EXIT.INFRASTRUCTURE); assert.match(inf.lines.join('\n'), /INFRASTRUCTURE UNAVAILABLE/);
  const rep = join(dir, 'report.json'), ok = logger(); assert.equal(await main(['--levels', '0,1', '--report', rep], {}, ok.out), EXIT.OK); const j = JSON.parse(readFileSync(rep, 'utf8'));
  assert.equal(j.productionCertified, false); assert.ok(j.results.every(x => x.level <= 1)); assert.equal(j.levels.L2, 'SKIP'); assert.match(ok.lines.join('\n'), /CONFORMANCE PASS LOCAL/); assert.match(ok.lines.at(-1), /^report: /);
  assert.deepEqual(parseCliArgs(['--only', 'L1-01,L1-02']).only, ['L1-01', 'L1-02']); assert.equal(parseCliArgs([]).mode, 'reference');
});

test('K9 integrated campaign mapping: PASS on a clean summary, FAIL (with failure codes) when any property is violated; included in the report and in the exit code', async () => {
  const clean = { f_e2_events: 60, normal_events: 10, f_e2: { confirmed: 60, retried: 59 }, normal: { confirmed: 10, firstTryConfirmed: 10 }, conflict: { state: 'CONFLICT_REQUIRES_REVIEW', republished: 1, measurementsForEvent: 1 }, brokerAcceptedAnyNotConfirmed: 0, confirmedWithoutBackendEvidence: [], eventsWithMoreThanOneMeasurement: 0,
    publisherCrash: { identical: true, entriesBefore: 60, entriesAfter: 60 }, backendRestart: [{}, {}], mqttConnectionsOpenNow: 1, crossTenantProbe: { askedByB: { kind: 'status', status: 'not-found' } }, counters: { no_answer: 74 } };
  const good = integratedResults(clean); assert.equal(good.length, 9); assert.ok(good.every(x => x.status === 'PASS'));
  const bad = integratedResults({ ...clean, eventsWithMoreThanOneMeasurement: 2, f_e2: { confirmed: 59, retried: 59 }, crossTenantProbe: { askedByB: { status: 'processed' } } }); assert.deepEqual(bad.filter(x => x.status === 'FAIL').map(x => x.failureCode).sort(), ['CROSS_TENANT_LEAK', 'DUPLICATE_MEASUREMENT', 'FE2_NOT_RECOVERED', 'OUTAGE_NOT_RECOVERED']);
  const r = await run({ only: ['L1-01'], integrated: good }); assert.equal(r.results.filter(x => x.group === 'integrated').length, 9); assert.equal(exitCodeFor(r), EXIT.OK);
  const r2 = await run({ only: ['L1-01'], integrated: bad }); assert.equal(r2.verdict, 'CONFORMANCE FAIL'); assert.equal(exitCodeFor(r2), EXIT.FAIL);
});

test('K10 the kit is tooling only: not composed in the app, no dependency on tests, no secrets, no new dependency, MODE B documented as not executed', () => {
  const read = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
  for (const f of ['src/app.ts', 'src/http/infrastructure.ts']) assert.equal(/be14-03|conformance/i.test(read(f)), false, f);
  const kit = readdirSync(new URL('../scripts/be14-03/', import.meta.url)).filter(f => f.endsWith('.ts'));
  assert.ok(kit.length >= 8); for (const f of kit) { const t = read('scripts/be14-03/' + f); assert.equal(/from '[^']*(test-support|\/test\/)/.test(t), false, f); assert.equal(/password\s*[:=]\s*['"](?!TEST_ONLY['"])[^'"]{4,}|Bearer [A-Za-z0-9]{12,}|BEGIN [A-Z ]*PRIVATE KEY|mongodb\+srv/i.test(t), false, f); }
  const pkg = JSON.parse(read('package.json')); assert.equal(pkg.scripts['publisher:conformance'], 'npm run build && node dist/scripts/be14-03/cli.js'); assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['cors', 'express', 'google-auth-library', 'mongoose', 'mqtt', 'zod']);
  assert.match(read('scripts/be14-03/runner.ts'), /EXTERNAL_MQTT_WORLD_NOT_IMPLEMENTED/);
});
