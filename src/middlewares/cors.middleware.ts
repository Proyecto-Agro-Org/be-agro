import cors from 'cors';
import { CorsOriginError } from '../errors/cors-origin.error.js';

export function createCorsMiddleware(allowedOrigins: ReadonlySet<string>) {
  return cors({
    origin(origin, callback) {
      const isAllowed =
        !origin || allowedOrigins.has('*') || allowedOrigins.has(origin);

      if (isAllowed) {
        callback(null, true);
        return;
      }

      callback(new CorsOriginError());
    },
  });
}
