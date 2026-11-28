import type { Connection } from 'mongoose';
import { EVENT_ID_PATTERN_SOURCE } from '../iot/event-id.js';
import { ingestionPrefix } from './ingestion-persistence.models.js';

// BE13-11B — Durable Broker Inbox. Its PURPOSE is to keep the exact raw bytes of VERIFIED deliveries (unlike audit and
// quarantine). Closed document: `additionalProperties: false` rejects anything not listed (credentials, tokens, passwords,
// x-emqx-key, connection strings...). No TTL index: retention is a pending human decision (retain by default).
export function brokerInboxCollection(prefix: string) {
  return ingestionPrefix.parse(prefix) + '_broker_inbox';
}

const technicalId = { bsonType: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$' };
const safeRef = { bsonType: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9:_./@-]+$' };
const hex64 = { bsonType: 'string', pattern: '^[0-9a-f]{64}$' };
const revision = { bsonType: ['int', 'long'], minimum: 0, maximum: 9_007_199_254_740_991 };

export const brokerInboxValidator = { $jsonSchema: { bsonType: 'object', additionalProperties: false,
  required: ['_id', 'realm', 'sourceId', 'principalReference', 'technicalDeviceKey', 'connectionReference', 'mqttClientId', 'topic', 'qos', 'retain', 'packetId',
    'receivedAt', 'verifiedAt', 'rawPersistedAt', 'verifierRevision', 'mappingRevision', 'contextFingerprint', 'rawPayloadSha256', 'rawPayload', 'rawPayloadBytes',
    'provenanceFingerprint'],
  properties: {
    _id: { bsonType: 'string', pattern: '^ib_[0-9a-f]{32}$' },
    realm: { enum: ['test', 'development', 'preview', 'production'] },
    // BE13-11L: optional (LEGACY records have none). Never backfilled with a guess; see scripts/be13-11l/inbox-eventid-migration.ts.
    eventId: { bsonType: 'string', pattern: EVENT_ID_PATTERN_SOURCE },
    sourceId: technicalId, principalReference: safeRef, technicalDeviceKey: technicalId, connectionReference: safeRef, mqttClientId: technicalId,
    topic: { bsonType: 'string', minLength: 1, maxLength: 1024 },
    qos: { bsonType: 'int', enum: [0, 1, 2] },
    retain: { bsonType: 'bool' },
    packetId: { anyOf: [{ bsonType: 'int', minimum: 1, maximum: 65535 }, { bsonType: 'null' }] },
    receivedAt: { bsonType: 'date' }, verifiedAt: { bsonType: 'date' }, rawPersistedAt: { bsonType: 'date' },
    verifierRevision: revision, mappingRevision: revision,
    contextFingerprint: hex64, rawPayloadSha256: hex64, provenanceFingerprint: hex64,
    rawPayload: { bsonType: 'binData' },
    rawPayloadBytes: { bsonType: ['int', 'long'], minimum: 0, maximum: 16 * 1024 * 1024 },
  } } };

// Indexes (justified):
// - `_id` (implicit, unique): inboxId lookups; recovery filters by { _id, realm }.
// - `inbox_realm_persisted`: inspection of what a realm persisted over time (backlog review). No worker-scheduling index:
//   there is no worker.
// - `inbox_realm_source_event` (BE13-11L): direct publisher reconciliation lookup by (realm, sourceId, eventId). NOT unique: legitimate re-deliveries are separate records.
export const INBOX_EVENT_INDEX_NAME = 'inbox_realm_source_event';
export const brokerInboxIndexes = [{ key: { realm: 1, rawPersistedAt: 1 }, name: 'inbox_realm_persisted' },
  { key: { realm: 1, sourceId: 1, eventId: 1, rawPersistedAt: -1 }, name: INBOX_EVENT_INDEX_NAME }] as const;

export async function provisionBrokerInboxCollection(connection: Connection, prefix: string) {
  const name = brokerInboxCollection(prefix), db = connection.db;
  if (!db || (await db.listCollections({ name }).toArray()).length) throw new TypeError('New explicit broker inbox namespace required');
  await db.createCollection(name, { collation: { locale: 'simple' }, validationLevel: 'strict', validationAction: 'error', validator: brokerInboxValidator });
  await db.collection(name).createIndexes(brokerInboxIndexes.map(index => ({ ...index, collation: { locale: 'simple' } })));
}
