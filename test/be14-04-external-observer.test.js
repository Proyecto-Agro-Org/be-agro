// BE14-04 — offline tests of ExternalMqttObserver, ExternalFaultController, scenario orchestrator, verdict labelling and external config. No Docker, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createObserver, ObserverError } from '../dist/scripts/be14-04/observer.js';
import { createFaultController, assertLocalTarget, FaultError } from '../dist/scripts/be14-04/fault-controller.js';
import { runScenario } from '../dist/scripts/be14-04/scenario.js';
import { SCENARIOS } from '../dist/scripts/be14-04/scenarios.js';
import { externalVerdict, requiredTestIds } from '../dist/scripts/be14-04/verdict.js';
import { CATALOG } from '../dist/scripts/be14-03/catalog.js';
import { validateExternalConfig } from '../dist/scripts/be14-03/external-config.js';
import { createWorld } from '../dist/scripts/be14-03/world.js';

const KEY = 'dev-a';
const bytes = (eventId, t = 20, extra = {}) => Buffer.from(JSON.stringify({ version: 1, eventId, sentAt: 1795115600000, clientid: KEY, deviceTimestamp: 1795115599000, payload: { temperature: t }, mqtt: { topic: 'agro/lab/in/a', messageType: 'telemetry', dataOrigin: 'simulated' }, ...extra }));
const sha = b => createHash('sha256').update(b).digest('hex');
const obs = (o = {}) => createObserver({ runId: 'r1', technicalIdentity: KEY, ...o });

