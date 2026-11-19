import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { once } from 'node:events';
import { request as rawRequest } from 'node:http';
import { EventEmitter } from 'node:events';
import express from 'express';
import { createSessionService } from '../dist/src/services/session.service.js';
import { createSessionRouter } from '../dist/src/routes/session.routes.js';
import { validateAuthenticationConfig, loadAuthenticationConfig } from '../dist/src/config/authentication.js';
import { digestSecret, newOpaqueSecret, isOpaqueSecret, sameDigest } from '../dist/src/auth/session-security.js';
import { createHttpInfrastructure } from '../dist/src/http/infrastructure.js';
import { createApp } from '../dist/src/app.js';
import { toSessionResponse } from '../dist/src/dto/session.dto.js';
import { createRequestAuthorization } from '../dist/src/middlewares/request-authorization.middleware.js';

const origin = 'https://frontend.example.invalid';
const audience = '1234567890-offline.apps.googleusercontent.com';
const diagnostic = 'OFFLINE_PRIVATE_STORAGE_FAILURE';
const config = values => validateAuthenticationConfig({ realm: 'test', audience, allowedOrigins: [origin],
  challengeTtlMs: 1000, absoluteTtlMs: 10000, idleTtlMs: 2000, ...values });
const clone = value => value === undefined || value === null ? null : structuredClone(value);
const code = expected => e => e.code === expected && !inspect(e, { showHidden: true }).includes(diagnostic);
function barrier() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

