// BE13-11D — LOCAL_TEST_ONLY EMQX laboratory controller. Starts ONE disposable EMQX container bound to 127.0.0.1, configures
// username/password authentication, a deny-by-default ACL and the broker rule that authors publisher facts, and removes
// everything at the end. Credentials are generated per run, held in memory only and scrubbed from any output. No Atlas, no
// external broker, no cloud, no production.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { LAB_VERIFIED_TOPIC } from '../../src/adapters/emqx-mqtt-broker.adapter.js';

export const EMQX_IMAGE = 'emqx/emqx:5.8.6';
export const LAB_USERS = ['lab-device-a', 'lab-device-b', 'lab-attacker', 'lab-consumer'] as const;
export type LabUser = typeof LAB_USERS[number];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

export interface EmqxLab {
  readonly containerName: string;
  readonly mqttPort: number;
  readonly brokerUrl: string;
  readonly secrets: Readonly<Record<string, string>>;
  api(method: string, path: string, body?: unknown): Promise<{ status: number; body: string }>;
  restart(): Promise<void>;
  logs(): string;
  scrub(text: string): string;
  stop(): void;
}

export async function startEmqxLab(basePort: number, runId: string, loadUsers: readonly string[] = []): Promise<EmqxLab> {
  const mqttPort = basePort + 20, apiPort = basePort + 21;
  const containerName = 'agro-emqx-lab-' + runId.slice(0, 12);
  const secrets = Object.fromEntries([...LAB_USERS, ...loadUsers].map(u => [u, 'labpw-' + randomBytes(16).toString('hex')])) as Record<string, string>;
  const dashUser = 'dash-' + randomBytes(5).toString('hex'), dashPassword = 'labpw-' + randomBytes(16).toString('hex');
  const all = [...Object.values(secrets), dashPassword];
  const scrub = (text: string) => all.reduce((t, s) => t.split(s).join('***'), text);
  let token = '';
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${apiPort}/api/v5${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: scrub((await response.text()).slice(0, 600)) };
  };
  // EVERYTHING is bound to loopback. Only the MQTT and the management ports are published.
  docker('run', '-d', '--name', containerName, '--label', 'agro.emqx.lab=' + runId, '-p', `127.0.0.1:${mqttPort}:1883`, '-p', `127.0.0.1:${apiPort}:18083`,
    '-e', 'EMQX_DASHBOARD__DEFAULT_USERNAME=' + dashUser, '-e', 'EMQX_DASHBOARD__DEFAULT_PASSWORD=' + dashPassword, '-e', 'EMQX_AUTHORIZATION__NO_MATCH=deny', EMQX_IMAGE);
  const stop = () => { try { docker('rm', '-f', containerName); } catch { /* already gone */ } };
  try {
    for (let i = 0; i < 120 && !token; i += 1) {
      try { const r = await fetch(`http://127.0.0.1:${apiPort}/api/v5/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: dashUser, password: dashPassword }) });
        if (r.ok) token = ((await r.json()) as { token: string }).token; } catch { /* starting */ }
      if (!token) await sleep(1000);
    }
    if (!token) throw new Error('EMQX_LAB_NOT_READY');
    const must = async (what: string, r: Promise<{ status: number; body: string }>, ok: number[]) => { const x = await r; if (!ok.includes(x.status)) throw new Error('EMQX_LAB_CONFIG_FAILED_' + what + '_' + x.status); };
    await must('authn', api('POST', '/authentication', { mechanism: 'password_based', backend: 'built_in_database', user_id_type: 'username', password_hash_algorithm: { name: 'sha256', salt_position: 'suffix' } }), [200, 201]);
    for (const u of [...LAB_USERS, ...loadUsers]) await must('user', api('POST', '/authentication/password_based:built_in_database/users', { user_id: u, password: secrets[u]! }), [201]);
    await must('authz-source', api('POST', '/authorization/sources', { type: 'built_in_database', enable: true }), [204]);
    await must('authz-file-off', api('DELETE', '/authorization/sources/file'), [204]);          // the default file source would allow everything from loopback
    const pub = (topic: string) => ({ action: 'publish', permission: 'allow', topic, qos: [0, 1, 2], retain: 'all' });
    await must('acl', api('POST', '/authorization/sources/built_in_database/rules/users', [
      { username: 'lab-device-a', rules: [pub('agro/lab/in/a'), pub('agro/lab/in/production/a')] },
      { username: 'lab-device-b', rules: [pub('agro/lab/in/b')] },
      { username: 'lab-attacker', rules: [pub('agro/lab/in/#')] },
      { username: 'lab-consumer', rules: [{ action: 'subscribe', permission: 'allow', topic: LAB_VERIFIED_TOPIC, qos: [0, 1, 2] }, { action: 'subscribe', permission: 'allow', topic: '$share/lab/' + LAB_VERIFIED_TOPIC, qos: [0, 1, 2] }] },
    ]), [204]);
    // BE13-11E: each synthetic load publisher may publish ONLY to its own routing topic (the topic is routing, never identity).
    for (let i = 0; i < loadUsers.length; i += 50) await must('acl-load', api('POST', '/authorization/sources/built_in_database/rules/users', loadUsers.slice(i, i + 50).map(u => ({ username: u, rules: [pub('agro/lab/in/load/' + u)] }))), [204]);
    // The broker authors the publisher facts: nobody can publish to the verified topic (ACL), so only this rule can write to it.
    await must('rule', api('POST', '/rules', { id: 'lab_verify', sql: 'SELECT clientid, username, qos, topic, flags.retain AS retain, publish_received_at, base64_encode(payload) AS payload_b64 FROM "agro/lab/in/#"',
      actions: [{ function: 'republish', args: { topic: LAB_VERIFIED_TOPIC, qos: '${qos}', retain: false, payload: '${.}' } }] }), [201]);
    await sleep(500);
  } catch (error) { stop(); throw error; }
  const restart = async () => {
    docker('restart', containerName);
    for (let i = 0; i < 90; i += 1) { try { const r = await fetch(`http://127.0.0.1:${apiPort}/api/v5/status`); if (r.ok) { token = ''; break; } } catch { /* restarting */ } await sleep(1000); }
    for (let i = 0; i < 60 && !token; i += 1) { try { const r = await fetch(`http://127.0.0.1:${apiPort}/api/v5/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: dashUser, password: dashPassword }) });
      if (r.ok) token = ((await r.json()) as { token: string }).token; } catch { /* not yet */ } if (!token) await sleep(1000); }
    if (!token) throw new Error('EMQX_LAB_RESTART_FAILED');
    await sleep(1000);
  };
  const logs = () => { try { return scrub(execFileSync('docker', ['logs', containerName], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 })); } catch { return ''; } };
  return { containerName, mqttPort, brokerUrl: `mqtt://127.0.0.1:${mqttPort}`, secrets, api, restart, logs, scrub, stop };
}

export function labContainersRemaining(): string[] {
  try { return docker('ps', '-a', '--filter', 'label=agro.emqx.lab', '--format', '{{.Names}}').split(/\r?\n/).filter(Boolean); } catch { return ['docker-unavailable']; }
}
