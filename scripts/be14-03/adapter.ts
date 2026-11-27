// BE14-03 — the BLACK-BOX publisher adapter. A publisher under test (reference, future ESP32/gateway firmware, any language) is driven ONLY through this interface; the kit never
// needs its internals (language, framework, OS, filesystem, MQTT or HTTP library). Observable behaviour only.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export type LogicalState = 'pending' | 'broker-accepted' | 'confirmed' | 'quarantined' | 'conflict' | 'unconfirmed' | 'unconfirmed-explicit';
export const TERMINAL: readonly LogicalState[] = ['confirmed', 'quarantined', 'conflict', 'unconfirmed-explicit'];
export interface PendingEntry { eventId: string; payloadSha256: string; payloadB64: string; state: LogicalState; lane?: 'fast' | 'slow'; attempts: number }
export interface BootConfig {
  technicalKey: string; mqttUrl: string; reconciliationUrl: string; principal: string; topic: string;
  /** optional tuning, honoured only when the capability `policy-config` / `capacity-config` is declared (the kit never demands concrete production values) */
  policy?: { fastMaxAttempts: number; fastDelayMs: number; fastMaxElapsedMs: number; slowIntervalMs: number; slowMaxElapsedMs: number }; capacity?: number; storePath?: string;
}
export type CreateInput = { payload: Record<string, number | string | boolean | null>; eventId?: string; deviceTimestamp?: number | string | null | 'OMIT'; sentAt?: number };
export type CreateResult = { result: 'accepted'; eventId: string } | { result: 'rejected'; reason: string };
export type BootResult = { ok: true } | { ok: false; failure: string };
/** Capabilities a publisher MAY declare. A capability a test needs and the adapter does not declare => the test is reported as FAIL (required) or SKIP (only when flagged optional). */
export type Capability = 'explicit-event-input' | 'crash-injection' | 'clock-control' | 'capacity-config' | 'policy-config' | 'outbox-corruption' | 'canonical-serialization';

export interface PublisherAdapter {
  capabilities(): Promise<Capability[]>;
  boot(config: BootConfig): Promise<BootResult>;
  createEvent(input: CreateInput): Promise<CreateResult>;
  /** Lets `ms` of (virtual or real) time pass so the publisher performs whatever work is due. */
  advance(ms: number): Promise<void>;
  /** Every outbox entry the publisher still owns, INCLUDING terminal ones it retains. */
  inspectPending(): Promise<PendingEntry[]>;
  /** Optional controls (declared via capabilities). */
  armCrash?(point: 'before-persist' | 'before-publish' | 'after-publish-before-persist' | 'after-puback' | 'after-backend-answer' | 'after-confirmation'): Promise<void>;
  setClock?(ms: number): Promise<void>;
  corruptOutbox?(kind: 'garbage' | 'torn-tmp'): Promise<void>;
  restart(): Promise<BootResult>;
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------- external bridge (line-delimited JSON over stdio)
// request  : {"id":1,"op":"boot","args":{...}}            response : {"id":1,"ok":true,"result":...}  |  {"id":1,"ok":false,"error":"..."}
// ops      : capabilities, boot, createEvent, advance, inspectPending, armCrash, setClock, corruptOutbox, restart, shutdown
export interface BridgeConfig { command: string; args?: string[]; timeoutMs?: number }
export function createStdioBridgeAdapter(cfg: BridgeConfig): PublisherAdapter & { close(): void } {
  let child: ChildProcessWithoutNullStreams | null = null, nextId = 1; const pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void; timer: NodeJS.Timeout }>();
  const start = () => {
    if (child) return; child = spawn(cfg.command, cfg.args ?? [], { stdio: ['pipe', 'pipe', 'pipe'] });
    createInterface({ input: child.stdout }).on('line', line => { try { const m = JSON.parse(line) as { id: number; ok: boolean; result?: unknown; error?: string }; const p = pending.get(m.id); if (!p) return; clearTimeout(p.timer); pending.delete(m.id); if (m.ok) p.res(m.result); else p.rej(new Error(m.error ?? 'bridge-error')); } catch { /* a non-protocol line is ignored */ } });
    child.stdin.on('error', e => { for (const p of pending.values()) { clearTimeout(p.timer); p.rej(e); } pending.clear(); });             // EPIPE after the child died must be a bounded error, never an unhandled event
    child.on('error', e => { for (const p of pending.values()) p.rej(e); pending.clear(); }); child.on('exit', () => { for (const p of pending.values()) { clearTimeout(p.timer); p.rej(new Error('BRIDGE_EXITED')); } pending.clear(); child = null; });
  };
  const call = <T>(op: string, args: unknown = {}): Promise<T> => { start(); return new Promise<T>((res, rej) => { const id = nextId++; const timer = setTimeout(() => { pending.delete(id); rej(new Error('BRIDGE_TIMEOUT ' + op)); }, cfg.timeoutMs ?? 15000); pending.set(id, { res: res as (v: unknown) => void, rej, timer }); child!.stdin.write(JSON.stringify({ id, op, args }) + '\n'); }); };
  return { capabilities: () => call('capabilities'), boot: c => call('boot', c), createEvent: i => call('createEvent', i), advance: ms => call('advance', { ms }), inspectPending: () => call('inspectPending'),
    armCrash: p => call('armCrash', { point: p }), setClock: ms => call('setClock', { ms }), corruptOutbox: k => call('corruptOutbox', { kind: k }), restart: () => call('restart'), shutdown: async () => { try { await call('shutdown'); } catch { /* */ } },
    close() { try { child?.kill(); } catch { /* */ } child = null; } };
}
