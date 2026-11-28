import type { z } from 'zod';
import { createIngestionIdentityPorts } from '../adapters/ingestion-identity.adapters.js';
import { isIssuedProtectedCandidate } from '../iot/protected-ingest.mapper.js';
import type { ProtectedMeasurementCandidate } from '../iot/protected-ingest.contracts.js';
import { technicalInputFingerprint } from '../iot/ingestion-event-fingerprint.js';
import type {
  CompositionAccepted,
  CompositionAttribution,
  CompositionQuarantineCode,
  CompositionQuarantined,
  CompositionResult,
  IdempotencyKey,
  MeasurementIngestionComposition,
  MeasurementIngestionDependencies,
  PersistentCompositionAccepted,
  PersistentCompositionQuarantineCode,
  PersistentCompositionQuarantined,
  PersistentCompositionResult,
  PersistentMeasurementIngestionComposition,
  PersistentMeasurementIngestionDependencies,
} from '../iot/ingestion-composition.contracts.js';
import {
  authorityTimeoutSchema,
  be12VerifiedSchema,
  compositionOptionsSchema,
  compositionSelectionSchema,
  idempotencyClaimSchema,
  idempotencyLookupSchema,
  persistenceLookupSchema,
  persistenceOutcomeSchema,
} from '../iot/ingestion-composition.schemas.js';
import type { TrustGateRealm } from '../iot/trust-gate.contracts.js';
import { trustedMeasurementEventSchema } from '../measurements/schemas.js';
import { createAttributionTrustGate } from './attribution-trust-gate.service.js';
import { createAuthorityCaller, DEFAULT_AUTHORITY_TIMEOUT_MS, runBounded } from './authority-call.js';
import { assembleTrustedMeasurementEvent, createTrustedEventBuilder } from './trusted-event-builder.service.js';

const BE12_FAILURES = new Set(['unknown-device', 'ambiguous-device', 'unverified-device', 'inactive-device', 'untrusted-clock', 'no-window', 'overlap', 'invalid-catalogue']);

class CompositionStop {
  constructor(readonly reason: PersistentCompositionQuarantineCode, readonly cause: string | null = null) {}
}
const stop = (reason: PersistentCompositionQuarantineCode, cause: string | null = null): never => { throw new CompositionStop(reason, cause); };

function requireMethod(value: unknown, method: string, name: string): void {
  if (typeof value !== 'object' || value === null || typeof (value as Record<string, unknown>)[method] !== 'function')
    throw new TypeError(`Missing composition dependency: ${name}`);
}

function bind<T extends object>(value: T, method: string) {
  return ((value as Record<string, unknown>)[method] as (...args: never[]) => unknown).bind(value);
}

// Composition root factory. Every dependency is mandatory: no permissive or
// silent defaults. The caller (future bootstrap) is the productive trust
// boundary: it decides which adapters and policies are trusted.
type FinalizationMode = 'claim' | 'persist';

export function createMeasurementIngestionComposition(deps: MeasurementIngestionDependencies): MeasurementIngestionComposition {
  return createComposition(deps, 'claim') as MeasurementIngestionComposition;
}

// BE13-06: same pipeline, but the last step is persistMeasurementAtomically
// (claim + measurement write in one transaction) instead of a bare claim.
export function createPersistentMeasurementIngestionComposition(deps: PersistentMeasurementIngestionDependencies): PersistentMeasurementIngestionComposition {
  return createComposition(deps, 'persist') as PersistentMeasurementIngestionComposition;
}

