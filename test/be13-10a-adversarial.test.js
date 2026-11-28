// BE13-10A — adversarial vectors against the security policy framework (offline).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createOperationsSecurityPolicyBundle, describeSecurityPolicyReadiness } from '../dist/src/services/operations-security-policy.service.js';
import { createBlockingSecurityPolicies } from '../dist/src/adapters/ingestion-production-placeholders.js';
import { syntheticPolicies, createInMemoryLeaseStore, QID } from '../test-support/be13-10a-policy.fixtures.js';

const bundleWith = (overrides = {}) => { const p = syntheticPolicies(overrides); return { ...p, bundle: createOperationsSecurityPolicyBundle(p.deps) }; };
const authorize = (bundle, credential, extra = {}) => bundle.authorization.authorize({ credential, realm: 'test', capability: 'QUARANTINE_DISCARD', quarantineId: null, ...extra });

test('X1 caller-injected role: in the credential, in the request, or as provider-shaped attributes in the credential', async () => {
  const { bundle } = bundleWith();
  for (const credential of [{ token: 'tok-viewer', roles: ['admin'] }, { token: 'tok-viewer', attributes: [{ name: 'group', value: 'discarders' }] },
    { token: 'tok-viewer', identity: { subject: 'op-both' } }, { subject: 'op-both', groups: ['discarders'] }]) {
    assert.equal((await authorize(bundle, credential)).decision, 'deny', JSON.stringify(credential));
  }
  assert.equal((await authorize(bundle, { token: 'tok-viewer' }, { roles: ['admin'], principal: { capabilities: ['QUARANTINE_DISCARD'] } })).decision, 'deny');
});

test('X2 caller-injected capability: credential capabilities ignored; unknown requested capability refused before any provider call', async () => {
  let identifyCalls = 0;
  const { bundle } = bundleWith({ identityProvider: { identify: async (...a) => { identifyCalls += 1; return syntheticPolicies().deps.identityProvider.identify(...a); } } });
  assert.equal((await authorize(bundle, { token: 'tok-viewer', capabilities: ['QUARANTINE_DISCARD'] })).decision, 'deny');
  const before = identifyCalls;
  assert.equal((await bundle.resolvePrincipal({ token: 'tok-ops' }, 'SUPERUSER')).reason, 'forbidden');
  assert.equal((await bundle.resolvePrincipal({ token: 'tok-ops' }, ['QUARANTINE_VIEW'])).reason, 'forbidden');
  assert.equal(identifyCalls, before);
});

test('X3 forged realm: credential realm ignored; provider/mapping/SoD answering for another realm never yield a principal', async () => {
  const { bundle } = bundleWith();
  assert.deepEqual(await bundle.resolvePrincipal({ token: 'tok-ops', realm: 'preview' }, 'QUARANTINE_VIEW').then(r => r.principal.realms), ['test']);
  assert.equal((await bundle.authorization.authorize({ credential: { token: 'tok-ops' }, realm: 'preview', capability: 'QUARANTINE_VIEW' })).reason, 'realm-out-of-scope');
  assert.equal((await bundle.authorization.authorize({ credential: { token: 'tok-ops' }, realm: undefined, capability: 'QUARANTINE_VIEW' })).reason, 'realm-out-of-scope');
  const sod = bundleWith({ separationOfDuties: { evaluate: async () => ({ realm: 'preview', decision: 'permit', policyRevision: 1 }) } }).bundle;
  assert.equal((await sod.resolvePrincipal({ token: 'tok-ops' }, 'QUARANTINE_VIEW')).status, 'denied');
});

test('X4 fake lease owner: claimed operatorId, a principal object instead of a credential, or a store answering with a foreign lease', async () => {
  const s = bundleWith();
  const store = createInMemoryLeaseStore('test');
  const governor = s.bundle.createLeaseGovernor(store);
  await governor.acquire({ token: 'tok-ops' }, { quarantineId: QID, expectedVersion: 0 });
  const lease = await store.get(QID);
  const input = { quarantineId: QID, leaseId: lease.leaseId, expectedVersion: lease.version };
  assert.equal((await governor.release({ token: 'tok-both', operatorId: 'op-ops' }, input)).reason, 'lease-active');
  assert.equal((await governor.release({ operatorId: 'op-ops', realms: ['test'], capabilities: ['QUARANTINE_REPLAY'], authenticationReference: 'x' }, input)).reason, 'unauthenticated');
  for (const foreign of [{ ...lease, realm: 'preview' }, { ...lease, quarantineId: 'q_' + 'f'.repeat(64) }, { ...lease, ownerOperatorId: 'op both' }, { ...lease, extra: true }]) {
    const g = s.bundle.createLeaseGovernor({ ...store, get: async () => foreign });
    assert.equal((await g.release({ token: 'tok-ops' }, input)).reason, 'lease-not-found');
    assert.equal((await g.status(QID)).status, 'UNKNOWN');
  }
  const throwing = s.bundle.createLeaseGovernor({ ...store, get: async () => { throw new Error('x'); } });
  assert.equal((await throwing.release({ token: 'tok-ops' }, input)).reason, 'lease-not-found');
  assert.throws(() => s.bundle.createLeaseGovernor({ get() {} }), /lease store/);
});

