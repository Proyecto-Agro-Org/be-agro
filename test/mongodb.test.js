import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import mongoose from 'mongoose';
import { loadMongoConfig, MongoConfigurationError } from '../dist/src/config/mongodb.js';
import {
  createMongoConnectionManager, MongoConnectionError, MongoDisconnectionError,
} from '../dist/src/infrastructure/mongodb.js';
import { createApp } from '../dist/src/app.js';

const env = { MONGODB_URI: 'mongodb://mongodb.example.invalid:27017/agro_qa' };
const secret = 'SYNTHETIC_PASSWORD_BE07';
const sensitiveUri = 'mongodb://synthetic-user:' + secret + '@mongodb.example.invalid/agro_qa';

function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

// An in-memory transport only: never calls a real Mongoose openUri/connect.
function fixture({ open, close } = {}) {
  const connection = new EventEmitter();
  connection.readyState = 0;
  const calls = { factory: 0, open: [], close: 0 };
  connection.openUri = async (uri, options) => {
    calls.open.push({ uri, options });
    connection.readyState = 2;
    if (open) await open(connection);
    connection.readyState = 1;
    return connection;
  };
  connection.close = async () => {
    calls.close++;
    connection.readyState = 3;
    if (close) await close(connection);
    connection.readyState = 0;
  };
  const manager = createMongoConnectionManager(() => { calls.factory++; return connection; });
  return { manager, calls, connection };
}

function assertSafe(error, ErrorType) {
  assert.ok(error instanceof ErrorType);
  assert.ok(!String(error).includes(secret));
  assert.ok(!String(error.stack).includes(secret));
  assert.ok(!JSON.stringify(error).includes(secret));
  assert.equal(error.cause, undefined);
  return true;
}

test('Mongo config accepts standard, replica set, IPv6 and SRV syntax without connecting', () => {
  for (const uri of [env.MONGODB_URI,
    'mongodb://node1.example.invalid:27017,node2.example.invalid:27017/agro_qa?replicaSet=qa',
    'mongodb://[::1]:27017/agro_qa',
    'mongodb+srv://cluster.example.invalid/agro_qa?retryWrites=true&w=majority']) {
    const config = loadMongoConfig({ MONGODB_URI: uri, UNRELATED_VARIABLE: 'ignored' });
    assert.equal(config.uri, uri);
    assert.equal(config.serverSelectionTimeoutMS, 5000);
    assert.deepEqual(Object.keys(config).sort(), ['serverSelectionTimeoutMS', 'uri']);
    assert.ok(Object.isFrozen(config));
  }
});

test('Mongo config rejects missing, empty and non-string URI', () => {
  for (const uri of [undefined, null, '', 12, false]) {
    assert.throws(() => loadMongoConfig({ MONGODB_URI: uri }), MongoConfigurationError);
  }
});

test('Mongo config rejects malformed protocols, hosts, ports, query options and missing database', () => {
  for (const uri of ['https://host.invalid/db', 'mongodb://', 'mongodb:///db',
    'mongodb://host.invalid', 'mongodb://host.invalid/', 'mongodb://host.invalid:bad/db',
    'mongodb+srv://host.invalid:27017/db', 'mongodb://host.invalid/db#fragment',
    ' mongodb://host.invalid/db', 'mongodb://host.invalid/bad db',
    'mongodb://host.invalid/db?unknownMongoOption=true']) {
    assert.throws(() => loadMongoConfig({ MONGODB_URI: uri }), MongoConfigurationError);
  }
});

test('Mongo timeout accepts integer milliseconds within its documented bounds', () => {
  for (const timeout of ['100', '2500', '30000']) {
    assert.equal(loadMongoConfig({ ...env, MONGODB_SERVER_SELECTION_TIMEOUT_MS: timeout })
      .serverSelectionTimeoutMS, Number(timeout));
  }
});

test('Mongo timeout rejects coercion traps, non-integers and unbounded waits', () => {
  for (const timeout of ['', ' ', '0', '-1', '99', '30001', '1.5', 'NaN', 'Infinity', '1e3', null, 5000]) {
    assert.throws(() => loadMongoConfig({ ...env, MONGODB_SERVER_SELECTION_TIMEOUT_MS: timeout }),
      MongoConfigurationError);
  }
});

