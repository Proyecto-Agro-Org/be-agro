import { z } from 'zod';
import { catalogueRealmSchema } from '../auth/identity-catalogue.schemas.js';
import { isBlockingPlaceholder } from '../adapters/ingestion-production-placeholders.js';
import { brokerContextFingerprint, brokerProvenanceFingerprint, payloadSha256 } from '../iot/broker-fingerprints.js';
import { parseBrokerPayload, payloadLimitsSchema } from '../iot/broker-payload.parser.js';
import { classifyIngestionFailure } from '../iot/ingestion-failure-classification.js';
import { emitAlert, emitMetric } from '../iot/ingestion-observability.js';
import type { AuditAction, IngestionAlertPort, IngestionAuditStore, IngestionMetricsPort } from '../iot/ingestion-operations.contracts.js';
import type {
  BoundaryAdmission, BoundaryRejectionCode, BoundaryResult, BrokerDeliveryContext, DeclaredDeviceEnvelope, DurableAdmissionMode, DurableAdmissionResult,
  DurableBrokerAdmissionDependencies, DurableBrokerAdmissionService, InboxPersistRequest, InboxRecord, MqttBoundaryConfig, MqttBoundaryReadiness,
  MqttIngestionBoundary, MqttIngestionBoundaryDependencies, MqttPayloadLimits, PersistedBrokerDeliveryReceipt,
} from '../iot/mqtt-ingestion-boundary.contracts.js';
import type { VerifiedIngestProvenance } from '../iot/protected-ingest.contracts.js';
import type { TrustGateRealm } from '../iot/trust-gate.contracts.js';
import { runBounded } from './authority-call.js';
import { createIngestionOperationsBootstrap, describeOperationsReadiness } from './ingestion-operations.service.js';

export { brokerContextFingerprint } from '../iot/broker-fingerprints.js';

// BE13-11A — MQTT ingestion boundary (OFFLINE, callable; no connection, subscription, credentials or TLS).
// raw delivery → structural validation → provenance verification (authentication) → identity mapping (authorization)
// → technical normalization → BE13-02 mapper → BE13-03 … BE13-10B (persistence, retry, quarantine, operations).
// The boundary OWNS provenance: the ingestion root it composes accepts ONLY evidence objects this boundary issued.
// BE13-11B — persist-before-ingest: the persisted instant BE13-04 requires exists ONLY because the Durable Broker Inbox
// wrote the exact verified bytes (majority + journal) and the store assigned it. A delivery cannot declare it.

const safeRef = z.string().min(1).max(128).regex(/^[A-Za-z0-9:_./@-]+$/);
const technicalId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/);
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const instant = z.number().int().min(0).max(8.64e15);
const topic = z.string().min(1).max(1024).refine(t => !/[+#\u0000]/.test(t));
const fieldKey = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const qosSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);
const packetIdSchema = z.number().int().min(1).max(65535).nullable();
const inboxIdSchema = z.string().regex(/^ib_[0-9a-f]{32}$/);
// CLOSED: no rawPersistedAt (BE13-11B), no verified/trusted/authenticated flags.
const observedSchema = z.object({
  connectionReference: safeRef, authenticatedPrincipalReference: safeRef.nullable(), mqttClientId: technicalId, topic, qos: qosSchema, retain: z.boolean(),
  packetId: packetIdSchema, receivedAt: instant,
}).strict();
const rawSchema = z.object({ brokerObserved: observedSchema, payload: z.instanceof(Uint8Array) }).strict();
const configSchema = z.object({
  topicRoutes: z.array(z.object({ prefix: z.string().min(1).max(256).refine(p => !/[+#\u0000]/.test(p)), messageType: z.literal('telemetry') }).strict()).max(64),
  retained: z.enum(['block', 'accept']),
  fields: z.array(fieldKey).max(64).refine(f => new Set(f).size === f.length),
  verifierTimeoutMs: z.number().int().min(1).max(60_000),
  auditVerifiedDeliveries: z.boolean(),
}).strict();
const verificationSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('VERIFIED'), realm: catalogueRealmSchema, principalReference: safeRef, contextFingerprint: hex64,
    authentication: z.literal('broker-confirmed'), verifiedAt: instant, verifierRevision: revision }).strict(),
  z.object({ status: z.literal('UNVERIFIED'), realm: catalogueRealmSchema, reason: z.enum(['not-authenticated', 'principal-unknown', 'not-authorized']), verifierRevision: revision }).strict(),
  z.object({ status: z.literal('REJECTED'), realm: catalogueRealmSchema, reason: z.enum(['principal-mismatch', 'context-mismatch', 'policy-violation']), verifierRevision: revision }).strict(),
]);
const identitySchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('mapped'), realm: catalogueRealmSchema, principalReference: safeRef, sourceId: technicalId,
    technicalDeviceKey: z.object({ kind: z.literal('mqtt-clientid'), value: technicalId }).strict(), mappingRevision: revision }).strict(),
  z.object({ status: z.literal('unknown'), realm: catalogueRealmSchema }).strict(),
]);
// Store answers are validated like any other authority answer.
const receiptSchema = z.object({ inboxId: inboxIdSchema, realm: catalogueRealmSchema, rawPersistedAt: instant, rawPayloadSha256: hex64,
  rawPayloadBytes: z.number().int().min(0), provenanceFingerprint: hex64 }).strict();
