import { createHash } from 'node:crypto';
import type { z } from 'zod';
import {
  associationAtResolutionSchema,
  catalogueDecisionSchema,
  deviceResolutionSchema,
  hardwareDecisionSchema,
  temporalAuthorityDecisionSchema,
} from './trust-gate.schemas.js';

// Content fingerprints bind each captured revision to the exact authority
// response it came from. A revision number alone cannot reveal "same revision,
// different content"; a later stage re-reads the authority, recomputes the
// fingerprint with this same function and compares. This is an integrity check
// over canonicalized data, not a signature and not proof of authenticity.
const schemas = {
  device: deviceResolutionSchema,
  hardware: hardwareDecisionSchema,
  temporal: temporalAuthorityDecisionSchema,
  association: associationAtResolutionSchema,
  catalogue: catalogueDecisionSchema,
} as const;

export type AuthorityKind = keyof typeof schemas;

// Canonical form: the Zod-parsed output (strict schemas, fixed key order).
export function canonicalAuthorityResponse(parsed: z.output<(typeof schemas)[AuthorityKind]>): string {
  return JSON.stringify(parsed);
}

export function digestCanonical(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// Returns null for anything that is not a valid response of that authority.
export function fingerprintAuthorityResponse(kind: AuthorityKind, response: unknown): string | null {
  try {
    const schema = schemas[kind];
    if (!schema) return null;
    const parsed = schema.safeParse(response);
    return parsed.success ? digestCanonical(canonicalAuthorityResponse(parsed.data)) : null;
  } catch { return null; }
}
