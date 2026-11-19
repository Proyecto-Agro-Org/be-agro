import { execFileSync } from 'node:child_process';
import { z } from 'zod';

const requestSchema = z.object({
  enabled: z.literal('AUTHORIZED_DISPOSABLE_DB02_ONLY'),
  runId: z.string().regex(/^[a-f0-9]{24}$/),
  container: z.string().regex(/^[a-f0-9]{64}$/),
  port: z.string().regex(/^[0-9]{4,5}$/).transform(Number).pipe(z.number().int().min(1024).max(65535)),
  topology: z.enum(['standalone', 'single-node-replica-set']),
}).strict();
export type LocalRequest = z.output<typeof requestSchema>;
export function validateDb02Request(environment: Record<string, unknown>): LocalRequest {
  // Never accept a URI, host, credentials, existing database or discovery option.
  for (const key of ['AGRO_DB02_URI', 'AGRO_DB02_HOST', 'AGRO_DB02_DATABASE'])
    if (environment[key] !== undefined) throw new Error('DB02_DESTINATION_OVERRIDE_FORBIDDEN');
  const result = requestSchema.safeParse({ enabled: environment.AGRO_DB02_ENABLE, runId: environment.AGRO_DB02_RUN_ID,
    container: environment.AGRO_DB02_CONTAINER, port: environment.AGRO_DB02_PORT, topology: environment.AGRO_DB02_TOPOLOGY });
  if (!result.success) throw new Error('DB02_EXPLICIT_OWNED_LOCAL_AUTHORIZATION_REQUIRED');
  return Object.freeze(result.data);
}
export function validateDb02Database(input: string, request: LocalRequest) {
  if (input !== 'agro_db02_test_' + request.runId) throw new Error('DB02_DATABASE_NOT_OWNED');
  return input;
}
export function localDockerEndpoint(input: string) {
  if (!['npipe:////./pipe/docker_engine', 'npipe:////./pipe/dockerDesktopLinuxEngine',
    'unix:///var/run/docker.sock', 'unix:///run/docker.sock'].includes(input)) throw new Error('DB02_DOCKER_ENDPOINT_NOT_LOCAL');
}
const inspectSchema = z.object({ Id: z.string(), State: z.object({ Running: z.literal(true) }),
  Config: z.object({ Image: z.string().regex(/^mongodb\/mongodb-community-server:8\.0(?:\.\d+)?(?:-ubi\d+)?$/),
    Labels: z.record(z.string(), z.string()), Cmd: z.array(z.string()) }),
  HostConfig: z.object({ NetworkMode: z.string(), Privileged: z.literal(false),
    Binds: z.array(z.string()).nullable(), PortBindings: z.record(z.string(), z.array(z.object({ HostIp: z.string(), HostPort: z.string() }))) }),
  Mounts: z.array(z.object({ Type: z.string(), Destination: z.string() })),
  NetworkSettings: z.object({ Networks: z.record(z.string(), z.unknown()) }) });
export function validateOwnedContainer(input: unknown, request: LocalRequest) {
  const c = inspectSchema.parse(input), network = 'agro-db02-' + request.runId;
  if (c.Id !== request.container || c.Config.Labels['agro.db02.run'] !== request.runId || c.HostConfig.NetworkMode !== network ||
    JSON.stringify(Object.keys(c.NetworkSettings.Networks)) !== JSON.stringify([network]) || c.HostConfig.Binds?.length ||
    c.Mounts.length !== 2 || new Set(c.Mounts.map(m => m.Destination)).size !== 2 ||
    c.Mounts.some(m => m.Type !== 'tmpfs' || !['/data/db', '/data/configdb'].includes(m.Destination))) throw new Error('DB02_CONTAINER_NOT_OWNED_ISOLATED');
  const bindings = c.HostConfig.PortBindings;
  if (Object.keys(bindings).length !== 1 || JSON.stringify(bindings['27017/tcp']) !== JSON.stringify([{ HostIp: '127.0.0.1', HostPort: String(request.port) }]))
    throw new Error('DB02_LOOPBACK_BINDING_REQUIRED');
  const cmd = c.Config.Cmd;
  if (!cmd.includes('--bind_ip_all') || (request.topology === 'single-node-replica-set'
    ? !cmd.includes('--replSet') || cmd[cmd.indexOf('--replSet') + 1] !== 'agro_db02' : cmd.includes('--replSet'))) throw new Error('DB02_TOPOLOGY_MISMATCH');
  return network;
}
function docker(args: string[]) {
  try { return JSON.parse(execFileSync('docker', args, { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 })); }
  catch { throw new Error('DB02_LOCAL_DOCKER_INSPECTION_FAILED'); }
}
export function verifyOwnedDocker(request: LocalRequest) {
  if (process.env.DOCKER_HOST) localDockerEndpoint(process.env.DOCKER_HOST);
  const contexts = z.array(z.object({ Endpoints: z.object({ docker: z.object({ Host: z.string() }) }) })).length(1).parse(docker(['context', 'inspect']));
  localDockerEndpoint(contexts[0].Endpoints.docker.Host);
  const containers = z.array(z.unknown()).length(1).parse(docker(['inspect', request.container]));
  const name = validateOwnedContainer(containers[0], request);
  const imageId = z.object({ Image: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).parse(containers[0]).Image;
  const network = z.array(z.object({ Internal: z.literal(true), Labels: z.record(z.string(), z.string()),
    Containers: z.record(z.string(), z.unknown()) })).length(1).parse(docker(['network', 'inspect', name]))[0];
  if (network.Labels['agro.db02.run'] !== request.runId || Object.keys(network.Containers).some(id => id !== request.container))
    throw new Error('DB02_SHARED_OR_UNKNOWN_NETWORK');
  return Object.freeze({ container: request.container, network: name, port: request.port, imageId });
}
export function db02Uri(request: LocalRequest, database: string) {
  validateDb02Database(database, request);
  return 'mongodb://127.0.0.1:' + request.port + '/' + database + '?directConnection=true' +
    (request.topology === 'single-node-replica-set' ? '&replicaSet=agro_db02' : '');
}
