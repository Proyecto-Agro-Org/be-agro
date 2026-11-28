import { mongo } from 'mongoose';
import { z } from 'zod';
import type { TechnicalDeviceKey } from '../telemetry/association.contracts.js';
import { sourcePolicySchema, technicalDeviceKeySchema, persistedKeySchema } from '../telemetry/association.schemas.js';
import { checkedOutput, epoch } from '../auth/validation.js';
import { ApplicationError } from '../errors/application.error.js';

const bsonId = z.union([z.instanceof(mongo.ObjectId), z.string().min(1).max(256)]);
const received = z.instanceof(Date).refine(value => epoch.safeParse(value.getTime()).success);
// Metadata-only mapper. It never spreads raw IoT bodies or invents units/readings.
// The caller must establish provenance separately; _receivedAt alone does not
// prove an authenticated sensor or ownership of a commercial client.
export function mapIngestMeasurementMetadata(input: unknown, fieldInput: unknown, keyInput: TechnicalDeviceKey) {
  const field = checkedOutput(sourcePolicySchema.shape.deviceField, fieldInput);
  const expected = checkedOutput(technicalDeviceKeySchema, keyInput);
  const row = checkedOutput(z.object({ _id: bsonId, _receivedAt: received,
    clientid: z.unknown().optional(), device_id: z.unknown().optional() }), input);
  const actual = checkedOutput(z.string().min(1).max(256), row[field]);
  if (actual !== expected.value) throw new ApplicationError('RESOURCE_NOT_FOUND');
  const id = row._id;
  const measurementId = checkedOutput(persistedKeySchema, id instanceof mongo.ObjectId
    ? { kind: 'object-id', value: id.toHexString() } : { kind: 'string', value: id });
  return Object.freeze({ measurementId: Object.freeze(measurementId), device: Object.freeze({ ...expected }),
    receivedAt: row._receivedAt.getTime() });
}

// Bounded predicate only; NOT an authorization capability and never a DB call.
export function buildIngestMeasurementFilter(input: unknown) {
  const value = checkedOutput(z.object({ deviceField: sourcePolicySchema.shape.deviceField, device: technicalDeviceKeySchema,
    from: epoch, to: epoch }).strict().refine(row => row.from < row.to), input);
  const field = value.deviceField;
  return { [field]: { $eq: value.device.value }, _receivedAt: { $gte: new Date(value.from), $lt: new Date(value.to) },
    $expr: { $and: [{ $eq: [{ $type: '$' + field }, 'string'] },
      { $eq: ['$' + field, { $literal: value.device.value }] }, { $eq: [{ $type: '$_receivedAt' }, 'date'] }] } };
}
