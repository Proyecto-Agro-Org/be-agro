import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { Mongoose } from 'mongoose';
import express from 'express';
import { once } from 'node:events';
import { createMongooseSessionRepository } from '../dist/src/repositories/mongoose-session.repository.js';
import { defineAuthenticationModels } from '../dist/src/models/authentication.models.js';
import { validateAuthenticationPersistenceConfig } from '../dist/src/config/authentication-persistence.js';
import { createIdentityCatalogue } from '../dist/src/repositories/identity-catalogue.repository.js';
import { createSessionService } from '../dist/src/services/session.service.js';
import { digestSecret, newOpaqueSecret, sameDigest } from '../dist/src/auth/session-security.js';
import { validateAuthenticationConfig } from '../dist/src/config/authentication.js';
import { createHttpInfrastructure } from '../dist/src/http/infrastructure.js';
import { createSessionRouter } from '../dist/src/routes/session.routes.js';
import { validateLocalAuditRequest } from '../dist/scripts/audit-auth-mongodb-local.js';
import { spawnSync } from 'node:child_process';

const diagnostic = 'PRIVATE_AUTH_DB_URI_OR_CREDENTIAL';
const code = expected => e => e.code === expected && !inspect(e, { showHidden: true }).includes(diagnostic);
const clone = value => value === null || value === undefined ? null : structuredClone(value);
function barrier() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const config = extra => validateAuthenticationPersistenceConfig({ collectionPrefix: 'agro_auth_offline', realm: 'test', ...extra });
const dateValue = value => value instanceof Date ? value.getTime() : value;

// Test-only command simulator below real Mongoose casting/queries. It is NOT a
// MongoDB server and does not prove distributed atomicity, indexes or durability.
function database() {
  const collections = new Map(), commands = [], hooks = {}, failures = new Set(); let now = 100000;
  const indexes = new Map(); let acknowledgements = true;
  async function before(kind, name, command) {
    commands.push({ kind, name, ...clone(command) });
    if (failures.has(kind)) throw new Error(diagnostic, { cause: { MONGODB_URI: diagnostic } });
    await hooks[kind]?.(name, command);
  }
  function expression(value, row) {
    if (value && Object.hasOwn(value, '$literal')) return value.$literal;
    if (value === '$$NOW') return new Date(now);
    if (typeof value === 'string' && value.startsWith('$')) return row[value.slice(1)];
    if (value?.$type) { const v = expression(value.$type, row); return v === undefined ? 'missing' : v === null ? 'null' : v instanceof Date ? 'date' : Array.isArray(v) ? 'array' : typeof v; }
    if (value?.$eq) return expression(value.$eq[0], row) === expression(value.$eq[1], row);
    if (value?.$gt) return dateValue(expression(value.$gt[0], row)) > dateValue(expression(value.$gt[1], row));
    if (value?.$and) return value.$and.every(v => expression(v, row));
    return value;
  }
  function matches(row, filter) {
    return Object.entries(filter).every(([key, condition]) => {
      if (key === '$expr') return expression(condition, row) === true;
      const value = row[key];
      if (condition && typeof condition === 'object' && !(condition instanceof Date)) return Object.entries(condition).every(([operator, target]) => {
        // Mongo query $type also matches array elements; aggregation $type above
        // distinguishes an array from a scalar null. Test both semantics.
        if (operator === '$type') return target === 10 && Object.hasOwn(row, key) && (value === null || (Array.isArray(value) && value.includes(null)));
        const candidates = Array.isArray(value) ? value : [value];
        if (operator === '$gt') return candidates.some(v => dateValue(v) > dateValue(target));
        if (operator === '$gte') return candidates.some(v => dateValue(v) >= dateValue(target));
        if (operator === '$lte') return candidates.some(v => dateValue(v) <= dateValue(target));
        throw new Error('Unsupported simulator operator: ' + operator);
      });
      return Array.isArray(value) ? value.some(v => dateValue(v) === dateValue(condition)) : dateValue(value) === dateValue(condition);
    });
  }
  function update(row, change) {
    for (const [key, value] of Object.entries(change.$set ?? {})) row[key] = clone(value);
    for (const [key, value] of Object.entries(change.$max ?? {})) if (dateValue(value) > dateValue(row[key])) row[key] = clone(value);
  }
  function collection(name) {
    if (!collections.has(name)) collections.set(name, new Map());
    const rows = collections.get(name);
    return {
      collectionName: name,
      listIndexes(options) { return { async toArray() {
        await before('listIndexes', name, { options });
        return clone(indexes.get(name) ?? [{ name: '_id_', key: { _id: 1 } },
          ...(name.endsWith('_sessions') ? [{ key: { realm: 1, digest: 1 }, unique: true }] : [])]);
      } }; },
      async insertOne(document, options) {
        await before('insertOne', name, { document, options });
        if (rows.has(document._id) || (name.endsWith('_sessions') && [...rows.values()].some(row => row.realm === document.realm && row.digest === document.digest))) throw Object.assign(new Error(diagnostic), { code: 11000 });
        rows.set(document._id, clone(document));
        return { acknowledged: acknowledgements, insertedId: document._id };
      },
      async findOne(filter, options) {
        await before('findOne', name, { filter, options });
        const row = [...rows.values()].find(row => matches(row, filter));
        if (!row) return null;
        const projection = options?.projection;
        return projection ? Object.fromEntries(Object.keys(projection).filter(key => projection[key] && Object.hasOwn(row, key)).map(key => [key, clone(row[key])])) : clone(row);
      },
      async updateOne(filter, change, options) {
        await before('updateOne', name, { filter, change, options });
        const row = [...rows.values()].find(row => matches(row, filter));
        if (row) update(row, change);
        await hooks.afterUpdate?.(name, row);
        return { acknowledged: acknowledgements, matchedCount: row ? 1 : 0, modifiedCount: row ? 1 : 0 };
      },
      async findOneAndUpdate(filter, change, options) {
        await before('findOneAndUpdate', name, { filter, change, options });
        const row = [...rows.values()].find(row => matches(row, filter));
        if (!row) return null;
        update(row, change); return clone(row);
      },
      async createIndex() { throw new Error('DDL must not execute.'); },
    };
  }
  function connection() {
    const mongoose = new Mongoose(), connection = mongoose.createConnection();
    // No URI/client/socket. Only tests install this fake driver database handle.
    connection.db = { collection, async createCollection() { throw new Error('DDL must not execute.'); } };
    connection.readyState = 1;
    return connection;
  }
  return { connection, collections, commands, hooks, failures, indexes, now: () => now, advance: ms => { now += ms; },
    setAcknowledged: value => { acknowledgements = value; } };
}
async function setup(db = database(), options = config()) {
  const connection = db.connection(), repository = await createMongooseSessionRepository(connection, options);
  return { db, connection, repository, models: defineAuthenticationModels(connection, options) };
}
const challenge = extra => ({ digest: digestSecret('challenge'), nonceDigest: digestSecret('nonce'), realm: 'test',
  audience: '123-offline.apps.googleusercontent.com', expiresAt: 101000, consumedAt: null, ...extra });
