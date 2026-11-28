import type { AuthorizationContext } from './contracts.js';

export interface ExternalIdentity { readonly issuer: string; readonly subject: string }
export type IdentityAssertionResult = { readonly status: 'invalid' } |
  { readonly status: 'verified'; readonly identity: ExternalIdentity };
export interface IdentityAssertionVerifier {
  verify(credential: string, expectedNonceDigest: string): Promise<IdentityAssertionResult>;
}
export interface CatalogueUser {
  readonly id: string; readonly issuer: string; readonly subject: string;
  readonly name: string; readonly email: string; readonly active: boolean;
  readonly securityVersion: number;
  readonly client: { readonly id: string; readonly name: string; readonly active: boolean } | null;
}
export interface IdentityCatalogue {
  findByPrincipal(principal: Readonly<ExternalIdentity>): Promise<CatalogueUser | null>;
  findById(userId: string): Promise<CatalogueUser | null>;
}
export interface LoginChallengeRecord {
  readonly digest: string; readonly nonceDigest: string; readonly realm: string;
  readonly audience: string; readonly expiresAt: number; readonly consumedAt: number | null;
}
export interface AppSessionRecord {
  readonly id: string; readonly digest: string; readonly realm: string;
  readonly userId: string; readonly clientId: string; readonly securityVersion: number;
  readonly createdAt: number; readonly absoluteExpiresAt: number; readonly idleExpiresAt: number;
  readonly revokedAt: number | null;
}
// Persistent, shared and atomic implementations are mandatory for deployment.
// No implementation, Mongo model, or memory store is selected by production code.
export interface SessionRepository {
  insertChallenge(record: Readonly<LoginChallengeRecord>): Promise<void>;
  findChallenge(digest: string, realm: string): Promise<LoginChallengeRecord | null>;
  // Atomic predicate: exact digest/nonce/realm, unconsumed, expiresAt > now.
  consumeChallenge(digest: string, nonceDigest: string, realm: string, now: number): Promise<boolean>;
  insertSession(record: Readonly<AppSessionRecord>): Promise<void>;
  findSessionByDigest(digest: string, realm: string): Promise<AppSessionRecord | null>;
  findSessionById(id: string, realm: string): Promise<AppSessionRecord | null>;
  // Atomic predicate: active and both expirations > now. Never clear revocation.
  // Only idleExpiresAt may change: atomically max(current idle, requested idle),
  // bounded by absoluteExpiresAt. Return this update's snapshot, never lower idle.
  touchSession(id: string, realm: string, now: number, idleExpiresAt: number): Promise<AppSessionRecord | null>;
  // Idempotent durable update for this digest only; rejection means unconfirmed.
  revokeSession(digest: string, realm: string, now: number): Promise<void>;
}
export interface SessionView {
  readonly user: CatalogueUser;
  readonly absoluteExpiresAt: number;
  readonly idleExpiresAt: number;
}
export interface SessionOperations {
  challenge(): Promise<{ challengeId: string; nonce: string; expiresAt: number }>;
  login(credential: string, challengeId: string): Promise<SessionView & { token: string }>;
  current(context: AuthorizationContext): Promise<SessionView>;
  logout(token: string | null): Promise<void>;
}
