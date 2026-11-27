// BE14-04 — declarative scenario orchestrator (setup → observer → boot → fault → wait-for-condition (bounded) → recover → assert → shutdown).
// Cleanup ALWAYS runs, evidence is preserved even on failure, and an observer/infrastructure failure is INFRA_ERROR, never a silent SKIP.
import type { PublisherAdapter } from '../be14-03/adapter.js';
import type { World } from '../be14-03/world.js';
import { FaultError, type FaultController, type FaultName } from './fault-controller.js';
import { ObserverError, type Observer, type ObserverCode } from './observer.js';
import { ConformanceFailure } from '../be14-03/catalog.js';

export interface ScenarioCtx {
  a: PublisherAdapter; w: World; obs: Observer; faults: FaultController; technicalKey: string; eventIds: string[]; marks: Record<string, number>;
  create(n: number, payload?: Record<string, number>): Promise<string[]>;
  /** Bounded condition wait on the REAL clock; the publisher is given time to work while we wait. */
  until(cond: () => boolean | Promise<boolean>, o: { timeoutMs: number; what: string; code?: ObserverCode }): Promise<void>;
  state(id: string): Promise<string | null>; rogue?: (topic: string, bytes: Buffer) => Promise<void>;
}
export interface Scenario { id: string; title: string; needsFaults: FaultName[]; /** the scenario PASSES only if the kit DETECTS the injected defect */ negative?: boolean; run(ctx: ScenarioCtx): Promise<Record<string, unknown>> }
export type ScenarioStatus = 'PASS' | 'FAIL' | 'SKIP' | 'INFRA_ERROR';
export interface ScenarioResult { id: string; title: string; status: ScenarioStatus; failureCode: string | null; skipReason: string | null; phaseMs: Record<string, number>; evidence: unknown; observer: unknown; faults: unknown[]; recoveryDurationsMs: number[] }

const INFRA: string[] = ['MQTT_OBSERVER_START_FAILED', 'BROKER_STOP_FAILED', 'BROKER_START_FAILED', 'BROKER_NOT_READY', 'API_FAULT_INJECTION_FAILED', 'CLIENT_DISCONNECT_FAILED'];
export async function runScenario(s: Scenario, d: { adapter: PublisherAdapter; world: World; obs: Observer; faults: FaultController; boot: Parameters<PublisherAdapter['boot']>[0]; rogue?: ScenarioCtx['rogue']; optional?: boolean }): Promise<ScenarioResult> {
  const phaseMs: Record<string, number> = {}; const t0 = Date.now(), f0 = d.faults.log().length; let phase = 'setup'; const mark = (p: string) => { phaseMs[phase] = Date.now() - t0 - Object.values(phaseMs).reduce((a, b) => a + b, 0); phase = p; };
  const res: ScenarioResult = { id: s.id, title: s.title, status: 'PASS', failureCode: null, skipReason: null, phaseMs, evidence: null, observer: null, faults: [], recoveryDurationsMs: [] };
  const supported = d.faults.supported(); const missing = s.needsFaults.filter(f => !supported.includes(f));
  if (missing.length) { res.status = d.optional === false ? 'FAIL' : 'SKIP'; res.failureCode = res.status === 'FAIL' ? 'FAULT_CAPABILITY_REQUIRED' : null; res.skipReason = 'FAULT_CAPABILITY_ABSENT: ' + missing.join(','); try { await d.world.stop(); } catch { /* */ } return res; }
  const ctx: ScenarioCtx = { a: d.adapter, w: d.world, obs: d.obs, faults: d.faults, technicalKey: d.boot.technicalKey, eventIds: [], marks: {}, ...(d.rogue ? { rogue: d.rogue } : {}),
    async create(n, payload) { const out: string[] = []; for (let i = 0; i < n; i += 1) { const r = await d.adapter.createEvent({ payload: payload ?? { temperature: 20 + i } }); if (r.result !== 'accepted') throw new ConformanceFailure('CREATE_REJECTED', 'the publisher rejected a valid reading: ' + r.reason); out.push(r.eventId); } ctx.eventIds.push(...out); return out; },
    async until(cond, o) { const end = Date.now() + o.timeoutMs; for (;;) { if (await cond()) return; if (Date.now() >= end) throw new ObserverError(o.code ?? 'MQTT_TIMEOUT', 'timed out waiting for ' + o.what + ' (' + o.timeoutMs + ' ms)'); await d.adapter.advance(100); } },
    async state(id) { return (await d.adapter.inspectPending()).find(e => e.eventId === id)?.state ?? null } };
  try {
    mark('observer'); mark('boot'); const b = await d.adapter.boot(d.boot); if (!b.ok) throw new ConformanceFailure('BOOT_FAILED', 'publisher failed to boot: ' + b.failure);
    mark('scenario'); const ev = await s.run(ctx); mark('assert'); const v = d.obs.verify({ knownEventIds: ctx.eventIds });
    if (s.negative) { res.evidence = { ...ev, detected: v.map(x => x.code) }; if (!v.length) throw new ConformanceFailure('NEGATIVE_NOT_DETECTED', 'the injected defect was NOT detected by the kit'); }
    else { res.evidence = ev; if (v.length) throw new ConformanceFailure(v[0]!.code, 'MQTT observer: ' + v[0]!.message, v); }
  } catch (e) {
    res.status = 'FAIL';
    if (e instanceof ConformanceFailure) { res.failureCode = e.code; res.evidence = { message: e.message, detail: e.evidence }; }
    else if (e instanceof ObserverError || e instanceof FaultError) { res.failureCode = e.code; res.status = INFRA.includes(e.code) ? 'INFRA_ERROR' : 'FAIL'; res.evidence = { message: e.message }; }
    else { res.failureCode = 'UNEXPECTED_ERROR'; res.evidence = { message: (e as Error).message.slice(0, 300) }; }
  } finally {
    mark('cleanup'); const errs = await d.faults.recoverAll().catch(x => [(x as Error).message]); try { await d.adapter.shutdown(); } catch { /* */ } try { await d.world.stop(); } catch { /* */ }
    if (errs.length && res.status === 'PASS') { res.status = 'INFRA_ERROR'; res.failureCode = 'RECOVERY_TIMEOUT'; res.evidence = { cleanup: errs }; } mark('done');
    res.observer = d.obs.summary(); const mine = d.faults.log().slice(f0); res.faults = mine; res.recoveryDurationsMs = mine.filter(f => f.recoveryMs !== null).map(f => f.recoveryMs as number);
  }
  return res;
}
