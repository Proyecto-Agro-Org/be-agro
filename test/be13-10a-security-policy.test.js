// BE13-10A — security policy framework (offline). Every policy below is an explicit
// TEST_ONLY synthetic double. None of them is a proposal for a production value.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOperationsSecurityPolicyBundle, describeSecurityPolicyReadiness } from '../dist/src/services/operations-security-policy.service.js';
import { createBlockingSecurityPolicies, isBlockingPlaceholder } from '../dist/src/adapters/ingestion-production-placeholders.js';
import { createIngestionOperationsBootstrap } from '../dist/src/services/ingestion-operations.service.js';
import { protectedDocument, world, createInMemoryPersistence, createTestOnlyRetryPolicy, createDeterministicScheduler, createInMemoryRecovery,
  createInMemoryQuarantine, createInMemoryAudit, createRecordingMetrics, createRecordingAlerts } from '../test-support/be13-composition.fixtures.js';
import { syntheticPolicies, createInMemoryLeaseStore, QID } from '../test-support/be13-10a-policy.fixtures.js';

const bundleWith = (overrides = {}) => { const p = syntheticPolicies(overrides); return { ...p, bundle: createOperationsSecurityPolicyBundle(p.deps) }; };
const ALL_POLICIES = ['identityProvider', 'capabilityMapping', 'separationOfDuties', 'leasePolicy', 'timeAuthority', 'evidenceVerifier', 'retention', 'legalHold'];

// ---------------------------------------------------------------- identity
test('I01 missing provider: the bundle refuses to exist without every policy', () => {
  const { deps } = syntheticPolicies();
  for (const name of ALL_POLICIES) {
    assert.throws(() => createOperationsSecurityPolicyBundle({ ...deps, [name]: undefined }), new RegExp(name));
    assert.throws(() => createOperationsSecurityPolicyBundle({ ...deps, [name]: {} }), new RegExp(name));
  }
  assert.throws(() => createOperationsSecurityPolicyBundle({ ...deps, realm: 'not a realm' }), /realm/);
  assert.throws(() => createOperationsSecurityPolicyBundle(null), TypeError);
});

test('I02 provider denies → unauthenticated', async () => {
  const { bundle } = bundleWith();
  assert.deepEqual(await bundle.resolvePrincipal({ token: 'unknown' }, 'QUARANTINE_VIEW'), { status: 'denied', reason: 'unauthenticated' });
  const blocked = createOperationsSecurityPolicyBundle({ ...syntheticPolicies().deps, identityProvider: createBlockingSecurityPolicies().identityProvider });
  assert.equal((await blocked.resolvePrincipal({ token: 'tok-ops' }, 'QUARANTINE_VIEW')).reason, 'unauthenticated');
});

test('I03 forged role in the credential is ignored', async () => {
  const { bundle } = bundleWith();
  const r = await bundle.resolvePrincipal({ token: 'tok-viewer', roles: ['admin'], attributes: [{ name: 'group', value: 'replayers' }] }, 'QUARANTINE_REPLAY');
  assert.deepEqual(r, { status: 'denied', reason: 'forbidden' });
});

test('I04 forged capability in the credential (or in the provider answer) is ignored / rejected', async () => {
  const { bundle } = bundleWith();
  assert.equal((await bundle.resolvePrincipal({ token: 'tok-viewer', capabilities: ['QUARANTINE_DISCARD'] }, 'QUARANTINE_DISCARD')).reason, 'forbidden');
  // A provider that tries to hand out capabilities directly is malformed (strict schema) → unauthenticated.
  const leaky = bundleWith({ identityProvider: { identify: async ({ realm }) => ({ status: 'authenticated', identity: { realm, subject: 'op-x', issuer: 'synthetic-idp',
    authenticationReference: 'synthetic:x', attributes: [], capabilities: ['QUARANTINE_DISCARD'] } }) } }).bundle;
  assert.equal((await leaky.resolvePrincipal({}, 'QUARANTINE_DISCARD')).reason, 'unauthenticated');
});

test('I05 wrong realm: provider identity of another realm, or a request for another realm', async () => {
  const { bundle } = bundleWith();
  assert.equal((await bundle.resolvePrincipal({ token: 'tok-preview' }, 'QUARANTINE_VIEW')).reason, 'realm-out-of-scope');
  assert.deepEqual(await bundle.authorization.authorize({ credential: { token: 'tok-ops' }, realm: 'preview', capability: 'QUARANTINE_VIEW', quarantineId: null }),
    { decision: 'deny', reason: 'realm-out-of-scope' });
});

