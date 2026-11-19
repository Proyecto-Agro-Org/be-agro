import type { ExternalIdentity } from './session.contracts.js';

// Logical read contracts, NOT an approved BSON/collection mapping for BE-02.
export interface CatalogueUserRecord extends ExternalIdentity {
  readonly id: string; readonly name: string; readonly email: string; readonly active: boolean;
  readonly securityVersion: number; readonly updatedAt: number;
  readonly membership: { readonly clientId: string; readonly active: boolean; readonly updatedAt: number } | null;
}
export interface CatalogueClientRecord {
  readonly id: string; readonly name: string; readonly active: boolean; readonly updatedAt: number;
}
export interface IdentityCatalogueStore {
  // Physical store must guarantee scoped uniqueness (or reject ambiguity), never
  // silently choose the first duplicate principal/user/client. Reader cannot
  // discover hidden duplicates from a single returned record; BE-02 gate remains.
  findUserByPrincipal(query: Readonly<ExternalIdentity & { realm: string }>): Promise<CatalogueUserRecord | null>;
  findUserById(query: Readonly<{ realm: string; userId: string }>): Promise<CatalogueUserRecord | null>;
  findClientById(query: Readonly<{ realm: string; clientId: string }>): Promise<CatalogueClientRecord | null>;
}
