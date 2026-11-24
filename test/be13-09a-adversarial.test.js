// BE13-09A — adversarial vectors for operator authorization, audit and observability (offline).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createIngestionOperationsBootstrap } from '../dist/src/services/ingestion-operations.service.js';
import { auditAppendSchema } from '../dist/src/repositories/mongo-ingestion-audit.store.js';
import { auditValidator } from '../dist/src/models/ingestion-audit.models.js';
import { emitAlert, sanitizeMetricLabels } from '../dist/src/iot/ingestion-observability.js';
import * as auditStoreModule from '../dist/src/repositories/mongo-ingestion-audit.store.js';
import { protectedDocument, world, createInMemoryPersistence, createTestOnlyRetryPolicy, createDeterministicScheduler, createInMemoryRecovery,
  createInMemoryQuarantine, createInMemoryAudit, createSyntheticOperatorAuthority, createRecordingMetrics, createRecordingAlerts } from '../test-support/be13-composition.fixtures.js';

const ACK = { mode: 'current-state-only', limitation: 'DEVICE_STATUS_HISTORY_REQUIRED' };
const verifier = { verify: e => (e && e.syntheticTestOnly === true ? { sourceId: e.sourceId, operation: 'telemetry', eventId: e.eventId, device: { kind: 'mqtt-clientid', value: e.clientid } } : null) };
const evidenceFor = doc => ({ syntheticTestOnly: true, sourceId: doc.sourceId, eventId: doc.eventId, clientid: doc.clientid });
const ALL = ['QUARANTINE_VIEW', 'QUARANTINE_REPLAY', 'QUARANTINE_UNBLOCK', 'QUARANTINE_BLOCK', 'QUARANTINE_RESOLVE', 'QUARANTINE_DISCARD', 'AUDIT_VIEW', 'OPERATIONS_VIEW'];
const table = { 'tok-admin': { operatorId: 'op-admin', realms: ['test'], capabilities: ALL, authenticationReference: 'synthetic:admin' },
  'tok-none': { operatorId: 'op-none', realms: ['test'], capabilities: [], authenticationReference: 'synthetic:none' } };
async function setup(extra = {}) {
  const w = world(); const persistence = createInMemoryPersistence(); let failing = true;
  const flaky = { lookup: k => persistence.lookup(k), persistAtomically: async i => { if (failing) throw new Error('down'); return persistence.persistAtomically(i); } };
  const quarantine = await createInMemoryQuarantine(), audit = createInMemoryAudit(), metrics = createRecordingMetrics(), alerts = createRecordingAlerts();
  const deps = { realmAuthority: { authorizedRealm: () => 'test' }, provenanceVerifier: verifier, hardware: w.deps.hardware, temporal: w.deps.temporal, catalogue: w.deps.catalogue,
    policies: w.deps.policies, identityStore: w.deps.identityStore, persistence: flaky,
    be12: { temporal: { select: async e => ({ status: 'trusted', at: e.receivedAt, clock: 'received-at' }) }, catalogue: { accepts: async () => true } },
    deviceStatusHistory: ACK, retryPolicy: createTestOnlyRetryPolicy(1), retryScheduler: createDeterministicScheduler(), recovery: createInMemoryRecovery(persistence),
    quarantine, authorization: createSyntheticOperatorAuthority(table), audit, metrics, alerts, retention: { mode: 'retain-indefinitely' }, ...extra };
  const boot = createIngestionOperationsBootstrap(deps);
  const doc = protectedDocument(); const q = await boot.ingest(doc, evidenceFor(doc), { field: 'temperature' });
  failing = false;
  return { deps, boot, doc, q, quarantine, audit, metrics, alerts, persistence, version: (await quarantine.get(q.quarantineId)).version };
}
const replay = (s, credential, extra = {}) => s.boot.operations.replay(credential, { quarantineId: s.q.quarantineId, expectedVersion: s.version, protectedDocument: s.doc,
  provenanceEvidence: evidenceFor(s.doc), field: 'temperature', ...extra });

