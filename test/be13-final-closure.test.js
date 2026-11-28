// BE13-FINAL — closure guards: productive defaults stay BLOCKED, nothing is composed productively, the state vocabulary is the documented one, and the key invariants hold end to end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { CONFIRMED_STATUSES } from '../dist/src/iot/ingest-confirmation.contracts.js';
import { DEFAULT_RATE_LIMIT_POLICY, createTokenBucketRateLimiter } from '../dist/src/iot/confirmation-rate-limit.js';
import { BLOCKED_CONFIRMATION_AUTHORITY, createIngestConfirmationRouter } from '../dist/src/routes/ingest-confirmation.routes.js';
import { DEFAULT_PUBLISHER_RETRY_POLICY } from '../dist/scripts/be13-11j/publisher-reconciler.js';
import * as outbox from '../dist/scripts/be13-11n/publisher-outbox.js';
import { parseArgs } from '../dist/scripts/be13-11l/inbox-eventid-migration.js';
import { createIngestConfirmationService } from '../dist/src/services/ingest-confirmation.service.js';
import { A, H, H2, createBackend } from '../test-support/be13-11j-invariants.js';
import { bytesOf, rig } from '../test-support/be13-11n-invariants.js';

const read = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8');

test('F1 every productive default is BLOCKED / dry-run: auth, rate limit, retry, outbox policy, migration', () => {
  assert.equal(DEFAULT_RATE_LIMIT_POLICY.mode, 'BLOCKED'); assert.equal(DEFAULT_PUBLISHER_RETRY_POLICY.mode, 'BLOCKED'); assert.equal(outbox.DEFAULT_OUTBOX_POLICY.mode, 'BLOCKED'); assert.equal(BLOCKED_CONFIRMATION_AUTHORITY.kind, 'BLOCKED');
  assert.equal(parseArgs([]).apply, false);
  const service = createIngestConfirmationService({ evidence: createBackend().evidence });
  const limiter = createTokenBucketRateLimiter({ mode: 'TEST_ONLY', perPrincipalRatePerSecond: 1, perPrincipalBurst: 1, globalRatePerSecond: 1, globalBurst: 1, maxKeys: 1 });
  assert.throws(() => createIngestConfirmationRouter({ mode: 'TEST_ONLY', service, authority: BLOCKED_CONFIRMATION_AUTHORITY, rateLimiter: limiter }), /AUTH_BLOCKED/);
  assert.throws(() => outbox.createOutboxPublisher({ store: outbox.createMemoryOutboxStore(), policy: outbox.DEFAULT_OUTBOX_POLICY, deps: rig(outbox).deps }), /BLOCKED/);
});

test('F2 nothing of the reconciliation machinery is composed in the productive app, and no productive source imports a scripts/ lab module', () => {
  for (const f of ['src/app.ts', 'src/http/infrastructure.ts', 'src/http/protect-application.ts', 'src/config/cors.ts']) assert.equal(/ingest-confirmation|confirmation-rate-limit|publisher-outbox|quarantine-reconcile|publisher-reconciler/.test(read(f)), false, f);
  const walk = d => readdirSync(new URL('../' + d, import.meta.url), { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(d + '/' + e.name) : [d + '/' + e.name]);
  for (const f of walk('src').filter(f => f.endsWith('.ts'))) assert.equal(/from '(\.\.\/)+scripts\//.test(read(f)), false, f);
});

test('F3 the state vocabulary is exactly the documented one; only three states confirm', () => {
  const doc = read('CONTRATO_BE13_RECONCILIACION_E2E.md');
  for (const s of ['processed', 'duplicate-confirmed', 'received-durable', 'quarantined', 'conflict', 'pending', 'not-found', 'CONFIRMED', 'QUARANTINED', 'CONFLICT', 'UNCONFIRMED_EXPLICIT', 'REJECTED_OUTBOX_FULL']) assert.ok(doc.includes(s), s);
  assert.deepEqual([...CONFIRMED_STATUSES].sort(), ['duplicate-confirmed', 'processed', 'received-durable']);
  assert.match(read('src/iot/ingest-confirmation.contracts.ts'), /'received-durable' \| 'processed' \| 'duplicate-confirmed' \| 'pending' \| 'not-found' \| 'quarantined' \| 'conflict'/);
});

test('F4 same eventId + same payload is a retry, same eventId + different payload is a conflict — at the confirmation and at the outbox', async () => {
  const be = createBackend(); be.deliver(A, 'f4', H); be.deliver(A, 'f4', H); const svc = createIngestConfirmationService({ evidence: be.evidence });
  assert.equal((await svc.confirm(A, 'f4', H)).status, 'duplicate-confirmed'); assert.equal(be.measurementCount(), 1); assert.equal((await svc.confirm(A, 'f4', H2)).status, 'conflict');
  const r = rig(outbox); assert.equal(r.pub.submit({ eventId: 'f4', bytes: bytesOf('f4', 1) }).result, 'ACCEPTED'); assert.equal(r.pub.submit({ eventId: 'f4', bytes: bytesOf('f4', 1) }).result, 'ALREADY_PRESENT');
  assert.equal(r.pub.submit({ eventId: 'f4', bytes: bytesOf('f4', 2) }).result, 'REJECTED_EVENT_ID_REUSED_WITH_OTHER_BYTES');
});

test('F5 PUBACK + silence never becomes success end to end (outbox + real confirmation service): PENDING, then UNCONFIRMED_EXPLICIT, never CONFIRMED', async () => {
  const be = createBackend(), svc = createIngestConfirmationService({ evidence: be.evidence });
  const r = rig(outbox, { publishAs: () => ({ puback: true, deliver: false }), confirmAs: async (id, h) => ({ ok: true, status: (await svc.confirm(A, id, h)).status }) });
  r.pub.submit({ eventId: 'f5', bytes: bytesOf('f5') }); await r.pump(); const e = r.pub.get('f5'); assert.equal(e.status, 'UNCONFIRMED_EXPLICIT'); assert.ok(e.brokerAcceptedCount >= 1); assert.equal(be.measurementCount(), 0);
});

test('F6 no secrets in the new modules: no credential-like literals, no connection strings, no Atlas hosts', () => {
  const files = ['src/iot/ingest-confirmation.contracts.ts', 'src/services/ingest-confirmation.service.ts', 'src/routes/ingest-confirmation.routes.ts', 'src/iot/confirmation-rate-limit.ts', 'src/iot/confirmation-observability.ts', 'src/iot/quarantine-reconcile-scope.ts',
    'src/repositories/mongo-ingest-confirmation.evidence.ts', 'scripts/be13-11l/inbox-eventid-migration.ts', 'scripts/be13-11n/publisher-outbox.ts', 'scripts/be13-11p/publisher-observability.ts'];
  for (const f of files) assert.equal(/password\s*[:=]\s*['"][^'"]{4,}|mongodb(\+srv)?:\/\/[^\s'"]+:[^\s'"]+@|BEGIN [A-Z ]*PRIVATE KEY/i.test(read(f).replace(/\/\/.*$/gm, '')), false, f);
});
