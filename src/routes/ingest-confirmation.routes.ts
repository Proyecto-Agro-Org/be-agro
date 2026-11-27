import { Router, type ErrorRequestHandler, type Request } from 'express';
import type { RateLimiter } from '../iot/confirmation-rate-limit.js';
import { EVENT_ID_PATTERN, PAYLOAD_SHA256_PATTERN, type ConfirmationScope, type IngestConfirmationService, type IngestConfirmationStatus } from '../iot/ingest-confirmation.contracts.js';

// BE13-11M — HTTP reconciliation endpoint. A ROUTER FACTORY only: it is not mounted by app.ts and cannot be built with the productive defaults.
//   * auth: an injected port. The productive default is BLOCKED (no technology is chosen); a BLOCKED authority or a BLOCKED rate-limit policy makes construction throw.
//   * the caller's scope (realm + sourceId [+ principalReference]) is derived by the SERVER from the authenticated principal; no header, path, query or body can widen it.
//   * unknown, foreign and never-published eventIds are indistinguishable (same `not-found`), so another tenant's existence is not revealed.
//   * `conflict` is a domain answer (HTTP 200) that never carries the stored hash.
export interface ConfirmationPrincipalAuthority {
  readonly kind?: 'BLOCKED' | 'TEST_ONLY' | 'APPROVED';
  /** Authenticates the request (credentials checked by the host). null = unauthenticated. */
  authenticate(request: Request): Promise<string | null>;
  /** Maps an authenticated principal to its authorized scope. null = no scope (denied). */
  scopeOf(principal: string): Promise<ConfirmationScope | null>;
}
/** Productive default: nothing authenticates. A router cannot be composed with it. */
export const BLOCKED_CONFIRMATION_AUTHORITY: ConfirmationPrincipalAuthority = Object.freeze({ kind: 'BLOCKED', authenticate: async () => null, scopeOf: async () => null });

export type ConfirmationOutcome = 'ok' | 'unauthenticated' | 'forbidden' | 'invalid-input' | 'rate-limited' | 'uri-too-long' | 'error';
/** Safe, payload-free audit/metric record. No hash, no principal secret, no raw input. */
export interface ConfirmationAuditEvent { readonly outcome: ConfirmationOutcome; readonly status?: IngestConfirmationStatus; readonly sourceId?: string; readonly eventId?: string }
export const MAX_CONFIRMATION_URL_LENGTH = 1024;

export function createIngestConfirmationRouter(options: { mode: 'TEST_ONLY' | 'APPROVED'; service: IngestConfirmationService; authority: ConfirmationPrincipalAuthority; rateLimiter: RateLimiter;
  onEvent?: (event: ConfirmationAuditEvent) => void }): Router {
  if (options.mode !== 'TEST_ONLY' && options.mode !== 'APPROVED') throw new TypeError('INGEST_CONFIRMATION_ROUTER_TEST_ONLY');          // fail closed: any other mode
  if (!options.authority || options.authority.kind === 'BLOCKED') throw new TypeError('INGEST_CONFIRMATION_AUTH_BLOCKED');
  if (!options.rateLimiter || options.rateLimiter.policy.mode === 'BLOCKED') throw new TypeError('INGEST_CONFIRMATION_RATE_POLICY_BLOCKED');
  if (options.mode === 'APPROVED' && (options.authority.kind !== 'APPROVED' || options.rateLimiter.policy.mode !== 'APPROVED')) throw new TypeError('INGEST_CONFIRMATION_NOT_APPROVED');
  const emit = (event: ConfirmationAuditEvent) => { try { options.onEvent?.(Object.freeze(event)); } catch { /* an observer can never change the answer */ } };
  const router = Router();
  router.get('/ingest-confirmations/:eventId', async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    try {
      if (request.originalUrl.length > MAX_CONFIRMATION_URL_LENGTH) { emit({ outcome: 'uri-too-long' }); response.status(414).json({ error: 'uri-too-long' }); return; }
      const principal = await options.authority.authenticate(request);
      const limit = options.rateLimiter.consume(principal);
      if (!limit.allowed) { emit({ outcome: 'rate-limited' }); response.setHeader('Retry-After', String(Math.max(1, Math.ceil(limit.retryAfterMs / 1000)))); response.status(429).json({ error: 'rate-limited' }); return; }
      if (principal === null) { emit({ outcome: 'unauthenticated' }); response.status(401).json({ error: 'unauthenticated' }); return; }
      const scope = await options.authority.scopeOf(principal);
      if (scope === null) { emit({ outcome: 'forbidden' }); response.status(403).json({ error: 'forbidden' }); return; }
      const eventId = request.params.eventId, sha = request.query.payloadSha256;
      if (typeof eventId !== 'string' || !EVENT_ID_PATTERN.test(eventId)) { emit({ outcome: 'invalid-input', sourceId: scope.sourceId }); response.status(400).json({ error: 'invalid-event-id' }); return; }
      if (typeof sha !== 'string' || !PAYLOAD_SHA256_PATTERN.test(sha)) { emit({ outcome: 'invalid-input', sourceId: scope.sourceId, eventId }); response.status(400).json({ error: 'invalid-payload-sha256' }); return; }
      const c = await options.service.confirm(scope, eventId, sha);
      emit({ outcome: 'ok', status: c.status, sourceId: scope.sourceId, eventId });
      response.status(200).json({ eventId: c.eventId, status: c.status, confirmed: c.confirmed, evidenceVersion: c.evidenceVersion, deliveries: c.deliveries, durableAt: c.durableAt });
    } catch {
      emit({ outcome: 'error' });
      response.status(503).json({ error: 'unavailable' });                    // the publisher must NOT read this as success
    }
  });
  // Malformed percent-encoding etc. must never surface a stack trace or an HTML page.
  const safeErrors: ErrorRequestHandler = (_error, _request, response, _next) => { emit({ outcome: 'invalid-input' }); response.status(400).json({ error: 'invalid-request' }); };
  router.use(safeErrors);
  return router;
}