test('I06 valid synthetic principal: subject from the provider, capabilities from the mapping, realm fixed', async () => {
  const { bundle } = bundleWith();
  const r = await bundle.resolvePrincipal({ token: 'tok-ops' }, 'QUARANTINE_REPLAY');
  assert.equal(r.status, 'resolved');
  assert.deepEqual(r.principal, { operatorId: 'op-ops', realms: ['test'], capabilities: ['QUARANTINE_VIEW', 'QUARANTINE_REPLAY'], authenticationReference: 'synthetic:op-ops' });
  assert.ok(Object.isFrozen(r.principal) && Object.isFrozen(r.principal.capabilities));
});

test('I07 malformed provider responses → unauthenticated', async () => {
  const bad = [null, 'yes', { status: 'authenticated' }, { status: 'authenticated', identity: { realm: 'test', subject: 'has space', issuer: 'i', authenticationReference: 'r', attributes: [] } },
    { status: 'authenticated', identity: { realm: 'test', subject: 'op', issuer: 'i', authenticationReference: 'r', attributes: [{ name: 'Group', value: 'x' }] } },
    { status: 'authenticated', identity: { realm: 'test', subject: 'op@example.com', issuer: 'i', authenticationReference: 'r', attributes: [] } },
    { status: 'denied', reason: 'because' }, { status: 'allow' }];
  for (const answer of bad) {
    const { bundle } = bundleWith({ identityProvider: { identify: async () => answer } });
    assert.equal((await bundle.resolvePrincipal({ token: 'tok-ops' }, 'QUARANTINE_VIEW')).reason, 'unauthenticated', JSON.stringify(answer));
  }
});

test('I08 provider throws (sync or async) → unauthenticated, no diagnostics leak', async () => {
  for (const identify of [() => { throw new Error('idp down: secret=abc'); }, async () => { throw new Error('x'); }]) {
    const { bundle } = bundleWith({ identityProvider: { identify } });
    const r = await bundle.resolvePrincipal({ token: 'tok-ops' }, 'QUARANTINE_VIEW');
    assert.deepEqual(r, { status: 'denied', reason: 'unauthenticated' });
  }
});

// ---------------------------------------------------------------- capability mapping
test('M01 unknown role / attribute → denied', async () => {
  const { bundle } = bundleWith();
  assert.equal((await bundle.resolvePrincipal({ token: 'tok-stranger' }, 'QUARANTINE_VIEW')).reason, 'forbidden');
  const blocked = createOperationsSecurityPolicyBundle({ ...syntheticPolicies().deps, capabilityMapping: createBlockingSecurityPolicies().capabilityMapping });
  assert.equal((await blocked.resolvePrincipal({ token: 'tok-ops' }, 'QUARANTINE_VIEW')).reason, 'forbidden');
});

test('M02 mapped identity without the requested capability → forbidden; empty mapping → forbidden', async () => {
  const { bundle } = bundleWith();
  assert.equal((await bundle.resolvePrincipal({ token: 'tok-viewer' }, 'QUARANTINE_REPLAY')).reason, 'forbidden');
  const empty = bundleWith({ capabilityMapping: { map: async ({ realm }) => ({ status: 'mapped', realm, capabilities: [], policyRevision: 1 }) } }).bundle;
  assert.equal((await empty.resolvePrincipal({ token: 'tok-ops' }, 'QUARANTINE_VIEW')).reason, 'forbidden');
});

test('M03 synthetic mapping: attributes → capabilities (union of groups)', async () => {
  const { bundle } = bundleWith();
  const r = await bundle.resolvePrincipal({ token: 'tok-both' }, 'QUARANTINE_DISCARD');
  assert.equal(r.status, 'resolved');
  assert.deepEqual([...r.principal.capabilities].sort(), ['QUARANTINE_DISCARD', 'QUARANTINE_REPLAY', 'QUARANTINE_VIEW']);
});

