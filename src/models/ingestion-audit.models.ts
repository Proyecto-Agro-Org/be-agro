import type { Connection } from 'mongoose';
import { ingestionPrefix } from './ingestion-persistence.models.js';

// BE13-09 — separate, append-only operations audit (authoritative). The
// embedded 100-entry quarantine audit stays only as a summary.
export function auditCollections(prefix: string) {
  const p = ingestionPrefix.parse(prefix);
  return { audit: p + '_audit', sequences: p + '_audit_sequences' };
}

const realm = { enum: ['test', 'development', 'preview', 'production'] };
const code = { bsonType: 'string', pattern: '^[a-z][a-z0-9-]{1,63}$' };
const capabilities = ['QUARANTINE_VIEW', 'QUARANTINE_REPLAY', 'QUARANTINE_UNBLOCK', 'QUARANTINE_BLOCK', 'QUARANTINE_RESOLVE', 'QUARANTINE_DISCARD', 'AUDIT_VIEW', 'OPERATIONS_VIEW'];
const actions = ['quarantine-created', 'quarantine-recurred', 'classification-changed', 'recovery-outcome', 'replay-requested', 'replay-denied', 'replay-started',
  'replay-result', 'transition-requested', 'transition-result', 'resolved', 'discarded', 'authorization-denied',
  // BE13-10B — replay lease governance
  'lease-acquired', 'lease-release-requested', 'lease-released-owner', 'lease-recovery-requested', 'lease-recovered-expired', 'lease-release-denied', 'stale-replay-blocked',
  // BE13-11A — broker boundary
  'broker-provenance-verified', 'broker-provenance-rejected', 'broker-verifier-unavailable', 'broker-delivery-malformed', 'technical-identity-mismatch',
  // BE13-11B — durable inbox
  'inbox-persisted', 'inbox-recovery-started', 'inbox-recovery-rejected', 'inbox-integrity-failed', 'inbox-processed',
  // BE13-11C — inbox reconciliation
  'inbox-reconciliation-candidate', 'inbox-reconciliation-claimed', 'inbox-reconciliation-completed', 'inbox-reconciliation-stale', 'inbox-reconciliation-integrity-failed'];
const safeRef = { bsonType: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9:_./-]+$' };

// additionalProperties:false rejects rawPayload, stack, messages, secrets, tokens, URIs.
export const auditValidator = { $jsonSchema: { bsonType: 'object', additionalProperties: false,
  required: ['_id', 'realm', 'stream', 'sequence', 'quarantineId', 'eventId', 'action', 'actorId', 'actorCapabilities', 'outcome', 'reasonCode', 'evidence', 'occurredAt'],
  properties: {
    _id: { bsonType: 'string', pattern: '^a_[0-9a-f]{64}$' },
    realm,
    stream: { bsonType: 'string', pattern: '^(realm|q_[0-9a-f]{64})$' },
    sequence: { bsonType: ['int', 'long'], minimum: 1 },
    quarantineId: { anyOf: [{ bsonType: 'string', pattern: '^q_[0-9a-f]{64}$' }, { bsonType: 'null' }] },
    eventId: { anyOf: [{ bsonType: 'string', minLength: 1, maxLength: 256 }, { bsonType: 'null' }] },
    action: { enum: actions },
    actorId: safeRef,
    actorCapabilities: { bsonType: 'array', maxItems: 8, uniqueItems: true, items: { enum: capabilities } },
    outcome: code,
    reasonCode: { anyOf: [code, { bsonType: 'null' }] },
    evidence: { anyOf: [{ bsonType: 'null' }, { bsonType: 'object', additionalProperties: false, required: ['evidenceType', 'reference', 'verification'], properties: {
      evidenceType: { enum: ['policy-approval', 'authority-restored', 'dependency-restored', 'data-verified', 'operator-decision'] },
      reference: safeRef, verification: { enum: ['DECLARED_UNVERIFIED'] } } }] },
    occurredAt: { bsonType: 'date' },
  } } };

export const sequenceValidator = { $jsonSchema: { bsonType: 'object', additionalProperties: false, required: ['_id', 'realm', 'stream', 'sequence'],
  properties: { _id: { bsonType: 'string' }, realm, stream: { bsonType: 'string', pattern: '^(realm|q_[0-9a-f]{64})$' }, sequence: { bsonType: ['int', 'long'], minimum: 1 } } } };

// Indexes (justified):
// - audit_stream_sequence (unique): deterministic order and no duplicate sequence per (realm, stream);
//   serves "all audit of one quarantine entry, in order".
// - audit_realm_occurred: time-window scans inside a realm (operational snapshot, future retention).
// No action/outcome index: no query needs it yet.
export const auditIndexes = [
  { key: { realm: 1, stream: 1, sequence: 1 }, name: 'audit_stream_sequence', unique: true },
  { key: { realm: 1, occurredAt: 1 }, name: 'audit_realm_occurred' },
] as const;

// BE13-10B / BE13-11A — LOCAL, additive validator upgrade: applies the CURRENT validator (lease actions of BE13-10B and
// broker-boundary actions of BE13-11A). Only new enum values are added: existing audit documents stay valid.
export const upgradeAuditValidatorBe1311a = (connection: Connection, prefix: string) => upgradeAuditValidatorBe1310b(connection, prefix);
// BE13-11B: same additive upgrade (durable inbox actions).
export const upgradeAuditValidatorBe1311b = upgradeAuditValidatorBe1311a;
// BE13-11C: same additive upgrade (inbox reconciliation actions).
export const upgradeAuditValidatorBe1311c = upgradeAuditValidatorBe1311a;
export async function upgradeAuditValidatorBe1310b(connection: Connection, prefix: string) {
  const n = auditCollections(prefix), db = connection.db;
  if (!db || (await db.listCollections({ name: n.audit }).toArray()).length !== 1) throw new TypeError('Existing audit namespace required');
  await db.command({ collMod: n.audit, validator: auditValidator, validationLevel: 'strict', validationAction: 'error' });
  return Object.freeze({ status: 'upgraded' as const });
}

export async function provisionAuditCollections(connection: Connection, prefix: string) {
  const n = auditCollections(prefix), db = connection.db;
  if (!db || (await db.listCollections({ name: { $in: [n.audit, n.sequences] } }).toArray()).length) throw new TypeError('New explicit audit namespace required');
  const options = { collation: { locale: 'simple' }, validationLevel: 'strict' as const, validationAction: 'error' as const };
  await db.createCollection(n.audit, { ...options, validator: auditValidator });
  await db.createCollection(n.sequences, { ...options, validator: sequenceValidator });
  await db.collection(n.audit).createIndexes(auditIndexes.map(index => ({ ...index, collation: { locale: 'simple' } })));
}
