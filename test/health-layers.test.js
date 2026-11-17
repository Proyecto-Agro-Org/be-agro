import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import express from 'express';

import { getHealthStatus } from '../dist/src/services/health.service.js';
import { createHealthRouter } from '../dist/src/routes/health.routes.js';
import { legacyErrorHandler } from '../dist/src/middlewares/legacy-error.middleware.js';

async function withServer(app, run) {
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test('health service runs without HTTP or persistence and returns independent results', () => {
  const first = getHealthStatus();
  assert.deepEqual(first, { status: 'ok' });
  first.status = 'changed by a caller';
  assert.deepEqual(getHealthStatus(), { status: 'ok' });
});

test('health router works mounted independently and preserves GET/HEAD and method boundaries', async () => {
  const app = express();
  app.use('/probe', createHealthRouter());
  await withServer(app, async (url) => {
    const get = await fetch(`${url}/probe/health`);
    assert.equal(get.status, 200);
    assert.deepEqual(await get.json(), { status: 'ok' });
    const head = await fetch(`${url}/probe/health`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.equal((await fetch(`${url}/health`)).status, 404);
    assert.equal((await fetch(`${url}/probe/health`, { method: 'POST' })).status, 404);
  });
});

test('extracted legacy middleware receives Express 5 async errors and conceals diagnostics', async (t) => {
  const app = express();
  const failure = new Error('Synthetic private diagnostic');
  const diagnostic = t.mock.method(console, 'error', () => {});
  // Only this isolated test app contains a synthetic failure route.
  app.get('/failure', async () => { throw failure; });
  app.use(legacyErrorHandler);
  await withServer(app, async (url) => {
    const response = await fetch(`${url}/failure`);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'Internal server error' });
    assert.equal(diagnostic.mock.callCount(), 1);
    assert.equal(diagnostic.mock.calls[0].arguments[0], failure);
  });
});
