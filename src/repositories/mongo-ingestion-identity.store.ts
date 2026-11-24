import type { Connection } from 'mongoose';
import { z } from 'zod';
import { catalogueRealmSchema } from '../auth/identity-catalogue.schemas.js';
import type { IngestionIdentityStore, StoredDeviceAssociation, StoredPhysicalDevice } from '../iot/ingestion-composition.contracts.js';
import { storedDeviceAssociationSchema, storedPhysicalDeviceSchema } from '../iot/ingestion-composition.schemas.js';
import type { TrustGateRealm } from '../iot/trust-gate.contracts.js';
import { sensorCollections } from '../models/sensor.models.js';
import { technicalDeviceKeySchema } from '../telemetry/association.schemas.js';
import { epoch, logicalKey } from '../auth/validation.js';

// BE13-06 (C3) — MongoDB IngestionIdentityStore over the BE-11 collections.
// Reads the same documents BE-11 writes (DeviceDocument / AssociationDocument)
// without going around BE-11 semantics: no writes, no client scoping from the
// payload, and the realm is ALWAYS part of the query filter (never a
// post-filter). Results are bounded (limit 2) so ambiguity is reported, never
// resolved by picking the first row.
export interface IdentityCollections {
  readonly devices: { find(filter: object, options: object): { limit(n: number): { toArray(): Promise<unknown[]> } } };
  readonly associations: { find(filter: object, options: object): { sort(sort: object): { limit(n: number): { toArray(): Promise<unknown[]> } } } };
}

const deviceQuerySchema = z.object({ realm: catalogueRealmSchema, sourceId: logicalKey, key: technicalDeviceKeySchema, limit: z.literal(2) }).strict();
const associationQuerySchema = z.object({ realm: catalogueRealmSchema, physicalDeviceId: logicalKey, at: epoch, limit: z.literal(2) }).strict();
const READ_OPTIONS = Object.freeze({ maxTimeMS: 3000, collation: { locale: 'simple' } });

const time = (value: unknown) => (value instanceof Date && Number.isSafeInteger(value.getTime()) ? value.getTime() : undefined);

function mapDevice(row: unknown): StoredPhysicalDevice {
  const d = row as Record<string, unknown>;
  return storedPhysicalDeviceSchema.parse({ realm: d.realm, id: d.id, sourceId: d.sourceId, key: { kind: d.keyKind, value: d.keyValue },
    verification: d.verification, lifecycle: d.lifecycle, version: d.version, createdAt: time(d.createdAt), updatedAt: time(d.updatedAt) });
}

function mapAssociation(row: unknown): StoredDeviceAssociation {
  const a = row as Record<string, unknown>;
  return storedDeviceAssociationSchema.parse({ realm: a.realm, id: a.id, revision: a.revision, clientId: a.clientId, sensorId: a.sensorId,
    fieldId: a.fieldId, areaId: a.areaId, physicalDeviceId: a.physicalDeviceId, sourceId: a.sourceId, device: { kind: a.keyKind, value: a.keyValue },
    validFrom: time(a.validFrom), validTo: a.validTo === null ? null : time(a.validTo), state: a.state, auditReason: a.auditReason });
}

// Query builders are exported so the realm-in-filter property is testable offline.
export function deviceFilter(realm: TrustGateRealm, sourceId: string, key: { kind: string; value: string }) {
  return { realm, sourceId, keyKind: key.kind, keyValue: key.value };
}
export function associationAtFilter(realm: TrustGateRealm, physicalDeviceId: string, at: number) {
  const instant = new Date(at);
  // [validFrom, validTo): validFrom <= at AND (validTo IS NULL OR at < validTo)
  return { realm, physicalDeviceId, validFrom: { $lte: instant }, $or: [{ validTo: null }, { validTo: { $gt: instant } }] };
}

export function createIngestionIdentityStoreFromCollections(collections: IdentityCollections): IngestionIdentityStore {
  const { devices, associations } = collections;
  return Object.freeze({
    async findDevicesByKey(input: unknown) {
      const q = deviceQuerySchema.parse(input);
      // Malformed stored documents throw: callers quarantine (fail closed).
      const rows = (await devices.find(deviceFilter(q.realm, q.sourceId, q.key), READ_OPTIONS).limit(q.limit).toArray()).map(mapDevice);
      return { realm: q.realm, rows };
    },
    async findAssociationsAt(input: unknown) {
      const q = associationQuerySchema.parse(input);
      const rows = (await associations.find(associationAtFilter(q.realm, q.physicalDeviceId, q.at), READ_OPTIONS)
        .sort({ validFrom: 1, id: 1 }).limit(q.limit).toArray()).map(mapAssociation);
      return { realm: q.realm, complete: true as const, rows };
    },
  }) as IngestionIdentityStore;
}

export function createMongoIngestionIdentityStore(options: { connection: Connection; sensorPrefix: string; businessPrefix: string }): IngestionIdentityStore {
  const db = options.connection.db;
  if (!db) throw new TypeError('Connected MongoDB database required');
  const names = sensorCollections(options.sensorPrefix, options.businessPrefix);
  return createIngestionIdentityStoreFromCollections({
    devices: db.collection(names.devices) as unknown as IdentityCollections['devices'],
    associations: db.collection(names.associations) as unknown as IdentityCollections['associations'],
  });
}
