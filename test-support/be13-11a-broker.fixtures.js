// SINTETICO — BE13-11A TEST_ONLY broker fixtures. No real broker, principal, credential, topic or device. Every limit,
// timeout, route and field list below is a TEST_ONLY value, NOT a production proposal.
import { fixture, world, RECEIVED, PERSISTED, createInMemoryPersistence, createTestOnlyRetryPolicy, createDeterministicScheduler, createInMemoryRecovery,
  createInMemoryQuarantine, createInMemoryAudit, createSyntheticOperatorAuthority, createRecordingMetrics, createRecordingAlerts,
  createSyntheticLeaseGovernance } from './be13-composition.fixtures.js';
import { createMqttIngestionBoundary } from '../dist/src/services/mqtt-ingestion-boundary.service.js';

export const TEST_ONLY_LIMITS = Object.freeze({ maxBytes: 4096, maxDepth: 8, maxKeys: 64, maxStringLength: 256 });
export const TEST_ONLY_CONFIG = Object.freeze({ topicRoutes: Object.freeze([{ prefix: 'synthetic/agro/', messageType: 'telemetry' }]), retained: 'block',
  fields: Object.freeze(['temperature']), verifierTimeoutMs: 50, auditVerifiedDeliveries: true });
export const PRINCIPAL = 'principal:synthetic-device-001';
export const KEY = 'synthetic-device-001';

// Device envelope (BE13-01 F01 shape) — payloadDeclared.
export function envelope(patch = {}) {
  const f = fixture('F01');
  return { version: 1, eventId: f.eventId, sentAt: f.sentAt, clientid: f.clientid, deviceTimestamp: f.deviceTimestamp, payload: { ...f.payload },
    mqtt: { topic: f.mqtt.topic, messageType: 'telemetry', dataOrigin: 'simulated' }, ...patch };
}
export const bytesOf = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
// brokerObserved — what a future adapter would observe.
export function observed(patch = {}) {
  return { connectionReference: 'conn:synthetic-1', authenticatedPrincipalReference: PRINCIPAL, mqttClientId: KEY, topic: 'synthetic/agro/device-001/telemetry',
    qos: 1, retain: false, packetId: 7, receivedAt: RECEIVED, rawPersistedAt: PERSISTED, ...patch };
}
export const delivery = ({ obs = {}, env = {}, payload } = {}) => ({ brokerObserved: observed(obs), payload: payload ?? bytesOf(envelope(env)) });

// Synthetic verifier: authenticates PRINCIPAL on any 'conn:' connection and echoes the request fingerprint.
export function syntheticVerifier(mode = { kind: 'ok' }) {
  const calls = [];
  return { calls, mode, async verify(request) {
    calls.push(request);
    const m = this.mode;
    if (m.kind === 'throw') throw new Error('verifier down');
    if (m.kind === 'hang') return new Promise(() => {});
    if (m.kind === 'answer') return typeof m.answer === 'function' ? m.answer(request) : m.answer;
    if (request.brokerObserved.authenticatedPrincipalReference !== PRINCIPAL) return { status: 'UNVERIFIED', realm: request.realm, reason: 'principal-unknown', verifierRevision: 1 };
    if (m.kind === 'reject') return { status: 'REJECTED', realm: request.realm, reason: 'policy-violation', verifierRevision: 1 };
    return { status: 'VERIFIED', realm: request.realm, principalReference: PRINCIPAL, contextFingerprint: request.contextFingerprint, authentication: 'broker-confirmed',
      verifiedAt: request.brokerObserved.receivedAt, verifierRevision: 1 };
  } };
}
export function syntheticMapping(mode = { kind: 'ok' }) {
  return { mode, async resolve(request) {
    const m = this.mode;
    if (m.kind === 'answer') return typeof m.answer === 'function' ? m.answer(request) : m.answer;
    if (request.principalReference !== PRINCIPAL) return { status: 'unknown', realm: request.realm };
    return { status: 'mapped', realm: request.realm, principalReference: PRINCIPAL, sourceId: 'synthetic-ingest', technicalDeviceKey: { kind: 'mqtt-clientid', value: m.key ?? KEY }, mappingRevision: 1 };
  } };
}

const ALL = ['QUARANTINE_VIEW', 'QUARANTINE_REPLAY', 'QUARANTINE_UNBLOCK', 'QUARANTINE_BLOCK', 'QUARANTINE_RESOLVE', 'QUARANTINE_DISCARD', 'AUDIT_VIEW', 'OPERATIONS_VIEW'];
export async function boundarySetup({ extra = {}, verifierMode, mappingMode, persistence: persistenceOverride } = {}) {
  const w = world();
  const persistence = persistenceOverride ?? createInMemoryPersistence(w.calls);
  const quarantine = await createInMemoryQuarantine(), audit = createInMemoryAudit(), metrics = createRecordingMetrics(), alerts = createRecordingAlerts();
  const lease = createSyntheticLeaseGovernance({ start: RECEIVED });
  const verifier = syntheticVerifier(verifierMode), mapping = syntheticMapping(mappingMode);
  const deps = { realmAuthority: { authorizedRealm: () => 'test' }, hardware: w.deps.hardware, temporal: w.deps.temporal, catalogue: w.deps.catalogue,
    policies: w.deps.policies, identityStore: w.deps.identityStore, persistence,
    be12: { temporal: { select: async e => ({ status: 'trusted', at: e.receivedAt, clock: 'received-at' }) }, catalogue: { accepts: async () => true } },
    deviceStatusHistory: { mode: 'current-state-only', limitation: 'DEVICE_STATUS_HISTORY_REQUIRED' }, retryPolicy: createTestOnlyRetryPolicy(1),
    retryScheduler: createDeterministicScheduler(), recovery: createInMemoryRecovery(persistence), quarantine,
    authorization: createSyntheticOperatorAuthority({ 'tok-admin': { operatorId: 'op-admin', realms: ['test'], capabilities: ALL, authenticationReference: 'synthetic:admin' } }),
    audit, metrics, alerts, retention: { mode: 'retain-indefinitely' }, timeAuthority: lease.timeAuthority, leasePolicy: lease.leasePolicy,
    brokerProvenanceVerifier: verifier, brokerIdentityMapping: mapping, payloadLimits: TEST_ONLY_LIMITS, boundaryConfig: TEST_ONLY_CONFIG, ...extra };
  return { w, persistence, quarantine, audit, metrics, alerts, verifier, mapping, deps, boundary: createMqttIngestionBoundary(deps) };
}
