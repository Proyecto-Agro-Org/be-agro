import { randomUUID } from 'node:crypto';
import { mongo, type Connection } from 'mongoose';
import { z } from 'zod';
import { catalogueRealmSchema } from '../auth/identity-catalogue.schemas.js';
import { brokerContextFingerprint, brokerProvenanceFingerprint, payloadSha256 } from '../iot/broker-fingerprints.js';
import type { DurableBrokerInbox, InboxRecord, PersistedBrokerDeliveryReceipt } from '../iot/mqtt-ingestion-boundary.contracts.js';
import type { TrustGateRealm } from '../iot/trust-gate.contracts.js';
import { brokerInboxCollection } from '../models/broker-inbox.models.js';

// BE13-11B — Mongo Durable Broker Inbox. INSERT-ONLY: persist + read; no update, no delete, no TTL.
// - inboxId: generated HERE (random 128-bit), never from the device, the caller or the MQTT packet id.
// - rawPersistedAt: assigned by the MongoDB SERVER (`$$NOW`) inside the same write that creates the record. It is the server
//   time of that write operation, NOT the majority-commit instant: the receipt is only issued AFTER the write was
//   acknowledged by a majority with journal, and the record re-read with readConcern majority.
// - Every query filters by the store's realm.
const technicalId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/);
const safeRef = z.string().min(1).max(128).regex(/^[A-Za-z0-9:_./@-]+$/);
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const instant = z.number().int().min(0).max(8.64e15);
const inboxIdSchema = z.string().regex(/^ib_[0-9a-f]{32}$/);
const MAX_BYTES = 16 * 1024 * 1024;
const eventIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/);
const requestSchema = z.object({
  eventId: eventIdSchema.optional(),
  realm: catalogueRealmSchema, sourceId: technicalId, principalReference: safeRef, technicalDeviceKey: technicalId, connectionReference: safeRef, mqttClientId: technicalId,
  topic: z.string().min(1).max(1024), qos: z.union([z.literal(0), z.literal(1), z.literal(2)]), retain: z.boolean(), packetId: z.number().int().min(1).max(65535).nullable(),
  receivedAt: instant, verifiedAt: instant, verifierRevision: revision, mappingRevision: revision, contextFingerprint: hex64, rawPayloadSha256: hex64,
  rawPayload: z.instanceof(Uint8Array).refine(b => b.byteLength <= MAX_BYTES),
}).strict();
const date = z.date().transform(d => d.getTime());
const storedSchema = z.object({
  _id: inboxIdSchema, eventId: eventIdSchema.optional(), realm: catalogueRealmSchema, sourceId: technicalId, principalReference: safeRef, technicalDeviceKey: technicalId, connectionReference: safeRef,
  mqttClientId: technicalId, topic: z.string().min(1).max(1024), qos: z.union([z.literal(0), z.literal(1), z.literal(2)]), retain: z.boolean(),
  packetId: z.number().int().min(1).max(65535).nullable(), receivedAt: date, verifiedAt: date, rawPersistedAt: date, verifierRevision: revision, mappingRevision: revision,
  contextFingerprint: hex64, rawPayloadSha256: hex64, provenanceFingerprint: hex64, rawPayload: z.instanceof(mongo.Binary), rawPayloadBytes: z.number().int().min(0).max(MAX_BYTES),
}).strict();
const writeConcern = { w: 'majority' as const, j: true, wtimeoutMS: 5000 };
const literal = (value: unknown) => ({ $literal: value });
export function eventIdOfBytes(bytes: Uint8Array): string | null {
  try { const id = (JSON.parse(Buffer.from(bytes).toString('utf8')) as { eventId?: unknown }).eventId; return typeof id === 'string' ? id : null; } catch { return null; }
}

