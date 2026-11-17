import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { test } from 'node:test';
import express from 'express';
import { z } from 'zod';
import { createApp } from '../dist/src/app.js';
import { createHttpInfrastructure } from '../dist/src/http/infrastructure.js';
import { createRequestObservability } from '../dist/src/http/request-observability.js';
import { ApplicationError } from '../dist/src/errors/application.error.js';
import { describeHttpError } from '../dist/src/http/error-response.js';
import { createCorsMiddleware } from '../dist/src/middlewares/cors.middleware.js';
import { createRequestValidation } from '../dist/src/middlewares/validate-request.middleware.js';
import { legacyErrorHandler } from '../dist/src/middlewares/legacy-error.middleware.js';

const secret = 'SYNTHETIC_HTTP_SECRET';
const origin = 'https://allowed.example.invalid';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function serve(app, run) {
  const server = app.listen(0, '127.0.0.1');
  try { await once(server, 'listening'); await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
}

async function fixture(register, run, options = {}) {
  const logs = [];
  const http = createHttpInfrastructure({ logger: record => { logs.push(record); }, ...options });
  const app = express(); app.disable('x-powered-by');
  http.protectApplication(app);
  app.use(http.requestContext, http.securityHeaders);
  app.use(createCorsMiddleware(new Set([origin])));
  app.use(http.jsonBody);
  register(app, http);
  app.use(http.notFound, http.errorHandler, http.terminalErrorHandler);
  await serve(app, url => run(url, logs, app));
}

test('application errors map to explicit statuses and ignore arbitrary diagnostic messages', async () => {
  const cases = { VALIDATION_ERROR: 400, RESOURCE_NOT_FOUND: 404, UNAUTHENTICATED: 401,
    FORBIDDEN: 403, CONFLICT: 409, INTERNAL_ERROR: 500, DEPENDENCY_UNAVAILABLE: 503, RATE_LIMITED: 429 };
  await fixture((app, http) => app.get('/error/:kind', http.routeLabel('application'), (req, _res, next) => {
    const error = new ApplicationError(req.params.kind); error.message = secret; next(error);
  }), async url => {
    for (const [kind, status] of Object.entries(cases)) {
      const r = await fetch(`${url}/error/${kind}`); assert.equal(r.status, status);
      assert.ok(!(await r.text()).includes(secret));
    }
  });
});

test('Zod validation maps to 400 without exposing issues or input', async () => {
  const input = createRequestValidation({ body: z.object({ password: z.number() }) });
  await fixture((app, http) => app.post('/probe', http.routeLabel('validation'), input.middleware,
    (_req, res) => res.json({ shouldNotRun: true })), async (url, logs) => {
    const r = await fetch(`${url}/probe`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: secret }) });
    assert.equal(r.status, 400); assert.deepEqual(await r.json(), { error: 'Invalid request' });
    assert.ok(!JSON.stringify(logs).includes(secret));
    assert.ok(!JSON.stringify(logs).includes('password'));
  });
});

test('async Express errors yield safe 500 and correlated structured error logs', async () => {
  await fixture((app, http) => app.get('/failure/:value', http.routeLabel('failure'), async () => {
    throw Object.assign(new Error(secret), { MONGODB_URI: secret, statusCode: 200 });
  }), async (url, logs) => {
    const r = await fetch(`${url}/failure/${secret}?token=${secret}`);
    assert.equal(r.status, 500); assert.deepEqual(await r.json(), { error: 'Internal server error' });
    const id = r.headers.get('x-request-id'); assert.match(id, uuid);
    const error = logs.find(x => x.event === 'request.error');
    assert.equal(error.requestId, id); assert.equal(error.errorCode, 'INTERNAL_ERROR');
    assert.equal(error.route, 'failure'); assert.ok(!JSON.stringify(logs).includes(secret));
  });
});

test('safe fallback 404 does not reflect the requested URL', async () => {
  await fixture(() => {}, async (url, logs) => {
    const r = await fetch(`${url}/${secret}?query=${secret}`);
    assert.equal(r.status, 404); assert.deepEqual(await r.json(), { error: 'Resource not found' });
    assert.ok(!JSON.stringify(logs).includes(secret));
    assert.equal(logs.find(x => x.event === 'request.finish').route, 'unmatched');
  });
});

