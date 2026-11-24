// SYNTHETIC TEST SUPPORT for BE13-05. Not production code, not a persistence
// layer, not an approved policy. Lives outside test/ so `node --test` does not
// load it as a suite. Everything here is an explicit test double.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIngestProvenanceAuthority } from '../dist/src/iot/ingest-provenance.authority.js';
import { createProtectedIngestMapper } from '../dist/src/iot/protected-ingest.mapper.js';
import { createBe12IdentityPorts } from '../dist/src/adapters/ingestion-identity.adapters.js';
import { createMeasurementAttributionService } from '../dist/src/services/measurement-attribution.service.js';
import { createMeasurementIngestionComposition } from '../dist/src/services/measurement-ingestion-composition.service.js';

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'be13-01', 'fixtures');
const manifest = JSON.parse(readFileSync(join(fixtureRoot, 'manifest.json'), 'utf8'));
export const fixture = id => JSON.parse(readFileSync(join(fixtureRoot, manifest.find(row => row.id === id).file), 'utf8'));

export const REALM = 'test';
export const SENT = 1795115600000;
export const RECEIVED = SENT + 100;
export const PERSISTED = RECEIVED + 10;
export const DEVICE_TS = 1795115595000;

export function protectedDocument(patch = {}, { receivedAt = RECEIVED, persistedAt = PERSISTED } = {}) {
  const envelope = { ...fixture('F01'), ...patch };
  return {
    sourceId: patch.sourceId ?? 'synthetic-ingest', operation: 'measurement', eventId: envelope.eventId, clientid: envelope.clientid,
    _receivedAt: new Date(receivedAt), ...(persistedAt === null ? {} : { persistedAt: new Date(persistedAt) }), _payload: structuredClone(envelope.payload),
    _provenance: { serviceAuthenticated: true, sourceId: patch.sourceId ?? 'synthetic-ingest', eventId: envelope.eventId, technicalClientId: envelope.clientid,
      brokerIdentity: 'declared-unverified', mqttContext: 'service-declared', topic: envelope.mqtt.topic, messageType: 'telemetry',
      dataOriginDeclared: envelope.mqtt.dataOrigin, physicalMeasurementVerified: false, commercialAttribution: false,
      deviceTimestamp: envelope.deviceTimestamp ?? null, brokerDeclaredAt: new Date(envelope.sentAt), receivedAt: new Date(receivedAt) },
  };
}

// ProtectedDocument → Candidate through the real BE13-02 mapper and a synthetic provenance verifier.
export function mapDocument(document) {
  const evidence = Object.freeze({ syntheticTestOnly: true });
  const boundary = createIngestProvenanceAuthority({ verify: v => v === evidence ? { sourceId: document.sourceId, operation: 'telemetry',
    eventId: document.eventId, device: { kind: 'mqtt-clientid', value: document.clientid } } : null });
  return createProtectedIngestMapper(boundary.authority).map(document, boundary.attest(evidence));
}
export const candidate = (patch, options) => {
  const result = mapDocument(protectedDocument(patch, options));
  if (result.status !== 'candidate') throw new Error('fixture must be a candidate');
  return result;
};

export const device = (patch = {}) => ({ realm: REALM, id: 'device-1', sourceId: 'synthetic-ingest', key: { kind: 'mqtt-clientid', value: 'synthetic-device-001' },
  verification: 'verified', lifecycle: 'active', version: 3, createdAt: 1, updatedAt: 2, ...patch });
export const association = (patch = {}) => ({ realm: REALM, id: 'assoc-A', revision: 1, clientId: 'client-A', sensorId: 'sensor-A', fieldId: 'field-A',
  areaId: 'area-A', physicalDeviceId: 'device-1', sourceId: 'synthetic-ingest', device: { kind: 'mqtt-clientid', value: 'synthetic-device-001' },
  validFrom: 0, validTo: null, state: 'active', auditReason: 'synthetic', ...patch });
export const closed = patch => association({ state: 'closed', ...patch });

// In-memory realm-scoped identity store: applies realm "in storage".
export function createInMemoryIdentityStore(state, calls = []) {
  return {
    async findDevicesByKey(q) {
      calls.push(['store:devices', q]);
      const rows = state.devices.filter(r => r.realm === q.realm && r.sourceId === q.sourceId && r.key.kind === q.key.kind && r.key.value === q.key.value);
      return { realm: q.realm, rows: structuredClone(rows.slice(0, q.limit)) };
    },
    async findAssociationsAt(q) {
      calls.push(['store:associations', q]);
      const rows = state.history.filter(r => r.realm === q.realm && r.physicalDeviceId === q.physicalDeviceId && r.validFrom <= q.at && (r.validTo === null || q.at < r.validTo));
      return { realm: q.realm, complete: true, rows: structuredClone(rows.slice(0, q.limit)) };
    },
  };
}

