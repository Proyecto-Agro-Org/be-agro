import type { z } from 'zod';
import {
  createBlockingAssociationResolution,
  createBlockingDeviceResolution,
  createBlockingHardwareAuthority,
  createBlockingMeasurementCatalogue,
  createBlockingTemporalAuthority,
} from '../adapters/trust-gate-blocking.adapters.js';
import { isIssuedProtectedCandidate } from '../iot/protected-ingest.mapper.js';
import { bindPort, createAuthorityCaller, DEFAULT_AUTHORITY_TIMEOUT_MS } from './authority-call.js';
import { buildAssociationQuery, buildCatalogueQuery, buildDeviceQuery, buildHardwareQuery, buildTemporalQuery } from '../iot/trust-gate.queries.js';
import { canonicalAuthorityResponse, digestCanonical } from '../iot/trust-gate.fingerprint.js';
import type {
  ReadyForAttribution,
  TrustGate,
  TrustGateOptions,
  TrustGatePorts,
  TrustGateQuarantineCode,
  TrustGateQuarantined,
  TrustGateRealm,
  TrustGateResult,
} from '../iot/trust-gate.contracts.js';
import {
  associationAtResolutionSchema,
  catalogueDecisionSchema,
  deviceResolutionSchema,
  gateCandidateSchema,
  gateOptionsSchema,
  gateSelectionSchema,
  hardwareDecisionSchema,
  temporalAuthorityDecisionSchema,
} from '../iot/trust-gate.schemas.js';


// Internal control-flow marker. Never leaves the gate: it is converted into a
// closed quarantine code without message, stack or adapter diagnostics.
class GateStop {
  constructor(readonly reason: TrustGateQuarantineCode) {}
}
const stop = (reason: TrustGateQuarantineCode): never => { throw new GateStop(reason); };
const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const signature = canonicalAuthorityResponse;

// ReadyForAttribution objects emitted by evaluate(), mapped to the exact
// candidate they were derived from. Module-private: no exported way to add an
// entry. Same scope as the BE13-02 candidate registry: in-process provenance,
// not authenticity, and no defence against hostile code inside the process.
const issuedReady = new WeakMap<object, object>();

export function isIssuedReadyFor(ready: unknown, candidate: unknown): boolean {
  return typeof ready === 'object' && ready !== null && typeof candidate === 'object' && candidate !== null &&
    issuedReady.get(ready) === candidate;
}

