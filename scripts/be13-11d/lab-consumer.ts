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

export type MetricSink = { name: string; labels: object }[];

export function createLabDeps(conn: Connection, metricsSink: MetricSink, realm = 'test'): DurableBrokerAdmissionDependencies {
  const real = createMongoMeasurementPersistence({ connection: conn, prefix: INGEST, realm: realm as never });
  const persistence: MeasurementPersistencePort = { lookup: k => real.lookup(k), replayFencing: 'atomic', persistAtomically: (i, o) => real.persistAtomically(i, o) };
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
    audit: createMongoIngestionAuditStore({ connection: conn, prefix: INGEST, realm: realm as never }),
    metrics: { increment: (name: string, labels: object) => { metricsSink.push({ name, labels }); } }, alerts: { emit: () => {} }, retention: { mode: 'retain-indefinitely' },
    timeAuthority: { now: async ({ realm: r }: { realm: string }) => ({ realm: r, status: 'untrusted' }) },
    leasePolicy: { evaluate: async ({ realm: r }: { realm: string }) => ({ realm: r, status: 'ACTIVE', recoveryByNonOwner: 'never', policyRevision: 1 }) },
    brokerProvenanceVerifier: {
      async verify(request: { realm: string; contextFingerprint: string; brokerObserved: { authenticatedPrincipalReference: string | null; receivedAt: number } }) {
        const p = request.brokerObserved.authenticatedPrincipalReference;
        if (p === null || LAB_PRINCIPALS[p] === undefined) return { status: 'UNVERIFIED', realm: request.realm, reason: 'principal-unknown', verifierRevision: 1 };
        return { status: 'VERIFIED', realm: request.realm, principalReference: p, contextFingerprint: request.contextFingerprint, authentication: 'broker-confirmed',
          verifiedAt: request.brokerObserved.receivedAt, verifierRevision: 1 };
      } },
    brokerIdentityMapping: {
      async resolve(request: { realm: string; principalReference: string }) {
        const m = LAB_PRINCIPALS[request.principalReference];
        return m === undefined ? { status: 'unknown', realm: request.realm }
          : { status: 'mapped', realm: request.realm, principalReference: request.principalReference, sourceId: m.sourceId, technicalDeviceKey: { kind: 'mqtt-clientid', value: m.key }, mappingRevision: 1 };
      } },
    payloadLimits: LAB_LIMITS, boundaryConfig: LAB_CONFIG,
    durableInbox: createMongoBrokerInboxStore({ connection: conn, prefix: INGEST, realm: realm as never }),
  } as unknown as DurableBrokerAdmissionDependencies;
}

export interface LabConsumerHooks {
  beforePersist?: () => void | Promise<void>;
  afterPersist?: () => void | Promise<void>;       // inbox confirmed (receipt in hand), ACK not yet sent
  beforeProcess?: () => void | Promise<void>;      // ACK already released, measurement not yet written
}
export interface LabConsumer {
  readonly adapter: EmqxMqttBrokerAdapter;
  readonly admission: DurableBrokerAdmissionService;
  readonly reconciler: BrokerInboxReconciler;
  readonly store: BrokerInboxReconciliationStore;
  readonly log: { at: string; detail: string }[];
  idle(): Promise<void>;
  stop(): Promise<void>;
}

export async function startLabConsumer(options: { conn: Connection; brokerUrl: string; password: string; clientId?: string; hooks?: LabConsumerHooks; poisonPolicy?: PoisonLabPolicy;
  metricsSink: MetricSink; realm?: string }): Promise<LabConsumer> {
  const realm = options.realm ?? 'test';
  const store = createMongoBrokerInboxReconciliationStore({ connection: options.conn, prefix: INGEST, realm: realm as never });
  const deps = createLabDeps(options.conn, options.metricsSink, realm);
  const admission = createDurableBrokerAdmissionService({ ...deps, reconciliationStore: store });
  const reconciler = createBrokerInboxReconciler({ realm: realm as never, admission, reconciliationStore: store, reconciliationPolicy: LAB_RECONCILIATION_POLICY,
    receiptedRecoveryPolicy: LAB_RECEIPTED_POLICY, audit: deps.audit, metrics: deps.metrics, alerts: deps.alerts });
  const log: { at: string; detail: string }[] = [], pending = new Set<Promise<void>>(), receipts = new WeakMap<AdapterObservedDelivery, string>();
  const hooks = options.hooks ?? {};
  const processFromRecord = (inboxId: string) => {
    const p = (async () => { await hooks.beforeProcess?.(); await admission.processPersistedBrokerDelivery({ inboxId }); log.push({ at: 'processed', detail: 'ok' }); })()
      .catch(() => { log.push({ at: 'process-failed', detail: 'error' }); });
    pending.add(p); void p.finally(() => pending.delete(p));
  };
  // persist-before-ack: the durable receipt decides the ACK; the pipeline runs only AFTER the ACK was released (QoS 1/2) or at once (QoS 0).
  const handler = async (delivery: AdapterObservedDelivery) => {
    await hooks.beforePersist?.();
    const r = await admission.admit(delivery, { mode: 'persist-only' });
    log.push({ at: 'persist', detail: r.status === 'rejected' ? r.reasonCode : r.status });
    if (r.status === 'persisted') {
      await hooks.afterPersist?.();
      receipts.set(delivery, r.receipt.inboxId);
      if (delivery.brokerObserved.qos === 0) processFromRecord(r.receipt.inboxId);
    }
    return decideBrokerAck(delivery.brokerObserved.qos, r);
  };
  const adapter = createEmqxMqttBrokerAdapter({ brokerUrl: options.brokerUrl, clientId: options.clientId ?? 'lab-consumer-1', username: 'lab-consumer', password: options.password,
    mqttFactory: await loadMqttJsFactory(), poisonPolicy: options.poisonPolicy ?? 'ack-and-drop', metrics: deps.metrics,
    testHooks: { afterAck: delivery => { log.push({ at: 'acked', detail: 'puback-released' }); const id = receipts.get(delivery); if (id !== undefined) processFromRecord(id); } } });
  await adapter.start(handler);
  return { adapter, admission, reconciler, store, log,
    async idle() { while (pending.size > 0) await Promise.allSettled([...pending]); },
    async stop() { await adapter.stop(); } };
}