function createComposition(deps: MeasurementIngestionDependencies | PersistentMeasurementIngestionDependencies, mode: FinalizationMode) {
  if (typeof deps !== 'object' || deps === null) throw new TypeError('Composition dependencies required');
  const realmResult = compositionOptionsSchema.safeParse(deps.realmContext);
  if (!realmResult.success) throw new TypeError('Missing composition dependency: realmContext');
  const realm: TrustGateRealm = realmResult.data.realm;
  const timeoutResult = authorityTimeoutSchema.safeParse(deps.authorityTimeoutMs);
  if (!timeoutResult.success) throw new TypeError('Invalid authority timeout');
  const timeoutMs = timeoutResult.data ?? DEFAULT_AUTHORITY_TIMEOUT_MS;

  requireMethod(deps.identityStore, 'findDevicesByKey', 'identityStore');
  requireMethod(deps.identityStore, 'findAssociationsAt', 'identityStore');
  requireMethod(deps.temporal, 'decide', 'temporal');
  requireMethod(deps.hardware, 'verify', 'hardware');
  requireMethod(deps.catalogue, 'evaluate', 'catalogue');
  if (typeof deps.policies !== 'object' || deps.policies === null) throw new TypeError('Missing composition dependency: policies');
  for (const name of ['clock', 'declaredAt', 'missingReason', 'persistenceTime'] as const) requireMethod(deps.policies[name], 'decide', `policies.${name}`);
  const store = mode === 'claim' ? (deps as MeasurementIngestionDependencies).idempotency : (deps as PersistentMeasurementIngestionDependencies).persistence;
  const storeName = mode === 'claim' ? 'idempotency' : 'persistence';
  requireMethod(store, 'lookup', storeName);
  requireMethod(store, mode === 'claim' ? 'claim' : 'persistAtomically', storeName);
  requireMethod(deps.be12, 'resolve', 'be12');

  const identity = createIngestionIdentityPorts(deps.identityStore, realm);
  const authorities = { devices: identity.devices, associations: identity.associations, temporal: deps.temporal, hardware: deps.hardware, catalogue: deps.catalogue };
  const gate = createAttributionTrustGate(authorities, { realm, authorityTimeoutMs: timeoutMs });
  const builder = createTrustedEventBuilder({ revalidators: authorities, policies: {
    clock: deps.policies.clock, declaredAt: deps.policies.declaredAt, missingReason: deps.policies.missingReason, persistenceTime: deps.policies.persistenceTime,
  } }, { realm, authorityTimeoutMs: timeoutMs });
  const call = createAuthorityCaller(realm, timeoutMs);
  const lookup = bind(store, 'lookup');
  const finalize = bind(store, mode === 'claim' ? 'claim' : 'persistAtomically');
  const unavailable: PersistentCompositionQuarantineCode = mode === 'claim' ? 'idempotency-unavailable' : 'persistence-unavailable';
  const resolveBe12 = bind(deps.be12, 'resolve');

  async function idempotency<S extends z.ZodType>(schema: S, operation: () => unknown): Promise<z.output<S>> {
    const result = await call(schema, operation);
    if (result.ok) return result.value;
    return result.reason === 'realm-mismatch' ? stop('realm-mismatch', storeName) : stop(unavailable);
  }

  const quarantined = (reason: PersistentCompositionQuarantineCode, cause: string | null, eventId: string | null): PersistentCompositionQuarantined =>
    Object.freeze({ status: 'quarantined', reason, cause, eventId });

  async function ingest(candidateInput: unknown, selectionInput: unknown): Promise<CompositionResult | PersistentCompositionResult> {
    let eventId: string | null = null;
    try {
      if (!isIssuedProtectedCandidate(candidateInput)) return quarantined('invalid-candidate', null, null);
      const candidate = candidateInput as ProtectedMeasurementCandidate;
      eventId = candidate.eventId;
      let field: string;
      try {
        const parsed = compositionSelectionSchema.safeParse(selectionInput);
        if (!parsed.success) return quarantined('invalid-selection', null, eventId);
        field = parsed.data.field;
      } catch { return quarantined('invalid-selection', null, eventId); }

      // 1. Idempotency pre-check (read only). Realm comes from the context.
      const key: IdempotencyKey = Object.freeze({ realm, sourceId: candidate.sourceId, operation: candidate.storeOperation, eventId, field });
      const fingerprint = technicalInputFingerprint(realm, candidate, field);
      // Results never alias the key object handed to the injected idempotency port.
      const idemOut = () => Object.freeze({ key: Object.freeze({ ...key }), fingerprint });
      const duplicate = (measurementId: string | null) => mode === 'claim'
        ? Object.freeze({ status: 'duplicate' as const, eventId: eventId as string, idempotency: idemOut() })
        : Object.freeze({ status: 'duplicate' as const, eventId: eventId as string, idempotency: idemOut(), measurementId });
      const known = await idempotency(mode === 'claim' ? idempotencyLookupSchema : persistenceLookupSchema, () => lookup(key as never));
      if (known.status === 'present') {
        if (known.fingerprint === fingerprint) return duplicate('measurementId' in known && typeof known.measurementId === 'string' ? known.measurementId : null);
        return quarantined('idempotency-conflict', null, eventId);
      }

      // 2. BE13-03 trust gate.
      const ready = await gate.evaluate(candidate, { field });
      if (ready.status !== 'ready-for-attribution') return quarantined('trust-gate-rejected', ready.reason, eventId);

      // 3. BE13-04 builder (mandatory revalidation + policies).
      const built = await builder.build(candidate, ready);
      if (built.status !== 'trusted-event') return quarantined('builder-rejected', built.reason, eventId);

      // 4. BE-12 resolves independently.
      let raw: unknown;
      // BE-12 is injected: it gets its own defensive copy, never the object returned below.
      const forBe12 = assembleTrustedMeasurementEvent(built.event);
      if (forBe12 === null) return quarantined('internal-error', null, eventId);
      try { raw = await runBounded(() => resolveBe12(forBe12 as never), timeoutMs); }
      catch (error) {
        let code: unknown;
        try { code = (error as { code?: unknown })?.code; } catch { code = undefined; }
        if (code === 'CONFLICT') return quarantined('attribution-drift', 'be12-conflict', eventId);
        if (code === 'VALIDATION_ERROR') return quarantined('be12-rejected', 'validation', eventId);
        return quarantined('dependency-error', 'be12', eventId);
      }
      let status: unknown, reason: unknown;
      try { status = (raw as { status?: unknown })?.status; reason = (raw as { reason?: unknown })?.reason; } catch { return quarantined('dependency-error', 'be12', eventId); }
      if (status === 'quarantined') return quarantined('be12-rejected', typeof reason === 'string' && BE12_FAILURES.has(reason) ? reason : null, eventId);
      let verified: z.output<typeof be12VerifiedSchema>;
      let be12Event: z.output<typeof trustedMeasurementEventSchema>;
      try {
        const v = be12VerifiedSchema.safeParse(raw);
        const e = v.success ? trustedMeasurementEventSchema.safeParse((v.data as { event?: unknown }).event) : null;
        if (!v.success || !e || !e.success) return quarantined('dependency-error', 'be12', eventId);
        verified = v.data; be12Event = e.data;
      } catch { return quarantined('dependency-error', 'be12', eventId); }

      // 5. A1 reconciliation: BE13-04 expectation vs BE-12 resolution.
      const expected = built.attribution;
      if (verified.realm !== realm) return quarantined('realm-mismatch', 'be12', eventId);
      const drift: Array<[string, boolean]> = [
        ['event', JSON.stringify(be12Event) !== JSON.stringify(built.event)],
        ['physicalDeviceId', verified.physicalDeviceId !== expected.physicalDeviceId],
        ['clientId', verified.clientId !== expected.clientId],
        ['fieldId', verified.fieldId !== expected.fieldId],
        ['areaId', verified.areaId !== expected.areaId],
        ['sensorId', verified.sensorId !== expected.sensorId],
        ['associationId', verified.associationId !== expected.associationId],
        ['associationRevision', verified.associationRevision !== expected.associationRevision],
        ['attributedAt', verified.attributedAt !== expected.authorizedAt],
        ['clock', verified.clock !== expected.clock],
      ];
      const drifted = drift.find(([, differs]) => differs);
      if (drifted) return quarantined('attribution-drift', drifted[0], eventId);

      const attributionOf = (): CompositionAttribution => Object.freeze({
        realm, attributedAt: expected.authorizedAt, clock: expected.clock, physicalDeviceId: expected.physicalDeviceId,
        clientId: expected.clientId, fieldId: expected.fieldId, areaId: expected.areaId, sensorId: expected.sensorId,
        associationId: expected.associationId, associationRevision: expected.associationRevision,
      });
      const event = assembleTrustedMeasurementEvent(built.event);
      if (event === null) return quarantined('internal-error', null, eventId);

      if (mode === 'claim') {
        // 6. Atomic claim, last. A failed pipeline never consumes the key.
        const claimed = await idempotency(idempotencyClaimSchema, () => finalize(Object.freeze({ ...key, fingerprint }) as never));
        if (claimed.status === 'replay') return duplicate(null);
        if (claimed.status === 'conflict') return quarantined('idempotency-conflict', null, eventId);
        const accepted: CompositionAccepted = Object.freeze({ status: 'accepted', event, attribution: attributionOf(), idempotency: idemOut(), persisted: false });
        return accepted;
      }

      // 6'. BE13-06: claim + measurement write in ONE transaction, only after reconciliation.
      const forStore = assembleTrustedMeasurementEvent(built.event);
      if (forStore === null) return quarantined('internal-error', null, eventId);
      const stored = await idempotency(persistenceOutcomeSchema, () => finalize(Object.freeze({ key: Object.freeze({ ...key }), fingerprint,
        event: forStore, attribution: attributionOf() }) as never));
      if (stored.status === 'duplicate') return duplicate(stored.measurementId);
      if (stored.status === 'conflict') return quarantined('idempotency-conflict', null, eventId);
      const persisted: PersistentCompositionAccepted = Object.freeze({ status: 'accepted', event, attribution: attributionOf(), idempotency: idemOut(),
        persisted: true, measurementId: stored.measurementId });
      return persisted;
    } catch (error) {
      if (error instanceof CompositionStop) return quarantined(error.reason, error.cause, eventId);
      return quarantined('internal-error', null, eventId);
    }
  }

  return Object.freeze({ ingest });
}
