import { Schema, type Connection, type Model } from 'mongoose';
import { z } from 'zod';
export interface BusinessDocument {
  _id: string; realm: string; id: string; clientId: string; name: string; description: string | null;
  active: boolean; createdAt: Date; updatedAt: Date; version: number; fieldId?: string;
}
export const businessPrefix = z.string().regex(/^agro_business_[a-z][a-z0-9_]{0,32}$/);
interface Models { fields: Model<BusinessDocument>; areas: Model<BusinessDocument> }
const owned = new WeakMap<Connection, Map<string, Models>>();
export function businessCollections(prefix: string) {
  const p = businessPrefix.parse(prefix);
  return { fields: p + '_fields', areas: p + '_areas', controls: p + '_controls' };
}
// Candidate isolated BE10 mapping, NOT a declaration of existing Atlas collections.
export function defineBusinessModels(connection: Connection, prefix: string): Models {
  const n = businessCollections(prefix), cached = owned.get(connection)?.get(prefix);
  if (cached) return cached;
  if (connection.models[n.fields] || connection.models[n.areas]) throw new TypeError('Business namespace already in use');
  const string = { type: String, required: true, cast: false };
  const shape = { _id: string, realm: string, id: string, clientId: string,
    name: { ...string, maxlength: 120 }, description: { type: String, default: null, maxlength: 2000, cast: false },
    active: { type: Boolean, required: true, cast: false },
    createdAt: { type: Date, required: true, cast: false }, updatedAt: { type: Date, required: true, cast: false },
    version: { type: Number, required: true, cast: false, min: 0, max: Number.MAX_SAFE_INTEGER - 1, validate: Number.isSafeInteger } };
  const settings = { strict: 'throw' as const, strictQuery: 'throw' as const, versionKey: false as const,
    autoCreate: false, autoIndex: false, bufferCommands: false, id: false };
  const field = new Schema<BusinessDocument>(shape, settings);
  const area = new Schema<BusinessDocument>({ ...shape, fieldId: string }, settings);
  for (const schema of [field, area]) schema.index({ realm: 1, id: 1 }, { unique: true, name: 'business_id_unique', collation: { locale: 'simple' } });
  field.index({ realm: 1, clientId: 1, active: 1, id: 1 }, { name: 'business_scope_page', collation: { locale: 'simple' } });
  area.index({ realm: 1, clientId: 1, fieldId: 1, active: 1, id: 1 }, { name: 'business_scope_page', collation: { locale: 'simple' } });
  const models = { fields: connection.model(n.fields, field, n.fields), areas: connection.model(n.areas, area, n.areas) };
  let map = owned.get(connection); if (!map) { map = new Map(); owned.set(connection, map); } map.set(prefix, models);
  return models;
}

export async function provisionBusinessCollections(connection: Connection, prefix: string) {
  const n = businessCollections(prefix), db = connection.db;
  if (!db || (await db.listCollections({ name: { $in: Object.values(n) } }).toArray()).length) throw new TypeError('New explicit business namespace required');
  const properties = { _id: { bsonType: 'string' }, realm: { enum: ['test', 'development', 'preview', 'production'] },
    id: { bsonType: 'string' }, clientId: { bsonType: 'string' }, name: { bsonType: 'string', minLength: 1, maxLength: 120 },
    description: { bsonType: ['string', 'null'], maxLength: 2000 }, active: { bsonType: 'bool' },
    createdAt: { bsonType: 'date' }, updatedAt: { bsonType: 'date' }, version: { bsonType: ['int', 'long', 'double'], minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1, multipleOf: 1 } };
  for (const kind of ['fields', 'areas'] as const) {
    const props = kind === 'areas' ? { ...properties, fieldId: { bsonType: 'string' } } : properties;
    await db.createCollection(n[kind], { collation: { locale: 'simple' }, validator: { $jsonSchema: {
      bsonType: 'object', required: Object.keys(props), additionalProperties: false, properties: props } }, validationLevel: 'strict', validationAction: 'error' });
  }
  await db.createCollection(n.controls, { collation: { locale: 'simple' } });
  const models = defineBusinessModels(connection, prefix);
  for (const model of Object.values(models)) await model.createIndexes();
  await db.collection(n.controls).createIndex({ realm: 1, clientId: 1 }, { unique: true, name: 'business_control_unique', collation: { locale: 'simple' } });
}
