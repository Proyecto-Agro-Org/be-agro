import assert from 'node:assert/strict';
import { once } from 'node:events';
import { inspect } from 'node:util';
import { test } from 'node:test';
import { request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';
import { EventEmitter } from 'node:events';
import express from 'express';
import { z } from 'zod';
import { createApp } from '../dist/src/app.js';
import { createRequestObservability } from '../dist/src/http/request-observability.js';
import { createHttpInfrastructure } from '../dist/src/http/infrastructure.js';
import { legacyErrorHandler, createLegacyErrorHandler } from '../dist/src/middlewares/legacy-error.middleware.js';
import { createRequestValidation } from '../dist/src/middlewares/validate-request.middleware.js';
import { terminalErrorHandler } from '../dist/src/middlewares/terminal-error.middleware.js';
import { describeHttpError } from '../dist/src/http/error-response.js';
import { ApplicationError } from '../dist/src/errors/application.error.js';
import { protectApplication } from '../dist/src/http/protect-application.js';

const secrets = ['TEST_SECRET_AUTHORIZATION_123', 'TEST_SECRET_COOKIE_456',
  'TEST_SECRET_PASSWORD_789', 'TEST_SECRET_MONGO_URI_ABC', 'TEST_SECRET_QUERY_DEF'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function noSecrets(value) {
  const rendered = typeof value === 'string' ? value : inspect(value, { depth: 12, showHidden: true });
  for (const secret of secrets) assert.ok(!rendered.includes(secret), 'sensitive marker reached output');
}
async function serve(app, run) {
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { return await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
}

test('legacy logger receives only a safe primitive projection, never the original exception', async t => {
  const failure = Object.assign(new Error(secrets[0], { cause: { password: secrets[2] } }), {
    Authorization: secrets[0], Cookie: secrets[1], MONGODB_URI: secrets[3], request: { url: secrets[4] },
  });
  Object.defineProperty(failure, 'hidden', { value: secrets[2] });
  const records = []; t.mock.method(console, 'error', (...args) => { records.push(args); });
  class BrokenOrigins extends Set { has() { throw failure; } }
  await serve(createApp({ allowedOrigins: new BrokenOrigins() }), async url => {
    const r = await fetch(`${url}/health?token=${secrets[4]}`, { headers: {
      Origin: 'https://audit.invalid', Authorization: secrets[0], Cookie: secrets[1], 'X-Request-ID': secrets[2],
    } });
    assert.equal(r.status, 500); noSecrets(await r.text());
    const row = JSON.parse(records[0][0]); assert.equal(row.event, 'request.error');
    assert.equal(row.requestId, r.headers.get('x-request-id')); assert.match(row.requestId, uuid);
  });
  assert.equal(records.length, 1); noSecrets(records); assert.notEqual(records[0][0], failure);
  assert.equal(failure.message, secrets[0]); // Do not sanitize by mutating the caller's error.
});

test('default 404 and unsupported methods never reflect path, query or client IDs', async () => {
  await serve(createApp(), async url => {
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      const r = await fetch(`${url}/${secrets[2]}?token=${secrets[4]}`, { method,
        headers: { 'X-Request-ID': secrets[0], Authorization: secrets[0], Cookie: secrets[1] } });
      assert.equal(r.status, 404); assert.match(r.headers.get('content-type'), /text\/html/);
      assert.match(r.headers.get('x-request-id'), uuid); noSecrets(await r.text());
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    }
  });
});

test('logger runtime boundary drops object values and unknown properties before calling its sink', () => {
  const rows = []; const observer = createRequestObservability(row => { rows.push(row); });
  const unsafe = { password: secrets[2], toString() { return 'INTERNAL_ERROR'; } };
  const response = { headersSent: false, setHeader() {} };
  observer.logError({ method: unsafe, headers: { authorization: secrets[0] } }, response, unsafe, unsafe);
  assert.equal(rows.length, 1); noSecrets(rows); assert.equal(rows[0].method, 'OTHER');
  assert.equal(rows[0].status, 500); assert.equal(rows[0].errorCode, 'INTERNAL_ERROR');
  assert.deepEqual(Object.keys(rows[0]).sort(), ['errorCode', 'event', 'method', 'requestId', 'route', 'status', 'timestamp']);
  assert.ok(Object.isFrozen(rows[0]));
});

test('route labels reject object coercion instead of storing arbitrary objects in logs', () => {
  const observer = createRequestObservability(() => {});
  assert.throws(() => observer.routeLabel({ password: secrets[2], toString() { return 'valid'; } }), TypeError);
});

function fixture(register, logger = () => {}) {
  const http = createHttpInfrastructure({ logger });
  const app = express(); app.disable('x-powered-by');
  http.protectApplication(app);
  app.use(http.requestContext, http.securityHeaders, http.jsonBody);
  register(app, http);
  app.use(http.notFound, http.errorHandler, http.terminalErrorHandler);
  return app;
}

test('external legacy logging callbacks receive a closed immutable DTO and no error references', async () => {
  const rows = []; const observer = createRequestObservability(row => { rows.push(row); });
  const app = express(); app.use(observer.contextMiddleware);
  const error = new Error(secrets[0], { cause: { nested: { token: secrets[1] } } });
  app.get('/probe', async () => { throw error; });
  app.use(createLegacyErrorHandler(observer), terminalErrorHandler);
  await serve(app, async url => {
    const r = await fetch(`${url}/probe?token=${secrets[4]}`); assert.equal(r.status, 500);
    noSecrets(await r.text()); assert.equal(rows[0].requestId, r.headers.get('x-request-id'));
  });
  assert.equal(rows.length, 1); noSecrets(rows);
  assert.ok(Object.isFrozen(rows[0])); assert.ok(!Object.values(rows[0]).includes(error));
  assert.ok(Object.values(rows[0]).every(value => ['string', 'number'].includes(typeof value)));
});

test('strings, arbitrary objects, nested causes and middleware/controller failures remain safe', async () => {
  const rows = [];
  const failures = [secrets[0], { message: secrets[1], stack: secrets[2], statusCode: 200 },
    new Error(secrets[0], { cause: new Error(secrets[3]) }), Object.assign(Object.create(null), { token: secrets[2] })];
  const app = fixture((app, http) => {
    app.use('/early', () => { throw failures[0]; });
    app.get('/probe/:index', http.routeLabel('probe'), async req => { throw failures[Number(req.params.index)]; });
    app.get('/dependency', () => { throw new ApplicationError('DEPENDENCY_UNAVAILABLE'); });
  }, row => { rows.push(row); });
  await serve(app, async url => {
    for (const path of ['/early', ...failures.map((_, i) => '/probe/' + i), '/dependency']) {
      const r = await fetch(url + path); assert.equal(r.status, path === '/dependency' ? 503 : 500);
      noSecrets(await r.text());
    }
  });
  noSecrets(rows); assert.equal(rows.filter(row => row.event === 'request.error').length, 6);
});

test('unknown parser error types are not coerced or allowed to execute custom conversion code', () => {
  let coerced = false;
  const type = { toString() { coerced = true; return 'charset.unsupported'; } };
  assert.equal(describeHttpError({ type, status: 415 }).status, 500);
  assert.equal(coerced, false);
});

test('a slow logger never holds the HTTP response or request lifecycle open', async () => {
  const deferred = Promise.withResolvers(); const rows = [];
  const app = fixture(app => app.get('/probe', (_req, res) => res.json({ ok: true })), row => {
    rows.push(row); return deferred.promise;
  });
  try {
    await serve(app, async url => {
      const r = await fetch(`${url}/probe`); assert.equal(r.status, 200); await r.text();
      assert.equal(rows.filter(row => row.event === 'request.finish').length, 1);
    });
  } finally { deferred.resolve(); }
  noSecrets(rows);
});

test('concurrent async body/params/query validation and errors keep request IDs and outputs isolated', async () => {
  const allEntered = Promise.withResolvers(); const release = Promise.withResolvers(); let entered = 0;
  const input = createRequestValidation({
    body: z.object({ value: z.coerce.number().int().refine(async value => {
      if (++entered === 12) allEntered.resolve(); await release.promise; return value % 3 !== 0;
    }), password: z.string().transform(() => 'redacted') }),
    params: z.object({ index: z.coerce.number().int() }),
    query: z.object({ page: z.coerce.number().int() }),
  });
  const rows = [];
  const app = fixture((app, http) => app.post('/probe/:index', http.routeLabel('probe'), input.middleware,
    (req, res) => { const data = input.getValidatedData(req);
      if (data.body.value % 2 === 0) throw new Error(secrets[0]);
      res.json({ value: data.body.value, index: data.params.index, page: data.query.page });
    }), row => { rows.push(row); });
  await serve(app, async url => {
    const pending = Array.from({ length: 12 }, (_, index) => fetch(`${url}/probe/${index + 1}?page=${index + 1}&token=${secrets[4]}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: secrets[0], Cookie: secrets[1] },
      body: JSON.stringify({ value: String(index + 1), password: secrets[2] }),
    }));
    await allEntered.promise; release.resolve();
    const responses = await Promise.all(pending); const ids = [];
    for (let index = 0; index < responses.length; index++) {
      const value = index + 1, r = responses[index];
      assert.equal(r.status, value % 3 === 0 ? 400 : value % 2 === 0 ? 500 : 200);
      const body = await r.json(); noSecrets(body);
      if (r.status === 200) assert.deepEqual(body, { value, index: value, page: value });
      ids.push(r.headers.get('x-request-id'));
    }
    assert.equal(new Set(ids).size, 12);
    for (const id of ids) {
      assert.match(id, uuid); const correlated = rows.filter(row => row.requestId === id);
      assert.equal(correlated.filter(row => row.event === 'request.start').length, 1);
      assert.equal(correlated.filter(row => row.event === 'request.finish').length, 1);
    }
  });
  noSecrets(rows);
});

test('a real aborted request cannot be revived by a late async error', { timeout: 5000 }, async () => {
  const entered = Promise.withResolvers(), closed = Promise.withResolvers(), release = Promise.withResolvers();
  const rows = [];
  const app = fixture(app => app.get('/probe', async (_req, res) => {
    res.once('close', () => closed.resolve()); entered.resolve(); await release.promise;
    throw new Error(secrets[2]);
  }), row => { rows.push(row); });
  await serve(app, async url => {
    const client = httpRequest(`${url}/probe`); client.on('error', () => {}); client.end();
    await entered.promise; client.destroy(); await closed.promise;
    release.resolve(); await new Promise(resolve => setImmediate(resolve));
  });
  assert.equal(rows.filter(row => row.event === 'request.finish').length, 1);
  assert.equal(rows.find(row => row.event === 'request.finish').outcome, 'aborted'); noSecrets(rows);
});

test('post-header failures terminate safely in both compositions without raw Express finalhandler logs', { timeout: 5000 }, async t => {
  const consoleRows = []; t.mock.method(console, 'error', (...args) => { consoleRows.push(args); });
  for (const secure of [false, true]) {
    const rows = []; const http = createHttpInfrastructure({ logger: row => { rows.push(row); } });
    const app = express(); if (secure) app.use(http.requestContext);
    app.get('/probe', (_req, res, next) => { res.write('safe-prefix'); next(new Error(secrets[0])); });
    app.use(secure ? http.errorHandler : legacyErrorHandler, terminalErrorHandler);
    await serve(app, url => new Promise(resolve => {
      const client = httpRequest(`${url}/probe`, res => {
        res.on('data', chunk => noSecrets(chunk.toString())); res.on('error', () => {}); res.on('close', resolve);
      }); client.on('error', resolve); client.end();
    }));
    noSecrets(rows);
  }
  noSecrets(consoleRows);
  for (const args of consoleRows) {
    assert.equal(args.length, 1); const row = JSON.parse(args[0]); assert.equal(row.event, 'request.error');
  }
});

test('concurrent error propagation sends at most one response and drops late closed responses', async () => {
  const release = Promise.withResolvers(); let sends = 0; const rows = [];
  const http = createHttpInfrastructure({ logger: row => { rows.push(row); },
    errorResponse: async () => { await release.promise; return { error: 'Internal server error' }; } });
  const res = { headersSent: false, writableEnded: false, destroyed: false, setHeader() {},
    status() { return this; }, type() { return this; }, send() { sends++; this.writableEnded = true; this.headersSent = true; } };
  const req = { method: 'GET' };
  const one = http.errorHandler(new Error(secrets[0]), req, res, () => assert.fail('unexpected delegation'));
  const two = http.errorHandler(new Error(secrets[1]), req, res, () => assert.fail('unexpected delegation'));
  release.resolve(); await Promise.all([one, two]); assert.equal(sends, 1);
  await http.errorHandler(new Error(secrets[2]), req, { destroyed: true, headersSent: false }, () => assert.fail());
  assert.equal(sends, 1); noSecrets(rows);
});

test('finish logs sanitize runtime status values and route labels reject control characters and Unicode', () => {
  const rows = []; const observer = createRequestObservability(row => { rows.push(row); });
  const res = new EventEmitter(); res.setHeader = () => {}; res.writableFinished = true;
  res.statusCode = { password: secrets[2] };
  observer.middleware({ method: 'GET' }, res, () => {}); res.emit('finish');
  assert.equal(rows[1].status, 500); noSecrets(rows);
  for (const label of ['bad\r\nlabel', '\u0000', 'temperatura-ñ', '']) assert.throws(() => observer.routeLabel(label), TypeError);
});

test('chunked JSON without Content-Length still respects parsing and the configured size limit', async () => {
  const app = fixture(app => app.post('/probe', (_req, res) => res.json({ ok: true })));
  await serve(app, async url => {
    for (const [body, status] of [['{}', 200], [JSON.stringify({ value: 'x'.repeat(17000) }), 413]]) {
      const observed = await new Promise((resolve, reject) => {
        const client = httpRequest(`${url}/probe`, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
          let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, text })); res.on('error', reject);
        }); client.on('error', reject); client.write(body.slice(0, 1)); client.end(body.slice(1));
      });
      assert.equal(observed.status, status); noSecrets(observed.text);
    }
  });
});

test('invalid HTTP framing and unknown methods are rejected without exposing the input', { timeout: 5000 }, async () => {
  for (const app of [createApp(), fixture(() => {})]) await serve(app, async url => {
    const port = Number(new URL(url).port);
    for (const request of [
      `POST / HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 50\r\nConnection: close\r\n\r\n{}`,
      `POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\nContent-Length: 3\r\n\r\n{}`,
      `POST / HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{"password":"${secrets[2]}"}`,
      `UNRECOGNIZED /${secrets[2]} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`,
    ]) {
      const result = await new Promise((resolve, reject) => {
        const socket = createConnection({ host: '127.0.0.1', port }); let data = '';
        socket.setEncoding('utf8'); socket.on('data', chunk => { data += chunk; });
        socket.on('connect', () => socket.end(request)); socket.on('error', reject); socket.on('close', () => resolve(data));
      });
      noSecrets(result); assert.ok(result === '' || /^HTTP\/1\.1 (?:400|404)/.test(result));
    }
  });
});

test('bounded nested JSON, Unicode and extreme numbers cannot enter diagnostics', async () => {
  const rows = [];
  const app = fixture((app, http) => app.post('/probe', http.routeLabel('probe'), () => { throw new Error(secrets[0]); }),
    row => { rows.push(row); });
  let nested = { password: secrets[2] }; for (let i = 0; i < 128; i++) nested = { nested };
  await serve(app, async url => {
    for (const body of [JSON.stringify(nested), '{"n":1e9999}', JSON.stringify({ unicode: '🌱\u0000\n', values: [null, [], {}] })]) {
      const r = await fetch(`${url}/probe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      assert.equal(r.status, 500); noSecrets(await r.text());
    }
  });
  noSecrets(rows);
});

test('repeated late next(error) calls cannot escape into the framework raw logger', async t => {
  const consoleRows = []; t.mock.method(console, 'error', (...args) => { consoleRows.push(args); });
  for (const secure of [false, true]) {
    const release = Promise.withResolvers(), propagated = Promise.withResolvers(); const rows = [];
    const logger = row => { rows.push(row); };
    const register = app => app.get('/probe', (_req, _res, next) => {
      next(new Error('safe initial failure'));
      release.promise.then(() => {
        for (const secret of secrets) next(new Error(secret));
        propagated.resolve();
      });
    });
    let app;
    if (secure) app = fixture(register, logger);
    else {
      app = express(); const observer = createRequestObservability(logger);
      protectApplication(app, observer); app.use(observer.contextMiddleware); register(app);
      app.use(createLegacyErrorHandler(observer), terminalErrorHandler);
    }
    await serve(app, async url => {
      const r = await fetch(`${url}/probe`); assert.equal(r.status, 500); noSecrets(await r.text());
      release.resolve(); await propagated.promise;
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
    });
    noSecrets(rows);
  }
  noSecrets(consoleRows);
  assert.equal(consoleRows.length, 0); // The injected sink owns diagnostics, never Express console.error.
});

test('dispatch protection validates the integration and sanitizes external embedding callbacks', () => {
  const rows = [], observer = createRequestObservability(row => { rows.push(row); });
  assert.throws(() => protectApplication({}, observer), TypeError);
  const original = new Error(secrets[0], { cause: secrets[2] });
  const app = { handle(_req, _res, done) { done(original); } };
  protectApplication(app, observer);
  let received;
  app.handle({ method: 'GET' }, { headersSent: false, setHeader() {} }, error => { received = error; });
  assert.notEqual(received, original); assert.equal(received.code, 'INTERNAL_ERROR'); noSecrets(received); noSecrets(rows);
  const passthrough = { handle(_req, _res, done) { done(); } }; protectApplication(passthrough, observer);
  passthrough.handle({}, {}, error => { assert.equal(error, undefined); });
});
