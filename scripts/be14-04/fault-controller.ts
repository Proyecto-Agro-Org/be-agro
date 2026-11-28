// BE14-04 — ExternalFaultController: injects faults into LOCAL INFRASTRUCTURE from outside the publisher (broker down/up/restart, client kick, reconciliation API down/up/429/delay, backend down/up).
// It never touches the publisher's code or memory. Hard guards: loopback targets only; only containers carrying THIS run's lab label; no volume is ever deleted; every action is logged with provenance (be14.stage=04 + runId).
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

export type FaultCode = 'BROKER_STOP_FAILED' | 'BROKER_START_FAILED' | 'BROKER_NOT_READY' | 'API_FAULT_INJECTION_FAILED' | 'CLIENT_DISCONNECT_FAILED' | 'RECOVERY_TIMEOUT' | 'FAULT_TARGET_NOT_LOCAL' | 'FAULT_TARGET_NOT_OWNED' | 'FAULT_CAPABILITY_ABSENT';
export class FaultError extends Error { constructor(readonly code: FaultCode, message: string) { super(message); } }
export const FAULTS = ['brokerDown', 'brokerUp', 'restartBroker', 'disconnectClient', 'reconciliationDown', 'reconciliationUp', 'backendDown', 'backendUp', 'injectHttpStatus', 'delayHttp'] as const;
export type FaultName = typeof FAULTS[number];
export interface FaultRecord { runId: string; stage: '04'; fault: FaultName | 'waitBrokerReady'; target: string; startedAt: number; recoveredAt: number | null; recoveryMs: number | null; ok: boolean; code: FaultCode | null }
export type Exec = (cmd: string, args: string[]) => string;
const defaultExec: Exec = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 60_000, windowsHide: true });
export const LOOPBACK = ['127.0.0.1', 'localhost', '::1', '[::1]'];
/** Throws unless the URL/host is loopback. Used for every network target the controller is given. */
export function assertLocalTarget(urlOrHost: string): void {
  let host = urlOrHost; try { host = new URL(urlOrHost).hostname; } catch { /* a bare host */ }
  if (!LOOPBACK.includes(host)) throw new FaultError('FAULT_TARGET_NOT_LOCAL', 'refusing to inject faults into a non-local target');
}
export interface HttpFaultSurface { stopHttp(): Promise<void>; startHttp(): Promise<unknown>; setHttp(m: { kind: 'normal' } | { kind: '429'; retryAfterSec: number } | { kind: '500' } | { kind: 'timeout' }): void }
export interface FaultControllerOptions {
  runId: string; labLabel?: string;                         // label value the broker container must carry (agro.emqx.lab=<runId>)
  broker?: { containerName: string; brokerUrl: string; api: (m: string, p: string) => Promise<{ status: number; body: string }> };
  http?: HttpFaultSurface; backend?: { stop(): Promise<void>; start(): Promise<void> };
  exec?: Exec; docker?: string; /** awaited after the broker is ready again (e.g. wait until the observer has re-subscribed) */ afterBrokerReady?: () => Promise<void>; readyTimeoutMs?: number; now?: () => number;
}
export function createFaultController(o: FaultControllerOptions) {
  const exec = o.exec ?? defaultExec, docker = o.docker ?? 'docker', now = o.now ?? (() => performance.now()), log: FaultRecord[] = []; let brokerDownAt: number | null = null, httpDownAt: number | null = null, backendDownAt: number | null = null;
  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
  const need = <T>(v: T | undefined, what: string): T => { if (v === undefined) throw new FaultError('FAULT_CAPABILITY_ABSENT', 'fault control for ' + what + ' is not configured'); return v; };
  if (o.broker) assertLocalTarget(o.broker.brokerUrl);
  /** Only a container that carries THIS run's lab label may be touched. */
  const ownBroker = (): string => {
    const b = need(o.broker, 'the broker'); const out = exec(docker, ['inspect', '--format', '{{index .Config.Labels "agro.emqx.lab"}}', b.containerName]).trim();
    if (out !== (o.labLabel ?? o.runId)) throw new FaultError('FAULT_TARGET_NOT_OWNED', 'the broker container does not carry this run\'s label; refusing to touch it'); return b.containerName;
  };
  const rec = async (fault: FaultRecord['fault'], target: string, f: () => Promise<void>, fail: FaultCode): Promise<FaultRecord> => {
    const r: FaultRecord = { runId: o.runId, stage: '04', fault, target, startedAt: Math.round(now()), recoveredAt: null, recoveryMs: null, ok: false, code: null }; log.push(r);
    try { await f(); r.ok = true; } catch (e) { r.code = e instanceof FaultError ? e.code : fail; throw e instanceof FaultError ? e : new FaultError(fail, (e as Error).message.slice(0, 200)); } return r;
  };
  const waitReady = async (timeoutMs = o.readyTimeoutMs ?? 60_000) => {
    const b = need(o.broker, 'the broker'), end = Date.now() + timeoutMs;
    for (;;) { try { const r = await b.api('GET', '/status'); if (r.status === 200) { await o.afterBrokerReady?.(); return; } } catch { /* not yet */ } if (Date.now() > end) throw new FaultError('BROKER_NOT_READY', 'the broker did not become ready in ' + timeoutMs + ' ms'); await sleep(250); }
  };
  const ctl = {
    log: () => log.map(r => ({ ...r })),
    async brokerDown() { const name = ownBroker(); await rec('brokerDown', name, async () => { exec(docker, ['stop', name]); brokerDownAt = now(); }, 'BROKER_STOP_FAILED'); },
    async brokerUp() { const name = ownBroker(); const r = await rec('brokerUp', name, async () => { exec(docker, ['start', name]); await waitReady(); }, 'BROKER_START_FAILED'); if (brokerDownAt !== null) { r.recoveredAt = Math.round(now()); r.recoveryMs = Math.round(now() - brokerDownAt); brokerDownAt = null; } },
    /** Restart keeps the container and its volume; nothing is deleted. */
    async restartBroker() { const name = ownBroker(); const t = now(); const r = await rec('restartBroker', name, async () => { exec(docker, ['restart', name]); await waitReady(); }, 'BROKER_START_FAILED'); r.recoveredAt = Math.round(now()); r.recoveryMs = Math.round(now() - t); },
    async disconnectClient(clientId: string) { const b = need(o.broker, 'the broker'); await rec('disconnectClient', 'client:' + clientId, async () => { const r = await b.api('DELETE', '/clients/' + encodeURIComponent(clientId)); if (r.status !== 204 && r.status !== 200 && r.status !== 404) throw new Error('kick returned ' + r.status); }, 'CLIENT_DISCONNECT_FAILED'); },
    async reconciliationDown() { const h = need(o.http, 'the reconciliation API'); await rec('reconciliationDown', 'reconciliation', async () => { await h.stopHttp(); httpDownAt = now(); }, 'API_FAULT_INJECTION_FAILED'); },
    async reconciliationUp() { const h = need(o.http, 'the reconciliation API'); const r = await rec('reconciliationUp', 'reconciliation', async () => { await h.startHttp(); }, 'API_FAULT_INJECTION_FAILED'); if (httpDownAt !== null) { r.recoveredAt = Math.round(now()); r.recoveryMs = Math.round(now() - httpDownAt); httpDownAt = null; } },
    async backendDown() { const b = need(o.backend, 'the backend'); await rec('backendDown', 'backend', async () => { await b.stop(); backendDownAt = now(); }, 'API_FAULT_INJECTION_FAILED'); },
    async backendUp() { const b = need(o.backend, 'the backend'); const r = await rec('backendUp', 'backend', async () => { await b.start(); }, 'API_FAULT_INJECTION_FAILED'); if (backendDownAt !== null) { r.recoveredAt = Math.round(now()); r.recoveryMs = Math.round(now() - backendDownAt); backendDownAt = null; } },
    async injectHttpStatus(status: 'normal' | 429 | 500, retryAfterSec = 1) { const h = need(o.http, 'the reconciliation API'); await rec('injectHttpStatus', 'reconciliation:' + status, async () => { h.setHttp(status === 'normal' ? { kind: 'normal' } : status === 429 ? { kind: '429', retryAfterSec } : { kind: '500' }); }, 'API_FAULT_INJECTION_FAILED'); },
    async delayHttp(on: boolean) { const h = need(o.http, 'the reconciliation API'); await rec('delayHttp', 'reconciliation:delay', async () => { h.setHttp(on ? { kind: 'timeout' } : { kind: 'normal' }); }, 'API_FAULT_INJECTION_FAILED'); },
    /** Which faults this controller can inject (capability negotiation input). */
    supported(): FaultName[] { const s: FaultName[] = []; if (o.broker) s.push('brokerDown', 'brokerUp', 'restartBroker', 'disconnectClient'); if (o.http) s.push('reconciliationDown', 'reconciliationUp', 'injectHttpStatus', 'delayHttp'); if (o.backend) s.push('backendDown', 'backendUp'); return s; },
    /** Best-effort recovery of whatever this controller broke; used by scenario cleanup. */
    async recoverAll() { const errs: string[] = []; if (brokerDownAt !== null) try { await ctl.brokerUp(); } catch (e) { errs.push((e as Error).message); } if (httpDownAt !== null) try { await ctl.reconciliationUp(); } catch (e) { errs.push((e as Error).message); } if (backendDownAt !== null) try { await ctl.backendUp(); } catch (e) { errs.push((e as Error).message); } if (o.http) try { o.http.setHttp({ kind: 'normal' }); } catch { /* */ } return errs; },
    waitBrokerReady: waitReady,
  };
  return ctl;
}
export type FaultController = ReturnType<typeof createFaultController>;