test('config errors do not expose input values, Zod issues or driver causes', () => {
  assert.throws(() => loadMongoConfig({ MONGODB_URI: sensitiveUri,
    MONGODB_SERVER_SELECTION_TIMEOUT_MS: secret }), e => assertSafe(e, MongoConfigurationError));
});

test('invalid config never creates a connection and is distinct from connectivity failure', async () => {
  const { manager, calls } = fixture();
  await assert.rejects(manager.connect({}), MongoConfigurationError);
  assert.equal(calls.factory, 0);
  assert.equal(manager.getState(), 'disconnected');
});

test('successful connect applies bounded pooling, no auto creation/indexes and no buffering', async () => {
  const { manager, calls, connection } = fixture();
  assert.equal(await manager.connect(env), connection);
  assert.equal(manager.getState(), 'connected');
  assert.deepEqual(calls.open[0], { uri: env.MONGODB_URI, options: {
    serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000, maxPoolSize: 5,
    minPoolSize: 0, autoCreate: false, autoIndex: false, bufferCommands: false,
  } });
  await manager.disconnect();
});

test('concurrent callers share a single opening attempt and connected pool', async () => {
  const gate = deferred();
  const { manager, calls, connection } = fixture({ open: () => gate.promise });
  const a = manager.connect(env), b = manager.connect(env);
  assert.equal(manager.getState(), 'connecting');
  gate.resolve();
  assert.deepEqual(await Promise.all([a, b]), [connection, connection]);
  assert.equal(await manager.connect(env), connection);
  assert.equal(calls.factory, 1);
  assert.equal(calls.open.length, 1);
  await manager.disconnect();
});

test('live or opening managers reject configuration changes instead of switching databases', async () => {
  const gate = deferred();
  const { manager, calls } = fixture({ open: () => gate.promise });
  const opening = manager.connect(env);
  await assert.rejects(manager.connect({ MONGODB_URI: 'mongodb://other.example.invalid/other_db' }),
    MongoConfigurationError);
  gate.resolve(); await opening;
  await assert.rejects(manager.connect({ ...env, MONGODB_SERVER_SELECTION_TIMEOUT_MS: '1000' }),
    MongoConfigurationError);
  assert.equal(calls.open.length, 1);
  await manager.disconnect();
});

test('failed opening rejects all callers safely, cleans up and allows an explicit retry', async (t) => {
  let fail = true;
  const { manager, calls } = fixture({ open: connection => {
    if (fail) {
      const error = new Error(sensitiveUri);
      connection.emit('error', error);
      throw error;
    }
  } });
  const log = t.mock.method(console, 'error', () => {});
  const warning = t.mock.method(console, 'warn', () => {});
  const results = await Promise.allSettled([manager.connect(env), manager.connect(env)]);
  for (const result of results) { assert.equal(result.status, 'rejected'); assertSafe(result.reason, MongoConnectionError); }
  assert.equal(manager.getState(), 'error');
  assert.equal(calls.close, 1);
  assert.equal(log.mock.callCount(), 0);
  assert.equal(warning.mock.callCount(), 0);
  fail = false;
  await manager.connect(env);
  assert.equal(calls.open.length, 2);
  assert.equal(manager.getState(), 'connected');
  await manager.disconnect();
});

test('disconnect is idempotent before first use, without creating a connection', async () => {
  const { manager, calls } = fixture();
  await Promise.all([manager.disconnect(), manager.disconnect()]);
  assert.equal(manager.getState(), 'disconnected');
  assert.equal(calls.factory, 0);
});

test('disconnect waits for an in-flight opening and concurrent shutdowns share cleanup', async () => {
  const gate = deferred();
  const { manager, calls } = fixture({ open: () => gate.promise });
  const opening = manager.connect(env);
  const closeA = manager.disconnect(), closeB = manager.disconnect();
  assert.equal(manager.getState(), 'disconnecting');
  gate.resolve();
  await Promise.all([opening, closeA, closeB]);
  assert.equal(calls.close, 1);
  assert.equal(manager.getState(), 'disconnected');
});

