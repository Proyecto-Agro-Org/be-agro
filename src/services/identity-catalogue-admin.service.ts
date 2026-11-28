import { z } from 'zod';
import type { IdentityCatalogueAdministrationStore, CatalogueSessionInvalidator } from '../auth/identity-catalogue-admin.contracts.js';
import { managedUserSchema, managedClientSchema, securityVersionSchema, catalogueRealmSchema,
  catalogueWriteReceiptSchema, catalogueRevocationReceiptSchema,
  type ManagedCatalogueUser, type ManagedCatalogueClient } from '../auth/identity-catalogue.schemas.js';
import { checkedOutput, logicalKey } from '../auth/validation.js';
import { safeClock } from '../auth/session-security.js';
import { ApplicationError, isApplicationErrorCode, type ApplicationErrorCode } from '../errors/application.error.js';

const change = z.object({ userId: logicalKey, expectedVersion: securityVersionSchema }).strict();
const membershipChange = change.extend({ clientId: logicalKey.nullable() });
const userState = change.extend({ active: z.boolean() });
const clientState = z.object({ clientId: logicalKey, expectedVersion: securityVersionSchema, active: z.boolean() }).strict();
const newUser = z.object({ id: logicalKey, issuer: z.literal('https://accounts.google.com'), subject: logicalKey,
  name: logicalKey, email: z.email().max(320), clientId: logicalKey.nullable() }).strict();
const newClient = z.object({ id: logicalKey, name: logicalKey }).strict();

