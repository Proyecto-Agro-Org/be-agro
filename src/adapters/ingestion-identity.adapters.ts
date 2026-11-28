import type { AttributionWindow, ResolvedPhysicalDevice } from '../measurements/contracts.js';
import type { IngestionIdentityStore } from '../iot/ingestion-composition.contracts.js';
import { storedAssociationsResponseSchema, storedDevicesResponseSchema } from '../iot/ingestion-composition.schemas.js';
import type {
  AssociationAtQuery,
  AssociationAtResolution,
  AssociationResolutionPort,
  DeviceResolution,
  DeviceResolutionPort,
  DeviceResolutionQuery,
  TrustGateRealm,
} from '../iot/trust-gate.contracts.js';
import type { TechnicalDeviceKey } from '../telemetry/association.contracts.js';

// Adapters from a realm-scoped IngestionIdentityStore to the BE13-03/BE13-04
// ports and to the BE-12 ports. The realm comes ONLY from the composition
// context passed at construction: it is applied to every store query, and a
// query that names another realm is refused. Each row must carry the context
// realm; a leaked row turns the whole answer into another realm's answer so
// the consumer quarantines it (BE13 ports) or the call fails (BE-12 ports).
// Storage-level realm isolation remains the store implementation's duty.

class RealmLeak extends Error {}

function bindStore(store: IngestionIdentityStore) {
  if (typeof store !== 'object' || store === null || typeof store.findDevicesByKey !== 'function' || typeof store.findAssociationsAt !== 'function')
    throw new TypeError('Identity store required');
  return { findDevicesByKey: store.findDevicesByKey.bind(store), findAssociationsAt: store.findAssociationsAt.bind(store) };
}

async function devicesFor(find: ReturnType<typeof bindStore>, realm: TrustGateRealm, sourceId: string, key: TechnicalDeviceKey) {
  const raw = await find.findDevicesByKey(Object.freeze({ realm, sourceId, key: Object.freeze({ kind: key.kind, value: key.value }), limit: 2 as const }));
  const parsed = storedDevicesResponseSchema.parse(raw);
  const foreign = parsed.realm !== realm ? parsed.realm : parsed.rows.find(row => row.realm !== realm)?.realm;
  return { foreign, rows: parsed.rows };
}

async function associationsFor(find: ReturnType<typeof bindStore>, realm: TrustGateRealm, physicalDeviceId: string, at: number) {
  const raw = await find.findAssociationsAt(Object.freeze({ realm, physicalDeviceId, at, limit: 2 as const }));
  const parsed = storedAssociationsResponseSchema.parse(raw);
  const foreign = parsed.realm !== realm ? parsed.realm : parsed.rows.find(row => row.realm !== realm)?.realm;
  return { foreign, rows: parsed.rows };
}

export function createIngestionIdentityPorts(store: IngestionIdentityStore, realm: TrustGateRealm): {
  readonly devices: DeviceResolutionPort; readonly associations: AssociationResolutionPort;
} {
  const find = bindStore(store);
  const devices: DeviceResolutionPort = Object.freeze({
    async resolve(query: DeviceResolutionQuery): Promise<DeviceResolution> {
      if (query.realm !== realm) throw new RealmLeak();
      const { foreign, rows } = await devicesFor(find, realm, query.sourceId, query.device);
      if (foreign !== undefined) return { realm: foreign, devices: [] };
      return { realm, devices: rows.map(({ realm: _r, ...row }) => row) };
    },
  });
  const associations: AssociationResolutionPort = Object.freeze({
    async findAt(query: AssociationAtQuery): Promise<AssociationAtResolution> {
      if (query.realm !== realm) throw new RealmLeak();
      const { foreign, rows } = await associationsFor(find, realm, query.physicalDeviceId, query.at);
      if (foreign !== undefined) return { realm: foreign, complete: true, records: [] };
      return { realm, complete: true, records: rows.map(({ realm: _r, ...row }) => row) };
    },
  });
  return Object.freeze({ devices, associations });
}

// BE-12 MeasurementAttributionPorts (devices/associations) over the same store.
export function createBe12IdentityPorts(store: IngestionIdentityStore, realm: TrustGateRealm): {
  readonly devices: { findExact(input: { readonly sourceId: string; readonly device: TechnicalDeviceKey; readonly limit: 2 }): Promise<ResolvedPhysicalDevice[]> };
  readonly associations: { findAt(input: { readonly realm: string; readonly physicalDeviceId: string; readonly at: number; readonly limit: 2 }): Promise<AttributionWindow[]> };
} {
  const find = bindStore(store);
  return Object.freeze({
    devices: Object.freeze({ async findExact(input: { sourceId: string; device: TechnicalDeviceKey; limit: 2 }) {
      const { foreign, rows } = await devicesFor(find, realm, input.sourceId, input.device);
      if (foreign !== undefined) throw new RealmLeak();
      return rows.map(row => ({ id: row.id, sourceId: row.sourceId, device: { kind: row.key.kind, value: row.key.value },
        lifecycle: row.lifecycle, verification: row.verification }));
    } }),
    associations: Object.freeze({ async findAt(input: { realm: string; physicalDeviceId: string; at: number; limit: 2 }) {
      if (input.realm !== realm) throw new RealmLeak();
      const { foreign, rows } = await associationsFor(find, realm, input.physicalDeviceId, input.at);
      if (foreign !== undefined) throw new RealmLeak();
      return rows.map(row => ({ id: row.id, revision: row.revision, realm: row.realm, clientId: row.clientId, fieldId: row.fieldId,
        areaId: row.areaId, sensorId: row.sensorId, physicalDeviceId: row.physicalDeviceId, validFrom: row.validFrom, validTo: row.validTo }));
    } }),
  });
}
