import type {
  AssociationAtQuery,
  AssociationAtResolution,
  AssociationResolutionPort,
  CatalogueDecision,
  CatalogueQuery,
  DeviceResolution,
  DeviceResolutionPort,
  DeviceResolutionQuery,
  HardwareAuthorityPort,
  HardwareAuthorityQuery,
  HardwareDecision,
  MeasurementCataloguePort,
  TemporalAuthorityDecision,
  TemporalAuthorityPort,
  TemporalAuthorityQuery,
} from '../iot/trust-gate.contracts.js';

// Default BE13-03 adapters. Each one blocks: no device registry, no approved
// clock policy, no approved BE-04 catalogue and no hardware attestation exist
// as productive authorities yet. Replacing them requires an explicit decision.

export function createBlockingDeviceResolution(): DeviceResolutionPort {
  return Object.freeze({ async resolve(query: DeviceResolutionQuery): Promise<DeviceResolution> {
    return Object.freeze({ realm: query.realm, devices: Object.freeze([]) });
  } });
}

export function createBlockingAssociationResolution(): AssociationResolutionPort {
  return Object.freeze({ async findAt(query: AssociationAtQuery): Promise<AssociationAtResolution> {
    return Object.freeze({ realm: query.realm, complete: true as const, records: Object.freeze([]) });
  } });
}

export function createBlockingTemporalAuthority(): TemporalAuthorityPort {
  return Object.freeze({ async decide(query: TemporalAuthorityQuery): Promise<TemporalAuthorityDecision> {
    return Object.freeze({ status: 'untrusted' as const, realm: query.realm, reason: 'untrusted-clock' as const });
  } });
}

export function createBlockingMeasurementCatalogue(): MeasurementCataloguePort {
  return Object.freeze({ async evaluate(query: CatalogueQuery): Promise<CatalogueDecision> {
    return Object.freeze({ status: 'unknown-magnitude' as const, realm: query.realm });
  } });
}

export function createBlockingHardwareAuthority(): HardwareAuthorityPort {
  return Object.freeze({ async verify(query: HardwareAuthorityQuery): Promise<HardwareDecision> {
    return Object.freeze({ status: 'unverified' as const, realm: query.realm });
  } });
}
