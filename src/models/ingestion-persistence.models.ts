import type { Connection } from 'mongoose';
import { z } from 'zod';

// BE13-06 — persistent idempotency claims and ingested measurements.
// Collections are created only by explicit provisioning (never by autoCreate).
export const ingestionPrefix = z.string().regex(/^agro_ingest_[a-z][a-z0-9_]{0,32}$/);

export function ingestionCollections(prefix: string) {
  const p = ingestionPrefix.parse(prefix);
  return { idempotency: p + '_idempotency', measurements: p + '_measurements' };
}

// Idempotency claim. _id = SHA-256 of the canonical logical key. A claim exists
// only if the transaction that wrote the measurement committed: there is no
// "pending" state outside a transaction.
export interface IdempotencyDocument {
  _id: string;
  realm: string;
  sourceId: string;
  operation: string;
  eventId: string;
  field: string;
  fingerprint: string;
  state: 'committed';
  measurementId: string;
  committedAt: Date; // technical server time ($currentDate); not an event timestamp
}

// Measurement written in the same transaction as its claim.
export interface MeasurementDocument {
  _id: string; // deterministic from the logical key
  realm: string;
  sourceId: string;
  operation: string;
  eventId: string;
  field: string;
  fingerprint: string;
  event: Record<string, unknown>;       // BE-12 TrustedMeasurementEvent (epoch numbers, unchanged)
  attribution: Record<string, unknown>; // reconciled BE13-04/BE-12 attribution
  storedAt: Date; // technical server time of this store; NOT the semantic event.persistedAt
}

const realm = { enum: ['test', 'development', 'preview', 'production'] };
const text = { bsonType: 'string', minLength: 1, maxLength: 256 };
const hex = { bsonType: 'string', pattern: '^[0-9a-f]{64}$' };
// Finite numbers only: NaN/±Infinity are rejected by the range bounds (verified against MongoDB 8.0.38).
const MAX_DOUBLE = 1.7976931348623157e308;
const finite = { bsonType: ['int', 'long', 'double'], minimum: -MAX_DOUBLE, maximum: MAX_DOUBLE };
// Same bounds as the BE-12 `epoch` schema: integer milliseconds in [0, 8.64e15].
const epoch = { bsonType: ['int', 'long', 'double'], minimum: 0, maximum: 8_640_000_000_000_000, multipleOf: 1 };
const revision = { bsonType: ['int', 'long', 'double'], minimum: 0, maximum: Number.MAX_SAFE_INTEGER, multipleOf: 1 };
// BE-12 metadata: scalar values only (string ≤ 256, finite number, boolean, null), at most 20 entries.
const metadata = { bsonType: 'object', maxProperties: 20, additionalProperties: { anyOf: [{ bsonType: 'string', maxLength: 256 }, finite, { bsonType: ['bool', 'null'] }] } };
const key = { realm, sourceId: text, operation: { enum: ['measurement', 'device-status'] }, eventId: text, field: text };

export const idempotencyValidator = { $jsonSchema: { bsonType: 'object', additionalProperties: false,
  required: ['_id', 'realm', 'sourceId', 'operation', 'eventId', 'field', 'fingerprint', 'state', 'measurementId', 'committedAt'],
  properties: { _id: hex, ...key, fingerprint: hex, state: { enum: ['committed'] }, measurementId: { bsonType: 'string', pattern: '^m_[0-9a-f]{64}$' },
    committedAt: { bsonType: 'date' } } } };

