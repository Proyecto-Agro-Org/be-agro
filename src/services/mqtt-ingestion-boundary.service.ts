import { createHash } from 'node:crypto';
import { z } from 'zod';
import { catalogueRealmSchema } from '../auth/identity-catalogue.schemas.js';
import { isBlockingPlaceholder } from '../adapters/ingestion-production-placeholders.js';
import { parseBrokerPayload, payloadLimitsSchema } from '../iot/broker-payload.parser.js';
import { classifyIngestionFailure } from '../iot/ingestion-failure-classification.js';
import { emitAlert, emitMetric } from '../iot/ingestion-observability.js';
import type { AuditAction, IngestionAuditStore, IngestionMetricsPort, IngestionAlertPort } from '../iot/ingestion-operations.contracts.js';
import type {
  BoundaryAdmission, BoundaryRejectionCode, BoundaryResult, BrokerDeliveryContext, MqttBoundaryConfig, MqttBoundaryReadiness, MqttIngestionBoundary,
  MqttIngestionBoundaryDependencies, MqttPayloadLimits,
} from '../iot/mqtt-ingestion-boundary.contracts.js';
import type { VerifiedIngestProvenance } from '../iot/protected-ingest.contracts.js';
import type { TrustGateRealm } from '../iot/trust-gate.contracts.js';
import { runBounded } from './authority-call.js';
import { createIngestionOperationsBootstrap, describeOperationsReadiness } from './ingestion-operations.service.js';

// BE13-11A — MQTT ingestion boundary (OFFLINE, callable; no connection, subscription, credentials or TLS).
// raw delivery → structural validation → provenance verification (authentication) → identity mapping (authorization)
// → technical normalization → BE13-02 mapper → BE13-03 … BE13-10B (persistence, retry, quarantine, operations).
// The boundary OWNS provenance: the ingestion root it composes is given a provenance verifier that accepts ONLY
// evidence objects this boundary issued after a successful verification. There is no path into the pipeline that
// skips the broker verifier, and nothing device-controlled (payload, topic, MQTT client id) can assert authority.

