import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';

import { createApp } from '../dist/src/app.js';

test('independent app instances retain separate CORS configurations', async () => {
  const origin = 'https://isolated.example.invalid';
  const allowed = createApp({ allowedOrigins: new Set([origin]) }).listen(0, '127.0.0.1');
  const denied = createApp({ allowedOrigins: new Set() }).listen(0, '127.0.0.1');
  try {
    await Promise.all([once(allowed, 'listening'), once(denied, 'listening')]);
    const [accepted, rejected] = await Promise.all([
      fetch(`http://127.0.0.1:${allowed.address().port}/health`, { headers: { Origin: origin } }),
      fetch(`http://127.0.0.1:${denied.address().port}/health`, { headers: { Origin: origin } }),
    ]);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get('access-control-allow-origin'), origin);
    assert.deepEqual(await accepted.json(), { status: 'ok' });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.headers.get('access-control-allow-origin'), null);
    assert.deepEqual(await rejected.json(), { error: 'Origin not allowed by CORS' });
  } finally {
    await Promise.all([allowed, denied].map((server) => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    })));
  }
});