test('O1 observer records connection, publish (clientId, topic, QoS, exact bytes, SHA-256) and a machine-readable timeline', () => {
  const o = obs(); o.sink.connect(KEY); const b = bytes(KEY + ':1'); o.sink.publish({ clientId: KEY, topic: 'agro/lab/in/a', qos: 1, dup: null, bytes: b });
  const s = o.summary(); assert.equal(s.publishCount, 1); assert.equal(s.connections.opens, 1);
  const p = s.timeline.find(e => e.type === 'PUBLISH_SEEN'); assert.equal(p.clientId, KEY); assert.equal(p.topic, 'agro/lab/in/a'); assert.equal(p.qos, 1); assert.equal(p.payloadSha256, sha(b)); assert.equal(p.payloadLength, b.length); assert.equal(p.eventId, KEY + ':1');
  assert.ok(s.timeline.every((e, i) => e.observerEventId === i + 1 && typeof e.timestamp === 'number' && e.runId === 'r1'));
  assert.deepEqual(o.publishRecords()[0].bytes, b);
});
test('O2 payload bytes are NOT persisted in the summary by default; a secret-looking value never leaks', () => {
  const o = obs(); o.sink.publish({ clientId: KEY, topic: 't', qos: 1, dup: null, bytes: bytes(KEY + ':1', 20, { password: 'SUPERSECRET' }) });
  const txt = JSON.stringify(o.summary()); assert.ok(!txt.includes('SUPERSECRET') && !txt.includes('payloadBytesB64'));
  const o2 = obs({ storePayloadBytes: true }); o2.sink.publish({ clientId: KEY, topic: 't', qos: 1, dup: null, bytes: bytes(KEY + ':2') }); assert.ok('payloadBytesB64' in o2.summary());
});
test('O3 DUP is reported NOT_OBSERVABLE when the source cannot see it (never guessed)', () => {
  const o = obs(); o.sink.publish({ clientId: KEY, topic: 't', qos: 1, dup: null, bytes: bytes(KEY + ':1') }); assert.equal(o.events().find(e => e.type === 'PUBLISH_SEEN').dup, 'NOT_OBSERVABLE'); assert.match(o.summary().dup, /NOT_OBSERVABLE/);
  const o2 = obs(); o2.sink.publish({ clientId: KEY, topic: 't', qos: 1, dup: true, bytes: bytes(KEY + ':1') }); assert.ok(o2.events().some(e => e.type === 'DUP_PUBLISH_SEEN'));
});
test('O4 reconnect accounting: same clientId, sequential connections are fine', () => {
  const o = obs(); o.sink.connect(KEY); o.sink.disconnect(KEY); o.sink.connect(KEY); const k = o.connections(); assert.equal(k.opens, 2); assert.equal(k.reconnects, 1); assert.equal(k.collisions, 0); assert.equal(k.maxConcurrent, 1); assert.deepEqual(o.verify(), []);
});
test('O5 clientId collision: a second CONNECT without DISCONNECT is detected (MQTT_CLIENT_ID_COLLISION)', () => {
  const o = obs(); o.sink.connect(KEY); o.sink.connect(KEY); assert.equal(o.connections().collisions, 1); assert.equal(o.connections().maxConcurrent, 2); assert.ok(o.verify().some(v => v.code === 'MQTT_CLIENT_ID_COLLISION')); assert.ok(o.events().some(e => e.type === 'COLLISION_SUSPECTED'));
});
test('O6 retry equality: same eventId + same bytes = OK; same eventId + different bytes = MQTT_RETRY_BYTES_CHANGED', () => {
  const o = obs(); const b = bytes(KEY + ':1'); o.sink.publish({ clientId: KEY, topic: 't', qos: 1, dup: null, bytes: b }); o.sink.publish({ clientId: KEY, topic: 't', qos: 1, dup: null, bytes: Buffer.from(b) }); assert.deepEqual(o.verify(), []); assert.equal(o.summary().retries, 1);
  o.sink.publish({ clientId: KEY, topic: 't', qos: 1, dup: null, bytes: bytes(KEY + ':1', 99) }); const v = o.verify(); assert.ok(v.some(x => x.code === 'MQTT_RETRY_BYTES_CHANGED'));
});
test('O7 hash the publisher owns vs hash on the wire: MQTT_HASH_CHANGED; unknown eventId: MQTT_EVENT_ID_CHANGED', () => {
  const o = obs(); const b = bytes(KEY + ':1'); o.sink.publish({ clientId: KEY, topic: 't', qos: 1, dup: null, bytes: b });
  assert.deepEqual(o.verify({ knownEventIds: [KEY + ':1'], knownHashes: { [KEY + ':1']: sha(b) } }), []);
  assert.ok(o.verify({ knownHashes: { [KEY + ':1']: 'f'.repeat(64) } }).some(v => v.code === 'MQTT_HASH_CHANGED'));
  assert.ok(o.verify({ knownEventIds: [KEY + ':7'] }).some(v => v.code === 'MQTT_EVENT_ID_CHANGED'));
});
test('O8 invalid topic is flagged (MQTT_TOPIC_INVALID): wildcard, NUL, empty, > 1024 bytes', () => {
  for (const t of ['a/+/b', 'a/#', 'a\u0000b', '', 'x'.repeat(1025)]) { const o = obs(); o.sink.publish({ clientId: KEY, topic: t, qos: 1, dup: null, bytes: bytes(KEY + ':1') }); assert.ok(o.verify().some(v => v.code === 'MQTT_TOPIC_INVALID'), JSON.stringify(t.slice(0, 10))); }
  const ok = obs(); ok.sink.publish({ clientId: KEY, topic: 'agro/lab/in/a', qos: 1, dup: null, bytes: bytes(KEY + ':1') }); assert.deepEqual(ok.verify(), []);
});
test('O9 a payload the canonical parser rejects is a contract failure, not an observation to trust', () => {
  const o = obs(); o.sink.publish({ clientId: KEY, topic: 't', qos: 1, dup: null, bytes: Buffer.from('{"not":"a contract payload"}') }); assert.ok(o.verify().some(v => v.code === 'PAYLOAD_CONTRACT_FAIL'));
});
test('O10 waitFor is ALWAYS bounded: timeout becomes MQTT_TIMEOUT (never a hang)', async () => {
  const o = obs(); const t0 = Date.now(); await assert.rejects(() => o.waitFor(() => false, { timeoutMs: 150, pollMs: 10, what: 'never' }), e => e instanceof ObserverError && e.code === 'MQTT_TIMEOUT'); assert.ok(Date.now() - t0 < 2000);
  let n = 0; await o.waitFor(() => ++n > 3, { timeoutMs: 1000, pollMs: 5 }); assert.ok(n > 3);
});
test('O11 events of another clientId do not count as the publisher connections', () => {
  const o = obs(); o.sink.connect('someone-else'); o.sink.connect('someone-else'); assert.equal(o.connections().collisions, 0); assert.equal(o.connections().opens, 0);
});