// In-memory idempotency fake: single-threaded, deterministic, NOT persistence.
export function createInMemoryIdempotency(calls = []) {
  const entries = new Map();
  const id = k => JSON.stringify([k.realm, k.sourceId, k.operation, k.eventId, k.field]);
  return {
    entries,
    async lookup(k) { calls.push(['idem:lookup', k]); const fp = entries.get(id(k)); return fp ? { realm: k.realm, status: 'present', fingerprint: fp } : { realm: k.realm, status: 'absent' }; },
    async claim(k) {
      calls.push(['idem:claim', k]);
      const current = entries.get(id(k));
      if (current === undefined) { entries.set(id(k), k.fingerprint); return { realm: k.realm, status: 'claimed' }; }
      return { realm: k.realm, status: current === k.fingerprint ? 'replay' : 'conflict' };
    },
  };
}

export function world(overrides = {}) {
  const calls = [];
  const state = {
    devices: [device()], history: [association()],
    temporal: { status: 'trusted', at: RECEIVED, clock: 'received-at', policyRevision: 7 },
    hardware: { status: 'verified', origin: 'simulated', method: 'synthetic-double', attestationRevision: 2 },
    catalogue: { temperature: { magnitude: 'temperature', unit: 'celsius' }, soil_moisture: { magnitude: 'soil-moisture-raw', unit: 'percent' } },
    policies: {
      clock: () => ({ status: 'approved', clock: 'received-at', policyRevision: 1 }),
      declaredAt: q => ({ status: 'approved', source: 'device-timestamp', declaredAt: q.candidateClocks.deviceTimestamp, policyRevision: 1 }),
      missingReason: () => ({ status: 'approved', missingReason: 'absent', policyRevision: 1 }),
      persistenceTime: q => ({ status: 'approved', persistedAt: q.persistedAt, policyRevision: 1 }),
    },
    ...overrides,
  };
  const identityStore = createInMemoryIdentityStore(state, calls);
  const idempotency = createInMemoryIdempotency(calls);
  const temporal = { async decide(q) { calls.push(['temporal', q]); return { realm: q.realm, ...state.temporal }; } };
  const hardware = { async verify(q) { calls.push(['hardware', q]);
    return state.hardware.status === 'verified' ? { realm: q.realm, physicalDeviceId: q.physicalDeviceId, ...state.hardware } : { realm: q.realm, ...state.hardware }; } };
  const catalogue = { async evaluate(q) { calls.push(['catalogue', q]); const row = state.catalogue[q.field];
    return row ? { status: 'approved', realm: q.realm, field: q.field, catalogueRevision: 4, ...row } : { status: 'unknown-magnitude', realm: q.realm }; } };
  const policy = name => ({ async decide(q) { calls.push(['policy:' + name, q]); return { realm: q.realm, ...state.policies[name](q) }; } });
  const policies = { clock: policy('clock'), declaredAt: policy('declaredAt'), missingReason: policy('missingReason'), persistenceTime: policy('persistenceTime') };
  // Real BE-12 service over the same store; synthetic temporal mirrors the synthetic clock policy.
  const be12 = createMeasurementAttributionService({
    ...createBe12IdentityPorts(identityStore, REALM),
    temporal: { async select(event) { calls.push(['be12:temporal', event.eventId]);
      return state.be12Temporal ? state.be12Temporal(event) : { status: 'trusted', at: event.receivedAt, clock: 'received-at' }; } },
    catalogue: { async accepts() { return state.be12Catalogue ?? true; } },
  }, { realm: REALM });
  const deps = { realmContext: { realm: REALM }, identityStore, temporal, hardware, catalogue, policies, idempotency, be12 };
  return { state, calls, deps, idempotency, compose: (extra = {}) => createMeasurementIngestionComposition({ ...deps, ...extra }) };
}

export const deepFrozen = v => v === null || typeof v !== 'object' || (Object.isFrozen(v) && Object.values(v).every(deepFrozen));
export const objectsOf = (v, out = new Set()) => { if (v !== null && typeof v === 'object' && !out.has(v)) { out.add(v); Object.values(v).forEach(x => objectsOf(x, out)); } return out; };

