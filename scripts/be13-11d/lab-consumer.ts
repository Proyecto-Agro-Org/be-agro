// BE13-11D — LOCAL_TEST_ONLY laboratory consumer wiring. NOT a production worker and never imported by app.ts: it composes the
// adapter, the verifier/mapping fixtures, the durable inbox (Mongo) and the reconciler for the Docker campaign.
import type { Connection } from 'mongoose';
import { createEmqxMqttBrokerAdapter, type EmqxMqttBrokerAdapter, type PoisonLabPolicy } from '../../src/adapters/emqx-mqtt-broker.adapter.js';
import { loadMqttJsFactory } from '../../src/adapters/emqx-mqtt-connect.js';
import { decideBrokerAck, type AdapterObservedDelivery } from '../../src/iot/broker-adapter.contracts.js';
import type { DurableBrokerAdmissionDependencies, DurableBrokerAdmissionService } from '../../src/iot/mqtt-ingestion-boundary.contracts.js';
import type { BrokerInboxReconciler, BrokerInboxReconciliationStore } from '../../src/iot/inbox-reconciliation.contracts.js';
import type { MeasurementPersistencePort } from '../../src/iot/ingestion-composition.contracts.js';
import { createMongoBrokerInboxStore } from '../../src/repositories/mongo-broker-inbox.store.js';
import { createMongoBrokerInboxReconciliationStore } from '../../src/repositories/mongo-broker-inbox-reconciliation.store.js';
import { createMongoIngestionIdentityStore } from '../../src/repositories/mongo-ingestion-identity.store.js';
import { createMongoIngestionAuditStore } from '../../src/repositories/mongo-ingestion-audit.store.js';
import { createMongoIngestionQuarantineStore } from '../../src/repositories/mongo-ingestion-quarantine.store.js';
import { createMongoMeasurementPersistence } from '../../src/repositories/mongo-measurement-persistence.repository.js';
import { createMongoPersistenceRecovery } from '../../src/repositories/mongo-persistence-recovery.repository.js';
import { createDurableBrokerAdmissionService } from '../../src/services/mqtt-ingestion-boundary.service.js';
import { createBrokerInboxReconciler } from '../../src/services/broker-inbox-reconciliation.service.js';

export const SENSOR = 'agro_sensors_be1311d', BUSINESS = 'agro_business_be1311d', INGEST = 'agro_ingest_be1311d';
// TEST_ONLY values: NOT production proposals.
export const LAB_LIMITS = Object.freeze({ maxBytes: 4096, maxDepth: 8, maxKeys: 64, maxStringLength: 256 });
export const LAB_CONFIG = Object.freeze({ topicRoutes: Object.freeze([{ prefix: 'agro/lab/in/', messageType: 'telemetry' }]), retained: 'block' as const,
  fields: Object.freeze(['temperature']), verifierTimeoutMs: 2000, auditVerifiedDeliveries: true });
export const LAB_RECONCILIATION_POLICY = Object.freeze({ mode: 'TEST_ONLY', minAgeMs: 1500, claimLeaseMs: 4000, maxBatch: 50 });
export const LAB_RECEIPTED_POLICY = Object.freeze({ mode: 'TEST_ONLY', minAgeMs: 1500 });
// LOCAL_TEST_ONLY identity mapping: authenticated broker principal -> sourceId + technical key. `lab-attacker` authenticates at the
// broker but is deliberately NOT mapped. The mapping never comes from a payload or a topic.
export const LAB_PRINCIPALS: Readonly<Record<string, { sourceId: string; key: string }>> = Object.freeze({
  'emqx-user:lab-device-a': { sourceId: 'lab-source-a', key: 'lab-device-a' },
  'emqx-user:lab-device-b': { sourceId: 'lab-source-b', key: 'lab-device-b' },
});

// BE13-11E: synthetic load publishers lab-load-01..lab-load-NN (each a distinct mapped principal with its own technical key and sourceId).
export const LOAD_PUBLISHERS = 40;
export const loadName = (i: number) => 'lab-load-' + String(i).padStart(2, '0');
export const loadPrincipals = (): Record<string, { sourceId: string; key: string }> => Object.fromEntries(Array.from({ length: LOAD_PUBLISHERS }, (_, i) => [
  'emqx-user:' + loadName(i + 1), { sourceId: 'lab-load-source-' + String(i + 1).padStart(2, '0'), key: loadName(i + 1) }]));