// ------------------------------------------------------------------ fault controller
const fakeBroker = () => ({ containerName: 'lab-c', brokerUrl: 'mqtt://127.0.0.1:1883', api: async () => ({ status: 200, body: '{}' }) });
const execOk = (label = 'r1', calls = []) => (cmd, args) => { calls.push(args.join(' ')); return args[0] === 'inspect' ? label + '\n' : ''; };
test('F1 non-local targets are refused (loopback only)', () => { for (const u of ['mqtt://10.0.0.5:1883', 'http://emqx.example.com', 'mqtt://broker.prod:1883']) assert.throws(() => assertLocalTarget(u), e => e instanceof FaultError && e.code === 'FAULT_TARGET_NOT_LOCAL'); assertLocalTarget('mqtt://127.0.0.1:1883'); assertLocalTarget('http://localhost:18083');
  assert.throws(() => createFaultController({ runId: 'r1', broker: { ...fakeBroker(), brokerUrl: 'mqtt://192.168.1.9:1883' } }), e => e.code === 'FAULT_TARGET_NOT_LOCAL'); });
test('F2 only a container carrying THIS run label is touched; a foreign/unlabelled one is refused and nothing is stopped', async () => {
  const calls = []; const f = createFaultController({ runId: 'r1', broker: fakeBroker(), exec: execOk('someone-elses-run', calls) }); await assert.rejects(() => f.brokerDown(), e => e.code === 'FAULT_TARGET_NOT_OWNED'); assert.ok(!calls.some(c => c.startsWith('stop')));
});
test('F3 brokerDown/Up/restart act on the owned container only, never delete anything, and log provenance + recovery', async () => {
  const calls = []; const f = createFaultController({ runId: 'r1', broker: fakeBroker(), exec: execOk('r1', calls), readyTimeoutMs: 500 }); await f.brokerDown(); await f.brokerUp(); await f.restartBroker();
  assert.ok(calls.includes('stop lab-c') && calls.includes('start lab-c') && calls.includes('restart lab-c')); assert.ok(!calls.some(c => /\b(rm|volume|prune)\b/.test(c)));
  const log = f.log(); assert.ok(log.every(r => r.runId === 'r1' && r.stage === '04')); assert.equal(typeof log.find(r => r.fault === 'brokerUp').recoveryMs, 'number');
});
test('F4 injection failures map to stable codes', async () => {
  const f = createFaultController({ runId: 'r1', broker: fakeBroker(), exec: (c, a) => { if (a[0] === 'inspect') return 'r1'; throw new Error('daemon down'); } }); await assert.rejects(() => f.brokerDown(), e => e.code === 'BROKER_STOP_FAILED'); await assert.rejects(() => f.brokerUp(), e => e.code === 'BROKER_START_FAILED');
  const g = createFaultController({ runId: 'r1', broker: { ...fakeBroker(), api: async () => ({ status: 500, body: '' }) }, exec: execOk(), readyTimeoutMs: 300 }); await assert.rejects(() => g.restartBroker(), e => e.code === 'BROKER_NOT_READY');
  const h = createFaultController({ runId: 'r1', broker: { ...fakeBroker(), api: async () => ({ status: 500, body: '' }) }, exec: execOk() }); await assert.rejects(() => h.disconnectClient('x'), e => e.code === 'CLIENT_DISCONNECT_FAILED');
  await assert.rejects(() => createFaultController({ runId: 'r1' }).reconciliationDown(), e => e.code === 'FAULT_CAPABILITY_ABSENT');
});
test('F5 HTTP faults drive the reconciliation surface; recoverAll restores whatever was left broken', async () => {
  let up = true, mode = 'normal'; const f = createFaultController({ runId: 'r1', http: { stopHttp: async () => { up = false; }, startHttp: async () => { up = true; }, setHttp: m => { mode = m.kind; } } });
  await f.reconciliationDown(); assert.equal(up, false); await f.injectHttpStatus(429, 2); assert.equal(mode, '429'); await f.delayHttp(true); assert.equal(mode, 'timeout'); const errs = await f.recoverAll(); assert.deepEqual(errs, []); assert.equal(up, true); assert.equal(mode, 'normal');
  assert.deepEqual(f.supported().sort(), ['delayHttp', 'injectHttpStatus', 'reconciliationDown', 'reconciliationUp']);
});

