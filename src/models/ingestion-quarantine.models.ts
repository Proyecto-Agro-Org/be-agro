import type { Connection } from 'mongoose';
import { ingestionPrefix } from './ingestion-persistence.models.js';

// BE13-08 — persistent, sanitized quarantine. No payload, no stack, no secrets:
// `additionalProperties: false` rejects any field not listed here (rawPayload,
// stack, x-emqx-key, connection strings, tokens...).
export function quarantineCollection(prefix: string) {
  return ingestionPrefix.parse(prefix) + '_quarantine';
}

const realm = { enum: ['test', 'development', 'preview', 'production'] };
const text = { bsonType: 'string', minLength: 1, maxLength: 256 };
const nullableText = { anyOf: [text, { bsonType: 'null' }] };
const code = { bsonType: 'string', pattern: '^[a-z][a-z0-9-]{1,63}$' };
const hexOrNull = { anyOf: [{ bsonType: 'string', pattern: '^[0-9a-f]{64}$' }, { bsonType: 'null' }] };
const status = { enum: ['OPEN', 'RETRYABLE', 'REPLAYING', 'BLOCKED', 'RESOLVED', 'DISCARDED'] };

export const quarantineValidator = { $jsonSchema: { bsonType: 'object', additionalProperties: false,
  required: ['_id', 'realm', 'stage', 'sourceId', 'operation', 'eventId', 'field', 'device', 'reasonCode', 'cause', 'retryClass', 'fingerprint',
    'documentDigest', 'status', 'version', 'attemptCount', 'firstSeenAt', 'lastSeenAt', 'createdAt', 'updatedAt', 'audit'],
  properties: {
    _id: { bsonType: 'string', pattern: '^q_[0-9a-f]{64}$' },
    realm,
    stage: { enum: ['mapper', 'trust-gate', 'builder', 'be12', 'composition', 'persistence', 'recovery', 'retry'] },
    sourceId: nullableText, operation: { enum: ['measurement', 'device-status', null] }, eventId: nullableText, field: nullableText,
    device: { anyOf: [{ bsonType: 'null' }, { bsonType: 'object', additionalProperties: false, required: ['kind', 'value'],
      properties: { kind: { enum: ['mqtt-clientid', 'device-id'] }, value: text } }] },
    reasonCode: code, cause: { anyOf: [code, { bsonType: 'null' }] },
    retryClass: { enum: ['transient', 'ambiguous-commit', 'validation', 'security', 'conflict', 'policy-blocked', 'consistency', 'unknown'] },
    fingerprint: hexOrNull, documentDigest: hexOrNull, status,
    version: { bsonType: ['int', 'long'], minimum: 1, maximum: 9_007_199_254_740_991 },
    attemptCount: { bsonType: ['int', 'long'], minimum: 1, maximum: 1_000_000 },
    firstSeenAt: { bsonType: 'date' }, lastSeenAt: { bsonType: 'date' }, createdAt: { bsonType: 'date' }, updatedAt: { bsonType: 'date' },
    audit: { bsonType: 'array', maxItems: 100, items: { bsonType: 'object', additionalProperties: false, required: ['action', 'at', 'outcome', 'reasonCode', 'evidence'],
      properties: { action: { enum: ['recorded', 'transition', 'replay'] }, at: { bsonType: 'date' }, outcome: code, reasonCode: { anyOf: [code, { bsonType: 'null' }] },
        evidence: { anyOf: [{ bsonType: 'string', minLength: 1, maxLength: 256, pattern: '^[A-Za-z0-9:_./-]+$' }, { bsonType: 'null' }] } } } },
  } } };

// Indexes (justified):
// - `_id` (implicit, unique): quarantineId = SHA-256 of the dedupe key, which includes the realm → dedupe.
// - `quarantine_realm_status`: list/scan by status within a realm (e.g. RETRYABLE), oldest update first.
// - `quarantine_realm_event`: find every quarantine entry of one event within a realm.
export const quarantineIndexes = [
  { key: { realm: 1, status: 1, updatedAt: 1 }, name: 'quarantine_realm_status' },
  { key: { realm: 1, eventId: 1 }, name: 'quarantine_realm_event' },
] as const;

export async function provisionQuarantineCollection(connection: Connection, prefix: string) {
  const name = quarantineCollection(prefix), db = connection.db;
  if (!db || (await db.listCollections({ name }).toArray()).length) throw new TypeError('New explicit quarantine namespace required');
  await db.createCollection(name, { collation: { locale: 'simple' }, validationLevel: 'strict', validationAction: 'error', validator: quarantineValidator });
  await db.collection(name).createIndexes(quarantineIndexes.map(index => ({ ...index, collation: { locale: 'simple' } })));
}