test('M04 excessive / unknown / duplicated capabilities → the whole mapping is rejected', async () => {
  for (const capabilities of [['QUARANTINE_VIEW', 'SUPERUSER'], ['QUARANTINE_VIEW', 'QUARANTINE_VIEW'], ['*'], Array(9).fill('QUARANTINE_VIEW')]) {
    const { bundle } = bundleWith({ capabilityMapping: { map: async ({ realm }) => ({ status: 'mapped', realm, capabilities, policyRevision: 1 }) } });
    assert.equal((await bundle.resolvePrincipal({ token: 'tok-ops' }, 'QUARANTINE_VIEW')).reason, 'forbidden', JSON.stringify(capabilities));
  }
});

test('M05 realm preserved: a mapping answering for another realm is rejected; the principal has only the bundle realm', async () => {
  const { bundle } = bundleWith({ capabilityMapping: { map: async () => ({ status: 'mapped', realm: 'preview', capabilities: ['QUARANTINE_VIEW'], policyRevision: 1 }) } });
  assert.equal((await bundle.resolvePrincipal({ token: 'tok-ops' }, 'QUARANTINE_VIEW')).reason, 'forbidden');
  const ok = await bundleWith().bundle.resolvePrincipal({ token: 'tok-ops' }, 'QUARANTINE_VIEW');
  assert.deepEqual(ok.principal.realms, ['test']);
});

// ---------------------------------------------------------------- separation of duties
test('S01 conflicting capabilities → separation-of-duties (deny for every capability of that operator)', async () => {
  const { bundle } = bundleWith();
  // tok-conflict maps to UNBLOCK + DISCARD; the synthetic SoD excludes that pair.
  assert.deepEqual(await bundle.resolvePrincipal({ token: 'tok-conflict' }, 'QUARANTINE_UNBLOCK'), { status: 'denied', reason: 'separation-of-duties' });
  assert.equal((await bundle.resolvePrincipal({ token: 'tok-conflict' }, 'QUARANTINE_DISCARD')).reason, 'separation-of-duties');
  assert.deepEqual(await bundle.authorization.authorize({ credential: { token: 'tok-conflict' }, realm: 'test', capability: 'QUARANTINE_DISCARD', quarantineId: null }),
    { decision: 'deny', reason: 'forbidden' });
});

test('S02 permitted combination → resolved', async () => {
  assert.equal((await bundleWith().bundle.resolvePrincipal({ token: 'tok-both' }, 'QUARANTINE_REPLAY')).status, 'resolved');
});

test('S03 missing / placeholder policy: missing refuses the bundle; the placeholder conflicts with everything', async () => {
  assert.throws(() => createOperationsSecurityPolicyBundle({ ...syntheticPolicies().deps, separationOfDuties: undefined }), /separationOfDuties/);
  const blocked = createOperationsSecurityPolicyBundle({ ...syntheticPolicies().deps, separationOfDuties: createBlockingSecurityPolicies().separationOfDuties });
  assert.equal((await blocked.resolvePrincipal({ token: 'tok-viewer' }, 'QUARANTINE_VIEW')).reason, 'separation-of-duties');
});

test('S04 policy throws, times out-free malformed answers or answers for another realm → separation-of-duties', async () => {
  for (const evaluate of [() => { throw new Error('x'); }, async () => ({ decision: 'permit' }), async () => ({ realm: 'preview', decision: 'permit', policyRevision: 1 }),
    async ({ realm }) => ({ realm, decision: 'permit', policyRevision: 1, override: true }), async () => undefined]) {
    const { bundle } = bundleWith({ separationOfDuties: { evaluate } });
    assert.equal((await bundle.resolvePrincipal({ token: 'tok-viewer' }, 'QUARANTINE_VIEW')).reason, 'separation-of-duties');
  }
});

// ---------------------------------------------------------------- replay lease
async function leaseSetup(overrides = {}) {
  const s = bundleWith(overrides);
  const store = createInMemoryLeaseStore('test');
  const governor = s.bundle.createLeaseGovernor(store);
  assert.deepEqual(await governor.acquire({ token: 'tok-ops' }, { quarantineId: QID, expectedVersion: 0 }), { status: 'acquired' });
  const lease = await store.get(QID);
  return { ...s, store, governor, lease };
}

test('L01 active lease: owner op-ops, ACTIVE while the synthetic time is within the TEST_ONLY window; a second acquire is refused', async () => {
  const s = await leaseSetup();
  assert.equal(s.lease.ownerOperatorId, 'op-ops');
  assert.equal(s.lease.acquiredAt, s.clock.at);
  assert.equal((await s.governor.status(QID)).status, 'ACTIVE');
  assert.deepEqual(await s.governor.acquire({ token: 'tok-both' }, { quarantineId: QID, expectedVersion: s.lease.version }), { status: 'denied', reason: 'lease-active' });
});

