import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { validateDb02Request, validateDb02Database, db02Uri, localDockerEndpoint, validateOwnedContainer } from '../dist/scripts/agro-db02/guard.js';
import { persistence } from '../dist/scripts/agro-db02/resources.js';

const environment = { AGRO_DB02_ENABLE: 'AUTHORIZED_DISPOSABLE_DB02_ONLY', AGRO_DB02_RUN_ID: 'a'.repeat(24),
  AGRO_DB02_CONTAINER: 'b'.repeat(64), AGRO_DB02_PORT: '27029', AGRO_DB02_TOPOLOGY: 'single-node-replica-set' };
const request = () => validateDb02Request(environment);
const container = () => ({ Id: environment.AGRO_DB02_CONTAINER, State: { Running: true },
  Config: { Image: 'mongodb/mongodb-community-server:8.0-ubi8', Labels: { 'agro.db02.run': environment.AGRO_DB02_RUN_ID }, Cmd: ['--bind_ip_all', '--replSet', 'agro_db02'] },
  HostConfig: { NetworkMode: 'agro-db02-' + environment.AGRO_DB02_RUN_ID, Privileged: false, Binds: null,
    PortBindings: { '27017/tcp': [{ HostIp: '127.0.0.1', HostPort: '27029' }] } },
  Mounts: [{ Type: 'tmpfs', Destination: '/data/db' }, { Type: 'tmpfs', Destination: '/data/configdb' }],
  NetworkSettings: { Networks: { ['agro-db02-' + environment.AGRO_DB02_RUN_ID]: {} },
    Ports: { '27017/tcp': [{ HostIp: '127.0.0.1', HostPort: '27029' }] } } });

test('DB02-G01 explicit opt-in and complete owned resource identity are required before any I/O', () => {
  assert.throws(() => validateDb02Request({}));
  for (const patch of [{ AGRO_DB02_ENABLE: '' }, { AGRO_DB02_RUN_ID: '../existing' }, { AGRO_DB02_CONTAINER: 'other-project' },
    { AGRO_DB02_PORT: '80' }, { AGRO_DB02_PORT: '27029?proxyHost=remote' }, { AGRO_DB02_TOPOLOGY: 'production' }])
    assert.throws(() => validateDb02Request({ ...environment, ...patch }));
  assert.equal(request().port, 27029);
});
test('DB02-G02 URIs/hosts/database overrides are forbidden and existing production URI is never used', () => {
  for (const key of ['AGRO_DB02_URI', 'AGRO_DB02_HOST', 'AGRO_DB02_DATABASE'])
    assert.throws(() => validateDb02Request({ ...environment, [key]: 'localhost-looking-but-untrusted' }));
  const r = validateDb02Request({ ...environment, MONGODB_URI: 'SYNTHETIC_PRIVATE_UNUSED' });
  const uri = db02Uri(r, 'agro_db02_test_' + r.runId);
  assert.equal(uri, 'mongodb://127.0.0.1:27029/agro_db02_test_' + r.runId + '?directConnection=true&replicaSet=agro_db02');
});
test('DB02-G03 only the exact run database can be queried or cleaned', () => {
  for (const name of ['iot_sensores', 'agro_test', 'admin', 'agro_db02_test_' + 'c'.repeat(24), '../test'])
    assert.throws(() => validateDb02Database(name, request()));
});
test('DB02-G04 Docker endpoint must be local IPC, not DNS, SSH or TCP even at loopback', () => {
  for (const endpoint of ['tcp://localhost:2375', 'ssh://server', 'tcp://127.0.0.1:2375', 'unix:///tmp/unknown.sock', 'https://remote'])
    assert.throws(() => localDockerEndpoint(endpoint));
  assert.doesNotThrow(() => localDockerEndpoint('npipe:////./pipe/docker_engine'));
});
test('DB02-G05 container ownership, official image and actual exclusive network are checked', () => {
  assert.equal(validateOwnedContainer(container(), request()), 'agro-db02-' + environment.AGRO_DB02_RUN_ID);
  for (const mutate of [c => { c.Id = 'c'.repeat(64); }, c => { c.Config.Image = 'unknown/mongodb'; },
    c => { c.Config.Labels['agro.db02.run'] = 'foreign'; }, c => { c.State.Running = false; },
    c => { c.NetworkSettings.Networks.shared = {}; }, c => { c.HostConfig.NetworkMode = 'host'; }]) {
    const c = container(); mutate(c); assert.throws(() => validateOwnedContainer(c, request()));
  }
});
test('DB02-G06 public ports, remapped destinations, persistent mounts and privileged mode are rejected', () => {
  for (const mutate of [c => { c.HostConfig.PortBindings['27017/tcp'][0].HostIp = '0.0.0.0'; },
    c => { c.HostConfig.PortBindings['27017/tcp'][0].HostPort = '27017'; },
    c => { c.HostConfig.PortBindings['27018/tcp'] = []; }, c => { c.Mounts[0].Type = 'volume'; }, c => { c.Mounts = []; },
    c => { c.HostConfig.Binds = ['C:/foreign:/data/db']; }, c => { c.HostConfig.Privileged = true; }]) {
    const c = container(); mutate(c); assert.throws(() => validateOwnedContainer(c, request()));
  }
});
test('DB02-G07 topology cannot be changed by an arbitrary replica set or missing flag', () => {
  const c = container(); c.Config.Cmd = ['--bind_ip_all']; assert.throws(() => validateOwnedContainer(c, request()));
  c.Config.Cmd = ['--bind_ip_all', '--replSet', 'foreign']; assert.throws(() => validateOwnedContainer(c, request()));
  const standalone = validateDb02Request({ ...environment, AGRO_DB02_TOPOLOGY: 'standalone' });
  assert.throws(() => validateOwnedContainer(container(), standalone));
  c.Config.Cmd = ['--bind_ip_all']; assert.doesNotThrow(() => validateOwnedContainer(c, standalone));
});
test('DB02-G08 CLI without authorization stops before Docker inspection or database sockets and sanitizes errors', () => {
  const child = spawnSync(process.execPath, ['dist/scripts/audit-agro-db02-mongodb-local.js'], {
    timeout: 10000, encoding: 'utf8', env: { ...process.env, AGRO_DB02_ENABLE: '', MONGODB_URI: 'SYNTHETIC_PRIVATE_UNUSED' } });
  assert.equal(child.status, 1); assert.equal(child.stdout, '');
  assert.match(child.stderr, /^DB02_NOT_COMPLETED:/); assert.equal(child.stderr.includes('SYNTHETIC_PRIVATE_UNUSED'), false);
});

