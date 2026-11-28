// BE14-04 — mutation check of the observer / fault controller / orchestrator / verdict: each seeded defect must be DETECTED by the offline tests' probes (a probe that still passes = a surviving mutant).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { CATALOG } from '../dist/scripts/be14-03/catalog.js';

const url = p => new URL('../' + p, import.meta.url);
const load = async (file, patch, id) => {
  if (!patch) return import(url(file).href);
  const text = readFileSync(url(file), 'utf8'); assert.equal(text.split(patch[0]).length - 1, 1, 'mutation anchor must match exactly once: ' + patch[0].slice(0, 80));
  const copy = file.replace(/\.js$/, `.mut-${id}.js`); writeFileSync(url(copy), text.replace(patch[0], patch[1]));
  try { return await import(url(copy).href); } finally { rmSync(url(copy), { force: true }); }
};
const KEY = 'dev-a';
const bytes = (eventId, t = 20) => Buffer.from(JSON.stringify({ version: 1, eventId, sentAt: 1795115600000, clientid: KEY, deviceTimestamp: 1795115599000, payload: { temperature: t }, mqtt: { topic: 'agro/lab/in/a', messageType: 'telemetry', dataOrigin: 'simulated' } }));
const pub = (o, b, topic = 'agro/lab/in/a') => o.sink.publish({ clientId: KEY, topic, qos: 1, dup: null, bytes: b });
const OBS = 'dist/scripts/be14-04/observer.js', FC = 'dist/scripts/be14-04/fault-controller.js', VD = 'dist/scripts/be14-04/verdict.js', SC = 'dist/scripts/be14-04/scenario.js';

/** each probe returns true when the (possibly mutated) module BEHAVES CORRECTLY */
const MUTANTS = [
  { id: 'M1', what: 'observer ignores a clientId collision', file: OBS, patch: ['collisions += 1;', 'collisions += 0;'], probe: async m => { const o = m.createObserver({ runId: 'r', technicalIdentity: KEY }); o.sink.connect(KEY); o.sink.connect(KEY); return o.verify().some(v => v.code === 'MQTT_CLIENT_ID_COLLISION'); } },
  { id: 'M2', what: 'a retry with changed bytes is accepted', file: OBS, patch: ['.size > 1)', '.size > 99)'], probe: async m => { const o = m.createObserver({ runId: 'r', technicalIdentity: KEY }); pub(o, bytes(KEY + ':1')); pub(o, bytes(KEY + ':1', 77)); return o.verify().some(v => v.code === 'MQTT_RETRY_BYTES_CHANGED'); } },
  { id: 'M3', what: 'a hash that differs from the owned one is accepted', file: OBS, patch: ['list.some(l => l.sha !== exp)', 'false'], probe: async m => { const o = m.createObserver({ runId: 'r', technicalIdentity: KEY }); pub(o, bytes(KEY + ':1')); return o.verify({ knownHashes: { [KEY + ':1']: 'f'.repeat(64) } }).some(v => v.code === 'MQTT_HASH_CHANGED'); } },
  { id: 'M4', what: 'an invalid topic is accepted', file: OBS, patch: ['if (!topicOk(p.topic))', 'if (false)'], probe: async m => { const o = m.createObserver({ runId: 'r', technicalIdentity: KEY }); pub(o, bytes(KEY + ':1'), 'a/+/b'); return o.verify().some(v => v.code === 'MQTT_TOPIC_INVALID'); } },
  { id: 'M5', what: 'the fault controller accepts a NON-local target', file: FC, patch: ['assertLocalTarget(o.broker.brokerUrl);', ';'], probe: async m => { try { m.createFaultController({ runId: 'r', broker: { containerName: 'c', brokerUrl: 'mqtt://10.9.9.9:1883', api: async () => ({ status: 200, body: '' }) } }); return false; } catch (e) { return e.code === 'FAULT_TARGET_NOT_LOCAL'; } } },
  { id: 'M6', what: 'waiting has no timeout', file: OBS, patch: ['if (Date.now() >= end)', 'if (false)'], probe: async m => { const o = m.createObserver({ runId: 'r', technicalIdentity: KEY }); const t0 = Date.now(); try { await o.waitFor(() => Date.now() - t0 > 700, { timeoutMs: 100, pollMs: 10 }); return false; } catch (e) { return e.code === 'MQTT_TIMEOUT'; } } },
  { id: 'M7', what: 'an observer/infrastructure failure becomes SKIP', file: SC, patch: ["'INFRA_ERROR' : 'FAIL'", "'SKIP' : 'FAIL'"], probe: async m => {
      const { createWorld } = await import(url('dist/scripts/be14-03/world.js').href); const { createObserver, ObserverError } = await import(url(OBS).href); const { createFaultController } = await import(url(FC).href);
      const w = createWorld({ technicalKey: KEY }); await w.start(); const adapter = { capabilities: async () => [], boot: async () => ({ ok: true }), advance: async () => {}, inspectPending: async () => [], shutdown: async () => {}, createEvent: async () => ({ result: 'rejected', reason: 'x' }), restart: async () => ({ ok: true }) };
      const r = await m.runScenario({ id: 'T', title: 't', needsFaults: [], run: async () => { throw new ObserverError('MQTT_OBSERVER_START_FAILED', 'x'); } }, { adapter, world: w, obs: createObserver({ runId: 'r', technicalIdentity: KEY }), faults: createFaultController({ runId: 'r' }), boot: { technicalKey: KEY, mqttUrl: 'x', reconciliationUrl: w.baseUrl, principal: w.principalA, topic: 't' } }); return r.status === 'INFRA_ERROR'; } },
  { id: 'M8', what: 'a test double can claim CONFORMANCE PASS EXTERNAL', file: VD, patch: ['i.identity.testDouble || ', ''], probe: async m => { const results = CATALOG.map(t => ({ testId: t.id, status: 'PASS' })); const v = m.externalVerdict({ totals: { fail: 0, notRun: 0, skip: 0, pass: results.length }, results, requiredTests: m.requiredTestIds(CATALOG), identity: { declaredKind: 'real-external', testDouble: true } }); return v.verdict !== 'CONFORMANCE PASS EXTERNAL'; } },
];
for (const m of MUTANTS) {
  test(`KMUT0 control — ${m.id}: the unmutated module behaves correctly under the same probe`, async () => { assert.equal(await m.probe(await load(m.file, null, 'c')), true); });
  test(`${m.id} is DETECTED — ${m.what}`, async () => { const mod = await load(m.file, m.patch, m.id); assert.equal(await m.probe(mod), false, `${m.id} survived: the probe still passes on the mutated module`); });
}
