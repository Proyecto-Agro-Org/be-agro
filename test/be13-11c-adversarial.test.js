// BE13-11C — adversarial vectors against reconciliation and the adapter boundary (OFFLINE, SINTETICO).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reconciliationSetup, createInMemoryReconciliationStore, TEST_ONLY_POLICY, delivery } from '../test-support/be13-11c-reconciliation.fixtures.js';
import { createBrokerInboxReconciler } from '../dist/src/services/broker-inbox-reconciliation.service.js';
import { bytesOf, envelope } from '../test-support/be13-11a-broker.fixtures.js';

const orphanId = async s => { await s.orphan(); s.inbox.advance(TEST_ONLY_POLICY.minAgeMs + 1000); return [...s.inbox.rows.keys()][0]; };

test('A01 forged realm: no reconciler, store call or scan can cross realms', async () => {
  const s = await reconciliationSetup();
  const id = await orphanId(s);
  for (const realm of ['production', 'preview', 'development', 'x', null, undefined]) {
    await assert.rejects(() => s.store.claim({ realm, inboxId: id, claimLeaseMs: 1 }));
    await assert.rejects(() => s.store.listCandidates({ realm, minAgeMs: 0, limit: 1 }));
    await assert.rejects(() => s.store.count({ realm, limit: 1 }));
  }
  assert.equal(s.store.states.size, 0);
});

test('A02 forged reconciliation status: only the closed API can move a state; invented ids and shapes change nothing', async () => {
  const s = await reconciliationSetup();
  const id = await orphanId(s);
  for (const bad of ['ib_x', 'ib_' + 'F'.repeat(32), '', null, {}, 7, 'q_' + 'a'.repeat(64)]) assert.equal(await s.reconciler.reconcileOne(bad), 'blocked');
  assert.equal(await s.reconciler.reconcileOne('ib_' + 'a'.repeat(32)), 'blocked'); // well-formed but no such record in this realm
  assert.equal(s.store.states.size, 0);
  assert.equal(await s.store.completeFromReceipt({ realm: 'test', inboxId: id }), false);
});

test('A03 stale token: right version with a wrong token, and right token with a wrong version, are both fenced out', async () => {
  const s = await reconciliationSetup();
  const id = await orphanId(s);
  const c = await s.store.claim({ realm: 'test', inboxId: id, claimLeaseMs: 5000 });
  assert.equal(await s.store.complete({ realm: 'test', claim: { ...c, token: 'f'.repeat(32) }, outcome: 'blocked' }), false);
  assert.equal(await s.store.complete({ realm: 'test', claim: { ...c, version: 9 }, outcome: 'blocked' }), false);
  assert.equal((await s.store.getState({ realm: 'test', inboxId: id })).status, 'claimed');
});

test('A04 direct completion without a claim creates nothing', async () => {
  const s = await reconciliationSetup();
  const id = await orphanId(s);
  assert.equal(await s.store.complete({ realm: 'test', claim: { inboxId: id, token: '0'.repeat(32), version: 1 }, outcome: 'recovered-and-processed' }), false);
  assert.equal(await s.store.completeFromReceipt({ realm: 'test', inboxId: id }), false);
  assert.equal(s.store.states.size, 0);
});

test('A05 raw tampering (bytes, context, hash) → integrity-failed, never processed', async () => {
  for (const change of [r => { r.rawPayload = bytesOf(JSON.stringify(envelope({ eventId: 'synthetic-telemetry-666' }))); }, r => { r.packetId = 9; r.receivedAt += 1; }, r => { r.rawPayloadSha256 = 'a'.repeat(64); }]) {
    const s = await reconciliationSetup();
    const id = await orphanId(s);
    change(s.inbox.rows.get(id));
    assert.equal(await s.reconciler.reconcileOne(id), 'integrity-failed');
    assert.equal(s.persistence.measurements.size, 0);
  }
});