test('X5 stale lease: a recovery prepared against an old lease cannot release the new one', async () => {
  const s = bundleWith();
  const store = createInMemoryLeaseStore('test');
  const governor = s.bundle.createLeaseGovernor(store);
  await governor.acquire({ token: 'tok-ops' }, { quarantineId: QID, expectedVersion: 0 });
  const old = await store.get(QID);
  await governor.release({ token: 'tok-ops' }, { quarantineId: QID, leaseId: old.leaseId, expectedVersion: old.version });
  await governor.acquire({ token: 'tok-ops2' }, { quarantineId: QID, expectedVersion: old.version + 1 });
  s.clock.at += 10_000;
  assert.equal((await governor.release({ token: 'tok-both' }, { quarantineId: QID, leaseId: old.leaseId, expectedVersion: old.version })).reason, 'lease-mismatch');
  const current = await store.get(QID);
  assert.equal((await governor.release({ token: 'tok-both' }, { quarantineId: QID, leaseId: current.leaseId, expectedVersion: old.version })).reason, 'stale-version');
  assert.equal((await store.get(QID)).state, 'ACTIVE');
});

test('X6 legal hold bypass: a hold answer for another stream/realm, non-boolean holds, or extra fields never release the record', async () => {
  for (const answer of [{ realm: 'test', stream: 'realm', legalHold: false, holdReference: null }, { realm: 'preview', stream: QID, legalHold: false, holdReference: null },
    { realm: 'test', stream: QID, legalHold: 'false', holdReference: null }, { realm: 'test', stream: QID, legalHold: 0, holdReference: null },
    { realm: 'test', stream: QID, legalHold: false, holdReference: null, override: 'release' }]) {
    const s = bundleWith({ legalHold: { holdFor: async () => answer } });
    s.clock.at = 9_999;
    const r = await s.bundle.evaluateRetention({ stream: QID });
    assert.deepEqual(r, { outcome: 'RETAIN', basis: 'legal-hold-unknown', deletes: false }, JSON.stringify(answer));
  }
  const s = bundleWith();
  s.clock.at = 9_999;
  s.holds.add(QID);
  assert.equal((await s.bundle.evaluateRetention({ stream: QID, legalHold: false })).basis, 'invalid-request');
  assert.equal((await s.bundle.evaluateRetention({ stream: QID })).basis, 'legal-hold');
  assert.equal(typeof s.bundle.delete, 'undefined');
});

test('X7 fake verified evidence: caller-declared VERIFIED, extra proof fields, or a verifier echo for another reference', async () => {
  const { bundle } = bundleWith();
  for (const evidence of [{ evidenceType: 'data-verified', reference: 'TICKET-OK', verification: 'VERIFIED' }, { evidenceType: 'data-verified', reference: 'TICKET-OK', verification: 'DECLARED_UNVERIFIED', signature: 'abc' },
    { evidenceType: 'data-verified', reference: 'TICKET OK', verification: 'DECLARED_UNVERIFIED' }, { evidenceType: 'trust-me', reference: 'TICKET-OK', verification: 'DECLARED_UNVERIFIED' }]) {
    assert.deepEqual(await bundle.verifyEvidence({ quarantineId: QID, evidence }), { status: 'REJECTED', basis: 'invalid-request' }, JSON.stringify(evidence));
  }
  assert.equal((await bundle.verifyEvidence({ quarantineId: QID, evidence: { evidenceType: 'data-verified', reference: 'TICKET-OK', verification: 'DECLARED_UNVERIFIED' }, status: 'VERIFIED' })).status, 'REJECTED');
  const echo = bundleWith({ evidenceVerifier: { verify: async ({ realm }) => ({ realm, reference: 'TICKET-OK', status: 'VERIFIED', verifierRevision: 1 }) } }).bundle;
  assert.equal((await echo.verifyEvidence({ quarantineId: QID, evidence: { evidenceType: 'data-verified', reference: 'TICKET-1', verification: 'DECLARED_UNVERIFIED' } })).status, 'UNVERIFIED');
});

