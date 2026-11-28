import { z } from 'zod';
import type { AuthorizationContext, AuthorizationPorts, SessionReference } from '../auth/contracts.js';
import type { AppSessionRecord, CatalogueUser, IdentityAssertionVerifier, IdentityCatalogue, SessionRepository, SessionView } from '../auth/session.contracts.js';
import { digestSecret, isOpaqueSecret, newOpaqueSecret, safeClock } from '../auth/session-security.js';
import { assertionResultSchema, catalogueUserSchema, challengeRecordSchema, sessionRecordSchema } from '../auth/session.schemas.js';
import { callPort, checkedOutput, epoch } from '../auth/validation.js';
import { validateAuthenticationConfig, type AuthenticationConfig } from '../config/authentication.js';
import { ApplicationError } from '../errors/application.error.js';
import { createAuthorizationService } from './authorization.service.js';

export function createSessionService(ports: { repository: SessionRepository; catalogue: IdentityCatalogue; verifier: IdentityAssertionVerifier },
  options: AuthenticationConfig, clock: () => number = Date.now) {
  const config = validateAuthenticationConfig(options), now = safeClock(clock);
  const source = 'agro-session:' + config.realm;
  // Snapshot trusted ports; there is no default memory repository or fake verifier.
  const repository = ports.repository;
  const bind = <K extends keyof SessionRepository>(key: K): SessionRepository[K] => {
    if (typeof repository?.[key] !== 'function') throw new TypeError('Incomplete session repository.');
    return repository[key].bind(repository) as SessionRepository[K];
  };
  const insertChallenge = bind('insertChallenge'), findChallenge = bind('findChallenge'), consumeChallenge = bind('consumeChallenge');
  const insertSession = bind('insertSession'), findDigest = bind('findSessionByDigest'), findId = bind('findSessionById');
  const touch = bind('touchSession'), revoke = bind('revokeSession');
  if (typeof ports.catalogue?.findById !== 'function' || typeof ports.catalogue.findByPrincipal !== 'function' || typeof ports.verifier?.verify !== 'function') throw new TypeError('Incomplete identity ports.');
  const findUser = ports.catalogue.findById.bind(ports.catalogue);
  const findPrincipal = ports.catalogue.findByPrincipal.bind(ports.catalogue);
  const verify = ports.verifier.verify.bind(ports.verifier);
  const expiry = (at: number, ttl: number) => checkedOutput(epoch, at + ttl);
  async function user(id: string) {
    const value = checkedOutput(catalogueUserSchema.nullable(), await callPort(() => findUser(id)));
    if (value && value.id !== id) throw new ApplicationError('INTERNAL_ERROR');
    return value;
  }
  function active(record: AppSessionRecord, at = now()) {
    return record.realm === config.realm && record.revokedAt === null && record.createdAt <= at &&
      record.absoluteExpiresAt > at && record.idleExpiresAt > at;
  }
  function bound(record: AppSessionRecord, value: CatalogueUser | null): value is CatalogueUser {
    return !!value?.active && !!value.client?.active && value.id === record.userId &&
      value.client.id === record.clientId && value.securityVersion === record.securityVersion;
  }
  function sameBinding(left: AppSessionRecord, right: AppSessionRecord) {
    return left.id === right.id && left.digest === right.digest && left.realm === right.realm &&
      left.userId === right.userId && left.clientId === right.clientId && left.securityVersion === right.securityVersion &&
      left.createdAt === right.createdAt && left.absoluteExpiresAt === right.absoluteExpiresAt;
  }
  async function recordById(id: string) {
    const record = checkedOutput(sessionRecordSchema.nullable(), await callPort(() => findId(id, config.realm)));
    if (record && (record.id !== id || record.realm !== config.realm)) throw new ApplicationError('INTERNAL_ERROR');
    return record;
  }
  async function recordByToken(token: unknown) {
    if (!isOpaqueSecret(token)) return null;
    const digest = digestSecret(token);
    const record = checkedOutput(sessionRecordSchema.nullable(), await callPort(() => findDigest(digest, config.realm)));
    if (record && (record.digest !== digest || record.realm !== config.realm)) throw new ApplicationError('INTERNAL_ERROR');
    return record;
  }
  const authPorts: AuthorizationPorts = {
    verifier: { async verify(token) {
      const record = await recordByToken(token);
      if (!record || !active(record) || !bound(record, await user(record.userId))) return { status: 'invalid' };
      const at = now();
      const idleExpiresAt = Math.min(record.absoluteExpiresAt, expiry(at, config.idleTtlMs));
      const touched = checkedOutput(sessionRecordSchema.nullable(), await callPort(() => touch(record.id, config.realm, at,
        idleExpiresAt)));
      if (!touched || !active(touched)) return { status: 'invalid' };
      // Another request may already have extended idle further. A persistent
      // atomic max must preserve that activity, within the current policy bound.
      const latestIdleBound = Math.min(record.absoluteExpiresAt, expiry(now(), config.idleTtlMs));
      if (!sameBinding(touched, record) || touched.idleExpiresAt < Math.max(record.idleExpiresAt, idleExpiresAt) ||
        touched.idleExpiresAt > latestIdleBound) throw new ApplicationError('INTERNAL_ERROR');
      return { status: 'verified', subject: touched.userId, sessionReference: touched.id,
        expiresAt: Math.min(touched.idleExpiresAt, touched.absoluteExpiresAt) };
    } },
    identities: { async resolve(principal) {
      if (principal.source !== source) return null;
      const value = await user(principal.subject);
      return value ? { userId: value.id, active: value.active } : null;
    } },
    sessions: { async inspect(reference) {
      if (reference.source !== source) return { status: 'missing' };
      const record = await recordById(reference.reference);
      if (!record) return { status: 'missing' };
      if (!active(record) || !bound(record, await user(record.userId))) return { status: 'revoked' };
      if (!active(record)) return { status: 'expired' };
      return { status: 'active', expiresAt: Math.min(record.idleExpiresAt, record.absoluteExpiresAt) };
    }, async revoke(reference) {
      if (reference.source !== source) return;
      const record = await recordById(reference.reference);
      if (record) await callPort(() => revoke(record.digest, config.realm, now()));
    } },
    sessionMemberships: { async resolve(userId, reference: SessionReference) {
      if (reference.source !== source) return { status: 'invalid-session' };
      const record = await recordById(reference.reference);
      if (!record || record.userId !== userId || !active(record)) return { status: 'invalid-session' };
      const value = await user(userId);
      if (!bound(record, value) || !active(record)) return { status: 'invalid-session' };
      return { status: 'authorized', membership: { clientId: record.clientId, active: true } };
    } },
  };
  const authorization = createAuthorizationService(authPorts, { source, now });
  async function view(record: AppSessionRecord): Promise<SessionView> {
    const value = await user(record.userId);
    if (!active(record) || !bound(record, value)) throw new ApplicationError('UNAUTHENTICATED');
    return Object.freeze({ user: Object.freeze({ ...value, client: value.client ? Object.freeze({ ...value.client }) : null }),
      absoluteExpiresAt: record.absoluteExpiresAt, idleExpiresAt: record.idleExpiresAt });
  }
  async function challenge() {
    const challengeId = newOpaqueSecret(), nonce = newOpaqueSecret(), expiresAt = expiry(now(), config.challengeTtlMs);
    await callPort(() => insertChallenge(Object.freeze({ digest: digestSecret(challengeId), nonceDigest: digestSecret(nonce),
      realm: config.realm, audience: config.audience, expiresAt, consumedAt: null })));
    if (expiresAt <= now()) throw new ApplicationError('UNAUTHENTICATED');
    return Object.freeze({ challengeId, nonce, expiresAt });
  }
  async function login(credential: string, challengeId: string) {
    if (!isOpaqueSecret(challengeId) || typeof credential !== 'string' || credential.length < 1 || credential.length > 8192) throw new ApplicationError('UNAUTHENTICATED');
    const digest = digestSecret(challengeId);
    const attempt = checkedOutput(challengeRecordSchema.nullable(), await callPort(() => findChallenge(digest, config.realm)));
    if (attempt && (attempt.digest !== digest || attempt.realm !== config.realm)) throw new ApplicationError('INTERNAL_ERROR');
    if (!attempt || attempt.audience !== config.audience || attempt.consumedAt !== null || attempt.expiresAt <= now()) throw new ApplicationError('UNAUTHENTICATED');
    const assertion = checkedOutput(assertionResultSchema, await callPort(() => verify(credential, attempt.nonceDigest)));
    if (assertion.status !== 'verified') throw new ApplicationError('UNAUTHENTICATED');
    const principal = Object.freeze({ ...assertion.identity });
    const value = checkedOutput(catalogueUserSchema.nullable(), await callPort(() => findPrincipal(principal)));
    if (value && (value.issuer !== principal.issuer || value.subject !== principal.subject)) throw new ApplicationError('INTERNAL_ERROR');
    if (!value?.active || !value.client?.active) throw new ApplicationError('FORBIDDEN');
    if (attempt.expiresAt <= now()) throw new ApplicationError('UNAUTHENTICATED');
    const consumed = checkedOutput(z.boolean(), await callPort(() => consumeChallenge(digest, attempt.nonceDigest, config.realm, now())));
    if (!consumed || attempt.expiresAt <= now()) throw new ApplicationError('UNAUTHENTICATED');
    const token = newOpaqueSecret(), at = now();
    const absoluteExpiresAt = expiry(at, config.absoluteTtlMs);
    const record = Object.freeze({ id: newOpaqueSecret(), digest: digestSecret(token), realm: config.realm,
      userId: value.id, clientId: value.client.id, securityVersion: value.securityVersion, createdAt: at,
      absoluteExpiresAt, idleExpiresAt: Math.min(absoluteExpiresAt, expiry(at, config.idleTtlMs)), revokedAt: null });
    await callPort(() => insertSession(record));
    const persisted = await recordByToken(token);
    if (!persisted || !sameBinding(persisted, record) || persisted.idleExpiresAt !== record.idleExpiresAt) throw new ApplicationError('INTERNAL_ERROR');
    return Object.freeze({ ...await view(persisted), token });
  }
  async function current(context: AuthorizationContext): Promise<SessionView> {
    authorization.assertContext(context);
    const reference = authorization.getSessionReference(context.identity);
    const record = await recordById(reference.reference);
    if (!record || record.userId !== context.identity.userId || record.clientId !== context.clientId) throw new ApplicationError('UNAUTHENTICATED');
    const result = await view(record);
    authorization.assertContext(context);
    return result;
  }
  async function logout(token: string | null): Promise<void> {
    if (!isOpaqueSecret(token)) return;
    await callPort(() => revoke(digestSecret(token), config.realm, now()));
  }
  return Object.freeze({ challenge, login, current, logout, authorization, allowedOrigins: config.allowedOrigins });
}
export type SessionService = ReturnType<typeof createSessionService>;
