import { createHash } from 'node:crypto';
import type { ProtectedMeasurementCandidate } from './protected-ingest.contracts.js';
import type { TrustGateRealm } from './trust-gate.contracts.js';

// Idempotency fingerprint of the APPROVED TECHNICAL INPUT (not of the derived
// event, which depends on authorities that may legitimately change).
//
// Included (exactly):
//   realm, sourceId, storeOperation, operation, eventId, device {kind, value},
//   field (selected payload key), payload (full technical payload),
//   deviceTimestamp (declared), sentAt (broker-declared).
// Excluded as volatile per delivery: receivedAt, persistedAt, topic,
//   brokerIdentityDeclared, provenance flags, and every authority-derived value.
//
// Canonical form: JSON with object keys sorted recursively, arrays in order,
// no Unicode normalization. -0 serializes as 0. Hash: SHA-256 hex.
// It is a consistency fingerprint, not a signature, MAC or authentication.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) out[key] = canonical((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

export function technicalInputFingerprint(realm: TrustGateRealm, candidate: ProtectedMeasurementCandidate, field: string): string {
  const material = canonical({
    v: 1,
    realm,
    sourceId: candidate.sourceId,
    storeOperation: candidate.storeOperation,
    operation: candidate.operation,
    eventId: candidate.eventId,
    device: { kind: candidate.device.kind, value: candidate.device.value },
    field,
    payload: candidate.payload,
    deviceTimestamp: candidate.timestamps.deviceTimestamp.value,
    sentAt: candidate.timestamps.sentAt.value,
  });
  return createHash('sha256').update(JSON.stringify(material), 'utf8').digest('hex');
}
