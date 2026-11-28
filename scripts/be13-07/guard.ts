import { execFileSync } from 'node:child_process';
import { z } from 'zod';

// BE13-07 — guard for the disposable local 3-node replica set. Accepts only the
// containers/network created by be13-07-multinode-local.ps1 for this runId,
// loopback ports, and the agro_mn replica set. Chaos actions are allowed only
// on the owned node containers.
const requestSchema = z.object({
  enabled: z.literal('AUTHORIZED_DISPOSABLE_MULTINODE_ONLY'),
  runId: z.string().regex(/^[a-f0-9]{24}$/),
  holder: z.string().regex(/^[a-f0-9]{64}$/),
  nodes: z.string().transform(s => s.split(',')).pipe(z.array(z.string().regex(/^[a-f0-9]{64}$/)).length(3)),
  basePort: z.string().regex(/^[0-9]{4,5}$/).transform(Number).pipe(z.number().int().min(1024).max(65000)),
}).strict();
export type MultiNodeRequest = z.output<typeof requestSchema> & { readonly ports: readonly number[] };

export function validateMultiNodeRequest(env: Record<string, unknown>): MultiNodeRequest {
  for (const key of ['AGRO_MN_URI', 'AGRO_MN_HOST', 'MONGODB_URI_OVERRIDE']) if (env[key] !== undefined) throw new Error('MN_DESTINATION_OVERRIDE_FORBIDDEN');
  const parsed = requestSchema.safeParse({ enabled: env.AGRO_MN_ENABLE, runId: env.AGRO_MN_RUN_ID, holder: env.AGRO_MN_HOLDER, nodes: env.AGRO_MN_NODES, basePort: env.AGRO_MN_BASE_PORT });
  if (!parsed.success) throw new Error('MN_EXPLICIT_OWNED_LOCAL_AUTHORIZATION_REQUIRED');
  const p = parsed.data.basePort;
  return Object.freeze({ ...parsed.data, ports: Object.freeze([p, p + 1, p + 2]) });
}

const LOCAL_ENDPOINTS = ['npipe:////./pipe/docker_engine', 'npipe:////./pipe/dockerDesktopLinuxEngine', 'unix:///var/run/docker.sock', 'unix:///run/docker.sock'];
function docker(args: string[]): string {
  try { return execFileSync('docker', args, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024 }); }
  catch { throw new Error('MN_LOCAL_DOCKER_COMMAND_FAILED'); }
}
const inspectSchema = z.object({ Id: z.string(), State: z.object({ Running: z.boolean(), Paused: z.boolean() }),
  Config: z.object({ Image: z.string(), Labels: z.record(z.string(), z.string()), Cmd: z.array(z.string()).nullable() }),
  HostConfig: z.object({ NetworkMode: z.string(), Privileged: z.boolean(), Binds: z.array(z.string()).nullable(), Tmpfs: z.record(z.string(), z.string()).nullable().optional(),
    PortBindings: z.record(z.string(), z.array(z.object({ HostIp: z.string(), HostPort: z.string() }))).nullable() }) });

function inspect(id: string) { return inspectSchema.parse(z.array(z.unknown()).length(1).parse(JSON.parse(docker(['inspect', id])))[0]); }

