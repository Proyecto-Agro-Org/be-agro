// BE14-03 — MODE A adapter: drives the BE14-01 REFERENCE publisher (or a mutated copy of it, for the kit's own mutation tests) through the black-box interface, with a VIRTUAL clock.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMqttPublisherPort } from '../be14-01/mqtt-port.js';
import * as defaultRef from '../be14-01/reference-publisher.js';
import type { BootConfig, BootResult, Capability, CreateInput, CreateResult, LogicalState, PendingEntry, PublisherAdapter } from './adapter.js';
import type { World } from './world.js';

type RefModule = typeof defaultRef;
const CRASH_POINTS: Record<string, string> = { 'before-publish': 'C1:before-publish', 'after-publish-before-persist': 'C2:after-publish-before-persist', 'after-puback': 'C3:after-puback', 'after-backend-answer': 'C4:after-backend-answer', 'after-confirmation': 'C5:after-confirmation-before-delete' };
const logical = (s: string, lane: string): LogicalState => s === 'CONFIRMED' ? 'confirmed' : s === 'QUARANTINED' ? 'quarantined' : s === 'CONFLICT_REQUIRES_REVIEW' ? 'conflict' : s === 'UNCONFIRMED_EXPLICIT' ? 'unconfirmed-explicit'
  : lane === 'slow' ? 'unconfirmed' : s === 'BROKER_ACCEPTED' || s === 'WAITING_CONFIRMATION' ? 'broker-accepted' : 'pending';

