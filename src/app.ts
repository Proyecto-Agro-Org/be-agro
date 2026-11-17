import cors from 'cors';
import express, { type ErrorRequestHandler } from 'express';

interface AppOptions {
  allowedOrigins?: ReadonlySet<string>;
}

interface LegacyError {
  statusCode?: number;
}

function getAllowedOrigins(value = process.env.CORS_ORIGINS ?? '') {
  return new Set(
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

export function createApp({ allowedOrigins = getAllowedOrigins() }: AppOptions = {}) {
  const app = express();

  app.disable('x-powered-by');

  app.use(
    cors({
      origin(origin, callback) {
        const isAllowed =
          !origin || allowedOrigins.has('*') || allowedOrigins.has(origin);

        if (isAllowed) {
          callback(null, true);
          return;
        }

        const error = Object.assign(new Error('Origin not allowed by CORS'), {
          statusCode: 403,
        });
        callback(error);
      },
    }),
  );

  app.get('/health', (_request, response) => {
    response.status(200).json({ status: 'ok' });
  });

  const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    // Describe the existing error convention without introducing runtime validation.
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

  app.use(errorHandler);

  return app;
}

const app = createApp();

export default app;
