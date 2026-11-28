import type { ClientSession } from 'mongoose';
import type { AuthorizationContext } from '../auth/contracts.js';
import type { BusinessScope, Page, PageInput } from '../business/contracts.js';
import type { TechnicalDeviceKey } from '../telemetry/association.contracts.js';

export type Lifecycle = 'active' | 'inactive' | 'decommissioned';
export type VerificationState = 'unverified' | 'verified';

export interface LogicalSensor {
  readonly id: string;
  readonly clientId: string;
  readonly fieldId: string;
  readonly areaId: string;
  readonly name: string;
  readonly description: string | null;
  readonly lifecycle: Lifecycle;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface PhysicalDevice {
  readonly id: string;
  readonly sourceId: string;
  readonly key: TechnicalDeviceKey;
  readonly verification: VerificationState;
  readonly lifecycle: Lifecycle;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface SensorAreaAssignment {
  readonly id: string;
  readonly revision: number;
  readonly clientId: string;
  readonly sensorId: string;
  readonly fieldId: string;
  readonly areaId: string;
  readonly validFrom: number;
  readonly validTo: number | null;
}

export interface SensorDeviceAssociation {
  readonly id: string;
  readonly revision: number;
  readonly clientId: string;
  readonly sensorId: string;
  readonly fieldId: string;
  readonly areaId: string;
  readonly physicalDeviceId: string;
  readonly sourceId: string;
  readonly device: TechnicalDeviceKey;
  readonly validFrom: number;
  readonly validTo: number | null;
  readonly state: 'active' | 'closed';
  readonly auditReason: string;
}

export interface SensorCreateInput { readonly fieldId: string; readonly areaId: string; readonly name: string; readonly description: string | null }
export interface SensorPatchInput { readonly name?: string; readonly description?: string | null; readonly version: number }
export interface DeviceCreateInput { readonly sourceId: string; readonly key: TechnicalDeviceKey }
export interface AssociationCreateInput { readonly sensorId: string; readonly physicalDeviceId: string; readonly validFrom: number; readonly auditReason: string }
export interface DeviceReassignmentInput extends AssociationCreateInput { readonly associationId: string; readonly associationRevision: number }
export interface AssociationCloseInput { readonly associationId: string; readonly associationRevision: number; readonly validTo: number; readonly auditReason: string }
export interface AreaReassignmentInput { readonly sensorId: string; readonly fieldId: string; readonly areaId: string; readonly validFrom: number; readonly sensorVersion: number; readonly auditReason: string }
export interface LifecycleInput { readonly version: number; readonly auditReason: string }

export type DeviceVerification =
  | { readonly status: 'unverified' }
  | { readonly status: 'verified'; readonly authority: string };
export interface DeviceIdentityVerifier { verify(sourceId: string, key: TechnicalDeviceKey): Promise<DeviceVerification> }

export interface SensorRepository {
  listSensors(scope: BusinessScope, page: PageInput): Promise<Page<LogicalSensor>>;
  getSensor(scope: BusinessScope, id: string): Promise<LogicalSensor>;
  createSensor(scope: BusinessScope, input: SensorCreateInput): Promise<LogicalSensor>;
  patchSensor(scope: BusinessScope, id: string, input: SensorPatchInput): Promise<LogicalSensor>;
  setSensorLifecycle(scope: BusinessScope, id: string, lifecycle: Exclude<Lifecycle, 'active'>, input: LifecycleInput): Promise<LogicalSensor>;
  reassignSensorArea(scope: BusinessScope, input: AreaReassignmentInput): Promise<LogicalSensor>;
  createDevice(scope: BusinessScope, input: DeviceCreateInput, verification: DeviceVerification): Promise<PhysicalDevice>;
  setDeviceVerification(scope: BusinessScope, id: string, version: number, verification: DeviceVerification): Promise<PhysicalDevice>;
  getDevice(scope: BusinessScope, id: string): Promise<PhysicalDevice>;
  setDeviceLifecycle(scope: BusinessScope, id: string, lifecycle: Exclude<Lifecycle, 'active'>, input: LifecycleInput): Promise<PhysicalDevice>;
  createAssociation(scope: BusinessScope, input: AssociationCreateInput): Promise<SensorDeviceAssociation>;
  closeAssociation(scope: BusinessScope, input: AssociationCloseInput): Promise<SensorDeviceAssociation>;
  reassignDevice(scope: BusinessScope, input: DeviceReassignmentInput): Promise<SensorDeviceAssociation>;
  listAssociations(scope: BusinessScope, sensorId: string): Promise<readonly SensorDeviceAssociation[]>;
  listAreaAssignments(scope: BusinessScope, sensorId: string): Promise<readonly SensorAreaAssignment[]>;
}

export interface SensorServiceContext { readonly authorization: AuthorizationContext }
export interface SensorDependencies {
  inspectField(scope: BusinessScope, fieldId: string, session: ClientSession): Promise<'clear' | 'blocked' | 'unknown'>;
  inspect(scope: BusinessScope, fieldId: string, areaId: string, session: ClientSession): Promise<'clear' | 'blocked' | 'unknown'>;
}
