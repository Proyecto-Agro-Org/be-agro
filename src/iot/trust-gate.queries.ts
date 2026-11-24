import type { TechnicalDeviceKey } from '../telemetry/association.contracts.js';
import type { DeclaredDataOrigin } from './protected-ingest.contracts.js';
import type {
  AssociationAtQuery,
  CatalogueQuery,
  DeviceResolutionQuery,
  HardwareAuthorityQuery,
  TemporalAuthorityQuery,
  TrustGateRealm,
} from './trust-gate.contracts.js';

// Single source of truth for the queries sent to BE13-03 authorities. BE13-04
// revalidation rebuilds the exact same queries from a ReadyForAttribution and
// its candidate, so fingerprints are comparable. Every query is a fresh frozen
// object; the realm is always part of the query context.
const key = (device: TechnicalDeviceKey): TechnicalDeviceKey => Object.freeze({ kind: device.kind, value: device.value });

export function buildDeviceQuery(realm: TrustGateRealm, sourceId: string, device: TechnicalDeviceKey): DeviceResolutionQuery {
  return Object.freeze({ realm, sourceId, device: key(device), limit: 2 as const });
}

export function buildHardwareQuery(realm: TrustGateRealm, eventId: string, sourceId: string, device: TechnicalDeviceKey,
  physicalDeviceId: string, dataOriginDeclared: DeclaredDataOrigin): HardwareAuthorityQuery {
  return Object.freeze({ realm, eventId, sourceId, device: key(device), physicalDeviceId, dataOriginDeclared });
}

export function buildTemporalQuery(realm: TrustGateRealm, eventId: string, sourceId: string, physicalDeviceId: string,
  timestamps: TemporalAuthorityQuery['timestamps']): TemporalAuthorityQuery {
  return Object.freeze({ realm, eventId, sourceId, physicalDeviceId, timestamps: Object.freeze({
    deviceTimestamp: timestamps.deviceTimestamp, sentAt: timestamps.sentAt, receivedAt: timestamps.receivedAt, persistedAt: timestamps.persistedAt,
  }) });
}

export function buildAssociationQuery(realm: TrustGateRealm, physicalDeviceId: string, at: number): AssociationAtQuery {
  return Object.freeze({ realm, physicalDeviceId, at, limit: 2 as const });
}

export function buildCatalogueQuery(realm: TrustGateRealm, sourceId: string, physicalDeviceId: string, sensorId: string, field: string,
  value: number | null, at: number): CatalogueQuery {
  return Object.freeze({ realm, sourceId, physicalDeviceId, sensorId, field, valueKind: value === null ? 'null' as const : 'number' as const, at });
}