const session = extra => ({ id: 'session-a', digest: digestSecret('session-token'), realm: 'test', userId: 'user-a', clientId: 'client-a',
  securityVersion: 1, createdAt: 100000, absoluteExpiresAt: 110000, idleExpiresAt: 102000, revokedAt: null, ...extra });

test('P01: persistence configuration has no collection fallback and rejects unsafe namespaces or limits', () => {
  assert.ok(Object.isFrozen(config()));
  for (const extra of [{ collectionPrefix: undefined }, { collectionPrefix: 'mediciones' }, { collectionPrefix: 'agro_auth_bad.name' },
    { realm: 'unknown' }, { operationTimeoutMs: 0 }, { operationTimeoutMs: 5001 }, { secret: diagnostic }]) assert.throws(() => config(extra), TypeError);
});

test('P02: models are auth-only, declare Date TTL proposals and never auto-create or connect on import/definition', () => {
  const mongoose = new Mongoose(), connection = mongoose.createConnection();
  const models = defineAuthenticationModels(connection, config());
  assert.equal(connection.readyState, 0); assert.equal(connection.getClient(), undefined);
  for (const model of Object.values(models)) for (const setting of ['autoCreate', 'autoIndex', 'bufferCommands']) assert.equal(model.schema.get(setting), false);
  assert.equal(models.challenges.schema.path('expiresAt').instance, 'Date');
  assert.ok(models.sessions.schema.indexes().some(([key, options]) => key.absoluteExpiresAt === 1 && options.expireAfterSeconds === 0));
  assert.equal(defineAuthenticationModels(connection, config()), models);
});

test('P03: repository requires an explicit open connection and existing complete unique indexes', async () => {
  await assert.rejects(createMongooseSessionRepository(new Mongoose().createConnection(), config()), code('DEPENDENCY_UNAVAILABLE'));
  for (const extra of [{ unique: false }, { sparse: true }, { partialFilterExpression: { active: true } }, { hidden: true }, { collation: { locale: 'en' } }]) {
    const db = database(); db.indexes.set('agro_auth_offline_sessions', [{ key: { _id: 1 } }, { key: { realm: 1, digest: 1 }, unique: true, ...extra }]);
    await assert.rejects(setup(db), code('DEPENDENCY_UNAVAILABLE'));
    assert.ok(db.commands.every(c => c.kind === 'listIndexes'));
  }
});

test('P04: real Mongoose mapping round-trips BSON Dates to logical epochs without exposing persistence fields', async () => {
  const f = await setup(), s = session(), c = challenge();
  await f.repository.insertSession(s); await f.repository.insertChallenge(c);
  const found = await f.repository.findSessionByDigest(s.digest, s.realm);
  assert.deepEqual(found, s); assert.deepEqual(await f.repository.findSessionById(s.id, s.realm), s);
  assert.deepEqual(await f.repository.findChallenge(c.digest, c.realm), c); assert.equal(Object.hasOwn(found, '_id'), false);
  const stored = [...f.db.collections.get('agro_auth_offline_sessions').values()][0];
  assert.ok(stored.createdAt instanceof Date); assert.equal(stored._id, 'test:session-a'); assert.equal(Object.hasOwn(stored, '__v'), false);
  for (const command of f.db.commands.filter(c => c.kind === 'insertOne')) assert.equal(command.options.writeConcern.w, 'majority');
});

