export type RequestPart = 'body' | 'params' | 'query';

export type ValidationIssueCode =
  | 'invalid_type' | 'too_big' | 'too_small' | 'invalid_format'
  | 'not_multiple_of' | 'unrecognized_keys' | 'invalid_union'
  | 'invalid_key' | 'invalid_element' | 'invalid_value' | 'custom';

export interface RequestValidationIssue {
  readonly part: RequestPart;
  readonly path: readonly string[];
  readonly code: ValidationIssueCode;
  readonly message: 'Valor inválido.';
}

// Internal representation only. No HTTP statusCode or global API envelope.
export class RequestValidationError extends Error {
  readonly code = 'REQUEST_VALIDATION_FAILED';
  readonly issues: readonly RequestValidationIssue[];

  constructor(issues: readonly RequestValidationIssue[]) {
    super('Solicitud inválida.');
    this.name = 'RequestValidationError';
    this.issues = Object.freeze(issues.map(issue => Object.freeze({
      part: issue.part,
      path: Object.freeze([...issue.path]),
      code: issue.code,
      message: 'Valor inválido.' as const,
    })));
  }
}

export class RequestValidationExecutionError extends Error {
  readonly code = 'REQUEST_VALIDATION_EXECUTION_FAILED';

  constructor() {
    super('No se pudo validar la solicitud.');
    this.name = 'RequestValidationExecutionError';
  }
}

export class ValidatedRequestUnavailableError extends Error {
  readonly code = 'VALIDATED_REQUEST_UNAVAILABLE';

  constructor() {
    super('Los datos validados no están disponibles.');
    this.name = 'ValidatedRequestUnavailableError';
  }
}
