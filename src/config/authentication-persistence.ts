import { z } from 'zod';

const schema = z.object({
  // No default collection: caller must choose an isolated authentication namespace.
  collectionPrefix: z.string().regex(/^agro_auth_[a-z][a-z0-9_]{0,39}$/),
  realm: z.enum(['development', 'test', 'preview', 'production']),
  operationTimeoutMs: z.number().int().min(100).max(5000).default(3000),
}).strict();
export type AuthenticationPersistenceConfig = Readonly<z.output<typeof schema>>;
export function validateAuthenticationPersistenceConfig(input: unknown): AuthenticationPersistenceConfig {
  try {
    const result = schema.safeParse(input);
    if (result.success) return Object.freeze(result.data);
  } catch { /* Do not retain configuration or adapter diagnostics. */ }
  throw new TypeError('Invalid authentication persistence configuration.');
}
