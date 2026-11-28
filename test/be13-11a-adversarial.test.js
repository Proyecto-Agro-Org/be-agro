// BE13-11A — adversarial vectors against the broker provenance boundary (OFFLINE, SINTETICO).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { boundarySetup, delivery, envelope, bytesOf, PRINCIPAL, KEY } from '../test-support/be13-11a-broker.fixtures.js';

const measurementsOf = s => [...s.persistence.measurements.values()];
const verified = (patch = {}) => r => ({ status: 'VERIFIED', realm: r.realm, principalReference: PRINCIPAL, contextFingerprint: r.contextFingerprint, authentication: 'broker-confirmed',
  verifiedAt: 1, verifierRevision: 1, ...patch });

test('A01 forged realm in the payload: the closed envelope rejects it; the verifier only ever sees the bootstrap realm', async () => {
  const s = await boundarySetup();
  assert.equal((await s.boundary.deliver(delivery({ env: { realm: 'production' } }))).reasonCode, 'payload-malformed');
  await s.boundary.deliver(delivery());
  assert.ok(s.verifier.calls.every(c => c.realm === 'test'));
});

test('A02 forged realm in the topic: routing only — realm and ownership unchanged', async () => {
  const s = await boundarySetup();
  const r = await s.boundary.deliver(delivery({ obs: { topic: 'synthetic/agro/production/client-B/telemetry' } }));
  assert.equal(r.results[0].result.status, 'accepted');
  const [m] = measurementsOf(s);
  assert.deepEqual([m.key.realm, m.attribution.realm, m.attribution.clientId], ['test', 'test', 'client-A']);
});

test('A03 forged business clientId: payload aliases must equal the authorized technical key; top-level aliases are not part of the envelope', async () => {
  const s = await boundarySetup();
  assert.equal((await s.boundary.deliver(delivery({ env: { payload: { temperature: 1, client_id: 'client-B' } } }))).reasonCode, 'technical-identity-mismatch');
  assert.equal((await s.boundary.deliver(delivery({ env: { clientId: 'client-B' } }))).reasonCode, 'payload-malformed');
  assert.equal(measurementsOf(s).length, 0);
});

test('A04 forged sourceId: never accepted from the payload; the persisted sourceId comes from the identity mapping', async () => {
  const s = await boundarySetup();
  assert.equal((await s.boundary.deliver(delivery({ env: { sourceId: 'attacker-source' } }))).reasonCode, 'payload-malformed');
  await s.boundary.deliver(delivery({ env: { payload: { temperature: 1, source_id: 'attacker-source' } } }));
  assert.ok(measurementsOf(s).every(m => m.key.sourceId === 'synthetic-ingest'));
});

test('A05 forged technical key: a device claiming another key, or a connection using one not mapped to its principal, is rejected', async () => {
  const s = await boundarySetup();
  assert.equal((await s.boundary.deliver(delivery({ env: { clientid: 'synthetic-device-007' } }))).reasonCode, 'technical-identity-mismatch');
  assert.equal((await s.boundary.deliver(delivery({ obs: { mqttClientId: 'synthetic-device-007' }, env: { clientid: 'synthetic-device-007' } }))).reasonCode, 'technical-identity-mismatch');
});

test('A06 forged verification revision / timestamps: anything but a non-negative integer is a malformed answer', async () => {
  for (const patch of [{ verifierRevision: -1 }, { verifierRevision: '1' }, { verifierRevision: 1.5 }, { verifiedAt: -5 }, { verifiedAt: 'now' }]) {
    const s = await boundarySetup({ verifierMode: { kind: 'answer', answer: verified(patch) } });
    assert.equal((await s.boundary.deliver(delivery())).reasonCode, 'invalid-authority-response', JSON.stringify(patch));
  }
});

test('A07 malicious verifier getter: a throwing getter in the answer is a malformed answer, never a crash or an acceptance', async () => {
  const s = await boundarySetup({ verifierMode: { kind: 'answer', answer: r => ({ ...verified()(r), get status() { throw new Error('hostile'); } }) } });
  assert.equal((await s.boundary.deliver(delivery())).reasonCode, 'invalid-authority-response');
  const m = await boundarySetup({ mappingMode: { kind: 'answer', answer: { get status() { throw new Error('hostile'); } } } });
  assert.equal((await m.boundary.deliver(delivery())).reasonCode, 'invalid-authority-response');
});