test('malformed JSON returns controlled 400 without logging the parser body', async () => {
  await fixture(() => {}, async (url, logs) => {
    const r = await fetch(`${url}/probe`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: '{"password":"' + secret });
    assert.equal(r.status, 400); assert.deepEqual(await r.json(), { error: 'Invalid request' });
    assert.ok(!JSON.stringify(logs).includes(secret));
  });
});

test('oversized JSON returns controlled 413 using the configured byte limit', async () => {
  await fixture(() => {}, async (url, logs) => {
    const r = await fetch(`${url}/probe`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: secret.repeat(20) }) });
    assert.equal(r.status, 413); assert.deepEqual(await r.json(), { error: 'Request body too large' });
    assert.ok(!JSON.stringify(logs).includes(secret));
  }, { bodyLimitBytes: 64 });
});

test('body media types and encodings are rejected safely while JSON suffix types work', async () => {
  await fixture((app, http) => app.post('/probe', http.routeLabel('json'), (req, res) => res.json(req.body)), async url => {
    const plain = await fetch(`${url}/probe`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: secret });
    assert.equal(plain.status, 415); assert.ok(!(await plain.text()).includes(secret));
    const encoded = await fetch(`${url}/probe`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, body: '{}' });
    assert.equal(encoded.status, 415);
    const vendor = await fetch(`${url}/probe`, { method: 'POST',
      headers: { 'Content-Type': 'application/example+json' }, body: '{"ok":true}' });
    assert.equal(vendor.status, 200); assert.deepEqual(await vendor.json(), { ok: true });
  });
});

test('JSON limit configuration rejects unsafe values before serving requests', () => {
  for (const limit of [0, -1, 1.5, Infinity, NaN, 1048577]) {
    assert.throws(() => createHttpInfrastructure({ bodyLimitBytes: limit }), TypeError);
  }
});

test('request IDs are unique for concurrent requests and never trust incoming proxy IDs', async () => {
  await fixture((app, http) => app.get('/probe', http.routeLabel('probe'), async (_req, res) => res.json({ ok: true })),
    async (url, logs) => {
      const ids = await Promise.all(Array.from({ length: 12 }, async () => {
        const r = await fetch(`${url}/probe`, { headers: { 'X-Request-ID': secret, 'X-Forwarded-For': secret,
          'X-Forwarded-Proto': 'https', Authorization: secret, Cookie: secret } });
        assert.equal(r.status, 200); await r.text(); return r.headers.get('x-request-id');
      }));
      assert.equal(new Set(ids).size, 12); ids.forEach(id => assert.match(id, uuid));
      for (const id of ids) {
        const rows = logs.filter(x => x.requestId === id);
        assert.equal(rows.filter(x => x.event === 'request.start').length, 1);
        assert.equal(rows.filter(x => x.event === 'request.finish').length, 1);
        assert.equal(rows.find(x => x.event === 'request.finish').status, 200);
        assert.ok(rows.find(x => x.event === 'request.finish').durationMs >= 0);
      }
      assert.ok(!JSON.stringify(logs).includes(secret));
    });
});