test('P05: duplicate session ID/digest and challenge digest fail safely instead of overwriting', async () => {
  const f = await setup(), s = session(), c = challenge(); await f.repository.insertSession(s); await f.repository.insertChallenge(c);
  await assert.rejects(f.repository.insertSession({ ...s, digest: digestSecret('other') }), code('DEPENDENCY_UNAVAILABLE'));
  await assert.rejects(f.repository.insertSession({ ...s, id: 'other' }), code('DEPENDENCY_UNAVAILABLE'));
  await assert.rejects(f.repository.insertChallenge(c), code('DEPENDENCY_UNAVAILABLE'));
  assert.equal(f.db.collections.get('agro_auth_offline_sessions').size, 1);
});

test('P06: token plaintext, operator objects and malformed records cannot reach persistence commands', async () => {
  const f = await setup(), before = f.db.commands.length;
  for (const key of [newOpaqueSecret(), { $ne: null }, '', null]) await assert.rejects(f.repository.findSessionByDigest(key, 'test'), code('INTERNAL_ERROR'));
  await assert.rejects(f.repository.insertSession({ ...session(), token: diagnostic }), code('INTERNAL_ERROR'));
  await assert.rejects(f.repository.insertSession(session({ revokedAt: 100000 })), code('INTERNAL_ERROR'));
  assert.equal(f.db.commands.length, before);
});

test('P07: consume requires exact realm/nonce, explicit BSON null and expiry at client/server snapshots', async () => {
  const f = await setup(), c = challenge(); await f.repository.insertChallenge(c);
  assert.equal(await f.repository.consumeChallenge(c.digest, digestSecret('wrong'), 'test', 100000), false);
  assert.equal(await f.repository.consumeChallenge(c.digest, c.nonceDigest, 'preview', 100000), false);
  f.db.advance(1000);
  assert.equal(await f.repository.consumeChallenge(c.digest, c.nonceDigest, 'test', 100000), false);
  const row = [...f.db.collections.get('agro_auth_offline_challenges').values()][0]; delete row.consumedAt;
  assert.equal(await f.repository.consumeChallenge(c.digest, c.nonceDigest, 'test', 100000), false);
});

test('P08: two independent Mongoose workers sharing the simulated store have one atomic claim winner', async () => {
  const db = database(), a = await setup(db), b = await setup(db), c = challenge(), gate = barrier(); let entered = 0;
  await a.repository.insertChallenge(c);
  db.hooks.updateOne = async () => { if (++entered === 2) gate.resolve(); await gate.promise; };
  const results = await Promise.all([a.repository.consumeChallenge(c.digest, c.nonceDigest, 'test', 100000), b.repository.consumeChallenge(c.digest, c.nonceDigest, 'test', 100000)]);
  assert.deepEqual(results.sort(), [false, true]);
  assert.equal(await b.repository.consumeChallenge(c.digest, c.nonceDigest, 'test', 100000), false);
});

test('P09: lost acknowledgement after a committed claim cannot enable a retry', async () => {
  const f = await setup(), c = challenge(); await f.repository.insertChallenge(c); let fail = true;
  f.db.hooks.afterUpdate = async () => { if (fail) { fail = false; throw new Error(diagnostic); } };
  await assert.rejects(f.repository.consumeChallenge(c.digest, c.nonceDigest, 'test', 100000), code('DEPENDENCY_UNAVAILABLE'));
  assert.equal(await f.repository.consumeChallenge(c.digest, c.nonceDigest, 'test', 100000), false);
});

test('P10: touch uses atomic max, returns the updated snapshot and never extends beyond absolute', async () => {
  const f = await setup(), s = session(); await f.repository.insertSession(s);
  assert.equal((await f.repository.touchSession(s.id, 'test', 100000, 103000)).idleExpiresAt, 103000);
  assert.equal((await f.repository.touchSession(s.id, 'test', 100000, 102500)).idleExpiresAt, 103000);
  assert.equal(await f.repository.touchSession(s.id, 'test', 100000, 110001), null);
  const cmd = f.db.commands.find(c => c.kind === 'findOneAndUpdate');
  assert.ok(cmd.change.$max.idleExpiresAt instanceof Date); assert.equal(cmd.options.upsert, false); assert.equal(cmd.options.returnDocument, 'after');
});

test('P11: revocation is first-write idempotent, visible to another worker and does not affect another token', async () => {
  const db = database(), a = await setup(db), b = await setup(db), s = session();
  await a.repository.insertSession(s); await a.repository.insertSession(session({ id: 'other', digest: digestSecret('other') }));
  await a.repository.revokeSession(s.digest, 'test', 100000); await b.repository.revokeSession(s.digest, 'test', 100001);
  assert.equal((await b.repository.findSessionByDigest(s.digest, 'test')).revokedAt, 100000);
  assert.equal((await a.repository.findSessionById('other', 'test')).revokedAt, null);
  assert.equal(await b.repository.touchSession(s.id, 'test', 100000, 103000), null);
});

test('P12: logout racing with a queued touch cannot clear revocation or resurrect activity', async () => {
  const f = await setup(), s = session(), entered = barrier(), release = barrier(); await f.repository.insertSession(s);
  f.db.hooks.findOneAndUpdate = async () => { entered.resolve(); await release.promise; };
  const pending = f.repository.touchSession(s.id, 'test', 100000, 103000); await entered.promise;
  await f.repository.revokeSession(s.digest, 'test', 100000); release.resolve(); assert.equal(await pending, null);
});

test('P13: expiration while a command is queued is checked against server NOW, not just stale client time', async () => {
  const f = await setup(), s = session(), entered = barrier(), release = barrier(); await f.repository.insertSession(s);
  f.db.hooks.findOneAndUpdate = async () => { entered.resolve(); await release.promise; };
  const pending = f.repository.touchSession(s.id, 'test', 100000, 103000); await entered.promise;
  f.db.advance(2000); release.resolve(); assert.equal(await pending, null);
});