// ------------------------------------------------------------------ orchestrator
const stubAdapter = (o = {}) => { const entries = []; return { calls: [], capabilities: async () => [], boot: async () => (o.bootFail ? { ok: false, failure: 'X' } : { ok: true }), createEvent: async i => { const id = KEY + ':' + (entries.length + 1); entries.push({ eventId: id, state: 'confirmed', payloadSha256: 'a'.repeat(64) }); return { result: 'accepted', eventId: id }; }, advance: async () => { await new Promise(r => setTimeout(r, 5)); }, inspectPending: async () => entries, restart: async () => ({ ok: true }), shutdown: async function () { o.shut = (o.shut ?? 0) + 1; } }; };
const deps = async (o = {}) => { const w = createWorld({ technicalKey: KEY }); await w.start(); const ob = obs(); const f = createFaultController({ runId: 'r1', http: { stopHttp: () => w.stopHttp(), startHttp: () => w.startHttp(), setHttp: m => w.setHttp(m) } }); return { adapter: stubAdapter(o), world: w, obs: ob, faults: f, boot: { technicalKey: KEY, mqttUrl: 'x', reconciliationUrl: w.baseUrl, principal: w.principalA, topic: 'agro/lab/in/a' } }; };
test('C1 orchestrator: cleanup ALWAYS runs (shutdown + world stop + recovery) even when the scenario fails, and evidence is preserved', async () => {
  const o = {}; const d = await deps(o); let stopped = false; const stop = d.world.stop.bind(d.world); d.world.stop = async () => { stopped = true; await stop(); };
  const r = await runScenario({ id: 'T', title: 't', needsFaults: ['reconciliationDown', 'reconciliationUp'], run: async c => { await c.faults.reconciliationDown(); throw new Error('boom'); } }, d);
  assert.equal(r.status, 'FAIL'); assert.equal(r.failureCode, 'UNEXPECTED_ERROR'); assert.equal(o.shut, 1); assert.ok(stopped); assert.equal(d.world.httpIsUp(), false /* stopped by cleanup */); assert.ok(r.faults.some(f => f.fault === 'reconciliationUp'), 'recoverAll restored the API'); assert.ok(r.observer && r.phaseMs);
});
test('C2 a scenario whose fault capability is absent is an explicit SKIP (or FAIL when required) — never silent', async () => {
  const d = await deps(); const sc = { id: 'T', title: 't', needsFaults: ['brokerDown'], run: async () => ({}) };
  const r = await runScenario(sc, d); assert.equal(r.status, 'SKIP'); assert.match(r.skipReason, /FAULT_CAPABILITY_ABSENT: brokerDown/);
  const d2 = await deps(); const r2 = await runScenario(sc, { ...d2, optional: false }); assert.equal(r2.status, 'FAIL'); assert.equal(r2.failureCode, 'FAULT_CAPABILITY_REQUIRED');
});
test('C3 observer/infrastructure failure inside a scenario is INFRA_ERROR, not SKIP', async () => {
  const d = await deps(); const r = await runScenario({ id: 'T', title: 't', needsFaults: [], run: async () => { throw new ObserverError('MQTT_OBSERVER_START_FAILED', 'x'); } }, d); assert.equal(r.status, 'INFRA_ERROR'); assert.equal(r.failureCode, 'MQTT_OBSERVER_START_FAILED');
});
test('C4 conditions are bounded: a never-true condition becomes MQTT_TIMEOUT', async () => {
  const d = await deps(); const r = await runScenario({ id: 'T', title: 't', needsFaults: [], run: async c => { await c.until(() => false, { timeoutMs: 120, what: 'never' }); return {}; } }, d); assert.equal(r.status, 'FAIL'); assert.equal(r.failureCode, 'MQTT_TIMEOUT');
});
test('C5 negative scenario S6 passes ONLY when the kit detects the injected defect', async () => {
  const s6 = SCENARIOS.find(s => s.id === 'S6'); const d = await deps(); const ob = d.obs; const rogue = async (topic, b) => ob.sink.publish({ clientId: 'rogue', topic, qos: 1, dup: null, bytes: b });
  const r = await runScenario(s6, { ...d, rogue }); assert.equal(r.status, 'PASS'); assert.ok(r.evidence.detected.includes('MQTT_RETRY_BYTES_CHANGED'));
  const d2 = await deps(); const same = async (topic, b) => { d2.obs.sink.publish({ clientId: 'rogue', topic, qos: 1, dup: null, bytes: b }); }; const dup = (b => b); void dup; const orig = s6.run; const r2 = await runScenario({ ...s6, run: async c => { const x = Buffer.from(JSON.stringify({ version: 1, eventId: KEY + ':s6', sentAt: 1795115600000, clientid: KEY, deviceTimestamp: 1795115599000, payload: { temperature: 1 }, mqtt: { topic: 'agro/lab/in/a', messageType: 'telemetry', dataOrigin: 'simulated' } })); await same('agro/lab/in/a', x); await same('agro/lab/in/a', x); return {}; } }, { ...d2, rogue: same }); void orig; assert.equal(r2.status, 'FAIL'); assert.equal(r2.failureCode, 'NEGATIVE_NOT_DETECTED');
});
test('C6 scenario catalogue declares S1..S6 with the faults each one needs', () => { assert.deepEqual(SCENARIOS.map(s => s.id), ['S1', 'S2', 'S3', 'S4', 'S5', 'S6']); assert.ok(SCENARIOS.find(s => s.id === 'S2').needsFaults.includes('brokerDown')); assert.equal(SCENARIOS.find(s => s.id === 'S6').negative, true); });

