// BE13-11N — offline tests of the durable publisher (outbox, two lanes, restart recovery, explicit terminal states). No broker, no Docker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as mod from '../dist/scripts/be13-11n/publisher-outbox.js';
import { createIngestConfirmationService } from '../dist/src/services/ingest-confirmation.service.js';
import { A, createBackend } from '../test-support/be13-11j-invariants.js';
import { bytesOf, checkOutboxInvariants, policy, rig, sha } from '../test-support/be13-11n-invariants.js';

test('O1 baseline: one publish, PUBACK, one confirmation => CONFIRMED, no retry; confirmed entries free capacity on compact', async () => {
  const r = rig(mod); r.pub.submit({ eventId: 'o1', bytes: bytesOf('o1') }); await r.pump();
  const e = r.pub.get('o1'); assert.equal(e.status, 'CONFIRMED'); assert.equal(e.attempts, 1); assert.equal(r.calls.length, 1); assert.equal(e.brokerAcceptedCount, 1);
  assert.equal(r.pub.compact(), 1); assert.equal(r.pub.entries().length, 0);
});

test('O2 F-E2: PUBACK without delivery => not-found, retry with the SAME eventId and bytes, then confirmation', async () => {
  const r = rig(mod, { publishAs: (id, n) => ({ puback: true, deliver: n >= 3 }) }); r.pub.submit({ eventId: 'o2', bytes: bytesOf('o2') }); await r.pump();
  const e = r.pub.get('o2'); assert.equal(e.status, 'CONFIRMED'); assert.equal(e.attempts, 3); assert.deepEqual([...new Set(r.calls.map(c => c.eventId))], ['o2']); assert.equal(new Set(r.calls.map(c => c.sha)).size, 1); assert.equal(e.brokerAcceptedCount, 3);
});

test('O3 duplicate: first publish arrived but its confirmation was lost; the retry creates no second measurement', async () => {
  const backend = createBackend(), service = createIngestConfirmationService({ evidence: backend.evidence }); let asked = 0;
  const r = rig(mod, { publishAs: (id) => { backend.deliver(A, id, sha(bytesOf(id))); return { puback: true, deliver: false }; }, confirmAs: async (id, h) => { asked += 1; if (asked === 1) return { ok: false }; return { ok: true, status: (await service.confirm(A, id, h)).status }; } });
  r.pub.submit({ eventId: 'o3', bytes: bytesOf('o3') }); await r.pump(); const e = r.pub.get('o3');
  assert.equal(e.status, 'CONFIRMED'); assert.equal(e.lastConfirmation, 'duplicate-confirmed'); assert.equal(backend.measurementCount(), 1); assert.equal(e.attempts, 2);
});

test('O4 quarantine and conflict are terminal and are never retried; neither is success', async () => {
  for (const [status, expect] of [['quarantined', 'QUARANTINED'], ['conflict', 'CONFLICT']]) {
    const r = rig(mod, { confirmAs: async () => ({ ok: true, status }) }); r.pub.submit({ eventId: 'o4', bytes: bytesOf('o4') }); await r.pump(); const e = r.pub.get('o4');
    assert.equal(e.status, expect); assert.equal(r.calls.length, 1); assert.ok(e.finishedAt !== null); assert.equal(r.pub.compact(), 0);          // retained for the operator
  }
});

test('O5 two lanes: fast lane spent => UNCONFIRMED alert + slow lane (still owned); slow lane spent => UNCONFIRMED_EXPLICIT, retained', async () => {
  const r = rig(mod, { confirmAs: async () => ({ ok: false }) }); r.pub.submit({ eventId: 'o5', bytes: bytesOf('o5') });
  await r.pump(2000); let e = r.pub.get('o5'); assert.equal(e.status, 'PENDING'); assert.equal(e.lane, 'slow'); assert.ok(e.unconfirmedSince !== null); assert.ok(e.attempts >= 3);
  assert.ok(r.transitions.some(x => x.from === 'fast' && x.to === 'slow' && x.confirmation === 'UNCONFIRMED'));
  await r.pump(120_000); e = r.pub.get('o5'); assert.equal(e.status, 'UNCONFIRMED_EXPLICIT'); assert.ok(e.slowAttempts >= 2); assert.ok(e.finishedAt !== null); assert.equal(r.pub.compact(), 0);
  assert.equal(new Set(r.calls.map(c => c.eventId)).size, 1);
});

