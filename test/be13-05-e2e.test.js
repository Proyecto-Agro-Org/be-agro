// BE13-05 — Local end-to-end scenarios (synthetic, offline):
// ProtectedDocument → Candidate (BE13-02) → Ready (BE13-03) → TrustedEvent (BE13-04)
// → BE-12 resolution → Composition result. No EMQX, no MongoDB, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMeasurementIngestionComposition } from '../dist/src/services/measurement-ingestion-composition.service.js';
import { REALM, RECEIVED, fixture, protectedDocument, mapDocument, association, closed, device, world } from '../test-support/be13-composition.fixtures.js';

async function e2e(w, documentPatch = {}, options, field = 'temperature', extra) {
  const mapped = mapDocument(protectedDocument(documentPatch, options));
  assert.equal(mapped.status, 'candidate');
  return w.compose(extra).ingest(mapped, { field });
}

test('E2E-01 valid synthetic telemetry is accepted end to end', async () => {
  const r = await e2e(world(), { payload: { temperature: 21.5, soil_moisture: null } });
  assert.deepEqual([r.status, r.event.value, r.event.unit, r.attribution.clientId, r.persisted], ['accepted', 21.5, 'celsius', 'client-A', false]);
});

test('E2E-02 unknown device is quarantined at the trust gate', async () => {
  const r = await e2e(world({ devices: [] }));
  assert.deepEqual([r.reason, r.cause], ['trust-gate-rejected', 'unresolved-device']);
});

test('E2E-03 historical association: ownership at the event instant, not today', async () => {
  const w = world({ history: [closed({ id: 'old', clientId: 'client-old', validTo: RECEIVED + 1 }),
    association({ id: 'now', clientId: 'client-now', validFrom: RECEIVED + 1 })] });
  const r = await e2e(w);
  assert.deepEqual([r.attribution.clientId, r.attribution.associationId], ['client-old', 'old']);
});

test('E2E-04 A→B→A across three events', async () => {
  const t1 = RECEIVED + 1_000, t2 = RECEIVED + 2_000;
  const w = world({ history: [closed({ id: 'A1', validTo: t1 }), closed({ id: 'B', clientId: 'client-B', validFrom: t1, validTo: t2 }),
    association({ id: 'A2', validFrom: t2 })] });
  const owners = [];
  for (const [i, at] of [[1, RECEIVED], [2, t1 + 5], [3, t2]].map(([i, at]) => [i, at])) {
    w.state.temporal = { status: 'trusted', at, clock: 'received-at', policyRevision: 7 };
    const r = await e2e(w, { eventId: `synthetic-telemetry-00${i}`, sentAt: at - 100 }, { receivedAt: at, persistedAt: at + 10 });
    owners.push(r.attribution.clientId);
  }
  assert.deepEqual(owners, ['client-A', 'client-B', 'client-A']);
});

test('E2E-05 exact retry of the same protected event is a duplicate', async () => {
  const w = world();
  assert.equal((await e2e(w)).status, 'accepted');
  assert.equal((await e2e(w, {}, { receivedAt: RECEIVED + 60_000, persistedAt: RECEIVED + 60_010 })).status, 'duplicate');
});

test('E2E-06 replay with altered payload under the same eventId conflicts', async () => {
  const w = world(); await e2e(w);
  const r = await e2e(w, { payload: { temperature: 99, soil_moisture: null } });
  assert.equal(r.reason, 'idempotency-conflict');
  const altered = await e2e(w, { deviceTimestamp: 1795115595001 });
  assert.equal(altered.reason, 'idempotency-conflict', 'declared device clock is part of the technical fingerprint');
});

test('E2E-07 realm crossing: rows, idempotency and BE-12 from another realm are rejected', async () => {
  const foreignRows = world({ devices: [device({ realm: 'production' })], history: [association({ realm: 'production' })] });
  assert.equal((await e2e(foreignRows)).cause, 'unresolved-device');
  const leaky = world();
  const leakStore = { findDevicesByKey: async q => ({ realm: q.realm, rows: [device({ realm: 'production' })] }),
    findAssociationsAt: leaky.deps.identityStore.findAssociationsAt.bind(leaky.deps.identityStore) };
  assert.deepEqual([(await e2e(leaky, {}, undefined, 'temperature', { identityStore: leakStore })).cause], ['realm-mismatch']);
  const idem = world();
  const r = await e2e(idem, {}, undefined, 'temperature', { idempotency: { lookup: async () => ({ realm: 'production', status: 'absent' }), claim: async () => ({}) } });
  assert.deepEqual([r.reason, r.cause], ['realm-mismatch', 'idempotency']);
  const be12 = world();
  const viaBe12 = await e2e(be12, {}, undefined, 'temperature', { be12: { resolve: async e => ({ ...(await be12.deps.be12.resolve(e)), realm: 'production' }) } });
  assert.deepEqual([viaBe12.reason, viaBe12.cause], ['realm-mismatch', 'be12']);
  assert.throws(() => createMeasurementIngestionComposition({ ...world().deps, realmContext: undefined }), TypeError);
});

test('E2E-08 attribution drift between BE13-04 and BE-12 is quarantined and never claimed', async () => {
  const w = world();
  const be12 = { resolve: async e => { w.state.history = [association({ clientId: 'client-intruder' })]; return w.deps.be12.resolve(e); } };
  const r = await e2e(w, {}, undefined, 'temperature', { be12 });
  assert.deepEqual([r.reason, r.cause], ['attribution-drift', 'clientId']);
  assert.equal(w.idempotency.entries.size, 0);
});

test('E2E-09 null end to end', async () => {
  const r = await e2e(world(), {}, undefined, 'soil_moisture');
  assert.deepEqual([r.status, r.event.value, r.event.missingReason], ['accepted', null, 'absent']);
});

test('E2E-10 zero end to end', async () => {
  const r = await e2e(world());
  assert.deepEqual([r.status, Object.is(r.event.value, 0), r.event.missingReason, r.attribution.realm], ['accepted', true, null, REALM]);
  assert.equal(fixture('F01').payload.temperature, 0);
});
