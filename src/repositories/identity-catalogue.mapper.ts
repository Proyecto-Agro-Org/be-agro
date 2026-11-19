import type { CatalogueUserDocument, CatalogueClientDocument } from '../models/identity-catalogue.models.js';
import { catalogueUserDocumentSchema, catalogueClientDocumentSchema, managedUserSchema, managedClientSchema,
  catalogueRealmSchema, type ManagedCatalogueUser, type ManagedCatalogueClient } from '../auth/identity-catalogue.schemas.js';
import { checkedOutput } from '../auth/validation.js';

export function fromCatalogueUserDocument(input: unknown): ManagedCatalogueUser {
  const { _id: _key, realm: _realm, ...row } = checkedOutput(catalogueUserDocumentSchema, input);
  const user = checkedOutput(managedUserSchema, { ...row, updatedAt: row.updatedAt.getTime(),
    membership: row.membership ? { ...row.membership, updatedAt: row.membership.updatedAt.getTime() } : null });
  return Object.freeze({ ...user, membership: user.membership ? Object.freeze(user.membership) : null });
}
export function fromCatalogueClientDocument(input: unknown): ManagedCatalogueClient {
  const { _id: _key, realm: _realm, ...row } = checkedOutput(catalogueClientDocumentSchema, input);
  return Object.freeze(checkedOutput(managedClientSchema, { ...row, updatedAt: row.updatedAt.getTime() }));
}
export function toCatalogueUserDocument(input: ManagedCatalogueUser, scope: string): CatalogueUserDocument {
  const row = checkedOutput(managedUserSchema, input), realm = checkedOutput(catalogueRealmSchema, scope);
  return checkedOutput(catalogueUserDocumentSchema, { ...row, realm, _id: realm + ':' + row.id,
    updatedAt: new Date(row.updatedAt), membership: row.membership ? { ...row.membership, updatedAt: new Date(row.membership.updatedAt) } : null });
}
export function toCatalogueClientDocument(input: ManagedCatalogueClient, scope: string): CatalogueClientDocument {
  const row = checkedOutput(managedClientSchema, input), realm = checkedOutput(catalogueRealmSchema, scope);
  return checkedOutput(catalogueClientDocumentSchema, { ...row, realm, _id: realm + ':' + row.id, updatedAt: new Date(row.updatedAt) });
}
