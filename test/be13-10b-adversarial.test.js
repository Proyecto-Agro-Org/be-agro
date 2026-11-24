// BE13-10B — adversarial vectors against replay lease governance (offline, TEST_ONLY doubles).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createResilientMeasurementIngestionRoot } from '../dist/src/services/measurement-ingestion-root.js';
import { quarantineValidator } from '../dist/src/models/ingestion-quarantine.models.js';
import { leaseSetup, A, B, ev, evidenceFor, TEST_ONLY_LEASE_WINDOW } from '../test-support/be13-10b-lease.fixtures.js';

const expire = s => { s.lease.clock.at += TEST_ONLY_LEASE_WINDOW + 1; };
const rootOf = s => createResilientMeasurementIngestionRoot(s.deps);
const rootReplay = (s, lease) => rootOf(s).replay({ quarantineId: s.id, protectedDocument: s.doc, provenanceEvidence: evidenceFor(s.doc), field: 'temperature', ...(lease ? { lease } : {}) });

test('A01 forged ownerId: in the credential or the replay input, the owner is ALWAYS the authorized operatorId', async () => {
  const s = await leaseSetup();
  const gate = s.holdNextWrite();
  const running = s.boot.operations.replay({ token: 'tok-a', operatorId: 'op-b', ownerId: 'op-b' }, { ...(await s.replayInput()), ownerId: 'op-b', lease: { ownerId: 'op-b', leaseToken: 1 } });
  await gate.atGate;
  assert.equal((await s.record()).lease.ownerId, 'op-a');
  assert.equal((await s.leaseOp('releaseLease', { token: 'tok-b', operatorId: 'op-a' })).reason, 'lease-owned-by-another-operator');
  gate.release();
  assert.equal((await running).quarantineStatus, 'RESOLVED');
});

test('A02 caller-provided acquiredAt is ignored: acquiredAt comes from the time authority only', async () => {
  const s = await leaseSetup();
  const gate = s.holdNextWrite();
  const running = s.boot.operations.replay(A, { ...(await s.replayInput()), acquiredAt: 0, leaseAcquiredAt: 0 });
  await gate.atGate;
  assert.equal((await s.record()).lease.acquiredAt, s.lease.clock.at);
  expire(s); // a caller-provided 0 would have made it "expired" long ago; trusted time decides
  gate.release(); await running;
});

test('A03 forged realm: credential/input realm ignored; a store bound to another realm never acquires or settles this entry', async () => {
  const s = await leaseSetup();
  assert.equal((await s.boot.operations.replay({ token: 'tok-preview', realm: 'test' }, { ...(await s.replayInput()), realm: 'test' })).reason, 'realm-out-of-scope');
  const { createInMemoryQuarantine } = await import('../test-support/be13-composition.fixtures.js');
  const other = await createInMemoryQuarantine('preview');
  other.rows.set(s.id, { ...(await s.record()), realm: 'test' });
  assert.equal((await other.acquireLease({ quarantineId: s.id, expectedVersion: await s.version(), ownerId: 'op-a', acquiredAt: 1 })).result, 'not-found');
  assert.equal(await other.settleReplay({ quarantineId: s.id, holder: { kind: 'unleased' }, to: 'RESOLVED', outcome: 'x-y', evidence: null }), 'stale');
});

test('A04 malformed time authority: no acquisition and no expiry, whatever it answers', async () => {
  for (const now of [async () => 'now', async () => ({ realm: 'test', status: 'trusted', at: Infinity, authorityRevision: 1 }), async () => ({ realm: 'test', status: 'TRUSTED', at: 1, authorityRevision: 1 }),
    () => { throw new Error('clock'); }, async () => ({ get realm() { throw new Error('hostile'); } })]) {
    const s = await leaseSetup({ extra: { timeAuthority: { now } } });
    assert.equal((await s.boot.operations.replay(A, await s.replayInput())).reason, 'time-authority-unavailable');
    assert.equal((await s.record()).status, 'RETRYABLE');
  }
});

