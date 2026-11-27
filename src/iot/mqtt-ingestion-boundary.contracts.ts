// BE13-11A — Broker provenance and the MQTT ingestion boundary (OFFLINE).
// Contracts for a FUTURE broker adapter (EMQX or other). Nothing here connects, subscribes, holds credentials or
// selects an authentication technology. Principle: NOTHING the device controls (payload, topic, MQTT client id,
// declared username/metadata/sourceId) can assert identity, realm, ownership, authenticity or authorization.
import type { TrustGateRealm } from './trust-gate.contracts.js';
import type { IngestionOperations, IngestionOperationsBootstrapDependencies, OperationsReadiness } from './ingestion-operations.contracts.js';
import type { ResilientIngestionResult, RetryClass } from './ingestion-recovery.contracts.js';

// ---------------------------------------------------------------- brokerObserved (facts from the adapter)
// Technical facts the adapter OBSERVED on the broker side. Opaque references only: never passwords, tokens, keys.
export interface BrokerDeliveryContext {
  readonly connectionReference: string;                     // opaque broker connection/session reference
  readonly authenticatedPrincipalReference: string | null;  // opaque; null = the broker reported no authenticated principal
  readonly mqttClientId: string;                            // TECHNICAL connection identity; NEVER a business clientId
  readonly topic: string;                                   // routing data only; never ownership or realm
  readonly qos: 0 | 1 | 2;                                  // delivery guarantee observed; never replaces idempotency
  readonly retain: boolean;
  readonly packetId: number | null;                         // technical evidence only; never an event identity
  readonly receivedAt: number;                              // technical delivery instant observed by the adapter (ms)
  // BE13-11B: there is NO rawPersistedAt here. The persisted instant exists only because the Durable Broker Inbox stored the
  // exact bytes (majority + journal) and the store assigned it; a delivery carrying such a field is malformed.
}
export interface RawBrokerDelivery {
  readonly brokerObserved: BrokerDeliveryContext;
  readonly payload: Uint8Array;                             // raw bytes as delivered; parsed by the boundary
}

// ---------------------------------------------------------------- payloadDeclared (claims from the device)
// Everything below is a CLAIM. It never becomes identity, realm, sourceId or authorization by itself.
export interface DeclaredDeviceEnvelope {
  readonly version: 1;
  readonly eventId: string;
  readonly sentAt: number;
  readonly clientid?: string;                               // declared technical key: compared, never trusted
  readonly deviceTimestamp?: string | number | null;
  readonly payload: Readonly<Record<string, number | string | boolean | null>>;
  readonly mqtt: { readonly topic?: string; readonly messageType: 'telemetry'; readonly dataOrigin: 'simulated' | 'physical-unverified' | 'unknown' };
}

// ---------------------------------------------------------------- provenance verifier (authentication)
// VERIFIED means ONLY: the authorized verifier confirmed that THIS delivery (bound by contextFingerprint) came from a
// broker connection authenticated as principalReference. It does NOT mean genuine hardware, a genuine physical sensor,
// true data or final business ownership.
export interface BrokerProvenanceRequest {
  readonly realm: TrustGateRealm;                           // from the bootstrap, never from the delivery
  readonly brokerObserved: BrokerDeliveryContext;           // frozen copy
  readonly contextFingerprint: string;                      // sha256 over the observed context + payload bytes
}
export type BrokerProvenanceVerification =
  | { readonly status: 'VERIFIED'; readonly realm: TrustGateRealm; readonly principalReference: string; readonly contextFingerprint: string;
      readonly authentication: 'broker-confirmed'; readonly verifiedAt: number; readonly verifierRevision: number }
  | { readonly status: 'UNVERIFIED'; readonly realm: TrustGateRealm; readonly reason: 'not-authenticated' | 'principal-unknown' | 'not-authorized'; readonly verifierRevision: number }
  | { readonly status: 'REJECTED'; readonly realm: TrustGateRealm; readonly reason: 'principal-mismatch' | 'context-mismatch' | 'policy-violation'; readonly verifierRevision: number };
export interface BrokerProvenanceVerifier { verify(request: BrokerProvenanceRequest): Promise<BrokerProvenanceVerification> }

