// BE13-11N — LOCAL_TEST_ONLY durable publisher: outbox + two-lane retry + explicit terminal states. Never imported by app code.
//
//   submit(event) -> durable outbox entry (eventId + payloadSha256 + exact bytes) -> publish (PUBACK = BROKER_ACCEPTED only) -> wait -> confirm over the reconciliation API
//   -> CONFIRMED | QUARANTINED | CONFLICT | (fast lane exhausted) UNCONFIRMED alert + slow lane | (slow lane exhausted) UNCONFIRMED_EXPLICIT.
// Invariants (each one has a mutant in test/be13-11n-mutants.test.js):
//   * the SAME eventId and the SAME bytes on every attempt; an eventId reused with other bytes is refused, never overwritten;
//   * PUBACK, pending, not-found, unknown statuses, timeouts and an unreachable backend are never success;
//   * a full outbox REJECTS explicitly (`OUTBOX_FULL`); nothing is ever discarded silently;
//   * the outbox survives a crash/restart (state is persisted atomically BEFORE it is relied upon);
//   * one publisher identity = ONE MQTT connection (the boundary binds the MQTT clientId to the device's technical key, so two connections with the same clientId are an identity collision).
// All policy values are injected. The productive default is BLOCKED; the values in PROPOSED_OUTBOX_POLICY are the BE13-11K proposal, NOT approved.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { CONFIRMED_STATUSES } from '../../src/iot/ingest-confirmation.contracts.js';

export type OutboxStatus = 'PENDING' | 'CONFIRMED' | 'QUARANTINED' | 'CONFLICT' | 'UNCONFIRMED_EXPLICIT';
export type Lane = 'fast' | 'slow';
export type Phase = 'needs-publish' | 'awaiting-confirm';
export interface OutboxEntry {
  readonly eventId: string; readonly payloadSha256: string; readonly payloadB64: string; readonly createdAt: number;
  attempts: number; slowAttempts: number; lastAttemptAt: number | null; nextAttemptAt: number; status: OutboxStatus; lane: Lane; phase: Phase;
  brokerAcceptedCount: number; unconfirmedSince: number | null; lastConfirmation: string | null; finishedAt: number | null; version: number;
}
export interface OutboxStore {
  load(): OutboxEntry[];
  save(entries: readonly OutboxEntry[]): void;       // atomic and durable: after it returns the state survives a crash
}

export type OutboxPolicy =
  | { readonly mode: 'BLOCKED'; readonly reason: 'publisher-outbox-policy-not-decided' }
  | { readonly mode: 'TEST_ONLY' | 'APPROVED'; readonly capacity: number;
      readonly fast: { readonly initialDelayMs: number; readonly backoffFactor: number; readonly maxDelayMs: number; readonly jitterRatio: number; readonly maxAttempts: number; readonly maxElapsedMs: number };
      readonly slow: { readonly intervalMs: number; readonly confirmWaitMs: number; readonly maxElapsedMs: number } };
export const DEFAULT_OUTBOX_POLICY: OutboxPolicy = Object.freeze({ mode: 'BLOCKED', reason: 'publisher-outbox-policy-not-decided' });
/** PROPOSED by BE13-11K (3 s, x2, cap 60 s, +-25 %, 8 attempts, 10 min; slow lane 15 min up to 24 h). NOT approved. Capacity is a placeholder. */
export const PROPOSED_OUTBOX_POLICY: Exclude<OutboxPolicy, { mode: 'BLOCKED' }> = Object.freeze({ mode: 'TEST_ONLY', capacity: 1000,
  fast: Object.freeze({ initialDelayMs: 3000, backoffFactor: 2, maxDelayMs: 60_000, jitterRatio: 0.25, maxAttempts: 8, maxElapsedMs: 600_000 }),
  slow: Object.freeze({ intervalMs: 900_000, confirmWaitMs: 3000, maxElapsedMs: 86_400_000 }) });

export type ConfirmAnswer = { readonly ok: true; readonly status: string } | { readonly ok: false };
export interface PublisherDeps {
  /** Publishes the stored bytes of `eventId` on the publisher's single connection. true = PUBACK (BROKER_ACCEPTED). */
  publish(eventId: string, bytes: Uint8Array): Promise<boolean>;
  confirm(eventId: string, payloadSha256: string): Promise<ConfirmAnswer>;
  now(): number;
  random(): number;
  onTransition?(event: { eventId: string; from: string; to: string; attempt: number; lane: Lane; confirmation?: string | null }): void;
}
export type SubmitResult = { readonly result: 'ACCEPTED' | 'ALREADY_PRESENT'; readonly eventId: string } | { readonly result: 'REJECTED_OUTBOX_FULL' } | { readonly result: 'REJECTED_EVENT_ID_REUSED_WITH_OTHER_BYTES' };

