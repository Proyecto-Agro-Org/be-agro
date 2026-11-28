// BE14-03 — configuration of MODE B (external publisher). PREPARED, not executed: no external publisher exists. Secrets are NEVER in the file: only the NAMES of environment variables.
import { isValidEventId } from '../../src/iot/event-id.js';

export interface ExternalConfig { technicalKey: string; mqtt: { url: string; usernameEnv?: string; passwordEnv?: string }; reconciliation: { principal: string; tokenEnv?: string }; scope: { foreignPrincipal?: string }; bridge: { command: string; args?: string[] };
  /** BE14-04 (all optional; absent = the old BE14-03 behaviour, world-dependent tests stay NOT_RUN) */
  publisher?: { kind: 'real-external' | 'test-bridge'; name?: string };
  observer?: { enabled: boolean; topicFilter: string; apiUrl: string; apiKeyEnv: string; apiSecretEnv: string; pollMs?: number; observerClientId?: string; observerUsernameEnv?: string; observerPasswordEnv?: string };
  faultControl?: { mode: 'none' | 'lab-emqx'; brokerContainer?: string; runId?: string; readyTimeoutMs?: number; requiredFaults?: string[] };
  timeouts?: { perTestMs?: number; bridgeMs?: number }; capabilities?: { declared?: string[] } }
const SECRET_KEY = /(pass(word)?|secret|token|api[-_]?key|credential)$/i;

/** Throws a stable, secret-free Error for anything wrong. Rejects inline secrets, non-local MQTT endpoints and missing env variables. */
export function validateExternalConfig(raw: unknown, env: Record<string, string | undefined>): ExternalConfig {
  const bad = (m: string): never => { throw new Error('external config: ' + m); };
  if (!raw || typeof raw !== 'object') return bad('not an object'); const c = raw as Record<string, unknown>;
  const walk = (o: unknown, path: string): void => { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (SECRET_KEY.test(k) && !/Env$/.test(k) && typeof v === 'string' && v !== '') bad(`inline secret at "${path}${k}" (reference an environment variable instead, e.g. "${k}Env")`); walk(v, path + k + '.'); } };
  walk(c, '');
  const technicalKey = String(c.technicalKey ?? ''); if (!isValidEventId(technicalKey)) bad('technicalKey must be a canonical technical id');
  const mqtt = c.mqtt as ExternalConfig['mqtt'] | undefined; if (!mqtt || typeof mqtt.url !== 'string') return bad('mqtt.url missing');
  let host = ''; try { host = new URL(mqtt.url).hostname; } catch { bad('mqtt.url is not a URL'); } if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) bad('mqtt.url must be a LOCAL broker (loopback only)');
  for (const k of ['usernameEnv', 'passwordEnv'] as const) { const n = mqtt[k]; if (n !== undefined && (typeof n !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(n) || !env[n])) bad(`mqtt.${k} must name a set environment variable`); }
  const rec = c.reconciliation as ExternalConfig['reconciliation'] | undefined; if (!rec || typeof rec.principal !== 'string' || !rec.principal) return bad('reconciliation.principal missing');
  if (rec.tokenEnv !== undefined && (typeof rec.tokenEnv !== 'string' || !env[rec.tokenEnv])) bad('reconciliation.tokenEnv must name a set environment variable');
  const bridge = c.bridge as ExternalConfig['bridge'] | undefined; if (!bridge || typeof bridge.command !== 'string' || !bridge.command) return bad('bridge.command missing');
  if (bridge.args !== undefined && (!Array.isArray(bridge.args) || bridge.args.some(a => typeof a !== 'string'))) bad('bridge.args must be strings');
  const out: ExternalConfig = { technicalKey, mqtt, reconciliation: rec, scope: (c.scope as ExternalConfig['scope']) ?? {}, bridge };
  const pub = c.publisher as ExternalConfig['publisher'] | undefined; if (pub !== undefined) { if (!pub || !['real-external', 'test-bridge'].includes(pub.kind)) bad('publisher.kind must be real-external|test-bridge'); out.publisher = pub; }
  const ob = c.observer as ExternalConfig['observer'] | undefined;
  if (ob !== undefined) { if (typeof ob.enabled !== 'boolean') bad('observer.enabled must be boolean');
    if (ob.enabled) { if (typeof ob.topicFilter !== 'string' || !ob.topicFilter) bad('observer.topicFilter missing'); let h = ''; try { h = new URL(ob.apiUrl).hostname; } catch { bad('observer.apiUrl is not a URL'); } if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(h)) bad('observer.apiUrl must be a LOCAL endpoint (loopback only)');
      for (const k of ['apiKeyEnv', 'apiSecretEnv', 'observerUsernameEnv', 'observerPasswordEnv'] as const) { const n = ob[k]; if (n === undefined && (k === 'apiKeyEnv' || k === 'apiSecretEnv')) bad('observer.' + k + ' missing'); if (n !== undefined && (typeof n !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(n) || !env[n])) bad('observer.' + k + ' must name a set environment variable'); } }
    out.observer = ob; }
  const fc = c.faultControl as ExternalConfig['faultControl'] | undefined; if (fc !== undefined) { if (!fc || !['none', 'lab-emqx'].includes(fc.mode)) bad('faultControl.mode must be none|lab-emqx'); if (fc.mode === 'lab-emqx' && (!fc.brokerContainer || !fc.runId)) bad('faultControl lab-emqx needs brokerContainer and runId (only containers labelled with that run are ever touched)'); out.faultControl = fc; }
  if (c.timeouts !== undefined) out.timeouts = c.timeouts as ExternalConfig['timeouts']; if (c.capabilities !== undefined) out.capabilities = c.capabilities as ExternalConfig['capabilities'];
  return out;
}