test('A08 mutable verifier/mapping answers: later mutation of the returned objects changes nothing already decided', async () => {
  const shared = { status: 'mapped', realm: 'test', principalReference: PRINCIPAL, sourceId: 'synthetic-ingest', technicalDeviceKey: { kind: 'mqtt-clientid', value: KEY }, mappingRevision: 1 };
  const s = await boundarySetup({ mappingMode: { kind: 'answer', answer: shared } });
  const r = await s.boundary.deliver(delivery());
  shared.sourceId = 'attacker-source'; shared.technicalDeviceKey.value = 'synthetic-device-666'; shared.mappingRevision = 999;
  assert.deepEqual([r.provenance.sourceId, r.provenance.mappingRevision], ['synthetic-ingest', 1]);
  assert.ok(measurementsOf(s).every(m => m.key.sourceId === 'synthetic-ingest'));
  // The injected config is snapshotted at construction: mutating it later changes nothing.
  const cfg = { topicRoutes: [{ prefix: 'synthetic/agro/', messageType: 'telemetry' }], retained: 'block', fields: ['temperature'], verifierTimeoutMs: 50, auditVerifiedDeliveries: false };
  const c = await boundarySetup({ extra: { boundaryConfig: cfg } });
  cfg.retained = 'accept'; cfg.topicRoutes.push({ prefix: '', messageType: 'telemetry' });
  assert.equal((await c.boundary.deliver(delivery({ obs: { retain: true } }))).reasonCode, 'retained-message-blocked');
});

test('A09 prototype pollution attempts at every level are rejected and pollute nothing', async () => {
  const s = await boundarySetup();
  for (const text of ['{"__proto__":{"isAdmin":true}}', '{"a":{"b":{"__proto__":{"isAdmin":true}}}}', '{"constructor":{"prototype":{"isAdmin":true}}}', '[{"__proto__":1}]'])
    assert.ok(['payload-dangerous-key', 'payload-malformed'].includes((await s.boundary.deliver(delivery({ payload: bytesOf(text) }))).reasonCode));
  assert.equal(({}).isAdmin, undefined);
});

test('A10 payload bomb: exactly maxBytes is measured, maxBytes + 1 is rejected unread; deep nesting cannot exhaust the stack', async () => {
  const s = await boundarySetup();
  assert.equal((await s.boundary.deliver(delivery({ payload: Buffer.alloc(4096, 0x20) }))).reasonCode, 'payload-malformed');
  assert.equal((await s.boundary.deliver(delivery({ payload: Buffer.alloc(4097, 0x20) }))).reasonCode, 'payload-too-large');
  const nested = await boundarySetup({ extra: { payloadLimits: { maxBytes: 200_000, maxDepth: 8, maxKeys: 64, maxStringLength: 256 } } });
  assert.equal((await nested.boundary.deliver(delivery({ payload: bytesOf('['.repeat(50_000) + ']'.repeat(50_000)) }))).reasonCode, 'payload-malformed');
  assert.equal((await nested.boundary.deliver(delivery({ payload: bytesOf('{"a":' + '['.repeat(5_000) + ']'.repeat(5_000) + '}') }))).reasonCode, 'payload-limits-exceeded');
});

test('A11 retained replay of an already ingested event is blocked; no second measurement', async () => {
  const s = await boundarySetup();
  await s.boundary.deliver(delivery());
  assert.equal((await s.boundary.deliver(delivery({ obs: { retain: true, packetId: null } }))).reasonCode, 'retained-message-blocked');
  assert.equal(measurementsOf(s).length, 1);
});

