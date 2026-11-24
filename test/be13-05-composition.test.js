// BE13-05 — Composition BE13-02 → BE13-03 → BE13-04 → BE-12 (offline).
// Every authority, policy, store and idempotency port here is an EXPLICIT
// SYNTHETIC DOUBLE (see test-support/be13-composition.fixtures.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMeasurementIngestionComposition } from '../dist/src/services/measurement-ingestion-composition.service.js';
import { trustedMeasurementEventSchema } from '../dist/src/measurements/schemas.js';
import { REALM, RECEIVED, candidate, association, closed, device, world, deepFrozen, objectsOf } from '../test-support/be13-composition.fixtures.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ingest = (w, c = candidate(), field = 'temperature', extra) => w.compose(extra).ingest(c, { field });
// Mutates the shared store after BE13-03/BE13-04 finished, right before BE-12 resolves.
const driftBeforeBe12 = (w, mutate) => ({ be12: { resolve: async event => { mutate(w.state); return w.deps.be12.resolve(event); } } });

test('BE13-05 #1 a non-issued candidate is quarantined before any dependency', async () => {
  const w = world(), c = candidate();
  for (const fake of [structuredClone(c), { ...c }, null, {}]) {
    assert.deepEqual(await w.compose().ingest(fake, { field: 'temperature' }), { status: 'quarantined', reason: 'invalid-candidate', cause: null, eventId: null });
  }
  assert.equal(w.calls.length, 0);
});

test('BE13-05 #2 trust gate rejection is reported with its closed cause', async () => {
  const r = await ingest(world({ devices: [] }));
  assert.deepEqual([r.status, r.reason, r.cause], ['quarantined', 'trust-gate-rejected', 'unresolved-device']);
});

test('BE13-05 #3 builder rejection (blocking policy) is reported with its closed cause', async () => {
  const w = world(); w.state.policies.clock = () => ({ status: 'blocked' });
  const r = await ingest(w);
  assert.deepEqual([r.reason, r.cause], ['builder-rejected', 'unresolved-clock']);
});

test('BE13-05 #4 correct realm: accepted, not persisted', async () => {
  const r = await ingest(world());
  assert.deepEqual([r.status, r.attribution.realm, r.persisted], ['accepted', REALM, false]);
});

test('BE13-05 #5 rows from another realm are never resolved', async () => {
  const w = world({ devices: [device({ realm: 'production' })], history: [association({ realm: 'production' })] });
  assert.deepEqual([(await ingest(w)).reason, (await ingest(w)).cause], ['trust-gate-rejected', 'unresolved-device']);
  assert.throws(() => createMeasurementIngestionComposition({ ...world().deps, realmContext: { realm: 'tenant-a' } }), TypeError);
});

test('BE13-05 #6 BE13 attribution equals BE-12 attribution → accepted', async () => {
  const r = await ingest(world());
  assert.deepEqual([r.attribution.clientId, r.attribution.sensorId, r.attribution.associationId, r.attribution.attributedAt], ['client-A', 'sensor-A', 'assoc-A', RECEIVED]);
  assert.equal(trustedMeasurementEventSchema.safeParse(r.event).success, true);
});

test('BE13-05 #7 BE-12 resolving a different window is attribution drift', async () => {
  const w = world();
  const r = await ingest(w, candidate(), 'temperature', driftBeforeBe12(w, s => { s.history = [association({ id: 'assoc-X', revision: 9 })]; }));
  assert.deepEqual([r.reason, r.cause], ['attribution-drift', 'associationId']);
});

for (const [n, field, value] of [[8, 'clientId', 'client-Z'], [9, 'sensorId', 'sensor-Z'], [11, 'fieldId', 'field-Z'], [12, 'areaId', 'area-Z']]) {
  test(`BE13-05 #${n} ${field} drift between BE13-04 and BE-12 is quarantined`, async () => {
    const w = world();
    const r = await ingest(w, candidate(), 'temperature', driftBeforeBe12(w, s => { s.history = [association({ [field]: value })]; }));
    assert.deepEqual([r.status, r.reason, r.cause], ['quarantined', 'attribution-drift', field]);
  });
}

test('BE13-05 #10 physicalDeviceId drift is quarantined', async () => {
  const w = world();
  const r = await ingest(w, candidate(), 'temperature', driftBeforeBe12(w, s => {
    s.devices = [device({ id: 'device-2' })]; s.history = [association({ physicalDeviceId: 'device-2' })];
  }));
  assert.deepEqual([r.reason, r.cause], ['attribution-drift', 'physicalDeviceId']);
});

