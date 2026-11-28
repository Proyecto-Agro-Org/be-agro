export class CorsOriginError extends Error {
  readonly statusCode = 403;

  constructor() {
    super('Origin not allowed by CORS');
    this.name = 'CorsOriginError';
  }
}
