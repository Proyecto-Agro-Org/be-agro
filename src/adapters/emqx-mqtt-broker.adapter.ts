import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import { emitMetric } from '../iot/ingestion-observability.js';
import type { IngestionMetricsPort } from '../iot/ingestion-operations.contracts.js';
import { decideBrokerAck, type AckDecision, type AdapterObservedDelivery } from '../iot/broker-adapter.contracts.js';

// BE13-11D — EMQX MQTT adapter. LOCAL_TEST_ONLY LABORATORY CODE: it refuses any broker that is not loopback and it is NOT wired
// into app.ts or any production bootstrap. It produces ONLY observed facts (BE13-11C contract). It never produces realm,
// business client id, source ownership, trusted/verified flags or hardware identity.
//
// Where the facts come from (verified against a real EMQX 5.8.6 in BE13-11D):
//   A plain MQTT subscriber does NOT see who published. The facts below are authored by the BROKER itself: an EMQX rule
//   (`SELECT clientid, username, qos, topic, flags.retain, publish_received_at, base64_encode(payload) ...`) republishes each
//   publish onto a topic that clients can neither publish to nor subscribe to (ACL), except this consumer's subscription. The
//   authenticated principal is the `username` EMQX authenticated for the PUBLISHER's connection. The payload travels as base64
//   so the exact bytes survive. The rule + ACL belong to the trusted computing base.
//
// ACK control (verified in MQTT.js 5.16.1 source and against the real broker): with protocolVersion 5, `customHandleAcks`
// is awaited BEFORE PUBACK/PUBREC is sent. The PUBACK is withheld until this adapter's handler returns a decision. On any
// failure the adapter does NOT ack and drops the connection, so the broker (persistent session) redelivers on reconnect.
export const LAB_VERIFIED_TOPIC = 'agro/lab/verified';

// ---- network guard: loopback literal IPs only (no DNS names, no userinfo, no TLS, no external hosts) --------------------
export function assertLoopbackBrokerUrl(raw: unknown): URL {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 128) throw new Error('LAB_BROKER_URL_INVALID');
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('LAB_BROKER_URL_INVALID'); }
  if (url.protocol !== 'mqtt:') throw new Error('LAB_BROKER_URL_PROTOCOL_NOT_ALLOWED');       // no mqtts/ws/wss: lab is plain loopback
  if (url.username !== '' || url.password !== '') throw new Error('LAB_BROKER_URL_CREDENTIALS_NOT_ALLOWED'); // credentials are passed separately
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = (isIP(host) === 4 && /^127\.\d+\.\d+\.\d+$/.test(host)) || host === '::1';
  if (!loopback) throw new Error('LAB_BROKER_HOST_NOT_LOOPBACK');                              // refuses localhost-by-name, domains and any other IP
  if (url.port === '' || Number(url.port) < 1024 || Number(url.port) > 65535) throw new Error('LAB_BROKER_PORT_INVALID');
  if (url.pathname !== '' && url.pathname !== '/') throw new Error('LAB_BROKER_URL_INVALID');
  return url;
}

// Refuses anything shaped like a managed/cloud broker or Atlas even if it were loopback-resolved by name.
export function assertLabCredentialShape(username: unknown, password: unknown): void {
  if (typeof username !== 'string' || !/^[A-Za-z0-9._@-]{1,64}$/.test(username)) throw new Error('LAB_CREDENTIAL_INVALID');
  if (typeof password !== 'string' || password.length < 16 || password.length > 128 || !/^labpw-[0-9a-f]+$/.test(password)) throw new Error('LAB_CREDENTIAL_NOT_TEST_ONLY');
}

// ---- broker-authored envelope (closed) ------------------------------------------------------------------------------------
const base64 = z.string().max(64 * 1024 * 1024).regex(/^[A-Za-z0-9+/]*={0,2}$/);
const envelopeSchema = z.object({
  clientid: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/),
  username: z.string().regex(/^[A-Za-z0-9._@-]{1,64}$/),
  qos: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  topic: z.string().min(1).max(1024),
  retain: z.boolean(),
  publish_received_at: z.number().int().min(0).max(8.64e15),
  payload_b64: base64,
}).strict();

export type EnvelopeParse = { ok: true; delivery: AdapterObservedDelivery; brokerReceivedAt: number } | { ok: false; reason: 'envelope-malformed' | 'payload-encoding-invalid' };