test('L02 expired synthetic lease: EXPIRED only by policy decision under trusted time; recovery is explicit, then re-acquire is explicit', async () => {
  const s = await leaseSetup();
  s.clock.at += 10_000;
  assert.equal((await s.governor.status(QID)).status, 'EXPIRED');
  assert.equal((await s.store.get(QID)).state, 'ACTIVE', 'expiry is derived, never written by status()');
  assert.deepEqual(await s.governor.release({ token: 'tok-both' }, { quarantineId: QID, leaseId: s.lease.leaseId, expectedVersion: s.lease.version }), { status: 'released', reason: 'expired-recovery' });
  assert.equal((await s.governor.status(QID)).status, 'RELEASED');
  const released = await s.store.get(QID);
  assert.deepEqual(s.store.history.at(-1), { op: 'release', quarantineId: QID, releasedBy: 'op-both', reason: 'expired-recovery', version: released.version });
  assert.equal((await s.governor.acquire({ token: 'tok-both' }, { quarantineId: QID, expectedVersion: released.version })).status, 'acquired');
});

test('L03 release unauthorized: no capability, unknown credential, or non-owner before expiry', async () => {
  const s = await leaseSetup();
  const input = { quarantineId: QID, leaseId: s.lease.leaseId, expectedVersion: s.lease.version };
  assert.equal((await s.governor.release({ token: 'tok-viewer' }, input)).reason, 'forbidden');
  assert.equal((await s.governor.release({ token: 'nobody' }, input)).reason, 'unauthenticated');
  assert.equal((await s.governor.release({ token: 'tok-both' }, input)).reason, 'lease-active');
  assert.equal((await s.store.get(QID)).state, 'ACTIVE');
});

test('L04 release authorized: the owner may release an active lease', async () => {
  const s = await leaseSetup();
  assert.deepEqual(await s.governor.release({ token: 'tok-ops' }, { quarantineId: QID, leaseId: s.lease.leaseId, expectedVersion: s.lease.version }), { status: 'released', reason: 'owner-release' });
  assert.equal((await s.governor.release({ token: 'tok-ops' }, { quarantineId: QID, leaseId: s.lease.leaseId, expectedVersion: s.lease.version + 1 })).reason, 'lease-not-active');
});

test('L05 stale version and lease mismatch are refused without touching the store', async () => {
  const s = await leaseSetup();
  assert.equal((await s.governor.release({ token: 'tok-ops' }, { quarantineId: QID, leaseId: s.lease.leaseId, expectedVersion: s.lease.version + 1 })).reason, 'stale-version');
  assert.equal((await s.governor.release({ token: 'tok-ops' }, { quarantineId: QID, leaseId: 'l_other', expectedVersion: s.lease.version })).reason, 'lease-mismatch');
  assert.equal((await s.governor.acquire({ token: 'tok-both' }, { quarantineId: 'q_' + 'b'.repeat(64), expectedVersion: 3 })).reason, 'stale-version');
  assert.equal(s.store.writes(), 1);
});

test('L06 concurrent takeover of an expired lease: exactly one recovery wins (CAS)', async () => {
  const s = await leaseSetup();
  s.clock.at += 10_000;
  const input = { quarantineId: QID, leaseId: s.lease.leaseId, expectedVersion: s.lease.version };
  const results = await Promise.all([s.governor.release({ token: 'tok-both' }, input), s.governor.release({ token: 'tok-ops2' }, input), s.governor.release({ token: 'tok-both' }, input)]);
  assert.equal(results.filter(r => r.status === 'released').length, 1);
  assert.ok(results.filter(r => r.status === 'denied').every(r => r.reason === 'stale-version'));
  const after = await s.store.get(QID);
  const acquires = await Promise.all([s.governor.acquire({ token: 'tok-both' }, { quarantineId: QID, expectedVersion: after.version }), s.governor.acquire({ token: 'tok-ops2' }, { quarantineId: QID, expectedVersion: after.version })]);
  assert.equal(acquires.filter(r => r.status === 'acquired').length, 1);
});

