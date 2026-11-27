import { Router, type Request } from 'express';
import { EVENT_ID_PATTERN, type ConfirmationScope, type IngestConfirmationService } from '../iot/ingest-confirmation.contracts.js';

// BE13-11J — HTTP reconciliation endpoint (LOCAL prototype). NOT mounted by app.ts and refuses to be built unless it is explicitly TEST_ONLY.
// The caller's scope (realm + sourceId) is derived by the SERVER from the authenticated principal; nothing in the path, query or body can widen it.
// Unknown, foreign and never-published eventIds are indistinguishable (same `not-found` answer), so existence of another tenant's event is not revealed.

export interface ConfirmationPrincipalAuthority {
  /** Authenticates the request (credentials checked by the host). null = unauthenticated. */
  authenticate(request: Request): Promise<string | null>;
  /** Maps an authenticated principal to its authorized scope. null = no scope (denied). */
  scopeOf(principal: string): Promise<ConfirmationScope | null>;
}

export function createIngestConfirmationRouter(options: { mode: 'TEST_ONLY'; service: IngestConfirmationService; authority: ConfirmationPrincipalAuthority }): Router {
  if (options.mode !== 'TEST_ONLY') throw new TypeError('INGEST_CONFIRMATION_ROUTER_TEST_ONLY');   // fail closed: no productive mode is decided
  const router = Router();
  router.get('/ingest-confirmations/:eventId', async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    try {
      const principal = await options.authority.authenticate(request);
      if (principal === null) { response.status(401).json({ error: 'unauthenticated' }); return; }
      const scope = await options.authority.scopeOf(principal);
      if (scope === null) { response.status(403).json({ error: 'forbidden' }); return; }
      const eventId = request.params.eventId;
      if (typeof eventId !== 'string' || !EVENT_ID_PATTERN.test(eventId)) { response.status(400).json({ error: 'invalid-event-id' }); return; }
      const c = await options.service.confirm(scope, eventId);
      response.status(200).json({ eventId: c.eventId, status: c.status, confirmed: c.confirmed, evidenceVersion: c.evidenceVersion, deliveries: c.deliveries, durableAt: c.durableAt });
    } catch {
      response.status(503).json({ error: 'unavailable' });                    // the publisher must NOT read this as success
    }
  });
  return router;
}
