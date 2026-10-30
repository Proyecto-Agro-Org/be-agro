import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';

import app from '../src/app.js';

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

test('unknown routes return 404', async () => {
  const response = await fetch(`${baseUrl}/missing`);

  assert.equal(response.status, 404);
});
