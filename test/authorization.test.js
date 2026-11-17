import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { inspect } from 'node:util';
import { test } from 'node:test';
import express from 'express';
import ts from 'typescript';
import path from 'node:path';
import { createAuthorizationService } from '../dist/src/services/authorization.service.js';
import { createRequestAuthorization } from '../dist/src/middlewares/request-authorization.middleware.js';
import { createHttpInfrastructure } from '../dist/src/http/infrastructure.js';
import { createApp } from '../dist/src/app.js';
import { ApplicationError } from '../dist/src/errors/application.error.js';

const credentialA = 'TEST_CREDENTIAL_A', credentialB = 'TEST_CREDENTIAL_B';
const secret = 'TEST_PRIVATE_DIAGNOSTIC';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const code = expected => error => error instanceof ApplicationError && error.code === expected &&
  !inspect(error, { showHidden: true }).includes(secret);

// All identity/session/resource fakes are confined to this test module.
function fixture() {
  let clock = 1000;
  const calls = { verification: [], identity: [], membership: [], session: [], resources: [] };
  const state = { activeUser: true, activeClient: true, hasUser: true, hasClient: true, session: 'active', throwSession: false };
  const ports = {
    verifier: { async verify(value) {
      calls.verification.push(value);
      if (![credentialA, credentialB].includes(value)) return { status: 'invalid' };
      return { status: 'verified', subject: value === credentialA ? 'subject-a' : 'subject-b',
        sessionReference: value === credentialA ? 'session-a' : 'session-b', expiresAt: 10000 };
    } },
    identities: { async resolve(principal) {
      calls.identity.push(principal);
      return state.hasUser ? { userId: principal.subject === 'subject-a' ? 'user-a' : 'user-b', active: state.activeUser } : null;
    } },
    memberships: { async resolve(userId) {
      calls.membership.push(userId);
      return state.hasClient ? { clientId: userId === 'user-a' ? 'client-a' : 'client-b', active: state.activeClient } : null;
    } },
    sessions: { async inspect(reference) {
      calls.session.push(reference);
      if (state.throwSession) throw new Error(secret, { cause: credentialA });
      return state.session === 'active' ? { status: 'active', expiresAt: 9000 } : { status: state.session };
    }, async revoke() { state.session = 'revoked'; } },
  };
  const records = ['a', 'b'].flatMap(suffix => [
    { kind: 'field', id: 'field-' + suffix, clientId: 'client-' + suffix },
    { kind: 'area', id: 'area-' + suffix, clientId: 'client-' + suffix, fieldId: 'field-' + suffix },
    { kind: 'device', id: 'device-' + suffix, clientId: 'client-' + suffix, fieldId: 'field-' + suffix, areaId: 'area-' + suffix },
    { kind: 'measurement', id: 'measurement-' + suffix, clientId: 'client-' + suffix,
      fieldId: 'field-' + suffix, areaId: 'area-' + suffix, deviceId: 'device-' + suffix },
  ]);
  const resources = { async findResource(query) {
    calls.resources.push(query);
    const record = records.find(row => Object.entries(query).every(([key, value]) => row[key] === value));
    return record ? { ...record } : null;
  } };
  const makeService = () => createAuthorizationService(ports, { source: 'test-authority', now: () => clock });
  return { ports, resources, calls, records, state, makeService, now: value => { clock = value; } };
}