export const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function createMemoryOutboxStore(): OutboxStore & { snapshot(): OutboxEntry[] } {
  let state: OutboxEntry[] = [];
  return { load: () => structuredClone(state), save: e => { state = structuredClone([...e]); }, snapshot: () => structuredClone(state) };
}
/** Durable file store: write temp file, fsync, atomic rename. A crash leaves either the old or the new state, never a torn one. */
export function createFileOutboxStore(path: string): OutboxStore {
  return {
    load() { if (!existsSync(path)) return []; const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version: 1; entries: OutboxEntry[] }; if (parsed.version !== 1 || !Array.isArray(parsed.entries)) throw new Error('OUTBOX_FILE_CORRUPT'); return parsed.entries; },
    save(entries) { mkdirSync(dirname(path), { recursive: true }); const tmp = path + '.tmp'; writeFileSync(tmp, JSON.stringify({ version: 1, entries }), 'utf8'); const fd = openSync(tmp, 'r+'); try { fsyncSync(fd); } finally { closeSync(fd); } renameSync(tmp, path); },
  };
}

export function validateOutboxPolicy(policy: OutboxPolicy): asserts policy is Exclude<OutboxPolicy, { mode: 'BLOCKED' }> {
  if (policy.mode === 'BLOCKED') throw new TypeError('PUBLISHER_OUTBOX_POLICY_BLOCKED');
  const ok = (n: number, lo: number, hi: number) => Number.isFinite(n) && n >= lo && n <= hi;
  const f = policy.fast, s = policy.slow;
  if (!ok(policy.capacity, 1, 10_000_000) || !Number.isInteger(policy.capacity) || !ok(f.initialDelayMs, 0, 3_600_000) || !ok(f.backoffFactor, 1, 10) || !ok(f.maxDelayMs, 0, 3_600_000) || !ok(f.jitterRatio, 0, 1) ||
    !Number.isInteger(f.maxAttempts) || !ok(f.maxAttempts, 1, 100) || !ok(f.maxElapsedMs, 1, 86_400_000) || !ok(s.intervalMs, 1, 86_400_000) || !ok(s.confirmWaitMs, 0, 3_600_000) || !ok(s.maxElapsedMs, 1, 31_536_000_000)) throw new TypeError('PUBLISHER_OUTBOX_POLICY_INVALID');
}

