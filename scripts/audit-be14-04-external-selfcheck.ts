// BE14-04 — the ONE local integration run: harness test bridge (reference publisher, REAL clock, REAL MQTT) + EMQX lab + ExternalMqttObserver + ExternalFaultController + the conformance catalog and scenarios S1–S6.
// LOCAL_TEST_ONLY. Everything is labelled with the run id and removed at the end. The verdict is HARNESS_SELF_TEST: a test double never earns CONFORMANCE PASS EXTERNAL.
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEmqxLab } from './be13-11d/emqx-lab.js';
import { LAB_VERIFIED_TOPIC } from '../src/adapters/emqx-mqtt-broker.adapter.js';
import { loadMqttJsFactory } from '../src/adapters/emqx-mqtt-connect.js';
import { createStdioBridgeAdapter } from './be14-03/adapter.js';
import { loadVectors } from './be14-03/catalog.js';
import { exitCodeFor, humanSummary, runConformance } from './be14-03/runner.js';
import { createEmqxObservationSource } from './be14-04/observer.js';
import { createFaultController } from './be14-04/fault-controller.js';
import { createExternalWorldKit } from './be14-04/external-world.js';
import { runScenario, type ScenarioResult } from './be14-04/scenario.js';
import { SCENARIOS } from './be14-04/scenarios.js';

const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '..', '..');
const bridgePath = resolve(root, 'test-support/be14-04-test-bridge.mjs'), vectors = loadVectors(resolve(root, 'test-support/publisher-conformance-vectors.json'));
const runId = randomBytes(6).toString('hex'), KEY = vectors.technicalKey, BASE = Number(process.env.BE14_04_BASE_PORT ?? 17400), OUT = process.env.BE14_04_OUT ?? '.local-evidence/be14-04-self-test.json';
const say = (s: string) => console.log(s);

