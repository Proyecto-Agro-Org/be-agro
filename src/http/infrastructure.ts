import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import { ApplicationError, describeApplicationError } from '../errors/application.error.js';
import { describeHttpError, legacyShapeErrorResponse, type ErrorResponseAdapter } from './error-response.js';
import { createRequestObservability, type LogSink } from './request-observability.js';
import { safeNotFound } from '../middlewares/not-found.middleware.js';
import { terminalErrorHandler } from '../middlewares/terminal-error.middleware.js';
import { protectApplication } from './protect-application.js';
import type { Express } from 'express';

export interface HttpInfrastructureOptions {
  readonly logger?: LogSink;
  readonly errorResponse?: ErrorResponseAdapter;
  readonly bodyLimitBytes?: number;
}

export function createHttpInfrastructure(options: HttpInfrastructureOptions = {}) {
  const observability = createRequestObservability(options.logger);
  const adapter = options.errorResponse ?? legacyShapeErrorResponse;
  const limit = options.bodyLimitBytes ?? 16384;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1048576) {
    throw new TypeError('Límite JSON no válido.');
  }
  const securityHeaders: RequestHandler = (_request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    next();
  };
  const parser = express.json({ limit, strict: true, inflate: false,
    type: ['application/json', 'application/*+json'] });
  const jsonBody: RequestHandler = (request, response, next) => {
    const hasBody = request.headers['transfer-encoding'] !== undefined ||
      (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0');
    if (hasBody && !request.is(['application/json', 'application/*+json'])) {
      next(new ApplicationError('UNSUPPORTED_MEDIA_TYPE'));
      return;
    }
    parser(request, response, next);
  };
  const errorHandler: ErrorRequestHandler = async (error: unknown, request, response, next) => {
    let safe = describeHttpError(error);
    const requestId = observability.getRequestId(request, response);
    if (response.headersSent) {
      observability.logError(request, response, safe.status, safe.code);
      next(Object.assign(new Error(safe.message), { statusCode: safe.status }));
      return;
    }
    if (response.writableEnded || response.destroyed) return;
    let body: unknown;
    try { body = await adapter(safe, requestId); }
    catch {
      safe = describeApplicationError('INTERNAL_ERROR');
      body = legacyShapeErrorResponse(safe, requestId);
    }
    // Serialize inside the boundary: a broken adapter can also throw in toJSON.
    let serialized: string | undefined;
    try { serialized = JSON.stringify(body); }
    catch { /* Fall back below without exposing serializer diagnostics. */ }
    if (serialized === undefined) {
      safe = describeApplicationError('INTERNAL_ERROR');
      serialized = JSON.stringify({ error: safe.message });
    }
    observability.logError(request, response, safe.status, safe.code);
    if (response.writableEnded || response.destroyed) return;
    // An async adapter or its serializer may have allowed headers to be sent
    // after the initial check. Delegate instead of throwing ERR_HTTP_HEADERS_SENT.
    if (response.headersSent) {
      next(Object.assign(new Error(safe.message), { statusCode: safe.status }));
      return;
    }
    response.status(safe.status).type('application/json').send(serialized);
  };
  return { requestContext: observability.middleware, securityHeaders, jsonBody, notFound: safeNotFound,
    errorHandler, terminalErrorHandler, routeLabel: observability.routeLabel,
    protectApplication: (app: Express) => protectApplication(app, observability, (_request, response) => {
      response.status(404).json({ error: 'Resource not found' });
    }) };
}

export type HttpInfrastructure = ReturnType<typeof createHttpInfrastructure>;