test('V1 forged operatorId / roles / capabilities / realm in the credential or the input are ignored', async () => {
  const s = await setup();
  for (const credential of [{ operatorId: 'op-admin' }, { token: 'tok-none', capabilities: ALL }, { token: 'tok-none', roles: ['ADMIN'], realm: 'test' }, 'tok-admin', null]) {
    assert.equal((await replay(s, credential)).status, 'denied');
  }
  assert.equal((await replay(s, { token: 'tok-none' }, { capabilities: ALL, operatorId: 'op-admin', realm: 'test' })).status, 'denied');
  assert.equal(s.persistence.measurements.size, 0);
});

test('V2 cross-realm quarantineId and forged ids are denied', async () => {
  const s = await setup();
  const preview = createSyntheticOperatorAuthority({ 'tok-p': { operatorId: 'op-p', realms: ['preview'], capabilities: ALL, authenticationReference: 'x' } });
  const boot = createIngestionOperationsBootstrap({ ...s.deps, authorization: preview });
  assert.equal((await boot.operations.replay({ token: 'tok-p' }, { quarantineId: s.q.quarantineId, expectedVersion: s.version, protectedDocument: s.doc, provenanceEvidence: evidenceFor(s.doc), field: 'temperature' })).reason, 'realm-out-of-scope');
  for (const id of ['q_' + 'f'.repeat(64), 'x', { $ne: null }]) {
    const r = await s.boot.operations.discard({ token: 'tok-admin' }, { quarantineId: id, expectedVersion: 1, evidence: { evidenceType: 'operator-decision', reference: 'T-1' } });
    assert.ok(['quarantine-not-found', 'invalid-request'].includes(r.reason));
  }
});

test('V3 evidence spoofing: issuedBy/verification cannot be supplied; free text and oversized metadata are rejected', async () => {
  const s = await setup();
  const bad = [
    { evidenceType: 'policy-approval', reference: 'T-1', issuedBy: 'ceo', verification: 'VERIFIED' },
    { evidenceType: 'operator-decision', reference: 'see https://evil.example/?token=abc' },
    { evidenceType: 'operator-decision', reference: 'T-1', metadata: Object.fromEntries(Array.from({ length: 11 }, (_, i) => ['k' + i, i])) },
    { evidenceType: 'operator-decision', reference: 'T-1', metadata: { stack: 'Error: x\n at y' } },
    { evidenceType: 'cryptographic-proof', reference: 'T-1' }, 'operator:fixed', null,
  ];
  for (const evidence of bad) assert.equal((await s.boot.operations.discard({ token: 'tok-admin' }, { quarantineId: s.q.quarantineId, expectedVersion: s.version, evidence })).reason, 'evidence-required');
  const ok = await s.boot.operations.discard({ token: 'tok-admin' }, { quarantineId: s.q.quarantineId, expectedVersion: s.version, evidence: { evidenceType: 'operator-decision', reference: 'T-1' } });
  assert.equal(ok.status, 'done');
  const entry = s.audit.entries.find(e => e.action === 'discarded');
  assert.deepEqual(entry.evidence, { evidenceType: 'operator-decision', reference: 'T-1', verification: 'DECLARED_UNVERIFIED' });
  assert.equal(entry.actorId, 'op-admin', 'issuedBy comes from the authorized principal');
});

