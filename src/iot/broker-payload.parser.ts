import { createHash } from 'node:crypto';
import { z } from 'zod';
import { eventIdSchema } from './event-id.js';
import type { DeclaredDeviceEnvelope, MqttPayloadLimits } from './mqtt-ingestion-boundary.contracts.js';

// BE13-11A — structural parser for raw broker payload bytes. Order (cheapest first, nothing deep before it passes):
// size (bytes) → strict UTF-8 → JSON → dangerous keys → depth/keys/string limits → non-finite numbers → closed envelope.
// No coercion ever ("0" stays a string). The bytes are fingerprinted (sha256) for audit; the payload itself is never logged.

export type ParseFailure = 'payload-too-large' | 'payload-invalid-utf8' | 'payload-malformed' | 'payload-dangerous-key' | 'payload-limits-exceeded';
export type ParseResult =
  | { readonly ok: true; readonly envelope: DeclaredDeviceEnvelope; readonly payloadFingerprint: string }
  | { readonly ok: false; readonly reasonCode: ParseFailure; readonly payloadFingerprint: string | null };

const DANGEROUS_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const technicalId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/);
const fieldKey = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
// The device envelope (BE13-01 contract). CLOSED: an unknown top-level key (realm, sourceId, trusted, verified,
// retryable, ...) makes the whole delivery malformed — device-declared fields can never carry authority.
const envelopeSchema = z.object({
  version: z.literal(1),
  eventId: eventIdSchema,                                   // BE14-02: the canonical definition (src/iot/event-id.ts)
  sentAt: z.number().int().min(0).max(8.64e15),
  clientid: technicalId.optional(),
  deviceTimestamp: z.union([z.string().max(128), z.number().finite(), z.null()]).optional(),
  payload: z.record(fieldKey, z.union([z.number().finite(), z.string(), z.boolean(), z.null()])),
  mqtt: z.object({ topic: z.string().max(1024).optional(), messageType: z.literal('telemetry'), dataOrigin: z.enum(['simulated', 'physical-unverified', 'unknown']) }).strict(),
}).strict();

export const payloadLimitsSchema = z.object({ maxBytes: z.number().int().min(1).max(16 * 1024 * 1024), maxDepth: z.number().int().min(1).max(64),
  maxKeys: z.number().int().min(1).max(100_000), maxStringLength: z.number().int().min(1).max(1_000_000) }).strict();

const decoder = new TextDecoder('utf-8', { fatal: true });

function inspect(value: unknown, limits: MqttPayloadLimits): ParseFailure | null {
  let keys = 0;
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 1 }];
  while (stack.length) {
    const { value: v, depth } = stack.pop()!;
    if (typeof v === 'string') { if (v.length > limits.maxStringLength) return 'payload-limits-exceeded'; continue; }
    if (typeof v === 'number') { if (!Number.isFinite(v)) return 'payload-malformed'; continue; }
    if (v === null || typeof v === 'boolean') continue;
    if (depth > limits.maxDepth) return 'payload-limits-exceeded';
    const entries = Array.isArray(v) ? v.map((item, i) => [String(i), item] as const) : Object.entries(v as Record<string, unknown>);
    for (const [key, item] of entries) {
      if (!Array.isArray(v) && DANGEROUS_KEYS.has(key)) return 'payload-dangerous-key';
      keys += 1;
      if (keys > limits.maxKeys || key.length > limits.maxStringLength) return 'payload-limits-exceeded';
      stack.push({ value: item, depth: depth + 1 });
    }
  }
  return null;
}

export function parseBrokerPayload(bytes: Uint8Array, limits: MqttPayloadLimits): ParseResult {
  // Size BEFORE hashing or decoding: an oversized payload never reaches anything deeper.
  if (bytes.byteLength > limits.maxBytes) return Object.freeze({ ok: false, reasonCode: 'payload-too-large', payloadFingerprint: null });
  const payloadFingerprint = createHash('sha256').update(bytes).digest('hex');
  const fail = (reasonCode: ParseFailure) => Object.freeze({ ok: false as const, reasonCode, payloadFingerprint });
  let text: string;
  try { text = decoder.decode(bytes); } catch { return fail('payload-invalid-utf8'); }  // never replaced silently
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return fail('payload-malformed'); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return fail('payload-malformed');
  const problem = inspect(parsed, limits);
  if (problem) return fail(problem);
  const envelope = envelopeSchema.safeParse(parsed);
  if (!envelope.success) return fail('payload-malformed');
  // Zod already returned fresh objects; freeze them so nothing downstream can alias or mutate the declared claims.
  const e = envelope.data;
  const frozen: DeclaredDeviceEnvelope = Object.freeze({ ...e, payload: Object.freeze({ ...e.payload }), mqtt: Object.freeze({ ...e.mqtt }) });
  return Object.freeze({ ok: true, envelope: frozen, payloadFingerprint });
}
