import { Schema, type Connection, type Model } from 'mongoose';
import { z } from 'zod';
import { businessCollections } from './business.models.js';

export const sensorPrefix = z.string().regex(/^agro_sensors_[a-z][a-z0-9_]{0,32}$/);
export interface SensorDocument { _id: string; realm: string; id: string; clientId: string; fieldId: string; areaId: string; name: string; description: string | null; lifecycle: string; version: number; createdAt: Date; updatedAt: Date }
export interface DeviceDocument { _id: string; realm: string; id: string; clientId: string; sourceId: string; keyKind: string; keyValue: string; verification: string; verificationAuthority: string | null; lifecycle: string; version: number; createdAt: Date; updatedAt: Date }
export interface AssignmentDocument { _id: string; realm: string; id: string; revision: number; clientId: string; sensorId: string; fieldId: string; areaId: string; validFrom: Date; validTo: Date | null; auditReason: string }
export interface AssociationDocument extends AssignmentDocument { physicalDeviceId: string; sourceId: string; keyKind: string; keyValue: string; state: string }
interface SensorModels { sensors: Model<SensorDocument>; devices: Model<DeviceDocument>; assignments: Model<AssignmentDocument>; associations: Model<AssociationDocument> }
const owned = new WeakMap<Connection, Map<string, SensorModels>>();

export function sensorCollections(prefix: string, businessPrefix: string) {
  const p = sensorPrefix.parse(prefix), business = businessCollections(businessPrefix);
  return { sensors: p + '_logical', devices: p + '_physical', assignments: p + '_area_history', associations: p + '_device_history', controls: business.controls, fields: business.fields, areas: business.areas };
}

export function defineSensorModels(connection: Connection, prefix: string, businessPrefix: string): SensorModels {
  const n = sensorCollections(prefix, businessPrefix), cached = owned.get(connection)?.get(prefix);
  if (cached) return cached;
  if ([n.sensors, n.devices, n.assignments, n.associations].some(name => connection.models[name])) throw new TypeError('Sensor namespace already in use');
  const req = { type: String, required: true, cast: false }, date = { type: Date, required: true, cast: false };
  const settings = { strict: 'throw' as const, strictQuery: 'throw' as const, versionKey: false as const, autoCreate: false, autoIndex: false, bufferCommands: false, id: false };
  const common = { _id: req, realm: req, id: req, clientId: req };
  const sensor = new Schema<SensorDocument>({ ...common, fieldId: req, areaId: req, name: { ...req, maxlength: 120 }, description: { type: String, default: null, maxlength: 2000, cast: false }, lifecycle: { ...req, enum: ['active','inactive','decommissioned'] }, version: { type: Number, required: true, cast: false, min: 0, validate: Number.isSafeInteger }, createdAt: date, updatedAt: date }, settings);
  const device = new Schema<DeviceDocument>({ ...common, sourceId: req, keyKind: { ...req, enum: ['mqtt-clientid','device-id'] }, keyValue: req, verification: { ...req, enum: ['unverified','verified'] }, verificationAuthority: { type: String, default: null, cast: false }, lifecycle: { ...req, enum: ['active','inactive','decommissioned'] }, version: { type: Number, required: true, cast: false, min: 0, validate: Number.isSafeInteger }, createdAt: date, updatedAt: date }, settings);
  const assignment = new Schema<AssignmentDocument>({ ...common, revision: { type: Number, required: true, cast: false, min: 0, validate: Number.isSafeInteger }, sensorId: req, fieldId: req, areaId: req, validFrom: date, validTo: { type: Date, default: null, cast: false }, auditReason: { ...req, maxlength: 240 } }, settings);
  const association = new Schema<AssociationDocument>({ ...common, revision: { type: Number, required: true, cast: false, min: 0, validate: Number.isSafeInteger }, sensorId: req, fieldId: req, areaId: req, validFrom: date, validTo: { type: Date, default: null, cast: false }, auditReason: { ...req, maxlength: 240 }, physicalDeviceId: req, sourceId: req, keyKind: { ...req, enum: ['mqtt-clientid','device-id'] }, keyValue: req, state: { ...req, enum: ['active','closed'] } }, settings);
  sensor.index({ realm: 1, id: 1 }, { unique: true, name: 'sensor_id_unique', collation: { locale: 'simple' } });
  sensor.index({ realm: 1, clientId: 1, id: 1 }, { name: 'sensor_scope_page', collation: { locale: 'simple' } });
  device.index({ realm: 1, id: 1 }, { unique: true, name: 'device_id_unique', collation: { locale: 'simple' } });
  device.index({ realm: 1, sourceId: 1, keyKind: 1, keyValue: 1 }, { unique: true, name: 'device_technical_identity_unique', collation: { locale: 'simple' } });
  assignment.index({ realm: 1, id: 1 }, { unique: true, name: 'assignment_id_unique', collation: { locale: 'simple' } });
  assignment.index({ realm: 1, clientId: 1, sensorId: 1, validFrom: 1 }, { unique: true, name: 'assignment_timeline_unique', collation: { locale: 'simple' } });
  assignment.index({ realm: 1, clientId: 1, fieldId: 1, areaId: 1, validTo: 1 }, { name: 'assignment_dependencies', collation: { locale: 'simple' } });
  association.index({ realm: 1, id: 1 }, { unique: true, name: 'association_id_unique', collation: { locale: 'simple' } });
  association.index({ realm: 1, physicalDeviceId: 1, validFrom: 1 }, { unique: true, name: 'device_timeline_unique', collation: { locale: 'simple' } });
  association.index({ realm: 1, clientId: 1, sensorId: 1, validFrom: 1 }, { name: 'sensor_association_history', collation: { locale: 'simple' } });
  association.index({ realm: 1, clientId: 1, fieldId: 1, areaId: 1, validTo: 1 }, { name: 'association_dependencies', collation: { locale: 'simple' } });
  const models = { sensors: connection.model(n.sensors, sensor, n.sensors), devices: connection.model(n.devices, device, n.devices), assignments: connection.model(n.assignments, assignment, n.assignments), associations: connection.model(n.associations, association, n.associations) };
  let map = owned.get(connection); if (!map) { map = new Map(); owned.set(connection, map); } map.set(prefix, models); return models;
}

