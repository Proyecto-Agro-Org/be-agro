const catalog = {
  VALIDATION_ERROR: { status: 400, message: 'Invalid request' },
  RESOURCE_NOT_FOUND: { status: 404, message: 'Resource not found' },
  UNAUTHENTICATED: { status: 401, message: 'Authentication required' },
  FORBIDDEN: { status: 403, message: 'Access forbidden' },
  CONFLICT: { status: 409, message: 'Resource conflict' },
  INTERNAL_ERROR: { status: 500, message: 'Internal server error' },
  DEPENDENCY_UNAVAILABLE: { status: 503, message: 'Dependency unavailable' },
  PAYLOAD_TOO_LARGE: { status: 413, message: 'Request body too large' },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, message: 'Unsupported media type' },
  RATE_LIMITED: { status: 429, message: 'Too many requests' },
  CORS_ORIGIN_FORBIDDEN: { status: 403, message: 'Origin not allowed by CORS' },
} as const;

export type ApplicationErrorCode = keyof typeof catalog;
export function isApplicationErrorCode(value: unknown): value is ApplicationErrorCode {
  return typeof value === 'string' && Object.hasOwn(catalog, value);
}
export interface SafeHttpError {
  readonly code: ApplicationErrorCode;
  readonly status: number;
  readonly message: string;
}

// Application code declares a category, never an arbitrary public diagnostic.
export class ApplicationError extends Error {
  readonly code: ApplicationErrorCode;

  constructor(code: ApplicationErrorCode) {
    const safeCode = isApplicationErrorCode(code) ? code : 'INTERNAL_ERROR';
    super(catalog[safeCode].message);
    this.name = 'ApplicationError';
    this.code = safeCode;
  }
}

export function describeApplicationError(code: ApplicationErrorCode): SafeHttpError {
  const safeCode = isApplicationErrorCode(code) ? code : 'INTERNAL_ERROR';
  return Object.freeze({ code: safeCode, ...catalog[safeCode] });
}