// Pure and exported: turns ONE broker-delivered message into observed facts. `connectionReference` and `receivedAt` are the
// adapter's own observations (a per-connection nonce and the adapter clock; see N1). Nothing here is derived from the payload.
export function parseBrokerAuthoredEnvelope(message: Uint8Array, packet: { qos: number; messageId?: number | undefined }, connectionReference: string, receivedAt: number): EnvelopeParse {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(message)); } catch { return { ok: false, reason: 'envelope-malformed' }; }
  const parsed = envelopeSchema.safeParse(value);
  if (!parsed.success) return { ok: false, reason: 'envelope-malformed' };
  const e = parsed.data;
  if (e.qos !== packet.qos) return { ok: false, reason: 'envelope-malformed' };               // the republish keeps the original QoS: a mismatch is not ours
  const bytes = Buffer.from(e.payload_b64, 'base64');
  if (bytes.toString('base64') !== e.payload_b64) return { ok: false, reason: 'payload-encoding-invalid' }; // canonical base64 only: exact bytes
  const packetId = typeof packet.messageId === 'number' && packet.qos > 0 ? packet.messageId : null;
  return { ok: true, brokerReceivedAt: e.publish_received_at, delivery: Object.freeze({
    brokerObserved: Object.freeze({ connectionReference, authenticatedPrincipalReference: 'emqx-user:' + e.username, mqttClientId: e.clientid, topic: e.topic,
      qos: e.qos, retain: e.retain, packetId, receivedAt }),
    payload: Uint8Array.from(bytes) }) };
}

// ---- adapter -----------------------------------------------------------------------------------------------------------
type MqttLikeClient = {
  on(event: string, listener: (...args: any[]) => void): unknown; // eslint-disable-line @typescript-eslint/no-explicit-any
  subscribe(topic: string, options: { qos: 0 | 1 | 2 }, callback: (error: Error | null, granted?: { qos: number }[]) => void): unknown;
  end(force?: boolean, opts?: object, callback?: () => void): unknown;
};
export type MqttFactory = (url: string, options: Record<string, unknown>) => MqttLikeClient;
export type PoisonLabPolicy = 'ack-and-drop' | 'withhold';
export interface EmqxMqttBrokerAdapterOptions {
  readonly brokerUrl: string;
  readonly clientId: string;
  readonly username: string;
  readonly password: string;
  readonly mqttFactory: MqttFactory;                       // injected (the real one is `mqtt.connect`); never imported here
  readonly metrics?: IngestionMetricsPort;
  readonly clock?: () => number;                           // adapter clock (N1: still the adapter's own clock)
  readonly sessionExpirySeconds?: number;                  // TEST_ONLY session setting
  readonly poisonPolicy?: PoisonLabPolicy;                 // TEST_ONLY lab behaviour for permanent rejections (production policy is undecided)
  readonly verifiedTopic?: string;
  // BE13-11E TEST_ONLY lab profiles (defaults keep the BE13-11D behaviour):
  readonly subscribeTopic?: string;                        // e.g. a `$share/<group>/agro/lab/verified` filter; deliveries still carry the broker-authored envelope
  readonly clean?: boolean;                                // false (default) = persistent session; true = clean start (queued QoS1 is NOT kept)
  readonly receiveMaximum?: number;                        // MQTT5 CONNECT property: how many unacknowledged QoS1/2 the broker may have in flight to this client
  readonly testHooks?: { readonly afterAck?: (delivery: AdapterObservedDelivery) => void; readonly beforeHandler?: (delivery: AdapterObservedDelivery) => void };
}
export interface EmqxMqttBrokerAdapter {
  start(handler: (delivery: AdapterObservedDelivery) => Promise<AckDecision>): Promise<void>;
  stop(): Promise<void>;
  readonly stats: () => Readonly<Record<'received' | 'acked' | 'withheld' | 'dropped' | 'malformed' | 'qos0', number>>;
  readonly connectionReference: () => string | null;
  readonly closed: () => boolean;                          // true once the connection closed (the lab supervisor restarts a NEW adapter)
  readonly lastBrokerReceivedAt: () => number | null;
}

