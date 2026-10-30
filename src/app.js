import cors from 'cors';
import express from 'express';

function getAllowedOrigins(value = process.env.CORS_ORIGINS ?? '') {
  return new Set(
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

export function createApp({ allowedOrigins = getAllowedOrigins() } = {}) {
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

        const error = new Error('Origin not allowed by CORS');
        error.statusCode = 403;
        callback(error);
      },
    }),
  );

  app.get('/health', (_request, response) => {
    response.status(200).json({ status: 'ok' });
  });

  app.use((error, _request, response, _next) => {
    const statusCode = error.statusCode ?? 500;

    if (statusCode >= 500) {
      console.error(error);
    }

    response.status(statusCode).json({
      error:
        statusCode === 403
          ? 'Origin not allowed by CORS'
          : 'Internal server error',
    });
  });

  return app;
}

const app = createApp();

export default app;