test('a connect during shutdown waits, then opens again with the requested configuration', async () => {
  const gate = deferred();
  const { manager, calls } = fixture({ close: () => gate.promise });
  await manager.connect(env);
  const closing = manager.disconnect();
  const opening = manager.connect({ ...env, MONGODB_SERVER_SELECTION_TIMEOUT_MS: '1000' });
  gate.resolve();
  await Promise.all([closing, opening]);
  assert.equal(calls.open.length, 2);
  assert.equal(calls.open[1].options.serverSelectionTimeoutMS, 1000);
  assert.equal(manager.getState(), 'connected');
  await manager.disconnect();
});

test('disconnect failure is sanitized and subsequent cleanup fails fast without opening another pool', async () => {
  const { manager, calls } = fixture({ close: () => { throw new Error(secret); } });
  await manager.connect(env);
  await assert.rejects(manager.disconnect(), e => assertSafe(e, MongoDisconnectionError));
  assert.equal(manager.getState(), 'error');
  await assert.rejects(manager.connect(env), MongoConnectionError);
  assert.equal(calls.open.length, 1);
  await assert.rejects(manager.disconnect(), MongoDisconnectionError);
  assert.equal(calls.close, 1);
  assert.equal(manager.getState(), 'error');
});

test('failed opening with failed cleanup cannot leak a second pool on retry', async () => {
  const { manager, calls } = fixture({ open: () => { throw new Error(secret); },
    close: () => { throw new Error(secret); } });
  await assert.rejects(manager.connect(env), MongoConnectionError);
  await assert.rejects(manager.connect(env), MongoConnectionError);
  assert.equal(calls.factory, 1);
  assert.equal(calls.open.length, 1);
  await assert.rejects(manager.disconnect(), MongoDisconnectionError);
  assert.equal(calls.close, 1);
  assert.equal(manager.getState(), 'error');
});

test('transport state reflects an unexpected disconnection and allows explicit reconnection', async () => {
  const { manager, connection, calls } = fixture();
  await manager.connect(env);
  connection.readyState = 0;
  assert.equal(manager.getState(), 'disconnected');
  await manager.connect(env);
  assert.equal(calls.open.length, 2);
  assert.equal(calls.close, 1);
  await manager.disconnect();
});

test('separate managers never share connections or override caller/environment objects', async () => {
  const a = fixture(), b = fixture();
  const other = { MONGODB_URI: 'mongodb://other.example.invalid/other_db' };
  const original = { ...env };
  const [first, second] = await Promise.all([a.manager.connect(env), b.manager.connect(other)]);
  assert.notEqual(first, second);
  assert.equal(a.calls.open[0].uri, env.MONGODB_URI);
  assert.equal(b.calls.open[0].uri, other.MONGODB_URI);
  assert.deepEqual(env, original);
  await Promise.all([a.manager.disconnect(), b.manager.disconnect()]);
});

test('health remains available while the injected Mongo transport is failing', async () => {
  const { manager } = fixture({ open: () => { throw new Error(secret); } });
  await assert.rejects(manager.connect(env), MongoConnectionError);
  const server = createApp().listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '{"status":"ok"}');
  } finally {
    await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    await manager.disconnect();
  }
});

