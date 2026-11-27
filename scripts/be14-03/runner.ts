// BE14-03 — conformance runner: executes the catalog against an adapter factory and produces the machine-readable report + the human summary + the exit code.
import type { PublisherAdapter } from './adapter.js';
import { CATALOG, ConformanceFailure, makeEnv, type ConfTest, type Level, type Vectors } from './catalog.js';
import type { World } from './world.js';

export type Status = 'PASS' | 'FAIL' | 'SKIP' | 'NOT_RUN';
export interface TestResult { testId: string; level: Level; title: string; status: Status; evidence: unknown; durationMs: number; failureCode: string | null; skipReason: string | null; group: 'offline' | 'integrated' }
export type LevelVerdict = 'PASS' | 'FAIL' | 'INCOMPLETE' | 'SKIP';
export interface Report {
  kit: { name: 'publisher-conformance-kit'; version: 1 }; mode: 'reference' | 'external'; startedAt: string; durationMs: number; capabilities: string[]; results: TestResult[];
  levels: Record<string, LevelVerdict>; totals: { total: number; pass: number; fail: number; skip: number; notRun: number }; verdict: string; productionCertified: false; disclaimer: string;
}
export const EXIT = { OK: 0, FAIL: 1, INVALID_CONFIG: 2, INFRASTRUCTURE: 3, INCOMPLETE: 4 } as const;
const DISCLAIMER = 'CONFORMANCE PASS LOCAL means the publisher met the executable contract in a simulated local world. It is NOT production certification and says nothing about hardware, field networks, authentication or any pending human decision.';

export async function runConformance(o: { vectors: Vectors; mode: 'reference' | 'external'; adapterFactory: (w: World) => PublisherAdapter; levels?: Level[]; only?: string[]; integrated?: Omit<TestResult, 'group'>[]; perTestTimeoutMs?: number; onProgress?: (r: TestResult) => void }): Promise<Report> {
  const started = Date.now(); const external = o.mode === 'external'; const { env, closeAll } = await makeEnv({ vectors: o.vectors, external, adapterFactory: o.adapterFactory });
  const results: TestResult[] = []; let caps = new Set<string>();
  try { caps = new Set(await env.caps()); } catch (e) { throw Object.assign(new Error('INFRASTRUCTURE_UNAVAILABLE: ' + (e as Error).message), { infrastructure: true }); } finally { await closeAll(); }
  const selected = CATALOG.filter(t => (!o.levels || o.levels.includes(t.level)) && (!o.only || o.only.includes(t.id)));
  const record = (t: ConfTest, status: Status, evidence: unknown, t0: number, failureCode: string | null = null, skipReason: string | null = null) => { const r: TestResult = { testId: t.id, level: t.level, title: t.title, status, evidence, durationMs: Date.now() - t0, failureCode, skipReason, group: 'offline' }; results.push(r); o.onProgress?.(r); };
  for (const t of selected) {
    const t0 = Date.now();
    if (external && t.world === 'mqtt') { record(t, 'NOT_RUN', null, t0, null, 'EXTERNAL_MQTT_WORLD_NOT_IMPLEMENTED: this kit version cannot observe/fault-inject a real broker for an external publisher'); continue; }
    const missing = (t.needs ?? []).filter(c => !caps.has(c));
    if (missing.length) { if (t.optional) record(t, 'SKIP', { missing }, t0, null, 'OPTIONAL_CAPABILITY_ABSENT:' + missing.join(',')); else if (t.skipWhenMissing) record(t, 'SKIP', { missing }, t0, null, t.skipWhenMissing); else record(t, 'FAIL', { missing }, t0, 'CAPABILITY_REQUIRED:' + missing.join(',')); continue; }
    try { const ev = await Promise.race([t.run(env), new Promise<never>((_, rej) => setTimeout(() => rej(new ConformanceFailure('TEST_TIMEOUT', 'the test exceeded ' + (o.perTestTimeoutMs ?? 60000) + ' ms')), o.perTestTimeoutMs ?? 60000))]); record(t, 'PASS', ev, t0); }
    catch (e) { if (e instanceof ConformanceFailure) record(t, 'FAIL', { message: e.message, detail: e.evidence }, t0, e.code); else record(t, 'FAIL', { message: (e as Error).message.slice(0, 300) }, t0, 'UNEXPECTED_ERROR'); }
    finally { await closeAll(); }
  }
  for (const i of o.integrated ?? []) { const r: TestResult = { ...i, group: 'integrated' }; results.push(r); o.onProgress?.(r); }
  const levels: Record<string, LevelVerdict> = {}; for (let l = 0; l <= 5; l += 1) { const rs = results.filter(r => r.level === l); levels['L' + l] = !rs.length ? 'SKIP' : rs.some(r => r.status === 'FAIL') ? 'FAIL' : rs.some(r => r.status === 'NOT_RUN') ? 'INCOMPLETE' : rs.some(r => r.status === 'PASS') ? 'PASS' : 'SKIP'; }
  const totals = { total: results.length, pass: results.filter(r => r.status === 'PASS').length, fail: results.filter(r => r.status === 'FAIL').length, skip: results.filter(r => r.status === 'SKIP').length, notRun: results.filter(r => r.status === 'NOT_RUN').length };
  const reached = [0, 1, 2, 3, 4, 5].filter(l => levels['L' + l] === 'PASS'), contiguous = (() => { let k = -1; while (levels['L' + (k + 1)] === 'PASS') k += 1; return k; })();
  const verdict = totals.fail > 0 ? 'CONFORMANCE FAIL' : totals.notRun > 0 ? 'CONFORMANCE INCOMPLETE' : contiguous >= 0 ? `CONFORMANCE PASS LOCAL (L0${contiguous > 0 ? '-L' + contiguous : ''}${reached.length > contiguous + 1 ? ' +' + reached.filter(l => l > contiguous).map(l => 'L' + l).join(',') : ''})` : 'CONFORMANCE NOTHING RUN';
  return { kit: { name: 'publisher-conformance-kit', version: 1 }, mode: o.mode, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, capabilities: [...caps], results, levels, totals, verdict, productionCertified: false, disclaimer: DISCLAIMER };
}
export const exitCodeFor = (r: Report): number => r.totals.fail > 0 ? EXIT.FAIL : r.totals.notRun > 0 ? EXIT.INCOMPLETE : EXIT.OK;
export function humanSummary(r: Report): string {
  const lines = [`Publisher conformance — mode ${r.mode} — ${r.verdict}`, ...Object.entries(r.levels).map(([k, v]) => `  ${k}: ${v}`), `  tests ${r.totals.total}: PASS ${r.totals.pass} · FAIL ${r.totals.fail} · SKIP ${r.totals.skip} · NOT_RUN ${r.totals.notRun}`];
  for (const x of r.results.filter(x => x.status === 'FAIL')) lines.push(`  FAIL ${x.testId} [${x.failureCode}] ${x.title}`); for (const x of r.results.filter(x => x.status === 'SKIP' || x.status === 'NOT_RUN')) lines.push(`  ${x.status} ${x.testId} (${x.skipReason})`);
  lines.push('  ' + r.disclaimer); return lines.join('\n');
}