test('X8 permissive default adapter: there is no default; every placeholder answers conservatively and is reported BLOCKED', async () => {
  const p = createBlockingSecurityPolicies();
  assert.ok(Object.isFrozen(p) && Object.values(p).every(Object.isFrozen));
  assert.deepEqual(await p.identityProvider.identify({ credential: { token: 'tok-ops' }, realm: 'test' }), { status: 'denied', reason: 'unauthenticated' });
  assert.equal((await p.separationOfDuties.evaluate({ realm: 'test', capabilities: [] })).decision, 'conflict');
  assert.equal((await p.leasePolicy.evaluate({ realm: 'test', now: 9e15, lease: { acquiredAt: 0 } })).status, 'ACTIVE');
  assert.equal((await p.timeAuthority.now({ realm: 'test' })).status, 'untrusted');
  assert.equal((await p.evidenceVerifier.verify({ realm: 'test', evidence: { reference: 'TICKET-OK' } })).status, 'UNVERIFIED');
  assert.equal((await p.retention.policyFor({ realm: 'test' })).policy.mode, 'pending-decision');
  assert.equal((await p.legalHold.holdFor({ realm: 'test', stream: QID })).legalHold, true);
  assert.throws(() => createOperationsSecurityPolicyBundle({ realm: 'test' }), /identityProvider/);
  assert.deepEqual(Object.values(describeSecurityPolicyReadiness({ realm: 'test', ...p }).dependencies), Array(8).fill('BLOCKED'));
});

test('X9 environment-driven bypass: no env, clock, randomness, timers-as-scheduler or network in the new modules; env changes nothing', async () => {
  for (const file of ['src/services/operations-security-policy.service.ts', 'src/iot/operations-security-policy.contracts.ts']) {
    const src = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    assert.equal(/process\.env|Date\.now|new Date\(|Math\.random|randomUUID|setInterval|fetch\(|node:http|node:net|import\.meta\.env/.test(src), false, file);
  }
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { NODE_ENV: 'development', AGRO_SECURITY_BYPASS: '1', AUTH_DISABLED: 'true', ALLOW_ALL: '1' });
    const bundle = createOperationsSecurityPolicyBundle({ realm: 'test', ...createBlockingSecurityPolicies() });
    assert.equal((await bundle.resolvePrincipal({ token: 'tok-ops' }, 'QUARANTINE_VIEW')).status, 'denied');
    assert.equal(bundle.readiness.productionReady, false);
  } finally { for (const k of ['NODE_ENV', 'AGRO_SECURITY_BYPASS', 'AUTH_DISABLED', 'ALLOW_ALL']) { if (k in saved) process.env[k] = saved[k]; else delete process.env[k]; } }
  const app = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8');
  for (const token of ['security-policy', 'identityProvider', '/login', '/lease', '/audit', '/metrics', '/replay']) assert.equal(app.includes(token), false, token);
});

test('X10 malformed policy objects: hostile getters, hostile answers, non-objects → refused or conservative, never permissive', async () => {
  const hostile = { get identify() { throw new Error('getter'); } };
  assert.throws(() => createOperationsSecurityPolicyBundle({ ...syntheticPolicies().deps, identityProvider: hostile }));
  assert.equal(describeSecurityPolicyReadiness({ ...syntheticPolicies().deps, identityProvider: hostile }).dependencies.identityProvider, 'MISSING');
  assert.equal(describeSecurityPolicyReadiness(new Proxy({}, { get() { throw new Error('proxy'); } })).productionReady, false);
  const answer = { status: 'authenticated', get identity() { throw new Error('hostile'); } };
  assert.equal((await bundleWith({ identityProvider: { identify: async () => answer } }).bundle.resolvePrincipal({ token: 'tok-ops' }, 'QUARANTINE_VIEW')).reason, 'unauthenticated');
  const thenable = { then: (ok) => ok({ status: 'denied', realm: 'test', reason: 'x' }) };
  assert.equal((await bundleWith({ capabilityMapping: { map: () => thenable } }).bundle.resolvePrincipal({ token: 'tok-ops' }, 'QUARANTINE_VIEW')).reason, 'forbidden');
  for (const name of ['identityProvider', 'capabilityMapping', 'separationOfDuties']) {
    assert.throws(() => createOperationsSecurityPolicyBundle({ ...syntheticPolicies().deps, [name]: 'allow-all' }), new RegExp(name));
  }
  // The answer objects handed back are copies: mutating the provider's object later changes nothing.
  const shared = { status: 'authenticated', identity: { realm: 'test', subject: 'op-ops', issuer: 'i', authenticationReference: 'r', attributes: [{ name: 'group', value: 'operators' }] } };
  const b = bundleWith({ identityProvider: { identify: async () => shared } }).bundle;
  const r = await b.resolvePrincipal({}, 'QUARANTINE_REPLAY');
  shared.identity.subject = 'op-evil';
  assert.equal(r.principal.operatorId, 'op-ops');
});