export type MetricSink = { name: string; labels: object }[];

// BE13-11E TEST_ONLY measurement/stress knobs. They exist only in the lab wiring.
export interface LabDepsExtras { inboxDelayMs?: number; auditTimings?: number[] }

export function createLabDeps(conn: Connection, metricsSink: MetricSink, realm = 'test', extras: LabDepsExtras = {}): DurableBrokerAdmissionDependencies {
  const real = createMongoMeasurementPersistence({ connection: conn, prefix: INGEST, realm: realm as never });
  const persistence: MeasurementPersistencePort = { lookup: k => real.lookup(k), replayFencing: 'atomic', persistAtomically: (i, o) => real.persistAtomically(i, o) };
  const principals: Record<string, { sourceId: string; key: string }> = { ...LAB_PRINCIPALS, ...loadPrincipals() };
  const approve = (extra: object = {}) => async (q: { realm: string }) => ({ realm: q.realm, status: 'approved', policyRevision: 1, ...extra });
  return {
    realmAuthority: { authorizedRealm: () => realm },
    temporal: { decide: async (q: { realm: string; timestamps: { receivedAt: number } }) => ({ realm: q.realm, status: 'trusted', at: q.timestamps.receivedAt, clock: 'received-at', policyRevision: 1 }) },
    hardware: { verify: async (q: { realm: string; physicalDeviceId: string }) => ({ realm: q.realm, status: 'verified', physicalDeviceId: q.physicalDeviceId, origin: 'simulated', method: 'synthetic', attestationRevision: 1 }) },
    catalogue: { evaluate: async (q: { realm: string; field: string }) => ({ realm: q.realm, status: 'approved', field: q.field, magnitude: q.field, unit: 'synthetic-unit', catalogueRevision: 1 }) },
    policies: {
      clock: { decide: async (q: { realm: string }) => ({ realm: q.realm, status: 'approved', clock: 'received-at', policyRevision: 1 }) },
      declaredAt: { decide: async (q: { realm: string; candidateClocks: { deviceTimestamp: unknown } }) => ({ realm: q.realm, status: 'approved', source: 'device-timestamp', declaredAt: q.candidateClocks.deviceTimestamp, policyRevision: 1 }) },
      missingReason: { decide: approve({ missingReason: 'absent' }) },
      persistenceTime: { decide: async (q: { realm: string; persistedAt: number }) => ({ realm: q.realm, status: 'approved', persistedAt: q.persistedAt, policyRevision: 1 }) },
    },
    identityStore: createMongoIngestionIdentityStore({ connection: conn, sensorPrefix: SENSOR, businessPrefix: BUSINESS }), persistence,
    be12: { temporal: { select: async (e: { receivedAt: number }) => ({ status: 'trusted', at: e.receivedAt, clock: 'received-at' }) }, catalogue: { accepts: async () => true } },
    deviceStatusHistory: { mode: 'current-state-only', limitation: 'DEVICE_STATUS_HISTORY_REQUIRED' },
    retryPolicy: { decide: () => ({ action: 'stop' as const }) }, retryScheduler: { async wait() { /* TEST_ONLY */ } },
    recovery: createMongoPersistenceRecovery({ connection: conn, prefix: INGEST, realm: realm as never }),
    quarantine: createMongoIngestionQuarantineStore({ connection: conn, prefix: INGEST, realm: realm as never }),
    authorization: { authorize: async () => ({ decision: 'deny', reason: 'unauthenticated' }) },
    audit: timedAudit(createMongoIngestionAuditStore({ connection: conn, prefix: INGEST, realm: realm as never }), extras.auditTimings),
    metrics: { increment: (name: string, labels: object) => { metricsSink.push({ name, labels }); } }, alerts: { emit: () => {} }, retention: { mode: 'retain-indefinitely' },
    timeAuthority: { now: async ({ realm: r }: { realm: string }) => ({ realm: r, status: 'untrusted' }) },
    leasePolicy: { evaluate: async ({ realm: r }: { realm: string }) => ({ realm: r, status: 'ACTIVE', recoveryByNonOwner: 'never', policyRevision: 1 }) },
    brokerProvenanceVerifier: {
      async verify(request: { realm: string; contextFingerprint: string; brokerObserved: { authenticatedPrincipalReference: string | null; receivedAt: number } }) {
        const p = request.brokerObserved.authenticatedPrincipalReference;
        if (p === null || principals[p] === undefined) return { status: 'UNVERIFIED', realm: request.realm, reason: 'principal-unknown', verifierRevision: 1 };
        return { status: 'VERIFIED', realm: request.realm, principalReference: p, contextFingerprint: request.contextFingerprint, authentication: 'broker-confirmed',
          verifiedAt: request.brokerObserved.receivedAt, verifierRevision: 1 };
      } },
    brokerIdentityMapping: {
      async resolve(request: { realm: string; principalReference: string }) {
        const m = principals[request.principalReference];
        return m === undefined ? { status: 'unknown', realm: request.realm }
          : { status: 'mapped', realm: request.realm, principalReference: request.principalReference, sourceId: m.sourceId, technicalDeviceKey: { kind: 'mqtt-clientid', value: m.key }, mappingRevision: 1 };
      } },
    payloadLimits: LAB_LIMITS, boundaryConfig: LAB_CONFIG,
    durableInbox: delayedInbox(createMongoBrokerInboxStore({ connection: conn, prefix: INGEST, realm: realm as never }), extras.inboxDelayMs),
  } as unknown as DurableBrokerAdmissionDependencies;
}