// Internal service only: no controllers, endpoints, provider provisioning or
// default store. Caller must supply trusted administrative ports explicitly.
export function createIdentityCatalogueAdministration(ports: { store: IdentityCatalogueAdministrationStore;
  invalidator: CatalogueSessionInvalidator }, scope: string, clock: () => number = Date.now) {
  const realm = checkedOutput(catalogueRealmSchema, scope), now = safeClock(clock);
  const store = ports.store;
  for (const name of ['findUser', 'findClient', 'insertUser', 'insertClient', 'replaceUser', 'replaceClient'] as const)
    if (typeof store?.[name] !== 'function') throw new TypeError('Catalogue administration ports required.');
  if (typeof ports.invalidator?.revokeBeforeVersion !== 'function') throw new TypeError('Session invalidator required.');
  if (store.realm !== realm || ports.invalidator.realm !== realm) throw new TypeError('Catalogue administrative realm mismatch.');
  const findUser = store.findUser.bind(store), findClient = store.findClient.bind(store);
  const insertUser = store.insertUser.bind(store), insertClient = store.insertClient.bind(store);
  const replaceUser = store.replaceUser.bind(store), replaceClient = store.replaceClient.bind(store);
  const revoke = ports.invalidator.revokeBeforeVersion.bind(ports.invalidator);
  async function invoke<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error: unknown) {
      // Preserve typed domain conflicts, but never retain the thrown object/cause.
      let code: ApplicationErrorCode = 'DEPENDENCY_UNAVAILABLE';
      try {
        if (error instanceof ApplicationError) {
          const own = Object.getOwnPropertyDescriptor(error, 'code');
          if (own && 'value' in own && isApplicationErrorCode(own.value)) code = own.value;
        }
      } catch { /* Proxies/getters in a failed port are not trusted diagnostics. */ }
      throw new ApplicationError(code);
    }
  }
  async function user(id: string) {
    const row = checkedOutput(managedUserSchema.nullable(), await invoke(() => findUser(id)));
    if (!row) throw new ApplicationError('RESOURCE_NOT_FOUND');
    if (row.id !== id) throw new ApplicationError('INTERNAL_ERROR'); return row;
  }
  async function client(id: string) {
    const row = checkedOutput(managedClientSchema.nullable(), await invoke(() => findClient(id)));
    if (!row) throw new ApplicationError('RESOURCE_NOT_FOUND');
    if (row.id !== id) throw new ApplicationError('INTERNAL_ERROR'); return row;
  }
  const nextVersion = (version: number) => checkedOutput(securityVersionSchema, version + 1);
  const at = (previous: number) => { const value = now(); if (value < previous) throw new ApplicationError('INTERNAL_ERROR'); return value; };
  async function membership(id: string | null, time: number) {
    if (id === null) return null;
    const value = await client(id); if (!value.active) throw new ApplicationError('FORBIDDEN');
    return { clientId: value.id, active: true, updatedAt: time, clientSecurityVersion: value.securityVersion };
  }
  async function cleanup(userId: string, version: number) {
    // Authorization was invalidated BEFORE cleanup. Failure is explicit and
    // retryable; it never rolls back version/active/membership or reports success.
    const checkpoint = Object.freeze({ realm, userId, beforeVersion: version });
    try {
      const receipt = checkedOutput(catalogueRevocationReceiptSchema, await revoke(realm, userId, version, now()));
      if (receipt.realm !== realm || receipt.userId !== userId || receipt.beforeVersion !== version) throw new ApplicationError('INTERNAL_ERROR');
      return Object.freeze({ revocation: 'confirmed' as const, checkpoint });
    } catch { return Object.freeze({ revocation: 'pending' as const, checkpoint }); }
  }
  async function update(before: ManagedCatalogueUser, patch: Partial<Pick<ManagedCatalogueUser, 'active' | 'membership'>>) {
    const after = checkedOutput(managedUserSchema, { ...before, ...patch, securityVersion: nextVersion(before.securityVersion), updatedAt: at(before.updatedAt) });
    if (!checkedOutput(z.boolean(), await invoke(() => replaceUser(before, after)))) throw new ApplicationError('CONFLICT');
    const cleanupResult = await cleanup(after.id, after.securityVersion);
    return Object.freeze({ user: Object.freeze({ ...after, membership: after.membership ? Object.freeze(after.membership) : null }), ...cleanupResult });
  }
  return Object.freeze({
    async createClient(input: unknown) {
      const value = checkedOutput(newClient, input);
      const row: ManagedCatalogueClient = { ...value, active: true, updatedAt: now(), securityVersion: 0 };
      const receipt = checkedOutput(catalogueWriteReceiptSchema, await invoke(() => insertClient(row)));
      if (receipt.realm !== realm || receipt.id !== row.id) throw new ApplicationError('INTERNAL_ERROR');
      return Object.freeze(row);
    },
    async createUser(input: unknown) {
      const { clientId, ...value } = checkedOutput(newUser, input), time = now();
      const row = checkedOutput(managedUserSchema, { ...value, active: true, securityVersion: 0,
        updatedAt: time, membership: await membership(clientId, time) });
      const receipt = checkedOutput(catalogueWriteReceiptSchema, await invoke(() => insertUser(row)));
      if (receipt.realm !== realm || receipt.id !== row.id) throw new ApplicationError('INTERNAL_ERROR');
      return Object.freeze({ ...row, membership: row.membership ? Object.freeze(row.membership) : null });
    },
    async changeMembership(input: unknown) {
      const value = checkedOutput(membershipChange, input), before = await user(value.userId);
      if (before.securityVersion !== value.expectedVersion) throw new ApplicationError('CONFLICT');
      return update(before, { membership: await membership(value.clientId, at(before.updatedAt)) });
    },
    async setUserActive(input: unknown) {
      const value = checkedOutput(userState, input), before = await user(value.userId);
      if (before.securityVersion !== value.expectedVersion) throw new ApplicationError('CONFLICT');
      return update(before, { active: value.active });
    },
    async invalidateUser(input: unknown) {
      const value = checkedOutput(change, input), before = await user(value.userId);
      if (before.securityVersion !== value.expectedVersion) throw new ApplicationError('CONFLICT');
      return update(before, {});
    },
    async setClientActive(input: unknown) {
      const value = checkedOutput(clientState, input), before = await client(value.clientId);
      if (before.securityVersion !== value.expectedVersion) throw new ApplicationError('CONFLICT');
      // Every disable/re-enable increments generation in ONE client CAS. Existing
      // memberships stay stale until explicitly relinked by a versioned user CAS.
      const after = { ...before, active: value.active, updatedAt: at(before.updatedAt), securityVersion: nextVersion(before.securityVersion) };
      if (!checkedOutput(z.boolean(), await invoke(() => replaceClient(before, after)))) throw new ApplicationError('CONFLICT');
      return Object.freeze(after);
    },
    async retryRevocation(input: unknown) {
      const value = checkedOutput(z.object({ userId: logicalKey, version: securityVersionSchema }).strict(), input);
      const row = await user(value.userId);
      if (value.version > row.securityVersion) throw new ApplicationError('CONFLICT');
      return cleanup(row.id, value.version);
    },
  });
}