export const measurementValidator = {
  // Cross-field invariants of the BE-12 TrustedMeasurementEvent schema plus key coherence.
  $expr: { $and: [
    { $eq: [{ $eq: ['$event.value', null] }, { $ne: ['$event.missingReason', null] }] },
    { $eq: ['$event.simulated', { $eq: ['$event.provenance', 'simulated'] }] },
    { $gte: ['$event.persistedAt', '$event.receivedAt'] },
    { $eq: ['$attribution.realm', '$realm'] },
    { $eq: ['$event.eventId', '$eventId'] },
    { $eq: ['$event.sourceId', '$sourceId'] },
  ] },
  $jsonSchema: { bsonType: 'object', additionalProperties: false,
  required: ['_id', 'realm', 'sourceId', 'operation', 'eventId', 'field', 'fingerprint', 'event', 'attribution', 'storedAt'],
  properties: { _id: { bsonType: 'string', pattern: '^m_[0-9a-f]{64}$' }, ...key, fingerprint: hex,
    event: { bsonType: 'object', additionalProperties: false,
      required: ['eventId', 'sourceId', 'device', 'receivedAt', 'declaredAt', 'persistedAt', 'magnitude', 'unit', 'value', 'missingReason', 'provenance', 'simulated', 'metadata'],
      properties: { eventId: text, sourceId: text, device: { bsonType: 'object', additionalProperties: false, required: ['kind', 'value'],
        properties: { kind: { enum: ['mqtt-clientid', 'device-id'] }, value: text } },
        receivedAt: epoch, declaredAt: { anyOf: [epoch, { bsonType: 'null' }] }, persistedAt: epoch, magnitude: text, unit: text,
        value: { anyOf: [finite, { bsonType: 'null' }] },
        missingReason: { enum: ['absent', 'invalid', 'unknown-unit', 'not-calibrated', 'insufficient-dependency', null] },
        provenance: { enum: ['physical', 'derived', 'estimated', 'simulated', 'manual', 'laboratory'] }, simulated: { bsonType: 'bool' }, metadata } },
    attribution: { bsonType: 'object', additionalProperties: false,
      required: ['realm', 'attributedAt', 'clock', 'physicalDeviceId', 'clientId', 'fieldId', 'areaId', 'sensorId', 'associationId', 'associationRevision'],
      properties: { realm, attributedAt: epoch, clock: { enum: ['received-at', 'declared-at-approved'] }, physicalDeviceId: text, clientId: text, fieldId: text,
        areaId: text, sensorId: text, associationId: text, associationRevision: revision } },
    storedAt: { bsonType: 'date' } } } };

// Index inventory (documented in CONTRATO_BE13_06_ATOMIC_PERSISTENCE.md):
// - idempotency `_id` (implicit, unique): SHA-256 of the canonical key; point lookups.
// - idempotency `idempotency_key_unique` {realm, sourceId, operation, eventId, field}, unique:
//   makes the logical invariant explicit and independent of the hash derivation.
// - measurements `_id` (implicit, unique): deterministic measurementId.
// - measurements `measurement_key_unique` {realm, sourceId, operation, eventId, field}, unique:
//   at most one measurement per logical key even if a claim were bypassed.
export const ingestionIndexes = {
  idempotency: [{ key: { realm: 1, sourceId: 1, operation: 1, eventId: 1, field: 1 }, name: 'idempotency_key_unique', unique: true }],
  measurements: [{ key: { realm: 1, sourceId: 1, operation: 1, eventId: 1, field: 1 }, name: 'measurement_key_unique', unique: true }],
} as const;

export async function provisionIngestionCollections(connection: Connection, prefix: string) {
  const n = ingestionCollections(prefix), db = connection.db;
  if (!db || (await db.listCollections({ name: { $in: [n.idempotency, n.measurements] } }).toArray()).length) throw new TypeError('New explicit ingestion namespace required');
  const options = { collation: { locale: 'simple' }, validationLevel: 'strict' as const, validationAction: 'error' as const };
  await db.createCollection(n.idempotency, { ...options, validator: idempotencyValidator });
  await db.createCollection(n.measurements, { ...options, validator: measurementValidator });
  await db.collection(n.idempotency).createIndexes(ingestionIndexes.idempotency.map(index => ({ ...index, collation: { locale: 'simple' } })));
  await db.collection(n.measurements).createIndexes(ingestionIndexes.measurements.map(index => ({ ...index, collation: { locale: 'simple' } })));
}