test('P14: negative write acknowledgements and driver errors fail closed without leaking diagnostics', async () => {
  const f = await setup(); f.db.setAcknowledged(false);
  await assert.rejects(f.repository.insertSession(session()), code('DEPENDENCY_UNAVAILABLE'));
  const c = challenge(); f.db.setAcknowledged(true); await f.repository.insertChallenge(c); f.db.setAcknowledged(false);
  await assert.rejects(f.repository.consumeChallenge(c.digest, c.nonceDigest, 'test', 100000), code('INTERNAL_ERROR'));
  f.db.failures.add('findOne'); await assert.rejects(f.repository.findSessionById('session-a', 'test'), code('DEPENDENCY_UNAVAILABLE'));
});

test('P15: a lost connection rejects immediately without buffering, automatic reconnect or commands', async () => {
  const f = await setup(), before = f.db.commands.length; f.connection.readyState = 0;
  await assert.rejects(f.repository.findSessionById('session-a', 'test'), code('DEPENDENCY_UNAVAILABLE'));
  assert.equal(f.db.commands.length, before); assert.equal(f.connection.getClient(), undefined);
});

test('P16: malformed stored BSON or identifiers never cross the repository boundary', async () => {
  const f = await setup(), s = session(); await f.repository.insertSession(s);
  const row = [...f.db.collections.get('agro_auth_offline_sessions').values()][0]; row.createdAt = 100000;
  await assert.rejects(f.repository.findSessionByDigest(s.digest, 'test'), code('INTERNAL_ERROR'));
  row.createdAt = new Date(100000); row._id = 'forged';
  await assert.rejects(f.repository.findSessionByDigest(s.digest, 'test'), code('INTERNAL_ERROR'));
});

test('P17: realm and collection namespaces isolate identical token digests and prevent foreign revocation', async () => {
  const db = database(), a = await setup(db), b = await setup(db, config({ realm: 'preview' })), isolated = await setup(db, config({ collectionPrefix: 'agro_auth_other' }));
  const s = session(); await a.repository.insertSession(s); await b.repository.insertSession(session({ realm: 'preview' }));
  assert.equal(await isolated.repository.findSessionByDigest(s.digest, 'test'), null);
  await a.repository.revokeSession(s.digest, 'preview', 100000);
  assert.equal((await b.repository.findSessionByDigest(s.digest, 'preview')).revokedAt, null);
  assert.equal(await a.repository.findSessionByDigest(s.digest, 'preview'), null);
});

test('P18 audit regression: arrays containing null are not an unconsumed or unrevoked scalar state', async () => {
  const f = await setup(), c = challenge(), s = session(); await f.repository.insertChallenge(c); await f.repository.insertSession(s);
  const challengeRow = [...f.db.collections.get('agro_auth_offline_challenges').values()][0];
  challengeRow.consumedAt = [null];
  assert.equal(await f.repository.consumeChallenge(c.digest, c.nonceDigest, 'test', 100000), false);
  const sessionRow = [...f.db.collections.get('agro_auth_offline_sessions').values()][0];
  sessionRow.revokedAt = [null, new Date(99999)];
  assert.equal(await f.repository.touchSession(s.id, 'test', 100000, 103000), null);
  await f.repository.revokeSession(s.digest, 'test', 100000);
  assert.ok(Array.isArray(sessionRow.revokedAt));
});

test('P19: index metadata read failures do not create collections or yield a partially ready repository', async () => {
  const db = database(); db.failures.add('listIndexes');
  await assert.rejects(setup(db), code('DEPENDENCY_UNAVAILABLE'));
  assert.ok(db.commands.every(c => c.kind === 'listIndexes'));
  db.failures.clear(); assert.ok((await setup(db)).repository);
});

function catalogueFixture() {
  const users = new Map(), clients = new Map(), calls = [], hooks = {};
  for (const suffix of ['a', 'b']) {
    clients.set('client-' + suffix, { id: 'client-' + suffix, name: 'Client ' + suffix, active: true, updatedAt: 100000 });
    users.set('user-' + suffix, { id: 'user-' + suffix, issuer: 'https://accounts.google.com', subject: 'subject-' + suffix,
      name: 'User ' + suffix, email: suffix + '@example.invalid', active: true, securityVersion: 1, updatedAt: 100000,
      membership: { clientId: 'client-' + suffix, active: true, updatedAt: 100000 } });
  }
  async function before(kind, query) { calls.push({ kind, query, frozen: Object.isFrozen(query) }); await hooks[kind]?.(query); }
  const store = {
    async findUserByPrincipal(query) { await before('principal', query); return clone([...users.values()].find(u => u.issuer === query.issuer && u.subject === query.subject)); },
    async findUserById(query) { await before('user', query); return clone(users.get(query.userId)); },
    async findClientById(query) { await before('client', query); return clone(clients.get(query.clientId)); },
  };
  return { store, users, clients, calls, hooks, catalogue: createIdentityCatalogue(store, 'test') };
}

test('K01: catalogue requires all explicit store methods and a known realm without a memory fallback', () => {
  assert.throws(() => createIdentityCatalogue({}, 'test'), TypeError);
  const f = catalogueFixture(); assert.throws(() => createIdentityCatalogue(f.store, 'unknown'), TypeError);
  assert.deepEqual(Object.keys(f.catalogue).sort(), ['findById', 'findByPrincipal']);
});

