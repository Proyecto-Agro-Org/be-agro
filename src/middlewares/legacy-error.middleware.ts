import type { ErrorRequestHandler } from 'express';
import { createRequestObservability } from '../http/request-observability.js';

function getLegacyStatus(error: unknown): number {
  try {
    if (typeof error === 'object' && error !== null && 'statusCode' in error) {
      const status = (error as { statusCode: unknown }).statusCode;
      if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599) {
        return status;
      }
    }
  } catch { /* Untrusted getters must not escape the HTTP error boundary. */ }
  return 500;
}

// Keep the legacy HTTP envelope; the logging contract intentionally excludes raw errors.
export function createLegacyErrorHandler(
  observability = createRequestObservability(record => console.error(JSON.stringify(record))),
): ErrorRequestHandler {
  return (error: unknown, request, response, next) => {
    const statusCode = getLegacyStatus(error);
    const message = statusCode === 403 ? 'Origin not allowed by CORS' : 'Internal server error';

    if (statusCode >= 500) {
      observability.logError(request, response, statusCode, 'INTERNAL_ERROR');
    }

    if (response.headersSent) {
      next(Object.assign(new Error(message), { statusCode }));
      return;
    }
    if (response.writableEnded || response.destroyed) return;
    response.status(statusCode).json({ error: message });
  };
}

export const legacyErrorHandler = createLegacyErrorHandler();
