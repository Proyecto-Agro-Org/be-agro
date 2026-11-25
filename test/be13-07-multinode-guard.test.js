// BE13-07 — offline tests for the multi-node local guard (no Docker needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertLocalMultiNodeUri, assertLocalMultiNodeHello, multiNodeUri, validateMultiNodeRequest } from '../dist/scripts/be13-07/guard.js';

const ports = [27071, 27072, 27073];
const env = { AGRO_MN_ENABLE: 'AUTHORIZED_DISPOSABLE_MULTINODE_ONLY', AGRO_MN_RUN_ID: 'a'.repeat(24), AGRO_MN_HOLDER: 'b'.repeat(64),
  AGRO_MN_NODES: ['c', 'd', 'e'].map(x => x.repeat(64)).join(','), AGRO_MN_BASE_PORT: '27071' };

test('MN guard: explicit owned authorization is required; overrides are forbidden', () => {
  const request = validateMultiNodeRequest(env);
  assert.deepEqual([...request.ports], ports);
  for (const bad of [{ ...env, AGRO_MN_ENABLE: 'yes' }, { ...env, AGRO_MN_NODES: 'c'.repeat(64) }, { ...env, AGRO_MN_BASE_PORT: '80' }, { ...env, AGRO_MN_URI: 'mongodb://x' }, {}]) {
    assert.throws(() => validateMultiNodeRequest(bad));
  }
  assert.equal(multiNodeUri(request, 'agro_mn_test_' + 'a'.repeat(24)), 'mongodb://127.0.0.1:27071,127.0.0.1:27072,127.0.0.1:27073/agro_mn_test_' + 'a'.repeat(24) + '?replicaSet=agro_mn');
  assert.throws(() => multiNodeUri(request, 'production'));
});

test('MN guard: only loopback members of agro_mn without credentials, TLS or discovery overrides', () => {
  assertLocalMultiNodeUri('mongodb://127.0.0.1:27071,127.0.0.1:27072,127.0.0.1:27073/agro_mn_test_x?replicaSet=agro_mn', ports);
  for (const uri of ['mongodb+srv://c.x.mongodb.net/db', 'mongodb://c-00.x.mongodb.net:27017,127.0.0.1:27072,127.0.0.1:27073/db?replicaSet=agro_mn',
    'mongodb://u:p@127.0.0.1:27071,127.0.0.1:27072,127.0.0.1:27073/db?replicaSet=agro_mn', 'mongodb://10.0.0.1:27071,127.0.0.1:27072,127.0.0.1:27073/db?replicaSet=agro_mn',
    'mongodb://127.0.0.1:27071/db?replicaSet=agro_mn', 'mongodb://127.0.0.1:27071,127.0.0.1:27072,127.0.0.1:27073/db?replicaSet=prod',
    'mongodb://127.0.0.1:27071,127.0.0.1:27072,127.0.0.1:27073/db?replicaSet=agro_mn&directConnection=true',
    'mongodb://127.0.0.1:27071,127.0.0.1:27072,127.0.0.1:27073/db?replicaSet=agro_mn&tls=true']) assert.throws(() => assertLocalMultiNodeUri(uri, ports), uri);
  assertLocalMultiNodeHello({ setName: 'agro_mn', hosts: ports.map(p => '127.0.0.1:' + p) }, ports);
  for (const hello of [{ setName: 'agro_mn', hosts: ['127.0.0.1:27071', '127.0.0.1:27072', '10.0.0.3:27073'] }, { setName: 'rs0', hosts: ports.map(p => '127.0.0.1:' + p) },
    { msg: 'isdbgrid' }, { setName: 'agro_mn', hosts: ['127.0.0.1:27071', '127.0.0.1:27072'], passives: ['8.8.8.8:27017'] }]) assert.throws(() => assertLocalMultiNodeHello(hello, ports));
});

test('MN launcher: closed chaos actions, loopback publishing, ownership labels and confirmed cleanup', () => {
  const launcher = readFileSync(new URL('../scripts/be13-07-multinode-local.ps1', import.meta.url), 'utf8');
  assert.match(launcher, /host_binding_ipv4=127\.0\.0\.1/);
  assert.match(launcher, /"127\.0\.0\.1:\$\{p\}:\$\{p\}"/);
  assert.match(launcher, /--network "container:\$holderId"/);
  assert.match(launcher, /Owned resource cleanup unconfirmed/);
  // Closed list of runners with literal paths; the suite name never becomes part of a path.
  assert.match(launcher, /ValidateSet\('be13-07','be13-08','be13-09','be13-10b','be13-11a','be13-11b','be13-11c'\)/);
  assert.match(launcher, /'be13-08'\{'dist\/scripts\/audit-be13-08-multinode-local\.js'\}'be13-09'\{'dist\/scripts\/audit-be13-09-multinode-local\.js'\}'be13-10b'\{'dist\/scripts\/audit-be13-10b-multinode-local\.js'\}'be13-11a'\{'dist\/scripts\/audit-be13-11a-multinode-local\.js'\}'be13-11b'\{'dist\/scripts\/audit-be13-11b-multinode-local\.js'\}'be13-11c'\{'dist\/scripts\/audit-be13-11c-multinode-local\.js'\}default\{'dist\/scripts\/audit-be13-07-multinode-local\.js'\}/);
  assert.match(launcher, /& node \$runner/);
  assert.doesNotMatch(launcher, /& node ["']?\$Suite/);
  assert.doesNotMatch(launcher, /--privileged|-v |--volume|mongodb\+srv/);
  const guard = readFileSync(new URL('../scripts/be13-07/guard.ts', import.meta.url), 'utf8');
  assert.match(guard, /action: 'stop' \| 'start' \| 'pause' \| 'unpause'/);
});
