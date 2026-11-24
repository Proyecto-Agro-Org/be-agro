import type {
  ClockPolicy,
  ClockPolicyDecision,
  ClockPolicyQuery,
  DeclaredAtPolicy,
  DeclaredAtPolicyDecision,
  DeclaredAtPolicyQuery,
  MissingReasonPolicy,
  MissingReasonPolicyDecision,
  MissingReasonPolicyQuery,
  PersistenceTimePolicy,
  PersistenceTimePolicyDecision,
  PersistenceTimePolicyQuery,
} from '../iot/trusted-event.contracts.js';

// Default BE13-04 policies. All block: there is no approved decision for which
// declared clock feeds BE-12 declaredAt, which missing reason a null carries,
// when a persistence instant is authoritative, or how BE13-03 clocks map to
// BE-12 clocks. Replacing any of them requires an explicit, reviewed decision.

export function createBlockingClockPolicy(): ClockPolicy {
  return Object.freeze({ async decide(query: ClockPolicyQuery): Promise<ClockPolicyDecision> {
    return Object.freeze({ status: 'blocked' as const, realm: query.realm });
  } });
}

export function createBlockingDeclaredAtPolicy(): DeclaredAtPolicy {
  return Object.freeze({ async decide(query: DeclaredAtPolicyQuery): Promise<DeclaredAtPolicyDecision> {
    return Object.freeze({ status: 'blocked' as const, realm: query.realm });
  } });
}

export function createBlockingMissingReasonPolicy(): MissingReasonPolicy {
  return Object.freeze({ async decide(query: MissingReasonPolicyQuery): Promise<MissingReasonPolicyDecision> {
    return Object.freeze({ status: 'blocked' as const, realm: query.realm });
  } });
}

export function createBlockingPersistenceTimePolicy(): PersistenceTimePolicy {
  return Object.freeze({ async decide(query: PersistenceTimePolicyQuery): Promise<PersistenceTimePolicyDecision> {
    return Object.freeze({ status: 'blocked' as const, realm: query.realm });
  } });
}