// ---------------------------------------------------------------- broker identity mapping (authorization)
// Maps an AUTHENTICATED principal to what it may publish as: the sourceId (from configuration/authorization, never from
// the payload) and the technical device key (the MQTT client id it is authorized to use).
export interface BrokerIdentityRequest { readonly realm: TrustGateRealm; readonly principalReference: string }
export type BrokerIdentityResolution =
  | { readonly status: 'mapped'; readonly realm: TrustGateRealm; readonly principalReference: string; readonly sourceId: string;
      readonly technicalDeviceKey: { readonly kind: 'mqtt-clientid'; readonly value: string }; readonly mappingRevision: number }
  | { readonly status: 'unknown'; readonly realm: TrustGateRealm };
export interface BrokerIdentityMapping { resolve(request: BrokerIdentityRequest): Promise<BrokerIdentityResolution> }

// Assembled by the boundary from the verifier + the mapping (both validated). Not a hardware attestation.
export interface BrokerProvenanceEvidence {
  readonly realm: TrustGateRealm;
  readonly principalReference: string;
  readonly authentication: 'broker-confirmed';
  readonly sourceId: string;
  readonly technicalDeviceKey: { readonly kind: 'mqtt-clientid'; readonly value: string };
  readonly connectionReference: string;
  readonly contextFingerprint: string;
  readonly verifiedAt: number;
  readonly verifierRevision: number;
  readonly mappingRevision: number;
}

// ---------------------------------------------------------------- configuration (no production values chosen)
export interface MqttPayloadLimits { readonly maxBytes: number; readonly maxDepth: number; readonly maxKeys: number; readonly maxStringLength: number }
export interface MqttBoundaryConfig {
  readonly topicRoutes: readonly { readonly prefix: string; readonly messageType: 'telemetry' }[];
  readonly retained: 'block' | 'accept';                    // default conservative: 'block'
  readonly fields: readonly string[];                       // measurement fields extracted per telemetry delivery
  readonly verifierTimeoutMs: number;                       // operational bound, not an SLO
  readonly auditVerifiedDeliveries: boolean;                // volume decision pending; negatives are always audited
}

// ---------------------------------------------------------------- boundary
export type BoundaryRejectionCode =
  | 'boundary-not-configured' | 'broker-context-malformed' | 'payload-too-large' | 'payload-invalid-utf8' | 'payload-malformed'
  | 'payload-dangerous-key' | 'payload-limits-exceeded' | 'retained-message-blocked' | 'topic-not-routed' | 'no-configured-field'
  | 'broker-provenance-unverified' | 'broker-provenance-rejected' | 'broker-principal-unknown' | 'broker-realm-mismatch'
  | 'broker-context-mismatch' | 'broker-verifier-unavailable' | 'invalid-authority-response' | 'technical-identity-mismatch'
  // BE13-11B durable inbox
  | 'broker-inbox-unavailable' | 'broker-inbox-not-found' | 'broker-inbox-integrity-failed';
export type BoundaryResult =
  | { readonly status: 'rejected'; readonly reasonCode: BoundaryRejectionCode; readonly retryClass: RetryClass; readonly retryable: boolean;
      readonly payloadFingerprint: string | null }
  | { readonly status: 'ingested'; readonly eventId: string; readonly payloadFingerprint: string;
      readonly provenance: { readonly sourceId: string; readonly principalReference: string; readonly contextFingerprint: string;
        readonly verifierRevision: number; readonly mappingRevision: number };
      readonly results: readonly { readonly field: string; readonly result: ResilientIngestionResult }[];
      readonly receipt?: PersistedBrokerDeliveryReceipt };
export type BoundaryAdmission =
  | Extract<BoundaryResult, { status: 'rejected' }>
  | { readonly status: 'admitted'; readonly protectedDocument: unknown; readonly provenanceEvidence: object; readonly fields: readonly string[] };

