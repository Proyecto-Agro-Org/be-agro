import { createHash } from 'node:crypto';
import type { TrustGateRealm } from './trust-gate.contracts.js';

// BE13-11A/11B — structured SHA-256 fingerprints binding a verification to one exact delivery. They detect corruption or
// partial tampering of a stored record; they are NOT MACs: without key management (not decided) a party able to rewrite a
// whole record consistently is not detected. No secret is involved and none is claimed.
const sha256 = (parts: readonly unknown[]) => createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex');

export function payloadSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface ObservedForFingerprint {
  readonly connectionReference: string; readonly authenticatedPrincipalReference: string | null; readonly mqttClientId: string; readonly topic: string;
  readonly qos: number; readonly retain: boolean; readonly packetId: number | null; readonly receivedAt: number;
}
// Realm + every observed fact + the exact payload bytes (by hash).
export function brokerContextFingerprint(realm: TrustGateRealm, observed: ObservedForFingerprint, rawPayloadSha256: string): string {
  return sha256(['be13-11a/broker-context', realm, observed.connectionReference, observed.authenticatedPrincipalReference, observed.mqttClientId, observed.topic,
    observed.qos, observed.retain, observed.packetId, observed.receivedAt, rawPayloadSha256]);
}

export interface ProvenanceForFingerprint {
  readonly realm: TrustGateRealm; readonly sourceId: string; readonly principalReference: string; readonly technicalDeviceKey: string;
  readonly connectionReference: string; readonly contextFingerprint: string; readonly rawPayloadSha256: string;
  readonly verifiedAt: number; readonly verifierRevision: number; readonly mappingRevision: number;
}
// The verified identity decision bound to the context and the bytes.
export function brokerProvenanceFingerprint(p: ProvenanceForFingerprint): string {
  return sha256(['be13-11b/provenance', p.realm, p.sourceId, p.principalReference, p.technicalDeviceKey, p.connectionReference, p.contextFingerprint,
    p.rawPayloadSha256, p.verifiedAt, p.verifierRevision, p.mappingRevision]);
}
