// BE13-10B — replay lease ownership, trusted-time expiry, authorized recovery and replay fencing (offline).
// Every clock, window and policy here is a TEST_ONLY synthetic double, not a production value.
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeOperationsReadiness, createIngestionOperationsBootstrap } from '../dist/src/services/ingestion-operations.service.js';
import { createResilientMeasurementIngestionRoot } from '../dist/src/services/measurement-ingestion-root.js';
import { createBlockingSecurityPolicies } from '../dist/src/adapters/ingestion-production-placeholders.js';
import { leaseSetup, A, B, C, ev, evidenceFor, TEST_ONLY_LEASE_WINDOW } from '../test-support/be13-10b-lease.fixtures.js';

const expire = s => { s.lease.clock.at += TEST_ONLY_LEASE_WINDOW + 1; };

test('B01 acquire: owner = authorized operatorId, acquiredAt = trusted time, token = new version; lease exists only while REPLAYING', async () => {
  const s = await leaseSetup();
  const gate = s.holdNextWrite();
  const running = s.boot.operations.replay(A, await s.replayInput());
  await gate.atGate;
  const r = await s.record();
  assert.equal(r.status, 'REPLAYING');
  assert.deepEqual(r.lease, { ownerId: 'op-a', acquiredAt: s.lease.clock.at, token: r.version });
  gate.release();
  assert.equal((await running).quarantineStatus, 'RESOLVED');
  assert.equal((await s.record()).lease, null);
});

test('B02 the owner releases its own active lease (QUARANTINE_REPLAY) → RETRYABLE, lease cleared, audited', async () => {
  const s = await leaseSetup();
  await s.quarantine.acquireLease({ quarantineId: s.id, expectedVersion: await s.version(), ownerId: 'op-a', acquiredAt: s.lease.clock.at });
  const r = await s.leaseOp('releaseLease', A);
  assert.deepEqual([r.status, r.quarantineStatus], ['done', 'RETRYABLE']);
  assert.equal((await s.record()).lease, null);
  const trail = await s.trail();
  assert.ok(trail.indexOf('lease-release-requested') < trail.indexOf('lease-released-owner'));
});

test('B03 a non-owner cannot release an ACTIVE lease, by release or by recovery', async () => {
  const s = await leaseSetup();
  await s.quarantine.acquireLease({ quarantineId: s.id, expectedVersion: await s.version(), ownerId: 'op-a', acquiredAt: s.lease.clock.at });
  assert.equal((await s.leaseOp('releaseLease', B)).reason, 'lease-owned-by-another-operator');
  assert.equal((await s.leaseOp('recoverExpiredLease', B)).reason, 'lease-active');
  assert.equal((await s.record()).status, 'REPLAYING');
  assert.equal((await s.trail()).filter(a => a === 'lease-release-denied').length, 2);
});

test('B04 wrong realm: an operator of another realm is denied for acquire, release and recovery', async () => {
  const s = await leaseSetup();
  const preview = { token: 'tok-preview' };
  assert.equal((await s.boot.operations.replay(preview, await s.replayInput())).reason, 'realm-out-of-scope');
  await s.quarantine.acquireLease({ quarantineId: s.id, expectedVersion: await s.version(), ownerId: 'op-a', acquiredAt: s.lease.clock.at });
  expire(s);
  assert.equal((await s.leaseOp('releaseLease', preview)).reason, 'realm-out-of-scope');
  assert.equal((await s.leaseOp('recoverExpiredLease', preview)).reason, 'realm-out-of-scope');
});

test('B05 stale version: acquire, release and recovery with an old version are refused without changes', async () => {
  const s = await leaseSetup();
  const v = await s.version();
  assert.equal((await s.boot.operations.replay(A, await s.replayInput(v + 1))).reason, 'stale-version');
  await s.quarantine.acquireLease({ quarantineId: s.id, expectedVersion: v, ownerId: 'op-a', acquiredAt: s.lease.clock.at });
  expire(s);
  assert.equal((await s.leaseOp('releaseLease', A, { expectedVersion: v })).reason, 'stale-version');
  assert.equal((await s.leaseOp('recoverExpiredLease', B, { expectedVersion: v })).reason, 'stale-version');
  assert.equal((await s.record()).status, 'REPLAYING');
});

