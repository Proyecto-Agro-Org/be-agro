// BE14-03 — the SIMULATED WORLD a publisher under test lives in (offline, deterministic where possible). Never imported by app code.
//   * MQTT side: a fake broker reachable through an mqtt.js-shaped factory (PUBACK modes, connection loss, per-clientId connection accounting).
//   * Backend side: an in-memory model of the real evidence (claims / durable inbox / quarantine) behind the REAL confirmation service and the REAL TEST_ONLY router.
//   * HTTP side: a real local server with fault injection (429, 401, 403, 5xx, timeout, reset, malformed, wrong eventId, unknown status, forced statuses).
import { once } from 'node:events';
import type { Server } from 'node:http';
import express from 'express';
import { createTokenBucketRateLimiter, PROPOSED_TEST_RATE_LIMIT } from '../../src/iot/confirmation-rate-limit.js';
import { createIngestConfirmationRouter } from '../../src/routes/ingest-confirmation.routes.js';
import { createIngestConfirmationService } from '../../src/services/ingest-confirmation.service.js';
import { sha256Hex } from '../be14-01/reference-publisher.js';

export type MqttMode = 'normal' | 'puback-no-delivery' | 'down' | 'drop-before-puback';
export type HttpMode = { kind: 'normal' } | { kind: '429'; retryAfterSec: number } | { kind: '401' } | { kind: '403' } | { kind: '500' } | { kind: 'timeout' } | { kind: 'reset' } | { kind: 'malformed' } | { kind: 'wrong-event' } | { kind: 'unknown-status' };
export interface PublishRecord { clientId: string; topic: string; bytes: Buffer; eventId: string; sha: string; delivered: boolean }
export interface ConnectRecord { clientId: string; at: number }
export interface HttpRecord { path: string; query: Record<string, string>; principal: string | null; method: string; mode: string }
type Row = { realm: 'test'; sourceId: string; eventId: string; persistedAt?: number; committedAt?: number; payloadSha256?: string; principalReference?: string | null; declaredEventId?: string | null };

