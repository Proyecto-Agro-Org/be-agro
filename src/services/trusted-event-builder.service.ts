import type { z } from 'zod';
import {
  createBlockingClockPolicy,
  createBlockingDeclaredAtPolicy,
  createBlockingMissingReasonPolicy,
  createBlockingPersistenceTimePolicy,
} from '../adapters/trusted-event-blocking.policies.js';
import { isIssuedProtectedCandidate } from '../iot/protected-ingest.mapper.js';
import { canonicalAuthorityResponse, digestCanonical } from '../iot/trust-gate.fingerprint.js';
import {
  buildAssociationQuery,
  buildCatalogueQuery,
  buildDeviceQuery,
  buildHardwareQuery,
  buildTemporalQuery,
} from '../iot/trust-gate.queries.js';
import {
  associationAtResolutionSchema,
  catalogueDecisionSchema,
  deviceResolutionSchema,
  hardwareDecisionSchema,
  temporalAuthorityDecisionSchema,
} from '../iot/trust-gate.schemas.js';
import type { ReadyForAttribution, TrustGateRealm } from '../iot/trust-gate.contracts.js';
import type {
  TrustedEventBuilder,
  TrustedEventBuilderOptions,
  TrustedEventBuilderPorts,
  TrustedEventQuarantineCode,
  TrustedEventQuarantined,
  TrustedEventReady,
  TrustedEventResult,
} from '../iot/trusted-event.contracts.js';
import {
  clockPolicyDecisionSchema,
  declaredAtPolicyDecisionSchema,
  missingReasonPolicyDecisionSchema,
  persistenceTimePolicyDecisionSchema,
  trustedEventBuilderOptionsSchema,
} from '../iot/trusted-event.schemas.js';
import type { MissingReason, TrustedMeasurementEvent } from '../measurements/contracts.js';
import { trustedMeasurementEventSchema } from '../measurements/schemas.js';
import type { ProtectedMeasurementCandidate } from '../iot/protected-ingest.contracts.js';
import { bindPort, createAuthorityCaller, DEFAULT_AUTHORITY_TIMEOUT_MS, type AuthorityCallFailure } from './authority-call.js';
import { isIssuedReadyFor } from './attribution-trust-gate.service.js';

class BuildStop {
  constructor(readonly reason: TrustedEventQuarantineCode) {}
}
const stop = (reason: TrustedEventQuarantineCode): never => { throw new BuildStop(reason); };
const fingerprint = (value: Parameters<typeof canonicalAuthorityResponse>[0]) => digestCanonical(canonicalAuthorityResponse(value));

// Final step, exported so the BE-12 schema boundary can be tested directly:
// anything the BE-12 schema rejects is not an event. The result is a fresh,
// deeply frozen copy (Zod output), never the input object.
export function assembleTrustedMeasurementEvent(input: unknown): TrustedMeasurementEvent | null {
  try {
    const parsed = trustedMeasurementEventSchema.safeParse(input);
    if (!parsed.success) return null;
    const event = parsed.data;
    return Object.freeze({ ...event, device: Object.freeze({ ...event.device }), metadata: Object.freeze({ ...event.metadata }) });
  } catch { return null; }
}

function requiredPort(port: unknown, method: string, name: string) {
  if (port === undefined) throw new TypeError(`Missing ${name} revalidator`);
  return bindPort(port, method, () => { throw new TypeError(`Missing ${name} revalidator`); }, name);
}

