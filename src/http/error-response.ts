import { ApplicationError, describeApplicationError, type SafeHttpError } from '../errors/application.error.js';
import { CorsOriginError } from '../errors/cors-origin.error.js';
import { RequestValidationError } from '../errors/request-validation.error.js';

export type ErrorResponseAdapter = (error: SafeHttpError, requestId: string) => unknown;

// Provisional legacy-shaped envelope for opt-in flows, not the final BE-03 DTO.
export const legacyShapeErrorResponse: ErrorResponseAdapter = error => ({ error: error.message });

export function describeHttpError(error: unknown): SafeHttpError {
  try {
    if (error instanceof ApplicationError) return describeApplicationError(error.code);
    if (error instanceof CorsOriginError) return describeApplicationError('CORS_ORIGIN_FORBIDDEN');
    if (error instanceof RequestValidationError) return describeApplicationError('VALIDATION_ERROR');
    if (typeof error === 'object' && error !== null) {
      const parserError = error as { type?: unknown; status?: unknown };
      const type = parserError.type;
      if (type === 'entity.parse.failed' && parserError.status === 400) {
        return describeApplicationError('VALIDATION_ERROR');
      }
      if (type === 'entity.too.large' && parserError.status === 413) {
        return describeApplicationError('PAYLOAD_TOO_LARGE');
      }
      if ((type === 'encoding.unsupported' || type === 'charset.unsupported') &&
        parserError.status === 415) return describeApplicationError('UNSUPPORTED_MEDIA_TYPE');
    }
  } catch { /* Even hostile getters must not escape the error boundary. */ }
  return describeApplicationError('INTERNAL_ERROR');
}