export function createOutboxPublisher(options: { store: OutboxStore; policy: OutboxPolicy; deps: PublisherDeps }) {
  validateOutboxPolicy(options.policy);
  const policy = options.policy, { deps } = options;
  let entries = options.store.load();                                  // restart recovery: the durable state IS the state
  let gateOpen = true;
  const persist = () => options.store.save(entries);
  const emit = (e: OutboxEntry, from: string, to: string, confirmation?: string | null) => { try { deps.onTransition?.({ eventId: e.eventId, from, to, attempt: e.attempts, lane: e.lane, confirmation: confirmation ?? null }); } catch { /* observers never change behaviour */ } };
  const delayFor = (attempt: number) => { const base = Math.min(policy.fast.maxDelayMs, policy.fast.initialDelayMs * policy.fast.backoffFactor ** (attempt - 1)); return Math.max(0, Math.round(base * (1 + (deps.random() * 2 - 1) * policy.fast.jitterRatio))); };
  const active = () => entries.filter(e => e.status !== 'CONFIRMED').length;           // a confirmed entry has done its job and no longer holds capacity

  function submit(event: { eventId: string; bytes: Uint8Array }): SubmitResult {
    const sha = sha256Hex(event.bytes), existing = entries.find(e => e.eventId === event.eventId);
    if (existing) return existing.payloadSha256 === sha ? { result: 'ALREADY_PRESENT', eventId: event.eventId } : { result: 'REJECTED_EVENT_ID_REUSED_WITH_OTHER_BYTES' };
    if (active() >= policy.capacity) return { result: 'REJECTED_OUTBOX_FULL' };                // explicit: the caller still owns the event; nothing was dropped
    const now = deps.now();
    entries.push({ eventId: event.eventId, payloadSha256: sha, payloadB64: Buffer.from(event.bytes).toString('base64'), createdAt: now, attempts: 0, slowAttempts: 0, lastAttemptAt: null, nextAttemptAt: now, status: 'PENDING', lane: 'fast', phase: 'needs-publish',
      brokerAcceptedCount: 0, unconfirmedSince: null, lastConfirmation: null, finishedAt: null, version: 1 });
    persist(); return { result: 'ACCEPTED', eventId: event.eventId };
  }

  const finish = (e: OutboxEntry, status: OutboxStatus, now: number, confirmation: string | null) => { const from = e.status; e.status = status; e.finishedAt = now; e.lastConfirmation = confirmation; e.version += 1; emit(e, from, status, confirmation); };

  async function step(e: OutboxEntry, now: number): Promise<void> {
    if (e.phase === 'needs-publish') {
      let accepted = false;
      try { accepted = (await deps.publish(e.eventId, Buffer.from(e.payloadB64, 'base64'))) === true; } catch { accepted = false; }   // the SAME eventId and bytes on every attempt
      const t = deps.now(); e.attempts += 1; if (e.lane === 'slow') e.slowAttempts += 1; e.lastAttemptAt = t; if (accepted) e.brokerAcceptedCount += 1;
      e.phase = 'awaiting-confirm'; e.nextAttemptAt = t + (e.lane === 'fast' ? delayFor(e.attempts) : policy.slow.confirmWaitMs); e.version += 1; emit(e, 'needs-publish', 'awaiting-confirm', accepted ? 'puback' : 'no-puback');
      return;
    }
    let answer: ConfirmAnswer; try { answer = await deps.confirm(e.eventId, e.payloadSha256); } catch { answer = { ok: false }; }
    const label = answer.ok && typeof answer.status === 'string' ? answer.status : 'unreachable';
    if (answer.ok && (CONFIRMED_STATUSES as readonly string[]).includes(answer.status)) return finish(e, 'CONFIRMED', deps.now(), label);
    if (answer.ok && answer.status === 'quarantined') return finish(e, 'QUARANTINED', deps.now(), label);
    if (answer.ok && answer.status === 'conflict') return finish(e, 'CONFLICT', deps.now(), label);                 // a publisher error: never retried
    e.lastConfirmation = label; const t = deps.now(); e.phase = 'needs-publish'; e.version += 1;
    if (e.lane === 'fast') {
      if (e.attempts >= policy.fast.maxAttempts || t - e.createdAt >= policy.fast.maxElapsedMs) {                    // fast lane spent: UNCONFIRMED alert, event stays owned by the slow lane
        e.lane = 'slow'; e.unconfirmedSince = t; e.nextAttemptAt = t + policy.slow.intervalMs; emit(e, 'fast', 'slow', 'UNCONFIRMED');
      } else e.nextAttemptAt = t;                                                                                      // the wait already happened before the confirmation query
    } else if (t - e.createdAt >= policy.slow.maxElapsedMs) finish(e, 'UNCONFIRMED_EXPLICIT', t, label);              // slow lane spent: explicit, retained, never "success", never "lost"
    else e.nextAttemptAt = t + policy.slow.intervalMs;
  }

  /** Processes every due entry once (sequentially per entry, bounded concurrency across entries). Returns the number of entries processed. */
  async function tick(concurrency = 8): Promise<number> {
    if (!gateOpen) return 0;
    const now = deps.now(), due = entries.filter(e => e.status === 'PENDING' && e.nextAttemptAt <= now);
    let i = 0; const worker = async () => { for (;;) { const e = due[i++]; if (!e) return; await step(e, now); } };
    await Promise.all(Array.from({ length: Math.min(concurrency, due.length) }, worker));
    if (due.length > 0) persist();
    return due.length;
  }
  return {
    submit, tick, persist,
    /** Test/campaign control: while closed, tick() does nothing (used to hold the retry loop during the original F-E2 window). */
    setGate(open: boolean) { gateOpen = open; },
    entries: () => structuredClone(entries) as OutboxEntry[],
    get: (eventId: string) => { const e = entries.find(x => x.eventId === eventId); return e ? structuredClone(e) as OutboxEntry : null; },
    stats(now = deps.now()) { const open = entries.filter(e => e.status === 'PENDING'); return { total: entries.length, pending: open.length, fast: open.filter(e => e.lane === 'fast').length, slow: open.filter(e => e.lane === 'slow').length,
      oldestPendingAgeMs: open.length ? Math.max(...open.map(e => now - e.createdAt)) : 0, byStatus: entries.reduce((a: Record<string, number>, e) => { a[e.status] = (a[e.status] ?? 0) + 1; return a; }, {}) }; },
    /** Removes CONFIRMED entries (their job is done). Every other terminal state is retained for the operator. */
    compact() { const before = entries.length; entries = entries.filter(e => e.status !== 'CONFIRMED'); if (entries.length !== before) persist(); return before - entries.length; },
  };
}