// ------------------------------------------------------------------ verdict labelling
const base = (extra = {}) => { const results = CATALOG.map(t => ({ testId: t.id, status: 'PASS' })); return { totals: { fail: 0, notRun: 0, skip: 0, pass: results.length }, results, requiredTests: requiredTestIds(CATALOG), identity: { declaredKind: 'real-external', testDouble: false }, ...extra }; };
test('V1 a declared real external publisher with every required test PASS earns CONFORMANCE PASS EXTERNAL', () => { assert.equal(externalVerdict(base()).verdict, 'CONFORMANCE PASS EXTERNAL'); });
test('V2 a TEST DOUBLE / test bridge can NEVER earn CONFORMANCE PASS EXTERNAL (HARNESS_SELF_TEST only)', () => {
  for (const identity of [{ declaredKind: 'test-bridge', testDouble: true }, { declaredKind: 'real-external', testDouble: true }, { declaredKind: 'undeclared', testDouble: false }]) { const v = externalVerdict(base({ identity })); assert.notEqual(v.verdict, 'CONFORMANCE PASS EXTERNAL'); assert.equal(v.label, 'HARNESS_SELF_TEST'); assert.match(v.verdict, /HARNESS_SELF_TEST/); }
});
test('V3 FAIL beats everything; NOT_RUN or a required test not PASS = INCOMPLETE; infra failure = INFRA_ERROR', () => {
  assert.equal(externalVerdict(base({ totals: { fail: 1, notRun: 0, skip: 0, pass: 1 } })).verdict, 'CONFORMANCE FAIL'); assert.equal(externalVerdict(base({ totals: { fail: 0, notRun: 2, skip: 0, pass: 1 } })).verdict, 'CONFORMANCE INCOMPLETE');
  const results = base().results.map((r, i) => (i === 3 ? { ...r, status: 'SKIP' } : r)); assert.equal(externalVerdict(base({ results })).verdict, 'CONFORMANCE INCOMPLETE'); assert.equal(externalVerdict(base({ infrastructureFailed: true })).verdict, 'CONFORMANCE INFRA_ERROR');
});

// ------------------------------------------------------------------ external config extension
const goodCfg = () => ({ technicalKey: KEY, mqtt: { url: 'mqtt://127.0.0.1:1883' }, reconciliation: { principal: 'p' }, scope: {}, bridge: { command: 'node' }, publisher: { kind: 'real-external' }, observer: { enabled: true, topicFilter: 'agro/lab/verify/#', apiUrl: 'http://127.0.0.1:18083/api/v5', apiKeyEnv: 'K_ENV', apiSecretEnv: 'S_ENV' }, faultControl: { mode: 'lab-emqx', brokerContainer: 'c', runId: 'r1' } });
test('E1 extended external config validates; non-local API, inline secrets and a missing env var are rejected', () => {
  const env = { K_ENV: 'k', S_ENV: 's' }; assert.equal(validateExternalConfig(goodCfg(), env).observer.enabled, true);
  const bad1 = goodCfg(); bad1.observer.apiUrl = 'http://10.1.1.1:18083'; assert.throws(() => validateExternalConfig(bad1, env), /LOCAL/);
  const bad2 = goodCfg(); bad2.observer.apiSecret = 'inline'; assert.throws(() => validateExternalConfig(bad2, env), /inline secret/);
  assert.throws(() => validateExternalConfig(goodCfg(), { K_ENV: 'k' }), /apiSecretEnv/);
  const bad3 = goodCfg(); bad3.faultControl = { mode: 'lab-emqx' }; assert.throws(() => validateExternalConfig(bad3, env), /brokerContainer/);
  const old = goodCfg(); delete old.observer; delete old.faultControl; delete old.publisher; assert.equal(validateExternalConfig(old, env).observer, undefined);          // BE14-03 configs still valid
});