test('L07 no time authority: lease is never considered expired; non-owner recovery and acquire are refused; the owner can still release', async () => {
  const s = await leaseSetup();
  s.clock.at += 10_000;
  s.clock.trusted = false;
  assert.equal((await s.governor.status(QID)).status, 'ACTIVE');
  const input = { quarantineId: QID, leaseId: s.lease.leaseId, expectedVersion: s.lease.version };
  assert.equal((await s.governor.release({ token: 'tok-both' }, input)).reason, 'time-authority-unavailable');
  assert.equal((await s.governor.acquire({ token: 'tok-both' }, { quarantineId: 'q_' + 'c'.repeat(64), expectedVersion: 0 })).reason, 'time-authority-unavailable');
  assert.equal((await s.governor.release({ token: 'tok-ops' }, input)).status, 'released');
  const placeholder = await leaseSetup();
  const blocked = createOperationsSecurityPolicyBundle({ ...placeholder.deps, timeAuthority: createBlockingSecurityPolicies().timeAuthority }).createLeaseGovernor(placeholder.store);
  assert.equal((await blocked.acquire({ token: 'tok-ops' }, { quarantineId: 'q_' + 'd'.repeat(64), expectedVersion: 0 })).reason, 'time-authority-unavailable');
});

test('L08 owner mismatch: another operator (even with the leaseId) cannot release an active lease; the placeholder lease policy never expires', async () => {
  const s = await leaseSetup();
  const input = { quarantineId: QID, leaseId: s.lease.leaseId, expectedVersion: s.lease.version };
  assert.equal((await s.governor.release({ token: 'tok-ops2' }, input)).reason, 'lease-active');
  const p = await leaseSetup({ leasePolicy: createBlockingSecurityPolicies().leasePolicy });
  p.clock.at += 10_000_000;
  assert.equal((await p.governor.status(QID)).status, 'ACTIVE');
  assert.equal((await p.governor.release({ token: 'tok-both' }, { quarantineId: QID, leaseId: p.lease.leaseId, expectedVersion: p.lease.version })).reason, 'lease-active');
});

// ---------------------------------------------------------------- retention + legal hold
const STREAM = QID;
test('R01 pending decision → RETAIN (placeholder default)', async () => {
  const { bundle } = bundleWith({ retention: createBlockingSecurityPolicies().retention });
  assert.deepEqual(await bundle.evaluateRetention({ stream: STREAM }), { outcome: 'RETAIN', basis: 'pending-decision', deletes: false });
});

test('R02 retain indefinitely → RETAIN', async () => {
  const { bundle } = bundleWith({ retention: { policyFor: async ({ realm }) => ({ realm, policy: { mode: 'retain-indefinitely', approvalReference: 'SYNTHETIC-1' }, policyRevision: 1 }) } });
  assert.equal((await bundle.evaluateRetention({ stream: STREAM })).basis, 'retain-indefinitely');
});

test('R03 retain until a synthetic date: RETAIN before, ELIGIBLE_FOR_DELETION_REVIEW after (nothing is deleted); untrusted time → RETAIN', async () => {
  const s = bundleWith();
  s.clock.at = 1_000;
  assert.deepEqual(await s.bundle.evaluateRetention({ stream: STREAM }), { outcome: 'RETAIN', basis: 'retain-until-not-reached', deletes: false });
  s.clock.at = 5_001;
  assert.deepEqual(await s.bundle.evaluateRetention({ stream: 'realm' }), { outcome: 'ELIGIBLE_FOR_DELETION_REVIEW', basis: 'retain-until-reached', deletes: false });
  s.clock.trusted = false;
  assert.equal((await s.bundle.evaluateRetention({ stream: STREAM })).basis, 'time-untrusted');
});

test('R04 legal hold prevents deletion even after retain-until; an unknown hold also retains', async () => {
  const s = bundleWith();
  s.clock.at = 9_999;
  s.holds.add(STREAM);
  assert.deepEqual(await s.bundle.evaluateRetention({ stream: STREAM }), { outcome: 'RETAIN', basis: 'legal-hold', deletes: false });
  const unknown = bundleWith({ legalHold: { holdFor: async () => { throw new Error('x'); } } });
  unknown.clock.at = 9_999;
  assert.equal((await unknown.bundle.evaluateRetention({ stream: STREAM })).basis, 'legal-hold-unknown');
  const placeholder = bundleWith({ legalHold: createBlockingSecurityPolicies().legalHold });
  placeholder.clock.at = 9_999;
  assert.equal((await placeholder.bundle.evaluateRetention({ stream: STREAM })).basis, 'legal-hold');
});

