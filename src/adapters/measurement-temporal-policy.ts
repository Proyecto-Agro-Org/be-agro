import type { TemporalDecision, TrustedMeasurementEvent } from '../measurements/contracts.js';

// Fail-closed policy while no acquisition clock/tolerance is approved.
// receivedAt is trustworthy as reception metadata but is not proof of when a
// buffered measurement was acquired, especially across ownership transfers.
export function createConservativeReceivedAtPolicy(){
  return Object.freeze({async select(_event:TrustedMeasurementEvent):Promise<TemporalDecision>{
    return Object.freeze({status:'untrusted',reason:'untrusted-clock'});
  }});
}