test('K02: catalogue resolves stable issuer/sub with scoped frozen queries, never email', async () => {
  const f = catalogueFixture(); f.users.get('user-b').email = f.users.get('user-a').email;
  const result = await f.catalogue.findByPrincipal({ issuer: 'https://accounts.google.com', subject: 'subject-b' });
  assert.equal(result.id, 'user-b'); assert.equal(result.client.id, 'client-b');
  assert.deepEqual(f.calls.map(c => c.query), [{ issuer: 'https://accounts.google.com', subject: 'subject-b', realm: 'test' }, { realm: 'test', clientId: 'client-b' }]);
  assert.ok(f.calls.every(c => c.frozen)); assert.equal(Object.hasOwn(result, 'membership'), false); assert.equal(Object.hasOwn(result, 'updatedAt'), false);
});

test('K03: unknown, inactive, unassigned and revoked memberships never receive an invented client', async () => {
  const f = catalogueFixture(); assert.equal(await f.catalogue.findById('unknown'), null);
  const user = f.users.get('user-a'); user.active = false;
  assert.equal((await f.catalogue.findById(user.id)).client, null); user.active = true; user.membership.active = false;
  assert.equal((await f.catalogue.findById(user.id)).client, null); user.membership = null;
  assert.equal((await f.catalogue.findById(user.id)).client, null);
  assert.equal(f.calls.filter(c => c.kind === 'client').length, 0);
});

test('K04: missing or disabled clients remain unauthorized rather than falling back to another client', async () => {
  const f = catalogueFixture(); f.clients.get('client-a').active = false;
  assert.equal((await f.catalogue.findById('user-a')).client.active, false);
  f.clients.delete('client-a'); assert.equal((await f.catalogue.findById('user-a')).client, null);
});

test('K05: mismatched user/client/principal output and operator inputs fail closed', async () => {
  const f = catalogueFixture(); const before = f.calls.length;
  await assert.rejects(f.catalogue.findById({ $ne: null }), code('INTERNAL_ERROR')); assert.equal(f.calls.length, before);
  const badPrincipal = createIdentityCatalogue({ ...f.store, async findUserByPrincipal() { return clone(f.users.get('user-b')); } }, 'test');
  await assert.rejects(badPrincipal.findByPrincipal({ issuer: 'https://accounts.google.com', subject: 'subject-a' }), code('INTERNAL_ERROR'));
  const badUser = createIdentityCatalogue({ ...f.store, async findUserById() { return clone(f.users.get('user-b')); } }, 'test');
  await assert.rejects(badUser.findById('user-a'), code('INTERNAL_ERROR'));
  const badClient = createIdentityCatalogue({ ...f.store, async findClientById() { return clone(f.clients.get('client-b')); } }, 'test');
  await assert.rejects(badClient.findById('user-a'), code('INTERNAL_ERROR'));
});

test('K06: catalogue output is immutable, validated and strips storage details through explicit projection', async () => {
  const f = catalogueFixture(), result = await f.catalogue.findById('user-a');
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.client));
  f.users.get('user-a').name = 'Changed'; assert.equal(result.name, 'User a');
  f.users.get('user-a').membership.updatedAt = 100001;
  await assert.rejects(f.catalogue.findById('user-a'), code('INTERNAL_ERROR'));
  f.users.get('user-a').membership.updatedAt = 100000; f.users.get('user-a').privateToken = diagnostic;
  await assert.rejects(f.catalogue.findById('user-a'), code('INTERNAL_ERROR'));
});

test('K07: catalogue storage exceptions and hostile thrown values are sanitized and later calls recover', async () => {
  const f = catalogueFixture();
  for (const failure of [diagnostic, { credential: diagnostic }, new Error(diagnostic, { cause: diagnostic }), new Proxy({}, { getPrototypeOf() { throw new Error(diagnostic); } })]) {
    f.hooks.user = async () => { throw failure; };
    await assert.rejects(f.catalogue.findById('user-a'), code('DEPENDENCY_UNAVAILABLE'));
  }
  delete f.hooks.user; assert.equal((await f.catalogue.findById('user-a')).client.id, 'client-a');
});

test('K08: trusted catalogue methods are snapshotted and inactive clients are re-read on each call', async () => {
  const f = catalogueFixture(); f.store.findUserById = async () => { throw new Error(diagnostic); };
  assert.equal((await f.catalogue.findById('user-a')).client.active, true);
  f.clients.get('client-a').active = false; assert.equal((await f.catalogue.findById('user-a')).client.active, false);
});

async function integration(db = database()) {
  const storage = await setup(db), catalogue = catalogueFixture();
  const verifier = { async verify(credential, nonceDigest) {
    let payload; try { payload = JSON.parse(credential); } catch { return { status: 'invalid' }; }
    return typeof payload.nonce === 'string' && sameDigest(digestSecret(payload.nonce), nonceDigest) ?
      { status: 'verified', identity: { issuer: 'https://accounts.google.com', subject: payload.subject } } : { status: 'invalid' };
  } };
  const options = validateAuthenticationConfig({ realm: 'test', audience: '123-offline.apps.googleusercontent.com',
    allowedOrigins: ['https://frontend.example.invalid'], challengeTtlMs: 1000, absoluteTtlMs: 10000, idleTtlMs: 2000 });
  const make = repository => createSessionService({ repository, catalogue: catalogue.catalogue, verifier }, options, db.now);
  const service = make(storage.repository);
  async function login(subject = 'subject-a', target = service) {
    const attempt = await target.challenge(); return target.login(JSON.stringify({ subject, nonce: attempt.nonce }), attempt.challengeId);
  }
  const context = async (token, target = service) => target.authorization.authorize(await target.authorization.authenticate(token));
  return { ...storage, ...catalogue, service, make, login, context };
}