test('DB03-G09 importing the integration worker has no execution or process side effects', () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    "await import('./dist/scripts/agro-db02/worker.js'); console.log('IMPORT_ONLY');"], {
    timeout: 10000, encoding: 'utf8', env: { ...process.env, AGRO_DB02_ENABLE: '' } });
  assert.equal(child.status, 0);
  assert.equal(child.stdout.trim(), 'IMPORT_ONLY');
  assert.equal(child.stderr, '');
});

test('DB02-D10 Docker --tmpfs is verified from HostConfig while absent or foreign storage remains rejected', () => {
  const c = container(); c.Mounts = [];
  c.HostConfig.Tmpfs = { '/data/db': 'rw,size=512m,mode=1777', '/data/configdb': 'rw,size=32m,mode=1777' };
  assert.doesNotThrow(() => validateOwnedContainer(c, request()));
  for (const configuration of [{}, { '/data/db': 'rw,size=512m' },
    { '/foreign': 'rw', '/data/db': 'rw' }, { '/data/db': 'ro', '/data/configdb': 'rw' }]) {
    c.HostConfig.Tmpfs = configuration;
    assert.throws(() => validateOwnedContainer(c, request()));
  }
});

test('DB02-D11 actual published ports must match loopback request, not merely HostConfig', () => {
  for (const mapping of [null, [], [{ HostIp: '0.0.0.0', HostPort: '27029' }], [{ HostIp: '127.0.0.1', HostPort: '27017' }]]) {
    const c = container(); c.NetworkSettings.Ports['27017/tcp'] = mapping;
    assert.throws(() => validateOwnedContainer(c, request()));
  }
});

test('DB02-D12 fixture auth namespace satisfies the existing production configuration validator', () => {
  assert.equal(persistence().collectionPrefix, 'agro_auth_db02');
  assert.equal(persistence().realm, 'test');
});
