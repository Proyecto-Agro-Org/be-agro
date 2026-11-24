import type {
  IngestProvenanceAuthority,
  IngestProvenanceCapability,
  VerifiedIngestProvenance,
} from './protected-ingest.contracts.js';

export interface ExternalProvenanceVerifier {
  verify(evidence: unknown): VerifiedIngestProvenance | null;
}

const issuedAuthorities = new WeakSet<object>();

export function isIssuedIngestProvenanceAuthority(value: unknown): value is IngestProvenanceAuthority {
  return typeof value === 'object' && value !== null && issuedAuthorities.has(value);
}

export function createIngestProvenanceAuthority(verifier: ExternalProvenanceVerifier) {
  if (!verifier || typeof verifier.verify !== 'function') throw new TypeError('Provenance verifier required');
  const verify = verifier.verify.bind(verifier);
  const issued = new WeakMap<object, VerifiedIngestProvenance>();
  const technicalId = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;

  function attest(evidence: unknown): IngestProvenanceCapability | null {
    try {
      const result = verify(evidence);
      if (!result || typeof result !== 'object') return null;
      const device = result.device;
      if (!technicalId.test(result.sourceId) || !technicalId.test(result.eventId) ||
        !['telemetry', 'device-status', 'connected', 'disconnected'].includes(result.operation) ||
        !device || !['mqtt-clientid', 'device-id'].includes(device.kind) || !technicalId.test(device.value)) return null;
      const capability = Object.freeze({}) as IngestProvenanceCapability;
      issued.set(capability as object, Object.freeze({
        sourceId: result.sourceId,
        operation: result.operation,
        eventId: result.eventId,
        device: Object.freeze({ kind: device.kind, value: device.value }),
      }));
      return capability;
    } catch { return null; }
  }

  const authority: IngestProvenanceAuthority = Object.freeze({
    accepts(capability: unknown, expected: VerifiedIngestProvenance) {
      if ((typeof capability !== 'object' && typeof capability !== 'function') || capability === null) return false;
      const actual = issued.get(capability as object);
      return actual !== undefined && actual.sourceId === expected.sourceId && actual.operation === expected.operation &&
        actual.eventId === expected.eventId && actual.device.kind === expected.device.kind && actual.device.value === expected.device.value;
    },
  });
  issuedAuthorities.add(authority as object);

  return Object.freeze({ attest, authority });
}
