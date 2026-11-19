import { z } from 'zod';
import type { IdentityCatalogueStore } from '../auth/identity-catalogue.contracts.js';
import type { CatalogueUser, ExternalIdentity, IdentityCatalogue } from '../auth/session.contracts.js';
import { callPort, checkedOutput, epoch, logicalKey } from '../auth/validation.js';
import { ApplicationError } from '../errors/application.error.js';

const userSchema = z.object({ id: logicalKey, issuer: logicalKey, subject: logicalKey,
  name: logicalKey, email: z.email().max(320), active: z.boolean(), securityVersion: z.number().int().nonnegative().safe(), updatedAt: epoch,
  membership: z.object({ clientId: logicalKey, active: z.boolean(), updatedAt: epoch }).strict().nullable(),
}).strict().refine(user => !user.membership || user.membership.updatedAt <= user.updatedAt);
const clientSchema = z.object({ id: logicalKey, name: logicalKey, active: z.boolean(), updatedAt: epoch }).strict();
const principalSchema = z.object({ issuer: logicalKey, subject: logicalKey }).strict();

// Read-only adapter. No provisioning, default clients, email lookup, or memory
// fallback. Physical store implementation remains gated on BE-02 approval.
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
      if (value) client = Object.freeze({ id: value.id, name: value.name, active: value.active });
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