test('I01: BE09.2 service integrates Mongoose persistence and catalogue with A/B scoped resource isolation', async () => {
  const f = await integration(), a = await f.login(), b = await f.login('subject-b'), queries = [];
  const port = { async findResource(query) { queries.push(query); return query.id === 'field-' + query.clientId.slice(-1) ? { ...query } : null; } };
  const own = f.service.authorization.createScopedRepository(await f.context(a.token), port);
  assert.equal((await own.getField('field-a')).clientId, 'client-a');
  await assert.rejects(own.getField('field-b'), code('RESOURCE_NOT_FOUND'));
  assert.equal((await f.context(b.token)).clientId, 'client-b'); assert.ok(queries.every(q => q.clientId === 'client-a'));
  const persisted = JSON.stringify([...f.db.collections.values()].flatMap(rows => [...rows.values()]));
  assert.equal(persisted.includes(a.token), false); assert.equal(persisted.includes(b.token), false);
});

test('I02: membership change, disablement and client revocation invalidate old sessions on new admission', async () => {
  for (const change of [f => { const u = f.users.get('user-a'); u.membership.clientId = 'client-b'; u.securityVersion++; },
    f => { f.users.get('user-a').active = false; }, f => { f.clients.get('client-a').active = false; },
    f => { f.users.get('user-a').membership.active = false; }]) {
    const f = await integration(), login = await f.login(); change(f);
    await assert.rejects(f.context(login.token), code('UNAUTHENTICATED'));
  }
});

test('I03: two service workers share durable-port revocation and a single successful login per challenge', async () => {
  const f = await integration(), worker = await setup(f.db), second = f.make(worker.repository);
  const attempt = await f.service.challenge(), credential = JSON.stringify({ subject: 'subject-a', nonce: attempt.nonce });
  const results = await Promise.allSettled([f.service.login(credential, attempt.challengeId), second.login(credential, attempt.challengeId)]);
  const winners = results.filter(r => r.status === 'fulfilled'); assert.equal(winners.length, 1);
  const token = winners[0].value.token; await second.logout(token);
  await assert.rejects(f.context(token), code('UNAUTHENTICATED'));
});

test('I04: unknown identity or missing client does not persist a session through the complete new composition', async () => {
  const f = await integration(); await assert.rejects(f.login('unknown-subject'), code('FORBIDDEN'));
  f.users.get('user-a').membership = null; await assert.rejects(f.login(), code('FORBIDDEN'));
  assert.equal(f.db.collections.get('agro_auth_offline_sessions').size, 0);
});

