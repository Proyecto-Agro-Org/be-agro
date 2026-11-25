import type { BrokerDeliveryContext } from './mqtt-ingestion-boundary.contracts.js';

// BE13-11C — contract a FUTURE EMQX adapter must satisfy. There is NO implementation here: no connection, no SDK, no
// credential, no subscription. The adapter belongs to the Trusted Computing Base: the boundary cannot detect an adapter that
// lies about OBSERVED facts (it can only refuse authority fields the adapter is not allowed to produce).

// What the adapter may produce: exclusively OBSERVED facts + the exact bytes. This is exactly the boundary's closed delivery.
export interface AdapterObservedDelivery {
  readonly brokerObserved: BrokerDeliveryContext;      // connectionReference, authenticatedPrincipalReference, mqttClientId, topic, qos, retain, packetId, receivedAt
  readonly payload: Uint8Array;                        // exact bytes, untouched
}
// References describing HOW the principal was authenticated, without choosing a mechanism (mTLS / JWT / password / plugin stay
// undecided). Opaque technical references only; never a secret, a certificate or a token.
export interface AdapterAuthenticationReferences {
  readonly authenticationMechanismReference: string | null;
  readonly brokerNodeReference: string | null;
  readonly sessionReference: string | null;
}
// The adapter NEVER produces these (the boundary rejects a delivery carrying them; none can come from a topic or payload).
export const ADAPTER_FORBIDDEN_AUTHORITY_FIELDS = Object.freeze(['realm', 'clientId', 'clientid', 'businessClientId', 'sourceId', 'trusted', 'verified',
  'verification', 'hardwareIdentity', 'deviceId', 'sensorId', 'rawPersistedAt', 'persistedAt'] as const);

// The realm is bootstrap configuration of the boundary; the adapter does not know it and never derives it from a topic.
export interface BrokerAdapterPort {
  // The consumer hands one observed delivery at a time to the handler and acts on the returned ACK decision.
  start(handler: (delivery: AdapterObservedDelivery) => Promise<AckDecision>): Promise<void>;
  stop(): Promise<void>;
}

// ---- ACK semantics (pure decision; no MQTT ack is implemented) ------------------------------------------------------------
export type QosLevel = 0 | 1 | 2;
export type AckDecisionCode =
  | 'ack-allowed'               // durable inbox majority-confirmed (receipt validated)
  | 'withhold-ack-retry'        // transient failure: the broker may redeliver (QoS 1/2)
  | 'loss-possible-qos0'        // QoS 0 and not persisted: the broker will NOT redeliver; the message may be lost
  | 'poison-policy-undecided';  // permanent rejection: ack-vs-withhold is a pending human decision
export interface AckDecision { readonly decision: AckDecisionCode; readonly qos: QosLevel }
const TRANSIENT = new Set(['broker-inbox-unavailable', 'broker-verifier-unavailable']);
export function decideBrokerAck(qos: QosLevel, result: { readonly status: string; readonly reasonCode?: string }): AckDecision {
  if (result.status === 'persisted' || result.status === 'ingested') return Object.freeze({ decision: 'ack-allowed' as const, qos });
  if (qos === 0) return Object.freeze({ decision: 'loss-possible-qos0' as const, qos });
  const transient = result.status === 'rejected' && result.reasonCode !== undefined && TRANSIENT.has(result.reasonCode);
  return Object.freeze({ decision: transient ? 'withhold-ack-retry' as const : 'poison-policy-undecided' as const, qos });
}