export function verifyOwnedMultiNode(request: MultiNodeRequest) {
  if (process.env.DOCKER_HOST && !LOCAL_ENDPOINTS.includes(process.env.DOCKER_HOST)) throw new Error('MN_DOCKER_ENDPOINT_NOT_LOCAL');
  const contexts = z.array(z.object({ Endpoints: z.object({ docker: z.object({ Host: z.string() }) }) })).length(1).parse(JSON.parse(docker(['context', 'inspect'])));
  if (!LOCAL_ENDPOINTS.includes(contexts[0].Endpoints.docker.Host)) throw new Error('MN_DOCKER_ENDPOINT_NOT_LOCAL');
  const network = 'agro-mn-' + request.runId;
  const holder = inspect(request.holder);
  if (holder.Id !== request.holder || !holder.State.Running || holder.Config.Labels['agro.mn.run'] !== request.runId || holder.Config.Labels['agro.mn.role'] !== 'holder')
    throw new Error('MN_HOLDER_IDENTITY_MISMATCH');
  if (!/^mongodb\/mongodb-community-server:8\.0(?:\.\d+)?(?:-ubi\d+)?$/.test(holder.Config.Image)) throw new Error('MN_IMAGE_IDENTITY_MISMATCH');
  if (holder.HostConfig.Privileged || holder.HostConfig.Binds?.length || holder.HostConfig.NetworkMode !== network) throw new Error('MN_HOLDER_CONFIGURATION_MISMATCH');
  const bindings = holder.HostConfig.PortBindings ?? {};
  const expected = Object.fromEntries(request.ports.map(p => [p + '/tcp', [{ HostIp: '127.0.0.1', HostPort: String(p) }]]));
  if (JSON.stringify(Object.keys(bindings).sort()) !== JSON.stringify(Object.keys(expected).sort()) ||
    Object.entries(expected).some(([k, v]) => JSON.stringify(bindings[k]) !== JSON.stringify(v))) throw new Error('MN_LOOPBACK_BINDING_MISMATCH');
  request.nodes.forEach((id, i) => {
    const node = inspect(id);
    if (node.Id !== id || node.Config.Labels['agro.mn.run'] !== request.runId || node.Config.Labels['agro.mn.role'] !== 'node' + (i + 1)) throw new Error('MN_NODE_IDENTITY_MISMATCH');
    if (node.HostConfig.Privileged || node.HostConfig.Binds?.length || node.HostConfig.NetworkMode !== 'container:' + request.holder) throw new Error('MN_NODE_CONFIGURATION_MISMATCH');
    if (Object.keys(node.HostConfig.Tmpfs ?? {}).sort().join() !== '/data/configdb,/data/db') throw new Error('MN_NODE_TMPFS_MISMATCH');
    const cmd = node.Config.Cmd ?? [];
    if (cmd[cmd.indexOf('--replSet') + 1] !== 'agro_mn' || cmd[cmd.indexOf('--port') + 1] !== String(request.ports[i])) throw new Error('MN_NODE_TOPOLOGY_MISMATCH');
  });
  const net = z.array(z.object({ Driver: z.string(), Internal: z.boolean(), Options: z.record(z.string(), z.string()), Labels: z.record(z.string(), z.string()),
    Containers: z.record(z.string(), z.unknown()) })).length(1).parse(JSON.parse(docker(['network', 'inspect', network])))[0];
  if (net.Driver !== 'bridge' || net.Labels['agro.mn.run'] !== request.runId || net.Options['com.docker.network.bridge.host_binding_ipv4'] !== '127.0.0.1' ||
    net.Options['com.docker.network.bridge.enable_ip_masquerade'] !== 'false' || Object.keys(net.Containers).some(c => c !== request.holder)) throw new Error('MN_NETWORK_MISMATCH');
  return Object.freeze({ network, holder: request.holder, nodes: request.nodes });
}

export function multiNodeUri(request: MultiNodeRequest, database: string) {
  if (database !== 'agro_mn_test_' + request.runId) throw new Error('MN_DATABASE_NOT_OWNED');
  return 'mongodb://' + request.ports.map(p => '127.0.0.1:' + p).join(',') + '/' + database + '?replicaSet=agro_mn';
}

export function assertLocalMultiNodeUri(uri: string, ports: readonly number[]) {
  if (uri.startsWith('mongodb+srv:')) throw new Error('MN_SRV_FORBIDDEN');
  if (/(mongodb\.net|amazonaws\.com|azure\.com|documentdb|@)/i.test(uri)) throw new Error('MN_NON_LOCAL_OR_CREDENTIALS');
  const match = /^mongodb:\/\/([^/?#]+)\/([A-Za-z0-9_]+)\?(.*)$/.exec(uri);
  if (!match) throw new Error('MN_URI_SHAPE');
  const hosts = match[1].split(',');
  if (hosts.length !== 3 || hosts.some((h, i) => h !== '127.0.0.1:' + ports[i])) throw new Error('MN_HOST_NOT_LOOPBACK');
  const params = new URLSearchParams(match[3]);
  if (params.get('replicaSet') !== 'agro_mn' || params.has('directConnection') || params.has('tls') || params.has('ssl') || params.has('authSource'))
    throw new Error('MN_OPTIONS_FORBIDDEN');
}

export function assertLocalMultiNodeHello(hello: Record<string, unknown>, ports: readonly number[]) {
  const allowed = new Set(ports.map(p => '127.0.0.1:' + p));
  const hosts = [...(Array.isArray(hello.hosts) ? hello.hosts : []), ...(Array.isArray(hello.passives) ? hello.passives : []), ...(Array.isArray(hello.arbiters) ? hello.arbiters : [])];
  if (hello.msg === 'isdbgrid' || hello.setName !== 'agro_mn' || hosts.length !== 3 || hosts.some(h => !allowed.has(String(h)))) throw new Error('MN_TOPOLOGY_NOT_LOCAL');
}

// Chaos is limited to the owned node containers, with a closed list of actions.
export function chaos(request: MultiNodeRequest, action: 'stop' | 'start' | 'pause' | 'unpause', nodeIndex: number) {
  const id = request.nodes[nodeIndex];
  if (!id) throw new Error('MN_UNKNOWN_NODE');
  const node = inspect(id);
  if (node.Config.Labels['agro.mn.run'] !== request.runId) throw new Error('MN_NODE_IDENTITY_MISMATCH');
  docker(action === 'stop' ? ['stop', '-t', '10', id] : [action, id]);
}