test('A05 malicious lease policy: EXPIRED for another realm / with extra fields / via hostile getters never enables recovery', async () => {
  for (const evaluate of [async () => ({ realm: 'preview', status: 'EXPIRED', recoveryByNonOwner: 'when-expired', policyRevision: 1 }),
    async ({ realm }) => ({ realm, status: 'EXPIRED', recoveryByNonOwner: 'when-expired', policyRevision: 1, ownerId: 'op-b' }),
    async ({ realm }) => ({ realm, get status() { throw new Error('x'); }, recoveryByNonOwner: 'when-expired', policyRevision: 1 }),
    async ({ realm }) => ({ realm, status: 'EXPIRED', recoveryByNonOwner: 'always', policyRevision: 1 })]) {
    const s = await leaseSetup({ extra: { leasePolicy: { evaluate } } });
    await s.quarantine.acquireLease({ quarantineId: s.id, expectedVersion: await s.version(), ownerId: 'op-a', acquiredAt: s.lease.clock.at });
    assert.equal((await s.leaseOp('recoverExpiredLease', B)).status, 'denied');
    assert.equal((await s.record()).lease.ownerId, 'op-a');
  }
});

test('A06 stale OWNER replay: same owner, older token (lease recovered and re-acquired meanwhile) cannot write', async () => {
  const s = await leaseSetup();
  const gate = s.holdNextWrite();
  const oldRun = s.boot.operations.replay(A, await s.replayInput());   // op-a, token t1, parked
  await gate.atGate;
  expire(s);
  await s.leaseOp('recoverExpiredLease', B);
  const t2 = await s.quarantine.acquireLease({ quarantineId: s.id, expectedVersion: await s.version(), ownerId: 'op-a', acquiredAt: s.lease.clock.at }); // op-a again, token t2
  gate.release();
  assert.equal((await oldRun).reason, 'stale-replay-lease');
  assert.equal(s.persistence.measurements.size, 0);
  assert.deepEqual((await s.record()).lease, { ownerId: 'op-a', acquiredAt: s.lease.clock.at, token: t2.leaseToken }, 'the new lease is untouched');
});

test('A07 replay after a discard attempt: discard of REPLAYING is refused; a replay of a DISCARDED entry is refused', async () => {
  const s = await leaseSetup();
  await s.quarantine.acquireLease({ quarantineId: s.id, expectedVersion: await s.version(), ownerId: 'op-a', acquiredAt: s.lease.clock.at });
  assert.equal((await s.leaseOp('discard', B)).reason, 'transition-not-allowed');
  expire(s); await s.leaseOp('recoverExpiredLease', B); await s.leaseOp('discard', B);
  assert.equal((await s.boot.operations.replay(A, await s.replayInput())).reason, 'transition-not-allowed');
  assert.equal((await rootReplay(s)).reasonCode, 'replay-not-allowed');
  assert.equal(s.persistence.measurements.size, 0);
});

test('A08 direct non-owner release at the store: wrong owner, wrong token, wrong version or generic transition all fail', async () => {
  const s = await leaseSetup();
  const { leaseToken } = await s.quarantine.acquireLease({ quarantineId: s.id, expectedVersion: await s.version(), ownerId: 'op-a', acquiredAt: 1 });
  const settle = holder => s.quarantine.settleReplay({ quarantineId: s.id, holder, to: 'RETRYABLE', outcome: 'x-y', evidence: null });
  assert.equal(await settle({ kind: 'lease', ownerId: 'op-b', leaseToken }), 'stale');
  assert.equal(await settle({ kind: 'lease', ownerId: 'op-a', leaseToken: leaseToken - 1 }), 'stale');
  assert.equal(await s.quarantine.settleReplay({ quarantineId: s.id, holder: { kind: 'lease', ownerId: 'op-a', leaseToken }, to: 'RETRYABLE', outcome: 'x-y', evidence: null, expectedVersion: leaseToken + 5 }), 'stale');
  assert.equal(await settle({ kind: 'unleased' }), 'not-allowed');
  assert.equal(await s.quarantine.transition({ quarantineId: s.id, from: 'REPLAYING', to: 'RETRYABLE', evidence: 'x', outcome: 'x-y' }), 'not-allowed');
  assert.equal((await s.record()).status, 'REPLAYING');
});