test('V4 audit poisoning: append schema and Mongo validator reject payload, stack, secrets and bad values; the store has no update/delete', () => {
  const base = { realm: 'test', quarantineId: null, eventId: null, action: 'replay-requested', actorId: 'op', actorCapabilities: [], outcome: 'requested', reasonCode: null, evidence: null };
  assert.equal(auditAppendSchema.safeParse(base).success, true);
  for (const bad of [{ ...base, rawPayload: { t: 1 } }, { ...base, stack: 'Error' }, { ...base, 'x-emqx-key': 'k' }, { ...base, realm: undefined }, { ...base, action: 'deleted' },
    { ...base, outcome: 'Bad Outcome' }, { ...base, actorId: 'op with spaces' }, { ...base, actorCapabilities: ['ROOT'] }, { ...base, actorCapabilities: ['AUDIT_VIEW', 'AUDIT_VIEW'] }]) {
    assert.equal(auditAppendSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
  const v = auditValidator.$jsonSchema;
  assert.equal(v.additionalProperties, false); assert.equal(v.properties.sequence.minimum, 1);
  for (const f of ['rawPayload', 'payload', 'stack', 'message', 'token']) assert.equal(Object.hasOwn(v.properties, f), false);
  const source = readFileSync(new URL('../src/repositories/mongo-ingestion-audit.store.ts', import.meta.url), 'utf8');
  for (const forbidden of ['deleteOne', 'deleteMany', 'replaceOne', 'findOneAndDelete', 'updateMany']) assert.equal(source.includes(forbidden), false, forbidden);
  assert.deepEqual(Object.keys(auditStoreModule).sort(), ['auditAppendSchema', 'createMongoIngestionAuditStore']);
});

test('V5 metrics cardinality injection and alert payload leak are neutralized', async () => {
  const injected = sanitizeMetricLabels({ stage: 'trust-gate', reasonCode: 'q_' + 'a'.repeat(64), outcome: 'client-A', retryClass: 'security', eventId: 'e1', sensorId: 's', deviceId: 'd', realm: 'test' });
  assert.deepEqual(injected, { stage: 'trust-gate', reasonCode: 'other', retryClass: 'security', outcome: 'other' });
  const events = [];
  await emitAlert({ emit: e => events.push(e) }, { type: 'RETRY_EXHAUSTED', severity: 'WARNING', reasonCode: 'synthetic-device-001', eventId: 'e1', quarantineId: 'q_x', payload: { t: 1 } });
  assert.deepEqual(events, [{ type: 'RETRY_EXHAUSTED', severity: 'WARNING', reasonCode: null }]);
  await emitAlert({ emit: e => events.push(e) }, { type: 'MADE_UP', severity: 'WARNING', reasonCode: null });
  await emitAlert({ emit: e => events.push(e) }, { type: 'RETRY_EXHAUSTED', severity: 'PANIC', reasonCode: null });
  assert.equal(events.length, 1);
});

test('V6 malformed audit store responses never count as durable audit (fail-closed)', async () => {
  for (const append of [async () => ({}), async () => null, async () => ({ realm: 'production', auditId: 'a_' + 'a'.repeat(64), sequence: 1 }), async () => ({ realm: 'test', auditId: 'x', sequence: 0 })]) {
    const s = await setup();
    const fakeAudit = { ...s.audit, append };
    const boot = createIngestionOperationsBootstrap({ ...s.deps, audit: fakeAudit });
    const r = await boot.operations.discard({ token: 'tok-admin' }, { quarantineId: s.q.quarantineId, expectedVersion: s.version, evidence: { evidenceType: 'operator-decision', reference: 'T-1' } });
    assert.equal(r.reason, 'audit-unavailable');
    assert.equal((await s.quarantine.get(s.q.quarantineId)).status, 'RETRYABLE');
  }
});

test('V7 repeated replays and replay after resolution are refused', async () => {
  const s = await setup();
  const first = await replay(s, { token: 'tok-admin' });
  assert.equal(first.quarantineStatus, 'RESOLVED');
  assert.equal((await replay(s, { token: 'tok-admin' })).status, 'denied');
  assert.equal((await s.boot.operations.replay({ token: 'tok-admin' }, { quarantineId: s.q.quarantineId, expectedVersion: first.version, protectedDocument: s.doc,
    provenanceEvidence: evidenceFor(s.doc), field: 'temperature' })).reason, 'transition-not-allowed');
  assert.equal(s.persistence.measurements.size, 1);
});

test('V8 no endpoints, workers or env-driven modes', () => {
  const app = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8');
  for (const token of ['ingestion-operations', 'quarantine', 'replay', '/audit', '/metrics']) assert.equal(app.includes(token), false, token);
  for (const file of ['../src/services/ingestion-operations.service.ts', '../src/iot/ingestion-observability.ts', '../src/repositories/mongo-ingestion-audit.store.ts']) {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8');
    for (const forbidden of ['process.env', 'setInterval', 'Date.now', 'Math.random', 'express']) assert.equal(text.includes(forbidden), false, `${file}: ${forbidden}`);
  }
});
