// BE13-11Q — reconciliation under a REAL Mongo majority loss (be13-07-multinode-local.ps1 -Suite be13-11q). SINTETICO, no broker. One question:
// while the evidence store cannot answer (majority lost), does the reconciliation API stay fail-closed (`pending`, never a confirmation, never `not-found`) and does the
// durable publisher keep its entries PENDING and then converge to CONFIRMED after the heal?
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import express from 'express';
import type { Connection } from 'mongoose';
import { chaos, validateMultiNodeRequest, verifyOwnedMultiNode } from './be13-07/guard.js';
import { connectMultiNode } from './be13-07/connect.js';
import { provisionBrokerInboxCollection } from '../src/models/broker-inbox.models.js';
import { provisionQuarantineCollection } from '../src/models/ingestion-quarantine.models.js';
import { brokerContextFingerprint } from '../src/iot/broker-fingerprints.js';
import { createMongoBrokerInboxStore } from '../src/repositories/mongo-broker-inbox.store.js';
import { createMongoIngestConfirmationEvidence } from '../src/repositories/mongo-ingest-confirmation.evidence.js';
import { createIngestConfirmationService } from '../src/services/ingest-confirmation.service.js';
import { createIngestConfirmationRouter } from '../src/routes/ingest-confirmation.routes.js';
import { createTokenBucketRateLimiter, PROPOSED_TEST_RATE_LIMIT } from '../src/iot/confirmation-rate-limit.js';
import { createMemoryOutboxStore, createOutboxPublisher, sha256Hex, type OutboxPolicy } from './be13-11n/publisher-outbox.js';

const INGEST = 'agro_ingest_be1311q';
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const results: { name: string; status: 'passed' | 'failed'; detail?: unknown }[] = [];
async function check(name: string, work: () => Promise<unknown>) {
  try { const detail = await work(); results.push({ name, status: 'passed', detail }); console.log('PASS ' + name + (detail ? ' ' + JSON.stringify(detail).slice(0, 320) : '')); }
  catch (error) { results.push({ name, status: 'failed', detail: (error as Error).message.slice(0, 300) }); console.log('FAIL ' + name + ' :: ' + (error as Error).message.slice(0, 300)); throw error; }
}

