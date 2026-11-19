import { Schema, type Connection, type Model } from 'mongoose';
import { validateAuthenticationPersistenceConfig, type AuthenticationPersistenceConfig } from '../config/authentication-persistence.js';
import { catalogueClientDocumentSchema, catalogueUserDocumentSchema } from '../auth/identity-catalogue.schemas.js';

export interface CatalogueMembershipDocument {
  clientId: string; active: boolean; updatedAt: Date; clientSecurityVersion: number;
}
export interface CatalogueUserDocument {
  _id: string; realm: string; id: string; issuer: string; subject: string; name: string; email: string;
  active: boolean; securityVersion: number; updatedAt: Date; membership: CatalogueMembershipDocument | null;
}
export interface CatalogueClientDocument {
  _id: string; realm: string; id: string; name: string; active: boolean; updatedAt: Date; securityVersion: number;
}
interface CatalogueModels { users: Model<CatalogueUserDocument>; clients: Model<CatalogueClientDocument> }
const owned = new WeakMap<Connection, Map<string, CatalogueModels>>();
// Explicit isolated authentication catalogue, NOT the approved agronomic Cliente.
// Model definition performs no connect, DDL, seeding or provisioning.
export function defineIdentityCatalogueModels(connection: Connection, options: AuthenticationPersistenceConfig): CatalogueModels {
  const { collectionPrefix: prefix } = validateAuthenticationPersistenceConfig(options);
  const found = owned.get(connection)?.get(prefix); if (found) return found;
  const names = { users: prefix + '_users', clients: prefix + '_clients' };
  if (connection.models[names.users] || connection.models[names.clients]) throw new TypeError('Catalogue model namespace already in use.');
  const settings = { autoCreate: false, autoIndex: false, bufferCommands: false, versionKey: false as const,
    strict: 'throw' as const, strictQuery: 'throw' as const, id: false };
  const string = { type: String, required: true, cast: false };
  const version = { type: Number, required: true, cast: false, min: 0, max: Number.MAX_SAFE_INTEGER,
    validate: Number.isSafeInteger };
  const date = { type: Date, required: true, cast: false };
  const boolean = { type: Boolean, required: true, cast: false };
  const membership = new Schema<CatalogueMembershipDocument>({ clientId: string, active: boolean,
    updatedAt: date, clientSecurityVersion: version }, { ...settings, _id: false });
  const users = new Schema<CatalogueUserDocument>({ _id: string, realm: string, id: string, issuer: string,
    subject: string, name: string, email: string, active: boolean, securityVersion: version, updatedAt: date,
    membership: { type: membership, default: undefined } }, settings);
  const clients = new Schema<CatalogueClientDocument>({ _id: string, realm: string, id: string, name: string,
    active: boolean, updatedAt: date, securityVersion: version }, settings);
  users.pre('validate', function () {
    if (!catalogueUserDocumentSchema.safeParse(this.toObject()).success) throw new TypeError('Invalid catalogue user record.');
  });
  clients.pre('validate', function () {
    if (!catalogueClientDocumentSchema.safeParse(this.toObject()).success) throw new TypeError('Invalid catalogue client record.');
  });
  users.index({ realm: 1, id: 1 }, { unique: true, name: 'auth_user_id_unique', collation: { locale: 'simple' } });
  users.index({ realm: 1, issuer: 1, subject: 1 }, { unique: true, name: 'auth_principal_unique', collation: { locale: 'simple' } });
  users.index({ realm: 1, 'membership.clientId': 1, id: 1 }, { name: 'auth_membership_lookup', collation: { locale: 'simple' } });
  clients.index({ realm: 1, id: 1 }, { unique: true, name: 'auth_client_id_unique', collation: { locale: 'simple' } });
  const result = Object.freeze({ users: connection.model(names.users, users, names.users), clients: connection.model(names.clients, clients, names.clients) });
  let cache = owned.get(connection); if (!cache) { cache = new Map(); owned.set(connection, cache); } cache.set(prefix, result);
  return result;
}
