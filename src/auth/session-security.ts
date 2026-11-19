import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { epoch } from './validation.js';
import { ApplicationError } from '../errors/application.error.js';

export function newOpaqueSecret(): string { return randomBytes(32).toString('base64url'); }
export function isOpaqueSecret(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) &&
    Buffer.from(value, 'base64url').toString('base64url') === value;
}
export function digestSecret(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
export function sameDigest(a: string, b: string): boolean {
  return /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
export function safeClock(clock: () => number = Date.now): () => number {
  if (typeof clock !== 'function') throw new TypeError('Invalid clock configuration.');
  return () => {
    try { const value = epoch.safeParse(clock()); if (value.success) return value.data; }
    catch { /* Never retain clock diagnostics. */ }
    throw new ApplicationError('INTERNAL_ERROR');
  };
}
