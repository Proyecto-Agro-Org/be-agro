import type { TrustGateRealm } from './trust-gate.contracts.js';

// BE13-11J — publisher-side end-to-end confirmation (LOCAL prototype, NOT composed in app.ts, NOT enabled in Production).
//
// MQTT PUBACK (BROKER_ACCEPTED) only says the broker accepted the publish. It is never evidence that the backend holds the event.
// INGEST_CONFIRMED is a separate, read-only answer derived from DURABLE backend evidence keyed by (realm, sourceId, eventId):
//   claim       committed idempotency claim (claim + measurement commit in ONE transaction, read with majority)  -> processed
//   inbox       durable raw record of a verified delivery (Durable Inbox)                                          -> received-durable
//   quarantine  controlled quarantine row                                                                          -> quarantined (NOT a success)
// Fail-closed: when the backend cannot demonstrate the state the answer is `pending`; ABSENCE of an error, a previous PUBACK, a timeout or an
// inference is never evidence. Delivery is at-least-once; processing is idempotent; this is NOT exactly-once.

export const INGEST_CONFIRMATION_EVIDENCE_VERSION = 1 as const;

export type IngestConfirmationStatus = 'received-durable' | 'processed' | 'duplicate-confirmed' | 'pending' | 'not-found' | 'quarantined' | 'conflict';
/** The only statuses a publisher may treat as end-to-end success. Everything else (and anything unknown) is NOT success. */
export const CONFIRMED_STATUSES: readonly IngestConfirmationStatus[] = Object.freeze(['received-durable', 'processed', 'duplicate-confirmed']);

// eventId is the reconciliation key: publisher-chosen, stable across retries, independent of the MQTT clientId, and namespaced by the
// AUTHENTICATED sourceId (never taken from the payload or the request) and the realm, so two tenants may even reuse the same text safely.
export const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/;
// BE13-11L: the publisher proves WHICH content it asks about. SHA-256 (lowercase hex) of the exact bytes it published, identical on every retry.
export const PAYLOAD_SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;

/** Authorized scope of the caller. Derived by the server from the authenticated principal, never from the request. */
export interface ConfirmationScope {
  readonly realm: TrustGateRealm; readonly sourceId: string;
  /** BE13-11M: the authenticated principal, so a quarantine row written BEFORE a sourceId was known can still be reconciled by its owner. Never taken from the request. */
  readonly principalReference?: string;
}

export type EvidenceState = 'present' | 'absent' | 'unavailable';
export interface IngestConfirmation {
  readonly eventId: string;
  readonly realm: TrustGateRealm;
  readonly status: IngestConfirmationStatus;
  /** true only for CONFIRMED_STATUSES. */
  readonly confirmed: boolean;
  readonly evidenceVersion: typeof INGEST_CONFIRMATION_EVIDENCE_VERSION;
  readonly evidence: { readonly claim: EvidenceState; readonly inbox: EvidenceState; readonly quarantine: EvidenceState };
  /** BE13-11L: how the asked payloadSha256 relates to the durable records of this eventId. `mismatch` => status `conflict`. */
  readonly payloadHash: 'match' | 'mismatch' | 'unverifiable';
  /** Number of durable inbox records seen for this event (>= 2 means the same event was admitted more than once and resolved idempotently). null when unknown. */
  readonly deliveries: number | null;
  /** Database instant of the durable evidence (claim commit, else inbox persist). null when there is none. */
  readonly durableAt: number | null;
}

// Rows carry their own scope so the service can re-verify it (defence in depth: a store that ever returned a foreign row must not confirm).
export interface ClaimEvidence { readonly realm: TrustGateRealm; readonly sourceId: string; readonly eventId: string; readonly committedAt: number }
export interface InboxEvidence { readonly realm: TrustGateRealm; readonly sourceId: string; readonly eventId: string; readonly persistedAt: number; readonly payloadSha256: string }
export interface QuarantineEvidence {
  readonly realm: TrustGateRealm; readonly sourceId: string | null; readonly eventId: string | null;
  // BE13-11M (new rows only; absent on legacy rows)
  readonly principalReference?: string | null; readonly declaredEventId?: string | null; readonly payloadSha256?: string | null;
}

/** Read-only evidence lookups. Each may reject (store unavailable): the service then answers `pending`, never `confirmed`. */
export interface ConfirmationEvidencePort {
  claims(scope: ConfirmationScope, eventId: string): Promise<readonly ClaimEvidence[]>;
  inbox(scope: ConfirmationScope, eventId: string): Promise<readonly InboxEvidence[]>;
  quarantine(scope: ConfirmationScope, eventId: string, payloadSha256: string): Promise<readonly QuarantineEvidence[]>;
}

export interface IngestConfirmationService {
  /** Never throws for evidence failures; an invalid eventId or scope is a programming error and throws TypeError. */
  confirm(scope: ConfirmationScope, eventId: string, payloadSha256: string): Promise<IngestConfirmation>;
}
