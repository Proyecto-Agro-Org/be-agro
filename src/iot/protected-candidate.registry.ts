import type { ProtectedMeasurementCandidate } from './protected-ingest.contracts.js';

// In-process identity registry for candidates emitted by the BE13-02 mapper.
// A structurally identical object, a JSON round-trip, a spread copy or a
// structuredClone is NOT registered and therefore never accepted by BE13-03.
// This is a module boundary inside one trusted process, not an external
// authenticator: code with arbitrary execution in the backend shares the
// same trust domain.
const issuedCandidates = new WeakSet<object>();

export function registerIssuedCandidate(candidate: ProtectedMeasurementCandidate): ProtectedMeasurementCandidate {
  if (!Object.isFrozen(candidate)) throw new TypeError('Issued candidates must be frozen');
  issuedCandidates.add(candidate as object);
  return candidate;
}

export function isIssuedCandidate(value: unknown): value is ProtectedMeasurementCandidate {
  return typeof value === 'object' && value !== null && issuedCandidates.has(value);
}
