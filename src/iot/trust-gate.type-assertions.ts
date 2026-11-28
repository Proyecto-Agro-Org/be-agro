// Compile-time guard (checked by `npm run typecheck`): a BE13-03 result must
// never be structurally assignable to a BE-12 trusted event or attribution.
// If a future change makes them assignable, this file stops compiling.
import type { AttributionResult, TrustedMeasurementEvent } from '../measurements/contracts.js';
import type { ReadyForAttribution, TrustGateResult } from './trust-gate.contracts.js';

type Assignable<A, B> = [A] extends [B] ? true : false;

export const readyIsNotTrustedMeasurementEvent: Assignable<ReadyForAttribution, TrustedMeasurementEvent> = false;
export const trustedMeasurementEventIsNotReady: Assignable<TrustedMeasurementEvent, ReadyForAttribution> = false;
export const readyIsNotAttributionResult: Assignable<ReadyForAttribution, AttributionResult> = false;
export const gateResultIsNotAttributionResult: Assignable<TrustGateResult, AttributionResult> = false;

// BE13-04: the builder result carries exactly a BE-12 TrustedMeasurementEvent
// but is itself neither an event nor a BE-12 AttributionResult.
import type { TrustedEventReady, TrustedEventResult } from './trusted-event.contracts.js';
export const trustedEventReadyIsNotAttributionResult: Assignable<TrustedEventReady, AttributionResult> = false;
export const trustedEventResultIsNotTrustedMeasurementEvent: Assignable<TrustedEventResult, TrustedMeasurementEvent> = false;
export const trustedEventCarriesBE12Event: Assignable<TrustedEventReady['event'], TrustedMeasurementEvent> = true;
export const be12EventFitsTrustedEventSlot: Assignable<TrustedMeasurementEvent, TrustedEventReady['event']> = true;

// BE13-07: readiness can never be typed as production-ready.
import type { IngestionRootReadiness } from './ingestion-root.contracts.js';
export const readinessNeverProductionReady: Assignable<{ productionReady: true }, Pick<IngestionRootReadiness, 'productionReady'>> = false;
