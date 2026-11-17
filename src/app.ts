import express from 'express';
import { getAllowedOrigins } from './config/cors.js';
import { createCorsMiddleware } from './middlewares/cors.middleware.js';
import { createLegacyErrorHandler } from './middlewares/legacy-error.middleware.js';
import { createHealthRouter } from './routes/health.routes.js';
import type { HttpInfrastructure } from './http/infrastructure.js';
import { legacyNotFound } from './middlewares/not-found.middleware.js';
import { createRequestObservability } from './http/request-observability.js';
import { terminalErrorHandler } from './middlewares/terminal-error.middleware.js';
import { protectApplication } from './http/protect-application.js';

interface AppOptions {
  allowedOrigins?: ReadonlySet<string>;
  httpInfrastructure?: HttpInfrastructure;
}

export function createApp({ allowedOrigins = getAllowedOrigins(), httpInfrastructure }: AppOptions = {}) {
  const app = express();

  app.disable('x-powered-by');
  const legacyObservability = createRequestObservability(record => console.error(JSON.stringify(record)));
  if (httpInfrastructure) httpInfrastructure.protectApplication(app);
  else protectApplication(app, legacyObservability);

  if (httpInfrastructure) app.use(httpInfrastructure.requestContext, httpInfrastructure.securityHeaders);
  else app.use(legacyObservability.contextMiddleware);
  app.use(createCorsMiddleware(allowedOrigins));
  if (httpInfrastructure) app.use(httpInfrastructure.jsonBody);
  app.use(httpInfrastructure
    ? createHealthRouter(httpInfrastructure.routeLabel('health')) : createHealthRouter(legacyObservability.routeLabel('health')));
  if (httpInfrastructure) app.use(httpInfrastructure.notFound, httpInfrastructure.errorHandler);
  else app.use(legacyNotFound, createLegacyErrorHandler(legacyObservability));
  app.use(terminalErrorHandler);

  return app;
}

const app = createApp();

export default app;
