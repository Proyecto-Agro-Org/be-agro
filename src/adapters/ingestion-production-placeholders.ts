import { createConservativeReceivedAtPolicy } from './measurement-temporal-policy.js';
import {
  createBlockingHardwareAuthority,
  createBlockingMeasurementCatalogue,
  createBlockingTemporalAuthority,
} from './trust-gate-blocking.adapters.js';
import {
  createBlockingClockPolicy,
  createBlockingDeclaredAtPolicy,
  createBlockingMissingReasonPolicy,
  createBlockingPersistenceTimePolicy,
} from './trusted-event-blocking.policies.js';
import type { ExternalProvenanceVerifier } from '../iot/ingest-provenance.authority.js';
import type { Be12AuthorityPorts } from '../iot/ingestion-root.contracts.js';

// BE13-07 — production placeholders. Every one BLOCKS. They exist so a future
// bootstrap can be assembled without any permissive default: until a human
// decision replaces a placeholder with an approved implementation, no real
// measurement can pass. Placeholders are registered in a module-private
// WeakSet so readiness diagnostics can report them as BLOCKED. Nothing in this
// module approves anything; test doubles live only in test-support/.
const placeholders = new WeakSet<object>();
const register = <T extends object>(value: T): T => { placeholders.add(value); return Object.freeze(value); };

export function isBlockingPlaceholder(value: unknown): boolean {
  return typeof value === 'object' && value !== null && placeholders.has(value);
}

export function createBlockingProvenanceVerifier(): ExternalProvenanceVerifier {
  // No EMQX/broker provenance verifier exists yet: nothing is ever attested.
  return register({ verify: (_evidence: unknown) => null });
}

export function createBlockingBe12Authorities(): Be12AuthorityPorts {
  return register({
    temporal: createConservativeReceivedAtPolicy(),
    catalogue: Object.freeze({ async accepts() { return false; } }),
  });
}

export function createProductionPlaceholders() {
  return Object.freeze({
    provenanceVerifier: createBlockingProvenanceVerifier(),
    hardware: register(createBlockingHardwareAuthority()),
    temporal: register(createBlockingTemporalAuthority()),
    catalogue: register(createBlockingMeasurementCatalogue()),
    policies: Object.freeze({
      declaredAt: register(createBlockingDeclaredAtPolicy()),
      clock: register(createBlockingClockPolicy()),
      missingReason: register(createBlockingMissingReasonPolicy()),
      persistenceTime: register(createBlockingPersistenceTimePolicy()),
    }),
    be12: createBlockingBe12Authorities(),
  });
}

// BE13-08 — blocking retry placeholders. The production retry policy never
// retries automatically (every retryable failure goes to quarantine as
// RETRYABLE for an explicit replay) and the scheduler never schedules.
export function createBlockingRetryPolicy() {
  return register({ decide: (_input: unknown) => ({ action: 'stop' as const }) });
}
export function createBlockingRetryScheduler() {
  return register({ async wait(_input: unknown): Promise<void> { throw new Error('retry scheduling is not approved'); } });
}