const sleepMs = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
// TEST_ONLY: artificial "slow Mongo" at the inbox boundary (the write itself is still real and majority-acknowledged).
function delayedInbox<T extends { persistVerifiedDelivery(r: never): Promise<unknown> }>(inbox: T, ms?: number): T {
  if (!ms) return inbox;
  return { ...inbox, persistVerifiedDelivery: async (r: never) => { await sleepMs(ms); return inbox.persistVerifiedDelivery(r); } } as T;
}
// TEST_ONLY: audit append latency samples (the audit store itself is unchanged).
function timedAudit<T extends { append(e: never): Promise<unknown> }>(audit: T, sink?: number[]): T {
  if (!sink) return audit;
  return { ...audit, append: async (e: never) => { const t = performance.now(); try { return await audit.append(e); } finally { sink.push(performance.now() - t); } } } as T;
}

export interface LabConsumerHooks {
  beforePersist?: () => void | Promise<void>;
  afterPersist?: () => void | Promise<void>;       // inbox confirmed (receipt in hand), ACK not yet sent
  beforeProcess?: () => void | Promise<void>;      // ACK already released, measurement not yet written
}
// BE13-11E: per-event stage timestamps (performance.now(), ms) shared across consumers by the benchmark.
export interface EventTiming { received: number; persisted?: number; acked?: number; processed?: number; deliveries: number }
export type TimingMap = Map<string, EventTiming>;
export interface LabConsumer {
  readonly adapter: EmqxMqttBrokerAdapter;
  readonly admission: DurableBrokerAdmissionService;
  readonly reconciler: BrokerInboxReconciler;
  readonly store: BrokerInboxReconciliationStore;
  readonly log: { at: string; detail: string }[];
  readonly concurrency: { current: number; max: number };   // handlers running at once on this connection (proves/refutes serialization)
  idle(): Promise<void>;
  stop(): Promise<void>;
}