export function createWorld(o: { technicalKey: string; principalA?: string; principalB?: string }) {
  const principalA = o.principalA ?? 'p-a', principalB = o.principalB ?? 'p-b', other = 'other-device-01'; let t = 0;
  const claims: Row[] = [], inbox: Row[] = [], quarantine: Row[] = [], measurements = new Map<string, number>(); const forced = new Map<string, string>();
  const publishes: PublishRecord[] = [], connects: ConnectRecord[] = [], requests: HttpRecord[] = []; let mqttMode: MqttMode = 'normal'; let http: HttpMode = { kind: 'normal' }; const open = new Map<string, number>(); let maxConcurrent = 0; const clients: { close(): void; clientId: string }[] = [];
  const ingest = (sourceId: string, bytes: Buffer) => {
    let eventId = ''; try { eventId = String((JSON.parse(bytes.toString('utf8')) as { eventId?: string }).eventId ?? ''); } catch { return; }
    const sha = sha256Hex(bytes), key = sourceId + '|' + eventId; t += 1; inbox.push({ realm: 'test', sourceId, eventId, persistedAt: t, payloadSha256: sha });
    if (!measurements.has(key)) { measurements.set(key, 1); claims.push({ realm: 'test', sourceId, eventId, committedAt: t }); }
  };
  const evidence = {
    claims: async (s: { sourceId: string }, id: string) => claims.filter(c => c.sourceId === s.sourceId && c.eventId === id) as never,
    inbox: async (s: { sourceId: string }, id: string) => inbox.filter(c => c.sourceId === s.sourceId && c.eventId === id) as never,
    quarantine: async (s: { sourceId: string; principalReference?: string }, id: string) => quarantine.filter(c => (c.sourceId === s.sourceId && c.eventId === id) || (c.principalReference === s.principalReference && c.declaredEventId === id)) as never,
  };
  const service = createIngestConfirmationService({ evidence });
  const scopes: Record<string, { realm: 'test'; sourceId: string; principalReference: string }> = { [principalA]: { realm: 'test', sourceId: o.technicalKey, principalReference: principalA }, [principalB]: { realm: 'test', sourceId: other, principalReference: principalB } };
  const factory = (_url: string, opts: { clientId: string }) => {
    const handlers: Record<string, (...a: unknown[]) => void> = {}; let closed = false; const clientId = opts.clientId;
    const c = { clientId, on: (e: string, l: (...a: unknown[]) => void) => { handlers[e] = l; if (e === 'connect') setTimeout(() => { if (mqttMode === 'down') handlers.error?.(new Error('ECONNREFUSED')); else { connects.push({ clientId, at: ++t }); open.set(clientId, (open.get(clientId) ?? 0) + 1); maxConcurrent = Math.max(maxConcurrent, open.get(clientId)!); l(); } }, 0); },
      publish: (topic: string, payload: Buffer, _o: object, cb: (e: Error | null) => void): void => { setTimeout(() => {
        if (closed || mqttMode === 'down') return cb(new Error('not-connected'));
        const bytes = Buffer.from(payload); let eventId = ''; try { eventId = String((JSON.parse(bytes.toString('utf8')) as { eventId?: string }).eventId ?? ''); } catch { /* */ }
        const deliver = mqttMode === 'normal'; publishes.push({ clientId, topic, bytes, eventId, sha: sha256Hex(bytes), delivered: deliver });
        if (mqttMode === 'drop-before-puback') { ingest(o.technicalKey, bytes); api.dropConnections(); return; }      // the broker took it, but the publisher never learns the outcome (callback never fires)
        if (deliver) ingest(clientId === o.technicalKey ? o.technicalKey : clientId, bytes); cb(null);
      }, 0); },
      end: (_f?: boolean, _o?: object, cb?: () => void) => { if (!closed) { closed = true; open.set(clientId, Math.max(0, (open.get(clientId) ?? 1) - 1)); handlers.close?.(); } cb?.(); }, close: () => c.end() };
    clients.push(c); return c;
  };
  const app = express();
  app.use((req, res, next) => { requests.push({ path: req.path, query: Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, String(v)])), principal: req.get('x-principal') ?? null, method: req.method, mode: http.kind });
    const m = http; if (m.kind === 'normal') return next(); if (m.kind === '429') { res.setHeader('Retry-After', String(m.retryAfterSec)); return void res.status(429).json({ error: 'rate-limited' }); }
    if (m.kind === '401' || m.kind === '403') return void res.status(Number(m.kind)).json({ error: 'denied' }); if (m.kind === '500') return void res.status(500).json({ error: 'boom' });
    if (m.kind === 'timeout') return void setTimeout(() => { try { res.status(200).end('late'); } catch { /* */ } }, 1500); if (m.kind === 'reset') return void req.socket.destroy();
    const id = decodeURIComponent(req.path.split('/').pop() ?? ''); if (m.kind === 'malformed') return void res.status(200).type('text/plain').send('not json at all'); if (m.kind === 'wrong-event') return void res.status(200).json({ eventId: 'someone-else:1', status: 'processed', confirmed: true });
    return void res.status(200).json({ eventId: id, status: 'zz-unknown-status', confirmed: false }); });
  app.use((req, res, next) => { const id = decodeURIComponent(req.path.split('/').pop() ?? ''); const f = forced.get(id); if (f !== undefined && req.method === 'GET') return void res.status(200).json({ eventId: id, status: f, confirmed: ['processed', 'duplicate-confirmed', 'received-durable'].includes(f), evidenceVersion: 1, deliveries: null, durableAt: null }); next(); });
  app.use(createIngestConfirmationRouter({ mode: 'TEST_ONLY', service, authority: { kind: 'TEST_ONLY', authenticate: async (r: { get(h: string): string | undefined }) => r.get('x-principal') ?? null, scopeOf: async (p: string) => scopes[p] ?? null } as never,
    rateLimiter: createTokenBucketRateLimiter({ ...PROPOSED_TEST_RATE_LIMIT, perPrincipalBurst: 100000, globalBurst: 100000, perPrincipalRatePerSecond: 100000, globalRatePerSecond: 100000 }) }));
  let server: Server | null = null, baseUrl = '';
  const api = {
    principalA, principalB, technicalKey: o.technicalKey, mqttFactory: factory, evidence, service,
    setMqtt(m: MqttMode) { mqttMode = m; if (m === 'down') api.dropConnections(); }, setHttp(m: HttpMode) { http = m; }, force(eventId: string, status: string | null) { if (status === null) forced.delete(eventId); else forced.set(eventId, status); },
    dropConnections() { for (const c of [...clients]) c.close(); },
    /** The backend already holds the same eventId with OTHER bytes (a publisher that lost its outbox, or a buggy one). */
    seedConflict(eventId: string) { t += 1; inbox.push({ realm: 'test', sourceId: o.technicalKey, eventId, persistedAt: t, payloadSha256: 'f'.repeat(64) }); },
    markQuarantine(eventId: string) { quarantine.push({ realm: 'test', sourceId: o.technicalKey, eventId }); },
    /** The backend processes the event on its own (the publisher's confirmation answer is what gets lost/delayed). */
    backendReceives(bytes: Buffer) { ingest(o.technicalKey, bytes); },
    publishes, connects, requests, measurements: () => [...measurements.entries()].map(([k, n]) => ({ key: k, n })), measurementTotal: () => [...measurements.values()].reduce((a, b) => a + b, 0), inboxFor: (id: string) => inbox.filter(r => r.eventId === id),
    maxConcurrentConnections: () => maxConcurrent, get baseUrl() { return baseUrl; },
    async start() { server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); baseUrl = 'http://127.0.0.1:' + (server.address() as { port: number }).port; return baseUrl; },
    async stop() { api.dropConnections(); if (server) { server.closeAllConnections(); await new Promise<void>(r => server!.close(() => r())); server = null; } },
  };
  return api;
}
export type World = ReturnType<typeof createWorld>;
