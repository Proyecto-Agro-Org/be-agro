import type { ManagedCatalogueClient, ManagedCatalogueUser, CatalogueWriteReceipt, CatalogueRevocationReceipt } from './identity-catalogue.schemas.js';

// Trusted internal administrative ports. Never exposed through HTTP or selected by env.
export interface IdentityCatalogueAdministrationStore {
  readonly realm: string;
  findUser(id: string): Promise<ManagedCatalogueUser | null>;
  findClient(id: string): Promise<ManagedCatalogueClient | null>;
  insertUser(user: ManagedCatalogueUser): Promise<CatalogueWriteReceipt>;
  insertClient(client: ManagedCatalogueClient): Promise<CatalogueWriteReceipt>;
  replaceUser(before: ManagedCatalogueUser, after: ManagedCatalogueUser): Promise<boolean>;
  replaceClient(before: ManagedCatalogueClient, after: ManagedCatalogueClient): Promise<boolean>;
}
export interface CatalogueSessionInvalidator {
  readonly realm: string;
  revokeBeforeVersion(realm: string, userId: string, version: number, at: number): Promise<CatalogueRevocationReceipt>;
}
