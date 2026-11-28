import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import type { IdentityAssertionVerifier } from '../auth/session.contracts.js';
import { digestSecret, safeClock, sameDigest } from '../auth/session-security.js';
import { logicalKey } from '../auth/validation.js';
import { ApplicationError } from '../errors/application.error.js';

const headerSchema = z.object({ alg: z.literal('RS256'), kid: logicalKey, typ: z.literal('JWT').optional() }).strict();
const claimsSchema = z.object({
  iss: z.enum(['accounts.google.com', 'https://accounts.google.com']),
  sub: logicalKey, aud: z.string(), exp: z.number().int().positive(), iat: z.number().int().positive(),
  nbf: z.number().int().nonnegative().optional(), azp: z.string().optional(),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  email: z.email().optional(), email_verified: z.boolean().optional(),
});
export interface GoogleIdentityOptions {
  readonly audience: string;
  readonly now?: () => number;
  readonly clockSkewMs?: number;
  // Trusted server-side dependency injection, never HTTP/env-selected mocks.
  readonly fetchCertificates?: () => Promise<Record<string, string>>;
}
export function createGoogleIdentityVerifier(options: GoogleIdentityOptions): IdentityAssertionVerifier {
  if (!/^[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(options.audience) || options.audience.length > 256) throw new TypeError('Invalid Google audience.');
  const audience = options.audience, now = safeClock(options.now);
  const skew = options.clockSkewMs ?? 60000;
  if (!Number.isSafeInteger(skew) || skew < 0 || skew > 60000) throw new TypeError('Invalid clock skew.');
  const client = new OAuth2Client({ transporterOptions: { timeout: 3000, retry: false } });
  // The SDK supplies retry:true per request, overriding transporter defaults.
  // Apply the policy after merging, including retryConfig which Gaxios also uses.
  client.transporter.interceptors.request.add({ resolved: async request => {
    request.retry = false;
    request.retryConfig = { ...request.retryConfig, retry: 0, noResponseRetries: 0, totalTimeout: 3000 };
    return request;
  } });
  const certificates = options.fetchCertificates ?? (async () => {
    const result = await client.getFederatedSignonCertsAsync();
    return z.record(z.string(), z.string()).parse(result.certs);
  });
  let fetching: Promise<Record<string, string>> | undefined;
  function keys() {
    // Coalesce concurrent fetches; the official client maintains certificate cache.
    if (!fetching) fetching = Promise.resolve().then(certificates).then(value => {
      const parsed = z.record(logicalKey, z.string().min(1).max(16384)).safeParse(value);
      if (!parsed.success || Object.keys(parsed.data).length > 100) throw new Error();
      return parsed.data;
    }).catch(() => { throw new ApplicationError('DEPENDENCY_UNAVAILABLE'); }).finally(() => { fetching = undefined; });
    return fetching;
  }
  return Object.freeze({ async verify(credential: string, expectedNonceDigest: string) {
    if (typeof credential !== 'string' || credential.length > 8192 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(credential) ||
      !/^[a-f0-9]{64}$/.test(expectedNonceDigest)) return { status: 'invalid' as const };
    let kid: string;
    try {
      const header = headerSchema.safeParse(JSON.parse(Buffer.from(credential.split('.')[0], 'base64url').toString('utf8')));
      if (!header.success) return { status: 'invalid' as const };
      kid = header.data.kid;
    } catch { return { status: 'invalid' as const }; }
    const certs = await keys();
    if (!Object.hasOwn(certs, kid)) return { status: 'invalid' as const };
    let payload: unknown;
    try {
      const ticket = await client.verifySignedJwtWithCertsAsync(credential, certs, audience,
        ['accounts.google.com', 'https://accounts.google.com'], 86400);
      payload = ticket.getPayload();
    } catch { return { status: 'invalid' as const }; } // SDK errors can contain the entire token.
    const parsed = claimsSchema.safeParse(payload);
    if (!parsed.success) return { status: 'invalid' as const };
    const p = parsed.data, time = now();
    if (p.aud !== audience || (p.azp !== undefined && p.azp !== audience) ||
      p.exp * 1000 <= time - skew || p.iat * 1000 > time + skew || p.exp <= p.iat ||
      p.exp * 1000 > time + 86400000 || (p.nbf !== undefined && p.nbf * 1000 > time + skew) ||
      (p.email !== undefined && p.email_verified !== true) || !sameDigest(digestSecret(p.nonce), expectedNonceDigest)) {
      return { status: 'invalid' as const };
    }
    return { status: 'verified' as const, identity: Object.freeze({ issuer: 'https://accounts.google.com', subject: p.sub }) };
  } });
}
