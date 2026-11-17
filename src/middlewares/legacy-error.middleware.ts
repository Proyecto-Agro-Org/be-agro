import type { ErrorRequestHandler } from 'express';

interface LegacyError {
  statusCode?: number;
}

// Preserve the inherited convention; this assertion is not runtime validation.
// A uniform error contract and additional hardening belong to BE-08.
export const legacyErrorHandler: ErrorRequestHandler = (
  error: unknown, _request, response, _next,
) => {
  const statusCode = (error as LegacyError).statusCode ?? 500;

  if (statusCode >= 500) {
    console.error(error);
  }

  response.status(statusCode).json({
    error:
      statusCode === 403
        ? 'Origin not allowed by CORS'
        : 'Internal server error',
  });
};
