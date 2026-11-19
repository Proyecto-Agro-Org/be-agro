import { z } from 'zod';
import type { AuthorizationContext } from '../auth/contracts.js';
import type { SessionService } from '../services/session.service.js';
import type { AssociationReadPort, TechnicalDeviceReadPort, TelemetrySourcePolicy, DeviceAssociation } from '../telemetry/association.contracts.js';
import { associationPageSchema, sourcePolicySchema, telemetryRangeRequestSchema, technicalDeviceIdentitySchema } from '../telemetry/association.schemas.js';
import { checkedOutput, callPort } from '../auth/validation.js';
import { safeClock } from '../auth/session-security.js';
import { catalogueRealmSchema } from '../auth/identity-catalogue.schemas.js';
import { ApplicationError } from '../errors/application.error.js';
import { buildIngestMeasurementFilter } from './telemetry-metadata.mapper.js';

// Preparation only: no MongoDB adapter, connection, business model or route.
// Plans must be revalidated at execution in any future read adapter. An approved
// source policy is server evidence/configuration, never a client/payload flag.
export function createAssociatedTelemetryPlanner(sessions: SessionService, context: AuthorizationContext,
  ports: { associations: AssociationReadPort; devices: TechnicalDeviceReadPort }, options: { realm: string;
    sources: readonly TelemetrySourcePolicy[] }, clock: () => number = Date.now) {
  const realm = checkedOutput(catalogueRealmSchema, options.realm), now = safeClock(clock);
  const authorization = sessions.authorization;
  authorization.assertContext(context);
  if (context.identity.source !== 'agro-session:' + realm) throw new ApplicationError('FORBIDDEN');
  const policies = checkedOutput(z.array(sourcePolicySchema).min(1).max(20), options.sources);
  if (new Set(policies.map(p => p.sourceId)).size !== policies.length) throw new ApplicationError('INTERNAL_ERROR');
  const assertContext = authorization.assertContext.bind(authorization), authorize = authorization.authorize.bind(authorization);
  const currentSession = sessions.current.bind(sessions);
  const findSensor = ports.associations.findForSensor.bind(ports.associations);
  const findDeviceWindows = ports.associations.findForDevice.bind(ports.associations);
  const findDevice = ports.devices.findExact.bind(ports.devices);
  const clientId = context.clientId;
  async function refresh() {
    assertContext(context);
    // authorize() on a legacy BE09.1 port need not reread session persistence.
    // Reuse BE09.2 current() to check revocation/version/lease explicitly.
    const current = await currentSession(context);
    if (current.user.client?.id !== clientId) throw new ApplicationError('FORBIDDEN');
    const fresh = await authorize(context.identity);
    assertContext(context); if (fresh.clientId !== clientId) throw new ApplicationError('FORBIDDEN');
  }
  const sameKey = (a: DeviceAssociation['device'], b: DeviceAssociation['device']) => a.kind === b.kind && a.value === b.value;
  const overlaps = (row: DeviceAssociation, from: number, to: number) => row.validFrom < to && (row.validTo === null || row.validTo > from);
  const signature = (rows: DeviceAssociation[]) => JSON.stringify([...rows].sort((a, b) => a.id.localeCompare(b.id)));
  async function history(input: unknown) {
    let request: z.output<typeof telemetryRangeRequestSchema>;
    try { const result = telemetryRangeRequestSchema.safeParse(input); if (!result.success) throw new Error(); request = result.data; }
    catch { throw new ApplicationError('VALIDATION_ERROR'); }
    await refresh();
    const to = Math.min(request.to, now()); if (request.from >= to) return Object.freeze([]);
    const query = Object.freeze({ realm, clientId, fieldId: request.fieldId, areaId: request.areaId,
      sensorId: request.sensorId, from: request.from, to, limit: 65 as const });
    const page = checkedOutput(associationPageSchema, await callPort(() => findSensor(query)));
    if (new Set(page.records.map(r => r.id)).size !== page.records.length) throw new ApplicationError('CONFLICT');
    const plans = [];
    for (const row of page.records) {
      if (row.realm !== realm || row.clientId !== clientId || row.fieldId !== request.fieldId ||
        row.areaId !== request.areaId || row.sensorId !== request.sensorId) throw new ApplicationError('RESOURCE_NOT_FOUND');
      if (!overlaps(row, request.from, to)) throw new ApplicationError('INTERNAL_ERROR');
      const source = policies.find(p => p.sourceId === row.sourceId);
      if (!source || !source.authenticatedIdentity || !source.verifiedTemporalAttribution || row.attribution !== 'verified') throw new ApplicationError('FORBIDDEN');
      if (source.clockId !== row.clockId || source.deviceKind !== row.device.kind) throw new ApplicationError('INTERNAL_ERROR');
      const from = Math.max(row.validFrom, request.from), until = Math.min(to, row.validTo ?? to);
      const identities = checkedOutput(z.array(technicalDeviceIdentitySchema).max(2), await callPort(() => findDevice(Object.freeze({
        sourceId: row.sourceId, device: Object.freeze({ ...row.device }), limit: 2 as const }))));
      if (!identities.length) throw new ApplicationError('RESOURCE_NOT_FOUND');
      if (identities.length !== 1 || identities[0].sourceId !== row.sourceId || !sameKey(identities[0].device, row.device)) throw new ApplicationError('INTERNAL_ERROR');
      const global = checkedOutput(associationPageSchema, await callPort(() => findDeviceWindows(Object.freeze({
        realm, sourceId: row.sourceId, device: Object.freeze({ ...row.device }), from, to: until, limit: 65 as const }))));
      const selected = global.records.filter(other => {
        if (other.realm !== realm || other.sourceId !== row.sourceId || !sameKey(other.device, row.device)) throw new ApplicationError('INTERNAL_ERROR');
        return overlaps(other, from, until);
      });
      if (selected.length !== 1 || signature(selected) !== signature([row])) throw new ApplicationError('CONFLICT');
      plans.push(Object.freeze({ realm, clientId, associationId: row.id, revision: row.revision, sensorId: row.sensorId,
        sourceId: row.sourceId, device: Object.freeze({ ...row.device }), from, to: until,
        filter: buildIngestMeasurementFilter({ deviceField: source.deviceField, device: row.device, from, to: until }),
        sort: Object.freeze({ _receivedAt: -1 as const, _id: -1 as const }), limit: request.limit }));
    }
    const again = checkedOutput(associationPageSchema, await callPort(() => findSensor(query)));
    if (signature(again.records) !== signature(page.records)) throw new ApplicationError('CONFLICT');
    await refresh(); return Object.freeze(plans);
  }
  return Object.freeze({ history });
}
