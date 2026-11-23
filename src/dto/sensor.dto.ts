import type { LogicalSensor, PhysicalDevice, SensorAreaAssignment, SensorDeviceAssociation } from '../sensors/contracts.js';

// Preparatory DTOs for an isolated composition. They are not mounted by src/app.ts.
export interface SensorResponse { sensor_id: string; campo_id: string; area_id: string; nombre: string; descripcion: string | null; estado: string; version: number; creado_en: string; actualizado_en: string }
export interface PhysicalDeviceResponse { dispositivo_id: string; origen_id: string; identificador: { tipo: string; valor: string }; verificacion: string; estado: string; version: number }
export interface TemporalAssociationResponse { asociacion_id: string; revision: number; sensor_id: string; campo_id: string; area_id: string; dispositivo_id: string; valido_desde: string; valido_hasta: string | null; estado: string }
export interface AreaAssignmentResponse { asignacion_id: string; revision: number; sensor_id: string; campo_id: string; area_id: string; valido_desde: string; valido_hasta: string | null }

function iso(value: number) { return new Date(value).toISOString(); }
export function toSensorResponse(value: LogicalSensor): SensorResponse { return { sensor_id:value.id,campo_id:value.fieldId,area_id:value.areaId,nombre:value.name,descripcion:value.description,estado:value.lifecycle,version:value.version,creado_en:iso(value.createdAt),actualizado_en:iso(value.updatedAt) }; }
export function toPhysicalDeviceResponse(value: PhysicalDevice): PhysicalDeviceResponse { return { dispositivo_id:value.id,origen_id:value.sourceId,identificador:{tipo:value.key.kind,valor:value.key.value},verificacion:value.verification,estado:value.lifecycle,version:value.version }; }
export function toTemporalAssociationResponse(value: SensorDeviceAssociation): TemporalAssociationResponse { return { asociacion_id:value.id,revision:value.revision,sensor_id:value.sensorId,campo_id:value.fieldId,area_id:value.areaId,dispositivo_id:value.physicalDeviceId,valido_desde:iso(value.validFrom),valido_hasta:value.validTo===null?null:iso(value.validTo),estado:value.state }; }
export function toAreaAssignmentResponse(value: SensorAreaAssignment): AreaAssignmentResponse { return { asignacion_id:value.id,revision:value.revision,sensor_id:value.sensorId,campo_id:value.fieldId,area_id:value.areaId,valido_desde:iso(value.validFrom),valido_hasta:value.validTo===null?null:iso(value.validTo) }; }