test('logging does not capture headers, bodies, params or query strings', async () => {
  await fixture((app, http) => app.post('/probe/:id', http.routeLabel('probe'), (_req, res) => res.json({ ok: true })),
    async (url, logs, app) => {
      const r = await fetch(`${url}/probe/${secret}?MONGODB_URI=${secret}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: secret, Cookie: secret },
        body: JSON.stringify({ password: secret, token: secret }) });
      assert.equal(r.status, 200); await r.text();
      assert.ok(!JSON.stringify(logs).includes(secret)); assert.equal(app.get('trust proxy'), false);
      assert.equal(logs.find(x => x.event === 'request.finish').route, 'probe');
    });
});

test('security headers apply to opt-in successes and errors without enabling CORS credentials', async () => {
  const logs = [];
  const http = createHttpInfrastructure({ logger: row => { logs.push(row); } });
  const app = createApp({ allowedOrigins: new Set([origin]), httpInfrastructure: http });
  await serve(app, async url => {
    for (const endpoint of ['/health', '/missing']) {
      const r = await fetch(url + endpoint, { headers: { Origin: origin } });
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
      assert.equal(r.headers.get('x-powered-by'), null);
      assert.equal(r.headers.get('strict-transport-security'), null);
      assert.equal(r.headers.get('access-control-allow-credentials'), null);
      await r.text();
    }
  });
});

test('CORS rejection and preflight retain their existing semantics in the opt-in profile', async () => {
  await fixture(() => {}, async (url, logs) => {
    const denied = await fetch(`${url}/probe`, { headers: { Origin: 'https://denied.example.invalid' } });
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: 'Origin not allowed by CORS' });
    const preflight = await fetch(`${url}/probe`, { method: 'OPTIONS', headers: { Origin: origin,
      'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Content-Type' } });
    assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
    assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
    assert.equal(logs.filter(x => x.event === 'request.finish').length, 2);
  });
});

test('health stays independent of MongoDB in legacy and opt-in apps', async () => {
  const apps = [createApp(), createApp({ httpInfrastructure: createHttpInfrastructure({ logger: () => {} }) })];
  for (const app of apps) await serve(app, async url => {
    const r = await fetch(`${url}/health`); assert.equal(r.status, 200);
    assert.equal(await r.text(), '{"status":"ok"}');
    const head = await fetch(`${url}/health`, { method: 'HEAD' }); assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  });
});

test('custom response adapters receive only safe descriptors and server request IDs', async () => {
  let received;
  await fixture(app => app.get('/probe', () => { throw new Error(secret); }), async url => {
    const r = await fetch(`${url}/probe`); const body = await r.json();
    assert.equal(body.code, 'INTERNAL_ERROR'); assert.equal(body.id, r.headers.get('x-request-id'));
    assert.deepEqual(Object.keys(received).sort(), ['code', 'message', 'status']);
    assert.ok(!JSON.stringify(body).includes(secret));
  }, { errorResponse: (safe, id) => { received = safe; return { code: safe.code, id }; } });
});

test('throwing, rejecting and unserializable response adapters fall back to safe 500', async () => {
  const circular = {}; circular.self = circular;
  for (const adapter of [() => { throw new Error(secret); }, async () => { throw secret; }, () => circular,
    () => undefined, () => ({ toJSON() { throw new Error(secret); } })]) {
    await fixture(app => app.get('/probe', (_req, _res, next) => next(new ApplicationError('CONFLICT'))), async url => {
      const r = await fetch(`${url}/probe`); assert.equal(r.status, 500);
      assert.deepEqual(await r.json(), { error: 'Internal server error' });
    }, { errorResponse: adapter });
  }
});

test('logger failures do not affect the response or become unhandled rejections', async () => {
  for (const logger of [() => { throw new Error(secret); }, async () => { throw new Error(secret); }]) {
    await fixture(app => app.get('/probe', (_req, res) => res.json({ ok: true })), async url => {
      const r = await fetch(`${url}/probe`); assert.equal(r.status, 200); await r.text();
      await new Promise(resolve => setImmediate(resolve));
    }, { logger });
  }
});

test('the default logger emits JSON records using only the projected fields', async t => {
  const rows = [];
  t.mock.method(console, 'info', text => { rows.push(JSON.parse(text)); });
  const app = createApp({ httpInfrastructure: createHttpInfrastructure() });
  await serve(app, async url => { const r = await fetch(`${url}/health?token=${secret}`); await r.text(); });
  assert.equal(rows.length, 2); assert.ok(!JSON.stringify(rows).includes(secret));
  assert.equal(rows[1].route, 'health'); assert.equal(rows[1].outcome, 'finished');
});

test('headers-sent errors forward a sanitized error and do not attempt a second response', async () => {
  const rows = [];
  const http = createHttpInfrastructure({ logger: row => { rows.push(row); } });
  const req = { method: 'GET' }; const response = { headersSent: true };
  let forwarded;
  await http.errorHandler(new Error(secret), req, response, error => { forwarded = error; });
  assert.ok(forwarded instanceof Error); assert.ok(!String(forwarded.stack).includes(secret));
  assert.equal(forwarded.statusCode, 500); assert.equal(rows.length, 1);
});

test('unknown diagnostics and hostile error getters are never trusted as public status or content', () => {
  for (const error of [secret, { statusCode: 400, message: secret },
    new Proxy({}, { get() { throw new Error(secret); } })]) {
    const safe = describeHttpError(error); assert.equal(safe.status, 500);
    assert.deepEqual(Object.keys(safe).sort(), ['code', 'message', 'status']);
    assert.ok(!JSON.stringify(safe).includes(secret));
  }
});

test('route labels are configured safe identifiers, never raw URL templates or input', () => {
  const observer = createRequestObservability(() => {});
  for (const label of ['/probe/:id', 'name?token=value', 'bad\nlabel', 'x'.repeat(65)]) {
    assert.throws(() => observer.routeLabel(label), TypeError);
  }
});

test('aborted responses log completion once and unknown methods never become log input', () => {
  const rows = [];
  const observer = createRequestObservability(row => { rows.push(row); });
  const response = new EventEmitter();
  response.headersSent = false;
  response.writableFinished = false;
  response.statusCode = 200;
  const headers = {};
  response.setHeader = (key, value) => { headers[key] = value; };
  const req = { method: secret, originalUrl: secret, headers: { authorization: secret } };
  observer.middleware(req, response, () => {});
  observer.routeLabel('probe')(req, response, () => {});
  response.emit('close'); response.emit('finish'); response.emit('close');
  assert.match(headers['X-Request-ID'], uuid);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].event, 'request.finish');
  assert.equal(rows[1].outcome, 'aborted');
  assert.equal(rows[1].method, 'OTHER');
  assert.ok(!JSON.stringify(rows).includes(secret));
});

test('legacy error boundary rejects invalid status values and hostile getters without exposing stacks', async t => {
  t.mock.method(console, 'error', () => {});
  const errors = [0, 200, 99999, NaN, '500', null, Infinity].map(statusCode => ({ statusCode, private: secret }));
  errors.push(new Proxy({}, { has() { throw new Error(secret); } }));
  errors.push({ get statusCode() { throw new Error(secret); } });
  for (const failure of errors) {
    const app = express(); app.get('/probe', (_req, _res, next) => next(failure)); app.use(legacyErrorHandler);
    await serve(app, async url => {
      const r = await fetch(`${url}/probe`); assert.equal(r.status, 500);
      assert.deepEqual(await r.json(), { error: 'Internal server error' });
    });
  }
  for (const failure of [null, undefined, false]) {
    let body;
    const response = { setHeader() {}, status(status) { assert.equal(status, 500); return this; }, json(value) { body = value; } };
    legacyErrorHandler(failure, {}, response, () => assert.fail('unexpected delegation'));
    assert.deepEqual(body, { error: 'Internal server error' });
  }
});

test('legacy logger failures cannot turn safe HTTP errors into finalhandler stack responses', async t => {
  for (const logger of [() => { throw new Error(secret); }, async () => { throw new Error(secret); }]) {
    const mock = t.mock.method(console, 'error', logger);
    const app = express(); app.get('/probe', async () => { throw new Error(secret); }); app.use(legacyErrorHandler);
    await serve(app, async url => {
      const r = await fetch(`${url}/probe`); assert.equal(r.status, 500);
      assert.deepEqual(await r.json(), { error: 'Internal server error' });
      await new Promise(resolve => setImmediate(resolve));
    });
    mock.mock.restore();
  }
});

test('legacy errors after headers are sent delegate only a safe error without a second response', t => {
  t.mock.method(console, 'error', () => {});
  let forwarded;
  legacyErrorHandler(new Error(secret), {}, { headersSent: true }, error => { forwarded = error; });
  assert.equal(forwarded.statusCode, 500);
  assert.equal(forwarded.message, 'Internal server error');
  assert.ok(!String(forwarded.stack).includes(secret));
});

test('async response adapters recheck headers before writing and delegate a sanitized error', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const logs = [];
  const http = createHttpInfrastructure({ logger: row => { logs.push(row); },
    errorResponse: async () => { await pending; return { error: 'Internal server error' }; } });
  const response = { headersSent: false, setHeader() {}, status() { assert.fail('second response'); } };
  let forwarded;
  const processing = http.errorHandler(new Error(secret), { method: 'GET' }, response, error => { forwarded = error; });
  response.headersSent = true; release(); await processing;
  assert.equal(forwarded.statusCode, 500); assert.ok(!String(forwarded.stack).includes(secret));
  assert.equal(logs.length, 1); assert.ok(!JSON.stringify(logs).includes(secret));
});

test('the default JSON limit accepts exactly 16 KiB and rejects one extra byte', async () => {
  await fixture(app => app.post('/probe', (_req, res) => res.json({ ok: true })), async url => {
    const overhead = Buffer.byteLength(JSON.stringify({ value: '' }));
    for (const [size, status] of [[16384, 200], [16385, 413]]) {
      const body = JSON.stringify({ value: 'x'.repeat(size - overhead) });
      assert.equal(Buffer.byteLength(body), size);
      const r = await fetch(`${url}/probe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      assert.equal(r.status, status); await r.text();
    }
  });
});