const recordSchema = z.object({ eventId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/).nullable().default(null), inboxId: inboxIdSchema, realm: catalogueRealmSchema, sourceId: technicalId, principalReference: safeRef, technicalDeviceKey: technicalId,
  connectionReference: safeRef, mqttClientId: technicalId, topic, qos: qosSchema, retain: z.boolean(), packetId: packetIdSchema, receivedAt: instant, verifiedAt: instant,
  rawPersistedAt: instant, verifierRevision: revision, mappingRevision: revision, contextFingerprint: hex64, rawPayloadSha256: hex64, provenanceFingerprint: hex64,
  rawPayload: z.instanceof(Uint8Array), rawPayloadBytes: z.number().int().min(0) }).strict();

const AUDIT_BY_CODE: Partial<Record<BoundaryRejectionCode, AuditAction>> = {
  'broker-context-malformed': 'broker-delivery-malformed', 'payload-too-large': 'broker-delivery-malformed', 'payload-invalid-utf8': 'broker-delivery-malformed',
  'payload-malformed': 'broker-delivery-malformed', 'payload-dangerous-key': 'broker-delivery-malformed', 'payload-limits-exceeded': 'broker-delivery-malformed',
  'topic-not-routed': 'broker-delivery-malformed', 'no-configured-field': 'broker-delivery-malformed',
  'broker-provenance-unverified': 'broker-provenance-rejected', 'broker-provenance-rejected': 'broker-provenance-rejected', 'broker-principal-unknown': 'broker-provenance-rejected',
  'broker-realm-mismatch': 'broker-provenance-rejected', 'broker-context-mismatch': 'broker-provenance-rejected', 'invalid-authority-response': 'broker-provenance-rejected',
  'broker-verifier-unavailable': 'broker-verifier-unavailable', 'technical-identity-mismatch': 'technical-identity-mismatch',
};
const PROVENANCE_OUTCOME: Partial<Record<BoundaryRejectionCode, string>> = {
  'broker-provenance-unverified': 'unverified', 'broker-principal-unknown': 'unverified', 'broker-provenance-rejected': 'rejected', 'broker-realm-mismatch': 'rejected',
  'broker-context-mismatch': 'rejected', 'invalid-authority-response': 'rejected', 'broker-verifier-unavailable': 'unavailable',
};
const AUDIT_TIMEOUT_MS = 5_000;
const INBOX_OPERATION_BOUND_MS = 15_000; // operational ceiling for one inbox call (not an SLO; the store has its own wtimeout/maxTimeMS)
const freeze = <T>(v: T): T => Object.freeze(v);
type Rejected = Extract<BoundaryResult, { status: 'rejected' }>;
type Ingested = Extract<BoundaryResult, { status: 'ingested' }>;
type Provenance = Ingested['provenance'];
interface VerifiedDelivery {
  readonly observed: BrokerDeliveryContext; readonly bytes: Uint8Array; readonly payloadFingerprint: string; readonly contextFingerprint: string;
  readonly declared: DeclaredDeviceEnvelope; readonly principalReference: string; readonly verifiedAt: number; readonly verifierRevision: number;
  readonly sourceId: string; readonly key: string; readonly mappingRevision: number; readonly fields: readonly string[];
}

async function bounded<S extends z.ZodType>(schema: S, operation: () => unknown, timeoutMs: number): Promise<{ ok: true; value: z.output<S> } | { ok: false; reason: 'unavailable' | 'malformed' }> {
  let raw: unknown;
  try { raw = await runBounded(operation, timeoutMs); } catch { return { ok: false, reason: 'unavailable' }; }
  try { const parsed = schema.safeParse(raw); return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reason: 'malformed' }; }
  catch { return { ok: false, reason: 'malformed' }; } // hostile getters on the answer
}

const BOUNDARY_REQUIREMENTS: ReadonlyArray<readonly [string, string | null]> = [
  ['brokerProvenanceVerifier', 'verify'], ['brokerIdentityMapping', 'resolve'], ['payloadLimits', null], ['boundaryConfig', null],
];
const LIMITATIONS = ['BROKER_AUTHENTICATION_MECHANISM_PENDING', 'BROKER_IDENTITY_SOURCE_PENDING', 'TOPIC_ACL_PENDING', 'PAYLOAD_LIMITS_PENDING',
  'RETAINED_POLICY_PENDING', 'VERIFIER_TIMEOUT_PENDING', 'PROVENANCE_NOT_REVALIDATED_BEFORE_PERSISTENCE', 'NO_BROKER_CONNECTION', 'NO_HARDWARE_ATTESTATION'] as const;

