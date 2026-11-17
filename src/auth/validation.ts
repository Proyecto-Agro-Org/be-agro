import { z } from 'zod';
import { ApplicationError } from '../errors/application.error.js';

// Bounded logical keys; no ObjectId assumption, trimming, or implicit coercion.
export const logicalKey = z.string().min(1).max(256)
  .refine(value => value.trim() === value && !/[\p{Cc}\p{Cf}]/u.test(value));
export const epoch = z.number().int().min(0).max(8640000000000000);

export function checkedOutput<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  try {
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
  } catch { /* Do not retain input, issues, getter failures, or adapter diagnostics. */ }
  throw new ApplicationError('INTERNAL_ERROR');
}

export async function callPort<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch { throw new ApplicationError('DEPENDENCY_UNAVAILABLE'); }
}