test('A09 audit bypass: without a durable request audit neither owner release nor expired recovery happens', async () => {
  const s = await leaseSetup();
  await s.quarantine.acquireLease({ quarantineId: s.id, expectedVersion: await s.version(), ownerId: 'op-a', acquiredAt: s.lease.clock.at });
  expire(s);
  for (const append of [async () => { throw new Error('down'); }, async () => undefined, async () => ({ realm: 'preview', auditId: 'a_' + '0'.repeat(64), sequence: 1 })]) {
    const broken = await leaseSetup({ extra: { audit: { ...s.audit, append } } });
    await broken.quarantine.acquireLease({ quarantineId: broken.id, expectedVersion: await broken.version(), ownerId: 'op-a', acquiredAt: broken.lease.clock.at });
    expire(broken);
    assert.equal((await broken.leaseOp('recoverExpiredLease', B)).reason, 'audit-unavailable');
    assert.equal((await broken.leaseOp('releaseLease', A)).reason, 'audit-unavailable');
    assert.equal((await broken.record()).status, 'REPLAYING');
  }
});

test('A10 capability injected from the credential never grants recovery or release', async () => {
  const s = await leaseSetup();
  await s.quarantine.acquireLease({ quarantineId: s.id, expectedVersion: await s.version(), ownerId: 'op-a', acquiredAt: s.lease.clock.at });
  expire(s);
  assert.equal((await s.leaseOp('recoverExpiredLease', { token: 'tok-replayer', capabilities: ['QUARANTINE_UNBLOCK'], roles: ['admin'] })).reason, 'forbidden');
  assert.equal((await s.leaseOp('releaseLease', { token: 'tok-a', capabilities: ['QUARANTINE_UNBLOCK'] }, { expectedVersion: await s.version() })).status, 'done');
});

test('A11 lease token reuse: an old (owner, token) pair cannot settle, fence or replay after a new acquisition', async () => {
  const s = await leaseSetup();
  const first = await s.quarantine.acquireLease({ quarantineId: s.id, expectedVersion: await s.version(), ownerId: 'op-a', acquiredAt: 1 });
  await s.quarantine.settleReplay({ quarantineId: s.id, holder: { kind: 'lease', ownerId: 'op-a', leaseToken: first.leaseToken }, to: 'RETRYABLE', outcome: 'x-y', evidence: null });
  const second = await s.quarantine.acquireLease({ quarantineId: s.id, expectedVersion: await s.version(), ownerId: 'op-a', acquiredAt: 2 });
  assert.notEqual(first.leaseToken, second.leaseToken);
  assert.ok(second.leaseToken > first.leaseToken, 'tokens are monotonic');
  assert.equal(await s.quarantine.settleReplay({ quarantineId: s.id, holder: { kind: 'lease', ownerId: 'op-a', leaseToken: first.leaseToken }, to: 'RESOLVED', outcome: 'x-y', evidence: null }), 'stale');
  assert.equal((await rootReplay(s, { ownerId: 'op-a', leaseToken: first.leaseToken })).reasonCode, 'stale-replay-lease');
  assert.equal(s.persistence.measurements.size, 0);
});

test('A12 invalid numerics: tokens/versions that are 0, negative, fractional, NaN, unsafe or strings are rejected', async () => {
  const s = await leaseSetup();
  for (const leaseToken of [0, -1, 1.5, NaN, 2 ** 53, '5', null]) assert.equal((await rootReplay(s, { ownerId: 'op-a', leaseToken })).reasonCode, 'invalid-replay-input', String(leaseToken));
  for (const expectedVersion of [0, -1, 1.5, NaN, 2 ** 53, '1']) assert.equal((await s.boot.operations.replay(A, { ...(await s.replayInput()), expectedVersion })).reason, 'invalid-request');
  for (const expectedVersion of [0, 2 ** 53, NaN]) assert.equal((await s.leaseOp('recoverExpiredLease', B, { expectedVersion })).reason, 'invalid-request');
  const token = quarantineValidator.$jsonSchema.properties.lease.properties.token;
  assert.deepEqual([token.minimum, token.maximum], [1, 9_007_199_254_740_991]);
  assert.ok(JSON.stringify(quarantineValidator.$expr).includes('REPLAYING'), 'validator couples REPLAYING and lease');
});

test('A13 no worker, timer, scheduler or wall clock in the lease code; app.ts mounts nothing new', () => {
  for (const file of ['src/services/replay-lease-governance.ts', 'src/services/ingestion-operations.service.ts', 'src/repositories/mongo-ingestion-quarantine.store.ts']) {
    const src = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    assert.equal(/Date\.now|setInterval|setTimeout|process\.env|cron|Math\.random|randomUUID/.test(src), false, file);
  }
  const app = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8');
  for (const t of ['lease', 'replay', 'recover', 'quarantine', '/audit']) assert.equal(app.includes(t), false, t);
});
