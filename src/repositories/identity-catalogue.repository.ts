import { z } from 'zod';
import type { IdentityCatalogueStore } from '../auth/identity-catalogue.contracts.js';
import type { CatalogueUser, ExternalIdentity, IdentityCatalogue } from '../auth/session.contracts.js';
import { callPort, checkedOutput, logicalKey } from '../auth/validation.js';
import { catalogueUserRecordSchema as userSchema, catalogueClientRecordSchema as clientSchema } from '../auth/identity-catalogue.schemas.js';
import { ApplicationError } from '../errors/application.error.js';

const principalSchema = z.object({ issuer: logicalKey, subject: logicalKey }).strict();

// Read-only adapter. No provisioning, default clients, email lookup, or memory
// fallback. BE09.5 physical catalogue is isolated from agronomic BE02 mappings.
export function createIdentityCatalogue(store: IdentityCatalogueStore, realm: string): IdentityCatalogue {
  if (!['development', 'test', 'preview', 'production'].includes(realm) ||
    typeof store?.findUserByPrincipal !== 'function' || typeof store.findUserById !== 'function' ||
    typeof store.findClientById !== 'function') throw new TypeError('Invalid identity catalogue configuration.');
  const findPrincipal = store.findUserByPrincipal.bind(store), findUser = store.findUserById.bind(store), findClient = store.findClientById.bind(store);
  async function map(input: unknown): Promise<CatalogueUser | null> {
    const user = checkedOutput(userSchema.nullable(), input);
    if (!user) return null;
    let client: CatalogueUser['client'] = null;
    if (user.active && user.membership?.active) {
      const clientId = user.membership.clientId;
      const value = checkedOutput(clientSchema.nullable(), await callPort(() => findClient(Object.freeze({ realm, clientId }))));
      if (value && value.id !== clientId) throw new ApplicationError('INTERNAL_ERROR');
      if (value) {
        // Both absent preserves legacy trusted-port compatibility. Physical
        // catalogue requires both; a mixed or stale generation never authorizes.
        const version = user.membership.clientSecurityVersion;
        const validGeneration = version === value.securityVersion;
        client = Object.freeze({ id: value.id, name: value.name, active: value.active && validGeneration });
      }
    }
    return Object.freeze({ id: user.id, issuer: user.issuer, subject: user.subject, name: user.name, email: user.email,
      active: user.active, securityVersion: user.securityVersion, client });
  }
  return Object.freeze({
    async findByPrincipal(input: Readonly<ExternalIdentity>) {
      const principal = checkedOutput(principalSchema, input);
      const raw = await callPort(() => findPrincipal(Object.freeze({ ...principal, realm })));
      const row = checkedOutput(userSchema.nullable(), raw);
      if (row && (row.issuer !== principal.issuer || row.subject !== principal.subject)) throw new ApplicationError('INTERNAL_ERROR');
      return map(row);
    },
    async findById(input: string) {
      const userId = checkedOutput(logicalKey, input);
      const raw = await callPort(() => findUser(Object.freeze({ realm, userId })));
      const row = checkedOutput(userSchema.nullable(), raw);
      if (row && row.id !== userId) throw new ApplicationError('INTERNAL_ERROR');
      return map(row);
    },
  });
}