function dependencyStatus(deps: Record<string, unknown>, name: string, method: string | null, schema?: z.ZodType): 'MISSING' | 'BLOCKED' | 'INJECTED_UNVERIFIED' {
  let v: unknown, present = false;
  try {
    v = deps[name];
    present = method !== null ? typeof v === 'object' && v !== null && method.split(',').every(m => typeof (v as Record<string, unknown>)[m] === 'function')
      : schema!.safeParse(v).success;
  } catch { present = false; }
  return !present ? 'MISSING' : isBlockingPlaceholder(v) ? 'BLOCKED' : 'INJECTED_UNVERIFIED';
}

export function describeMqttBoundaryReadiness(input: unknown): MqttBoundaryReadiness {
  const deps = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const dependencies: Record<string, 'MISSING' | 'BLOCKED' | 'INJECTED_UNVERIFIED'> = {};
  for (const [name, method] of BOUNDARY_REQUIREMENTS) dependencies[name] = dependencyStatus(deps, name, method, name === 'payloadLimits' ? payloadLimitsSchema : configSchema);
  // The pipeline's provenance verifier is always the boundary's own (never injected): readiness evaluates the rest.
  let operations;
  try { operations = describeOperationsReadiness({ ...deps, provenanceVerifier: { verify: () => null } }); }
  catch { operations = describeOperationsReadiness({}); }
  const boundaryTestReady = operations.operationsTestReady && Object.values(dependencies).every(s => s === 'INJECTED_UNVERIFIED');
  return freeze({ boundaryTestReady, productionReady: false as const, dependencies: freeze(dependencies), operations, limitations: freeze([...LIMITATIONS]) });
}

// BE13-11B: the durable admission additionally needs the inbox.
export function describeDurableAdmissionReadiness(input: unknown): MqttBoundaryReadiness {
  const deps = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const base = describeMqttBoundaryReadiness(input);
  const durableInbox = dependencyStatus(deps, 'durableInbox', 'persistVerifiedDelivery,getById,ping');
  return freeze({ ...base, boundaryTestReady: base.boundaryTestReady && durableInbox === 'INJECTED_UNVERIFIED', dependencies: freeze({ ...base.dependencies, durableInbox }),
    limitations: freeze([...LIMITATIONS, 'INBOX_RETENTION_PENDING', 'INBOX_REVOCATION_SEMANTICS_PENDING', 'NO_INBOX_WORKER', 'RAW_PAYLOAD_PRIVACY_CLASSIFICATION_PENDING']) });
}

