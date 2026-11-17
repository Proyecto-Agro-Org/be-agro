import type { Express, RequestHandler } from 'express';
import type { createRequestObservability } from './request-observability.js';
import { ApplicationError } from '../errors/application.error.js';
import { legacyNotFound } from '../middlewares/not-found.middleware.js';
import { terminalErrorHandler } from '../middlewares/terminal-error.middleware.js';

// Own the last dispatch callback as well as the middleware boundary. Repeated
// next(error) can exhaust the stack; Express's default callback logs raw Errors.
// Keep the Express app/export and delegate routing to the original implementation.
export function protectApplication(
  app: Express,
  observability: ReturnType<typeof createRequestObservability>,
  notFound: RequestHandler = legacyNotFound,
): void {
  if (!('handle' in app) || typeof app.handle !== 'function') {
    throw new TypeError('Express dispatch no disponible.');
  }
  // Express 5 implements handle(req, res, next), but its Application declarations
  // omit it. This is the single runtime-checked integration assertion.
  const target = app as Express & { handle: RequestHandler };
  const dispatch = target.handle.bind(app);
  target.handle = (request, response, next) => {
    dispatch(request, response, (error: unknown) => {
      const failed = error !== undefined && error !== null;
      if (failed) observability.logError(request, response, 500, 'INTERNAL_ERROR');
      if (typeof next === 'function') {
        // Preserve embedding callbacks, but never propagate the original payload.
        next(failed ? new ApplicationError('INTERNAL_ERROR') : undefined);
        return;
      }
      if (response.writableEnded || response.destroyed) return;
      if (failed || response.headersSent) {
        terminalErrorHandler(undefined, request, response, () => {});
      } else {
        notFound(request, response, () => {
          terminalErrorHandler(undefined, request, response, () => {});
        });
      }
    });
  };
}