async function main() {
  const request = validateMultiNodeRequest(process.env); verifyOwnedMultiNode(request);
  if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) throw Error('MN_GIT_TREE_NOT_CLEAN');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const conns: Connection[] = [await connectMultiNode(request), await connectMultiNode(request)];
  let paused: number[] = [];
  try {
    const connection = conns[0]!, db = connection.db!;
    if ((await db.listCollections().toArray()).length !== 0) throw Error('MN_DATABASE_NOT_EMPTY');
    const status = async () => (await db.admin().command({ replSetGetStatus: 1 }, { readPreference: 'nearest' })) as { members: { name: string; stateStr: string; health: number }[] };
    const waitHealthy = async () => { for (let i = 0; i < 120; i += 1) { try { const s = await status(); if (s.members.filter(m => m.health === 1).length === 3 && s.members.filter(m => m.stateStr === 'PRIMARY').length === 1 && s.members.filter(m => m.stateStr === 'SECONDARY').length === 2) return; } catch { /* election */ } await sleep(500); } throw Error('MN_WAIT_TIMEOUT_healthy'); };
    await provisionBrokerInboxCollection(connection, INGEST); await provisionQuarantineCollection(connection, INGEST);
    const store = createMongoBrokerInboxStore({ connection, prefix: INGEST, realm: 'test' });
    const SOURCE = 'lab-source-a', PRINCIPAL = 'emqx-user:lab-source-a';
    const body = (id: string) => Buffer.from(JSON.stringify({ version: 1, eventId: id, sentAt: 1795115600000, payload: { temperature: 1 } }));
    let n = 0; const deliver = async (id: string) => { const bytes = body(id), rawPayloadSha256 = sha(bytes), receivedAt = 1795115600000 + (n++);
      const obs = { connectionReference: 'conn-' + n, authenticatedPrincipalReference: PRINCIPAL, mqttClientId: SOURCE, topic: 'agro/lab/in/a', qos: 1 as const, retain: false, packetId: (n % 60000) + 1, receivedAt };
      return store.persistVerifiedDelivery({ eventId: id, realm: 'test', sourceId: SOURCE, principalReference: PRINCIPAL, technicalDeviceKey: SOURCE, connectionReference: obs.connectionReference, mqttClientId: SOURCE, topic: obs.topic, qos: 1, retain: false, packetId: obs.packetId,
        receivedAt, verifiedAt: receivedAt + 1, verifierRevision: 1, mappingRevision: 1, contextFingerprint: brokerContextFingerprint('test', obs, rawPayloadSha256), rawPayloadSha256, rawPayload: bytes } as never); };
    const svc = createIngestConfirmationService({ evidence: createMongoIngestConfirmationEvidence({ connection: conns[1]!, prefix: INGEST, realm: 'test' }) });
    const authority = { kind: 'TEST_ONLY' as const, authenticate: async (r: { get(h: string): string | undefined }) => r.get('x-principal') ?? null, scopeOf: async (p: string) => p === PRINCIPAL ? { realm: 'test' as const, sourceId: SOURCE, principalReference: PRINCIPAL } : null };
    const app = express(); app.use(createIngestConfirmationRouter({ mode: 'TEST_ONLY', service: svc, authority: authority as never, rateLimiter: createTokenBucketRateLimiter(PROPOSED_TEST_RATE_LIMIT) }));
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
    const ask = async (id: string) => { const t = Date.now(); try { const r = await fetch(base + '/ingest-confirmations/' + id + '?payloadSha256=' + sha(body(id)), { headers: { 'x-principal': PRINCIPAL }, signal: AbortSignal.timeout(9000) });
      return r.status === 200 ? { ok: true as const, status: ((await r.json()) as { status: string }).status, ms: Date.now() - t } : { ok: false as const, http: r.status, ms: Date.now() - t }; } catch { return { ok: false as const, http: 0, ms: Date.now() - t }; } };
    try {
      await waitHealthy(); await deliver('q-durable');
      await check('healthy baseline: a durable event is `received-durable`, an unknown one `not-found`', async () => {
        const a = await ask('q-durable'), b = await ask('q-unknown'); assert.equal(a.ok && a.status, 'received-durable'); assert.equal(b.ok && b.status, 'not-found'); return { a, b };
      });
      const delivered = new Set<string>(['q-durable']); let healed = false;
      const policy: OutboxPolicy = { mode: 'TEST_ONLY', capacity: 50, fast: { initialDelayMs: 600, backoffFactor: 1.5, maxDelayMs: 2500, jitterRatio: 0.25, maxAttempts: 30, maxElapsedMs: 600_000 }, slow: { intervalMs: 5000, confirmWaitMs: 500, maxElapsedMs: 300_000 } };
      const pub = createOutboxPublisher({ store: createMemoryOutboxStore(), policy, deps: { now: () => Date.now(), random: () => Math.random(),
        // PUBACK always; the backend only receives the event once the store is healthy (a delivery that cannot be persisted is never ACKed in the real adapter)
        publish: async eventId => { if (healed && !delivered.has(eventId)) { await deliver(eventId); delivered.add(eventId); } return true; }, confirm: async (id, h) => { const r = await ask(id); return r.ok ? { ok: true, status: r.status } : { ok: false }; } } });
      for (const id of ['q-durable', 'q-late-1', 'q-late-2']) pub.submit({ eventId: id, bytes: body(id) });
      const loop = async (ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { await pub.tick(8); await sleep(300); } };
      const primary = (await status()).members.find(m => m.stateStr === 'PRIMARY')!; const pIdx = request.ports.indexOf(Number(primary.name.split(':')[1])); paused = [0, 1, 2].filter(i => i !== pIdx);
      let outage: unknown;
      await check('REAL majority loss: the API answers `pending` (never a confirmation, never `not-found`) within a bounded time, even for an event that IS durable on the primary', async () => {
        for (const i of paused) chaos(request, 'pause', i); const t0 = Date.now(); await sleep(1500);
        const durable = await ask('q-durable'), unknown = await ask('q-unknown'), late = await ask('q-late-1');
        for (const r of [durable, unknown, late]) { assert.equal(r.ok, true, JSON.stringify(r)); assert.equal((r as { status: string }).status, 'pending', JSON.stringify(r)); assert.ok(r.ms < 8000, 'bounded latency ' + r.ms); }
        outage = { durable, unknown, late, afterMs: Date.now() - t0 }; return outage;
      });
      await check('durable publisher during the outage: nothing is CONFIRMED, nothing is lost, retries keep the same eventId', async () => {
        await loop(12_000); const es = pub.entries(); assert.ok(es.every(e => e.status === 'PENDING'), JSON.stringify(es.map(e => e.status))); assert.ok(es.every(e => e.lastConfirmation === 'pending' || e.lastConfirmation === 'unreachable' || e.lastConfirmation === null));
        return { statuses: es.map(e => [e.eventId, e.status, e.attempts, e.lastConfirmation]) };
      });
      await check('HEAL: the store recovers; every event converges to CONFIRMED with the same eventIds (no duplicates)', async () => {
        for (const i of paused) chaos(request, 'unpause', i); paused = []; await waitHealthy(); healed = true;
        const end = Date.now() + 120_000; while (Date.now() < end && pub.stats().pending > 0) { await pub.tick(8); await sleep(300); }
        const es = pub.entries(); assert.ok(es.every(e => e.status === 'CONFIRMED'), JSON.stringify(es.map(e => [e.eventId, e.status, e.lastConfirmation])));
        const inboxCounts = await db.collection('agro_ingest_be1311q_broker_inbox').aggregate([{ $group: { _id: '$eventId', n: { $sum: 1 } } }]).toArray();
        return { statuses: es.map(e => [e.eventId, e.status, e.attempts]), inbox: inboxCounts.map(d => [d._id, d.n]) };
      });
      mkdirSync('.local-evidence', { recursive: true }); writeFileSync('.local-evidence/be13-11q-recovery.json', JSON.stringify({ label: 'LOCAL_LAB_EVIDENCE', head, outage, results }, null, 1));
      console.log('BE1311Q_LOCAL_OK ' + JSON.stringify({ passed: results.filter(r => r.status === 'passed').length, failed: results.filter(r => r.status === 'failed').length }));
    } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); void sha256Hex; }
  } finally { for (const i of paused) { try { chaos(request, 'unpause', i); } catch { /* */ } } await Promise.all(conns.map(c => c.close().catch(() => undefined))); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error('BE1311Q_LOCAL_FAILED', JSON.stringify({ message: error instanceof Error ? error.message.slice(0, 400) : 'error' })); process.exit(1); });
