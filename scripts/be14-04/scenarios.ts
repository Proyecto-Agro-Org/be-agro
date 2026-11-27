// BE14-04 — scenarios S1–S6 (declarative). They assert on what the OBSERVER saw and on the world's evidence, never on publisher internals other than the black-box outbox view.
import { check, ConformanceFailure } from '../be14-03/catalog.js';
import type { Scenario, ScenarioCtx } from './scenario.js';

const allConfirmed = (c: ScenarioCtx, ids: string[]) => async () => { for (const id of ids) if ((await c.state(id)) !== 'confirmed') return false; return true; };
const seen = (c: ScenarioCtx, id: string) => c.obs.publishRecords().filter(p => p.eventId === id);

export const SCENARIOS: Scenario[] = [
  { id: 'S1', title: 'normal: connect, publish, confirm', needsFaults: [],
    async run(c) { const ids = await c.create(3);
      await c.until(() => c.obs.connections().opens >= 1, { timeoutMs: 8000, what: 'the publisher connection', code: 'MQTT_CONNECTION_NOT_SEEN' });
      await c.until(() => ids.every(id => seen(c, id).length >= 1), { timeoutMs: 10000, what: 'the publishes on the broker', code: 'MQTT_PUBLISH_NOT_SEEN' });
      await c.until(allConfirmed(c, ids), { timeoutMs: 10000, what: 'confirmation', code: 'RECOVERY_TIMEOUT' as never });
      const pend = await c.a.inspectPending(); for (const id of ids) { const p = pend.find(e => e.eventId === id)!; check(seen(c, id).every(r => r.sha === p.payloadSha256), 'MQTT_HASH_CHANGED', 'observed bytes do not match the owned hash', id); }
      check(c.obs.connectRecords().every(r => r.clientId === c.technicalKey), 'MQTT_CLIENT_ID_COLLISION', 'a connection used a clientId other than the technical identity');
      check(c.w.measurementTotal() === 3, 'DUPLICATE_OR_LOST', 'expected exactly 3 measurements', c.w.measurementTotal()); return { events: ids.length, connections: c.obs.connections() }; } },
  { id: 'S2', title: 'broker down while events are created; same ids/bytes after recovery', needsFaults: ['brokerDown', 'brokerUp'],
    async run(c) { await c.create(1); await c.until(() => c.obs.connections().opens >= 1, { timeoutMs: 8000, what: 'the first connection', code: 'MQTT_CONNECTION_NOT_SEEN' });
      await c.faults.brokerDown(); const ids = await c.create(2); await c.a.advance(2500);
      for (const id of ids) check((await c.state(id)) !== 'confirmed', 'CONFIRMED_WITHOUT_BROKER', 'confirmed while the broker was down', id);
      const before = new Map((await c.a.inspectPending()).map(e => [e.eventId, e.payloadSha256]));
      await c.faults.brokerUp(); const all = c.eventIds; await c.until(allConfirmed(c, all), { timeoutMs: 20000, what: 'convergence after the broker recovered', code: 'MQTT_TIMEOUT' });
      for (const id of ids) check(before.get(id) === (await c.a.inspectPending()).find(e => e.eventId === id)?.payloadSha256 && seen(c, id).every(r => r.sha === before.get(id)), 'MQTT_RETRY_BYTES_CHANGED', 'bytes changed across the outage', id);
      check(c.w.measurementTotal() === all.length, 'DUPLICATE_OR_LOST', 'measurements != events', c.w.measurementTotal()); return { events: all.length, recoveryMs: c.faults.log().find(f => f.fault === 'brokerUp')?.recoveryMs }; } },
  { id: 'S3', title: 'broker kicks the client: reconnect with the SAME clientId, never two connections', needsFaults: ['disconnectClient'],
    async run(c) { const first = await c.create(2); await c.until(allConfirmed(c, first), { timeoutMs: 12000, what: 'first confirmations', code: 'MQTT_TIMEOUT' });
      await c.faults.disconnectClient(c.technicalKey); const more = await c.create(2); await c.until(allConfirmed(c, more), { timeoutMs: 20000, what: 'confirmation after reconnect', code: 'MQTT_TIMEOUT' });
      const k = c.obs.connections(); check(k.opens >= 2, 'MQTT_CONNECTION_NOT_SEEN', 'no reconnect was observed after the kick', k); check(k.maxConcurrent <= 1 && k.collisions === 0, 'MQTT_CLIENT_ID_COLLISION', 'two connections for one identity', k);
      check(c.obs.connectRecords().every(r => r.clientId === c.technicalKey), 'MQTT_CLIENT_ID_COLLISION', 'reconnected with another clientId'); return { connections: k }; } },
  { id: 'S4', title: 'reconciliation API down: broker accepted but unconfirmed, converges after recovery without new ids', needsFaults: ['reconciliationDown', 'reconciliationUp'],
    async run(c) { await c.faults.reconciliationDown(); const ids = await c.create(2); await c.until(() => ids.every(id => seen(c, id).length >= 1), { timeoutMs: 10000, what: 'the publishes', code: 'MQTT_PUBLISH_NOT_SEEN' }); await c.a.advance(1500);
      for (const id of ids) check((await c.state(id)) !== 'confirmed', 'CONFIRMED_WITHOUT_ANSWER', 'confirmed while the reconciliation API was down', id);
      await c.faults.reconciliationUp(); await c.until(allConfirmed(c, ids), { timeoutMs: 25000, what: 'convergence after the API recovered', code: 'MQTT_TIMEOUT' });
      check(c.w.measurementTotal() === 2 && c.eventIds.length === 2, 'DUPLICATE_OR_LOST', 'duplicates or new ids appeared', c.w.measurementTotal()); return { recoveryMs: c.faults.log().find(f => f.fault === 'reconciliationUp')?.recoveryMs }; } },
  { id: 'S5', title: 'HTTP 429 + Retry-After: never success, converges afterwards', needsFaults: ['injectHttpStatus'],
    async run(c) { await c.faults.injectHttpStatus(429, 2); const [id] = await c.create(1); await c.a.advance(1500); check((await c.state(id!)) !== 'confirmed', 'CONFIRMED_ON_429', '429 treated as success');
      await c.faults.injectHttpStatus('normal'); await c.until(allConfirmed(c, [id!]), { timeoutMs: 20000, what: 'convergence after 429', code: 'MQTT_TIMEOUT' }); return { requests429: c.w.requests.filter(r => r.mode === '429').length }; } },
  { id: 'S6', title: 'NEGATIVE: a retry of the same eventId with DIFFERENT bytes must be detected as MQTT_RETRY_BYTES_CHANGED', needsFaults: [], negative: true,
    async run(c) { const rogue = c.rogue; if (!rogue) throw new ConformanceFailure('FAULT_CAPABILITY_REQUIRED', 'S6 needs a rogue publisher channel');
      const mk = (t: number) => Buffer.from(JSON.stringify({ version: 1, eventId: c.technicalKey + ':s6', sentAt: 1795115600000, clientid: c.technicalKey, deviceTimestamp: 1795115599000, payload: { temperature: t }, mqtt: { topic: 'agro/lab/in/a', messageType: 'telemetry', dataOrigin: 'simulated' } }));
      await rogue('agro/lab/in/a', mk(20)); await rogue('agro/lab/in/a', mk(21)); await c.until(() => c.obs.publishRecords().filter(p => p.eventId === c.technicalKey + ':s6').length >= 2, { timeoutMs: 8000, what: 'the two rogue publishes', code: 'MQTT_PUBLISH_NOT_SEEN' }); return { injected: 'same eventId, different bytes' }; } },
];
