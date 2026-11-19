import type { Request } from 'express';
import { ApplicationError } from '../errors/application.error.js';

export function readSessionBearer(request: Request, optional = false): string | null {
  let count = 0;
  for (let i = 0; i < request.rawHeaders.length; i += 2) if (request.rawHeaders[i].toLowerCase() === 'authorization') count++;
  if (count > 1) throw new ApplicationError(optional ? 'VALIDATION_ERROR' : 'UNAUTHENTICATED');
  const value = request.headers.authorization;
  if (value === undefined && optional) return null;
  if (typeof value !== 'string' || value.length > 8199 || !/^Bearer [A-Za-z0-9._~+/-]+=*$/i.test(value)) {
    throw new ApplicationError(optional ? 'VALIDATION_ERROR' : 'UNAUTHENTICATED');
  }
  return value.slice(7);
}
