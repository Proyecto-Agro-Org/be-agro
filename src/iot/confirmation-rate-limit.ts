// BE13-11M — rate limiting ABSTRACTION for the reconciliation query. No limit value is approved: the productive default is BLOCKED (a router cannot be built with it).
// The 11K proposal (10 req/s sustained, burst 50 per principal) is only a PROPOSED value used by tests/campaigns through an explicit TEST_ONLY policy.
export type RateLimitPolicy =
  | { readonly mode: 'BLOCKED'; readonly reason: 'rate-limit-policy-not-decided' }
  | { readonly mode: 'TEST_ONLY' | 'APPROVED'; readonly perPrincipalRatePerSecond: number; readonly perPrincipalBurst: number; readonly globalRatePerSecond: number; readonly globalBurst: number; readonly maxKeys: number };
export const DEFAULT_RATE_LIMIT_POLICY: RateLimitPolicy = Object.freeze({ mode: 'BLOCKED', reason: 'rate-limit-policy-not-decided' });
/** PROPOSED (BE13-11K), NOT approved. Exposed only so a TEST_ONLY composition can opt in explicitly. */
export const PROPOSED_TEST_RATE_LIMIT: Exclude<RateLimitPolicy, { mode: 'BLOCKED' }> = Object.freeze({ mode: 'TEST_ONLY', perPrincipalRatePerSecond: 10, perPrincipalBurst: 50, globalRatePerSecond: 200, globalBurst: 400, maxKeys: 10_000 });

export interface RateLimiter {
  readonly policy: RateLimitPolicy;
  /** `principal` is the authenticated principal, or null for requests that did not authenticate (they share ONE bucket). */
  consume(principal: string | null): { readonly allowed: boolean; readonly retryAfterMs: number };
}

export function createTokenBucketRateLimiter(policy: RateLimitPolicy, clock: () => number = Date.now): RateLimiter {
  if (policy.mode === 'BLOCKED') throw new TypeError('RATE_LIMIT_POLICY_BLOCKED');
  const ok = (n: number, lo: number, hi: number) => Number.isFinite(n) && n >= lo && n <= hi;
  if (!ok(policy.perPrincipalRatePerSecond, 0.01, 100_000) || !ok(policy.perPrincipalBurst, 1, 1_000_000) || !ok(policy.globalRatePerSecond, 0.01, 1_000_000) || !ok(policy.globalBurst, 1, 1_000_000) || !ok(policy.maxKeys, 1, 1_000_000)) throw new TypeError('RATE_LIMIT_POLICY_INVALID');
  type Bucket = { tokens: number; at: number };
  const buckets = new Map<string, Bucket>(); let global: Bucket = { tokens: policy.globalBurst, at: clock() };
  const take = (b: Bucket, rate: number, burst: number, now: number) => {
    b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * rate); b.at = now;
    if (b.tokens >= 1) { b.tokens -= 1; return 0; }
    return Math.ceil(((1 - b.tokens) / rate) * 1000);
  };
  return Object.freeze({ policy, consume(principal: string | null) {
    const now = clock(), key = principal === null ? '\u0000unauthenticated' : 'p:' + principal;
    let b = buckets.get(key);
    if (!b) { if (buckets.size >= policy.maxKeys) buckets.delete(buckets.keys().next().value as string); b = { tokens: policy.perPrincipalBurst, at: now }; }   // bounded memory: oldest key evicted
    buckets.delete(key); buckets.set(key, b);                                                                                                         // most-recently-used last
    const waitOwn = take(b, policy.perPrincipalRatePerSecond, policy.perPrincipalBurst, now);
    if (waitOwn > 0) return { allowed: false, retryAfterMs: waitOwn };
    const waitGlobal = take(global, policy.globalRatePerSecond, policy.globalBurst, now);
    if (waitGlobal > 0) { b.tokens += 1; return { allowed: false, retryAfterMs: waitGlobal }; }                                                      // refund: the global cap refused it
    return { allowed: true, retryAfterMs: 0 };
  } });
}
