import type { Request, RequestHandler } from 'express';
import { z } from 'zod';
import {
  RequestValidationError, RequestValidationExecutionError, ValidatedRequestUnavailableError,
  type RequestPart, type RequestValidationIssue, type ValidationIssueCode,
} from '../errors/request-validation.error.js';

export type RequestSchemas = Readonly<Partial<Record<RequestPart, z.ZodType>>>;

export type ValidatedRequest<S extends RequestSchemas> = {
  readonly [P in keyof S as P extends RequestPart ? P : never]:
    S[P] extends z.ZodType ? z.output<S[P]> : unknown;
};

export interface RequestValidationOptions {
  // Trusted static field names, never derived from incoming request keys.
  readonly publicFields?: Readonly<Partial<Record<RequestPart, readonly string[]>>>;
}

const parts: readonly RequestPart[] = ['body', 'params', 'query'];
const issueCodes: readonly ValidationIssueCode[] = [
  'invalid_type', 'too_big', 'too_small', 'invalid_format', 'not_multiple_of',
  'unrecognized_keys', 'invalid_union', 'invalid_key', 'invalid_element', 'invalid_value', 'custom',
];

export function createRequestValidation<const S extends RequestSchemas>(
  schemas: S, options: RequestValidationOptions = {},
) {
  if (Object.keys(schemas).some(key => !parts.some(part => part === key))) {
    throw new TypeError('Parte de validación no admitida.');
  }
  const configured: { part: RequestPart; schema: z.ZodType; publicFields: ReadonlySet<string> }[] = [];
  for (const part of parts) {
    const schema = schemas[part];
    if (schema !== undefined) {
      if (!(schema instanceof z.ZodType)) throw new TypeError('Esquema de validación no válido.');
      configured.push({ part, schema, publicFields: new Set(options.publicFields?.[part] ?? []) });
    }
  }
  const validated = new WeakMap<Request, ValidatedRequest<S>>();
  const executions = new WeakMap<Request, symbol>();

  const middleware: RequestHandler = async (request, _response, next) => {
    const execution = Symbol();
    executions.set(request, execution);
    validated.delete(request);
    const data: Partial<Record<RequestPart, unknown>> = {};
    const issues: RequestValidationIssue[] = [];
    try {
      for (const { part, schema, publicFields } of configured) {
        const result = await schema.safeParseAsync(request[part]);
        if (result.success) {
          data[part] = result.data;
        } else {
          for (const issue of result.error.issues) {
            issues.push({
              part,
              // Dynamic record keys and custom issue paths can contain secrets.
              // Only explicitly approved static names are preserved.
              path: issue.path.map(segment => typeof segment === 'string' && publicFields.has(segment)
                ? segment : typeof segment === 'number' ? '[index]' : '[field]'),
              code: issueCodes.find(code => code === issue.code) ?? 'custom',
              message: 'Valor inválido.',
            });
          }
        }
      }
    } catch {
      // Refinements/transforms may throw or reject with sensitive diagnostics.
      // Do not retain the original exception, input or cause.
      next(new RequestValidationExecutionError());
      return;
    }
    // A later invocation on this same Request owns the current result. An old
    // async completion must never overwrite it or revive data after failure.
    if (executions.get(request) !== execution) {
      next(new RequestValidationExecutionError());
      return;
    }
    if (issues.length) {
      next(new RequestValidationError(issues));
      return;
    }
    // Every configured part succeeded. The loop cannot express this schema-to-
    // output mapping to TypeScript; this is the single checked-boundary assertion.
    validated.set(request, Object.freeze(data) as ValidatedRequest<S>);
    next();
  };

  function getValidatedData(request: Request): ValidatedRequest<S> {
    const data = validated.get(request);
    if (!data) throw new ValidatedRequestUnavailableError();
    return data;
  }

  return { middleware, getValidatedData };
}