// ---------------------------------------------------------------- shared core
function createBoundaryCore(deps: MqttIngestionBoundaryDependencies) {
  if (typeof deps !== 'object' || deps === null) throw new TypeError('MQTT boundary dependencies required');
  // The boundary owns provenance. An injected pipeline verifier would be a bypass: refused.
  if (Object.hasOwn(deps, 'provenanceVerifier')) throw new TypeError('The MQTT boundary owns provenance: provenanceVerifier must not be injected');
  if (typeof deps.brokerProvenanceVerifier?.verify !== 'function') throw new TypeError('Missing boundary dependency: brokerProvenanceVerifier');
  if (typeof deps.brokerIdentityMapping?.resolve !== 'function') throw new TypeError('Missing boundary dependency: brokerIdentityMapping');
  if (typeof deps.payloadLimits !== 'object' || deps.payloadLimits === null) throw new TypeError('Missing boundary dependency: payloadLimits');
  if (typeof deps.boundaryConfig !== 'object' || deps.boundaryConfig === null) throw new TypeError('Missing boundary dependency: boundaryConfig');

  // Evidence issued by THIS boundary only. The pipeline verifier is a lookup in a private WeakMap.
  const issued = new WeakMap<object, VerifiedIngestProvenance>();
  const boundaryProvenanceVerifier = freeze({ verify: (evidence: unknown) => (typeof evidence === 'object' && evidence !== null ? issued.get(evidence) ?? null : null) });
  const boot = createIngestionOperationsBootstrap({ ...deps, provenanceVerifier: boundaryProvenanceVerifier } as never);
  const realm = boot.realm;
  const verifier = deps.brokerProvenanceVerifier, mapping = deps.brokerIdentityMapping;
  const audit: IngestionAuditStore = deps.audit, metrics: IngestionMetricsPort = deps.metrics, alerts: IngestionAlertPort = deps.alerts;
  // Configuration is snapshotted ONCE (validated copies). Placeholders or invalid values leave the boundary unconfigured.
  const parsedConfig = !isBlockingPlaceholder(deps.boundaryConfig) ? configSchema.safeParse(deps.boundaryConfig) : null;
  const parsedLimits = !isBlockingPlaceholder(deps.payloadLimits) ? payloadLimitsSchema.safeParse(deps.payloadLimits) : null;
  const config: MqttBoundaryConfig | null = parsedConfig?.success ? freeze({ ...parsedConfig.data, topicRoutes: freeze(parsedConfig.data.topicRoutes.map(r => freeze({ ...r }))),
    fields: freeze([...parsedConfig.data.fields]) }) : null;
  const limits: MqttPayloadLimits | null = parsedLimits?.success ? freeze({ ...parsedLimits.data }) : null;

  async function auditBestEffort(action: AuditAction, outcome: string, eventId: string | null) {
    try {
      await runBounded(() => audit.append(freeze({ realm, quarantineId: null, eventId, action, actorId: 'broker-boundary', actorCapabilities: freeze([]),
        outcome, reasonCode: outcome, evidence: null })), AUDIT_TIMEOUT_MS);
    } catch { /* best effort: never changes a durable fact or an ingestion result */ }
  }
  async function reject(reasonCode: BoundaryRejectionCode, payloadFingerprint: string | null, eventId: string | null): Promise<Rejected> {
    const cls = classifyIngestionFailure(reasonCode, null);
    await emitMetric(metrics, 'mqtt_boundary_rejected_total', { stage: 'boundary', reasonCode, retryClass: cls.retryClass });
    await emitMetric(metrics, 'broker_delivery_total', { stage: 'boundary', outcome: 'rejected' });
    const provenanceOutcome = PROVENANCE_OUTCOME[reasonCode];
    if (provenanceOutcome) await emitMetric(metrics, 'provenance_result_total', { stage: 'boundary', outcome: provenanceOutcome });
    const action = AUDIT_BY_CODE[reasonCode];
    if (action) await auditBestEffort(action, reasonCode, eventId);
    if (reasonCode === 'broker-verifier-unavailable') await emitAlert(alerts, { type: 'BROKER_VERIFIER_UNAVAILABLE', severity: 'WARNING', reasonCode });
    if (reasonCode === 'technical-identity-mismatch') await emitAlert(alerts, { type: 'TECHNICAL_IDENTITY_MISMATCH', severity: 'CRITICAL', reasonCode });
    // The class comes ONLY from the closed classification: nothing in the delivery can make a rejection retryable.
    return freeze({ status: 'rejected' as const, reasonCode, retryClass: cls.retryClass, retryable: cls.retryable, payloadFingerprint });
  }

  // Delivery-independent checks on already-parsed claims (shared by the live and the recovery paths).
  function claimsMatch(declared: DeclaredDeviceEnvelope, key: string): boolean {
    const claims = [declared.clientid, ...['clientid', 'clientId', 'client_id'].filter(k => Object.hasOwn(declared.payload, k)).map(k => declared.payload[k])];
    return claims.every(c => c === undefined || c === key);
  }
  const routed = (topicValue: string, declared: DeclaredDeviceEnvelope) => config!.topicRoutes.some(r => topicValue.startsWith(r.prefix) && r.messageType === declared.mqtt.messageType);
  const fieldsOf = (declared: DeclaredDeviceEnvelope) => freeze(config!.fields.filter(f => Object.hasOwn(declared.payload, f)));

  async function verifyDelivery(raw: unknown): Promise<VerifiedDelivery | Rejected> {
    if (!config || !limits) return reject('boundary-not-configured', null, null);
    // 1. Structural validation of the delivery (closed): extra keys such as trusted/verified/realm/rawPersistedAt make it malformed.
    let observed: BrokerDeliveryContext, bytes: Uint8Array;
    try {
      const parsed = rawSchema.safeParse(raw);
      if (!parsed.success) return reject('broker-context-malformed', null, null);
      observed = freeze({ ...parsed.data.brokerObserved });
      bytes = Uint8Array.from(parsed.data.payload); // private copy: the caller cannot change the bytes after verification
    } catch { return reject('broker-context-malformed', null, null); }
    // 2. Payload: size → UTF-8 → JSON → dangerous keys → limits → closed envelope.
    const parsed = parseBrokerPayload(bytes, limits);
    if (!parsed.ok) return reject(parsed.reasonCode, parsed.payloadFingerprint, null);
    const declared = parsed.envelope, fingerprint = parsed.payloadFingerprint;
    // 3. Delivery policy: retained blocked unless explicitly accepted; the topic is routing only.
    if (observed.retain && config.retained !== 'accept') return reject('retained-message-blocked', fingerprint, declared.eventId);
    if (!routed(observed.topic, declared)) return reject('topic-not-routed', fingerprint, declared.eventId);
    // 4. Provenance (authentication of THIS delivery). Realm comes from the bootstrap, never from the delivery.
    if (observed.authenticatedPrincipalReference === null) return reject('broker-provenance-unverified', fingerprint, declared.eventId);
    const contextFingerprint = brokerContextFingerprint(realm, observed, fingerprint);
    const v = await bounded(verificationSchema, () => verifier.verify(freeze({ realm, brokerObserved: observed, contextFingerprint })), config.verifierTimeoutMs);
    if (!v.ok) return reject(v.reason === 'unavailable' ? 'broker-verifier-unavailable' : 'invalid-authority-response', fingerprint, declared.eventId);
    if (v.value.realm !== realm) return reject('broker-realm-mismatch', fingerprint, declared.eventId);
    if (v.value.status === 'UNVERIFIED') return reject(v.value.reason === 'principal-unknown' ? 'broker-principal-unknown' : 'broker-provenance-unverified', fingerprint, declared.eventId);
    if (v.value.status === 'REJECTED') return reject('broker-provenance-rejected', fingerprint, declared.eventId);
    const verification = v.value;
    if (verification.contextFingerprint !== contextFingerprint || verification.principalReference !== observed.authenticatedPrincipalReference)
      return reject('broker-context-mismatch', fingerprint, declared.eventId);
    // 5. Identity mapping (authorization): sourceId and the authorized technical key come from here, never from the payload.
    const m = await bounded(identitySchema, () => mapping.resolve(freeze({ realm, principalReference: verification.principalReference })), config.verifierTimeoutMs);
    if (!m.ok) return reject(m.reason === 'unavailable' ? 'broker-verifier-unavailable' : 'invalid-authority-response', fingerprint, declared.eventId);
    if (m.value.realm !== realm) return reject('broker-realm-mismatch', fingerprint, declared.eventId);
    if (m.value.status === 'unknown') return reject('broker-principal-unknown', fingerprint, declared.eventId);
    const identity = m.value;
    if (identity.principalReference !== verification.principalReference) return reject('broker-context-mismatch', fingerprint, declared.eventId);
    // 6. Technical identity: the connection must use the key this principal is authorized for; every device CLAIM must match it.
    const key = identity.technicalDeviceKey.value;
    if (observed.mqttClientId !== key || !claimsMatch(declared, key)) return reject('technical-identity-mismatch', fingerprint, declared.eventId);
    const fields = fieldsOf(declared);
    if (fields.length === 0) return reject('no-configured-field', fingerprint, declared.eventId);
    await emitMetric(metrics, 'provenance_result_total', { stage: 'boundary', outcome: 'verified' });
    if (config.auditVerifiedDeliveries) await auditBestEffort('broker-provenance-verified', 'verified', declared.eventId);
    return freeze({ observed, bytes, payloadFingerprint: fingerprint, contextFingerprint, declared, principalReference: verification.principalReference,
      verifiedAt: verification.verifiedAt, verifierRevision: verification.verifierRevision, sourceId: identity.sourceId, key, mappingRevision: identity.mappingRevision, fields });
  }

  // Technical normalization into the BE13-02 protected document. Identity fields come from verified evidence only;
  // persistedAt ONLY from a durable inbox record (null on the direct path: BE13-04 then blocks).
  function admissionFrom(a: { sourceId: string; key: string; topic: string; receivedAt: number; persistedAt: number | null; declared: DeclaredDeviceEnvelope }) {
    const receivedAt = new Date(a.receivedAt);
    const protectedDocument = freeze({
      sourceId: a.sourceId, operation: 'measurement' as const, eventId: a.declared.eventId, clientid: a.key, _receivedAt: receivedAt,
      ...(a.persistedAt === null ? {} : { persistedAt: new Date(a.persistedAt) }),
      _payload: freeze({ ...a.declared.payload }),
      _provenance: freeze({ serviceAuthenticated: true as const, sourceId: a.sourceId, eventId: a.declared.eventId, technicalClientId: a.key,
        brokerIdentity: 'broker-assertion-config-verified' as const, mqttContext: 'service-declared' as const, topic: a.topic, messageType: 'telemetry' as const,
        dataOriginDeclared: a.declared.mqtt.dataOrigin, physicalMeasurementVerified: false as const, commercialAttribution: false as const,
        deviceTimestamp: a.declared.deviceTimestamp ?? null, brokerDeclaredAt: new Date(a.declared.sentAt), receivedAt }),
    });
    const provenanceEvidence = freeze({});
    issued.set(provenanceEvidence, freeze({ sourceId: a.sourceId, operation: 'telemetry' as const, eventId: a.declared.eventId,
      device: freeze({ kind: 'mqtt-clientid' as const, value: a.key }) }));
    return freeze({ protectedDocument, provenanceEvidence });
  }

  async function ingestFields(admission: { protectedDocument: unknown; provenanceEvidence: object }, fields: readonly string[], eventId: string, payloadFingerprint: string,
    provenance: Provenance, receipt?: PersistedBrokerDeliveryReceipt): Promise<Ingested> {
    const results = [];
    for (const field of fields) results.push(freeze({ field, result: await boot.ingest(admission.protectedDocument, admission.provenanceEvidence, { field }) }));
    await emitMetric(metrics, 'broker_delivery_total', { stage: 'boundary', outcome: 'ingested' });
    return freeze({ status: 'ingested' as const, eventId, payloadFingerprint, provenance, results: freeze(results), ...(receipt ? { receipt } : {}) });
  }

  return { realm, boot, config, limits, audit, metrics, alerts, reject, auditBestEffort, verifyDelivery, admissionFrom, ingestFields, claimsMatch, routed, fieldsOf };
}

