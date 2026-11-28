// BE14-01 — REFERENCE MQTT port over MQTT.js: ONE connection per publisher identity, clientId = the device technical key (never random, never shared), QoS 1,
// PUBACK = BROKER_ACCEPTED only. Reconnects lazily after the broker closes the connection. TEST_ONLY credentials are injected by the caller; nothing is hardcoded.
import { loadMqttJsFactory } from '../../src/adapters/emqx-mqtt-connect.js';
import { createSingleConnectionGuard, type MqttPublisherPort } from './reference-publisher.js';

type Client = { on(e: string, l: (...a: unknown[]) => void): void; publish(t: string, p: Buffer, o: object, cb: (e: Error | null) => void): void; end(force?: boolean, o?: object, cb?: () => void): void };
export function createMqttPublisherPort(o: { url: string; technicalKey: string; username: string; password: string; topic: string; ackTimeoutMs?: number; connectTimeoutMs?: number; factory?: (url: string, opts: object) => unknown }) {
  const guard = createSingleConnectionGuard(o.technicalKey); let client: Client | null = null, release: (() => void) | null = null, closed = true, opening: Promise<Client | null> | null = null;
  const open = async (): Promise<Client | null> => {
    if (client && !closed) return client; if (opening) return opening;
    opening = (async () => {
      const factory = o.factory ?? (await loadMqttJsFactory()) as unknown as (url: string, opts: object) => unknown; const rel = guard.acquire();
      const c = factory(o.url, { protocolVersion: 5, clientId: guard.clientId, username: o.username, password: o.password, clean: true, reconnectPeriod: 0 }) as Client;
      const ok = await new Promise<boolean>(res => { c.on('connect', () => res(true)); c.on('error', () => res(false)); setTimeout(() => res(false), o.connectTimeoutMs ?? 8000); });
      if (!ok) { rel(); try { c.end(true); } catch { /* */ } client = null; closed = true; return null; }
      closed = false; client = c; release = rel; c.on('close', () => { closed = true; release?.(); release = null; }); return c;
    })().finally(() => { opening = null; });
    return opening;
  };
  const port: MqttPublisherPort & { close(): Promise<void>; readonly connectionsOpen: number } = {
    async publish(_eventId, bytes) {
      let c: Client | null; try { c = await open(); } catch { return false; } if (!c) return false;
      return new Promise<boolean>(res => { const t = setTimeout(() => res(false), o.ackTimeoutMs ?? 8000); c!.publish(o.topic, Buffer.from(bytes), { qos: 1 }, e => { clearTimeout(t); res(!e); }); });
    },
    async close() { const c = client; client = null; if (c) await new Promise<void>(res => { c.end(true, {}, () => res()); setTimeout(res, 1500); }); },
    get connectionsOpen() { return guard.open; },
  };
  return port;
}