test('A06 provenance tampering (identity, key, verification instant, revision) → integrity-failed', async () => {
  for (const change of [r => { r.verifiedAt += 1; }, r => { r.mappingRevision = 9; }, r => { r.sourceId = 'attacker-source'; }, r => { r.principalReference = 'principal:other'; }]) {
    const s = await reconciliationSetup();
    const id = await orphanId(s);
    change(s.inbox.rows.get(id));
    assert.equal(await s.reconciler.reconcileOne(id), 'integrity-failed');
    assert.equal(s.persistence.measurements.size, 0);
  }
});

test('A07 two concurrent completions: exactly one succeeds', async () => {
  const s = await reconciliationSetup();
  const id = await orphanId(s);
  const c = await s.store.claim({ realm: 'test', inboxId: id, claimLeaseMs: 5000 });
  const out = await Promise.all([s.store.complete({ realm: 'test', claim: c, outcome: 'recovered-and-processed' }), s.store.complete({ realm: 'test', claim: c, outcome: 'blocked' })]);
  assert.equal(out.filter(Boolean).length, 1);
});

test('A08 scan across realm: a preview scan over the same inbox never lists, counts or claims test records', async () => {
  const s = await reconciliationSetup();
  const id = await orphanId(s);
  const preview = createInMemoryReconciliationStore(s.inbox, 'preview');
  assert.deepEqual([(await preview.listCandidates({ realm: 'preview', minAgeMs: 0, limit: 10 })).length, (await preview.count({ realm: 'preview', limit: 10 })).absent], [0, 0]);
  assert.equal(await preview.claim({ realm: 'preview', inboxId: id, claimLeaseMs: 1 }), null);
});

test('A09 malicious store answers are never trusted', async () => {
  const hostile = [
    ['claim', { inboxId: 'ib_' + 'a'.repeat(32), token: 'f'.repeat(32), version: 1 }],   // claim for ANOTHER record
    ['claim', { token: 1 }], ['claim', 'yes'], ['claim', { inboxId: 'x', token: 'f'.repeat(32), version: 1, extra: 1 }],
  ];
  for (const [, answer] of hostile) {
    const s = await reconciliationSetup();
    const id = await orphanId(s);
    s.store.claim = async () => answer;
    assert.equal(await s.reconciler.reconcileOne(id), 'unavailable');
    assert.equal(s.persistence.measurements.size, 0);
  }
  const s = await reconciliationSetup();
  const id = await orphanId(s);
  s.store.complete = async () => 'yes';                                  // truthy but not === true
  assert.equal(await s.reconciler.reconcileOne(id), 'stale-reconciliation');
  s.store.listCandidates = async () => [{ inboxId: 'ib_zz', rawPersistedAt: 1 }];
  assert.equal((await s.reconciler.reconcileBrokerInbox({ mode: 'inspect-only', limit: 5 })).reason, 'unavailable');
  s.store.listCandidates = async () => { throw new Error('boom'); };
  assert.equal((await s.reconciler.reconcileBrokerInbox({ mode: 'reconcile', limit: 5 })).reason, 'unavailable');
  s.store.count = async () => ({ absent: -1 });
  assert.equal((await s.reconciler.reconcileBrokerInbox({ mode: 'inspect-only', limit: 5 })).reason, 'unavailable');
});

test('A10 payload never leaks into audit, metrics, alerts or reports', async () => {
  const s = await reconciliationSetup();
  await orphanId(s);
  const report = await s.reconciler.reconcileBrokerInbox({ mode: 'reconcile', limit: 5 });
  const own = s.audit.entries.filter(e => e.actorId === 'inbox-reconciler');
  assert.ok(own.length >= 3 && own.every(e => e.eventId === null && e.quarantineId === null)); // reconciliation audit carries no event id at all
  const dump = JSON.stringify([own, s.metrics.events, s.alerts.events, report]);
  for (const leak of ['temperature', 'synthetic/agro', 'synthetic-device', 'rawPayload', 'principal:synthetic', 'conn:synthetic', 'synthetic-telemetry']) assert.equal(dump.includes(leak), false, leak);
});

test('A11 adapter supplies a business clientId: refused (closed delivery) or mismatched against the authorized technical key', async () => {
  const s = await reconciliationSetup();
  assert.equal((await s.boundary.deliver(delivery({ obs: { clientId: 'business-client' } }))).reasonCode, 'broker-context-malformed');
  assert.equal((await s.boundary.deliver(delivery({ env: { clientid: 'business-client' } }))).reasonCode, 'technical-identity-mismatch');
  assert.equal(s.inbox.rows.size, 0);
});