test('B06 untrusted time: no lease is acquired and no lease is ever considered expired', async () => {
  const s = await leaseSetup();
  s.lease.clock.trusted = false;
  assert.equal((await s.boot.operations.replay(A, await s.replayInput())).reason, 'time-authority-unavailable');
  assert.equal((await s.record()).status, 'RETRYABLE');
  s.lease.clock.trusted = true;
  await s.quarantine.acquireLease({ quarantineId: s.id, expectedVersion: await s.version(), ownerId: 'op-a', acquiredAt: s.lease.clock.at });
  expire(s); s.lease.clock.trusted = false;
  assert.equal((await s.leaseOp('recoverExpiredLease', B)).reason, 'time-authority-unavailable');
  assert.equal((await s.leaseOp('releaseLease', A)).status, 'done', 'the owner can still release without trusted time');
});

test('B07 malformed time authority answers block expiry (and acquisition)', async () => {
  for (const answer of [null, { status: 'trusted' }, { realm: 'test', status: 'trusted', at: -1, authorityRevision: 1 }, { realm: 'test', status: 'trusted', at: '99', authorityRevision: 1 },
    { realm: 'preview', status: 'trusted', at: 99_999, authorityRevision: 1 }, { realm: 'test', status: 'trusted', at: 99_999, authorityRevision: 1, override: true }]) {
    const s = await leaseSetup({ extra: { timeAuthority: { now: async () => answer } } });
    assert.equal((await s.boot.operations.replay(A, await s.replayInput())).reason, 'time-authority-unavailable', JSON.stringify(answer));
    await s.quarantine.acquireLease({ quarantineId: s.id, expectedVersion: await s.version(), ownerId: 'op-a', acquiredAt: 1 });
    assert.equal((await s.leaseOp('recoverExpiredLease', B)).reason, 'time-authority-unavailable');
  }
});

test('B08 lease policy throwing, malformed, other realm or "never" → lease stays ACTIVE', async () => {
  for (const evaluate of [() => { throw new Error('x'); }, async () => ({ status: 'EXPIRED' }), async () => ({ realm: 'preview', status: 'EXPIRED', recoveryByNonOwner: 'when-expired', policyRevision: 1 }),
    async ({ realm }) => ({ realm, status: 'EXPIRED', recoveryByNonOwner: 'never', policyRevision: 1 }), async ({ realm }) => ({ realm, status: 'UNKNOWN', recoveryByNonOwner: 'when-expired', policyRevision: 1 })]) {
    const s = await leaseSetup({ extra: { leasePolicy: { evaluate } } });
    await s.quarantine.acquireLease({ quarantineId: s.id, expectedVersion: await s.version(), ownerId: 'op-a', acquiredAt: s.lease.clock.at });
    expire(s);
    const r = await s.leaseOp('recoverExpiredLease', B);
    assert.ok(['lease-policy-unavailable', 'lease-active'].includes(r.reason), r.reason);
    assert.equal((await s.record()).status, 'REPLAYING');
  }
});

test('B09 an explicitly ACTIVE decision blocks recovery; B10 explicit EXPIRED allows AUTHORIZED recovery, then a new acquisition', async () => {
  const s = await leaseSetup();
  await s.quarantine.acquireLease({ quarantineId: s.id, expectedVersion: await s.version(), ownerId: 'op-a', acquiredAt: s.lease.clock.at });
  assert.equal((await s.leaseOp('recoverExpiredLease', B)).reason, 'lease-active');
  expire(s);
  const r = await s.leaseOp('recoverExpiredLease', B);
  assert.deepEqual([r.status, r.quarantineStatus], ['done', 'RETRYABLE']);
  assert.equal((await s.record()).lease, null);
  const replay = await s.boot.operations.replay(B, await s.replayInput());
  assert.deepEqual([replay.status, replay.quarantineStatus], ['done', 'RESOLVED']);
  assert.equal(s.persistence.measurements.size, 1);
});

test('B11 expired recovery without QUARANTINE_UNBLOCK (or with an unknown credential) is denied', async () => {
  const s = await leaseSetup();
  await s.quarantine.acquireLease({ quarantineId: s.id, expectedVersion: await s.version(), ownerId: 'op-a', acquiredAt: s.lease.clock.at });
  expire(s);
  assert.equal((await s.leaseOp('recoverExpiredLease', { token: 'tok-replayer' })).reason, 'forbidden');
  assert.equal((await s.leaseOp('recoverExpiredLease', { token: 'nobody' })).reason, 'unauthenticated');
  assert.equal((await s.record()).status, 'REPLAYING');
});