export function createEmqxMqttBrokerAdapter(options: EmqxMqttBrokerAdapterOptions): EmqxMqttBrokerAdapter {
  const url = assertLoopbackBrokerUrl(options.brokerUrl);
  assertLabCredentialShape(options.username, options.password);
  if (typeof options.mqttFactory !== 'function') throw new TypeError('mqttFactory required');
  const topic = options.verifiedTopic ?? LAB_VERIFIED_TOPIC;
  const clock = options.clock ?? (() => Date.now());
  const poison: PoisonLabPolicy = options.poisonPolicy ?? 'withhold';
  const counters = { received: 0, acked: 0, withheld: 0, dropped: 0, malformed: 0, qos0: 0 };
  let client: MqttLikeClient | null = null, connectionRef: string | null = null, lastBroker: number | null = null, isClosed = false;

  const metric = (name: 'broker_adapter_connection_total' | 'broker_adapter_delivery_total', outcome: string) => options.metrics ? emitMetric(options.metrics, name, { stage: 'boundary', outcome }) : Promise.resolve();

  async function decide(handler: (d: AdapterObservedDelivery) => Promise<AckDecision>, delivery: AdapterObservedDelivery): Promise<AckDecision> {
    try { options.testHooks?.beforeHandler?.(delivery); return await handler(delivery); }
    catch { return Object.freeze({ decision: 'withhold-ack-retry' as const, qos: delivery.brokerObserved.qos }); } // a failing handler is never an ack
  }

  async function start(handler: (delivery: AdapterObservedDelivery) => Promise<AckDecision>): Promise<void> {
    if (client) throw new Error('LAB_ADAPTER_ALREADY_STARTED');
    connectionRef = 'emqx-rule-delivery:' + randomBytes(8).toString('hex'); // new on every start: no trusted state survives a restart
    const handleAck = async (_t: string, message: Buffer, packet: { qos: number; messageId?: number }, cb: (error: Error | number | null, code?: number) => void) => {
      counters.received += 1; await metric('broker_adapter_delivery_total', 'received');
      const parsed = parseBrokerAuthoredEnvelope(message, packet, connectionRef!, clock());
      if (!parsed.ok) { counters.malformed += 1; await metric('broker_adapter_delivery_total', 'rejected'); return finish(poisonDecision(packet.qos as 0 | 1 | 2), cb); }
      lastBroker = parsed.brokerReceivedAt;
      const decision = await decide(handler, parsed.delivery);
      return finish(decision, cb, parsed.delivery);
    };
    const finish = async (decision: AckDecision, cb: (error: Error | number | null, code?: number) => void, delivery?: AdapterObservedDelivery) => {
      if (decision.decision === 'ack-allowed') { counters.acked += 1; await metric('broker_adapter_delivery_total', 'acked'); cb(null, 0); if (delivery) options.testHooks?.afterAck?.(delivery); return; }
      if (decision.decision === 'poison-policy-undecided' && poison === 'ack-and-drop') { counters.dropped += 1; await metric('broker_adapter_delivery_total', 'dropped'); cb(null, 0); return; }
      // Anything else: NO ack, and the connection is dropped so the broker keeps the message in the session for redelivery.
      counters.withheld += 1; await metric('broker_adapter_delivery_total', 'withheld');
      client?.end(true);
    };
    const poisonDecision = (qos: 0 | 1 | 2): AckDecision => Object.freeze({ decision: 'poison-policy-undecided' as const, qos });
    const clientOptions: Record<string, unknown> = {
      protocolVersion: 5, clientId: options.clientId, username: options.username, password: options.password, clean: options.clean ?? false, reconnectPeriod: 0,
      properties: { sessionExpiryInterval: options.sessionExpirySeconds ?? 600, ...(options.receiveMaximum === undefined ? {} : { receiveMaximum: options.receiveMaximum }) }, customHandleAcks: handleAck,
    };
    const c = options.mqttFactory(url.toString(), clientOptions);
    client = c;
    c.on('message', (_t: string, message: Buffer, packet: { qos: number; messageId?: number }) => {
      if (packet.qos !== 0) return;                              // QoS 1/2 were handled (and acked) in customHandleAcks
      counters.qos0 += 1;
      void (async () => {
        const parsed = parseBrokerAuthoredEnvelope(message, packet, connectionRef!, clock());
        if (!parsed.ok) { counters.malformed += 1; return; }
        lastBroker = parsed.brokerReceivedAt;
        await decide(handler, parsed.delivery);                  // no ack exists for QoS 0: nothing can be withheld or redelivered
      })();
    });
    await new Promise<void>((resolve, reject) => {
      c.on('connect', () => { void metric('broker_adapter_connection_total', 'connected'); c.subscribe(options.subscribeTopic ?? topic, { qos: 2 }, error => error ? reject(error) : resolve()); });
      c.on('error', (error: Error) => reject(error));
      c.on('close', () => { isClosed = true; void metric('broker_adapter_connection_total', 'disconnected'); });
    });
  }

  async function stop(): Promise<void> {
    const c = client; client = null;
    if (c) await new Promise<void>(resolve => { c.end(true, {}, () => resolve()); });
  }
  return Object.freeze({ start, stop, stats: () => Object.freeze({ ...counters }), connectionReference: () => connectionRef, closed: () => isClosed, lastBrokerReceivedAt: () => lastBroker });
}

// ---- readiness: laboratory only. productionReady is ALWAYS false -------------------------------------------------------------
export function describeEmqxLocalLabReadiness(input: { readonly loopbackGuard: boolean; readonly testOnlyCredentials: boolean; readonly deferredAck: boolean;
  readonly durableInbox: boolean; readonly reconciliation: boolean; readonly cleanupVerified: boolean }) {
  const emqxLocalLabReady = Object.values(input).every(v => v === true);
  return Object.freeze({ emqxLocalLabReady, productionReady: false as const, scope: 'LOCAL_TEST_ONLY' as const,
    limitations: Object.freeze(['PRODUCTION_AUTH_PENDING', 'BROKER_RULE_AND_ACL_ARE_TCB', 'PUBLISHER_FACTS_VIA_BROKER_RULE', 'RECEIVED_AT_CLOCK_N1_OPEN', 'NO_PRODUCTION_WORKER']) });
}
export { decideBrokerAck };
