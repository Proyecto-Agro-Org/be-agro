// BE13-11I — LOCAL_TEST_ONLY pure helpers for the D13 -> D13b stale-replay / eventual-delivery analysis. No I/O, no broker access, never imported by app code.

export type PacketRecord = { t: number; scn: string; dup: boolean | null; qos: number | null; messageId: number | null; eventId: string };
export type FieldReport = { name: string; value: unknown; source: string; status: 'OBSERVED' | 'NOT_EXPOSED' };

/** Decodes the broker-authored envelope (`{ payload_b64 }`) and returns the eventId of the inner payload ('' when it cannot be decoded). */
export function eventIdFromEnvelope(payload: Uint8Array): string {
  try {
    const env = JSON.parse(Buffer.from(payload).toString('utf8')) as { payload_b64?: string };
    const raw = Buffer.from(String(env.payload_b64 ?? ''), 'base64');
    return String((JSON.parse(raw.toString('utf8')) as { eventId?: string }).eventId ?? '');
  } catch { return ''; }
}

/** `e11f-d13-7` -> 'd13', `e11f-d13b-7` -> 'd13b'; anything else -> null. */
export function scenarioOfEvent(eventId: string): string | null { const m = /^e11f-([a-z0-9]+)-\d+$/.exec(eventId); return m ? m[1]! : null; }

/** Splits delivered ids into "own" (current cycle) and "stale" (any other scenario); never mixes them. */
export function splitStaleOwn(deliveredIds: Iterable<string>, ownIds: ReadonlySet<string>): { own: string[]; stale: string[] } {
  const own: string[] = [], stale: string[] = [];
  for (const id of new Set(deliveredIds)) (ownIds.has(id) ? own : stale).push(id);
  return { own, stale };
}

const SESSION_FIELDS = ['clientid', 'connected', 'clean_start', 'expiry_interval', 'inflight_cnt', 'inflight_max', 'mqueue_len', 'mqueue_max', 'mqueue_dropped', 'subscriptions_cnt', 'created_at', 'connected_at', 'disconnected_at',
  'recv_cnt', 'recv_msg', 'send_cnt', 'send_msg', 'awaiting_rel_cnt', 'awaiting_rel_max', 'recv_msg.qos1', 'send_msg.qos1', 'send_msg.dropped', 'send_msg.dropped.queue_full', 'send_msg.dropped.expired', 'durable', 'proto_ver', 'node'] as const;
type Resp = { status?: number; body?: string; error?: string } | undefined;

/** Parses the COMPLETE management-API bodies (never truncated before JSON.parse). A field the API does not return is `NOT_EXPOSED`; nothing is inferred. */
export function parseSessionResponses(r: { client?: Resp; subscriptions?: Resp; inflight?: Resp; mqueue?: Resp }): { fields: FieldReport[]; subscriptions: unknown[] | null; inflightMessages: unknown[] | null; mqueueMessages: unknown[] | null; clientHttpStatus: number | null } {
  const parse = (x: Resp): unknown => { if (!x || x.status !== 200 || typeof x.body !== 'string') return undefined; try { return JSON.parse(x.body); } catch { return undefined; } };
  const c = parse(r.client) as Record<string, unknown> | undefined;
  const fields: FieldReport[] = SESSION_FIELDS.map(name => c !== undefined && Object.prototype.hasOwnProperty.call(c, name)
    ? { name, value: c[name], source: 'GET /clients/{clientid}', status: 'OBSERVED' as const } : { name, value: null, source: 'GET /clients/{clientid}', status: 'NOT_EXPOSED' as const });
  const list = (x: unknown): unknown[] | null => Array.isArray(x) ? x : x && typeof x === 'object' && Array.isArray((x as { data?: unknown }).data) ? (x as { data: unknown[] }).data : null;
  return { fields, subscriptions: list(parse(r.subscriptions)), inflightMessages: list(parse(r.inflight)), mqueueMessages: list(parse(r.mqueue)), clientHttpStatus: r.client?.status ?? null };
}

export type Timeline = { firstStaleAt: number | null; lastStaleAt: number | null; lastStaleAckAt: number | null; firstOwnAt: number | null; lastOwnAt: number | null; ownAfterLastStaleAckGapMs: number | null;
  staleBeforeFirstOwn: number; ownDeliveredBeforeStaleDrained: number; ownDeliveredAfterStaleDrained: number; staleDrained: boolean };

