// Logical contracts only. No collection names, agronomic BSON model or HTTP route
// is selected here. A technical key never becomes a commercial client ID.
export interface TechnicalDeviceKey { readonly kind: 'mqtt-clientid' | 'device-id'; readonly value: string }
export interface DeviceAssociation {
  readonly id: string; readonly revision: number; readonly realm: string; readonly clientId: string;
  readonly fieldId: string; readonly areaId: string; readonly sensorId: string;
  readonly sourceId: string; readonly device: TechnicalDeviceKey; readonly clockId: string;
  readonly validFrom: number; readonly validTo: number | null;
  readonly attribution: 'verified' | 'quarantined';
}
export interface SensorAssociationQuery {
  readonly realm: string; readonly clientId: string; readonly fieldId: string; readonly areaId: string;
  readonly sensorId: string; readonly from: number; readonly to: number; readonly limit: 65;
}
export interface DeviceAssociationQuery {
  readonly realm: string; readonly sourceId: string; readonly device: TechnicalDeviceKey;
  readonly from: number; readonly to: number; readonly limit: 65;
}
export interface AssociationReadPort {
  // Must filter inside storage, not retrieve all tenant measurements. Complete
  // means no hidden/truncated intervals. Check global device overlaps internally.
  findForSensor(query: SensorAssociationQuery): Promise<{ complete: boolean; records: DeviceAssociation[] }>;
  findForDevice(query: DeviceAssociationQuery): Promise<{ complete: boolean; records: DeviceAssociation[] }>;
}
export interface TechnicalDeviceIdentity {
  readonly sourceId: string; readonly device: TechnicalDeviceKey;
  readonly recordId: { readonly kind: 'object-id' | 'string'; readonly value: string };
}
export interface TechnicalDeviceReadPort {
  findExact(query: { readonly sourceId: string; readonly device: TechnicalDeviceKey; readonly limit: 2 }): Promise<TechnicalDeviceIdentity[]>;
}
export interface TelemetrySourcePolicy {
  readonly sourceId: string; readonly clockId: string; readonly deviceKind: TechnicalDeviceKey['kind'];
  readonly deviceField: 'clientid' | 'device_id';
  // Server configuration/evidence, NEVER read from an IoT payload. Current
  // unauthenticated iot-ingest is unverified and cannot pass these gates.
  readonly authenticatedIdentity: boolean; readonly verifiedTemporalAttribution: boolean;
}

// Preparatory internal business operations; no concrete MongoDB implementation
// until field/area/sensor BSON names/types are approved under BE02.
export type EnterpriseReadQuery = { readonly realm: string; readonly clientId: string } & (
  | { readonly operation: 'fields' }
  | { readonly operation: 'areas' | 'dashboard'; readonly fieldId: string }
  | { readonly operation: 'sensors'; readonly fieldId: string; readonly areaId: string }
  | { readonly operation: 'associated-device' | 'technical-status' | 'latest';
      readonly fieldId: string; readonly areaId: string; readonly sensorId: string }
  | { readonly operation: 'history'; readonly fieldId: string; readonly areaId: string; readonly sensorId: string;
      readonly from: number; readonly to: number; readonly limit: number });
