// BE14-04 — wires an ExternalConfig (observer/faultControl sections) into the runner's `externalObserved` option. Secrets come from environment variables only.
import type { ExternalConfig } from '../be14-03/external-config.js';
import type { ExternalRunOptions } from '../be14-03/runner.js';
import { createExternalWorldKit } from './external-world.js';
import { createFaultController } from './fault-controller.js';
import { createEmqxObservationSource, ObserverError, type ObservationSource } from './observer.js';

export async function buildObservedRun(cfg: ExternalConfig, env: Record<string, string | undefined>): Promise<{ options: ExternalRunOptions; source: ObservationSource; start(): Promise<void>; stop(): Promise<void> } | null> {
  const ob = cfg.observer; if (!ob?.enabled) return null;
  const apiAuth = 'Basic ' + Buffer.from(env[ob.apiKeyEnv!] + ':' + env[ob.apiSecretEnv!]).toString('base64');
  const api = async (method: string, path: string) => { const r = await fetch(ob.apiUrl.replace(/\/$/, '') + path, { method, headers: { authorization: apiAuth }, signal: AbortSignal.timeout(4000) }); return { status: r.status, body: await r.text() }; };
  const fc = cfg.faultControl;
  const faults = createFaultController({ runId: fc?.runId ?? 'external', ...(fc?.mode === 'lab-emqx' ? { broker: { containerName: fc.brokerContainer!, brokerUrl: cfg.mqtt.url, api }, ...(fc.readyTimeoutMs ? { readyTimeoutMs: fc.readyTimeoutMs } : {}) } : {}), ...(fc?.mode === 'lab-emqx' ? {} : {}) });
  const kit = createExternalWorldKit({ runId: fc?.runId ?? 'external', faults });
  const source = createEmqxObservationSource({ mqttUrl: cfg.mqtt.url, username: env[ob.observerUsernameEnv ?? cfg.mqtt.usernameEnv ?? ''] ?? '', password: env[ob.observerPasswordEnv ?? cfg.mqtt.passwordEnv ?? ''] ?? '', topicFilter: ob.topicFilter, technicalIdentity: cfg.technicalKey, api, ...(ob.pollMs ? { pollMs: ob.pollMs } : {}), ...(ob.observerClientId ? { clientId: ob.observerClientId } : {}) });
  const username = env[cfg.mqtt.usernameEnv ?? ''], password = env[cfg.mqtt.passwordEnv ?? ''];
  const options: ExternalRunOptions = { kit, identity: { declaredKind: cfg.publisher?.kind ?? 'undeclared', ...(cfg.publisher?.name ? { name: cfg.publisher.name } : {}), testDouble: cfg.publisher?.kind === 'test-bridge' }, requiredFaults: fc?.requiredFaults ?? [],
    bootExtras: () => ({ mqttUrl: cfg.mqtt.url, ...(username && password ? { mqttCredentials: { username, password } } : {}) }) };
  return { options, source, start: async () => { try { await source.start(kit.sink); } catch (e) { throw e instanceof ObserverError ? Object.assign(e, { infrastructure: true }) : e; } }, stop: () => source.stop() };
}