export function createAttributionTrustGate(ports: TrustGatePorts, options: TrustGateOptions): TrustGate {
  if (typeof ports !== 'object' || ports === null) throw new TypeError('Trust gate ports required');
  const parsedOptions = gateOptionsSchema.safeParse(options);
  if (!parsedOptions.success) throw new TypeError('Invalid trust gate options');
  const realm: TrustGateRealm = parsedOptions.data.realm;
  const timeoutMs = parsedOptions.data.authorityTimeoutMs ?? DEFAULT_AUTHORITY_TIMEOUT_MS;

  // Methods are captured once; later mutation of the ports object has no effect.
  const resolveDevice = bindPort(ports.devices, 'resolve', createBlockingDeviceResolution, 'device');
  const findAssociationAt = bindPort(ports.associations, 'findAt', createBlockingAssociationResolution, 'association');
  const decideTime = bindPort(ports.temporal, 'decide', createBlockingTemporalAuthority, 'temporal');
  const evaluateCatalogue = bindPort(ports.catalogue, 'evaluate', createBlockingMeasurementCatalogue, 'catalogue');
  const verifyHardware = bindPort(ports.hardware, 'verify', createBlockingHardwareAuthority, 'hardware');

  const call = createAuthorityCaller(realm, timeoutMs);
  async function ask<S extends z.ZodType>(schema: S, operation: () => unknown): Promise<z.output<S>> {
    const result = await call(schema, operation);
    return result.ok ? result.value : stop(result.reason);
  }

  const quarantined = (reason: TrustGateQuarantineCode, eventId: string | null): TrustGateQuarantined =>
    Object.freeze({ status: 'quarantined', reason, eventId });

  async function evaluate(input: unknown, selectionInput: unknown): Promise<TrustGateResult> {
    let eventId: string | null = null;
    try {
      // 1. Candidate: identity (issued by BE13-02) AND shape (measurement only).
      if (!isIssuedProtectedCandidate(input)) return quarantined('invalid-candidate', null);
      let candidate: z.output<typeof gateCandidateSchema>;
      try {
        const parsed = gateCandidateSchema.safeParse(input);
        if (!parsed.success) return quarantined('invalid-candidate', null);
        candidate = parsed.data;
      } catch { return quarantined('invalid-candidate', null); }
      eventId = candidate.eventId;

      let field: string;
      try {
        const parsed = gateSelectionSchema.safeParse(selectionInput);
        if (!parsed.success) return quarantined('invalid-candidate', eventId);
        field = parsed.data.field;
      } catch { return quarantined('invalid-candidate', eventId); }
      if (!hasOwn(candidate.payload, field)) return quarantined('absent-field', eventId);
      const raw = candidate.payload[field];
      let value: number | null;
      if (raw === null) value = null;
      else if (typeof raw === 'number' && Number.isFinite(raw)) value = raw;
      else return quarantined('invalid-value', eventId);

      const sourceId = candidate.sourceId;
      const device = Object.freeze({ kind: candidate.device.kind, value: candidate.device.value });
      const sameKey = (key: { kind: string; value: string }) => key.kind === device.kind && key.value === device.value;
      const timestamps = Object.freeze({
        deviceTimestamp: candidate.timestamps.deviceTimestamp.value,
        sentAt: candidate.timestamps.sentAt.value,
        receivedAt: candidate.timestamps.receivedAt.value,
        persistedAt: candidate.timestamps.persistedAt.value,
      });

      // 2. Device (BE-11 PhysicalDevice). Never pick the "first" match.
      const deviceQuery = buildDeviceQuery(realm, sourceId, device);
      const devices = await ask(deviceResolutionSchema, () => resolveDevice(deviceQuery as never));
      if (devices.devices.length === 0) return quarantined('unresolved-device', eventId);
      if (devices.devices.some(row => row.sourceId !== sourceId || !sameKey(row.key))) return quarantined('contradictory-authority', eventId);
      if (devices.devices.length !== 1) return quarantined('ambiguous-device', eventId);
      const physical = devices.devices[0];
      if (physical.verification !== 'verified') return quarantined('unverified-device', eventId);
      if (physical.lifecycle !== 'active') return quarantined('inactive-device', eventId);

      // 3. Hardware/provenance authority, separate from BE13-02 ingest provenance.
      const declaredOrigin = candidate.provenance.dataOriginDeclared;
      const hardwareQuery = buildHardwareQuery(realm, eventId, sourceId, device, physical.id, declaredOrigin);
      const hardware = await ask(hardwareDecisionSchema, () => verifyHardware(hardwareQuery as never));
      if (hardware.status !== 'verified') return quarantined('unverified-hardware', eventId);
      if (hardware.physicalDeviceId !== physical.id) return quarantined('contradictory-authority', eventId);
      if ((declaredOrigin === 'simulated' && hardware.origin !== 'simulated') ||
        (declaredOrigin === 'physical-unverified' && hardware.origin !== 'physical')) return quarantined('contradictory-authority', eventId);

      // 4. Temporal authority. The instant must be one of the candidate's own
      // clocks, as named by the authority, and never after reception.
      const temporalQuery = buildTemporalQuery(realm, eventId, sourceId, physical.id, timestamps);
      const temporal = await ask(temporalAuthorityDecisionSchema, () => decideTime(temporalQuery as never));
      if (temporal.status === 'unresolved') return quarantined('unresolved-time', eventId);
      if (temporal.status === 'untrusted') return quarantined('untrusted-clock', eventId);
      const expectedInstant = temporal.clock === 'received-at' ? timestamps.receivedAt
        : temporal.clock === 'broker-declared-approved' ? timestamps.sentAt
          : (typeof timestamps.deviceTimestamp === 'number' ? timestamps.deviceTimestamp : null);
      if (expectedInstant === null || temporal.at !== expectedInstant || temporal.at > timestamps.receivedAt)
        return quarantined('contradictory-authority', eventId);
      const at = temporal.at;

      // 5. Historical association at the authorized instant: [validFrom, validTo).
      const associationQuery = buildAssociationQuery(realm, physical.id, at);
      const associations = await ask(associationAtResolutionSchema, () => findAssociationAt(associationQuery as never));
      if (associations.records.some(row => row.physicalDeviceId !== physical.id || row.sourceId !== sourceId || !sameKey(row.device) ||
        !(row.validFrom <= at && (row.validTo === null || at < row.validTo)))) return quarantined('contradictory-authority', eventId);
      if (associations.records.length === 0) return quarantined('missing-association', eventId);
      if (associations.records.length !== 1) return quarantined('overlapping-association', eventId);
      const association = associations.records[0];

      // 6. Catalogue: approval only; no normalization or conversion.
      const catalogueQuery = buildCatalogueQuery(realm, sourceId, physical.id, association.sensorId, field, value, at);
      const catalogue = await ask(catalogueDecisionSchema, () => evaluateCatalogue(catalogueQuery as never));
      if (catalogue.status === 'unknown-magnitude') return quarantined('unapproved-magnitude', eventId);
      if (catalogue.status === 'incompatible-unit') return quarantined('incompatible-unit', eventId);
      if (catalogue.field !== field) return quarantined('contradictory-authority', eventId);

      // 7. In-gate revalidation (TOCTOU between reads). Downstream stages must
      // still revalidate: this only proves stability across the two reads.
      const devicesAgain = await ask(deviceResolutionSchema, () => resolveDevice(deviceQuery as never));
      const hardwareAgain = await ask(hardwareDecisionSchema, () => verifyHardware(hardwareQuery as never));
      const temporalAgain = await ask(temporalAuthorityDecisionSchema, () => decideTime(temporalQuery as never));
      const associationsAgain = await ask(associationAtResolutionSchema, () => findAssociationAt(associationQuery as never));
      const catalogueAgain = await ask(catalogueDecisionSchema, () => evaluateCatalogue(catalogueQuery as never));
      if (signature(associationsAgain) !== signature(associations)) return quarantined('stale-association', eventId);
      if (signature(devicesAgain) !== signature(devices) || signature(hardwareAgain) !== signature(hardware) ||
        signature(temporalAgain) !== signature(temporal) || signature(catalogueAgain) !== signature(catalogue))
        return quarantined('stale-resolution', eventId);

      const ready: ReadyForAttribution = Object.freeze({
        status: 'ready-for-attribution',
        realm,
        eventId,
        sourceId,
        // Fresh object: never the same reference handed to authorities.
        device: Object.freeze({ kind: device.kind, value: device.value }),
        physicalDeviceId: physical.id,
        clientId: association.clientId,
        fieldId: association.fieldId,
        areaId: association.areaId,
        sensorId: association.sensorId,
        associationId: association.id,
        association: Object.freeze({ validFrom: association.validFrom, validTo: association.validTo }),
        authorizedAt: at,
        clock: temporal.clock,
        field,
        magnitude: catalogue.magnitude,
        unit: catalogue.unit,
        value,
        timestamps: Object.freeze({ receivedAt: timestamps.receivedAt, persistedAt: timestamps.persistedAt }),
        provenance: Object.freeze({
          technicalIdentityAuthorization: 'external-capability',
          payloadIntegrity: 'not-attested',
          dataOriginDeclared: declaredOrigin,
          hardware: Object.freeze({ status: 'verified', origin: hardware.origin, method: hardware.method }),
        }),
        revisions: Object.freeze({
          deviceVersion: physical.version,
          associationId: association.id,
          associationRevision: association.revision,
          temporalPolicyRevision: temporal.policyRevision,
          catalogueRevision: catalogue.catalogueRevision,
          hardwareAttestationRevision: hardware.attestationRevision,
        }),
        fingerprints: Object.freeze({
          device: digestCanonical(signature(devices)),
          hardware: digestCanonical(signature(hardware)),
          temporal: digestCanonical(signature(temporal)),
          association: digestCanonical(signature(associations)),
          catalogue: digestCanonical(signature(catalogue)),
        }),
        revalidation: 'required',
      });
      issuedReady.set(ready, input as object);
      return ready;
    } catch (error) {
      if (error instanceof GateStop) return quarantined(error.reason, eventId);
      return quarantined('internal-error', eventId);
    }
  }

  return Object.freeze({ evaluate: evaluate as TrustGate['evaluate'] });
}
