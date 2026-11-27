// BE13-11J — LOCAL_TEST_ONLY publisher reconciliation loop. Never imported by app code.
// SUPERSEDED by scripts/be13-11n/publisher-outbox.ts (durable outbox, two lanes, restart recovery). Kept because the 11J tests/mutants and the campaign history use it.
//
//   publish(eventId) -> (PUBACK = BROKER_ACCEPTED only) -> wait -> confirm(eventId) -> confirmed? stop : publish AGAIN WITH THE SAME eventId -> ...
// Bounded by an injected policy (attempts and elapsed time). The loop NEVER invents a new eventId, NEVER treats PUBACK as final, NEVER treats
// pending / not-found / unknown / an unreachable backend as success, and NEVER turns an exhausted budget into success or into "lost".
import { CONFIRMED_STATUSES, type IngestConfirmationStatus } from '../../src/iot/ingest-confirmation.contracts.js';

export type PublisherRetryPolicy =
  | { readonly mode: 'BLOCKED'; readonly reason: 'publisher-retry-policy-not-decided' }
  | { readonly mode: 'TEST_ONLY' | 'APPROVED'; readonly initialDelayMs: number; readonly maxAttempts: number; readonly backoffFactor: number; readonly maxDelayMs: number; readonly maxElapsedMs: number };
/** The productive default decides nothing: a publisher cannot reconcile until a human approves a policy. */
export const DEFAULT_PUBLISHER_RETRY_POLICY: PublisherRetryPolicy = Object.freeze({ mode: 'BLOCKED', reason: 'publisher-retry-policy-not-decided' });

export type ReconcileOutcome = 'CONFIRMED' | 'QUARANTINED' | 'UNCONFIRMED_EXPLICIT';
export type ConfirmationAnswer = { readonly ok: true; readonly status: string } | { readonly ok: false };
export interface ReconcileAttempt { readonly attempt: number; readonly brokerAccepted: boolean; readonly confirmation: string }
export interface ReconcileResult {
  readonly eventId: string;
  readonly outcome: ReconcileOutcome;
  readonly attempts: number;
  /** PUBACK seen on at least one attempt. Informational only: it never decides the outcome. */
  readonly brokerAcceptedAny: boolean;
  readonly finalConfirmation: string;
  readonly exhausted: 'max-attempts' | 'max-elapsed' | null;
  readonly trail: readonly ReconcileAttempt[];
}
export interface ReconcileDeps {
  /** Publishes the event with EXACTLY this eventId. true = broker PUBACK (BROKER_ACCEPTED); false/throw = no PUBACK. */
  publish(eventId: string, attempt: number): Promise<boolean>;
  /** Asks the backend. A throw or ok:false = backend unreachable. */
  confirm(eventId: string): Promise<ConfirmationAnswer>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export function validatePolicy(policy: PublisherRetryPolicy): asserts policy is Exclude<PublisherRetryPolicy, { mode: 'BLOCKED' }> {
  if (policy.mode === 'BLOCKED') throw new TypeError('PUBLISHER_RETRY_POLICY_BLOCKED');
  const ok = (n: number, lo: number, hi: number) => Number.isFinite(n) && n >= lo && n <= hi;
  if (!ok(policy.initialDelayMs, 0, 600_000) || !ok(policy.maxAttempts, 1, 20) || !Number.isInteger(policy.maxAttempts) || !ok(policy.backoffFactor, 1, 10) || !ok(policy.maxDelayMs, 0, 600_000) || !ok(policy.maxElapsedMs, 1, 3_600_000)) throw new TypeError('PUBLISHER_RETRY_POLICY_INVALID');
}
export const delayBefore = (policy: Exclude<PublisherRetryPolicy, { mode: 'BLOCKED' }>, attempt: number) => Math.min(policy.maxDelayMs, Math.round(policy.initialDelayMs * policy.backoffFactor ** (attempt - 1)));

export async function reconcilePublish(eventId: string, policy: PublisherRetryPolicy, deps: ReconcileDeps): Promise<ReconcileResult> {
  validatePolicy(policy);
  const started = deps.now(), trail: ReconcileAttempt[] = [];
  let brokerAcceptedAny = false, last = 'none', exhausted: ReconcileResult['exhausted'] = null;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    let brokerAccepted = false;
    try { brokerAccepted = (await deps.publish(eventId, attempt)) === true; } catch { brokerAccepted = false; }   // the SAME eventId on every attempt
    brokerAcceptedAny ||= brokerAccepted;
    await deps.sleep(delayBefore(policy, attempt));
    let answer: ConfirmationAnswer;
    try { answer = await deps.confirm(eventId); } catch { answer = { ok: false }; }
    last = answer.ok && typeof answer.status === 'string' ? answer.status : 'unreachable';
    trail.push({ attempt, brokerAccepted, confirmation: last });
    if (answer.ok && (CONFIRMED_STATUSES as readonly string[]).includes(answer.status)) return { eventId, outcome: 'CONFIRMED', attempts: attempt, brokerAcceptedAny, finalConfirmation: last, exhausted: null, trail };
    if (answer.ok && answer.status === ('quarantined' satisfies IngestConfirmationStatus)) return { eventId, outcome: 'QUARANTINED', attempts: attempt, brokerAcceptedAny, finalConfirmation: last, exhausted: null, trail };
    if (deps.now() - started >= policy.maxElapsedMs) { exhausted = 'max-elapsed'; break; }
  }
  // Budget spent without backend evidence: explicit, NOT success and NOT a declared loss (the event may still arrive late).
  return { eventId, outcome: 'UNCONFIRMED_EXPLICIT', attempts: trail.length, brokerAcceptedAny, finalConfirmation: last, exhausted: exhausted ?? 'max-attempts', trail };
}