test('R05 invalid retention responses → RETAIN (retention-unavailable); invalid stream → RETAIN', async () => {
  for (const answer of [null, { realm: 'test', policy: { mode: 'ttl', days: 30 }, policyRevision: 1 }, { realm: 'preview', policy: { mode: 'retain-until', until: 0, approvalReference: 'x' }, policyRevision: 1 },
    { realm: 'test', policy: { mode: 'retain-until', until: -1, approvalReference: 'x' }, policyRevision: 1 }, { realm: 'test', policy: { mode: 'retain-until', until: 0 }, policyRevision: 1 }]) {
    const s = bundleWith({ retention: { policyFor: async () => answer } });
    s.clock.at = 9_999;
    assert.deepEqual(await s.bundle.evaluateRetention({ stream: STREAM }), { outcome: 'RETAIN', basis: 'retention-unavailable', deletes: false }, JSON.stringify(answer));
  }
  for (const input of [{ stream: 'q_nothex' }, { stream: STREAM, extra: 1 }, null]) assert.equal((await bundleWith().bundle.evaluateRetention(input)).basis, 'invalid-request');
});

test('R06 retention policy throws → RETAIN', async () => {
  const s = bundleWith({ retention: { policyFor: () => { throw new Error('x'); } } });
  s.clock.at = 9_999;
  assert.equal((await s.bundle.evaluateRetention({ stream: STREAM })).basis, 'retention-unavailable');
});

// ---------------------------------------------------------------- evidence verification
const declared = (reference = 'TICKET-1', evidenceType = 'data-verified') => ({ quarantineId: QID, evidence: { evidenceType, reference, verification: 'DECLARED_UNVERIFIED' } });
test('E01 declared evidence remains UNVERIFIED with the placeholder verifier', async () => {
  const { bundle } = bundleWith({ evidenceVerifier: createBlockingSecurityPolicies().evidenceVerifier });
  assert.deepEqual(await bundle.verifyEvidence(declared()), { status: 'UNVERIFIED', basis: 'verifier' });
});

test('E02 VERIFIED only from the (synthetic) verifier for the same reference and realm', async () => {
  const s = bundleWith();
  assert.deepEqual(await s.bundle.verifyEvidence(declared('TICKET-OK')), { status: 'VERIFIED', basis: 'verifier' });
  assert.equal(s.verifierCalls.at(-1).realm, 'test');
});

test('E03 rejected evidence', async () => {
  assert.deepEqual(await bundleWith().bundle.verifyEvidence(declared('TICKET-BAD')), { status: 'REJECTED', basis: 'verifier' });
});

test('E04 malformed verifier responses → UNVERIFIED (never VERIFIED)', async () => {
  for (const answer of [null, { status: 'VERIFIED' }, { realm: 'preview', reference: 'TICKET-1', status: 'VERIFIED', verifierRevision: 1 },
    { realm: 'test', reference: 'OTHER', status: 'VERIFIED', verifierRevision: 1 }, { realm: 'test', reference: 'TICKET-1', status: 'OK', verifierRevision: 1 },
    { realm: 'test', reference: 'TICKET-1', status: 'VERIFIED', verifierRevision: 1, signature: 'abc' }]) {
    const { bundle } = bundleWith({ evidenceVerifier: { verify: async () => answer } });
    assert.deepEqual(await bundle.verifyEvidence(declared()), { status: 'UNVERIFIED', basis: 'verifier-unavailable' }, JSON.stringify(answer));
  }
});

test('E05 verifier throws → UNVERIFIED', async () => {
  const { bundle } = bundleWith({ evidenceVerifier: { verify: () => { throw new Error('x'); } } });
  assert.deepEqual(await bundle.verifyEvidence(declared()), { status: 'UNVERIFIED', basis: 'verifier-unavailable' });
});

