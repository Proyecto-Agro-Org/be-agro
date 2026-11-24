import { z } from 'zod';
import { catalogueRealmSchema } from '../auth/identity-catalogue.schemas.js';
import type { QuarantineLease } from '../iot/ingestion-recovery.contracts.js';
import type { OperationsTimeAuthority, ReplayLeasePolicy } from '../iot/operations-security-policy.contracts.js';
import type { TrustGateRealm } from '../iot/trust-gate.contracts.js';
import { DEFAULT_AUTHORITY_TIMEOUT_MS, runBounded } from './authority-call.js';

// BE13-10B — shared, fail-closed evaluation of replay leases. Used by the operations service (runtime) and by the
// BE13-10A policy bundle, so both read time and lease decisions with the SAME strict schemas.
// - Time comes ONLY from the injected OperationsTimeAuthority (no wall-clock read here).
// - A lease is EXPIRED only on an explicit, well-formed, same-realm EXPIRED decision under trusted time that also
//   allows recovery by a non-owner. Anything else — throw, timeout, malformed, untrusted, other realm, unknown — is ACTIVE.
// - No duration is chosen here: the decision belongs to the injected ReplayLeasePolicy.

const revision = z.number().int().min(0);
const instant = z.number().int().min(0).max(8.64e15);

export const timeAuthorityResultSchema = z.discriminatedUnion('status', [
  z.object({ realm: catalogueRealmSchema, status: z.literal('trusted'), at: instant, authorityRevision: revision }).strict(),
  z.object({ realm: catalogueRealmSchema, status: z.literal('untrusted') }).strict(),
]);
export const leasePolicyDecisionSchema = z.object({ realm: catalogueRealmSchema, status: z.enum(['ACTIVE', 'EXPIRED']),
  recoveryByNonOwner: z.enum(['never', 'when-expired']), policyRevision: revision }).strict();

async function bounded<S extends z.ZodType>(schema: S, operation: () => unknown): Promise<z.output<S> | null> {
  try {
    const parsed = schema.safeParse(await runBounded(operation, DEFAULT_AUTHORITY_TIMEOUT_MS));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

export async function readTrustedTime(timeAuthority: OperationsTimeAuthority, realm: TrustGateRealm): Promise<number | null> {
  const t = await bounded(timeAuthorityResultSchema, () => timeAuthority.now(Object.freeze({ realm })));
  return t && t.realm === realm && t.status === 'trusted' ? t.at : null;
}

export type ReplayLeaseExpiry =
  | { readonly status: 'EXPIRED'; readonly now: number; readonly policyRevision: number }
  | { readonly status: 'ACTIVE'; readonly basis: 'time-untrusted' | 'policy-unavailable' | 'policy-active' | 'recovery-not-allowed' };

export async function evaluateReplayLeaseExpiry(input: { realm: TrustGateRealm; timeAuthority: OperationsTimeAuthority; leasePolicy: ReplayLeasePolicy;
  quarantineId: string; lease: QuarantineLease }): Promise<ReplayLeaseExpiry> {
  const { realm, quarantineId, lease } = input;
  const now = await readTrustedTime(input.timeAuthority, realm);
  if (now === null) return Object.freeze({ status: 'ACTIVE', basis: 'time-untrusted' });
  // The BE13-10A ReplayLease shape: the policy sees the owner, the acquisition instant and the fencing token.
  const view = Object.freeze({ realm, quarantineId, leaseId: `lease:${lease.token}`, ownerOperatorId: lease.ownerId, acquiredAt: lease.acquiredAt,
    state: 'ACTIVE' as const, version: lease.token });
  const decision = await bounded(leasePolicyDecisionSchema, () => input.leasePolicy.evaluate(Object.freeze({ realm, lease: view, now })));
  if (!decision || decision.realm !== realm) return Object.freeze({ status: 'ACTIVE', basis: 'policy-unavailable' });
  if (decision.status !== 'EXPIRED') return Object.freeze({ status: 'ACTIVE', basis: 'policy-active' });
  if (decision.recoveryByNonOwner !== 'when-expired') return Object.freeze({ status: 'ACTIVE', basis: 'recovery-not-allowed' });
  return Object.freeze({ status: 'EXPIRED', now, policyRevision: decision.policyRevision });
}