const safeRef = z.string().min(1).max(128).regex(/^[A-Za-z0-9:_./@-]+$/);
const technicalId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/);
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const revision = z.number().int().min(0);
const instant = z.number().int().min(0).max(8.64e15);
const topic = z.string().min(1).max(1024).refine(t => !/[+#\u0000]/.test(t));
const fieldKey = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const observedSchema = z.object({
  connectionReference: safeRef, authenticatedPrincipalReference: safeRef.nullable(), mqttClientId: technicalId, topic,
  qos: z.union([z.literal(0), z.literal(1), z.literal(2)]), retain: z.boolean(), packetId: z.number().int().min(1).max(65535).nullable(), receivedAt: instant,
  rawPersistedAt: instant.nullable(),
}).strict().refine(o => o.rawPersistedAt === null || o.rawPersistedAt >= o.receivedAt);
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
const freeze = <T>(v: T): T => Object.freeze(v);

// Bound to the realm and to EVERY observed fact plus the exact payload bytes: a verification is valid for this delivery only.
export function brokerContextFingerprint(realm: TrustGateRealm, observed: BrokerDeliveryContext, payloadFingerprint: string): string {
  return createHash('sha256').update(JSON.stringify(['be13-11a/broker-context', realm, observed.connectionReference, observed.authenticatedPrincipalReference,
    observed.mqttClientId, observed.topic, observed.qos, observed.retain, observed.packetId, observed.receivedAt, observed.rawPersistedAt, payloadFingerprint]), 'utf8').digest('hex');
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

export function describeMqttBoundaryReadiness(input: unknown): MqttBoundaryReadiness {
  const deps = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const dependencies: Record<string, 'MISSING' | 'BLOCKED' | 'INJECTED_UNVERIFIED'> = {};
  for (const [name, method] of BOUNDARY_REQUIREMENTS) {
    let v: unknown, present = false;
    try {
      v = deps[name];
      present = method !== null ? typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>)[method] === 'function'
        : (name === 'payloadLimits' ? payloadLimitsSchema : configSchema).safeParse(v).success;
    } catch { present = false; }
    dependencies[name] = !present ? 'MISSING' : isBlockingPlaceholder(v) ? 'BLOCKED' : 'INJECTED_UNVERIFIED';
  }
  // The pipeline's provenance verifier is always the boundary's own (never injected): readiness evaluates the rest.
  let operations;
  try { operations = describeOperationsReadiness({ ...deps, provenanceVerifier: { verify: () => null } }); }
  catch { operations = describeOperationsReadiness({}); }
  const boundaryTestReady = operations.operationsTestReady && Object.values(dependencies).every(s => s === 'INJECTED_UNVERIFIED');
  return freeze({ boundaryTestReady, productionReady: false as const, dependencies: freeze(dependencies), operations,
    limitations: freeze(['BROKER_AUTHENTICATION_MECHANISM_PENDING', 'BROKER_IDENTITY_SOURCE_PENDING', 'TOPIC_ACL_PENDING', 'PAYLOAD_LIMITS_PENDING',
      'RETAINED_POLICY_PENDING', 'VERIFIER_TIMEOUT_PENDING', 'PROVENANCE_NOT_REVALIDATED_BEFORE_PERSISTENCE', 'NO_BROKER_CONNECTION', 'NO_HARDWARE_ATTESTATION']) });
}

export function createMqttIngestionBoundary(deps: MqttIngestionBoundaryDependencies): MqttIngestionBoundary {
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
  // Configuration is snapshotted ONCE (validated copies): later mutation of the injected objects changes nothing.
  // Placeholders or invalid values leave the boundary unconfigured: it admits nothing.
  const parsedConfig = !isBlockingPlaceholder(deps.boundaryConfig) ? configSchema.safeParse(deps.boundaryConfig) : null;
  const parsedLimits = !isBlockingPlaceholder(deps.payloadLimits) ? payloadLimitsSchema.safeParse(deps.payloadLimits) : null;
  const config: MqttBoundaryConfig | null = parsedConfig?.success ? freeze({ ...parsedConfig.data, topicRoutes: freeze(parsedConfig.data.topicRoutes.map(r => freeze({ ...r }))),
    fields: freeze([...parsedConfig.data.fields]) }) : null;
  const limits: MqttPayloadLimits | null = parsedLimits?.success ? freeze({ ...parsedLimits.data }) : null;
  const readiness = describeMqttBoundaryReadiness(deps);

  async function auditBestEffort(action: AuditAction, outcome: string, eventId: string | null) {
    try {
      await runBounded(() => audit.append(freeze({ realm, quarantineId: null, eventId, action, actorId: 'broker-boundary', actorCapabilities: freeze([]),
        outcome, reasonCode: outcome, evidence: null })), AUDIT_TIMEOUT_MS);
    } catch { /* best effort: automatic ingestion never depends on audit */ }
  }
  async function reject(reasonCode: BoundaryRejectionCode, payloadFingerprint: string | null, eventId: string | null): Promise<Extract<BoundaryResult, { status: 'rejected' }>> {
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

  type Admitted = { status: 'admitted'; protectedDocument: unknown; provenanceEvidence: object; fields: readonly string[]; eventId: string; payloadFingerprint: string;
    provenance: Extract<BoundaryResult, { status: 'ingested' }>['provenance'] };

  async function admit(raw: unknown): Promise<Admitted | Extract<BoundaryResult, { status: 'rejected' }>> {
    if (!config || !limits) return reject('boundary-not-configured', null, null);
    // 1. Structural validation of the delivery (closed): extra keys such as trusted/verified/realm make it malformed.
    let observed: BrokerDeliveryContext, bytes: Uint8Array;
    try {
      const parsed = rawSchema.safeParse(raw);
      if (!parsed.success) return reject('broker-context-malformed', null, null);
      observed = freeze({ ...parsed.data.brokerObserved });
      bytes = Uint8Array.from(parsed.data.payload); // private copy: the caller cannot change the bytes after verification
    } catch { return reject('broker-context-malformed', null, null); }
    // 2. Payload: size → UTF-8 → JSON → dangerous keys → limits → closed envelope. Nothing deep before it passes.
    const parsed = parseBrokerPayload(bytes, limits);
    if (!parsed.ok) return reject(parsed.reasonCode, parsed.payloadFingerprint, null);
    const declared = parsed.envelope, fingerprint = parsed.payloadFingerprint;
    // 3. Delivery policy: retained messages are blocked unless explicitly accepted; the topic is routing only.
    if (observed.retain && config.retained !== 'accept') return reject('retained-message-blocked', fingerprint, declared.eventId);
    if (!config.topicRoutes.some(r => observed.topic.startsWith(r.prefix) && r.messageType === declared.mqtt.messageType)) return reject('topic-not-routed', fingerprint, declared.eventId);
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
    // 6. Technical identity: the connection must use the key this principal is authorized for, and every device CLAIM must match it.
    const key = identity.technicalDeviceKey.value;
    const claims = [declared.clientid, ...['clientid', 'clientId', 'client_id'].filter(k => Object.hasOwn(declared.payload, k)).map(k => declared.payload[k])];
    if (observed.mqttClientId !== key || claims.some(c => c !== undefined && c !== key)) return reject('technical-identity-mismatch', fingerprint, declared.eventId);
    const fields = config.fields.filter(f => Object.hasOwn(declared.payload, f));
    if (fields.length === 0) return reject('no-configured-field', fingerprint, declared.eventId);
    // 7. Technical normalization into the BE13-02 protected document: observed facts and declared claims stay in their
    // own places; the document's identity fields come from the verified evidence only.
    const receivedAt = new Date(observed.receivedAt);
    const protectedDocument = freeze({
      sourceId: identity.sourceId, operation: 'measurement' as const, eventId: declared.eventId, clientid: key, _receivedAt: receivedAt,
      ...(observed.rawPersistedAt === null ? {} : { persistedAt: new Date(observed.rawPersistedAt) }),
      _payload: freeze({ ...declared.payload }),
      _provenance: freeze({ serviceAuthenticated: true as const, sourceId: identity.sourceId, eventId: declared.eventId, technicalClientId: key,
        brokerIdentity: 'broker-assertion-config-verified' as const, mqttContext: 'service-declared' as const, topic: observed.topic, messageType: 'telemetry' as const,
        dataOriginDeclared: declared.mqtt.dataOrigin, physicalMeasurementVerified: false as const, commercialAttribution: false as const,
        deviceTimestamp: declared.deviceTimestamp ?? null, brokerDeclaredAt: new Date(declared.sentAt), receivedAt }),
    });
    const provenanceEvidence = freeze({});
    issued.set(provenanceEvidence, freeze({ sourceId: identity.sourceId, operation: 'telemetry' as const, eventId: declared.eventId,
      device: freeze({ kind: 'mqtt-clientid' as const, value: key }) }));
    await emitMetric(metrics, 'provenance_result_total', { stage: 'boundary', outcome: 'verified' });
    if (config.auditVerifiedDeliveries) await auditBestEffort('broker-provenance-verified', 'verified', declared.eventId);
    return freeze({ status: 'admitted' as const, protectedDocument, provenanceEvidence, fields: freeze(fields), eventId: declared.eventId, payloadFingerprint: fingerprint,
      provenance: freeze({ sourceId: identity.sourceId, principalReference: verification.principalReference, contextFingerprint,
        verifierRevision: verification.verifierRevision, mappingRevision: identity.mappingRevision }) });
  }

  async function deliver(raw: unknown): Promise<BoundaryResult> {
    const admitted = await admit(raw);
    if (admitted.status === 'rejected') return admitted;
    const results = [];
    for (const field of admitted.fields) results.push(freeze({ field, result: await boot.ingest(admitted.protectedDocument, admitted.provenanceEvidence, { field }) }));
    await emitMetric(metrics, 'broker_delivery_total', { stage: 'boundary', outcome: 'ingested' });
    return freeze({ status: 'ingested' as const, eventId: admitted.eventId, payloadFingerprint: admitted.payloadFingerprint, provenance: admitted.provenance, results: freeze(results) });
  }

  async function admitForReplay(raw: unknown): Promise<BoundaryAdmission> {
    const a = await admit(raw);
    return a.status === 'rejected' ? a : freeze({ status: 'admitted' as const, protectedDocument: a.protectedDocument, provenanceEvidence: a.provenanceEvidence, fields: a.fields });
  }

  return freeze({ realm, deliver, admitForReplay, operations: boot.operations, readiness });
}
