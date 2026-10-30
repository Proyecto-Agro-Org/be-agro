import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';

import { createApp } from '../src/app.js';

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
});