export async function startLabConsumer(options: { conn: Connection; brokerUrl: string; password: string; clientId?: string; hooks?: LabConsumerHooks; poisonPolicy?: PoisonLabPolicy;
  metricsSink: MetricSink; realm?: string; clean?: boolean; subscribeTopic?: string; receiveMaximum?: number; handlerDelayMs?: number; timings?: TimingMap;
  extras?: LabDepsExtras }): Promise<LabConsumer> {
  const realm = options.realm ?? 'test';
  const store = createMongoBrokerInboxReconciliationStore({ connection: options.conn, prefix: INGEST, realm: realm as never });
  const deps = createLabDeps(options.conn, options.metricsSink, realm, options.extras);
  const admission = createDurableBrokerAdmissionService({ ...deps, reconciliationStore: store });
  const reconciler = createBrokerInboxReconciler({ realm: realm as never, admission, reconciliationStore: store, reconciliationPolicy: LAB_RECONCILIATION_POLICY,
    receiptedRecoveryPolicy: LAB_RECEIPTED_POLICY, audit: deps.audit, metrics: deps.metrics, alerts: deps.alerts });
  const log: { at: string; detail: string }[] = [], pending = new Set<Promise<void>>(), receipts = new WeakMap<AdapterObservedDelivery, string>();
  const concurrency = { current: 0, max: 0 }, ids = new WeakMap<AdapterObservedDelivery, string>(), timings = options.timings;
  const eventIdOf = (d: AdapterObservedDelivery) => { try { return String((JSON.parse(Buffer.from(d.payload).toString('utf8')) as { eventId?: string }).eventId ?? ''); } catch { return ''; } };
  const stamp = (d: AdapterObservedDelivery, stage: 'persisted' | 'acked' | 'processed') => { const t = timings?.get(ids.get(d) ?? ''); if (t && t[stage] === undefined) t[stage] = performance.now(); };
  const hooks = options.hooks ?? {};
  const processFromRecord = (inboxId: string, delivery?: AdapterObservedDelivery) => {
    const p = (async () => { await hooks.beforeProcess?.();
      const res = await admission.processPersistedBrokerDelivery({ inboxId });
      // BE13-11E: a rejection (inbox unavailable, integrity...) or an `uncertain` result is NOT a processed event: the receipted record waits for recovery.
      if (res.status !== 'ingested' || res.results.some(x => x.result.status === 'uncertain')) { log.push({ at: 'process-incomplete', detail: res.status === 'rejected' ? res.reasonCode : 'uncertain' }); return; }
      if (delivery) stamp(delivery, 'processed'); log.push({ at: 'processed', detail: 'ok' }); })()
      .catch(() => { log.push({ at: 'process-failed', detail: 'error' }); });
    pending.add(p); void p.finally(() => pending.delete(p));
  };
  // persist-before-ack: the durable receipt decides the ACK; the pipeline runs only AFTER the ACK was released (QoS 1/2) or at once (QoS 0).
  const handler = async (delivery: AdapterObservedDelivery) => {
    concurrency.current += 1; concurrency.max = Math.max(concurrency.max, concurrency.current);
    try { return await handle(delivery); } finally { concurrency.current -= 1; }
  };
  const handle = async (delivery: AdapterObservedDelivery) => {
    const eventId = eventIdOf(delivery);
    if (timings && eventId) { ids.set(delivery, eventId); const t = timings.get(eventId); if (t) t.deliveries += 1; else timings.set(eventId, { received: performance.now(), deliveries: 1 }); }
    if (options.handlerDelayMs) await sleepMs(options.handlerDelayMs);
    await hooks.beforePersist?.();
    const r = await admission.admit(delivery, { mode: 'persist-only' });
    if (r.status === 'persisted') stamp(delivery, 'persisted');
    log.push({ at: 'persist', detail: r.status === 'rejected' ? r.reasonCode : r.status });
    if (r.status === 'persisted') {
      await hooks.afterPersist?.();
      receipts.set(delivery, r.receipt.inboxId);
      if (delivery.brokerObserved.qos === 0) processFromRecord(r.receipt.inboxId, delivery);
    }
    return decideBrokerAck(delivery.brokerObserved.qos, r);
  };
  const adapter = createEmqxMqttBrokerAdapter({ brokerUrl: options.brokerUrl, clientId: options.clientId ?? 'lab-consumer-1', username: 'lab-consumer', password: options.password,
    mqttFactory: await loadMqttJsFactory(), poisonPolicy: options.poisonPolicy ?? 'ack-and-drop', metrics: deps.metrics,
    ...(options.clean === undefined ? {} : { clean: options.clean }), ...(options.subscribeTopic === undefined ? {} : { subscribeTopic: options.subscribeTopic }),
    ...(options.receiveMaximum === undefined ? {} : { receiveMaximum: options.receiveMaximum }),
    testHooks: { afterAck: delivery => { log.push({ at: 'acked', detail: 'puback-released' }); stamp(delivery, 'acked'); const id = receipts.get(delivery); if (id !== undefined) processFromRecord(id, delivery); } } });
  await adapter.start(handler);
  return { adapter, admission, reconciler, store, log, concurrency,
    async idle() { while (pending.size > 0) await Promise.allSettled([...pending]); },
    async stop() { await adapter.stop(); } };
}
