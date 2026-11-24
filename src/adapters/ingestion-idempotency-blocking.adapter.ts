import type { IdempotencyClaim, IdempotencyKey, IdempotencyLookup, MeasurementIdempotencyPort } from '../iot/ingestion-composition.contracts.js';

// Default idempotency adapter: blocks. There is no approved persistent store
// for idempotency keys; an in-memory map would silently lose state across
// restarts and instances, so none is provided as a production default.
export function createBlockingIdempotencyPort(): MeasurementIdempotencyPort {
  return Object.freeze({
    async lookup(_key: IdempotencyKey): Promise<IdempotencyLookup> { throw new Error('idempotency store not configured'); },
    async claim(_input: IdempotencyKey & { fingerprint: string }): Promise<IdempotencyClaim> { throw new Error('idempotency store not configured'); },
  });
}