// All shared-store/catalogue/identity/admission fakes live only in this test file.
// Methods execute their predicate/update synchronously after the optional barrier.
function fixture(options = {}) {
  let clock = 100000;
  const challenges = new Map(), sessions = new Map(), users = new Map();
  const hooks = {}, fail = new Set(), calls = {};
  for (const suffix of ['a', 'b']) users.set('user-' + suffix, { id: 'user-' + suffix,
    issuer: 'https://accounts.google.com', subject: 'subject-' + suffix,
    name: 'User ' + suffix, email: suffix + '@example.invalid', active: true, securityVersion: 1,
    client: { id: 'client-' + suffix, name: 'Client ' + suffix, active: true } });
  async function before(name) { calls[name] = (calls[name] ?? 0) + 1; if (fail.has(name)) throw new Error(diagnostic); await hooks[name]?.(); }
  const repository = {
    async insertChallenge(row) { await before('insertChallenge'); if (challenges.has(row.digest)) throw new Error(); challenges.set(row.digest, clone(row)); },
    async findChallenge(digest, realm) { await before('findChallenge'); const row = challenges.get(digest); return row?.realm === realm ? clone(row) : null; },
    async consumeChallenge(digest, nonce, realm, now) {
      await before('consumeChallenge'); const row = challenges.get(digest);
      if (!row || row.realm !== realm || row.nonceDigest !== nonce || row.consumedAt !== null || row.expiresAt <= now) return false;
      row.consumedAt = now; return true;
    },
    async insertSession(row) { await before('insertSession'); if ([...sessions.values()].some(r => r.digest === row.digest)) throw new Error(); sessions.set(row.id, clone(row)); },
    async findSessionByDigest(digest, realm) { await before('findSessionByDigest'); return clone([...sessions.values()].find(r => r.digest === digest && r.realm === realm)); },
    async findSessionById(id, realm) { await before('findSessionById'); const row = sessions.get(id); return row?.realm === realm ? clone(row) : null; },
    async touchSession(id, realm, now, idleExpiresAt) {
      await before('touchSession'); const row = sessions.get(id);
      if (!row || row.realm !== realm || row.revokedAt !== null || row.idleExpiresAt <= now || row.absoluteExpiresAt <= now) return null;
      row.idleExpiresAt = Math.max(row.idleExpiresAt, Math.min(row.absoluteExpiresAt, idleExpiresAt)); return clone(row);
    },
    async revokeSession(digest, realm, now) { await before('revokeSession'); for (const row of sessions.values()) if (row.digest === digest && row.realm === realm) row.revokedAt ??= now; },
  };
  const catalogue = {
    async findByPrincipal(p) { await before('findByPrincipal'); return clone([...users.values()].find(u => u.issuer === p.issuer && u.subject === p.subject)); },
    async findById(id) { await before('findById'); return clone(users.get(id)); },
  };
  const verifier = { async verify(credential, nonceDigest) {
    await before('verify'); let p;
    try { p = JSON.parse(credential); } catch { return { status: 'invalid' }; }
    if (typeof p.nonce !== 'string' || !sameDigest(digestSecret(p.nonce), nonceDigest)) return { status: 'invalid' };
    return { status: 'verified', identity: { issuer: 'https://accounts.google.com', subject: p.subject } };
  } };
  const service = createSessionService({ repository, catalogue, verifier }, config(options), () => clock);
  const assertion = (attempt, subject = 'subject-a') => JSON.stringify({ subject, nonce: attempt.nonce });
  async function login(subject = 'subject-a', target = service) { const attempt = await target.challenge(); return target.login(assertion(attempt, subject), attempt.challengeId); }
  async function context(token, target = service) { const identity = await target.authorization.authenticate(token); return target.authorization.authorize(identity); }
  return { service, repository, catalogue, verifier, challenges, sessions, users, hooks, fail, calls, assertion, login, context,
    now: () => clock, advance: ms => { clock += ms; }, setClock: value => { clock = value; } };
}
async function serve(app, check) {
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { return await check('http://127.0.0.1:' + server.address().port); }
  finally { await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
}
function httpFixture(f, onLog = () => {}) {
  const logs = [], state = { allowed: true, failing: false };
  const http = createHttpInfrastructure({ logger: r => { logs.push(r); onLog(r); }, errorResponse: e => ({ error: { code: e.code, message: e.message } }) });
  const app = express(); app.disable('x-powered-by'); http.protectApplication(app);
  app.use(http.requestContext, http.securityHeaders);
  app.use('/api/v1/auth', createSessionRouter(f.service, http, { async admit() { if (state.failing) throw new Error(diagnostic); return state.allowed; } }));
  app.use(http.notFound, http.errorHandler, http.terminalErrorHandler);
  return { app, logs, state };
}

test('auth configuration is explicit, immutable and validates environment, origins and duration limits', () => {
  assert.ok(Object.isFrozen(config())); assert.ok(Object.isFrozen(config().allowedOrigins));
  for (const value of [{ audience: 'invalid' }, { realm: 'unknown' }, { allowedOrigins: ['*'] },
    { allowedOrigins: ['https://host.invalid/'] }, { allowedOrigins: ['https://u:p@host.invalid'] },
    { realm: 'production', allowedOrigins: ['http://localhost:5173'] }, { idleTtlMs: 10001 }, { challengeTtlMs: 0 }]) assert.throws(() => config(value), TypeError);
  assert.throws(() => loadAuthenticationConfig({}), TypeError);
  assert.equal(loadAuthenticationConfig({ AUTH_ENVIRONMENT: 'test', GOOGLE_CLIENT_ID: audience, AUTH_ALLOWED_ORIGINS: origin }).audience, audience);
});
test('opaque values contain no identity, are canonical, and persist only SHA256 digests', async () => {
  const f = fixture(), attempt = await f.service.challenge(), login = await f.service.login(f.assertion(attempt), attempt.challengeId);
  for (const raw of [attempt.challengeId, attempt.nonce, login.token]) { assert.equal(raw.length, 43); assert.ok(isOpaqueSecret(raw)); assert.match(digestSecret(raw), /^[a-f0-9]{64}$/); }
  const stored = JSON.stringify([...f.challenges.values(), ...f.sessions.values()]);
  for (const secret of [attempt.challengeId, attempt.nonce, login.token]) assert.equal(stored.includes(secret), false);
  assert.equal(JSON.stringify([...f.sessions.values()]).includes('@example.invalid'), false);
  assert.equal(isOpaqueSecret('A'.repeat(42) + 'B'), false);
  assert.equal(sameDigest('not-a-digest', 'not-a-digest'), false);
});
test('session creation integrates with BE09.1 private identity, context and response mapping', async () => {
  const f = fixture(), login = await f.login(), context = await f.context(login.token);
  assert.equal(context.clientId, 'client-a'); assert.equal(context.identity.userId, 'user-a');
  const view = await f.service.current(context), dto = toSessionResponse(view);
  assert.equal(dto.usuario.cliente_id, dto.cliente.cliente_id);
  assert.equal(JSON.stringify(dto).includes(login.token), false);
  assert.equal(Object.hasOwn(dto, 'securityVersion'), false);
  assert.match(dto.sesion.expira_en, /Z$/);
  assert.equal(f.service.authorization.getSessionReference(context.identity).source, 'agro-session:test');
});
test('malformed credentials/challenge IDs fail before verification or persistence work', async () => {
  const f = fixture();
  for (const challenge of ['', newOpaqueSecret() + 'x', {}, null]) await assert.rejects(f.service.login('x', challenge), code('UNAUTHENTICATED'));
  const attempt = await f.service.challenge();
  for (const credential of ['', 'x'.repeat(8193), null]) await assert.rejects(f.service.login(credential, attempt.challengeId), code('UNAUTHENTICATED'));
  assert.equal(f.calls.verify, undefined); assert.equal(f.sessions.size, 0);
});
test('wrong nonce, unknown challenge and invalid verifier result do not create sessions', async () => {
  const f = fixture(), attempt = await f.service.challenge();
  await assert.rejects(f.service.login(f.assertion({ nonce: newOpaqueSecret() }), attempt.challengeId), code('UNAUTHENTICATED'));
  await assert.rejects(f.service.login(f.assertion(attempt), newOpaqueSecret()), code('UNAUTHENTICATED'));
  await assert.rejects(f.service.login('invalid-assertion', attempt.challengeId), code('UNAUTHENTICATED'));
  assert.equal(f.sessions.size, 0);
});
test('challenge expires at exact boundary and remains invalid even if physical TTL cleanup has not run', async () => {
  const f = fixture(), attempt = await f.service.challenge(); f.advance(1000);
  await assert.rejects(f.service.login(f.assertion(attempt), attempt.challengeId), code('UNAUTHENTICATED'));
  assert.equal(f.challenges.size, 1); assert.equal(f.sessions.size, 0);
});
test('challenge replay produces only one session and rejects a reused attempt', async () => {
  const f = fixture(), attempt = await f.service.challenge();
  await f.service.login(f.assertion(attempt), attempt.challengeId);
  await assert.rejects(f.service.login(f.assertion(attempt), attempt.challengeId), code('UNAUTHENTICATED'));
  assert.equal(f.sessions.size, 1);
});
test('two service instances racing on the same challenge have one atomic winner', async () => {
  const f = fixture(), second = createSessionService({ repository: f.repository, catalogue: f.catalogue, verifier: f.verifier }, config(), f.now);
  const attempt = await f.service.challenge(), gate = barrier(); let started = 0;
  f.hooks.consumeChallenge = async () => { if (++started === 2) gate.resolve(); await gate.promise; };
  const result = await Promise.allSettled([f.service.login(f.assertion(attempt), attempt.challengeId), second.login(f.assertion(attempt), attempt.challengeId)]);
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(result.filter(r => r.status === 'rejected' && r.reason.code === 'UNAUTHENTICATED').length, 1);
  assert.equal(f.sessions.size, 1);
});
test('failed insertion burns the claimed attempt; recovery requires a new challenge', async () => {
  const f = fixture(), attempt = await f.service.challenge(); f.fail.add('insertSession');
  await assert.rejects(f.service.login(f.assertion(attempt), attempt.challengeId), code('DEPENDENCY_UNAVAILABLE'));
  f.fail.clear();
  await assert.rejects(f.service.login(f.assertion(attempt), attempt.challengeId), code('UNAUTHENTICATED'));
  assert.ok((await f.login()).token); assert.equal(f.sessions.size, 1);
});
test('unknown, inactive and unassigned identities do not get sessions or fictitious clients', async () => {
  const f = fixture();
  await assert.rejects(f.login('unknown-subject'), code('FORBIDDEN'));
  f.users.get('user-a').active = false; await assert.rejects(f.login(), code('FORBIDDEN'));
  f.users.get('user-a').active = true; f.users.get('user-a').client = null; await assert.rejects(f.login(), code('FORBIDDEN'));
  f.users.get('user-a').client = { id: 'client-a', name: 'A', active: false }; await assert.rejects(f.login(), code('FORBIDDEN'));
  assert.equal(f.sessions.size, 0);
});
test('membership version change never silently transfers an old session into a different client', async () => {
  const f = fixture(), login = await f.login(), identity = await f.service.authorization.authenticate(login.token);
  f.users.get('user-a').client = { id: 'client-b', name: 'B', active: true }; f.users.get('user-a').securityVersion++;
  await assert.rejects(f.service.authorization.authorize(identity), code('UNAUTHENTICATED'));
  await assert.rejects(f.context(login.token), code('UNAUTHENTICATED'));
  assert.equal((await f.context((await f.login()).token)).clientId, 'client-b');
});
test('user deactivation or global version change invalidates an existing application session', async () => {
  for (const mutate of [u => { u.active = false; }, u => { u.securityVersion++; }]) {
    const f = fixture(), login = await f.login(); mutate(f.users.get('user-a'));
    await assert.rejects(f.context(login.token), code('UNAUTHENTICATED'));
  }
});
test('idle activity extends conditionally, never beyond the absolute expiry', async () => {
  const f = fixture(), login = await f.login(); f.advance(1000);
  await f.context(login.token); assert.equal([...f.sessions.values()][0].idleExpiresAt, f.now() + 2000);
  for (let i = 0; i < 8; i++) { f.advance(1000); await f.context(login.token); }
  assert.equal([...f.sessions.values()][0].idleExpiresAt, login.absoluteExpiresAt);
  f.advance(1000); await assert.rejects(f.context(login.token), code('UNAUTHENTICATED'));
});
test('expired idle session does not authenticate merely because its row still exists', async () => {
  const f = fixture(), login = await f.login(); f.advance(2000);
  await assert.rejects(f.context(login.token), code('UNAUTHENTICATED')); assert.equal(f.sessions.size, 1);
});
test('logout is durable/idempotent and also works after user or client deactivation', async () => {
  const f = fixture(), login = await f.login(); f.users.get('user-a').active = false;
  await f.service.logout(login.token); await f.service.logout(login.token);
  await f.service.logout(null); await f.service.logout('malformed'); await f.service.logout(newOpaqueSecret());
  assert.notEqual([...f.sessions.values()][0].revokedAt, null);
  f.users.get('user-a').active = true; await assert.rejects(f.context(login.token), code('UNAUTHENTICATED'));
});
test('revoking one session leaves another session of the same user and a different user intact', async () => {
  const f = fixture(), a = await f.login(), a2 = await f.login(), b = await f.login('subject-b');
  await f.service.logout(a.token); await assert.rejects(f.context(a.token), code('UNAUTHENTICATED'));
  assert.equal((await f.context(a2.token)).clientId, 'client-a'); assert.equal((await f.context(b.token)).clientId, 'client-b');
});
test('revocation is visible to a separate worker sharing the persistent port', async () => {
  const f = fixture(), login = await f.login();
  const second = createSessionService({ repository: f.repository, catalogue: f.catalogue, verifier: f.verifier }, config(), f.now);
  await second.logout(login.token); await assert.rejects(f.context(login.token), code('UNAUTHENTICATED'));
});
test('revocation racing with touch cannot resurrect a session', async () => {
  const f = fixture(), login = await f.login(), started = barrier(), release = barrier();
  f.hooks.touchSession = async () => { started.resolve(); await release.promise; };
  const pending = f.context(login.token); await started.promise; await f.service.logout(login.token); release.resolve();
  await assert.rejects(pending, code('UNAUTHENTICATED'));
  assert.notEqual([...f.sessions.values()][0].revokedAt, null);
});
test('expiry while a session lookup is pending cannot mint a current context', async () => {
  const f = fixture(), login = await f.login(); f.hooks.findSessionByDigest = async () => { f.advance(10000); };
  await assert.rejects(f.context(login.token), code('UNAUTHENTICATED'));
});
test('an already issued local capability is not claimed to be remotely cancelled, but new admission and current view reject', async () => {
  const f = fixture(), login = await f.login(), context = await f.context(login.token);
  await f.service.logout(login.token);
  f.service.authorization.assertContext(context); // Documented in-flight admission semantics.
  await assert.rejects(f.service.current(context), code('UNAUTHENTICATED'));
  await assert.rejects(f.context(login.token), code('UNAUTHENTICATED'));
});
test('application environments cannot authenticate or revoke each other sessions', async () => {
  const f = fixture(), login = await f.login();
  const preview = createSessionService({ repository: f.repository, catalogue: f.catalogue, verifier: f.verifier }, config({ realm: 'preview' }), f.now);
  await assert.rejects(preview.authorization.authenticate(login.token), code('UNAUTHENTICATED'));
  await preview.logout(login.token); assert.equal([...f.sessions.values()][0].revokedAt, null);
});
test('repository, catalogue and verifier diagnostics are sanitized and recovery does not cache failure', async () => {
  for (const method of ['insertChallenge', 'findChallenge', 'verify', 'findByPrincipal', 'consumeChallenge', 'insertSession']) {
    const f = fixture(), attempt = await f.service.challenge(); f.fail.add(method);
    const op = method === 'insertChallenge' ? f.service.challenge() : f.service.login(f.assertion(attempt), attempt.challengeId);
    await assert.rejects(op, code('DEPENDENCY_UNAVAILABLE')); f.fail.clear(); assert.ok((await f.login()).token);
  }
  const f = fixture(), login = await f.login(); f.fail.add('revokeSession');
  await assert.rejects(f.service.logout(login.token), code('DEPENDENCY_UNAVAILABLE'));
  assert.equal([...f.sessions.values()][0].revokedAt, null); f.fail.clear(); await f.service.logout(login.token);
});
test('scoped resource reads prevent cross-client access with sessions issued through the new service', async () => {
  const f = fixture(), a = await f.login(), b = await f.login('subject-b'); const calls = [];
  const resources = { async findResource(query) { calls.push(query); return query.id === 'field-' + query.clientId.slice(-1) ? { ...query } : null; } };
  const own = f.service.authorization.createScopedRepository(await f.context(a.token), resources);
  assert.equal((await own.getField('field-a')).clientId, 'client-a');
  await assert.rejects(own.getField('field-b'), code('RESOURCE_NOT_FOUND'));
  const other = f.service.authorization.createScopedRepository(await f.context(b.token), resources);
  assert.equal((await other.getField('field-b')).clientId, 'client-b');
  assert.deepEqual(calls.map(c => c.clientId), ['client-a', 'client-a', 'client-b']);
});
test('captured session references require issued capabilities; copies and foreign contexts fail closed', async () => {
  const f = fixture(), login = await f.login(), context = await f.context(login.token);
  assert.throws(() => f.service.authorization.getSessionReference({ ...context.identity }), code('UNAUTHENTICATED'));
  await assert.rejects(f.service.current({ ...context }), code('FORBIDDEN'));
});
test('complete isolated HTTP flow issues a session, recovers identity and revokes without logging credentials', async () => {
  const f = fixture(), h = httpFixture(f);
  await serve(h.app, async url => {
    const post = (path, body, token) => fetch(url + '/api/v1/auth' + path, { method: 'POST', headers: { Origin: origin,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const r = await post('/google/challenge', {}); assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store');
    const attempt = await r.json(); const credential = JSON.stringify({ subject: 'subject-a', nonce: attempt.nonce });
    const lr = await post('/login', { provider: 'google', credential, challenge_id: attempt.challenge_id }); assert.equal(lr.status, 200);
    const login = await lr.json(); assert.equal(login.token_type, 'Bearer'); assert.equal(login.usuario.usuario_id, 'user-a');
    const current = await fetch(url + '/api/v1/auth/session', { headers: { Authorization: 'Bearer ' + login.token, Origin: origin } });
    assert.equal(current.status, 200); assert.equal(current.headers.get('x-powered-by'), null);
    const dto = await current.json(); assert.equal(dto.cliente.cliente_id, 'client-a'); assert.equal(Object.hasOwn(dto, 'token'), false);
    const logout = await post('/logout', undefined, login.token); assert.equal(logout.status, 204); assert.equal(await logout.text(), '');
    const invalid = await fetch(url + '/api/v1/auth/session', { headers: { Authorization: 'Bearer ' + login.token } }); assert.equal(invalid.status, 401); await invalid.text();
    assert.equal((await post('/logout')).status, 204);
    const logged = JSON.stringify(h.logs); for (const value of [login.token, credential, attempt.nonce, diagnostic, 'a@example.invalid']) assert.equal(logged.includes(value), false);
    assert.ok(h.logs.every(x => typeof x.requestId === 'string'));
  });
});
test('HTTP rejects missing/malformed/duplicated Bearer and never reads credentials from a query', async () => {
  const f = fixture(), h = httpFixture(f), login = await f.login();
  await serve(h.app, async url => {
    for (const value of [null, 'Basic ' + login.token, 'Bearer malformed', 'Bearer ' + login.token + ', Bearer ' + login.token]) {
      const r = await fetch(url + '/api/v1/auth/session', { headers: value ? { Authorization: value } : {} }); assert.equal(r.status, 401); await r.text();
    }
    const query = await fetch(url + '/api/v1/auth/session?token=' + login.token); assert.equal(query.status, 400); await query.text();
  });
});
test('HTTP Origin/JSON/DTO gates reject unsafe login inputs without touching challenge storage', async () => {
  const f = fixture(), h = httpFixture(f);
  await serve(h.app, async url => {
    for (const headers of [{ 'Content-Type': 'application/json' }, { Origin: 'null', 'Content-Type': 'application/json' },
      { Origin: origin + '/', 'Content-Type': 'application/json' }]) {
      const r = await fetch(url + '/api/v1/auth/google/challenge', { method: 'POST', headers, body: '{}' }); assert.equal(r.status, 403); await r.text();
    }
    const form = await fetch(url + '/api/v1/auth/google/challenge', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'text/plain' }, body: '{}' }); assert.equal(form.status, 415); await form.text();
    const extra = await fetch(url + '/api/v1/auth/google/challenge', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{"clientId":"client-b"}' }); assert.equal(extra.status, 400); await extra.text();
    assert.equal(f.calls.insertChallenge, undefined);
    const options = await fetch(url + '/api/v1/auth/session', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
    assert.equal(options.status, 204); assert.equal(options.headers.get('access-control-allow-origin'), origin); assert.equal(options.headers.get('access-control-allow-credentials'), null);
  });
});
test('explicit admission prevents repeated requests reaching persistence and sanitizes limiter failures', async () => {
  const f = fixture(), h = httpFixture(f); h.state.allowed = false;
  await serve(h.app, async url => {
    const request = () => fetch(url + '/api/v1/auth/google/challenge', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
    const denied = await request(); assert.equal(denied.status, 429); await denied.text(); assert.equal(f.calls.insertChallenge, undefined);
    h.state.failing = true; const failed = await request(); assert.equal(failed.status, 503); assert.equal((await failed.text()).includes(diagnostic), false);
  });
  assert.throws(() => createSessionRouter(f.service, createHttpInfrastructure(), undefined), TypeError);
});
test('default Express application still exposes public health without auth routes, credentials or MongoDB', async () => {
  await serve(createApp(), async url => {
    const health = await fetch(url + '/health'); assert.equal(health.status, 200); assert.equal(await health.text(), '{"status":"ok"}');
    for (const path of ['/api/v1/auth/session', '/api/v1/auth/login', '/api/v1/auth/google/challenge', '/auth/google-demo']) {
      const response = await fetch(url + path); assert.equal(response.status, 404); await response.text();
    }
  });
});

test('audit regression: delayed challenge consumption cannot issue a session after the attempt expiry', async () => {
  const f = fixture(), attempt = await f.service.challenge();
  f.hooks.consumeChallenge = async () => { f.advance(1000); };
  await assert.rejects(f.service.login(f.assertion(attempt), attempt.challengeId), code('UNAUTHENTICATED'));
  assert.equal(f.sessions.size, 0);
});
test('audit regression: persistence cannot substitute another user/client binding during issuance', async () => {
  const f = fixture();
  f.hooks.findSessionByDigest = async () => {
    for (const row of f.sessions.values()) { row.userId = 'user-b'; row.clientId = 'client-b'; }
  };
  await assert.rejects(f.login(), code('INTERNAL_ERROR'));
});

test('duration environment settings are applied and malformed values never silently fall back', () => {
  const environment = { AUTH_ENVIRONMENT: 'test', GOOGLE_CLIENT_ID: audience, AUTH_ALLOWED_ORIGINS: origin,
    AUTH_LOGIN_CHALLENGE_MS: '1000', AUTH_SESSION_ABSOLUTE_MS: '10000', AUTH_SESSION_IDLE_MS: '2000' };
  const parsed = loadAuthenticationConfig(environment);
  assert.equal(parsed.challengeTtlMs, 1000); assert.equal(parsed.absoluteTtlMs, 10000); assert.equal(parsed.idleTtlMs, 2000);
  for (const value of ['', '1e3', '-1000', '1000ms', 'Infinity', ' 1000 ', 1000, '9999999999999999999999']) {
    assert.throws(() => loadAuthenticationConfig({ ...environment, AUTH_LOGIN_CHALLENGE_MS: value }), TypeError);
  }
});

test('real duplicate Authorization header fields are rejected even when Node normalizes them', async () => {
  const f = fixture(), h = httpFixture(f), login = await f.login();
  await serve(h.app, async url => {
    const status = await new Promise((resolve, reject) => {
      const request = rawRequest(url + '/api/v1/auth/session', { headers: [
        'Host', new URL(url).host, 'Authorization', 'Bearer ' + login.token, 'Authorization', 'Bearer ' + login.token] }, response => {
        response.resume(); response.once('end', () => resolve(response.statusCode));
      });
      request.once('error', reject); request.end();
    });
    assert.equal(status, 401); assert.equal(f.calls.touchSession, undefined);
  });
});

test('simultaneous HTTP requests with A/B sessions keep their private contexts isolated', async () => {
  const f = fixture(), h = httpFixture(f), a = await f.login(), b = await f.login('subject-b');
  await serve(h.app, async url => {
    await Promise.all(Array.from({ length: 12 }, async (_, i) => {
      const suffix = i % 2 ? 'b' : 'a', token = i % 2 ? b.token : a.token;
      const response = await fetch(url + '/api/v1/auth/session', { headers: { Authorization: 'Bearer ' + token } });
      assert.equal(response.status, 200); const body = await response.json();
      assert.equal(body.usuario.usuario_id, 'user-' + suffix); assert.equal(body.cliente.cliente_id, 'client-' + suffix);
    }));
  });
});

test('storage metadata and unsafe clock exceptions fail closed without retaining diagnostics', async () => {
  const f = fixture();
  f.hooks.findChallenge = async () => { for (const row of f.challenges.values()) row.privateDiagnostic = diagnostic; };
  const attempt = await f.service.challenge();
  await assert.rejects(f.service.login(f.assertion(attempt), attempt.challengeId), code('INTERNAL_ERROR'));
  const failing = createSessionService({ repository: f.repository, catalogue: f.catalogue, verifier: f.verifier }, config(), () => { throw new Error(diagnostic); });
  await assert.rejects(failing.challenge(), code('INTERNAL_ERROR'));
});

test('HTTP storage failures never report a successful logout and oversized input is rejected', async () => {
  const f = fixture(), h = httpFixture(f), login = await f.login();
  const verificationCount = f.calls.verify;
  await serve(h.app, async url => {
    f.fail.add('revokeSession');
    const failed = await fetch(url + '/api/v1/auth/logout', { method: 'POST', headers: { Origin: origin, Authorization: 'Bearer ' + login.token } });
    assert.equal(failed.status, 503); assert.equal((await failed.text()).includes(diagnostic), false);
    const huge = await fetch(url + '/api/v1/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ credential: 'x'.repeat(20000) }) });
    assert.equal(huge.status, 413); await huge.text(); assert.equal(f.calls.verify, verificationCount);
  });
});

test('C02: an older concurrent touch cannot shorten idle expiry or reject a correct atomic max update', async () => {
  const f = fixture(), login = await f.login(), started = barrier(), release = barrier();
  let calls = 0;
  const repository = { ...f.repository, async touchSession(id, realm, now, idleExpiresAt) {
    if (++calls === 1) { started.resolve(); await release.promise; }
    const row = f.sessions.get(id);
    if (row.realm !== realm || row.revokedAt !== null || row.idleExpiresAt <= now || row.absoluteExpiresAt <= now) return null;
    row.idleExpiresAt = Math.max(row.idleExpiresAt, Math.min(row.absoluteExpiresAt, idleExpiresAt));
    return clone(row);
  } };
  const service = createSessionService({ repository, catalogue: f.catalogue, verifier: f.verifier }, config(), f.now);
  const older = f.context(login.token, service);
  // Install the rejection observer before releasing the delayed operation.
  const result = Promise.allSettled([older]);
  await started.promise; f.advance(500);
  assert.equal((await f.context(login.token, service)).clientId, 'client-a');
  const newerExpiry = [...f.sessions.values()][0].idleExpiresAt;
  release.resolve();
  assert.equal((await result)[0].status, 'fulfilled');
  assert.equal([...f.sessions.values()][0].idleExpiresAt, newerExpiry);
});

test('C05: a lost acknowledgement after atomic challenge consumption never permits replay', async () => {
  const f = fixture(), attempt = await f.service.challenge(); let fail = true;
  const repository = { ...f.repository, async consumeChallenge(...args) {
    const result = await f.repository.consumeChallenge(...args);
    if (fail) { fail = false; throw new Error(diagnostic); }
    return result;
  } };
  const service = createSessionService({ repository, catalogue: f.catalogue, verifier: f.verifier }, config(), f.now);
  await assert.rejects(service.login(f.assertion(attempt), attempt.challengeId), code('DEPENDENCY_UNAVAILABLE'));
  await assert.rejects(service.login(f.assertion(attempt), attempt.challengeId), code('UNAUTHENTICATED'));
  assert.equal(f.sessions.size, 0); assert.ok((await f.login('subject-a', service)).token);
});

function middlewareRequest(token) {
  return { headers: { authorization: 'Bearer ' + token }, rawHeaders: ['Authorization', 'Bearer ' + token] };
}
function middlewareResponse() {
  const response = new EventEmitter();
  response.writableEnded = response.destroyed = response.headersSent = false;
  return response;
}
function invoke(middleware, request, response) {
  return new Promise((resolve, reject) => {
    let calls = 0;
    Promise.resolve(middleware(request, response, error => {
      if (++calls > 1) reject(new Error('next called twice'));
      else resolve(error);
    })).catch(reject);
  });
}

test('C06: closing a request during real session verification cannot revive its identity or context', async () => {
  const f = fixture(), login = await f.login(), entered = barrier(), release = barrier();
  f.hooks.touchSession = async () => { entered.resolve(); await release.promise; };
  const auth = createRequestAuthorization(f.service.authorization), request = middlewareRequest(login.token), response = middlewareResponse();
  const pending = invoke(auth.authenticate, request, response); await entered.promise;
  response.destroyed = true; response.emit('close'); release.resolve();
  assert.equal((await pending).code, 'UNAUTHENTICATED');
  assert.throws(() => auth.getAuthorizationContext(request), code('UNAUTHENTICATED'));
});

test('C07: an obsolete authentication cannot overwrite the newer B session on the same request', async () => {
  const f = fixture(), a = await f.login(), b = await f.login('subject-b'), entered = barrier(), release = barrier(); let touches = 0;
  f.hooks.touchSession = async () => { if (++touches === 1) { entered.resolve(); await release.promise; } };
  const auth = createRequestAuthorization(f.service.authorization), request = middlewareRequest(a.token), response = middlewareResponse();
  const old = invoke(auth.authenticate, request, response); await entered.promise;
  Object.assign(request, middlewareRequest(b.token));
  assert.equal(await invoke(auth.authenticate, request, response), undefined);
  assert.equal(await invoke(auth.requireClient, request, response), undefined);
  release.resolve(); assert.equal((await old).code, 'UNAUTHENTICATED');
  assert.equal(auth.getAuthorizationContext(request).clientId, 'client-b');
  response.emit('finish');
});

test('C08: expiry during bound membership lookup permanently invalidates the pending capability', async () => {
  const f = fixture(), login = await f.login(), identity = await f.service.authorization.authenticate(login.token);
  const entered = barrier(), release = barrier();
  f.hooks.findById = async () => { entered.resolve(); await release.promise; };
  const pending = f.service.authorization.authorize(identity); const result = Promise.allSettled([pending]);
  await entered.promise; f.advance(2000); release.resolve();
  assert.equal((await result)[0].reason.code, 'UNAUTHENTICATED');
  f.setClock(100000); assert.throws(() => f.service.authorization.assertIdentity(identity), code('UNAUTHENTICATED'));
});

test('C09: simultaneous challenges and logins remain independent with unique opaque secrets', async () => {
  const f = fixture(), attempts = await Promise.all(Array.from({ length: 8 }, () => f.service.challenge()));
  assert.equal(new Set(attempts.map(a => a.challengeId)).size, 8); assert.equal(new Set(attempts.map(a => a.nonce)).size, 8);
  const sessions = await Promise.all(attempts.map((a, i) => f.service.login(f.assertion(a, i % 2 ? 'subject-b' : 'subject-a'), a.challengeId)));
  assert.equal(new Set(sessions.map(s => s.token)).size, 8); assert.equal(f.sessions.size, 8);
  for (let i = 0; i < sessions.length; i++) assert.equal((await f.context(sessions[i].token)).clientId, i % 2 ? 'client-b' : 'client-a');
});

test('C10: identical profile emails do not merge different issuer/sub principals or admit unknown users', async () => {
  const f = fixture(); f.users.get('user-b').email = f.users.get('user-a').email;
  const a = await f.login(), b = await f.login('subject-b');
  assert.equal((await f.context(a.token)).clientId, 'client-a'); assert.equal((await f.context(b.token)).clientId, 'client-b');
  await assert.rejects(f.login('unknown-subject'), code('FORBIDDEN'));
});

test('C11: public identity headers, cookies and body tokens never select a client or replace Authorization', async () => {
  const f = fixture(), h = httpFixture(f), a = await f.login(), b = await f.login('subject-b');
  await serve(h.app, async url => {
    const path = url + '/api/v1/auth/session';
    const spoofed = { 'x-user-id': 'user-b', 'x-client-id': 'client-b', 'x-entity-id': 'client-b',
      Cookie: 'agro-session=' + b.token };
    const own = await fetch(path, { headers: { ...spoofed, Authorization: 'Bearer ' + a.token } });
    assert.equal(own.status, 200); assert.equal((await own.json()).cliente.cliente_id, 'client-a');
    const denied = await fetch(path, { headers: spoofed }); assert.equal(denied.status, 401); await denied.text();
    const body = await fetch(url + '/api/v1/auth/logout', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: b.token }) });
    assert.equal(body.status, 400); await body.text(); assert.equal(f.calls.revokeSession, undefined);
    assert.equal(JSON.stringify(h.logs).includes(b.token), false);
  });
});

test('C12: thrown strings, unexpected objects and nested exceptions never reach auth responses or log sinks', async () => {
  const f = fixture(), h = httpFixture(f), secret = 'PRIVATE_NESTED_AUTH_PAYLOAD';
  const failures = [secret, { error: { credential: secret, MONGODB_URI: secret, otherClient: 'PRIVATE_CLIENT_B' } },
    new Error(secret, { cause: new Error(secret) }), new Proxy({}, { get() { throw new Error(secret); }, getPrototypeOf() { throw new Error(secret); } })];
  await serve(h.app, async url => {
    for (const failure of failures) {
      const attempt = await f.service.challenge(); f.hooks.verify = async () => { throw failure; };
      const credential = f.assertion(attempt);
      const response = await fetch(url + '/api/v1/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: secret },
        body: JSON.stringify({ provider: 'google', credential, challenge_id: attempt.challengeId }) });
      assert.equal(response.status, 503); assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = await response.text(), logs = JSON.stringify(h.logs);
      for (const value of [secret, 'PRIVATE_CLIENT_B', credential, attempt.nonce, attempt.challengeId]) {
        assert.equal(body.includes(value), false); assert.equal(logs.includes(value), false);
      }
    }
    delete f.hooks.verify; assert.ok((await f.login()).token);
  });
});

test('C13: logout after authentication but before authorization rejects the pending client capability', async () => {
  const f = fixture(), login = await f.login(), identity = await f.service.authorization.authenticate(login.token);
  await f.service.logout(login.token);
  await assert.rejects(f.service.authorization.authorize(identity), code('UNAUTHENTICATED'));
  assert.throws(() => f.service.authorization.assertIdentity(identity), code('UNAUTHENTICATED'));
  await assert.rejects(f.context(login.token), code('UNAUTHENTICATED'));
});

test('C14: an aborted HTTP login never responds with a token; an already claimed attempt stays consumed', async () => {
  const f = fixture(), entered = barrier(), release = barrier(), closed = barrier(), completed = barrier();
  const h = httpFixture(f, row => { if (row.event === 'request.finish' && row.outcome === 'aborted') closed.resolve(); });
  const attempt = await f.service.challenge();
  f.hooks.insertSession = async () => { entered.resolve(); await release.promise; };
  f.hooks.findById = async () => { completed.resolve(); };
  await serve(h.app, async url => {
    const abort = new AbortController();
    const request = fetch(url + '/api/v1/auth/login', { method: 'POST', signal: abort.signal, headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'google', credential: f.assertion(attempt), challenge_id: attempt.challengeId }) });
    const outcome = Promise.allSettled([request]);
    await entered.promise; abort.abort(); await closed.promise; release.resolve(); await completed.promise;
    // Drain promise continuations after the controlled port completed, without a timed sleep.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await outcome)[0].status, 'rejected');
    assert.equal(f.sessions.size, 1); // Unreachable secret, expires normally; no retry reissues it.
    await assert.rejects(f.service.login(f.assertion(attempt), attempt.challengeId), code('UNAUTHENTICATED'));
    assert.ok([...f.challenges.values()].every(row => row.consumedAt !== null));
    assert.equal(JSON.stringify(h.logs).includes(attempt.nonce), false);
  });
});