// ---------------------------------------------------------------- BE13-11A direct boundary (NOT durable)
// Kept for callers that only need verification; it has no persisted instant, so BE13-04 blocks every measurement it submits.
export function createMqttIngestionBoundary(deps: MqttIngestionBoundaryDependencies): MqttIngestionBoundary {
  const core = createBoundaryCore(deps);
  const readiness = describeMqttBoundaryReadiness(deps);
  const provenanceOf = (v: VerifiedDelivery): Provenance => freeze({ sourceId: v.sourceId, principalReference: v.principalReference, contextFingerprint: v.contextFingerprint,
    verifierRevision: v.verifierRevision, mappingRevision: v.mappingRevision });
  async function deliver(raw: unknown): Promise<BoundaryResult> {
    const v = await core.verifyDelivery(raw);
    if ('status' in v) return v;
    const admission = core.admissionFrom({ sourceId: v.sourceId, key: v.key, topic: v.observed.topic, receivedAt: v.observed.receivedAt, persistedAt: null, declared: v.declared });
    return core.ingestFields(admission, v.fields, v.declared.eventId, v.payloadFingerprint, provenanceOf(v));
  }
  async function admitForReplay(raw: unknown): Promise<BoundaryAdmission> {
    const v = await core.verifyDelivery(raw);
    if ('status' in v) return v;
    const a = core.admissionFrom({ sourceId: v.sourceId, key: v.key, topic: v.observed.topic, receivedAt: v.observed.receivedAt, persistedAt: null, declared: v.declared });
    return freeze({ status: 'admitted' as const, ...a, fields: v.fields });
  }
  return freeze({ realm: core.realm, deliver, admitForReplay, operations: core.boot.operations, readiness });
}

