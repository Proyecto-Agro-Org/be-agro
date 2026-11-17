import cors from 'cors';

export function createCorsMiddleware(allowedOrigins: ReadonlySet<string>) {
  return cors({
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
  });
}
