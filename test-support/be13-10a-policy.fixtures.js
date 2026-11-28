// BE13-10A — TEST_ONLY synthetic policies. They exist to exercise the framework;
// none of the identities, groups, exclusions, windows, dates or tickets below is a
// proposal for production. Production modules never import test-support.
export const QID = 'q_' + 'a'.repeat(64);

const IDENTITIES = {
  'tok-ops': { subject: 'op-ops', groups: ['operators'] },
  'tok-ops2': { subject: 'op-ops2', groups: ['operators'] },
  'tok-viewer': { subject: 'op-viewer', groups: ['viewers'] },
  'tok-both': { subject: 'op-both', groups: ['operators', 'discarders'] },
  'tok-conflict': { subject: 'op-conflict', groups: ['unblockers', 'discarders'] },
  'tok-stranger': { subject: 'op-stranger', groups: ['unknown-group'] },
  'tok-preview': { subject: 'op-preview', groups: ['operators'], realm: 'preview' },
};
const GROUP_CAPABILITIES = {
  operators: ['QUARANTINE_VIEW', 'QUARANTINE_REPLAY'],
  viewers: ['QUARANTINE_VIEW'],
  discarders: ['QUARANTINE_DISCARD'],
  unblockers: ['QUARANTINE_UNBLOCK'],
};
const EXCLUSIONS = [['QUARANTINE_UNBLOCK', 'QUARANTINE_DISCARD']];
export const TEST_ONLY_LEASE_WINDOW = 5_000;      // synthetic units, NOT a production duration
export const TEST_ONLY_RETAIN_UNTIL = 5_000;      // synthetic instant, NOT a production date

export function syntheticPolicies(overrides = {}) {
  const clock = { at: 1_000, trusted: true };
  const holds = new Set();
  const verifierCalls = [];
  const deps = {
    realm: 'test',
    // The credential is read ONLY for its token; anything else it carries is ignored.
    identityProvider: { async identify({ credential, realm }) {
      const e = IDENTITIES[credential?.token];
      if (!e) return { status: 'denied', reason: 'unauthenticated' };
      return { status: 'authenticated', identity: { realm: e.realm ?? realm, subject: e.subject, issuer: 'synthetic-idp', authenticationReference: 'synthetic:' + e.subject,
        attributes: e.groups.map(value => ({ name: 'group', value })) } };
    } },
    capabilityMapping: { async map({ realm, identity }) {
      const caps = [...new Set(identity.attributes.filter(a => a.name === 'group').flatMap(a => GROUP_CAPABILITIES[a.value] ?? []))];
      return caps.length ? { status: 'mapped', realm, capabilities: caps, policyRevision: 1 } : { status: 'denied', realm, reason: 'no-capability' };
    } },
    separationOfDuties: { async evaluate({ realm, capabilities }) {
      const hit = EXCLUSIONS.find(([a, b]) => capabilities.includes(a) && capabilities.includes(b));
      return hit ? { realm, decision: 'conflict', conflictingCapabilities: hit, policyRevision: 1 } : { realm, decision: 'permit', policyRevision: 1 };
    } },
    leasePolicy: { async evaluate({ realm, lease, now }) {
      return { realm, status: now - lease.acquiredAt > TEST_ONLY_LEASE_WINDOW ? 'EXPIRED' : 'ACTIVE', recoveryByNonOwner: 'when-expired', policyRevision: 1 };
    } },
    timeAuthority: { async now({ realm }) { return clock.trusted ? { realm, status: 'trusted', at: clock.at, authorityRevision: 1 } : { realm, status: 'untrusted' }; } },
    evidenceVerifier: { async verify(request) {
      verifierCalls.push(request);
      const status = request.evidence.reference === 'TICKET-OK' ? 'VERIFIED' : request.evidence.reference === 'TICKET-BAD' ? 'REJECTED' : 'UNVERIFIED';
      return { realm: request.realm, reference: request.evidence.reference, status, verifierRevision: 1 };
    } },
    retention: { async policyFor({ realm }) { return { realm, policy: { mode: 'retain-until', until: TEST_ONLY_RETAIN_UNTIL, approvalReference: 'SYNTHETIC-RETENTION' }, policyRevision: 1 }; } },
    legalHold: { async holdFor({ realm, stream }) { return { realm, stream, legalHold: holds.has(stream), holdReference: holds.has(stream) ? 'SYNTHETIC-HOLD' : null }; } },
    ...overrides,
  };
  return { deps, clock, holds, verifierCalls };
}

// In-memory lease store with CAS on (state, leaseId, version). Check-and-set is
// synchronous, so concurrent callers observe a single winner.
export function createInMemoryLeaseStore(realm = 'test') {
  const leases = new Map();
  const history = [];
  let writes = 0;
  return {
    history,
    writes: () => writes,
    async get(quarantineId) { const l = leases.get(quarantineId); return l ? { ...l } : null; },
    async acquire({ quarantineId, ownerOperatorId, acquiredAt, expectedVersion }) {
      const current = leases.get(quarantineId);
      if (current?.state === 'ACTIVE') return 'held';
      if ((current?.version ?? 0) !== expectedVersion) return 'stale';
      const version = expectedVersion + 1;
      leases.set(quarantineId, { realm, quarantineId, leaseId: `l_${version}_${quarantineId.slice(2, 10)}`, ownerOperatorId, acquiredAt, state: 'ACTIVE', version });
      writes += 1; history.push({ op: 'acquire', quarantineId, ownerOperatorId, version });
      return 'acquired';
    },
    async release({ quarantineId, leaseId, expectedVersion, releasedBy, reason }) {
      const current = leases.get(quarantineId);
      if (!current || current.state !== 'ACTIVE' || current.leaseId !== leaseId || current.version !== expectedVersion) return 'stale';
      leases.set(quarantineId, { ...current, state: 'RELEASED', version: current.version + 1 });
      writes += 1; history.push({ op: 'release', quarantineId, releasedBy, reason, version: current.version + 1 });
      return 'released';
    },
  };
}
