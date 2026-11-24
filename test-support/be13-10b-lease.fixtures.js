// BE13-10B — TEST_ONLY harness for lease governance over the in-memory doubles. A "gate" holds a replay INSIDE the
// pipeline (lease held, right before the fenced write) so another operator can act while it is genuinely in flight.
import { protectedDocument, world, createInMemoryPersistence, createTestOnlyRetryPolicy, createDeterministicScheduler, createInMemoryRecovery,
  createInMemoryQuarantine, createInMemoryAudit, createSyntheticOperatorAuthority, createRecordingMetrics, createRecordingAlerts,
  createSyntheticLeaseGovernance, TEST_ONLY_LEASE_WINDOW } from './be13-composition.fixtures.js';
import { createIngestionOperationsBootstrap } from '../dist/src/services/ingestion-operations.service.js';

export { TEST_ONLY_LEASE_WINDOW };
const ALL = ['QUARANTINE_VIEW', 'QUARANTINE_REPLAY', 'QUARANTINE_UNBLOCK', 'QUARANTINE_BLOCK', 'QUARANTINE_RESOLVE', 'QUARANTINE_DISCARD', 'AUDIT_VIEW', 'OPERATIONS_VIEW'];
export const OPERATORS = {
  'tok-a': { operatorId: 'op-a', realms: ['test'], capabilities: ['QUARANTINE_VIEW', 'QUARANTINE_REPLAY'], authenticationReference: 'synthetic:a' },
  'tok-b': { operatorId: 'op-b', realms: ['test'], capabilities: ['QUARANTINE_VIEW', 'QUARANTINE_REPLAY', 'QUARANTINE_UNBLOCK', 'QUARANTINE_DISCARD'], authenticationReference: 'synthetic:b' },
  'tok-c': { operatorId: 'op-c', realms: ['test'], capabilities: ['QUARANTINE_VIEW', 'QUARANTINE_REPLAY', 'QUARANTINE_UNBLOCK'], authenticationReference: 'synthetic:c' },
  'tok-replayer': { operatorId: 'op-replayer', realms: ['test'], capabilities: ['QUARANTINE_REPLAY'], authenticationReference: 'synthetic:replayer' },
  'tok-admin': { operatorId: 'op-admin', realms: ['test'], capabilities: ALL, authenticationReference: 'synthetic:admin' },
  'tok-preview': { operatorId: 'op-preview', realms: ['preview'], capabilities: ALL, authenticationReference: 'synthetic:preview' },
};
export const A = { token: 'tok-a' }, B = { token: 'tok-b' }, C = { token: 'tok-c' };
const verifier = { verify: e => (e && e.syntheticTestOnly === true ? { sourceId: e.sourceId, operation: 'telemetry', eventId: e.eventId, device: { kind: 'mqtt-clientid', value: e.clientid } } : null) };
export const evidenceFor = doc => ({ syntheticTestOnly: true, sourceId: doc.sourceId, eventId: doc.eventId, clientid: doc.clientid });
export const ev = (evidenceType = 'operator-decision', reference = 'TICKET-1') => ({ evidenceType, reference });

export async function leaseSetup({ extra = {}, fencing = true } = {}) {
  const w = world();
  const persistence = createInMemoryPersistence(w.calls);
  let failing = true, hold = null;
  const wrapped = {
    lookup: k => persistence.lookup(k),
    async persistAtomically(i, o) {
      if (failing) throw new Error('down');
      if (hold) { const h = hold; hold = null; h.reached(); await h.released; }
      return persistence.persistAtomically(i, o);
    },
    ...(fencing ? { replayFencing: 'atomic' } : {}),
  };
  const quarantine = await createInMemoryQuarantine(), audit = createInMemoryAudit(), metrics = createRecordingMetrics(), alerts = createRecordingAlerts();
  const lease = createSyntheticLeaseGovernance();
  const deps = { realmAuthority: { authorizedRealm: () => 'test' }, provenanceVerifier: verifier, hardware: w.deps.hardware, temporal: w.deps.temporal, catalogue: w.deps.catalogue,
    policies: w.deps.policies, identityStore: w.deps.identityStore, persistence: wrapped,
    be12: { temporal: { select: async e => ({ status: 'trusted', at: e.receivedAt, clock: 'received-at' }) }, catalogue: { accepts: async () => true } },
    deviceStatusHistory: { mode: 'current-state-only', limitation: 'DEVICE_STATUS_HISTORY_REQUIRED' }, retryPolicy: createTestOnlyRetryPolicy(1),
    retryScheduler: createDeterministicScheduler(), recovery: createInMemoryRecovery(persistence), quarantine, authorization: createSyntheticOperatorAuthority(OPERATORS),
    audit, metrics, alerts, retention: { mode: 'retain-indefinitely' }, timeAuthority: lease.timeAuthority, leasePolicy: lease.leasePolicy, ...extra };
  const boot = createIngestionOperationsBootstrap(deps);
  const doc = protectedDocument();
  const q = await boot.ingest(doc, evidenceFor(doc), { field: 'temperature' });
  if (q.quarantineStatus !== 'RETRYABLE') throw new Error('setup: expected RETRYABLE');
  failing = false;
  const id = q.quarantineId;
  const s = {
    w, persistence, quarantine, audit, metrics, alerts, lease, deps, boot, doc, id,
    record: () => quarantine.get(id),
    version: async () => (await quarantine.get(id)).version,
    replayInput: async (version) => ({ quarantineId: id, expectedVersion: version ?? (await quarantine.get(id)).version, protectedDocument: doc, provenanceEvidence: evidenceFor(doc), field: 'temperature' }),
    // Holds the NEXT write right before the fenced persistence; resolves when the replay is parked there.
    holdNextWrite() { let reached, release; const h = { reached: null, released: new Promise(r => { release = r; }) };
      const atGate = new Promise(r => { reached = r; }); h.reached = reached; hold = h; return { atGate, release }; },
    async leaseOp(op, credential, extraInput = {}) { return boot.operations[op](credential, { quarantineId: id, expectedVersion: await s.version(), evidence: ev(), ...extraInput }); },
    trail: async () => (await audit.listForQuarantine(id, 200)).map(a => a.action),
  };
  return s;
}