test('A12 duplicate packet ids across concurrent deliveries of distinct events do not merge them', async () => {
  const s = await boundarySetup();
  const out = await Promise.all(['a', 'b', 'c'].map(x => s.boundary.deliver(delivery({ obs: { packetId: 42 }, env: { eventId: 'synthetic-telemetry-' + x } }))));
  assert.ok(out.every(r => r.results[0].result.status === 'accepted'));
  assert.equal(s.persistence.claims.size, 3);
});

test('A13 fake "authenticated" claims: payload or context flags cannot replace the broker-reported principal', async () => {
  const s = await boundarySetup();
  assert.equal((await s.boundary.deliver(delivery({ obs: { authenticatedPrincipalReference: null, authenticated: true } }))).reasonCode, 'broker-context-malformed');
  assert.equal((await s.boundary.deliver(delivery({ obs: { authenticatedPrincipalReference: null }, env: { authenticated: true } }))).reasonCode, 'payload-malformed');
  assert.equal((await s.boundary.deliver(delivery({ obs: { authenticatedPrincipalReference: null } }))).reasonCode, 'broker-provenance-unverified');
});

test('A14 raw secret leak attempt: nothing from the payload reaches audit, metrics, alerts or results (fingerprint only)', async () => {
  const s = await boundarySetup({ verifierMode: { kind: 'reject' } });
  const secret = 'pw-SYNTHETIC-NOT-A-SECRET-123';
  const results = [await s.boundary.deliver(delivery({ env: { payload: { temperature: 1, note: secret } } })), await s.boundary.deliver(delivery({ payload: bytesOf('{"password":"' + secret + '"') })),
    await s.boundary.deliver(delivery({ env: { password: secret } }))];
  const text = JSON.stringify([results, s.audit.entries, s.metrics.events, s.alerts.events]);
  assert.equal(text.includes(secret), false);
  assert.ok(results.every(r => r.payloadFingerprint === null || /^[0-9a-f]{64}$/.test(r.payloadFingerprint)));
});

test('A15 malformed broker context: every malformed observed fact is rejected before any parsing or verification', async () => {
  const s = await boundarySetup();
  const bad = [{ qos: 3 }, { retain: 'yes' }, { packetId: 0 }, { packetId: 70_000 }, { receivedAt: -1 }, { rawPersistedAt: 1 }, { topic: 'synthetic/agro/#' },
    { topic: '' }, { mqttClientId: 'has space' }, { connectionReference: '' }, { authenticatedPrincipalReference: 'x'.repeat(200) }];
  for (const obs of bad) assert.equal((await s.boundary.deliver(delivery({ obs }))).reasonCode, 'broker-context-malformed', JSON.stringify(obs));
  for (const payload of ['{"version":1}', [1, 2], new ArrayBuffer(4), null]) assert.equal((await s.boundary.deliver({ ...delivery(), payload })).reasonCode, 'broker-context-malformed');
  for (const raw of [null, 'delivery', [], { brokerObserved: null, payload: bytesOf('{}') }, { get brokerObserved() { throw new Error('hostile'); }, payload: bytesOf('{}') }])
    assert.equal((await s.boundary.deliver(raw)).reasonCode, 'broker-context-malformed');
  assert.equal(s.verifier.calls.length, 0);
});

test('A16 no broker connection, network, credentials, timers-as-workers or env reads in the boundary code; app.ts mounts nothing', () => {
  for (const file of ['src/services/mqtt-ingestion-boundary.service.ts', 'src/iot/broker-payload.parser.ts', 'src/iot/mqtt-ingestion-boundary.contracts.ts']) {
    const src = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    assert.equal(/process\.env|mqtt:\/\/|mqtts:\/\/|wss?:\/\/|from 'mqtt'|emqx|net\.connect|tls\.connect|setInterval|subscribe\(|password\s*[:=]/i.test(src.replace(/\/\/.*$/gm, '')), false, file);
  }
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  // BE13-11D authorized exactly ONE MQTT client library (lab adapter only); the boundary code above stays free of any broker client.
  assert.deepEqual(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter(d => /mqtt|emqx/i.test(d)), ['mqtt']);
  const app = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8');
  for (const t of ['mqtt', 'broker', 'boundary', 'emqx']) assert.equal(app.toLowerCase().includes(t), false, t);
});
