import type { Connection } from 'mongoose';
import { ingestionPrefix } from './ingestion-persistence.models.js';
import { brokerInboxCollection } from './broker-inbox.models.js';

// BE13-11C — operational STATE of an inbox record, in its OWN collection. The raw inbox record (bytes, provenance, broker
// context, rawPersistedAt) is never updated. One document per inboxId (_id = inboxId, so realm + inboxId lookups use the
// implicit unique _id index). No raw payload, no topic, no client id, no credential. No TTL.
export function brokerInboxStateCollection(prefix: string) {
  return ingestionPrefix.parse(prefix) + '_broker_inbox_state';
}

export const brokerInboxStateValidator = { $jsonSchema: { bsonType: 'object', additionalProperties: false,
  required: ['_id', 'realm', 'status', 'version'],
  properties: {
    _id: { bsonType: 'string', pattern: '^ib_[0-9a-f]{32}$' },
    realm: { enum: ['test', 'development', 'preview', 'production'] },
    status: { enum: ['receipted', 'claimed', 'completed'] },
    version: { bsonType: 'int', minimum: 1, maximum: 1_000_000 },
    token: { bsonType: 'string', pattern: '^[0-9a-f]{32}$' },
    claimedAt: { bsonType: 'date' },
    completedAt: { bsonType: 'date' },
    outcome: { enum: ['recovered-and-processed', 'already-processed', 'integrity-failed', 'blocked', 'admission-processed'] },
  } } };

// No secondary index: every lookup is by _id (inboxId), and the candidate scan walks the raw collection through its existing
// { realm, rawPersistedAt } index and joins by _id. A { realm, status } index would serve no query that exists today.
export async function provisionBrokerInboxStateCollection(connection: Connection, prefix: string) {
  const name = brokerInboxStateCollection(prefix), db = connection.db;
  if (!db || (await db.listCollections({ name }).toArray()).length) throw new TypeError('New explicit broker inbox state namespace required');
  await db.createCollection(name, { collation: { locale: 'simple' }, validationLevel: 'strict', validationAction: 'error', validator: brokerInboxStateValidator });
}

export { brokerInboxCollection };