test('strict JSON rejects primitives, permits containers and does not require media type for empty bodies', async () => {
  await fixture(app => app.post('/probe', (_req, res) => res.json({ ok: true })), async url => {
    for (const body of ['null', 'false', '42', JSON.stringify(secret)]) {
      const r = await fetch(`${url}/probe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      assert.equal(r.status, 400); assert.deepEqual(await r.json(), { error: 'Invalid request' });
    }
    for (const body of ['{}', '[]']) {
      const r = await fetch(`${url}/probe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      assert.equal(r.status, 200); await r.text();
    }
    for (const headers of [{}, { 'Content-Type': 'text/plain' }]) {
      const r = await fetch(`${url}/probe`, { method: 'POST', headers });
      assert.equal(r.status, 200); await r.text();
    }
    const charset = await fetch(`${url}/probe`, { method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=iso-8859-1' }, body: '{}' });
    assert.equal(charset.status, 415); await charset.text();
  });
});

test('CORS rejects before parsing and both early and route failures retain security headers and IDs', async () => {
  await fixture(app => app.get('/probe', async () => { throw new Error(secret); }), async (url, logs) => {
    for (const [headers, status] of [
      [{ Origin: 'https://denied.example.invalid', 'Content-Type': 'application/json' }, 403],
      [{ Origin: origin, 'Content-Type': 'application/json' }, 400],
    ]) {
      const r = await fetch(`${url}/probe`, { method: 'POST', headers, body: '{' + secret });
      assert.equal(r.status, status); assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.match(r.headers.get('x-request-id'), uuid); await r.text();
    }
    const r = await fetch(`${url}/probe`); assert.equal(r.status, 500);
    assert.equal(r.headers.get('cache-control'), 'no-store'); await r.text();
    assert.ok(!JSON.stringify(logs).includes(secret));
    assert.equal(logs.filter(row => row.event === 'request.error').length, 3);
  });
});

test('untrusted request ID header shapes are ignored rather than reflected or logged', async () => {
  await fixture(app => app.get('/probe', (_req, res) => res.json({ ok: true })), async (url, logs) => {
    const ids = [];
    for (const incoming of ['', secret, secret.repeat(80), '../../private?token=' + secret, 'one, two']) {
      const r = await fetch(`${url}/probe`, { headers: { 'X-Request-ID': incoming,
        'X-Correlation-ID': secret, Authorization: 'Bearer ' + secret, Cookie: 'session=' + secret } });
      assert.equal(r.status, 200); const id = r.headers.get('x-request-id');
      assert.match(id, uuid); assert.notEqual(id, incoming); ids.push(id); await r.text();
    }
    assert.equal(new Set(ids).size, ids.length); assert.ok(!JSON.stringify(logs).includes(secret));
  });
});
