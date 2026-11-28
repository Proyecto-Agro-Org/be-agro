import { z } from 'zod';

const duration = (min: number, max: number) => z.number().int().min(min).max(max);
export const authenticationConfigSchema = z.object({
  realm: z.enum(['development', 'test', 'preview', 'production']),
  audience: z.string().regex(/^[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/).max(256),
  allowedOrigins: z.array(z.string().max(256)).min(1).max(20),
  challengeTtlMs: duration(1000, 600000).default(300000),
  absoluteTtlMs: duration(1000, 86400000).default(28800000),
  idleTtlMs: duration(1000, 3600000).default(1800000),
}).strict().superRefine((config, ctx) => {
  if (config.idleTtlMs > config.absoluteTtlMs) ctx.addIssue({ code: 'custom', message: 'Invalid durations.' });
  for (const origin of config.allowedOrigins) {
    try {
      const url = new URL(origin);
      const local = ['development', 'test'].includes(config.realm) && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
      if (url.origin !== origin || (url.protocol !== 'https:' && !local) || url.username || url.password) throw new Error();
    } catch { ctx.addIssue({ code: 'custom', message: 'Invalid origin.' }); }
  }
});
export type AuthenticationConfig = Readonly<Omit<z.output<typeof authenticationConfigSchema>, 'allowedOrigins'>> & {
  readonly allowedOrigins: readonly string[];
};
export function validateAuthenticationConfig(value: unknown): AuthenticationConfig {
  try {
    const result = authenticationConfigSchema.safeParse(value);
    if (result.success) return Object.freeze({ ...result.data, allowedOrigins: Object.freeze([...result.data.allowedOrigins]) });
  } catch { /* Configuration input must not become a diagnostic. */ }
  throw new TypeError('Invalid authentication configuration.');
}
export function loadAuthenticationConfig(environment: Record<string, unknown> = process.env): AuthenticationConfig {
  const milliseconds = (key: string) => {
    const value = environment[key];
    if (value === undefined) return undefined;
    return typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : null;
  };
  return validateAuthenticationConfig({ realm: environment.AUTH_ENVIRONMENT, audience: environment.GOOGLE_CLIENT_ID,
    allowedOrigins: typeof environment.AUTH_ALLOWED_ORIGINS === 'string' ? environment.AUTH_ALLOWED_ORIGINS.split(',').map(x => x.trim()) : undefined,
    challengeTtlMs: milliseconds('AUTH_LOGIN_CHALLENGE_MS'), absoluteTtlMs: milliseconds('AUTH_SESSION_ABSOLUTE_MS'),
    idleTtlMs: milliseconds('AUTH_SESSION_IDLE_MS') });
}