for (const n of [2, 10]) {
  test(`B1${n === 2 ? 2 : 3} ${n} concurrent recoveries of an expired lease → exactly one winner`, async () => {
    const s = await leaseSetup();
    await s.quarantine.acquireLease({ quarantineId: s.id, expectedVersion: await s.version(), ownerId: 'op-a', acquiredAt: s.lease.clock.at });
    expire(s);
    const v = await s.version();
    const results = await Promise.all(Array.from({ length: n }, (_, i) => s.boot.operations.recoverExpiredLease(i % 2 ? B : C, { quarantineId: s.id, expectedVersion: v, evidence: ev() })));
    assert.equal(results.filter(r => r.status === 'done').length, 1);
    assert.ok(results.filter(r => r.status === 'denied').every(r => r.reason === 'stale-version'));
    assert.equal((await s.trail()).filter(a => a === 'lease-recovered-expired').length, 1);
  });
}

test('B14/B23/B25b S7 (expired): A in flight → B recovers → B discards → A completes: the fence blocks A, no measurement, DISCARDED', async () => {
  const s = await leaseSetup();
  const gate = s.holdNextWrite();
  const replayA = s.boot.operations.replay(A, await s.replayInput());
  await gate.atGate;                         // A holds the lease and is about to write
  expire(s);                                 // TEST_ONLY: the synthetic policy now declares the lease EXPIRED
  assert.equal((await s.leaseOp('recoverExpiredLease', B)).status, 'done');
  assert.equal((await s.leaseOp('discard', B)).quarantineStatus, 'DISCARDED');
  gate.release();
  assert.deepEqual(await replayA, { status: 'denied', reason: 'stale-replay-lease' });
  assert.equal(s.persistence.measurements.size, 0);
  assert.equal((await s.record()).status, 'DISCARDED');
  const trail = await s.trail();
  assert.ok(trail.includes('lease-recovered-expired') && trail.includes('discarded') && trail.includes('stale-replay-blocked'));
});

test('B14b stale replay after recovery and RE-ACQUISITION by B: A is fenced, B persists — exactly one measurement', async () => {
  const s = await leaseSetup();
  const gate = s.holdNextWrite();
  const replayA = s.boot.operations.replay(A, await s.replayInput());
  await gate.atGate;
  expire(s);
  assert.equal((await s.leaseOp('recoverExpiredLease', B)).status, 'done');
  const replayB = await s.boot.operations.replay(B, await s.replayInput());
  assert.equal(replayB.quarantineStatus, 'RESOLVED');
  gate.release();
  assert.equal((await replayA).reason, 'stale-replay-lease');
  assert.equal(s.persistence.measurements.size, 1);
});

test('B15/B25a S7 (active, exact): A in flight → B cannot release, recover or discard → A persists normally', async () => {
  const s = await leaseSetup();
  const gate = s.holdNextWrite();
  const replayA = s.boot.operations.replay(A, await s.replayInput());
  await gate.atGate;
  assert.equal((await s.leaseOp('releaseLease', B)).reason, 'lease-owned-by-another-operator');
  assert.equal((await s.leaseOp('recoverExpiredLease', B)).reason, 'lease-active');
  assert.equal((await s.leaseOp('discard', B)).reason, 'transition-not-allowed');
  assert.equal((await s.record()).status, 'REPLAYING');
  gate.release();
  const r = await replayA;
  assert.deepEqual([r.status, r.quarantineStatus, r.replay.outcome.status], ['done', 'RESOLVED', 'accepted']);
  assert.equal(s.persistence.measurements.size, 1);
});

test('B16 replay vs discard with an active lease: discard never wins while the lease is held', async () => {
  const s = await leaseSetup();
  const v = await s.version();
  const [rep, dis] = await Promise.all([s.boot.operations.replay(A, await s.replayInput(v)), s.boot.operations.discard(B, { quarantineId: s.id, expectedVersion: v, evidence: ev() })]);
  assert.equal([rep.status, dis.status].filter(x => x === 'done').length, 1);
  const final = (await s.record()).status;
  assert.ok(!(final === 'DISCARDED' && s.persistence.measurements.size > 0));
});