test('O6 saturation: a full outbox REJECTS explicitly (nothing dropped); confirmed entries free capacity', async () => {
  const r = rig(mod, { pol: policy({ capacity: 2 }) });
  assert.equal(r.pub.submit({ eventId: 'o6a', bytes: bytesOf('a') }).result, 'ACCEPTED'); assert.equal(r.pub.submit({ eventId: 'o6b', bytes: bytesOf('b') }).result, 'ACCEPTED');
  assert.equal(r.pub.submit({ eventId: 'o6c', bytes: bytesOf('c') }).result, 'REJECTED_OUTBOX_FULL'); assert.equal(r.pub.entries().length, 2);
  await r.pump(); assert.equal(r.pub.submit({ eventId: 'o6c', bytes: bytesOf('c') }).result, 'ACCEPTED');
});

test('O7 eventId reuse: other bytes refused, same bytes idempotent', () => {
  const r = rig(mod); assert.equal(r.pub.submit({ eventId: 'o7', bytes: bytesOf('o7', 1) }).result, 'ACCEPTED');
  assert.equal(r.pub.submit({ eventId: 'o7', bytes: bytesOf('o7', 1) }).result, 'ALREADY_PRESENT'); assert.equal(r.pub.submit({ eventId: 'o7', bytes: bytesOf('o7', 2) }).result, 'REJECTED_EVENT_ID_REUSED_WITH_OTHER_BYTES');
  assert.equal(r.pub.entries()[0].payloadSha256, sha(bytesOf('o7', 1)));
});

test('O8 restart recovery with the FILE store: the outbox survives a crash and resumes with the same eventIds, bytes and attempts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'outbox-')), path = join(dir, 'outbox.json'); const store = mod.createFileOutboxStore(path);
  const r1 = rig(mod, { store, publishAs: (id, n) => ({ puback: true, deliver: false }) });
  for (let i = 0; i < 3; i += 1) r1.pub.submit({ eventId: 'o8-' + i, bytes: bytesOf('o8-' + i) });
  await r1.pub.tick();                                                                       // all three published once (phase awaiting-confirm), state persisted
  const before = r1.pub.entries(); assert.ok(before.every(e => e.attempts === 1 && e.phase === 'awaiting-confirm'));
  // CRASH: r1 and its in-memory state are gone; a new process builds a publisher over the same file.
  const delivered = new Map(); const calls = []; let now = r1.t();
  const r2pub = mod.createOutboxPublisher({ store: mod.createFileOutboxStore(path), policy: policy(), deps: { now: () => now, random: () => 0.5,
    publish: async (id, bytes) => { calls.push({ id, sha: sha(bytes) }); delivered.set(id, sha(bytes)); return true; }, confirm: async (id, h) => ({ ok: true, status: delivered.get(id) === h ? 'processed' : 'not-found' }) } });
  assert.deepEqual(r2pub.entries().map(e => [e.eventId, e.attempts, e.payloadB64]), before.map(e => [e.eventId, e.attempts, e.payloadB64]));
  for (let i = 0; i < 20 && r2pub.stats().pending > 0; i += 1) { now += 200; await r2pub.tick(); }
  assert.equal(r2pub.stats().byStatus.CONFIRMED, 3); assert.deepEqual(new Set(calls.map(c => c.id)), new Set(['o8-0', 'o8-1', 'o8-2'])); assert.ok(calls.every(c => c.sha === sha(bytesOf(c.id))));
  assert.equal(existsSync(path + '.tmp'), false);
});

test('O9 crash between publish and persist: the entry is re-published with the SAME eventId (at-least-once), never lost', async () => {
  const store = mod.createMemoryOutboxStore(); const r1 = rig(mod, { store }); r1.pub.submit({ eventId: 'o9', bytes: bytesOf('o9') });
  const lost = mod.createMemoryOutboxStore(); lost.save(store.load());                      // the state a crash would leave: submitted, publish done, NOT persisted
  await r1.pub.tick();                                                                       // (r1 persisted, but the "crashed" copy is the older state)
  const r2 = mod.createOutboxPublisher({ store: lost, policy: policy(), deps: r1.deps }); assert.equal(r2.get('o9').attempts, 0);
  await r2.tick(); assert.equal(r1.calls.filter(c => c.eventId === 'o9').length, 2); assert.equal(new Set(r1.calls.map(c => c.sha)).size, 1);
});

test('O10 file store: corrupt files fail closed; the temp file is never read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'outbox-')), path = join(dir, 'o.json'); writeFileSync(path, '{"version":2,"entries":[]}');
  assert.throws(() => mod.createFileOutboxStore(path).load(), /OUTBOX_FILE_CORRUPT/); writeFileSync(path, 'not json'); assert.throws(() => mod.createFileOutboxStore(path).load());
  writeFileSync(path + '.tmp', 'garbage'); writeFileSync(path, JSON.stringify({ version: 1, entries: [] })); assert.deepEqual(mod.createFileOutboxStore(path).load(), []);
  const s = mod.createFileOutboxStore(join(dir, 'new', 'x.json')); s.save([]); assert.equal(JSON.parse(readFileSync(join(dir, 'new', 'x.json'), 'utf8')).version, 1);
});

