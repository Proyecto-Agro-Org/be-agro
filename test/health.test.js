import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { createApp } from '../dist/src/app.js';

const allowedOrigin = 'https://app.example.com';
const app = createApp({ allowedOrigins: new Set([allowedOrigin]) });

let baseUrl;
let server;

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test('GET /health reports that the API is healthy', async () => {
  const response = await fetch(`${baseUrl}/health`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('CORS allows a configured origin', async () => {
  const response = await fetch(`${baseUrl}/health`, {
    headers: { Origin: allowedOrigin },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), allowedOrigin);
});

test('CORS handles an allowed preflight request', async () => {
  const response = await fetch(`${baseUrl}/health`, {
    method: 'OPTIONS',
    headers: {
      Origin: allowedOrigin,
      'Access-Control-Request-Method': 'GET',
    },
  });

  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), allowedOrigin);
  assert.match(response.headers.get('access-control-allow-methods'), /GET/);
});

test('CORS rejects an unconfigured origin', async () => {
  const response = await fetch(`${baseUrl}/health`, {
    headers: { Origin: 'https://untrusted.example.com' },
  });

  assert.equal(response.status, 403);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(await response.json(), {
    error: 'Origin not allowed by CORS',
  });
});

test('unknown routes return 404', async () => {
  const response = await fetch(`${baseUrl}/missing`);

  assert.equal(response.status, 404);
  assert.match(response.headers.get('content-type'), /text\/html/);
});

async function withApp(options, run) {
  const instance = createApp(options).listen(0, '127.0.0.1');
  await once(instance, 'listening');
  try {
    await run(`http://127.0.0.1:${instance.address().port}`);
  } finally {
    await new Promise((resolve, reject) => {
      instance.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test('health retains JSON headers and disables x-powered-by', async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.equal(response.headers.get('x-powered-by'), null);
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
});

test('HEAD /health retains the automatic empty response', async () => {
  const response = await fetch(`${baseUrl}/health`, { method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');
});

test('POST /health remains an unregistered route returning HTML', async () => {
  const response = await fetch(`${baseUrl}/health`, { method: 'POST' });
  assert.equal(response.status, 404);
  assert.match(response.headers.get('content-type'), /text\/html/);
});

test('wildcard CORS reflects Origin without enabling credentials', async () => {
  await withApp({ allowedOrigins: new Set(['*']) }, async (url) => {
    const origin = 'https://synthetic.example.invalid';
    const response = await fetch(`${url}/health`, { headers: { Origin: origin } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.match(response.headers.get('vary'), /Origin/);
    assert.equal(response.headers.get('access-control-allow-credentials'), null);
  });
});

test('CORS allowlist matching remains exact rather than normalizing similar origins', async () => {
  for (const origin of [
    `${allowedOrigin}/`,
    `${allowedOrigin}:443`,
    'https://app.example.com.evil.invalid',
  ]) {
    const response = await fetch(`${baseUrl}/health`, { headers: { Origin: origin } });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.deepEqual(await response.json(), { error: 'Origin not allowed by CORS' });
  }
});

test('an empty CORS allowlist still permits no Origin and rejects an Origin', async () => {
  await withApp({ allowedOrigins: new Set() }, async (url) => {
    assert.equal((await fetch(`${url}/health`)).status, 200);
    const response = await fetch(`${url}/health`, { headers: { Origin: allowedOrigin } });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.deepEqual(await response.json(), { error: 'Origin not allowed by CORS' });
  });
});

test('unexpected errors retain safe legacy 500 responses and internal logging', async (t) => {
  const failure = new Error('Synthetic internal diagnostic');
  class FailingOrigins extends Set {
    has() { throw failure; }
  }
  const diagnostic = t.mock.method(console, 'error', () => {});
  await withApp({ allowedOrigins: new FailingOrigins() }, async (url) => {
    const response = await fetch(`${url}/health`, { headers: { Origin: allowedOrigin } });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'Internal server error' });
    assert.equal(diagnostic.mock.callCount(), 1);
    assert.equal(diagnostic.mock.calls[0].arguments[0], failure);
  });
});

test('importing the compiled application does not open a listener', () => {
  const result = spawnSync(process.execPath, [
    '--input-type=module', '--eval',
    `import app, {createApp} from ${JSON.stringify(new URL('../dist/src/app.js', import.meta.url).href)};
     if (typeof app.listen !== 'function' || typeof createApp !== 'function') process.exitCode = 1;`,
  ], { encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

// Observe the real compiled startup in a child process, without changing its source.
// The observer reports the OS-selected port and closes only that child's listener.
async function probeStartup({ envFile, origins, requestedOrigin, port = '0' } = {}) {
  const tempRoot = await realpath(tmpdir());
  const directory = await mkdtemp(join(tempRoot, 'agro-be05-'));
  try {
    if (envFile !== undefined) await writeFile(join(directory, '.env'), envFile);
    const env = { ...process.env, PORT: port };
    delete env.CORS_ORIGINS;
    if (origins !== undefined) env.CORS_ORIGINS = origins;
    const program = `
      import {Server} from 'node:http';
      const listen = Server.prototype.listen;
      Server.prototype.listen = function (...args) {
        this.once('listening', async () => {
          try {
            const port = this.address().port;
            const response = await fetch('http://127.0.0.1:' + port + '/health', {
              headers: ${JSON.stringify(requestedOrigin ? { Origin: requestedOrigin } : {})}
            });
            console.log(JSON.stringify({port, status:response.status,
              allowOrigin:response.headers.get('access-control-allow-origin'), body:await response.json()}));
          } catch (error) { console.error(error); process.exitCode = 1; }
          finally { this.close(); }
        });
        return listen.apply(this, args);
      };
      await import(${JSON.stringify(new URL('../dist/scripts/start.js', import.meta.url).href)});
    `;
    const result = spawnSync(process.execPath, [
      '--env-file-if-exists=.env', '--input-type=module', '--eval', program,
    ], { cwd: directory, env, encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    return result;
  } finally {
    const resolved = await realpath(directory);
    assert.equal(dirname(resolved), tempRoot);
    assert.ok(basename(resolved).startsWith('agro-be05-'));
    await rm(resolved, { recursive: true });
  }
}

function startupResult(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.split(/\r?\n/).find((line) => line.startsWith('{')));
}

test('the compiled listener starts with PORT=0 and no .env', async () => {
  const response = startupResult(await probeStartup());
  assert.ok(response.port > 0);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: 'ok' });
});

test('optional .env is loaded before app initialization and CORS trims comma-separated origins', async () => {
  const response = startupResult(await probeStartup({
    envFile: 'CORS_ORIGINS= https://first.example.invalid, , https://second.example.invalid \n',
    requestedOrigin: 'https://second.example.invalid',
  }));
  assert.equal(response.status, 200);
  assert.equal(response.allowOrigin, 'https://second.example.invalid');
});

test('process environment takes precedence over optional .env', async () => {
  const response = startupResult(await probeStartup({
    envFile: 'CORS_ORIGINS=https://file.example.invalid\n',
    origins: 'https://process.example.invalid',
    requestedOrigin: 'https://file.example.invalid',
  }));
  assert.equal(response.status, 403);
  assert.equal(response.allowOrigin, null);
  assert.deepEqual(response.body, { error: 'Origin not allowed by CORS' });
});

test('invalid PORT still fails startup without silently falling back to 3000', async () => {
  const result = await probeStartup({ port: 'not-a-port' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ERR_SOCKET_BAD_PORT/);
});
