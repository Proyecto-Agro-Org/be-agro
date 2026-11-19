// Logical application keys, not a declaration of MongoDB BSON types or collections.
declare const userKey: unique symbol;
declare const clientKey: unique symbol;
declare const resourceKey: unique symbol;
declare const identityKey: unique symbol;
declare const contextKey: unique symbol;
export type UserId = string & { readonly [userKey]: true };
export type ClientId = string & { readonly [clientKey]: true };
export type ResourceId = string & { readonly [resourceKey]: true };

export interface VerifiedPrincipal { readonly source: string; readonly subject: string }
export interface SessionReference { readonly source: string; readonly reference: string }
export type CredentialVerification =
  | { readonly status: 'invalid' }
  | { readonly status: 'verified'; readonly subject: string; readonly sessionReference: string; readonly expiresAt: number };
export interface ResolvedUser { readonly userId: string; readonly active: boolean }
export interface ResolvedMembership { readonly clientId: string; readonly active: boolean }
export type SessionStatus =
  | { readonly status: 'active'; readonly expiresAt: number }
  | { readonly status: 'expired' | 'revoked' | 'missing' };

// These are trusted server ports. No real adapter or environment-selected fake exists.
// Runtime validation of their output cannot replace cryptographic verification.
export interface CredentialVerifier { verify(credential: string): Promise<CredentialVerification> }
export interface IdentityResolver { resolve(principal: VerifiedPrincipal): Promise<ResolvedUser | null> }
export interface MembershipResolver { resolve(userId: UserId): Promise<ResolvedMembership | null> }
export type SessionMembershipResolution =
  | { readonly status: 'authorized'; readonly membership: ResolvedMembership }
  | { readonly status: 'invalid-session' | 'no-membership' };
export interface SessionBoundMembershipResolver {
  resolve(userId: UserId, session: SessionReference): Promise<SessionMembershipResolution>;
}
export interface SessionLifecycle {
  inspect(session: SessionReference): Promise<SessionStatus>;
  revoke(session: SessionReference): Promise<void>;
}
interface AuthorizationBasePorts {
  readonly verifier: CredentialVerifier;
  readonly identities: IdentityResolver;
  readonly sessions: SessionLifecycle;
}
// Existing consumers remain supported; real sessions must choose the bound port.
export type AuthorizationPorts = AuthorizationBasePorts & (
  | { readonly memberships: MembershipResolver; readonly sessionMemberships?: never }
  | { readonly sessionMemberships: SessionBoundMembershipResolver; readonly memberships?: never }
);

export interface AuthenticatedIdentity {
  readonly [identityKey]: true;
  readonly userId: UserId;
  readonly source: string;
  readonly authenticatedAt: number;
  readonly expiresAt: number;
}
export interface AuthorizationContext {
  readonly [contextKey]: true;
  readonly identity: AuthenticatedIdentity;
  readonly clientId: ClientId;
}
export type AuthenticationState = 'unauthenticated' | 'authenticated' | 'authorized';

interface QueryBase { readonly clientId: ClientId; readonly id: ResourceId }
export type ScopedResourceQuery =
  | (QueryBase & { readonly kind: 'field' })
  | (QueryBase & { readonly kind: 'area'; readonly fieldId: ResourceId })
  | (QueryBase & { readonly kind: 'device'; readonly fieldId: ResourceId; readonly areaId: ResourceId })
  | (QueryBase & { readonly kind: 'measurement'; readonly fieldId: ResourceId; readonly areaId: ResourceId; readonly deviceId: ResourceId });

// Ownership references only, not domain documents or HTTP response DTOs.
export type ResourceOwnership = ScopedResourceQuery;
export interface ScopedResourcePort {
  findResource(query: Readonly<ScopedResourceQuery>): Promise<ResourceOwnership | null>;
}