test('I05: isolated HTTP composition persists/revokes sessions and keeps DB diagnostics and internal fields out of logs/responses', async () => {
  const f = await integration(), logs = [], origin = 'https://frontend.example.invalid';
  const http = createHttpInfrastructure({ logger: record => { logs.push(record); }, errorResponse: error => ({ error: { code: error.code, message: error.message } }) });
  const app = express(); app.disable('x-powered-by'); http.protectApplication(app);
  app.use(http.requestContext, http.securityHeaders);
  app.use('/api/v1/auth', createSessionRouter(f.service, http, { async admit() { return true; } }));
  app.use(http.notFound, http.errorHandler, http.terminalErrorHandler);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const base = 'http://127.0.0.1:' + server.address().port + '/api/v1/auth';
    const post = (path, body, token) => fetch(base + path, { method: 'POST', headers: { Origin: origin,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const attemptResponse = await post('/google/challenge', {}); assert.equal(attemptResponse.status, 200);
    const attempt = await attemptResponse.json(), credential = JSON.stringify({ subject: 'subject-a', nonce: attempt.nonce });
    const login = await post('/login', { provider: 'google', credential, challenge_id: attempt.challenge_id }); assert.equal(login.status, 200);
    const issued = await login.json();
    const current = await fetch(base + '/session', { headers: { Authorization: 'Bearer ' + issued.token, Cookie: diagnostic } });
    assert.equal(current.status, 200); const dto = await current.json(); assert.equal(dto.cliente.cliente_id, 'client-a');
    for (const key of ['_id', 'digest', 'securityVersion', 'membership']) assert.equal(JSON.stringify(dto).includes('"' + key + '"'), false);
    f.db.failures.add('findOne'); const failed = await fetch(base + '/session', { headers: { Authorization: 'Bearer ' + issued.token } });
    assert.equal(failed.status, 503); const failure = await failed.text(); assert.equal(failed.headers.get('cache-control'), 'no-store');
    f.db.failures.clear(); const logout = await post('/logout', undefined, issued.token); assert.equal(logout.status, 204); assert.equal(await logout.text(), '');
    const revoked = await fetch(base + '/session', { headers: { Authorization: 'Bearer ' + issued.token } }); assert.equal(revoked.status, 401); await revoked.text();
    const sink = JSON.stringify(logs);
    for (const secret of [issued.token, attempt.nonce, attempt.challenge_id, credential, diagnostic, 'a@example.invalid']) {
      assert.equal(sink.includes(secret), false); assert.equal(failure.includes(secret), false);
    }
    assert.ok(logs.every(record => typeof record.requestId === 'string'));
  } finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('A01 regression: array realm cannot cause a foreign-realm session to be revoked', async () => {
  const db = database(), own = await setup(db), foreign = await setup(db, config({ realm: 'preview' }));
  const row = session({ realm: 'preview' }); await foreign.repository.insertSession(row);
  const stored = [...db.collections.get('agro_auth_offline_sessions').values()][0]; stored.realm = ['preview', 'test'];
  await own.repository.revokeSession(row.digest, 'test', 100000);
  assert.equal(stored.revokedAt, null);
});

test('A02 regression: array nonce/digest does not satisfy a scalar challenge claim', async () => {
  for (const field of ['realm', 'digest', 'nonceDigest']) {
    const f = await setup(), c = challenge(); await f.repository.insertChallenge(c);
    const row = [...f.db.collections.get('agro_auth_offline_challenges').values()][0]; row[field] = [row[field], row[field]];
    assert.equal(await f.repository.consumeChallenge(c.digest, c.nonceDigest, 'test', 100000), false, field);
    assert.equal(row.consumedAt, null);
  }
});

test('A03 regression: malformed createdAt or id cannot be touched before output validation rejects it', async () => {
  for (const field of ['createdAt', 'id']) {
    const f = await setup(), s = session(); await f.repository.insertSession(s);
    const row = [...f.db.collections.get('agro_auth_offline_sessions').values()][0]; row[field] = [row[field]];
    const oldIdle = row.idleExpiresAt.getTime();
    assert.equal(await f.repository.touchSession(s.id, 'test', 100000, 103000), null, field);
    assert.equal(row.idleExpiresAt.getTime(), oldIdle);
  }
});

test('A04 regression: truthy non-boolean insert acknowledgements never count as confirmed writes', async () => {
  for (const acknowledgement of ['false', 'true', 1, {}, []]) {
    const f = await setup(); f.db.setAcknowledged(acknowledgement);
    await assert.rejects(f.repository.insertSession(session()), code('DEPENDENCY_UNAVAILABLE'));
    await assert.rejects(f.repository.insertChallenge(challenge()), code('DEPENDENCY_UNAVAILABLE'));
  }
});

test('A05: missing, empty-array, array-null and already-used states never mutate challenge/session rows', async () => {
  for (const value of [undefined, [], [null], [null, null], '', new Date(99999)]) {
    const f = await setup(), c = challenge(), s = session(); await f.repository.insertChallenge(c); await f.repository.insertSession(s);
    const ch = [...f.db.collections.get('agro_auth_offline_challenges').values()][0], row = [...f.db.collections.get('agro_auth_offline_sessions').values()][0];
    if (value === undefined) { delete ch.consumedAt; delete row.revokedAt; } else { ch.consumedAt = clone(value); row.revokedAt = clone(value); }
    const snapshot = clone([ch, row]);
    assert.equal(await f.repository.consumeChallenge(c.digest, c.nonceDigest, 'test', 100000), false);
    assert.equal(await f.repository.touchSession(s.id, 'test', 100000, 103000), null);
    await f.repository.revokeSession(s.digest, 'test', 100000);
    assert.deepEqual([ch, row], snapshot);
  }
});

test('A06: invalid BSON date fields cannot be renewed and logically expired rows remain invalid without TTL cleanup', async () => {
  for (const field of ['createdAt', 'absoluteExpiresAt', 'idleExpiresAt']) for (const value of [undefined, null, [], [new Date(100000)], 100000, 'future']) {
    const f = await setup(), s = session(); await f.repository.insertSession(s);
    const row = [...f.db.collections.get('agro_auth_offline_sessions').values()][0];
    if (value === undefined) delete row[field]; else row[field] = clone(value);
    const snapshot = clone(row); assert.equal(await f.repository.touchSession(s.id, 'test', 100000, 103000), null);
    assert.deepEqual(row, snapshot);
  }
  const f = await integration(), login = await f.login(); f.db.advance(2000);
  assert.equal(f.db.collections.get('agro_auth_offline_sessions').size, 1);
  await assert.rejects(f.context(login.token), code('UNAUTHENTICATED'));
});

test('A07: operation objects, null/empty IDs and malformed epochs fail before issuing mutation commands', async () => {
  const f = await setup(), s = session(), c = challenge(), before = f.db.commands.length;
  for (const input of [{ $ne: null }, null, '']) {
    await assert.rejects(f.repository.touchSession(input, 'test', 100000, 103000), code('INTERNAL_ERROR'));
    await assert.rejects(f.repository.consumeChallenge(c.digest, input, 'test', 100000), code('INTERNAL_ERROR'));
    await assert.rejects(f.repository.revokeSession(input, 'test', 100000), code('INTERNAL_ERROR'));
  }
  for (const at of [NaN, Infinity, -1, {}, '100000']) await assert.rejects(f.repository.touchSession(s.id, 'test', at, 103000), code('INTERNAL_ERROR'));
  assert.equal(f.db.commands.length, before);
});

test('A08: catalogue rejects multiple-client/identity arrays and propagates explicit ambiguity as a safe dependency failure', async () => {
  const f = catalogueFixture();
  for (const membership of [[], [null], [clone(f.users.get('user-a').membership), clone(f.users.get('user-b').membership)]]) {
    f.users.get('user-a').membership = membership;
    await assert.rejects(f.catalogue.findById('user-a'), code('INTERNAL_ERROR'));
  }
  const duplicate = createIdentityCatalogue({ ...f.store, async findUserByPrincipal() { return [clone(f.users.get('user-b')), clone(f.users.get('user-b'))]; } }, 'test');
  await assert.rejects(duplicate.findByPrincipal({ issuer: 'https://accounts.google.com', subject: 'subject-b' }), code('INTERNAL_ERROR'));
  const ambiguous = createIdentityCatalogue({ ...f.store, async findUserByPrincipal() { throw new Error(diagnostic); } }, 'test');
  await assert.rejects(ambiguous.findByPrincipal({ issuer: 'https://accounts.google.com', subject: 'subject-b' }), code('DEPENDENCY_UNAVAILABLE'));
});

test('A09: out-of-order activity from independent workers preserves the newer idle snapshot', async () => {
  const db = database(), a = await setup(db), b = await setup(db), s = session(), entered = barrier(), release = barrier(); let calls = 0;
  await a.repository.insertSession(s);
  db.hooks.findOneAndUpdate = async () => { if (++calls === 1) { entered.resolve(); await release.promise; } };
  const older = a.repository.touchSession(s.id, 'test', 100000, 102000); await entered.promise;
  try {
    db.advance(500); assert.equal((await b.repository.touchSession(s.id, 'test', 100500, 102500)).idleExpiresAt, 102500);
  } finally { release.resolve(); }
  assert.equal((await older).idleExpiresAt, 102500);
});

test('A10: catalogue invalidation during queued activity denies authorization but cannot cancel a separate session write', async () => {
  const f = await integration(), login = await f.login(), entered = barrier(), release = barrier(); f.db.advance(500);
  f.db.hooks.findOneAndUpdate = async () => { entered.resolve(); await release.promise; };
  const outcome = Promise.allSettled([f.context(login.token)]); await entered.promise;
  f.users.get('user-a').active = false; f.users.get('user-a').securityVersion++; release.resolve();
  assert.equal((await outcome)[0].reason.code, 'UNAUTHENTICATED');
  const row = [...f.db.collections.get('agro_auth_offline_sessions').values()][0];
  assert.equal(row.idleExpiresAt.getTime(), 102500); // Explicit cross-store consistency limitation.
});

test('A11: arbitrary nested driver failures are sanitized on read/write and recovered operations do not reuse failure', async () => {
  const f = await setup(), s = session(); await f.repository.insertSession(s);
  for (const failure of [diagnostic, { uri: diagnostic }, new Error(diagnostic, { cause: diagnostic }), new Proxy({}, { getPrototypeOf() { throw new Error(diagnostic); } })]) {
    f.db.hooks.findOne = async () => { throw failure; };
    await assert.rejects(f.repository.findSessionByDigest(s.digest, 'test'), code('DEPENDENCY_UNAVAILABLE'));
    f.db.hooks.updateOne = async () => { throw failure; };
    await assert.rejects(f.repository.revokeSession(s.digest, 'test', 100000), code('DEPENDENCY_UNAVAILABLE'));
  }
  delete f.db.hooks.findOne; delete f.db.hooks.updateOne;
  assert.equal((await f.repository.findSessionByDigest(s.digest, 'test')).revokedAt, null);
  await f.repository.revokeSession(s.digest, 'test', 100000);
});

test('A12: logical IDs beginning with dollar are treated as literals in expression guards', async () => {
  const f = await setup(), s = session({ id: '$id' }); await f.repository.insertSession(s);
  assert.equal((await f.repository.touchSession(s.id, 'test', 100000, 103000)).id, '$id');
});

test('A13: manual MongoDB probe requires an explicit attestation and rejects remote/unsafe port or replica-set values', () => {
  assert.throws(() => validateLocalAuditRequest({}), /NOT_AUTHORIZED/);
  const base = { AGRO_AUTH_LOCAL_AUDIT: 'AUTHORIZED_DISPOSABLE_LOOPBACK_ONLY' };
  for (const port of ['0', '27017/other', 'mongodb+srv://external', '1e4', '70000', 27017]) assert.throws(() => validateLocalAuditRequest({ ...base, AGRO_AUTH_LOCAL_PORT: port }), /INVALID/);
  assert.throws(() => validateLocalAuditRequest({ ...base, AGRO_AUTH_LOCAL_REPLICA_SET: 'rs/other' }), /INVALID/);
  const request = validateLocalAuditRequest({ ...base, MONGODB_URI: diagnostic });
  assert.deepEqual(request, { port: 27017, replicaSet: undefined }); assert.ok(Object.isFrozen(request));
});

test('A14: manual probe executable refuses without opt-in before any MongoDB connection and prints no URI/credentials', () => {
  const env = { ...process.env, MONGODB_URI: diagnostic }; delete env.AGRO_AUTH_LOCAL_AUDIT;
  const result = spawnSync(process.execPath, ['dist/scripts/audit-auth-mongodb-local.js'], { env, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1); assert.match(result.stderr, /NOT_COMPLETED/);
  assert.equal((result.stdout + result.stderr).includes(diagnostic), false);
  assert.equal(result.stdout.includes('local_auth_audit_scope'), false);
});