// The boundary OWNS provenance: the ingestion root it composes accepts only evidence the boundary issued.
export interface MqttIngestionBoundaryDependencies extends Omit<IngestionOperationsBootstrapDependencies, 'provenanceVerifier'> {
  readonly brokerProvenanceVerifier: BrokerProvenanceVerifier;
  readonly brokerIdentityMapping: BrokerIdentityMapping;
  readonly payloadLimits: MqttPayloadLimits;
  readonly boundaryConfig: MqttBoundaryConfig;
}
export interface MqttBoundaryReadiness {
  readonly boundaryTestReady: boolean;
  readonly productionReady: false;                          // ALWAYS false
  readonly dependencies: Readonly<Record<string, 'MISSING' | 'BLOCKED' | 'INJECTED_UNVERIFIED'>>;
  readonly operations: OperationsReadiness;
  readonly limitations: readonly string[];
}
import type { BrokerInboxReconciliationStore } from './inbox-reconciliation.contracts.js';
// ---------------------------------------------------------------- BE13-11B durable broker inbox
// Only VERIFIED deliveries reach it (built by the boundary after verification + identity mapping). It stores the EXACT
// bytes; the store generates inboxId and assigns rawPersistedAt server-side ($$NOW) in the durable write.
export interface InboxPersistRequest {
  // BE13-11L: the validated eventId of the VERIFIED delivery (declared by the device, checked by the boundary). Optional only for backward compatibility with callers that
  // predate 11L; the boundary always sends it. The store refuses an eventId that is not the one inside the exact bytes it persists.
  readonly eventId?: string;
  readonly realm: TrustGateRealm;
  readonly sourceId: string;
  readonly principalReference: string;
  readonly technicalDeviceKey: string;
  readonly connectionReference: string;
  readonly mqttClientId: string;
  readonly topic: string;
  readonly qos: 0 | 1 | 2;
  readonly retain: boolean;
  readonly packetId: number | null;
  readonly receivedAt: number;
  readonly verifiedAt: number;
  readonly verifierRevision: number;
  readonly mappingRevision: number;
  readonly contextFingerprint: string;
  readonly rawPayloadSha256: string;
  readonly rawPayload: Uint8Array;
}
export interface InboxRecord extends Omit<InboxPersistRequest, 'eventId'> {
  readonly eventId: string | null;          // BE13-11L: null for LEGACY records written before 11L (never invented)
  readonly inboxId: string;                 // generated by the store; never device-controlled; never the packet id
  readonly rawPersistedAt: number;          // server-assigned ($$NOW) during the durable write; see CONTRATO_BE13_11B_DURABLE_INBOX
  readonly rawPayloadBytes: number;
  readonly provenanceFingerprint: string;
}
export interface PersistedBrokerDeliveryReceipt {
  readonly inboxId: string;
  readonly realm: TrustGateRealm;
  readonly rawPersistedAt: number;
  readonly rawPayloadSha256: string;
  readonly rawPayloadBytes: number;
  readonly provenanceFingerprint: string;
}
// No update, no delete, no TTL: the stored evidence is immutable through this API.
export interface DurableBrokerInbox {
  persistVerifiedDelivery(request: InboxPersistRequest): Promise<PersistedBrokerDeliveryReceipt>;
  getById(request: { readonly realm: TrustGateRealm; readonly inboxId: string }): Promise<InboxRecord | null>;
  ping(): Promise<boolean>;
}
export type DurableAdmissionMode = 'persist-only' | 'persist-and-process';
export type DurableAdmissionResult =
  | Extract<BoundaryResult, { status: 'rejected' }>
  | { readonly status: 'persisted'; readonly receipt: PersistedBrokerDeliveryReceipt }
  | Extract<BoundaryResult, { status: 'ingested' }>;
// BE13-11C: the optional reconciliation store records receipt/completion markers (separate collection; the raw record is untouched).
export interface DurableBrokerAdmissionDependencies extends MqttIngestionBoundaryDependencies {
  readonly durableInbox: DurableBrokerInbox;
  readonly reconciliationStore?: BrokerInboxReconciliationStore;
}
export interface DurableBrokerAdmissionService {
  readonly realm: TrustGateRealm;
  // verify → persist (majority + j) → receipt → (optionally) process FROM the persisted record.
  admit(raw: unknown, options: { readonly mode: DurableAdmissionMode }): Promise<DurableAdmissionResult>;
  // Crash recovery: only realm (bound) + inboxId; uses ONLY the stored bytes. Never accepts a new payload.
  processPersistedBrokerDelivery(input: { readonly inboxId: string }): Promise<Exclude<DurableAdmissionResult, { status: 'persisted' }>>;
  // Operator replay evidence built from a persisted record (same integrity checks).
  admitForReplay(input: { readonly inboxId: string }): Promise<BoundaryAdmission>;
  readonly operations: IngestionOperations;
  readonly readiness: MqttBoundaryReadiness;
}

export interface MqttIngestionBoundary {
  readonly realm: TrustGateRealm;
  deliver(raw: unknown): Promise<BoundaryResult>;
  // Same verification as deliver, without ingesting: the evidence an operator replay (BE13-09/10B) needs.
  admitForReplay(raw: unknown): Promise<BoundaryAdmission>;
  readonly operations: IngestionOperations;
  readonly readiness: MqttBoundaryReadiness;
}