test('BE13-05 #13 first event is accepted and claims its key', async () => {
  const w = world(), r = await ingest(w);
  assert.equal(r.status, 'accepted');
  assert.equal(w.idempotency.entries.size, 1);
  assert.deepEqual(r.idempotency.key, { realm: REALM, sourceId: 'synthetic-ingest', operation: 'measurement', eventId: 'synthetic-telemetry-001', field: 'temperature' });
});

test('BE13-05 #14 exact retry (different reception instant) is a duplicate', async () => {
  const w = world(); await ingest(w);
  const authorityCalls = () => w.calls.filter(([n]) => !n.startsWith('idem:')).length;
  const before = authorityCalls();
  const retry = candidate({}, { receivedAt: RECEIVED + 5_000, persistedAt: RECEIVED + 5_010 });
  const r = await ingest(w, retry);
  assert.deepEqual([r.status, r.eventId], ['duplicate', 'synthetic-telemetry-001']);
  assert.ok(before > 0);
  assert.equal(authorityCalls(), before, 'a known retry does not re-run gate, builder or BE-12');
});

test('BE13-05 #15 same eventId with different payload is an idempotency conflict', async () => {
  const w = world(); await ingest(w);
  assert.equal((await ingest(w, candidate({ payload: { temperature: 1, soil_moisture: null } }))).reason, 'idempotency-conflict');
});

test('BE13-05 #16 same eventId in another realm is independent and never leaks', async () => {
  const w = world(); await ingest(w);
  const other = world({ devices: [device({ realm: 'preview' })], history: [association({ realm: 'preview' })] });
  other.idempotency.entries.clear();
  for (const [k, v] of w.idempotency.entries) other.idempotency.entries.set(k, v);
  const preview = await createMeasurementIngestionComposition({ ...other.deps, realmContext: { realm: 'preview' },
    be12: { resolve: async e => ({ ...(await w.deps.be12.resolve(e)), realm: 'preview' }) } }).ingest(candidate(), { field: 'temperature' });
  assert.notEqual(preview.status, 'duplicate', 'a key from realm test must not answer for realm preview');
});

test('BE13-05 #17 same eventId from another source is a different key', async () => {
  const w = world({ devices: [device(), device({ id: 'device-9', sourceId: 'other-source' })],
    history: [association(), association({ id: 'assoc-9', physicalDeviceId: 'device-9', sourceId: 'other-source' })] });
  assert.equal((await ingest(w)).status, 'accepted');
  const r = await ingest(w, candidate({ sourceId: 'other-source' }));
  assert.equal(r.status, 'accepted');
  assert.equal(w.idempotency.entries.size, 2);
});

test('BE13-05 #18 null with an approved missing reason is accepted as null', async () => {
  const r = await ingest(world(), candidate(), 'soil_moisture');
  assert.deepEqual([r.status, r.event.value, r.event.missingReason], ['accepted', null, 'absent']);
});

test('BE13-05 #19 zero is accepted as zero', async () => {
  const r = await ingest(world());
  assert.deepEqual([r.status, Object.is(r.event.value, 0), r.event.missingReason], ['accepted', true, null]);
});

test('BE13-05 #20 a missing field is never turned into a measurement', async () => {
  const w = world(), r = await ingest(w, candidate(), 'humidity');
  assert.deepEqual([r.reason, r.cause], ['trust-gate-rejected', 'absent-field']);
  assert.equal(w.idempotency.entries.size, 0, 'a rejected event never consumes its key');
});

test('BE13-05 #21 A→B: an event before the boundary belongs to A even though the device is B today', async () => {
  const w = world({ history: [closed({ id: 'A', validTo: RECEIVED + 1 }), association({ id: 'B', clientId: 'client-B', validFrom: RECEIVED + 1 })] });
  const r = await ingest(w);
  assert.deepEqual([r.attribution.clientId, r.attribution.associationId], ['client-A', 'A']);
});

test('BE13-05 #22 A→B→A: an event inside the B window belongs to B', async () => {
  const w = world({ history: [closed({ id: 'A1', validTo: RECEIVED - 10 }), closed({ id: 'B', clientId: 'client-B', validFrom: RECEIVED - 10, validTo: RECEIVED + 10 }),
    association({ id: 'A2', validFrom: RECEIVED + 10 })] });
  assert.deepEqual([(await ingest(w)).attribution.clientId], ['client-B']);
});

test('BE13-05 #23 association changed between gate and builder → builder stale-association', async () => {
  const w = world(); let n = 0; const store = w.deps.identityStore, original = store.findAssociationsAt.bind(store);
  const identityStore = { findDevicesByKey: store.findDevicesByKey.bind(store),
    async findAssociationsAt(q) { n++; const out = await original(q); if (n > 2) out.rows = out.rows.map(r => ({ ...r, revision: r.revision + 1 })); return out; } };
  const r = await ingest(w, candidate(), 'temperature', { identityStore });
  assert.deepEqual([r.reason, r.cause], ['builder-rejected', 'stale-association']);
});