/** Timeline of the stale drain vs. the first/last own delivery. `ackedAt` = per-event ACK-release instants; the stale set is drained when every stale event has one. */
export function deliveryTimeline(packets: readonly PacketRecord[], ownIds: ReadonlySet<string>, staleIds: readonly string[], ackedAt: ReadonlyMap<string, number>): Timeline {
  const first = new Map<string, number>(), last = new Map<string, number>();
  for (const p of packets) { if (!first.has(p.eventId)) first.set(p.eventId, p.t); last.set(p.eventId, p.t); }
  const staleSeen = staleIds.filter(id => first.has(id)), ownSeen = [...ownIds].filter(id => first.has(id));
  const min = (v: number[]) => v.length ? Math.min(...v) : null, max = (v: number[]) => v.length ? Math.max(...v) : null;
  const staleAcks = staleIds.map(id => ackedAt.get(id)).filter((x): x is number => x !== undefined);
  const staleDrained = staleIds.length > 0 && staleAcks.length === staleIds.length;
  const lastStaleAckAt = max(staleAcks), firstOwnAt = min(ownSeen.map(id => first.get(id)!)), lastOwnAt = max(ownSeen.map(id => first.get(id)!));
  const after = lastStaleAckAt === null ? [] : ownSeen.filter(id => first.get(id)! > lastStaleAckAt);
  const firstOwnAfter = after.length ? Math.min(...after.map(id => first.get(id)!)) : null;
  return { firstStaleAt: min(staleSeen.map(id => first.get(id)!)), lastStaleAt: max(staleSeen.map(id => last.get(id)!)), lastStaleAckAt, firstOwnAt, lastOwnAt,
    ownAfterLastStaleAckGapMs: lastStaleAckAt !== null && firstOwnAfter !== null ? Math.round(firstOwnAfter - lastStaleAckAt) : null,
    staleBeforeFirstOwn: firstOwnAt === null ? staleSeen.length : staleSeen.filter(id => first.get(id)! < firstOwnAt).length,
    ownDeliveredBeforeStaleDrained: lastStaleAckAt === null ? ownSeen.length : ownSeen.length - after.length, ownDeliveredAfterStaleDrained: after.length, staleDrained };
}

export type EventualClass = 'EVENTUALLY_DELIVERED' | 'PARTIAL_EVENTUAL_DELIVERY' | 'NOT_EVENTUALLY_DELIVERED';
/** n/n -> EVENTUALLY_DELIVERED; 1..n-1 -> PARTIAL; none -> NOT. `delivered` counts distinct own events delivered by the end of the (extended) window. */
export function classifyEventualDelivery(delivered: number, n: number): EventualClass {
  if (n > 0 && delivered >= n) return 'EVENTUALLY_DELIVERED';
  return delivered > 0 ? 'PARTIAL_EVENTUAL_DELIVERY' : 'NOT_EVENTUALLY_DELIVERED';
}

export type Outcome = 'STALE_REPLAY_STARVATION_LOCAL' | 'SESSION_STATE_LOSS_LOCAL' | 'MIXED_SESSION_FAILURE_LOCAL' | 'INCONCLUSIVE_LOCAL';
/** Final classification. Own events missing after the stale drain AND the whole window: nothing arrived after the drain -> state loss; something arrived but not all -> mixed. */
export function classifyOutcome(o: { n: number; ownDeliveredFinal: number; ownDeliveredAfterDrain: number; staleDelivered: number; staleDrained: boolean; timedOut: boolean }): Outcome {
  if (o.n <= 0) return 'INCONCLUSIVE_LOCAL';
  if (o.ownDeliveredFinal >= o.n) return o.staleDelivered > 0 ? 'STALE_REPLAY_STARVATION_LOCAL' : 'INCONCLUSIVE_LOCAL';   // n/n without any stale replay is not this phenomenon
  if (!o.staleDrained || !o.timedOut) return 'INCONCLUSIVE_LOCAL';                                                         // the missing events were not observed past a full drain + the whole window
  return o.ownDeliveredAfterDrain > 0 ? 'MIXED_SESSION_FAILURE_LOCAL' : 'SESSION_STATE_LOSS_LOCAL';
}