test('O11 policy: BLOCKED by default, invalid values rejected, backoff with jitter bounds, the 11K proposal is TEST_ONLY and not approved', async () => {
  assert.equal(mod.DEFAULT_OUTBOX_POLICY.mode, 'BLOCKED'); const deps = rig(mod).deps;
  assert.throws(() => mod.createOutboxPublisher({ store: mod.createMemoryOutboxStore(), policy: mod.DEFAULT_OUTBOX_POLICY, deps }), /BLOCKED/);
  for (const bad of [{ capacity: 0 }, { fast: { maxAttempts: 0 } }, { fast: { backoffFactor: 0.5 } }, { fast: { jitterRatio: 2 } }, { slow: { intervalMs: 0 } }, { capacity: 1.5 }]) assert.throws(() => mod.createOutboxPublisher({ store: mod.createMemoryOutboxStore(), policy: policy(bad), deps }), /INVALID/);
  assert.equal(mod.PROPOSED_OUTBOX_POLICY.mode, 'TEST_ONLY'); assert.deepEqual([mod.PROPOSED_OUTBOX_POLICY.fast.initialDelayMs, mod.PROPOSED_OUTBOX_POLICY.fast.maxAttempts, mod.PROPOSED_OUTBOX_POLICY.slow.intervalMs], [3000, 8, 900_000]);
  for (const [rnd, lo, hi] of [[0, 75, 75], [1, 125, 125]]) { const r = rig(mod, { pol: policy({ fast: { initialDelayMs: 100, jitterRatio: 0.25 } }), publishAs: () => ({ puback: true, deliver: false }) }); r.deps.random = () => rnd; r.pub.submit({ eventId: 'o11', bytes: bytesOf('o11') }); await r.pub.tick(); const e = r.pub.get('o11'); assert.equal(e.nextAttemptAt - e.lastAttemptAt >= lo && e.nextAttemptAt - e.lastAttemptAt <= hi, true, String(e.nextAttemptAt - e.lastAttemptAt)); }
});

test('O12 gate + stats + safe transitions: the retry loop can be held; stats expose depth/oldest age; observers get no payload', async () => {
  const r = rig(mod, { publishAs: () => ({ puback: true, deliver: false }) }); r.pub.submit({ eventId: 'o12', bytes: bytesOf('o12') }); r.pub.setGate(false); assert.equal(await r.pub.tick(), 0); assert.equal(r.pub.get('o12').attempts, 0);
  r.pub.setGate(true); await r.pub.tick(); r.advance(5000); const st = r.pub.stats(); assert.equal(st.pending, 1); assert.ok(st.oldestPendingAgeMs >= 5000); assert.equal(st.byStatus.PENDING, 1);
  for (const t of r.transitions) { const j = JSON.stringify(t); assert.equal(j.includes(Buffer.from(bytesOf('o12')).toString('base64')), false); }
});

test('O13 invariants hold on the real module', async () => { assert.deepEqual(await checkOutboxInvariants(mod), []); });

test('O14 harness wiring (static): ONE connection per publisher identity, the original PUBACK is only BROKER_ACCEPTED, no shared-clientId concurrent connections', () => {
  const lib = readFileSync(new URL('../scripts/be13-11n/publisher-outbox.ts', import.meta.url), 'utf8');
  assert.match(lib, /one publisher identity = ONE MQTT connection/); assert.equal(/mqtt|createHash\('md5'/.test(lib.replace(/\/\/.*$/gm, '')), false);
});

test('O15 the EMQX campaign wiring: one connection per identity, confirmations held until the original window ends, crash/restart rebuilt from the file, evidence cross-checked against Mongo', () => {
  const h = readFileSync(new URL('../scripts/audit-be13-11f-emqx-durability.ts', import.meta.url), 'utf8');
  assert.match(h, /BE13_11N_TAG/); assert.match(h, /pubStats\.maxConcurrent <= 1/); assert.match(h, /await pub\.tick\(8\); pub\.setGate\(false\)/);
  assert.match(h, /j11n\.rebuild\(\)\.entries\(\)/); assert.match(h, /createFileOutboxStore\(path\)/); assert.match(h, /confirmedWithoutBackendEvidence/); assert.match(h, /eventsWithMoreThanOneMeasurement/);
  assert.match(h, /withLab\(\{ durable: true, flushIntervalMs: 1, writeBufferMaxItems: 1 \}/); assert.match(h, /mode: 'TEST_ONLY', capacity: 200/);
  assert.equal(/lab-device-a'.*window: 20/.test(h), false);
});
