import type {
  IngestProvenanceAuthority,
  ProtectedIngestMapResult,
  ProtectedIngestQuarantineCode,
  ProtectedMeasurementCandidate,
  ProtectedMessageType,
  VerifiedIngestProvenance,
} from './protected-ingest.contracts.js';
import { protectedIngestDocumentSchema, type ProtectedIngestDocument } from './protected-ingest.schemas.js';
import { isIssuedIngestProvenanceAuthority } from './ingest-provenance.authority.js';

const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const quarantined = (reason: ProtectedIngestQuarantineCode): ProtectedIngestMapResult => Object.freeze({ status: 'quarantined', reason });
const plain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function cloneTechnicalValue(value: unknown, depth = 0, budget = { left: 10_000 }): unknown {
  if (--budget.left < 0 || depth > 16) throw new Error('invalid');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('invalid'); return value; }
  if (Array.isArray(value)) return Object.freeze(value.map(item => cloneTechnicalValue(item, depth + 1, budget)));
  if (!plain(value)) throw new Error('invalid');
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.startsWith('$') || key.includes('.') || key.includes('\0') || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('invalid');
    copy[key] = cloneTechnicalValue(item, depth + 1, budget);
  }
  return Object.freeze(copy);
}

function preflight(input: unknown): ProtectedIngestQuarantineCode | null {
  if (!plain(input)) return 'unsupported-document';
  const protectedShape = ['sourceId', 'operation', '_payload', '_provenance'].some(key => hasOwn(input, key));
  if (!protectedShape) return 'unsupported-document';
  if (!hasOwn(input, 'sourceId') || typeof input.sourceId !== 'string' || input.sourceId === '') return 'missing-source';
  if (!hasOwn(input, 'eventId') || typeof input.eventId !== 'string' || input.eventId === '') return 'missing-event-id';
  if (!hasOwn(input, 'clientid') || typeof input.clientid !== 'string' || input.clientid === '') return 'missing-technical-identity';
  if (!['measurement', 'device-status'].includes(String(input.operation))) return 'unsupported-operation';
  if (!plain(input._payload)) return 'invalid-payload';
  const provenance = input._provenance;
  if (plain(provenance)) {
    for (const key of ['brokerDeclaredAt', 'receivedAt']) {
      const value = provenance[key];
      if (!(value instanceof Date) || !Number.isSafeInteger(value.getTime()) || value.getTime() < 0) return 'invalid-timestamp';
    }
  }
  if (!(input._receivedAt instanceof Date) || !Number.isSafeInteger(input._receivedAt.getTime()) || input._receivedAt.getTime() < 0 ||
    (hasOwn(input, 'persistedAt') && (!(input.persistedAt instanceof Date) || !Number.isSafeInteger(input.persistedAt.getTime()) || input.persistedAt.getTime() < 0)))
    return 'invalid-timestamp';
  if (input.persistedAt instanceof Date && input.persistedAt.getTime() < input._receivedAt.getTime()) return 'invalid-timestamp';
  return null;
}

function operationOf(document: ProtectedIngestDocument): ProtectedMessageType | null {
  const messageType = document._provenance.messageType;
  if (messageType === 'unknown' || document._provenance.mqttContext !== 'service-declared') return null;
  if (document.operation === 'measurement') return messageType === 'telemetry' ? messageType : null;
  return messageType === 'telemetry' ? null : messageType;
}

function contradictory(document: ProtectedIngestDocument): boolean {
  const provenance = document._provenance;
  if (document.sourceId !== provenance.sourceId || document.eventId !== provenance.eventId || document.clientid !== provenance.technicalClientId ||
    document._receivedAt.getTime() !== provenance.receivedAt.getTime()) return true;
  return ['clientid', 'clientId', 'client_id'].some(alias => hasOwn(document._payload, alias) && document._payload[alias] !== document.clientid);
}

export function createProtectedIngestMapper(authority: IngestProvenanceAuthority) {
  if (!isIssuedIngestProvenanceAuthority(authority)) throw new TypeError('Issued provenance authority required');
  const accepts = authority.accepts.bind(authority);

  function map(input: unknown, capability?: unknown): ProtectedIngestMapResult {
    try {
      const early = preflight(input); if (early) return quarantined(early);
      let payload: Readonly<Record<string, unknown>>;
      try { payload = cloneTechnicalValue((input as Record<string, unknown>)._payload) as Readonly<Record<string, unknown>>; }
      catch { return quarantined('invalid-payload'); }
      const parsed = protectedIngestDocumentSchema.safeParse(input);
      if (!parsed.success) return quarantined('invalid-schema');
      const document = parsed.data;
      if (contradictory(document)) return quarantined('conflicting-identity');
      const operation = operationOf(document); if (!operation) return quarantined('unsupported-operation');
      const expected: VerifiedIngestProvenance = Object.freeze({
        sourceId: document.sourceId,
        operation,
        eventId: document.eventId,
        device: Object.freeze({ kind: 'mqtt-clientid', value: document.clientid }),
      });
      let authorized = false;
      try { authorized = accepts(capability, expected) === true; } catch { authorized = false; }
      if (!authorized) return quarantined('unverified-provenance');
      const persistedAt = document.persistedAt?.getTime() ?? null;
      const candidate: ProtectedMeasurementCandidate = {
        status: 'candidate',
        kind: operation === 'telemetry' ? 'measurement-candidate' : 'technical-event-candidate',
        sourceId: document.sourceId,
        storeOperation: document.operation,
        operation,
        eventId: document.eventId,
        device: Object.freeze({ kind: 'mqtt-clientid', value: document.clientid }),
        declaredTechnicalIdentity: document.clientid,
        idempotencyKey: Object.freeze({ sourceId: document.sourceId, operation: document.operation, eventId: document.eventId }),
        timestamps: Object.freeze({
          deviceTimestamp: Object.freeze({ value: document._provenance.deviceTimestamp, origin: 'device-declared', trustedForAttribution: false }),
          sentAt: Object.freeze({ value: document._provenance.brokerDeclaredAt.getTime(), origin: 'broker-declared', trustedForAttribution: false }),
          receivedAt: Object.freeze({ value: document._receivedAt.getTime(), origin: 'ingest-received', trustedForAttribution: false }),
          persistedAt: Object.freeze({ value: persistedAt, origin: 'ingest-persisted', trustedForAttribution: false }),
        }),
        payload,
        provenance: Object.freeze({
          technicalIdentityAuthorization: 'external-capability',
          payloadIntegrity: 'not-attested',
          brokerIdentityDeclared: document._provenance.brokerIdentity,
          mqttContext: 'service-declared',
          topic: document._provenance.topic,
          dataOriginDeclared: document._provenance.dataOriginDeclared,
          physicalMeasurementVerified: false,
          commercialAttribution: false,
        }),
        eligibleForMeasurementMapping: operation === 'telemetry',
      };
      return Object.freeze(candidate);
    } catch { return quarantined('internal-error'); }
  }

  return Object.freeze({ map });
}
