import { z } from 'zod';
import type { AuthenticatedIdentity, AuthorizationContext, AuthorizationPorts, ClientId, ScopedResourcePort, UserId } from '../auth/contracts.js';
import { callPort, checkedOutput, epoch, logicalKey } from '../auth/validation.js';
import { ApplicationError } from '../errors/application.error.js';
import { bindClientScopedRepository } from '../repositories/client-scoped.repository.js';

const verificationSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('invalid') }).strict(),
  z.object({ status: z.literal('verified'), subject: logicalKey, sessionReference: logicalKey, expiresAt: epoch }).strict(),
]);
const userSchema = z.object({ userId: logicalKey, active: z.boolean() }).strict().nullable();
const membershipSchema = z.object({ clientId: logicalKey, active: z.boolean() }).strict().nullable();
const sessionSchema = z.union([
  z.object({ status: z.literal('active'), expiresAt: epoch }).strict(),
  z.object({ status: z.enum(['expired', 'revoked', 'missing']) }).strict(),
]);

export interface AuthorizationOptions {
  readonly source: string;
  readonly now?: () => number;
  readonly maxCredentialLength?: number;
}

export function createAuthorizationService(ports: AuthorizationPorts, options: AuthorizationOptions) {
  const sourceResult = logicalKey.safeParse(options?.source);
  if (!sourceResult.success) throw new TypeError('Fuente de identidad no válida.');
  if (typeof ports?.verifier?.verify !== 'function' || typeof ports.identities?.resolve !== 'function' ||
    typeof ports.memberships?.resolve !== 'function' || typeof ports.sessions?.inspect !== 'function' ||
    typeof ports.sessions.revoke !== 'function') throw new TypeError('Puertos de autorización incompletos.');
  const source = sourceResult.data, clock = options.now ?? Date.now;
  const maxCredentialLength = options.maxCredentialLength ?? 8192;
  if (typeof clock !== 'function' || !Number.isSafeInteger(maxCredentialLength) ||
    maxCredentialLength < 1 || maxCredentialLength > 65536) throw new TypeError('Configuración de autorización no válida.');
  const verify = ports.verifier.verify.bind(ports.verifier);
  const resolveUser = ports.identities.resolve.bind(ports.identities);
  const resolveMembership = ports.memberships.resolve.bind(ports.memberships);
  const inspectSession = ports.sessions.inspect.bind(ports.sessions);
  const identities = new WeakMap<AuthenticatedIdentity, { isLive?: () => boolean }>();
  const contexts = new WeakMap<AuthorizationContext, AuthenticatedIdentity>();

  function now() {
    try { return checkedOutput(epoch, clock()); }
    catch { throw new ApplicationError('INTERNAL_ERROR'); }
  }
  function validateCredential(value: unknown): asserts value is string {
    if (typeof value !== 'string' || value.length < 1 || value.length > maxCredentialLength ||
      !/^[A-Za-z0-9._~+/-]+=*$/.test(value)) throw new ApplicationError('UNAUTHENTICATED');
  }
  function assertIdentity(identity: AuthenticatedIdentity): void {
    const record = identities.get(identity);
    if (!record) throw new ApplicationError('UNAUTHENTICATED');
    let live = true;
    try { if (record.isLive) live = record.isLive() === true; }
    catch {
      identities.delete(identity);
      throw new ApplicationError('INTERNAL_ERROR');
    }
    if (!live || identity.expiresAt <= now()) {
      identities.delete(identity);
      throw new ApplicationError('UNAUTHENTICATED');
    }
  }
  function assertContext(context: AuthorizationContext): void {
    const identity = contexts.get(context);
    if (!identity) throw new ApplicationError('FORBIDDEN');
    assertIdentity(identity);
  }
  async function authenticate(credential: string): Promise<AuthenticatedIdentity> {
    validateCredential(credential);
    const verification = checkedOutput(verificationSchema, await callPort(() => verify(credential)));
    if (verification.status !== 'verified' || verification.expiresAt <= now()) throw new ApplicationError('UNAUTHENTICATED');
    const principal = Object.freeze({ source, subject: verification.subject });
    const session = Object.freeze({ source, reference: verification.sessionReference });
    const status = checkedOutput(sessionSchema, await callPort(() => inspectSession(session)));
    if (status.status !== 'active') throw new ApplicationError('UNAUTHENTICATED');
    const expiresAt = Math.min(status.expiresAt, verification.expiresAt);
    if (expiresAt <= now()) throw new ApplicationError('UNAUTHENTICATED');
    const user = checkedOutput(userSchema, await callPort(() => resolveUser(principal)));
    if (!user || !user.active) throw new ApplicationError('FORBIDDEN');
    const authenticatedAt = now();
    if (expiresAt <= authenticatedAt) throw new ApplicationError('UNAUTHENTICATED');
    // Nominal types only aid compilation. The private WeakMap enforces provenance.
    const identity = Object.freeze({ userId: user.userId as UserId, source, authenticatedAt, expiresAt }) as AuthenticatedIdentity;
    identities.set(identity, {});
    return identity;
  }
  async function authorize(identity: AuthenticatedIdentity): Promise<AuthorizationContext> {
    assertIdentity(identity);
    const membership = checkedOutput(membershipSchema, await callPort(() => resolveMembership(identity.userId)));
    assertIdentity(identity);
    if (!membership || !membership.active) throw new ApplicationError('FORBIDDEN');
    const context = Object.freeze({ identity, clientId: membership.clientId as ClientId }) as AuthorizationContext;
    contexts.set(context, identity);
    return context;
  }
  function invalidate(identity: AuthenticatedIdentity): void { identities.delete(identity); }
  function bindToRequest(identity: AuthenticatedIdentity, isLive: () => boolean): void {
    assertIdentity(identity);
    const record = identities.get(identity);
    if (!record || record.isLive || typeof isLive !== 'function') throw new ApplicationError('INTERNAL_ERROR');
    record.isLive = isLive;
  }
  function createScopedRepository(context: AuthorizationContext, port: ScopedResourcePort) {
    assertContext(context);
    return bindClientScopedRepository(() => { assertContext(context); return context.clientId; }, port);
  }
  return Object.freeze({ authenticate, authorize, assertIdentity, assertContext, invalidate, bindToRequest, createScopedRepository });
}

export type AuthorizationService = ReturnType<typeof createAuthorizationService>;
