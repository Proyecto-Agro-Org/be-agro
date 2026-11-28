import { z } from 'zod';
import { logicalKey, checkedOutput, callPort } from '../auth/validation.js';
import type { ClientId, ResourceId, ScopedResourcePort, ScopedResourceQuery } from '../auth/contracts.js';
import { ApplicationError } from '../errors/application.error.js';

const base = { clientId: logicalKey, id: logicalKey };
const ownership = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('field') }).strict(),
  z.object({ ...base, kind: z.literal('area'), fieldId: logicalKey }).strict(),
  z.object({ ...base, kind: z.literal('device'), fieldId: logicalKey, areaId: logicalKey }).strict(),
  z.object({ ...base, kind: z.literal('measurement'), fieldId: logicalKey, areaId: logicalKey, deviceId: logicalKey }).strict(),
]).nullable();

function resourceId(value: unknown): ResourceId {
  const result = logicalKey.safeParse(value);
  if (!result.success) throw new ApplicationError('VALIDATION_ERROR');
  return result.data as ResourceId;
}

// Internal composition helper. getScope must be a server capability validator,
// never a closure over a client-provided entity ID. The public service supplies it.
export function bindClientScopedRepository(getScope: () => ClientId, port: ScopedResourcePort) {
  if (typeof getScope !== 'function' || typeof port?.findResource !== 'function') {
    throw new TypeError('Scoped resource port no válido.');
  }
  const find = port.findResource.bind(port);
  async function read(query: ScopedResourceQuery) {
    if (getScope() !== query.clientId) throw new ApplicationError('FORBIDDEN');
    const raw = await callPort(() => find(Object.freeze(query)));
    getScope(); // A request may have expired/closed while the port was pending.
    const record = checkedOutput(ownership, raw);
    if (!record) throw new ApplicationError('RESOURCE_NOT_FOUND');
    if (record.kind !== query.kind || record.id !== query.id || record.clientId !== query.clientId ||
      ('fieldId' in query && (!('fieldId' in record) || record.fieldId !== query.fieldId)) ||
      ('areaId' in query && (!('areaId' in record) || record.areaId !== query.areaId)) ||
      ('deviceId' in query && (!('deviceId' in record) || record.deviceId !== query.deviceId))) {
      throw new ApplicationError('RESOURCE_NOT_FOUND');
    }
    getScope();
    return Object.freeze(record);
  }
  async function getField(id: unknown) {
    const key = resourceId(id);
    return read({ kind: 'field', clientId: getScope(), id: key });
  }
  async function getArea(fieldId: unknown, id: unknown) {
    const field = resourceId(fieldId), key = resourceId(id);
    await getField(field);
    return read({ kind: 'area', clientId: getScope(), fieldId: field, id: key });
  }
  async function getDevice(fieldId: unknown, areaId: unknown, id: unknown) {
    const field = resourceId(fieldId), area = resourceId(areaId), key = resourceId(id);
    await getArea(field, area);
    return read({ kind: 'device', clientId: getScope(), fieldId: field, areaId: area, id: key });
  }
  async function getMeasurement(fieldId: unknown, areaId: unknown, deviceId: unknown, id: unknown) {
    const field = resourceId(fieldId), area = resourceId(areaId), device = resourceId(deviceId), key = resourceId(id);
    await getDevice(field, area, device);
    return read({ kind: 'measurement', clientId: getScope(), fieldId: field, areaId: area, deviceId: device, id: key });
  }
  return Object.freeze({ getField, getArea, getDevice, getMeasurement });
}