test('importing Mongo infrastructure and app never connects, creates a pool or requires env', () => {
  const uri = new URL('../dist/src/infrastructure/mongodb.js', import.meta.url).href;
  const appUri = new URL('../dist/src/app.js', import.meta.url).href;
  const program = `
    import mongoose from 'mongoose';
    import net from 'node:net';
    import dns from 'node:dns';
    mongoose.createConnection = () => { throw new Error('Unexpected connection factory'); };
    mongoose.mongo.MongoClient.prototype.connect = () => { throw new Error('Unexpected Mongo connect'); };
    net.Socket.prototype.connect = () => { throw new Error('Unexpected socket'); };
    dns.resolveSrv = () => { throw new Error('Unexpected DNS'); };
    process.env.MONGODB_URI = 'intentionally invalid';
    const {mongoConnection} = await import(${JSON.stringify(uri)});
    await import(${JSON.stringify(appUri)});
    if (mongoConnection.getState() !== 'disconnected') process.exitCode = 1;
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', program],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test('decoded database names respect forbidden characters and the UTF-8 byte limit', () => {
  for (const name of ['bad db', 'bad/db', 'bad\\db', 'bad\0db', 'bad.db', 'bad$db', 'bad"db',
    'a'.repeat(64), 'é'.repeat(32)]) {
    assert.throws(() => loadMongoConfig({ MONGODB_URI:
      'mongodb://host.example.invalid/' + encodeURIComponent(name) }), MongoConfigurationError);
  }
  for (const name of ['a'.repeat(63), 'é'.repeat(31)]) {
    assert.ok(loadMongoConfig({ MONGODB_URI:
      'mongodb://host.example.invalid/' + encodeURIComponent(name) }));
  }
});

test('encoded credentials are preserved and malformed credentials fail without disclosure', () => {
  const password = encodeURIComponent(secret + '@:/?#[]%');
  const uri = 'mongodb://synthetic-user:' + password + '@host.example.invalid/agro_qa';
  assert.equal(loadMongoConfig({ MONGODB_URI: uri }).uri, uri);
  assert.throws(() => loadMongoConfig({ MONGODB_URI:
    'mongodb://synthetic-user:' + secret + '%ZZ@host.example.invalid/agro_qa' }),
  e => assertSafe(e, MongoConfigurationError));
});

test('real Mongoose close failure rejects later shutdowns rather than waiting forever', async () => {
  const isolated = new mongoose.Mongoose();
  const connection = isolated.connection;
  let closeCalls = 0;
  // Keep real Connection.close() semantics; replace only the network boundaries.
  connection.openUri = async () => { connection.readyState = 1; return connection; };
  connection.client = { close: async () => { closeCalls++; throw new Error(secret); } };
  const manager = createMongoConnectionManager(() => connection);
  await manager.connect(env);
  await assert.rejects(manager.disconnect(), e => assertSafe(e, MongoDisconnectionError));
  assert.equal(connection.readyState, 3);
  let timer;
  try {
    const result = await Promise.race([
      manager.disconnect().then(() => 'resolved', error => {
        assertSafe(error, MongoDisconnectionError); return 'rejected';
      }),
      new Promise(resolve => { timer = setTimeout(() => resolve('pending'), 250); }),
    ]);
    assert.equal(result, 'rejected');
    await assert.rejects(manager.connect(env), MongoConnectionError);
    assert.equal(manager.getState(), 'error');
    assert.equal(closeCalls, 1);
  } finally { clearTimeout(timer); }
});

test('shutdown queued behind failed opening cannot retry or clear failed cleanup', async () => {
  const gate = deferred();
  const { manager, calls } = fixture({ open: () => gate.promise,
    close: () => { throw new Error(secret); } });
  const opening = manager.connect(env);
  const closing = manager.disconnect();
  gate.reject(new Error(secret));
  const results = await Promise.allSettled([opening, closing]);
  assert.equal(results[0].status, 'rejected');
  assertSafe(results[0].reason, MongoConnectionError);
  assert.equal(results[1].status, 'rejected');
  assertSafe(results[1].reason, MongoDisconnectionError);
  assert.equal(calls.close, 1);
  assert.equal(manager.getState(), 'error');
  await assert.rejects(manager.connect(env), MongoConnectionError);
});

test('failed close before reopening quarantines the manager even when Mongoose skips a second close', async () => {
  const connection = new mongoose.Mongoose().connection;
  let opens = 0, closes = 0;
  connection.openUri = async () => { opens++; connection.readyState = 1; return connection; };
  connection.client = { close: async () => { closes++; throw new Error(secret); } };
  const manager = createMongoConnectionManager(() => connection);
  await manager.connect(env);
  connection.readyState = 0; // Simulate transport loss, without any network.
  await assert.rejects(manager.connect(env), e => assertSafe(e, MongoConnectionError));
  await assert.rejects(manager.connect(env), MongoConnectionError);
  await assert.rejects(manager.disconnect(), MongoDisconnectionError);
  assert.equal(manager.getState(), 'error');
  assert.equal(opens, 1);
  assert.equal(closes, 1);
});
