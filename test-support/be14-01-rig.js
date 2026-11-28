// BE14-01 — deterministic rig for the reference publisher: fake clock, scripted MQTT, reconciliation backed by the REAL confirmation service over the in-memory evidence model.
import { createIngestConfirmationService } from '../dist/src/services/ingest-confirmation.service.js';
import { A, createBackend } from './be13-11j-invariants.js';

export const KEY = 'ESP32-AGRO-001';
const FAST = { initialDelayMs: 100, backoffFactor: 2, maxDelayMs: 1000, jitterRatio: 0, maxAttempts: 3, maxElapsedMs: 20_000 };
const SLOW = { intervalMs: 5000, confirmWaitMs: 50, maxElapsedMs: 40_000 };
export const policy = (o = {}) => ({ mode: 'TEST_ONLY', capacity: o.capacity ?? 100, fast: { ...FAST, ...(o.fast ?? {}) }, slow: { ...SLOW, ...(o.slow ?? {}) } });

export function rig(mod, o = {}) {
  let t = 5_000_000; const backend = o.backend ?? createBackend(), service = createIngestConfirmationService({ evidence: backend.evidence }), publishes = [], queries = [], logs = [];
  const sha = b => mod.sha256Hex(b);
  const mqtt = { publish: async (eventId, bytes) => { publishes.push({ eventId, sha: sha(bytes), at: t }); const r = o.mqttAs ? o.mqttAs(eventId, publishes.length, bytes) : { puback: true, deliver: true }; if (r.deliver) backend.deliver(A, eventId, sha(bytes)); return r.puback; } };
  const reconciliation = { query: async (eventId, hash) => { queries.push({ eventId, at: t }); if (o.recAs) return o.recAs(eventId, hash, queries.length); return { kind: 'status', status: (await service.confirm(A, eventId, hash)).status }; } };
  const store = o.store ?? mod.createMemoryStore();
  const make = (extra = {}) => mod.createReferencePublisher({ store, policy: o.pol ?? policy(), technicalKey: KEY, mqtt, reconciliation, now: () => t, random: () => 0.5, log: l => logs.push(l), ...extra });
  const pub = make(o.hooks ? { hooks: o.hooks } : {});
  const pump = async (pb = pub, horizonMs = 120_000) => { const end = t + horizonMs; for (let i = 0; i < 10_000 && t <= end; i += 1) { const open = pb.entries().filter(e => !mod.TERMINAL_STATES.includes(e.state)); if (!open.length) return; t = Math.max(t, Math.min(...open.map(e => e.nextAttemptAt))); await pb.tick(); } };
  return { pub, backend, service, publishes, queries, logs, store, make, pump, t: () => t, advance: ms => { t += ms; }, sha };
}