export function createMongoBrokerInboxStore(options: { connection: Connection; prefix: string; realm: TrustGateRealm }): DurableBrokerInbox {
  const db = options.connection.db;
  if (!db) throw new TypeError('Connected MongoDB database required');
  const realm = catalogueRealmSchema.parse(options.realm);
  const rows = db.collection(brokerInboxCollection(options.prefix));

  async function getById(raw: unknown): Promise<InboxRecord | null> {
    const input = z.object({ realm: catalogueRealmSchema, inboxId: inboxIdSchema }).strict().parse(raw);
    if (input.realm !== realm) return null; // a store bound to realm A never reads realm B
    const doc = await rows.findOne({ _id: input.inboxId as never, realm }, { readConcern: { level: 'majority' }, maxTimeMS: 5000 } as never);
    if (doc === null) return null;
    const { _id, rawPayload, eventId, ...rest } = storedSchema.parse(doc);
    const bytes = Uint8Array.from(rawPayload.buffer.subarray(0, rawPayload.length()));
    return Object.freeze({ ...rest, eventId: eventId ?? null, inboxId: _id, rawPayload: bytes });
  }

  async function persistVerifiedDelivery(raw: unknown): Promise<PersistedBrokerDeliveryReceipt> {
    const r = requestSchema.parse(raw);
    if (r.realm !== realm) throw new Error('INBOX_REALM_MISMATCH');
    const bytes = Uint8Array.from(r.rawPayload); // private copy: the caller cannot change what is hashed and written
    const sha = payloadSha256(bytes);
    // The store refuses to write bytes or a context that are not exactly the ones the boundary verified.
    if (sha !== r.rawPayloadSha256) throw new Error('INBOX_PAYLOAD_HASH_MISMATCH');
    // BE13-11L: an eventId is stored only if it is EXACTLY the one inside the bytes being persisted (never trust a side channel for the reconciliation key).
    if (r.eventId !== undefined && eventIdOfBytes(bytes) !== r.eventId) throw new Error('INBOX_EVENTID_MISMATCH');
    const contextFingerprint = brokerContextFingerprint(realm, { connectionReference: r.connectionReference, authenticatedPrincipalReference: r.principalReference,
      mqttClientId: r.mqttClientId, topic: r.topic, qos: r.qos, retain: r.retain, packetId: r.packetId, receivedAt: r.receivedAt }, sha);
    if (contextFingerprint !== r.contextFingerprint) throw new Error('INBOX_CONTEXT_MISMATCH');
    const provenanceFingerprint = brokerProvenanceFingerprint({ realm, sourceId: r.sourceId, principalReference: r.principalReference, technicalDeviceKey: r.technicalDeviceKey,
      connectionReference: r.connectionReference, contextFingerprint, rawPayloadSha256: sha, verifiedAt: r.verifiedAt, verifierRevision: r.verifierRevision, mappingRevision: r.mappingRevision });
    const inboxId = 'ib_' + randomUUID().replace(/-/g, '');
    const created = await rows.updateOne({ _id: inboxId as never }, [{ $set: {
      ...(r.eventId === undefined ? {} : { eventId: literal(r.eventId) }),
      realm: literal(realm), sourceId: literal(r.sourceId), principalReference: literal(r.principalReference), technicalDeviceKey: literal(r.technicalDeviceKey),
      connectionReference: literal(r.connectionReference), mqttClientId: literal(r.mqttClientId), topic: literal(r.topic), qos: literal(new mongo.Int32(r.qos)),
      retain: literal(r.retain), packetId: literal(r.packetId === null ? null : new mongo.Int32(r.packetId)), receivedAt: literal(new Date(r.receivedAt)),
      verifiedAt: literal(new Date(r.verifiedAt)), verifierRevision: literal(r.verifierRevision), mappingRevision: literal(r.mappingRevision),
      contextFingerprint: literal(contextFingerprint), rawPayloadSha256: literal(sha), rawPayload: literal(new mongo.Binary(bytes)),
      rawPayloadBytes: literal(bytes.byteLength), provenanceFingerprint: literal(provenanceFingerprint),
      rawPersistedAt: '$$NOW', // server-side time of THIS write
    } }], { upsert: true, writeConcern, maxTimeMS: 5000 } as never);
    if (created.upsertedCount !== 1) throw new Error('INBOX_NOT_PERSISTED');
    // Majority read-back: the receipt describes what a majority holds, not what the client sent.
    const stored = await getById({ realm, inboxId });
    if (!stored || payloadSha256(stored.rawPayload) !== sha || stored.provenanceFingerprint !== provenanceFingerprint) throw new Error('INBOX_NOT_VISIBLE');
    return Object.freeze({ inboxId, realm, rawPersistedAt: stored.rawPersistedAt, rawPayloadSha256: sha, rawPayloadBytes: bytes.byteLength, provenanceFingerprint });
  }

  async function ping() { try { return (await db!.command({ ping: 1 })).ok === 1; } catch { return false; } }

  return Object.freeze({ persistVerifiedDelivery, getById, ping }) as DurableBrokerInbox;
}