function request(credential = credentialA) {
  return { method: 'GET', headers: credential === null ? {} : { authorization: 'Bearer ' + credential },
    rawHeaders: credential === null ? [] : ['Authorization', 'Bearer ' + credential] };
}
function response() {
  const res = new EventEmitter(); res.headersSent = false; res.writableEnded = false; res.destroyed = false;
  res.setHeader = () => {};
  return res;
}
async function run(middleware, req, res = response()) {
  return new Promise((resolve, reject) => {
    let called = false;
    Promise.resolve(middleware(req, res, error => {
      if (called) reject(new Error('next called twice'));
      called = true; resolve(error);
    })).catch(reject);
  });
}
async function authenticated(f = fixture(), credential = credentialA) {
  const service = f.makeService(), identity = await service.authenticate(credential);
  const context = await service.authorize(identity);
  return { f, service, identity, context, repository: service.createScopedRepository(context, f.resources) };
}
async function serve(app, check) {
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { return await check(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
function httpFixture(f) {
  const rows = [], service = f.makeService(), auth = createRequestAuthorization(service);
  const http = createHttpInfrastructure({ logger: row => { rows.push(row); } });
  const app = express(); app.disable('x-powered-by'); http.protectApplication(app);
  app.use(http.requestContext, http.securityHeaders, http.jsonBody);
  app.get('/probe/:id', http.routeLabel('authorizationProbe'), auth.authenticate, auth.requireClient, async (req, res) => {
    const repository = service.createScopedRepository(auth.getAuthorizationContext(req), f.resources);
    const resource = await repository.getField(req.params.id);
    res.json({ id: resource.id });
  });
  app.use(http.notFound, http.errorHandler, http.terminalErrorHandler);
  return { app, service, auth, rows };
}

test('verified identity and authorized context are distinct, immutable, and exclude credentials', async () => {
  const { f, identity, context } = await authenticated();
  assert.deepEqual(Object.keys(identity).sort(), ['authenticatedAt', 'expiresAt', 'source', 'userId']);
  assert.equal(identity.userId, 'user-a'); assert.equal(context.clientId, 'client-a');
  assert.equal(identity.expiresAt, 9000); assert.ok(Object.isFrozen(identity)); assert.ok(Object.isFrozen(context));
  assert.ok(!inspect(context).includes(credentialA));
  assert.deepEqual(f.calls.identity[0], { source: 'test-authority', subject: 'subject-a' });
  assert.deepEqual(f.calls.session[0], { source: 'test-authority', reference: 'session-a' });
});

test('invalid credentials and oversized/non-string inputs never mint an identity', async () => {
  const f = fixture(), service = f.makeService();
  for (const value of [null, undefined, {}, '', ' bad', 'bad token', 'x'.repeat(8193)]) {
    await assert.rejects(service.authenticate(value), code('UNAUTHENTICATED'));
  }
  assert.equal(f.calls.verification.length, 0);
  await assert.rejects(service.authenticate('unrecognized'), code('UNAUTHENTICATED'));
  assert.equal(f.calls.identity.length, 0);
});

test('configuration requires all explicit server ports and bounded source/credential settings', () => {
  const f = fixture();
  for (const ports of [{}, { ...f.ports, verifier: {} }, { ...f.ports, sessions: { inspect() {} } }]) {
    assert.throws(() => createAuthorizationService(ports, { source: 'test' }), TypeError);
  }
  for (const options of [{ source: '' }, { source: 'bad\nsource' }, { source: 'ok', maxCredentialLength: 0 },
    { source: 'ok', maxCredentialLength: Infinity }]) assert.throws(() => createAuthorizationService(f.ports, options), TypeError);
});

test('plain objects, copied identities and identities from another instance are rejected at runtime', async () => {
  const { f, service, identity } = await authenticated();
  for (const value of [{ userId: 'user-a', source: 'test-authority', expiresAt: 99999 }, { ...identity }, JSON.parse(JSON.stringify(identity)), null]) {
    await assert.rejects(service.authorize(value), code('UNAUTHENTICATED'));
  }
  await assert.rejects(f.makeService().authorize(identity), code('UNAUTHENTICATED'));
});

test('forged, copied and foreign authorization contexts cannot bind a repository', async () => {
  const { f, service, context } = await authenticated();
  for (const value of [{ ...context }, { identity: context.identity, clientId: 'client-b' }, null]) {
    assert.throws(() => service.createScopedRepository(value, f.resources), code('FORBIDDEN'));
  }
  assert.throws(() => f.makeService().createScopedRepository(context, f.resources), code('FORBIDDEN'));
});

test('expired, revoked and missing simulated sessions fail before identity lookup', async () => {
  for (const state of ['expired', 'revoked', 'missing']) {
    const f = fixture(); f.state.session = state;
    await assert.rejects(f.makeService().authenticate(credentialA), code('UNAUTHENTICATED'));
    assert.equal(f.calls.identity.length, 0);
  }
  const f = fixture(); f.now(10000);
  await assert.rejects(f.makeService().authenticate(credentialA), code('UNAUTHENTICATED'));
});

test('inactive or unknown local users are forbidden rather than assigned a default client', async () => {
  for (const state of [{ hasUser: false }, { activeUser: false }]) {
    const f = fixture(); Object.assign(f.state, state);
    await assert.rejects(f.makeService().authenticate(credentialA), code('FORBIDDEN'));
    assert.equal(f.calls.membership.length, 0);
  }
});

test('an authenticated user without an active membership remains unauthorized', async () => {
  for (const state of [{ hasClient: false }, { activeClient: false }]) {
    const f = fixture(); Object.assign(f.state, state); const service = f.makeService();
    const identity = await service.authenticate(credentialA);
    await assert.rejects(service.authorize(identity), code('FORBIDDEN')); service.assertIdentity(identity);
  }
});

test('provider, identity, membership and session failures discard diagnostics and become safe dependency errors', async () => {
  for (const [part, method] of [['verifier', 'verify'], ['identities', 'resolve'], ['sessions', 'inspect'], ['memberships', 'resolve']]) {
    const f = fixture(); f.ports[part][method] = async () => { throw new Error(secret, { cause: credentialA }); };
    const service = f.makeService();
    await assert.rejects(async () => service.authorize(await service.authenticate(credentialA)), code('DEPENDENCY_UNAVAILABLE'));
  }
});

test('malformed adapter outputs and extra token/role properties are rejected without retaining their values', async () => {
  const cases = [
    ['verifier', 'verify', { status: 'verified', subject: 's', sessionReference: 'r', expiresAt: 9000, token: secret }],
    ['identities', 'resolve', { userId: 'user-a', active: true, role: 'admin', token: secret }],
    ['memberships', 'resolve', { clientId: 'client-a', active: true, password: secret }],
    ['sessions', 'inspect', { status: 'active', expiresAt: NaN, original: secret }],
  ];
  for (const [part, method, value] of cases) {
    const f = fixture(); f.ports[part][method] = async () => value; const service = f.makeService();
    await assert.rejects(async () => service.authorize(await service.authenticate(credentialA)), code('INTERNAL_ERROR'));
  }
});

test('adapter methods are snapshotted and resolved objects cannot mutate issued contexts', async () => {
  const f = fixture(), user = { userId: 'user-a', active: true };
  f.ports.identities.resolve = async () => user; const service = f.makeService();
  f.ports.verifier.verify = async () => ({ status: 'invalid' });
  const identity = await service.authenticate(credentialA); user.userId = 'user-b';
  const context = await service.authorize(identity); assert.equal(identity.userId, 'user-a'); assert.equal(context.clientId, 'client-a');
});

test('own measurements require an owned field, area and device and every query carries frozen client scope', async () => {
  const { f, repository } = await authenticated();
  const reference = await repository.getMeasurement('field-a', 'area-a', 'device-a', 'measurement-a');
  assert.equal(reference.id, 'measurement-a'); assert.equal(reference.clientId, 'client-a'); assert.ok(Object.isFrozen(reference));
  assert.deepEqual(f.calls.resources.map(query => query.kind), ['field', 'area', 'device', 'measurement']);
  assert.ok(f.calls.resources.every(query => query.clientId === 'client-a' && Object.isFrozen(query)));
});

test('foreign resources and manipulated parent IDs are uniformly not found', async () => {
  const { f, repository } = await authenticated();
  for (const operation of [() => repository.getField('field-b'), () => repository.getField('missing'),
    () => repository.getArea('field-a', 'area-b'), () => repository.getDevice('field-a', 'area-a', 'device-b'),
    () => repository.getMeasurement('field-a', 'area-a', 'device-a', 'measurement-b')]) {
    await assert.rejects(operation(), code('RESOURCE_NOT_FOUND'));
  }
  const before = f.calls.resources.length;
  await assert.rejects(repository.getMeasurement('field-b', 'area-b', 'device-b', 'measurement-b'), code('RESOURCE_NOT_FOUND'));
  assert.equal(f.calls.resources.length - before, 1); // Stop at unauthorized parent, never query its children.
});

test('colliding logical IDs in two clients are resolved by bound client, never an unscoped ID lookup', async () => {
  const f = fixture(); f.records.push({ kind: 'field', id: 'shared', clientId: 'client-a' }, { kind: 'field', id: 'shared', clientId: 'client-b' });
  const a = await authenticated(f, credentialA), b = await authenticated(f, credentialB);
  assert.equal((await a.repository.getField('shared')).clientId, 'client-a');
  assert.equal((await b.repository.getField('shared')).clientId, 'client-b');
});

test('a misbehaving resource port cannot return a foreign owner or inconsistent lineage', async () => {
  const { service, context } = await authenticated();
  for (const resource of [
    { kind: 'field', id: 'field-a', clientId: 'client-b' },
    { kind: 'field', id: 'other', clientId: 'client-a' },
  ]) {
    const repository = service.createScopedRepository(context, { async findResource() { return resource; } });
    await assert.rejects(repository.getField('field-a'), code('RESOURCE_NOT_FOUND'));
  }
  const repository = service.createScopedRepository(context, { async findResource(query) {
    return query.kind === 'field' ? { ...query } : { ...query, fieldId: 'field-b' };
  } });
  await assert.rejects(repository.getArea('field-a', 'area-a'), code('RESOURCE_NOT_FOUND'));
});

test('invalid ID types and operator objects cannot reach the persistence port', async () => {
  const { f, repository } = await authenticated();
  for (const id of [null, undefined, {}, { $ne: null }, [], '', ' x ', 'bad\nvalue', 'x'.repeat(257)]) {
    await assert.rejects(repository.getField(id), code('VALIDATION_ERROR'));
  }
  assert.equal(f.calls.resources.length, 0);
});

test('resource failures and malformed ownership metadata do not expose adapter errors', async () => {
  const { service, context } = await authenticated();
  await assert.rejects(service.createScopedRepository(context, { async findResource() { throw new Error(secret); } }).getField('field-a'), code('DEPENDENCY_UNAVAILABLE'));
  await assert.rejects(service.createScopedRepository(context, { async findResource(query) { return { ...query, token: secret }; } }).getField('field-a'), code('INTERNAL_ERROR'));
});

test('scope expires at the boundary and cannot be revived by turning the test clock back', async () => {
  const { f, repository } = await authenticated(); f.now(9000);
  await assert.rejects(repository.getField('field-a'), code('UNAUTHENTICATED'));
  f.now(1000); await assert.rejects(repository.getField('field-a'), code('UNAUTHENTICATED'));
});

test('invalidating identity during an asynchronous query prevents returning its result', async () => {
  const { service, identity, context } = await authenticated(); const gate = Promise.withResolvers();
  const repository = service.createScopedRepository(context, { findResource: () => gate.promise });
  const pending = repository.getField('field-a'); service.invalidate(identity);
  gate.resolve({ kind: 'field', id: 'field-a', clientId: 'client-a' });
  await assert.rejects(pending, code('UNAUTHENTICATED'));
});

test('accessors reject missing authentication and distinguish authenticated from client-authorized state', async () => {
  const f = fixture(), auth = createRequestAuthorization(f.makeService()), req = request(), res = response();
  assert.equal(auth.getState(req), 'unauthenticated'); assert.throws(() => auth.getAuthenticatedIdentity(req), code('UNAUTHENTICATED'));
  assert.equal(await run(auth.authenticate, req, res), undefined); assert.equal(auth.getState(req), 'authenticated');
  assert.throws(() => auth.getAuthorizationContext(req), code('FORBIDDEN'));
  assert.equal(await run(auth.requireClient, req, res), undefined); assert.equal(auth.getState(req), 'authorized');
});

test('custom identity headers, body/query and req.user never establish authentication', async () => {
  const f = fixture(), auth = createRequestAuthorization(f.makeService());
  const req = Object.assign(request(null), { user: { userId: 'user-a' }, auth: { clientId: 'client-a' },
    body: { identity: { verified: true }, clientId: 'client-a' }, query: { cliente_id: 'client-a' } });
  req.headers['x-user-id'] = 'user-a'; req.headers['x-client-id'] = 'client-a';
  assert.ok(code('UNAUTHENTICATED')(await run(auth.authenticate, req)));
  assert.equal(f.calls.verification.length, 0);
  assert.ok(code('UNAUTHENTICATED')(await run(auth.requireClient, req)));
});

test('ambiguous and malformed authorization headers are rejected without a verifier call', async () => {
  const f = fixture(), auth = createRequestAuthorization(f.makeService());
  for (const header of [['Bearer ' + credentialA], 'Basic fake', 'Bearer ', 'Bearer  ' + credentialA]) {
    const req = request(); req.headers.authorization = header;
    assert.ok(code('UNAUTHENTICATED')(await run(auth.authenticate, req)));
  }
  const duplicate = request(); duplicate.rawHeaders.push('authorization', 'Bearer ' + credentialB);
  assert.ok(code('UNAUTHENTICATED')(await run(auth.authenticate, duplicate)));
  assert.equal(f.calls.verification.length, 0);
});

test('request copies and another accessor instance cannot retrieve identity or scope', async () => {
  const f = fixture(), service = f.makeService(), auth = createRequestAuthorization(service), req = request(), res = response();
  await run(auth.authenticate, req, res); await run(auth.requireClient, req, res);
  assert.throws(() => auth.getAuthorizationContext({ ...req }), code('UNAUTHENTICATED'));
  assert.throws(() => createRequestAuthorization(service).getAuthorizationContext(req), code('UNAUTHENTICATED'));
});

test('finishing or closing a request invalidates captured scopes but not another request for the same user', async () => {
  const f = fixture(), service = f.makeService(), auth = createRequestAuthorization(service);
  const reqA = request(), reqB = request(), resA = response(), resB = response();
  for (const [req, res] of [[reqA, resA], [reqB, resB]]) { await run(auth.authenticate, req, res); await run(auth.requireClient, req, res); }
  const repository = service.createScopedRepository(auth.getAuthorizationContext(reqA), f.resources);
  resA.emit('finish'); resA.emit('close');
  assert.equal(auth.getState(reqA), 'unauthenticated'); assert.equal(auth.getState(reqB), 'authorized');
  await assert.rejects(repository.getField('field-a'), code('UNAUTHENTICATED'));
  assert.equal(resA.listenerCount('finish'), 0); assert.equal(resA.listenerCount('close'), 0);
});

test('an old async authentication cannot overwrite the newer session on the same Request', async () => {
  const f = fixture(), gate = Promise.withResolvers(), original = f.ports.verifier.verify;
  f.ports.verifier.verify = async value => { if (value === credentialA) await gate.promise; return original(value); };
  const service = f.makeService(), auth = createRequestAuthorization(service), req = request(), res = response();
  const old = run(auth.authenticate, req, res); req.headers.authorization = 'Bearer ' + credentialB;
  await run(auth.authenticate, req, res); await run(auth.requireClient, req, res); gate.resolve();
  assert.ok(code('UNAUTHENTICATED')(await old)); assert.equal(auth.getAuthorizationContext(req).clientId, 'client-b');
});

test('an old membership resolution cannot restore context after another authentication', async () => {
  const f = fixture(), gate = Promise.withResolvers(), original = f.ports.memberships.resolve;
  f.ports.memberships.resolve = async userId => { if (userId === 'user-a') await gate.promise; return original(userId); };
  const auth = createRequestAuthorization(f.makeService()), req = request(), res = response();
  await run(auth.authenticate, req, res); const old = run(auth.requireClient, req, res);
  req.headers.authorization = 'Bearer ' + credentialB; await run(auth.authenticate, req, res); await run(auth.requireClient, req, res);
  gate.resolve(); assert.ok(code('UNAUTHENTICATED')(await old)); assert.equal(auth.getAuthorizationContext(req).clientId, 'client-b');
});

test('closing during credential verification prevents a late identity from reviving the request', async () => {
  const f = fixture(), gate = Promise.withResolvers(), original = f.ports.verifier.verify;
  f.ports.verifier.verify = async value => { await gate.promise; return original(value); };
  const auth = createRequestAuthorization(f.makeService()), req = request(), res = response();
  const pending = run(auth.authenticate, req, res); res.emit('close'); gate.resolve();
  assert.ok(code('UNAUTHENTICATED')(await pending)); assert.equal(auth.getState(req), 'unauthenticated');
  assert.ok(code('UNAUTHENTICATED')(await run(auth.authenticate, req, res)));
});

test('expiry during identity or membership resolution cannot mint a usable capability', async () => {
  const f = fixture(), original = f.ports.identities.resolve;
  f.ports.identities.resolve = async principal => { f.now(10000); return original(principal); };
  await assert.rejects(f.makeService().authenticate(credentialA), code('UNAUTHENTICATED'));
  const other = fixture(), service = other.makeService(), identity = await service.authenticate(credentialA);
  other.now(9000); await assert.rejects(service.authorize(identity), code('UNAUTHENTICATED'));
});

test('revocation simulation affects new authentications without claiming a real logout implementation', async () => {
  const f = fixture(), service = f.makeService(); await service.authenticate(credentialA);
  await f.ports.sessions.revoke({ source: 'test-authority', reference: 'session-a' });
  await assert.rejects(service.authenticate(credentialA), code('UNAUTHENTICATED'));
});

test('HTTP authorization integrates safe 400/401/403/404/503 errors with BE-08', async () => {
  const f = fixture(), { app, rows } = httpFixture(f);
  await serve(app, async url => {
    const scenarios = [
      [null, 'field-a', 401], ['invalid', 'field-a', 401], [credentialA, 'field-b', 404],
      [credentialA, 'missing', 404], [credentialA, 'field-a', 200], [credentialA, 'bad%20id%20', 400],
    ];
    for (const [credential, id, expected] of scenarios) {
      const r = await fetch(`${url}/probe/${id}`, { headers: credential ? { Authorization: 'Bearer ' + credential, Cookie: secret } : {} });
      assert.equal(r.status, expected); const text = await r.text(); assert.ok(!text.includes(secret)); assert.ok(!text.includes(credentialA));
      assert.match(r.headers.get('x-request-id'), uuid);
    }
    f.state.hasClient = false;
    const denied = await fetch(`${url}/probe/field-a`, { headers: { Authorization: 'Bearer ' + credentialA } });
    assert.equal(denied.status, 403); await denied.text();
    f.state.hasClient = true; f.state.session = 'expired';
    const expired = await fetch(`${url}/probe/field-a`, { headers: { Authorization: 'Bearer ' + credentialA } });
    assert.equal(expired.status, 401); await expired.text();
    f.state.session = 'malformed';
    const internal = await fetch(`${url}/probe/field-a`, { headers: { Authorization: 'Bearer ' + credentialA } });
    assert.equal(internal.status, 500); assert.ok(!(await internal.text()).includes(secret));
    f.state.session = 'active'; f.state.throwSession = true;
    const dependency = await fetch(`${url}/probe/field-a`, { headers: { Authorization: 'Bearer ' + credentialA } });
    assert.equal(dependency.status, 503); assert.ok(!(await dependency.text()).includes(secret));
  });
  assert.ok(!inspect(rows, { depth: 10 }).includes(secret)); assert.ok(!inspect(rows).includes(credentialA));
  assert.ok(rows.some(row => row.errorCode === 'UNAUTHENTICATED'));
});

test('concurrent HTTP identities do not share scope, request IDs, or resource filters', { timeout: 5000 }, async () => {
  const f = fixture(), gate = Promise.withResolvers(), all = Promise.withResolvers(), original = f.ports.verifier.verify;
  let entered = 0;
  f.ports.verifier.verify = async value => { if (++entered === 12) all.resolve(); await gate.promise; return original(value); };
  const { app, rows } = httpFixture(f);
  await serve(app, async url => {
    const pending = Array.from({ length: 12 }, (_, i) => fetch(`${url}/probe/field-${i % 2 ? 'b' : 'a'}`, {
      headers: { Authorization: 'Bearer ' + (i % 2 ? credentialB : credentialA), 'X-Request-ID': secret },
    }));
    await all.promise; gate.resolve(); const responses = await Promise.all(pending); const ids = [];
    for (let i = 0; i < responses.length; i++) {
      assert.equal(responses[i].status, 200); assert.deepEqual(await responses[i].json(), { id: 'field-' + (i % 2 ? 'b' : 'a') });
      ids.push(responses[i].headers.get('x-request-id'));
    }
    assert.equal(new Set(ids).size, 12); ids.forEach(id => assert.match(id, uuid));
  });
  assert.equal(f.calls.resources.filter(q => q.clientId === 'client-a').length, 6);
  assert.equal(f.calls.resources.filter(q => q.clientId === 'client-b').length, 6);
  assert.ok(!inspect(rows, { depth: 10 }).includes(credentialA)); assert.ok(!inspect(rows, { depth: 10 }).includes(secret));
});

test('real default app remains public health only and has no auth bypass or mock endpoint', async () => {
  await serve(createApp(), async url => {
    const health = await fetch(`${url}/health`, { headers: { Authorization: 'Bearer ' + credentialA, 'X-Client-Id': 'client-a' } });
    assert.equal(health.status, 200); assert.equal(await health.text(), '{"status":"ok"}');
    for (const path of ['/probe/field-a', '/auth/login', '/auth/google-demo', '/auth/demo/sesion']) {
      const r = await fetch(url + path, { headers: { Authorization: 'Bearer ' + credentialA } }); assert.equal(r.status, 404); await r.text();
    }
  });
});

test('an injected clock failure is sanitized instead of escaping as an original exception', async () => {
  const f = fixture();
  const service = createAuthorizationService(f.ports, { source: 'test', now: () => { throw new Error(secret); } });
  await assert.rejects(service.authenticate(credentialA), code('INTERNAL_ERROR'));
});

test('response flags invalidate identity and captured scopes before finish/close events arrive', async () => {
  const f = fixture(), service = f.makeService(), auth = createRequestAuthorization(service), req = request(), res = response();
  await run(auth.authenticate, req, res); await run(auth.requireClient, req, res);
  const repository = service.createScopedRepository(auth.getAuthorizationContext(req), f.resources);
  res.writableEnded = true;
  await assert.rejects(repository.getField('field-a'), code('UNAUTHENTICATED'));
  assert.throws(() => auth.getAuthorizationContext(req), code('UNAUTHENTICATED'));
  assert.equal(f.calls.resources.length, 0);
});

test('request binding is single-use, requires an issued identity and fails closed on a dead lease', async () => {
  const { service, identity } = await authenticated(); let live = true;
  assert.throws(() => service.bindToRequest({ ...identity }, () => true), code('UNAUTHENTICATED'));
  service.bindToRequest(identity, () => live);
  assert.throws(() => service.bindToRequest(identity, () => true), code('INTERNAL_ERROR'));
  live = false; assert.throws(() => service.assertIdentity(identity), code('UNAUTHENTICATED'));
  live = true; assert.throws(() => service.assertIdentity(identity), code('UNAUTHENTICATED'));
});

test('a failing liveness callback is sanitized and permanently invalidates the capability', async () => {
  const { service, identity } = await authenticated();
  service.bindToRequest(identity, () => { throw new Error(secret); });
  assert.throws(() => service.assertIdentity(identity), code('INTERNAL_ERROR'));
  assert.throws(() => service.assertIdentity(identity), code('UNAUTHENTICATED'));
});

test('failed reauthentication clears the previous authorization and every captured reader', async () => {
  const f = fixture(), service = f.makeService(), auth = createRequestAuthorization(service), req = request(), res = response();
  await run(auth.authenticate, req, res); await run(auth.requireClient, req, res);
  const reader = service.createScopedRepository(auth.getAuthorizationContext(req), f.resources);
  req.headers.authorization = 'Bearer invalid';
  assert.ok(code('UNAUTHENTICATED')(await run(auth.authenticate, req, res)));
  assert.equal(auth.getState(req), 'unauthenticated');
  await assert.rejects(reader.getField('field-a'), code('UNAUTHENTICATED'));
});

test('obsolete authorization on the same identity cannot erase the latest successful scope', async () => {
  const f = fixture(), gate = Promise.withResolvers(), original = f.ports.memberships.resolve;
  let count = 0; f.ports.memberships.resolve = async userId => { if (++count === 1) await gate.promise; return original(userId); };
  const auth = createRequestAuthorization(f.makeService()), req = request(), res = response();
  await run(auth.authenticate, req, res); const old = run(auth.requireClient, req, res);
  await run(auth.requireClient, req, res); gate.resolve();
  assert.ok(code('UNAUTHENTICATED')(await old)); assert.equal(auth.getAuthorizationContext(req).clientId, 'client-a');
});

test('downstream next failures are propagated once, not caught as another authentication failure', async () => {
  const auth = createRequestAuthorization(fixture().makeService()); let calls = 0;
  const failure = new Error('synthetic downstream');
  await assert.rejects(auth.authenticate(request(), response(), () => { calls++; throw failure; }), error => error === failure);
  assert.equal(calls, 1);
});

test('TypeScript distinguishes user/client keys and forbids constructing identities or unscoped queries', () => {
  const filename = path.resolve('test/authorization-types.fixture.ts');
  const source = `
    import type {AuthenticatedIdentity,AuthorizationContext,UserId,ClientId,ResourceId,ScopedResourceQuery} from '../src/auth/contracts.js';
    declare const user:UserId; declare const client:ClientId; declare const resource:ResourceId;
    // @ts-expect-error User and client are distinct nominal key types.
    const wrong:ClientId=user;
    // @ts-expect-error A plain object lacks the private identity brand.
    const identity:AuthenticatedIdentity={userId:user,source:'unverified',authenticatedAt:0,expiresAt:100};
    // @ts-expect-error A plain object lacks the private authorization brand.
    const context:AuthorizationContext={identity,clientId:client};
    // @ts-expect-error A resource query without a bound client is not permitted.
    const query:ScopedResourceQuery={kind:'field',id:resource};
  `;
  const config = ts.readConfigFile('tsconfig.json', ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
  const host = ts.createCompilerHost(parsed.options), original = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, ...rest) => path.resolve(file) === filename
    ? ts.createSourceFile(file, source, languageVersion, true) : original(file, languageVersion, ...rest);
  const program = ts.createProgram([filename], { ...parsed.options, noEmit: true }, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => process.cwd(), getCanonicalFileName: file => file, getNewLine: () => '\n',
  }));
});