export interface ReferenceAdapterOptions { realClock?: boolean; ackTimeoutMs?: number; connectTimeoutMs?: number }
/** `world` may be a bare `{}` when the publisher talks to a REAL broker (BE14-04 self-test bridge). */
export function createReferenceAdapter(world: Pick<World, 'mqttFactory'> | { mqttFactory?: undefined }, ref: RefModule = defaultRef, opts: ReferenceAdapterOptions = {}): PublisherAdapter & { readonly storePath: string } {
  let cfg: BootConfig | null = null, pub: ReturnType<RefModule['createReferencePublisher']> | null = null, port: ReturnType<typeof createMqttPublisherPort> | null = null, now = opts.realClock ? Date.now() : 10_000_000, offset = 0, crashed = false, armed: string | null = null, failNextSave = false;
  const dir = mkdtempSync(join(tmpdir(), 'conf-')), storePath = join(dir, 'outbox.json');
  const build = (): BootResult => {
    if (!cfg) return { ok: false, failure: 'NOT_BOOTED' };
    let store; try { store = ref.createFileStore(storePath); store.load(); } catch (e) { return { ok: false, failure: (e as Error).message.includes('CORRUPT') || (e as Error).name === 'SyntaxError' ? 'OUTBOX_CORRUPT' : 'OUTBOX_UNREADABLE' }; }   // fail-closed: never start empty over an unreadable outbox
    const guarded: typeof store = { load: () => store.load(), save: s => { if (failNextSave) { failNextSave = false; throw new Error('PERSIST_FAILED'); } store.save(s); } };
    port = createMqttPublisherPort({ url: cfg.mqttUrl, technicalKey: cfg.technicalKey, username: cfg.mqttCredentials?.username ?? 'conformance', password: cfg.mqttCredentials?.password ?? 'TEST_ONLY', topic: cfg.topic, ...(world.mqttFactory ? { factory: world.mqttFactory as never } : {}), ackTimeoutMs: opts.ackTimeoutMs ?? 120, connectTimeoutMs: opts.connectTimeoutMs ?? 120 });
    const p = cfg.policy;
    const policy = { mode: 'TEST_ONLY' as const, capacity: cfg.capacity ?? 500, fast: { initialDelayMs: p?.fastDelayMs ?? 100, backoffFactor: 1, maxDelayMs: p?.fastDelayMs ?? 100, jitterRatio: 0, maxAttempts: p?.fastMaxAttempts ?? 5, maxElapsedMs: p?.fastMaxElapsedMs ?? 5000 }, slow: { intervalMs: p?.slowIntervalMs ?? 1000, confirmWaitMs: 50, maxElapsedMs: p?.slowMaxElapsedMs ?? 20_000 } };
    pub = ref.createReferencePublisher({ store: guarded, policy, technicalKey: cfg.technicalKey, mqtt: port, reconciliation: ref.createHttpReconciliationClient({ baseUrl: cfg.reconciliationUrl, auth: ref.createTestOnlyAuth(cfg.principal), timeoutMs: 300 }), now: () => (opts.realClock ? Date.now() + offset : now), random: () => 0.5,
      hooks: { crashAt: pt => { if (armed && pt === armed) { armed = null; crashed = true; throw new Error('CRASH ' + pt); } } } });
    crashed = false; return { ok: true };
  };
  const drive = async (ms: number) => {
    if (opts.realClock) { const end = Date.now() + ms; while (Date.now() < end && !crashed) { try { await pub?.tick(8); } catch (e) { if (!/CRASH/.test((e as Error).message)) throw e; crashed = true; } await new Promise(r => setTimeout(r, 25)); } return; }
    if (!pub || crashed) return; const end = now + ms;
    for (let i = 0; i < 20_000 && now < end && !crashed; i += 1) {
      const open = pub.entries().filter(e => !ref.TERMINAL_STATES.includes(e.state)); const next = open.length ? Math.min(...open.map(e => e.nextAttemptAt)) : end; now = Math.min(end, Math.max(now, next));
      try { await pub.tick(8); } catch (e) { if (!/CRASH/.test((e as Error).message)) throw e; crashed = true; }
      if (!open.length) break;
    }
    now = Math.max(now, end);
  };
  return {
    storePath,
    async capabilities(): Promise<Capability[]> { return ['explicit-event-input', 'crash-injection', 'clock-control', 'capacity-config', 'policy-config', 'outbox-corruption', 'canonical-serialization']; },
    async boot(c) { cfg = c; return build(); },
    async createEvent(i: CreateInput): Promise<CreateResult> {
      if (!pub || !cfg) return { result: 'rejected', reason: 'NOT_BOOTED' };
      if (i.deviceTimestamp === 'OMIT') return { result: 'rejected', reason: 'DEVICE_TIMESTAMP_REQUIRED' };               // the reference never emits an event without deviceTimestamp
      try {
        const r = pub.submitReading({ payload: i.payload, ...(i.eventId === undefined ? {} : { eventId: i.eventId }), ...(i.deviceTimestamp === undefined ? {} : { deviceTimestamp: i.deviceTimestamp }), ...(i.sentAt === undefined ? {} : { sentAt: i.sentAt }), topic: cfg.topic, dataOrigin: 'simulated' });
        if (r.result === 'ACCEPTED' || r.result === 'ALREADY_PRESENT') return { result: 'accepted', eventId: r.eventId }; return { result: 'rejected', reason: r.result };
      } catch (e) { return { result: 'rejected', reason: (e as Error).message.slice(0, 60) }; }
    },
    advance: drive,
    async inspectPending(): Promise<PendingEntry[]> { return (pub?.entries() ?? []).map(e => ({ eventId: e.eventId, payloadSha256: e.payloadSha256, payloadB64: e.payloadB64, state: logical(e.state, e.lane), lane: e.lane, attempts: e.publishAttempts })); },
    async armCrash(pt) { if (pt === 'before-persist') failNextSave = true; else { armed = CRASH_POINTS[pt] ?? null; } },
    async setClock(ms) { if (opts.realClock) offset = ms - Date.now(); else now = ms; },
    async corruptOutbox(kind) { if (kind === 'garbage') writeFileSync(storePath, '{"version":1,"nextSeq":3,"entries":[ {"torn":'); else writeFileSync(storePath + '.tmp', '{"version":1,"entries":[GARBAGE'); },
    async restart() { try { await port?.close(); } catch { /* */ } pub = null; port = null; armed = null; failNextSave = false; return build(); },
    async shutdown() { try { await port?.close(); } catch { /* */ } pub = null; },
  };
}
export const outboxFileExists = (a: { storePath: string }) => existsSync(a.storePath) && readFileSync(a.storePath, 'utf8').length > 0;