export async function provisionSensorCollections(connection: Connection, prefix: string, businessPrefix: string) {
  const n = sensorCollections(prefix, businessPrefix), db = connection.db;
  if (!db || (await db.listCollections({ name: { $in: [n.sensors,n.devices,n.assignments,n.associations] } }).toArray()).length) throw new TypeError('New explicit sensor namespace required');
  const base = { _id:{bsonType:'string'},realm:{enum:['test','development','preview','production']},id:{bsonType:'string'},clientId:{bsonType:'string'} };
  const version={bsonType:['int','long','double'],minimum:0,maximum:Number.MAX_SAFE_INTEGER-1,multipleOf:1}, date={bsonType:'date'};
  const definitions = {
    [n.sensors]: { ...base,fieldId:{bsonType:'string'},areaId:{bsonType:'string'},name:{bsonType:'string',minLength:1,maxLength:120},description:{bsonType:['string','null'],maxLength:2000},lifecycle:{enum:['active','inactive','decommissioned']},version,createdAt:date,updatedAt:date },
    [n.devices]: { ...base,sourceId:{bsonType:'string'},keyKind:{enum:['mqtt-clientid','device-id']},keyValue:{bsonType:'string'},verification:{enum:['unverified','verified']},verificationAuthority:{bsonType:['string','null']},lifecycle:{enum:['active','inactive','decommissioned']},version,createdAt:date,updatedAt:date },
    [n.assignments]: { ...base,revision:version,sensorId:{bsonType:'string'},fieldId:{bsonType:'string'},areaId:{bsonType:'string'},validFrom:date,validTo:{bsonType:['date','null']},auditReason:{bsonType:'string',minLength:1,maxLength:240} },
    [n.associations]: { ...base,revision:version,sensorId:{bsonType:'string'},fieldId:{bsonType:'string'},areaId:{bsonType:'string'},physicalDeviceId:{bsonType:'string'},sourceId:{bsonType:'string'},keyKind:{enum:['mqtt-clientid','device-id']},keyValue:{bsonType:'string'},validFrom:date,validTo:{bsonType:['date','null']},state:{enum:['active','closed']},auditReason:{bsonType:'string',minLength:1,maxLength:240} },
  };
  for (const [name,properties] of Object.entries(definitions)) await db.createCollection(name, { collation: { locale: 'simple' }, validator: { $jsonSchema: { bsonType:'object',required:Object.keys(properties),additionalProperties:false,properties } },validationLevel:'strict',validationAction:'error' });
  const models = defineSensorModels(connection, prefix, businessPrefix); for (const model of Object.values(models)) await model.createIndexes();
}