export function createTrustedEventBuilder(ports: TrustedEventBuilderPorts, options: TrustedEventBuilderOptions): TrustedEventBuilder {
  if (typeof ports !== 'object' || ports === null) throw new TypeError('Trusted event builder ports required');
  const parsedOptions = trustedEventBuilderOptionsSchema.safeParse(options);
  if (!parsedOptions.success) throw new TypeError('Invalid trusted event builder options');
  const realm: TrustGateRealm = parsedOptions.data.realm;
  const call = createAuthorityCaller(realm, parsedOptions.data.authorityTimeoutMs ?? DEFAULT_AUTHORITY_TIMEOUT_MS);

  const revalidators = ports.revalidators;
  if (typeof revalidators !== 'object' || revalidators === null) throw new TypeError('Revalidators required');
  const resolveDevice = requiredPort(revalidators.devices, 'resolve', 'device');
  const findAssociationAt = requiredPort(revalidators.associations, 'findAt', 'association');
  const decideTime = requiredPort(revalidators.temporal, 'decide', 'temporal');
  const evaluateCatalogue = requiredPort(revalidators.catalogue, 'evaluate', 'catalogue');
  const verifyHardware = requiredPort(revalidators.hardware, 'verify', 'hardware');

  const policies = ports.policies ?? {};
  if (typeof policies !== 'object' || policies === null) throw new TypeError('Invalid policies');
  const decideClock = bindPort(policies.clock, 'decide', createBlockingClockPolicy, 'clock policy');
  const decideDeclaredAt = bindPort(policies.declaredAt, 'decide', createBlockingDeclaredAtPolicy, 'declaredAt policy');
  const decideMissingReason = bindPort(policies.missingReason, 'decide', createBlockingMissingReasonPolicy, 'missingReason policy');
  const decidePersistence = bindPort(policies.persistenceTime, 'decide', createBlockingPersistenceTimePolicy, 'persistenceTime policy');

  async function ask<S extends z.ZodType>(schema: S, operation: () => unknown,
    remap: Partial<Record<AuthorityCallFailure, TrustedEventQuarantineCode>> = {}): Promise<z.output<S>> {
    const result = await call(schema, operation);
    return result.ok ? result.value : stop(remap[result.reason] ?? result.reason);
  }

  const quarantined = (reason: TrustedEventQuarantineCode, eventId: string | null): TrustedEventQuarantined =>
    Object.freeze({ status: 'quarantined', reason, eventId });

  async function build(candidateInput: unknown, readyInput: unknown): Promise<TrustedEventResult> {
    let eventId: string | null = null;
    try {
      // 1. Provenance: both objects were emitted in-process by BE13-02/BE13-03,
      // and this ready was derived from this exact candidate.
      if (!isIssuedProtectedCandidate(candidateInput)) return quarantined('invalid-candidate', null);
      if (!isIssuedReadyFor(readyInput, candidateInput)) return quarantined('invalid-ready', null);
      const candidate = candidateInput as ProtectedMeasurementCandidate;
      const ready = readyInput as ReadyForAttribution;
      eventId = ready.eventId;
      if (ready.realm !== realm) return quarantined('realm-mismatch', eventId);

      const clocks = Object.freeze({
        deviceTimestamp: candidate.timestamps.deviceTimestamp.value,
        sentAt: candidate.timestamps.sentAt.value,
        receivedAt: candidate.timestamps.receivedAt.value,
        persistedAt: candidate.timestamps.persistedAt.value,
      });
      const revisions = ready.revisions, fingerprints = ready.fingerprints;

      // 2. Mandatory revalidation of every BE13-03 authority: same queries,
      // CURRENT state, revision AND fingerprint must both match.
      const devices = await ask(deviceResolutionSchema, () => resolveDevice(buildDeviceQuery(realm, ready.sourceId, ready.device) as never));
      if (fingerprint(devices) !== fingerprints.device || devices.devices.length !== 1 || devices.devices[0].id !== ready.physicalDeviceId ||
        devices.devices[0].version !== revisions.deviceVersion) return quarantined('stale-device', eventId);

      const hardware = await ask(hardwareDecisionSchema, () => verifyHardware(buildHardwareQuery(realm, eventId as string, ready.sourceId, ready.device,
        ready.physicalDeviceId, candidate.provenance.dataOriginDeclared) as never));
      if (fingerprint(hardware) !== fingerprints.hardware || hardware.status !== 'verified' ||
        hardware.attestationRevision !== revisions.hardwareAttestationRevision) return quarantined('stale-hardware', eventId);

      const temporal = await ask(temporalAuthorityDecisionSchema, () => decideTime(buildTemporalQuery(realm, eventId as string, ready.sourceId,
        ready.physicalDeviceId, clocks) as never));
      if (fingerprint(temporal) !== fingerprints.temporal || temporal.status !== 'trusted' || temporal.policyRevision !== revisions.temporalPolicyRevision ||
        temporal.at !== ready.authorizedAt || temporal.clock !== ready.clock) return quarantined('stale-temporal-policy', eventId);

      const associations = await ask(associationAtResolutionSchema, () => findAssociationAt(buildAssociationQuery(realm, ready.physicalDeviceId,
        ready.authorizedAt) as never));
      if (fingerprint(associations) !== fingerprints.association || associations.records.length !== 1 ||
        associations.records[0].id !== revisions.associationId || associations.records[0].revision !== revisions.associationRevision ||
        associations.records[0].clientId !== ready.clientId) return quarantined('stale-association', eventId);

      const catalogue = await ask(catalogueDecisionSchema, () => evaluateCatalogue(buildCatalogueQuery(realm, ready.sourceId, ready.physicalDeviceId,
        ready.sensorId, ready.field, ready.value, ready.authorizedAt) as never));
      if (fingerprint(catalogue) !== fingerprints.catalogue || catalogue.status !== 'approved' || catalogue.catalogueRevision !== revisions.catalogueRevision ||
        catalogue.magnitude !== ready.magnitude || catalogue.unit !== ready.unit) return quarantined('stale-catalog', eventId);

      // 3. BE-12 clock mapping (explicit policy; no built-in equivalence).
      const clock = await ask(clockPolicyDecisionSchema, () => decideClock(Object.freeze({ realm, eventId, gateClock: ready.clock,
        authorizedAt: ready.authorizedAt, temporalPolicyRevision: revisions.temporalPolicyRevision }) as never));
      if (clock.status !== 'approved') return quarantined('unresolved-clock', eventId);

      // 4. declaredAt: the policy names a declared clock; the value must be that
      // clock's exact candidate value (or null for 'none'). Never chosen here.
      const declared = await ask(declaredAtPolicyDecisionSchema, () => decideDeclaredAt(Object.freeze({ realm, eventId, sourceId: ready.sourceId,
        physicalDeviceId: ready.physicalDeviceId, candidateClocks: clocks, gateClock: ready.clock, authorizedAt: ready.authorizedAt,
        temporalPolicyRevision: revisions.temporalPolicyRevision }) as never));
      if (declared.status !== 'approved') return quarantined('unapproved-declared-at', eventId);
      if (declared.source === 'device-timestamp') {
        if (typeof clocks.deviceTimestamp !== 'number') return quarantined('missing-declared-at', eventId);
        if (declared.declaredAt !== clocks.deviceTimestamp) return quarantined('contradictory-authority', eventId);
      } else if (declared.source === 'broker-sent-at') {
        if (declared.declaredAt !== clocks.sentAt) return quarantined('contradictory-authority', eventId);
      }

      // 5. Consistency between BE13-03 temporal evidence, BE-12 clock and declaredAt.
      if (clock.clock === 'received-at') {
        if (ready.clock !== 'received-at' || ready.authorizedAt !== clocks.receivedAt) return quarantined('contradictory-authority', eventId);
      } else {
        const sameSource = (ready.clock === 'device-declared-approved' && declared.source === 'device-timestamp') ||
          (ready.clock === 'broker-declared-approved' && declared.source === 'broker-sent-at');
        if (!sameSource || declared.declaredAt !== ready.authorizedAt) return quarantined('contradictory-authority', eventId);
      }

      // 6. missingReason: only for null. Numbers (0 included) carry none.
      let missingReason: MissingReason | null = null;
      let missingReasonRevision: number | null = null;
      if (ready.value === null) {
        const decision = await ask(missingReasonPolicyDecisionSchema, () => decideMissingReason(Object.freeze({ realm, eventId,
          physicalDeviceId: ready.physicalDeviceId, sensorId: ready.sensorId, field: ready.field, magnitude: ready.magnitude, unit: ready.unit }) as never),
          { 'invalid-authority-response': 'invalid-missing-reason' });
        if (decision.status !== 'approved') return quarantined('missing-reason-required', eventId);
        missingReason = decision.missingReason;
        missingReasonRevision = decision.policyRevision;
      }

      // 7. persistedAt: never completed. Absent → blocked without consulting.
      if (clocks.persistedAt === null) return quarantined('unresolved-persisted-at', eventId);
      const persistedAt = clocks.persistedAt;
      const persistence = await ask(persistenceTimePolicyDecisionSchema, () => decidePersistence(Object.freeze({ realm, eventId,
        receivedAt: clocks.receivedAt, persistedAt }) as never));
      if (persistence.status !== 'approved') return quarantined('unresolved-persisted-at', eventId);
      if (persistence.persistedAt !== persistedAt || persistence.persistedAt < clocks.receivedAt) return quarantined('contradictory-authority', eventId);

      // 8. Exactly one BE-12 TrustedMeasurementEvent, validated by the real schema.
      const event = assembleTrustedMeasurementEvent({
        eventId,
        sourceId: ready.sourceId,
        device: { kind: ready.device.kind, value: ready.device.value },
        receivedAt: clocks.receivedAt,
        declaredAt: declared.declaredAt,
        persistedAt,
        magnitude: ready.magnitude,
        unit: ready.unit,
        value: ready.value,
        missingReason,
        provenance: hardware.origin,
        simulated: hardware.origin === 'simulated',
        metadata: {},
      });
      if (event === null) return quarantined('schema-mismatch', eventId);

      const result: TrustedEventReady = Object.freeze({
        status: 'trusted-event',
        event,
        attribution: Object.freeze({
          realm, authorizedAt: ready.authorizedAt, clock: clock.clock, physicalDeviceId: ready.physicalDeviceId,
          clientId: associations.records[0].clientId, fieldId: associations.records[0].fieldId, areaId: associations.records[0].areaId,
          sensorId: associations.records[0].sensorId, associationId: associations.records[0].id, associationRevision: associations.records[0].revision,
        }),
        policies: Object.freeze({ clock: clock.policyRevision, declaredAt: declared.policyRevision, declaredAtSource: declared.source,
          missingReason: missingReasonRevision, persistenceTime: persistence.policyRevision }),
        revisions: Object.freeze({ ...revisions }),
        fingerprints: Object.freeze({ ...fingerprints }),
        revalidation: 'required',
      });
      return result;
    } catch (error) {
      if (error instanceof BuildStop) return quarantined(error.reason, eventId);
      return quarantined('internal-error', eventId);
    }
  }

  return Object.freeze({ build: build as TrustedEventBuilder['build'] });
}
