import type { z } from 'zod';

// Shared, fail-closed invocation of an injected authority/policy port.
// - bounded by an operational timeout (not a temporal tolerance);
// - output validated by a strict schema (Zod copies: no aliasing to adapter objects);
// - the response must declare the expected realm.
// Diagnostics (messages, stacks, thrown values) are discarded.
export type AuthorityCallFailure = 'dependency-error' | 'invalid-authority-response' | 'realm-mismatch';
export type AuthorityCallResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: AuthorityCallFailure };

export const DEFAULT_AUTHORITY_TIMEOUT_MS = 5_000;

export function createAuthorityCaller(realm: string, timeoutMs: number) {
  function bounded(operation: () => unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      let pending: Promise<unknown>;
      try { pending = Promise.resolve(operation()); }
      catch (error) { clearTimeout(timer); reject(error); return; }
      pending.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
  }

  return async function call<S extends z.ZodType>(schema: S, operation: () => unknown): Promise<AuthorityCallResult<z.output<S>>> {
    let raw: unknown;
    try { raw = await bounded(operation); } catch { return { ok: false, reason: 'dependency-error' }; }
    let parsed: z.output<S> | undefined;
    try {
      const result = schema.safeParse(raw);
      if (result.success) parsed = result.data;
    } catch { /* Hostile getters/proxies: discard diagnostics. */ }
    if (parsed === undefined) return { ok: false, reason: 'invalid-authority-response' };
    if ((parsed as { realm?: unknown }).realm !== realm) return { ok: false, reason: 'realm-mismatch' };
    return { ok: true, value: parsed };
  };
}

export function bindPort(port: unknown, method: string, fallback: () => object, name: string): (query: never) => unknown {
  if (port === undefined) {
    const blocking = fallback() as Record<string, (query: never) => unknown>;
    return blocking[method].bind(blocking);
  }
  if (typeof port !== 'object' || port === null) throw new TypeError(`Invalid ${name} port`);
  const fn = (port as Record<string, unknown>)[method];
  if (typeof fn !== 'function') throw new TypeError(`Invalid ${name} port`);
  return fn.bind(port) as (query: never) => unknown;
}