test('BE13-05 #24 device changed between gate and builder → builder stale-device', async () => {
  const w = world(); let n = 0; const store = w.deps.identityStore, original = store.findDevicesByKey.bind(store);
  const identityStore = { findAssociationsAt: store.findAssociationsAt.bind(store),
    async findDevicesByKey(q) { n++; const out = await original(q); if (n > 2) out.rows = out.rows.map(r => ({ ...r, version: r.version + 1 })); return out; } };
  const r = await ingest(w, candidate(), 'temperature', { identityStore });
  assert.deepEqual([r.reason, r.cause], ['builder-rejected', 'stale-device']);
});

test('BE13-05 #25 throwing dependencies are contained', async () => {
  const w = world();
  assert.deepEqual([(await ingest(w, candidate(), 'temperature', { be12: { resolve: async () => { throw new Error('mongodb://u:p@h'); } } })).reason], ['dependency-error']);
  const r = await ingest(w, candidate(), 'temperature', { idempotency: { lookup: async () => { throw new Error('x'); }, claim: async () => ({}) } });
  assert.deepEqual([r.reason, JSON.stringify(r).includes('x')], ['idempotency-unavailable', false]);
  const store = await ingest(w, candidate(), 'temperature', { identityStore: { findDevicesByKey: async () => { throw new Error('secret'); }, findAssociationsAt: async () => ({}) } });
  assert.deepEqual([store.reason, store.cause], ['trust-gate-rejected', 'dependency-error']);
});

test('BE13-05 #26 malformed responses are contained', async () => {
  const w = world();
  assert.equal((await ingest(w, candidate(), 'temperature', { be12: { resolve: async () => ({ status: 'verified' }) } })).reason, 'dependency-error');
  assert.equal((await ingest(w, candidate(), 'temperature', { idempotency: { lookup: async k => ({ realm: k.realm, status: 'maybe' }), claim: async () => ({}) } })).reason,
    'idempotency-unavailable');
  const bad = await ingest(w, candidate(), 'temperature', { identityStore: { findDevicesByKey: async q => ({ realm: q.realm, rows: [{ ...device(), extra: 1 }] }),
    findAssociationsAt: async () => ({}) } });
  assert.deepEqual([bad.reason, bad.cause], ['trust-gate-rejected', 'dependency-error']);
});

test('BE13-05 #27 deterministic: same inputs and fresh stores → identical results', async () => {
  const c = candidate();
  assert.deepEqual(await ingest(world(), c), await ingest(world(), c));
});

test('BE13-05 #28 immutable output with no shared references to inputs or dependency calls', async () => {
  const w = world(), c = candidate(), before = structuredClone(c);
  const seen = []; const be12 = { resolve: async e => { seen.push(e); return w.deps.be12.resolve(e); } };
  const r = await ingest(w, c, 'temperature', { be12 });
  assert.equal(deepFrozen(r), true);
  assert.deepEqual(structuredClone(c), before);
  const theirs = new Set([...objectsOf(c), ...seen.flatMap(e => [...objectsOf(e)]), ...w.calls.flatMap(([, q]) => [...objectsOf(q)])]);
  for (const object of objectsOf(r)) assert.equal(theirs.has(object), false);
});

test('BE13-05 #29 the composition is not exposed by app or routes', () => {
  const sources = [readFileSync(join(root, 'src', 'app.ts'), 'utf8'),
    ...readdirSync(join(root, 'src', 'routes')).map(f => readFileSync(join(root, 'src', 'routes', f), 'utf8'))];
  for (const text of sources) for (const token of ['measurement-ingestion-composition', 'trusted-event-builder', 'attribution-trust-gate', 'ingestion-identity'])
    assert.equal(text.includes(token), false, token);
});

test('BE13-05 #30 composition modules perform no external IO, clock or randomness', () => {
  const files = ['services/measurement-ingestion-composition.service.ts', 'adapters/ingestion-identity.adapters.ts', 'adapters/ingestion-idempotency-blocking.adapter.ts',
    'iot/ingestion-event-fingerprint.ts', 'iot/ingestion-composition.contracts.ts', 'iot/ingestion-composition.schemas.ts', 'services/authority-call.ts',
    'services/trusted-event-builder.service.ts', 'services/attribution-trust-gate.service.ts'];
  for (const file of files) {
    const text = readFileSync(join(root, 'src', file), 'utf8');
    for (const forbidden of ["from 'mongoose'", "from 'express'", 'node:http', 'node:net', 'node:fs', 'node:child_process', 'process.env', 'Date.now', 'Math.random', 'fetch(', 'new Date(']) {
      assert.equal(text.includes(forbidden), false, `${file}: ${forbidden}`);
    }
  }
});
