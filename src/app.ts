import express from 'express';
import { getAllowedOrigins } from './config/cors.js';
import { createCorsMiddleware } from './middlewares/cors.middleware.js';
import { legacyErrorHandler } from './middlewares/legacy-error.middleware.js';
import { createHealthRouter } from './routes/health.routes.js';

interface AppOptions {
  allowedOrigins?: ReadonlySet<string>;
}

export function createApp({ allowedOrigins = getAllowedOrigins() }: AppOptions = {}) {
  const app = express();

  app.disable('x-powered-by');

  app.use(createCorsMiddleware(allowedOrigins));
  app.use(createHealthRouter());
  app.use(legacyErrorHandler);

  return app;
}

const app = createApp();

export default app;