const lab = await startEmqxLab(BASE, runId);
const result: Record<string, unknown> = { runId, stage: 'be14-04', mode: 'HARNESS_SELF_TEST (test bridge = reference publisher, real clock, real MQTT, real EMQX 5.8.6 local)' };
let source: ReturnType<typeof createEmqxObservationSource> | null = null; const bridges: { close(): void }[] = []; let code = 0;
try {
  let kitRef: ReturnType<typeof createExternalWorldKit> | null = null;
  const http = { stopHttp: async () => { await kitRef!.currentWorld()?.stopHttp(); }, startHttp: async () => { await kitRef!.currentWorld()?.startHttp(); }, setHttp: (m: never) => kitRef!.currentWorld()?.setHttp(m) };
  const faults2 = createFaultController({ runId, broker: { containerName: lab.containerName, brokerUrl: lab.brokerUrl, api: (m, p) => lab.api(m, p) }, http: http as never, readyTimeoutMs: 90_000, afterBrokerReady: async () => { const end = Date.now() + 30_000; while (!(source?.isReady?.() ?? true) && Date.now() < end) await new Promise(r => setTimeout(r, 100)); } });
  const kit2 = createExternalWorldKit({ runId, faults: faults2 }); kitRef = kit2;
  const secret = lab.secrets['lab-device-a']!;
  source = createEmqxObservationSource({ mqttUrl: lab.brokerUrl, username: 'lab-consumer', password: lab.secrets['lab-consumer']!, topicFilter: LAB_VERIFIED_TOPIC, technicalIdentity: KEY, api: (m, p) => lab.api(m, p, undefined, { full: true }), pollMs: 100 });
  await source.start(kit2.sink); say('observer started (subscriber on the broker rule + management-API poller)');
  const boot = (w: { baseUrl: string; principalA: string }) => ({ technicalKey: KEY, mqttUrl: lab.brokerUrl, reconciliationUrl: w.baseUrl, principal: w.principalA, topic: 'agro/lab/in/a', mqttCredentials: { username: 'lab-device-a', password: secret } });
  const newBridge = () => { const b = createStdioBridgeAdapter({ command: process.execPath, args: [bridgePath], timeoutMs: 30_000 }); bridges.push(b); return b; };

  // ---- 1) the catalog (L0–L5) against the real broker, observed from outside
  say('running the conformance catalog in external-observed mode ...');
  const report = await runConformance({ vectors, mode: 'external', adapterFactory: () => newBridge(), perTestTimeoutMs: 120_000, ...(process.env.BE14_04_ONLY ? { only: process.env.BE14_04_ONLY.split(',') } : {}), onProgress: r => say(`  ${r.status.padEnd(7)} ${r.testId} ${r.failureCode ?? r.skipReason ?? ''}`),
    externalObserved: { kit: kit2, identity: { declaredKind: 'test-bridge', name: 'be14-04-test-bridge', testDouble: true }, requiredFaults: [], bootExtras: () => ({ mqttUrl: lab.brokerUrl, mqttCredentials: { username: 'lab-device-a', password: secret } }) } });
  say(humanSummary(report)); result.catalog = report; result.catalogExit = exitCodeFor(report); bridges.splice(0).forEach(b => b.close());

  // ---- 2) scenarios S1–S6
  const rogue = async (topic: string, bytes: Buffer) => { const f = (await loadMqttJsFactory()) as unknown as (u: string, o: object) => { on(e: string, l: (...a: unknown[]) => void): void; publish(t: string, p: Buffer, o: object, cb: (e: Error | null) => void): void; end(f?: boolean, o?: object, cb?: () => void): void };
    const c = f(lab.brokerUrl, { protocolVersion: 5, clientId: KEY + '-rogue', username: 'lab-device-a', password: secret, clean: true, reconnectPeriod: 0 }); await new Promise<void>((res, rej) => { c.on('connect', () => res()); c.on('error', e => rej(e as Error)); });
    await new Promise<void>((res, rej) => c.publish(topic, bytes, { qos: 1 }, e => (e ? rej(e) : res()))); await new Promise<void>(res => c.end(true, {}, () => res())); };
  const scenarios: ScenarioResult[] = [];
  for (const s of SCENARIOS.filter(x => !process.env.BE14_04_SCENARIOS || process.env.BE14_04_SCENARIOS.split(',').includes(x.id))) {
    const world = await kit2.worldFactory(KEY); await world.start(); const obs = kit2.current()!; const adapter = newBridge(); say('scenario ' + s.id + ' — ' + s.title);
    const r = await runScenario(s, { adapter, world, obs, faults: faults2, boot: boot(world), rogue }); scenarios.push(r); say(`  ${r.status} ${r.failureCode ?? ''}`); bridges.splice(0).forEach(b => b.close());
  }
  result.scenarios = scenarios;
  const bad = scenarios.filter(s => s.status !== 'PASS'); result.scenarioSummary = { total: scenarios.length, pass: scenarios.filter(s => s.status === 'PASS').length, notPass: bad.map(s => ({ id: s.id, status: s.status, code: s.failureCode })) };

  // ---- 3) honesty check: external mode WITHOUT an observer (what exists today for a real publisher) must stay INCOMPLETE
  const plain = await runConformance({ vectors, mode: 'external', adapterFactory: () => createStdioBridgeAdapter({ command: process.execPath, args: [resolve(root, 'test-support/be14-03-mock-bridge.mjs')] }), only: ['L0-01', 'L1-01'] });
  result.externalWithoutObserver = { verdict: plain.verdict, exit: exitCodeFor(plain) };
  const honest = plain.verdict === 'CONFORMANCE INCOMPLETE' && exitCodeFor(plain) === 4 && !report.verdict.includes('PASS EXTERNAL') && !JSON.stringify(report).includes('CONFORMANCE PASS EXTERNAL');
  result.checks = { catalogNoFail: report.totals.fail === 0, catalogNotRun: report.totals.notRun, harnessLabel: report.verdict, scenariosAllPass: bad.length === 0, honestIncompleteWithoutObserver: honest };
  code = report.totals.fail === 0 && report.totals.notRun === 0 && bad.length === 0 && honest ? 0 : 1;
} catch (e) { result.error = (e as Error).message.slice(0, 400); code = 3; }
finally { bridges.forEach(b => b.close()); try { await source?.stop(); } catch { /* */ } lab.stop(); }
mkdirSync(dirname(resolve(OUT)), { recursive: true }); writeFileSync(OUT, JSON.stringify(result, null, 1)); say('evidence: ' + OUT); say(code === 0 ? 'BE14-04 SELF-TEST: PASS' : 'BE14-04 SELF-TEST: NOT GREEN (exit ' + code + ')'); process.exitCode = code;