// ---------------------------------------------------------------- readiness + bundle + integration
test('Readiness: placeholders → BLOCKED; synthetic → INJECTED_UNVERIFIED; missing → MISSING; productionReady is always false', () => {
  const blocked = describeSecurityPolicyReadiness({ realm: 'test', ...createBlockingSecurityPolicies() });
  assert.deepEqual(Object.values(blocked.dependencies), Array(8).fill('BLOCKED'));
  assert.equal(blocked.policyTestReady, false);
  const synthetic = describeSecurityPolicyReadiness(syntheticPolicies().deps);
  assert.deepEqual(Object.values(synthetic.dependencies), Array(8).fill('INJECTED_UNVERIFIED'));
  assert.equal(synthetic.policyTestReady, true);
  assert.equal(describeSecurityPolicyReadiness(null).dependencies.identityProvider, 'MISSING');
  for (const r of [blocked, synthetic, describeSecurityPolicyReadiness({}), bundleWith().bundle.readiness]) {
    assert.equal(r.productionReady, false);
    assert.ok(Object.isFrozen(r));
    assert.ok(r.limitations.includes('WORM_NOT_PROVIDED') && r.limitations.includes('IDP_SELECTION_PENDING') && r.limitations.includes('LEASE_EXPIRY_PENDING'));
  }
  for (const value of Object.values(createBlockingSecurityPolicies())) assert.equal(isBlockingPlaceholder(value), true);
});

test('Bundle with every placeholder: assembles (fail-closed), but denies, conflicts, retains and never verifies', async () => {
  const bundle = createOperationsSecurityPolicyBundle({ realm: 'test', ...createBlockingSecurityPolicies() });
  assert.equal(bundle.readiness.policyTestReady, false);
  assert.equal((await bundle.resolvePrincipal({ token: 'tok-ops' }, 'QUARANTINE_VIEW')).reason, 'unauthenticated');
  assert.equal((await bundle.evaluateRetention({ stream: 'realm' })).outcome, 'RETAIN');
  assert.equal((await bundle.verifyEvidence(declared())).status, 'UNVERIFIED');
  assert.ok(Object.isFrozen(bundle));
});

test('Integration: bundle.authorization is a drop-in OperatorAuthorizationPort for the BE13-09 bootstrap', async () => {
  const { bundle } = bundleWith();
  const w = world();
  const persistence = createInMemoryPersistence(w.calls);
  let failing = true;
  const flaky = { lookup: k => persistence.lookup(k), persistAtomically: async i => { if (failing) throw new Error('down'); return persistence.persistAtomically(i); } };
  const quarantine = await createInMemoryQuarantine(), audit = createInMemoryAudit();
  const verifier = { verify: e => (e && e.syntheticTestOnly === true ? { sourceId: e.sourceId, operation: 'telemetry', eventId: e.eventId, device: { kind: 'mqtt-clientid', value: e.clientid } } : null) };
  const boot = createIngestionOperationsBootstrap({ realmAuthority: { authorizedRealm: () => 'test' }, provenanceVerifier: verifier, hardware: w.deps.hardware, temporal: w.deps.temporal,
    catalogue: w.deps.catalogue, policies: w.deps.policies, identityStore: w.deps.identityStore, persistence: flaky,
    be12: { temporal: { select: async e => ({ status: 'trusted', at: e.receivedAt, clock: 'received-at' }) }, catalogue: { accepts: async () => true } },
    deviceStatusHistory: { mode: 'current-state-only', limitation: 'DEVICE_STATUS_HISTORY_REQUIRED' }, retryPolicy: createTestOnlyRetryPolicy(1), retryScheduler: createDeterministicScheduler(),
    recovery: createInMemoryRecovery(persistence), quarantine, authorization: bundle.authorization, audit, metrics: createRecordingMetrics(), alerts: createRecordingAlerts(),
    retention: { mode: 'retain-indefinitely' } });
  const doc = protectedDocument();
  const evidence = { syntheticTestOnly: true, sourceId: doc.sourceId, eventId: doc.eventId, clientid: doc.clientid };
  const q = await boot.ingest(doc, evidence, { field: 'temperature' });
  failing = false;
  const version = (await quarantine.get(q.quarantineId)).version;
  const input = { quarantineId: q.quarantineId, expectedVersion: version, protectedDocument: doc, provenanceEvidence: evidence, field: 'temperature' };
  assert.equal((await boot.operations.replay({ token: 'tok-viewer', capabilities: ['QUARANTINE_REPLAY'] }, input)).reason, 'forbidden');
  assert.equal((await boot.operations.replay({ token: 'tok-conflict' }, input)).reason, 'forbidden');
  const r = await boot.operations.replay({ token: 'tok-ops' }, input);
  assert.deepEqual([r.status, r.quarantineStatus], ['done', 'RESOLVED']);
  assert.ok(audit.entries.some(e => e.action === 'replay-started' && e.actorId === 'op-ops'));
});
