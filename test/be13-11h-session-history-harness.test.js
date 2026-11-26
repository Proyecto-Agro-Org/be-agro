// BE13-11H — offline guards: the reproduction harness records the session state before D13b and tags its evidence per variant.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../scripts/audit-be13-11f-emqx-durability.ts', import.meta.url), 'utf8');

test('H1: D13b takes a session snapshot (clientId, sessionPresent, broker counters) before closing the first consumer', () => {
  assert.match(src, /const snapshotBefore = await sessionSnapshot\(first\); await first\.close\(true\)/);
  for (const field of ['sessionPresent', 'clientId', 'brokerRestartsSoFar', 'rawConsumerOpensSoFar', 'inflight_cnt', 'mqueue_len', 'clean_start', 'expiry_interval']) assert.ok(src.includes(field), field);
});

test('H2: the variant evidence is tagged and carries the stale breakdown', () => {
  assert.match(src, /BE13_11H_TAG/);
  assert.match(src, /staleByScenario/);
});

test('H3: the 11H harness does not alter the broker configuration knobs', () => {
  assert.match(src, /withLab\(\{ durable: true, flushIntervalMs: 1, writeBufferMaxItems: 1 \}/);
  assert.match(src, /sessionExpirySeconds: 3600/);
});