// ---------------------------------------------------------------- BE13-11B durable admission (persist-before-ingest)
export function createDurableBrokerAdmissionService(deps: DurableBrokerAdmissionDependencies): DurableBrokerAdmissionService {
  const inbox = deps?.durableInbox;
  if (typeof inbox?.persistVerifiedDelivery !== 'function' || typeof inbox?.getById !== 'function' || typeof inbox?.ping !== 'function')
    throw new TypeError('Missing durable admission dependency: durableInbox');
  const rstore = deps.reconciliationStore;
  if (rstore !== undefined && (typeof rstore.markReceipted !== 'function' || typeof rstore.completeFromReceipt !== 'function')) throw new TypeError('Invalid dependency: reconciliationStore');
  const core = createBoundaryCore(deps);
  const realm = core.realm, metrics = core.metrics, alerts = core.alerts;
  const readiness = describeDurableAdmissionReadiness(deps);
  // BE13-11C markers (best-effort: a lost marker only makes the record a CANDIDATE; reconciliation is idempotent downstream).
  const markReceipted = async (inboxId: string) => { if (rstore) { try { await runBounded(() => rstore.markReceipted(freeze({ realm, inboxId })), INBOX_OPERATION_BOUND_MS); } catch { /* candidate */ } } };
  const markCompleted = async (inboxId: string) => { if (rstore) { try { await runBounded(() => rstore.completeFromReceipt(freeze({ realm, inboxId })), INBOX_OPERATION_BOUND_MS); } catch { /* candidate */ } } };

  async function inboxRejection(reasonCode: 'broker-inbox-unavailable' | 'broker-inbox-not-found' | 'broker-inbox-integrity-failed', phase: 'persist' | 'recovery',
    payloadFingerprint: string | null, eventId: string | null): Promise<Rejected> {
    if (phase === 'persist') {
      await emitMetric(metrics, 'broker_inbox_persist_total', { stage: 'boundary', outcome: 'failed', reasonCode });
      await emitAlert(alerts, { type: 'BROKER_INBOX_PERSISTENCE_UNAVAILABLE', severity: 'CRITICAL', reasonCode });
    } else {
      await emitMetric(metrics, 'broker_inbox_recovery_total', { stage: 'boundary', outcome: reasonCode === 'broker-inbox-unavailable' ? 'failed' : 'rejected', reasonCode });
      if (reasonCode === 'broker-inbox-integrity-failed') {
        await emitMetric(metrics, 'broker_inbox_integrity_failure_total', { stage: 'boundary', reasonCode });
        await emitAlert(alerts, { type: 'BROKER_INBOX_INTEGRITY_FAILURE', severity: 'CRITICAL', reasonCode });
        await core.auditBestEffort('inbox-integrity-failed', reasonCode, eventId);
      } else {
        if (reasonCode === 'broker-inbox-unavailable') await emitAlert(alerts, { type: 'BROKER_INBOX_RECOVERY_FAILURE', severity: 'WARNING', reasonCode });
        await core.auditBestEffort('inbox-recovery-rejected', reasonCode, eventId);
      }
    }
    return core.reject(reasonCode, payloadFingerprint, eventId);
  }

  // ONE integrity path for recovery AND replay: the record is the only input; its bytes, context and provenance must still be
  // exactly what was verified (all recomputed, never trusted as stored), then re-checked against the current configuration.
  type Loaded = { ok: true; record: InboxRecord; declared: DeclaredDeviceEnvelope; fields: readonly string[] } | { ok: false; rejection: Rejected };
  async function loadVerifiedRecord(inboxIdRaw: unknown): Promise<Loaded> {
    const fail = async (p: Promise<Rejected>) => ({ ok: false as const, rejection: await p });
    if (!core.config || !core.limits) return fail(core.reject('boundary-not-configured', null, null));
    const id = inboxIdSchema.safeParse(inboxIdRaw);
    if (!id.success) return fail(inboxRejection('broker-inbox-not-found', 'recovery', null, null));
    await core.auditBestEffort('inbox-recovery-started', 'started', null);
    let raw: unknown;
    try { raw = await runBounded(() => inbox.getById(freeze({ realm, inboxId: id.data })), INBOX_OPERATION_BOUND_MS); }
    catch { return fail(inboxRejection('broker-inbox-unavailable', 'recovery', null, null)); }
    if (raw === null) return fail(inboxRejection('broker-inbox-not-found', 'recovery', null, null));
    let record: InboxRecord;
    try {
      const parsed = recordSchema.safeParse(raw);
      if (!parsed.success) return fail(inboxRejection('broker-inbox-integrity-failed', 'recovery', null, null));
      record = freeze({ ...parsed.data, rawPayload: Uint8Array.from(parsed.data.rawPayload) });
    } catch { return fail(inboxRejection('broker-inbox-integrity-failed', 'recovery', null, null)); }
    const sha = payloadSha256(record.rawPayload);
    const contextFingerprint = brokerContextFingerprint(realm, { connectionReference: record.connectionReference, authenticatedPrincipalReference: record.principalReference,
      mqttClientId: record.mqttClientId, topic: record.topic, qos: record.qos, retain: record.retain, packetId: record.packetId, receivedAt: record.receivedAt }, record.rawPayloadSha256);
    const provenanceFingerprint = brokerProvenanceFingerprint({ realm, sourceId: record.sourceId, principalReference: record.principalReference,
      technicalDeviceKey: record.technicalDeviceKey, connectionReference: record.connectionReference, contextFingerprint: record.contextFingerprint,
      rawPayloadSha256: record.rawPayloadSha256, verifiedAt: record.verifiedAt, verifierRevision: record.verifierRevision, mappingRevision: record.mappingRevision });
    if (record.realm !== realm || record.inboxId !== id.data || sha !== record.rawPayloadSha256 || record.rawPayloadBytes !== record.rawPayload.byteLength ||
      contextFingerprint !== record.contextFingerprint || provenanceFingerprint !== record.provenanceFingerprint)
      return fail(inboxRejection('broker-inbox-integrity-failed', 'recovery', null, null));
    // The stored bytes are re-parsed under the CURRENT limits and re-checked against the stored identity (no new payload accepted).
    const parsed = parseBrokerPayload(record.rawPayload, core.limits);
    if (!parsed.ok) { await core.auditBestEffort('inbox-recovery-rejected', parsed.reasonCode, null); return fail(core.reject(parsed.reasonCode, parsed.payloadFingerprint, null)); }
    const declared = parsed.envelope;
    if (record.retain && core.config.retained !== 'accept') return fail(core.reject('retained-message-blocked', sha, declared.eventId));
    if (!core.routed(record.topic, declared)) return fail(core.reject('topic-not-routed', sha, declared.eventId));
    if (record.mqttClientId !== record.technicalDeviceKey || !core.claimsMatch(declared, record.technicalDeviceKey)) return fail(core.reject('technical-identity-mismatch', sha, declared.eventId));
    const fields = core.fieldsOf(declared);
    if (fields.length === 0) return fail(core.reject('no-configured-field', sha, declared.eventId));
    return { ok: true, record, declared, fields };
  }
  const admissionOf = (l: Extract<Loaded, { ok: true }>) => core.admissionFrom({ sourceId: l.record.sourceId, key: l.record.technicalDeviceKey, topic: l.record.topic,
    receivedAt: l.record.receivedAt, persistedAt: l.record.rawPersistedAt, declared: l.declared });

  async function processRecord(inboxIdRaw: unknown, knownReceipt?: PersistedBrokerDeliveryReceipt): Promise<Rejected | Ingested> {
    const loaded = await loadVerifiedRecord(inboxIdRaw);
    if (!loaded.ok) return loaded.rejection;
    const { record, declared, fields } = loaded;
    const receipt = knownReceipt ?? freeze({ inboxId: record.inboxId, realm, rawPersistedAt: record.rawPersistedAt, rawPayloadSha256: record.rawPayloadSha256,
      rawPayloadBytes: record.rawPayloadBytes, provenanceFingerprint: record.provenanceFingerprint });
    const result = await core.ingestFields(admissionOf(loaded), fields, declared.eventId, record.rawPayloadSha256, freeze({ sourceId: record.sourceId,
      principalReference: record.principalReference, contextFingerprint: record.contextFingerprint, verifierRevision: record.verifierRevision,
      mappingRevision: record.mappingRevision }), receipt);
    // BE13-11E (F-E1): only mark the receipt `completed` when every field ended as a measurement, a duplicate or an OPEN quarantine entry.
    // An `uncertain` result means NOTHING was recorded (measurement and quarantine both unavailable): the record must stay `receipted`
    // so the receipted recovery can retry it. Marking it completed would make the event unrecoverable.
    if (result.results.every(r => r.result.status !== 'uncertain')) await markCompleted(record.inboxId);
    await core.auditBestEffort('inbox-processed', 'processed', declared.eventId);
    await emitMetric(metrics, 'broker_inbox_recovery_total', { stage: 'boundary', outcome: 'processed' });
    return result;
  }

  async function admit(raw: unknown, options: { readonly mode: DurableAdmissionMode }): Promise<DurableAdmissionResult> {
    const mode = (options as { mode?: unknown } | undefined)?.mode;
    if (mode !== 'persist-only' && mode !== 'persist-and-process') return core.reject('broker-context-malformed', null, null);
    // 1-6. Verification. Security rejections and transient verifier failures are NOT persisted (anti-flood; see ADR).
    const v = await core.verifyDelivery(raw);
    if ('status' in v) return v;
    // 7. Durable write of the EXACT verified bytes + observed facts + verified identity.
    const request: InboxPersistRequest = freeze({ eventId: v.declared.eventId, realm, sourceId: v.sourceId, principalReference: v.principalReference, technicalDeviceKey: v.key,
      connectionReference: v.observed.connectionReference, mqttClientId: v.observed.mqttClientId, topic: v.observed.topic, qos: v.observed.qos, retain: v.observed.retain,
      packetId: v.observed.packetId, receivedAt: v.observed.receivedAt, verifiedAt: v.verifiedAt, verifierRevision: v.verifierRevision, mappingRevision: v.mappingRevision,
      contextFingerprint: v.contextFingerprint, rawPayloadSha256: v.payloadFingerprint, rawPayload: v.bytes });
    const expectedProvenance = brokerProvenanceFingerprint({ realm, sourceId: v.sourceId, principalReference: v.principalReference, technicalDeviceKey: v.key,
      connectionReference: v.observed.connectionReference, contextFingerprint: v.contextFingerprint, rawPayloadSha256: v.payloadFingerprint, verifiedAt: v.verifiedAt,
      verifierRevision: v.verifierRevision, mappingRevision: v.mappingRevision });
    let receipt: PersistedBrokerDeliveryReceipt;
    try {
      const r = receiptSchema.safeParse(await runBounded(() => inbox.persistVerifiedDelivery(request), INBOX_OPERATION_BOUND_MS));
      if (!r.success || r.data.realm !== realm || r.data.rawPayloadSha256 !== v.payloadFingerprint || r.data.rawPayloadBytes !== v.bytes.byteLength ||
        r.data.provenanceFingerprint !== expectedProvenance) return inboxRejection('broker-inbox-unavailable', 'persist', v.payloadFingerprint, v.declared.eventId);
      receipt = freeze({ ...r.data });
    } catch { return inboxRejection('broker-inbox-unavailable', 'persist', v.payloadFingerprint, v.declared.eventId); }
    // Not confirmed → never reaches the pipeline (above). Confirmed → audit/metrics are best-effort and cannot undo it.
    await markReceipted(receipt.inboxId);
    await core.auditBestEffort('inbox-persisted', 'persisted', v.declared.eventId);
    await emitMetric(metrics, 'broker_inbox_persist_total', { stage: 'boundary', outcome: 'persisted' });
    if (mode === 'persist-only') return freeze({ status: 'persisted' as const, receipt });
    // 8. Process FROM the persisted record (majority read), exactly as a crash recovery would.
    return processRecord(receipt.inboxId, receipt);
  }

  async function processPersistedBrokerDelivery(input: { readonly inboxId: string }) {
    return processRecord((input as { inboxId?: unknown } | null)?.inboxId);
  }

  async function admitForReplay(input: { readonly inboxId: string }): Promise<BoundaryAdmission> {
    // EXACTLY the recovery integrity path, without ingesting.
    const loaded = await loadVerifiedRecord((input as { inboxId?: unknown } | null)?.inboxId);
    if (!loaded.ok) return loaded.rejection;
    return freeze({ status: 'admitted' as const, ...admissionOf(loaded), fields: loaded.fields });
  }

  return freeze({ realm, admit, processPersistedBrokerDelivery, admitForReplay, operations: core.boot.operations, readiness });
}