test('B18 owner/token mismatch at the replay root: a replay presenting a lease it does not hold is stale before any work', async () => {
  const s = await leaseSetup();
  const acquired = await s.quarantine.acquireLease({ quarantineId: s.id, expectedVersion: await s.version(), ownerId: 'op-a', acquiredAt: s.lease.clock.at });
  const root = createResilientMeasurementIngestionRoot(s.deps);
  const base = { quarantineId: s.id, protectedDocument: s.doc, provenanceEvidence: evidenceFor(s.doc), field: 'temperature' };
  assert.equal((await root.replay({ ...base, lease: { ownerId: 'op-b', leaseToken: acquired.leaseToken } })).reasonCode, 'stale-replay-lease');
  assert.equal((await root.replay({ ...base, lease: { ownerId: 'op-a', leaseToken: acquired.leaseToken + 1 } })).reasonCode, 'stale-replay-lease');
  assert.equal(s.persistence.measurements.size, 0);
  assert.equal((await s.record()).status, 'REPLAYING');
});

test('B21/B22/B24 audit: lease acquired; recovery denied; audit failure blocks recovery and owner release (no state change)', async () => {
  const s = await leaseSetup();
  const gate = s.holdNextWrite();
  const running = s.boot.operations.replay(A, await s.replayInput());
  await gate.atGate;
  assert.ok((await s.trail()).includes('lease-acquired'));
  assert.equal((await s.leaseOp('recoverExpiredLease', B)).reason, 'lease-active');
  assert.ok((await s.trail()).includes('lease-release-denied'));
  expire(s);
  s.audit.setFailing(true);
  assert.equal((await s.leaseOp('recoverExpiredLease', B)).reason, 'audit-unavailable');
  assert.equal((await s.leaseOp('releaseLease', A)).reason, 'audit-unavailable');
  assert.equal((await s.record()).status, 'REPLAYING');
  s.audit.setFailing(false);
  gate.release();
  assert.equal((await running).quarantineStatus, 'RESOLVED');
});

test('Fence on non-leased (BE13-08 root) replays: a discard while it runs leaves NO measurement', async () => {
  const s = await leaseSetup();
  const root = createResilientMeasurementIngestionRoot(s.deps);
  const gate = s.holdNextWrite();
  const running = root.replay({ quarantineId: s.id, protectedDocument: s.doc, provenanceEvidence: evidenceFor(s.doc), field: 'temperature' });
  await gate.atGate;
  assert.equal((await s.leaseOp('discard', B)).quarantineStatus, 'DISCARDED');
  gate.release();
  assert.equal((await running).reasonCode, 'stale-replay-lease');
  assert.equal(s.persistence.measurements.size, 0);
});

test('A persistence adapter that cannot fence is refused: no write attempted, lease handed back', async () => {
  const s = await leaseSetup({ fencing: false });
  const r = await s.boot.operations.replay(A, await s.replayInput());
  assert.deepEqual(r, { status: 'denied', reason: 'replay-fence-unsupported' });
  assert.equal(s.persistence.measurements.size, 0);
  assert.deepEqual([(await s.record()).status, (await s.record()).lease], ['RETRYABLE', null]);
});

test('Readiness: time authority and lease policy reported MISSING / BLOCKED / INJECTED_UNVERIFIED; productionReady stays false', async () => {
  const s = await leaseSetup();
  const ok = describeOperationsReadiness(s.deps);
  assert.deepEqual([ok.dependencies.timeAuthority, ok.dependencies.leasePolicy, ok.operationsTestReady, ok.productionReady], ['INJECTED_UNVERIFIED', 'INJECTED_UNVERIFIED', true, false]);
  const p = createBlockingSecurityPolicies();
  const blocked = describeOperationsReadiness({ ...s.deps, timeAuthority: p.timeAuthority, leasePolicy: p.leasePolicy });
  assert.deepEqual([blocked.dependencies.timeAuthority, blocked.dependencies.leasePolicy, blocked.operationsTestReady], ['BLOCKED', 'BLOCKED', false]);
  assert.equal(describeOperationsReadiness({ ...s.deps, timeAuthority: undefined }).dependencies.timeAuthority, 'MISSING');
  assert.throws(() => createIngestionOperationsBootstrap({ ...s.deps, leasePolicy: undefined }), /leasePolicy/);
  // Placeholders: the default bootstrap can neither acquire (untrusted time) nor recover (never expires).
  const def = await leaseSetup({ extra: { timeAuthority: p.timeAuthority, leasePolicy: p.leasePolicy } });
  assert.equal((await def.boot.operations.replay(A, await def.replayInput())).reason, 'time-authority-unavailable');
  assert.ok(ok.limitations.includes('LEASE_DURATION_PENDING'));
});
