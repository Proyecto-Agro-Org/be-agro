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