test('A12 adapter supplies a trusted / verified flag: refused, nothing persisted', async () => {
  const s = await reconciliationSetup();
  for (const d of [delivery({ obs: { trusted: true } }), delivery({ obs: { verified: true } }), { ...delivery(), trusted: true }, { ...delivery(), verified: 'VERIFIED' }, { ...delivery(), verification: {} }])
    assert.equal((await s.boundary.deliver(d)).reasonCode, 'broker-context-malformed');
  assert.equal(s.inbox.rows.size, 0);
});

test('A13 topic-derived realm: topics naming other realms change nothing; an explicit realm field is refused', async () => {
  const s = await reconciliationSetup();
  for (const topic of ['synthetic/agro/production/telemetry', 'synthetic/agro/realm=production/x', 'synthetic/agro/preview/telemetry']) await s.boundary.deliver(delivery({ obs: { topic }, env: { eventId: 'synthetic-telemetry-' + topic.length } }));
  assert.ok([...s.inbox.rows.values()].every(r => r.realm === 'test'));
  assert.equal((await s.boundary.deliver(delivery({ obs: { realm: 'production' } }))).reasonCode, 'broker-context-malformed');
});

test('A14 fake authenticated principal: unknown or missing principals never reach the inbox', async () => {
  const s = await reconciliationSetup();
  assert.equal((await s.boundary.deliver(delivery({ obs: { authenticatedPrincipalReference: 'principal:forged' } }))).status, 'rejected');
  assert.equal((await s.boundary.deliver(delivery({ obs: { authenticatedPrincipalReference: null } }))).reasonCode, 'broker-provenance-unverified');
  assert.equal(s.inbox.rows.size, 0);
});

test('A15 packet id is never a business identity or a reconciliation key', async () => {
  const s = await reconciliationSetup();
  await s.boundary.deliver(delivery({ obs: { packetId: 5 } }));
  await s.boundary.deliver(delivery({ obs: { packetId: 5 }, env: { eventId: 'synthetic-telemetry-002' } }));
  assert.deepEqual([s.inbox.rows.size, s.persistence.measurements.size], [2, 2]);
  assert.equal(await s.reconciler.reconcileOne('5'), 'blocked');
  assert.equal(await s.reconciler.reconcileOne('ib_' + '5'.repeat(32)), 'blocked');
});

test('A16 structural: no worker, scheduler, polling, broker client, env, delete or TTL in the reconciliation code; app.ts untouched', () => {
  for (const file of ['src/services/broker-inbox-reconciliation.service.ts', 'src/repositories/mongo-broker-inbox-reconciliation.store.ts', 'src/models/broker-inbox-state.models.ts',
    'src/iot/inbox-reconciliation.contracts.ts', 'src/iot/broker-adapter.contracts.ts']) {
    const src = readFileSync(new URL('../' + file, import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
    assert.equal(/process\.env|setInterval|setTimeout|cron|mqtt:\/\/|from 'mqtt'|emqx|expireAfterSeconds|deleteOne|deleteMany|updateMany|replaceOne|while\s*\(true\)/i.test(src), false, file);
  }
  const app = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8').toLowerCase();
  for (const t of ['inbox', 'broker', 'mqtt', 'reconcil']) assert.equal(app.includes(t), false, t);
  const pkg = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  assert.equal(/"(mqtt|mqtt\.js|emqx[^"]*)"/i.test(pkg), false);
});

test('A17 the reconciler never invents authority: it cannot process a record outside the persisted bytes (no payload argument exists)', async () => {
  const s = await reconciliationSetup();
  const id = await orphanId(s);
  assert.equal(s.reconciler.reconcileOne.length, 1);
  await s.reconciler.reconcileOne(id, { payload: bytesOf(JSON.stringify(envelope({ eventId: 'synthetic-telemetry-evil' }))) });
  assert.ok([...s.persistence.measurements.values()].every(m => m.key.eventId !== 'synthetic-telemetry-evil'));
});
