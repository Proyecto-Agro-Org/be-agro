import type { ErrorRequestHandler } from 'express';

// Final owned boundary: prevent Express finalhandler from logging an Error/stack.
// Upstream handlers already emitted a safe diagnostic. Never pass an Error to destroy.
export const terminalErrorHandler: ErrorRequestHandler = (_error: unknown, _request, response, _next) => {
  if (response.writableEnded || response.destroyed) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.status(500).json({ error: 'Internal server error' });
};