// BE13-06: in-memory stand-in for persistMeasurementAtomically. Single-threaded
// and therefore trivially "atomic"; NOT a transaction and NOT persistence.
export function createInMemoryPersistence(calls = []) {
  const claims = new Map(), measurements = new Map();
  const id = k => JSON.stringify([k.realm, k.sourceId, k.operation, k.eventId, k.field]);
  const mid = k => 'm_' + Buffer.from(id(k)).toString('hex').padEnd(64, '0').slice(0, 64);
  return {
    claims, measurements,
    async lookup(k) { calls.push(['persist:lookup', k]); const c = claims.get(id(k));
      return c ? { realm: k.realm, status: 'present', fingerprint: c.fingerprint, measurementId: c.measurementId } : { realm: k.realm, status: 'absent' }; },
    async persistAtomically(input) {
      calls.push(['persist:atomic', input]);
      const k = input.key, current = claims.get(id(k));
      if (current) return current.fingerprint === input.fingerprint ? { realm: k.realm, status: 'duplicate', measurementId: current.measurementId } : { realm: k.realm, status: 'conflict' };
      const measurementId = mid(k);
      claims.set(id(k), { fingerprint: input.fingerprint, measurementId }); measurements.set(measurementId, structuredClone(input));
      return { realm: k.realm, status: 'persisted', measurementId };
    },
  };
}

// ---------------------------------------------------------------- BE13-08 synthetic doubles (TEST_ONLY)
// Bounded retry policy: maxAttempts is a TEST_ONLY number, not an SLO.
export function createTestOnlyRetryPolicy(maxAttempts = 3, calls = []) {
  return { decide(input) { calls.push(['retry:decide', input]); return input.attempt < maxAttempts ? { action: 'retry' } : { action: 'stop' }; } };
}
// Deterministic scheduler: records waits, never sleeps.
export function createDeterministicScheduler(calls = []) {
  return { waits: [], async wait(input) { calls.push(['retry:wait', input]); this.waits.push(input); } };
}
// Recovery over the in-memory persistence fake (same semantics as the Mongo recovery).
export function createInMemoryRecovery(persistence, calls = []) {
  const id = k => JSON.stringify([k.realm, k.sourceId, k.operation, k.eventId, k.field]);
  return {
    async inspect(k) {
      calls.push(['recovery:inspect', k]);
      const claim = persistence.claims.get(id(k));
      const measurement = claim ? persistence.measurements.get(claim.measurementId) : [...persistence.measurements.values()].find(m => id(m.key) === id(k));
      if (!claim && !measurement) return { realm: k.realm, state: 'not-committed' };
      if (claim && !measurement) return { realm: k.realm, state: 'inconsistent', inconsistency: 'orphan-claim' };
      if (!claim && measurement) return { realm: k.realm, state: 'inconsistent', inconsistency: 'orphan-measurement' };
      if (claim.fingerprint !== measurement.fingerprint) return { realm: k.realm, state: 'inconsistent', inconsistency: 'fingerprint-mismatch' };
      return { realm: k.realm, state: 'committed', measurementId: claim.measurementId, fingerprint: claim.fingerprint };
    },
  };
}
// In-memory quarantine store with the same dedupe key, state machine and audit semantics.
export async function createInMemoryQuarantine(realm = REALM) {
  const { quarantineIdFor } = await import('../dist/src/repositories/mongo-ingestion-quarantine.store.js');
  const { initialQuarantineStatus, isTransitionAllowed } = await import('../dist/src/iot/ingestion-failure-classification.js');
  const rows = new Map(); let clock = 0;
  return {
    rows,
    async record(entry) {
      if (entry.realm !== realm) throw new Error('QUARANTINE_REALM_MISMATCH');
      const quarantineId = quarantineIdFor(entry); const now = ++clock;
      const row = rows.get(quarantineId) ?? { ...structuredClone(entry), quarantineId, status: initialQuarantineStatus(entry.retryClass), attemptCount: 0, firstSeenAt: now, audit: [] };
      row.attemptCount += 1; row.lastSeenAt = now; row.audit.push({ action: 'recorded', at: now, outcome: entry.reasonCode, reasonCode: entry.reasonCode, evidence: null });
      rows.set(quarantineId, row);
      return { realm, quarantineId, status: row.status, attemptCount: row.attemptCount };
    },
    async get(id) { const r = rows.get(id); return r && r.realm === realm ? structuredClone(r) : null; },
    async transition({ quarantineId, from, to, evidence, outcome }) {
      const r = rows.get(quarantineId); if (!r || r.realm !== realm) return 'not-found';
      if (r.status !== from) return 'stale';
      if (!isTransitionAllowed(from, to, r.retryClass) || (from === 'BLOCKED' && to === 'RETRYABLE' && !evidence)) return 'not-allowed';
      r.status = to; r.audit.push({ action: 'transition', at: ++clock, outcome, reasonCode: null, evidence }); return 'transitioned';
    },
    async appendAudit(id, entry) { const r = rows.get(id); if (!r || r.realm !== realm) return false; r.audit.push({ ...entry, at: ++clock }); return true; },
  };
}
