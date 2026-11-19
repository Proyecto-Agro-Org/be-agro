import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mongo, type Connection } from 'mongoose';
import { digestSecret } from '../../src/auth/session-security.js';
import { createSessionService } from '../../src/services/session.service.js';
import { createIdentityCatalogueAdministration } from '../../src/services/identity-catalogue-admin.service.js';
import { createAssociatedTelemetryPlanner } from '../../src/repositories/associated-telemetry.planner.js';
import { deviceAssociationSchema } from '../../src/telemetry/association.schemas.js';
import type { AssociationReadPort } from '../../src/telemetry/association.contracts.js';
import type { CatalogueUserDocument, CatalogueClientDocument } from '../../src/models/identity-catalogue.models.js';
import type { IdentityCatalogueAdministrationStore } from '../../src/auth/identity-catalogue-admin.contracts.js';
import { realPorts, collectionNames } from './resources.js';
import { raceProcesses } from './processes.js';

export interface CaseResult { id: string; status: 'passed' | 'failed'; evidence?: unknown }
const failure = (code: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === code;
const duplicate = (error: unknown) => error instanceof mongo.MongoServerError && error.code === 11000;
const audience = '123-local-audit.apps.googleusercontent.com';
export async function runDatabaseCases(connection: Connection, record: (result: CaseResult) => void) {
  const db = connection.db!, p = await realPorts(connection);
  let at = Date.now() + 600000; // Logical expiry tests remain physically ahead of TTL clock.
  async function test(id: string, action: () => Promise<unknown>) {
    try { const evidence = await action(); record({ id, status: 'passed', ...(evidence === undefined ? {} : { evidence }) }); }
    catch { record({ id, status: 'failed' }); throw new Error('DB02_CASE_FAILED_' + id); }
  }
  const principal = (id: string, clientId = 'client-a') => ({ id, issuer: 'https://accounts.google.com' as const,
    subject: 'synthetic-' + id, name: 'Synthetic DB02', email: id + '@example.invalid', clientId });
  function service(subject: string, realm: 'test' | 'preview' = 'test') {
    return createSessionService({ repository: p.repository, catalogue: p.catalogue,
      verifier: { async verify() { return { status: 'verified', identity: { issuer: 'https://accounts.google.com', subject } }; } } },
    { realm, audience, allowedOrigins: ['http://127.0.0.1:3000'], challengeTtlMs: 60000, absoluteTtlMs: 600000, idleTtlMs: 60000 }, () => at);
  }
  async function login(id: string) { const s = service('synthetic-' + id), attempt = await s.challenge(); return { s, session: await s.login('synthetic-not-google', attempt.challengeId) }; }
  await test('R01-index-inventory', async () => {
    const indexes = [];
    for (const name of collectionNames) indexes.push({ collection: name, indexes: await db.collection(name).listIndexes().toArray() });
    for (const name of ['auth_user_id_unique', 'auth_principal_unique', 'auth_client_id_unique', 'auth_session_digest_unique', 'db02_device_unique'])
      assert.ok(indexes.some(c => c.indexes.some(i => i.name === name && i.unique === true)));
    assert.ok(indexes.every(c => c.indexes.every(i => i.collation === undefined || i.collation.locale === 'simple')));
    return indexes;
  });
  await test('R02-controlled-create-and-unique', async () => {
    for (const id of ['client-a', 'client-b']) await p.admin.createClient({ id, name: 'Synthetic ' + id });
    for (const id of ['user-a', 'race-user', 'expiry-user', 'pending-user']) await p.admin.createUser(principal(id));
    await p.admin.createUser(principal('user-b', 'client-b'));
    await assert.rejects(p.admin.createUser({ ...principal('duplicate-user'), subject: 'synthetic-user-a' }), failure('CONFLICT'));
    await assert.rejects(p.admin.createClient({ id: 'client-a', name: 'duplicate' }), failure('CONFLICT'));
    const users = db.collection<CatalogueUserDocument>('db02_auth_users'), row = await users.findOne({ id: 'user-a' }); assert.ok(row);
    await assert.rejects(users.insertOne({ ...row, _id: 'test:other-id', id: 'other-id' }), duplicate);
    const clients = db.collection<CatalogueClientDocument>('db02_auth_clients');
    await clients.insertOne({ _id: 'test:CLIENT-A', realm: 'test', id: 'CLIENT-A', name: 'Case-sensitive', active: true, securityVersion: 0, updatedAt: new Date(at) });
    assert.equal(await clients.countDocuments({ realm: 'test', id: 'client-a' }), 1);
    assert.equal(await clients.countDocuments({ realm: 'test', id: 'CLIENT-A' }), 1);
  });
  await test('R03-server-bson-validation', async () => {
    for (const value of [null, ['bad'], 5]) await assert.rejects(db.collection('db02_auth_users').updateOne({ id: 'user-a', realm: 'test' }, { $set: { subject: value } }),
      (error: unknown) => error instanceof mongo.MongoServerError && error.code === 121);
    await assert.rejects(db.collection('db02_auth_users').updateOne({ id: 'user-a', realm: 'test' }, { $unset: { subject: '' } }),
      (error: unknown) => error instanceof mongo.MongoServerError && error.code === 121);
  });
  await test('R04-two-process-cas', async () => raceProcesses({ operation: 'cas' }));
  await test('R05-cas-conflict-A-B-A', async () => {
    const old = await login('user-a');
    await p.admin.changeMembership({ userId: 'user-a', expectedVersion: 0, clientId: 'client-b' });
    await p.admin.changeMembership({ userId: 'user-a', expectedVersion: 1, clientId: 'client-a' });
    await assert.rejects(p.admin.changeMembership({ userId: 'user-a', expectedVersion: 0, clientId: 'client-b' }), failure('CONFLICT'));
    await assert.rejects(old.s.authorization.authenticate(old.session.token));
    assert.equal((await p.administration.findUser('user-a'))?.securityVersion, 2);
  });
  await test('R06-two-process-challenge-and-replay', async () => {
    const digest = digestSecret(randomBytes(32).toString('hex')), nonce = digestSecret(randomBytes(32).toString('hex'));
    await p.repository.insertChallenge({ realm: 'test', digest, nonceDigest: nonce, audience, expiresAt: at + 60000, consumedAt: null });
    const result = await raceProcesses({ operation: 'claim', digest, nonce, at });
    assert.equal(await p.repository.consumeChallenge(digest, nonce, 'test', at), false);
    await assert.rejects(p.repository.insertChallenge({ realm: 'test', digest, nonceDigest: nonce, audience, expiresAt: at + 60000, consumedAt: null }));
    const malformed = digestSecret('synthetic-malformed-null');
    await p.repository.insertChallenge({ realm: 'test', digest: malformed, nonceDigest: nonce, audience, expiresAt: at + 60000, consumedAt: null });
    await db.collection('db02_auth_challenges').updateOne({ realm: 'test', digest: malformed }, { $set: { consumedAt: [null] } });
    assert.equal(await p.repository.consumeChallenge(malformed, nonce, 'test', at), false);
    return result;
  });
  await test('R07-challenge-expiry-before-ttl', async () => {
    const digest = digestSecret('synthetic-expiry'), nonce = digestSecret('synthetic-nonce');
    await p.repository.insertChallenge({ realm: 'test', digest, nonceDigest: nonce, audience, expiresAt: at + 1000, consumedAt: null });
    assert.equal(await p.repository.consumeChallenge(digest, nonce, 'test', at + 1000), false);
    assert.equal(await db.collection('db02_auth_challenges').countDocuments({ digest, realm: 'test' }), 1);
  });
  await test('R08-session-hash-touch-logout', async () => {
    const { s, session } = await login('user-b');
    const record = await p.repository.findSessionByDigest(digestSecret(session.token), 'test'); assert.ok(record);
    await assert.rejects(p.repository.insertSession({ ...record, id: randomBytes(32).toString('hex') }));
    const raw = await db.collection('db02_auth_sessions').findOne({ digest: digestSecret(session.token) });
    assert.equal(JSON.stringify(raw).includes(session.token), false);
    at += 1000;
    await s.authorization.authenticate(session.token);
    assert.ok((await p.repository.findSessionByDigest(record.digest, 'test'))!.idleExpiresAt > record.idleExpiresAt);
    await s.logout(session.token); await s.logout(session.token);
    await assert.rejects(s.authorization.authenticate(session.token));
    assert.equal(await p.repository.touchSession(record.id, 'test', at, at + 60000), null);
  });
  await test('R09-idle-and-absolute-expiry-before-ttl', async () => {
    const idle = await login('expiry-user'); at += 60000;
    await assert.rejects(idle.s.authorization.authenticate(idle.session.token));
    assert.equal(await db.collection('db02_auth_sessions').countDocuments({ digest: digestSecret(idle.session.token) }), 1);
    const absolute = await login('expiry-user');
    for (let i = 0; i < 19; i++) { at += 30000; await absolute.s.authorization.authenticate(absolute.session.token); }
    at += 30000;
    await assert.rejects(absolute.s.authorization.authenticate(absolute.session.token));
    assert.equal(await db.collection('db02_auth_sessions').countDocuments({ digest: digestSecret(absolute.session.token) }), 1);
  });
  await test('R10-disable-reactivate-and-realm', async () => {
    const old = await login('user-a');
    await p.admin.setUserActive({ userId: 'user-a', expectedVersion: 2, active: false });
    await assert.rejects(old.s.authorization.authenticate(old.session.token));
    await p.admin.setUserActive({ userId: 'user-a', expectedVersion: 3, active: true });
    await assert.rejects(old.s.authorization.authenticate(old.session.token));
    const current = await login('user-a');
    const preview = await realPorts(connection, 'preview');
    assert.equal(await preview.repository.findSessionByDigest(digestSecret(current.session.token), 'preview'), null);
    assert.equal(await preview.catalogue.findById('user-a'), null);
    await p.admin.setClientActive({ clientId: 'client-a', expectedVersion: 0, active: false });
    await assert.rejects(current.s.authorization.authenticate(current.session.token));
    await p.admin.setClientActive({ clientId: 'client-a', expectedVersion: 1, active: true });
    await assert.rejects(current.s.authorization.authenticate(current.session.token));
    await p.admin.changeMembership({ userId: 'user-a', expectedVersion: 4, clientId: 'client-a' });
    await assert.rejects(current.s.authorization.authenticate(current.session.token));
  });
  await test('R11-pending-revocation-checkpoint', async () => {
    await p.admin.changeMembership({ userId: 'pending-user', expectedVersion: 0, clientId: 'client-a' });
    const old = await login('pending-user');
    const injected = createIdentityCatalogueAdministration({ store: p.administration,
      invalidator: { realm: 'test', async revokeBeforeVersion() { throw new Error('synthetic-failure'); } } }, 'test');
    const result = await injected.invalidateUser({ userId: 'pending-user', expectedVersion: 1 });
    assert.equal(result.revocation, 'pending');
    await assert.rejects(old.s.authorization.authenticate(old.session.token));
    const stored = await p.administration.findUser('pending-user'); assert.ok(stored);
    const retry = await p.admin.retryRevocation({ userId: stored.id, version: stored.securityVersion });
    assert.equal(retry.revocation, 'confirmed');
    assert.equal((await p.admin.retryRevocation({ userId: stored.id, version: stored.securityVersion })).revocation, 'confirmed');
    const lostResponse = createIdentityCatalogueAdministration({ invalidator: p.invalidator, store: {
      ...p.administration, async replaceUser(before, after) {
        const replaced = await p.administration.replaceUser(before, after); assert.equal(replaced, true);
        throw new Error('synthetic-response-lost-after-real-CAS');
      },
    } }, 'test');
    await assert.rejects(lostResponse.invalidateUser({ userId: stored.id, expectedVersion: stored.securityVersion }));
    const recovered = await p.administration.findUser(stored.id); assert.ok(recovered);
    assert.equal(recovered.securityVersion, stored.securityVersion + 1);
    assert.equal((await p.admin.retryRevocation({ userId: recovered.id, version: recovered.securityVersion })).revocation, 'confirmed');
    // Deliberately violate the trusted-port contract only in this fault test.
    const voidStore = { ...p.administration, async insertClient(row: Parameters<typeof p.administration.insertClient>[0]) {
      await p.administration.insertClient(row); return undefined;
    } } as unknown as IdentityCatalogueAdministrationStore;
    const noReceipt = createIdentityCatalogueAdministration({ store: voidStore, invalidator: p.invalidator }, 'test');
    await assert.rejects(noReceipt.createClient({ id: 'void-receipt', name: 'Synthetic' }), failure('INTERNAL_ERROR'));
    assert.ok(await p.administration.findClient('void-receipt'));
    const wrongReceipt = createIdentityCatalogueAdministration({ store: p.administration, invalidator: {
      realm: 'test', async revokeBeforeVersion(realm, userId, beforeVersion, time) {
        return { ...await p.invalidator.revokeBeforeVersion(realm, userId, beforeVersion, time), realm: 'preview' };
      },
    } }, 'test');
    const invalidReceipt = await wrongReceipt.invalidateUser({ userId: recovered.id, expectedVersion: recovered.securityVersion });
    assert.equal(invalidReceipt.revocation, 'pending');
    assert.equal((await p.admin.retryRevocation({ userId: recovered.id, version: invalidReceipt.checkpoint.beforeVersion })).revocation, 'confirmed');
    return { fault: 'injected port failures/receipts after real writes; not real network loss', checkpointRecovered: true };
  });
  await test('R12-temporal-planner-real-storage', async () => {
    const source = { sourceId: 'synthetic-source', clockId: 'synthetic-clock', deviceKind: 'mqtt-clientid' as const,
      deviceField: 'clientid' as const, authenticatedIdentity: true, verifiedTemporalAttribution: true };
    const device = { kind: 'mqtt-clientid' as const, value: 'technical-a' };
    const association = { id: 'window-a', revision: 0, realm: 'test', clientId: 'client-a', fieldId: 'field-a', areaId: 'area-a', sensorId: 'logical-a',
      sourceId: source.sourceId, clockId: source.clockId, device, validFrom: 100, validTo: 500, attribution: 'verified' as const };
    const windows = db.collection('db02_business_associations'), raw = db.collection('db02_ingest_measurements'), devices = db.collection('db02_ingest_devices');
    await windows.insertMany([association, { ...association, id: 'window-b', clientId: 'client-b', fieldId: 'field-b', areaId: 'area-b', sensorId: 'logical-b', validFrom: 500, validTo: null }]);
    await devices.insertMany([{ sourceId: source.sourceId, clientid: 'technical-a' }, { sourceId: source.sourceId, clientid: 'technical-b' }]);
    await assert.rejects(devices.insertOne({ sourceId: source.sourceId, clientid: 'technical-a' }), duplicate);
    await raw.insertMany([{ clientid: 'technical-a', _receivedAt: new Date(300), timestamp: '2999-01-01', cliente_id: 'forged-b' },
      { clientid: 'technical-a', _receivedAt: new Date(500), timestamp: '1900-01-01', cliente_id: 'forged-a' },
      { clientid: 'technical-b', _receivedAt: new Date(300) }, { clientid: ['technical-a'], _receivedAt: new Date(300) },
      { clientid: 'technical-a', _receivedAt: [new Date(300)] }, { clientid: 'technical-a', _receivedAt: new Date(50) }]);
    const ports = { associations: {
      async findForSensor(q) {
        const rows = await windows.find({ realm: q.realm, clientId: q.clientId, fieldId: q.fieldId, areaId: q.areaId, sensorId: q.sensorId,
          validFrom: { $lt: q.to }, $or: [{ validTo: null }, { validTo: { $gt: q.from } }] }).limit(q.limit).toArray();
        return { complete: rows.length < q.limit, records: rows.map(({ _id, ...row }) => deviceAssociationSchema.parse(row)) };
      },
      async findForDevice(q) {
        const rows = await windows.find({ realm: q.realm, sourceId: q.sourceId, 'device.kind': q.device.kind, 'device.value': q.device.value,
          validFrom: { $lt: q.to }, $or: [{ validTo: null }, { validTo: { $gt: q.from } }] }).limit(q.limit).toArray();
        return { complete: rows.length < q.limit, records: rows.map(({ _id, ...row }) => deviceAssociationSchema.parse(row)) };
      },
    } satisfies AssociationReadPort, devices: { async findExact(q: { sourceId: string; device: typeof device; limit: 2 }) {
      const rows = await devices.find({ sourceId: q.sourceId, clientid: q.device.value }).limit(q.limit).toArray();
      return rows.map(row => ({ sourceId: q.sourceId, device: q.device, recordId: { kind: 'object-id' as const, value: row._id.toHexString() } }));
    } } };
    for (const client of ['a', 'b']) {
      const { s, session } = await login('user-' + client), context = await s.authorization.authorize(await s.authorization.authenticate(session.token));
      const planner = createAssociatedTelemetryPlanner(s, context, ports, { realm: 'test', sources: [source] }, () => at);
      const request = { fieldId: 'field-' + client, areaId: 'area-' + client, sensorId: 'logical-' + client, from: 0, to: 1000, limit: 10 };
      const plans = await planner.history(request); assert.equal(plans.length, 1);
      const rows = await raw.find(plans[0].filter).sort(plans[0].sort).limit(plans[0].limit).toArray();
      assert.equal(rows.length, 1); assert.equal(rows[0]._receivedAt.getTime(), client === 'a' ? 300 : 500);
      assert.deepEqual(await planner.history({ ...request, fieldId: client === 'a' ? 'field-b' : 'field-a' }), []);
      const denied = createAssociatedTelemetryPlanner(s, context, ports, { realm: 'test', sources: [{ ...source, verifiedTemporalAttribution: false }] }, () => at);
      await assert.rejects(denied.history(request), failure('FORBIDDEN'));
      assert.deepEqual(await planner.history({ ...request, sensorId: 'unassigned' }), []);
    }
    assert.notEqual(association.clientId, device.value); assert.notEqual(association.sensorId, device.value);
    return { syntheticProvenanceOnly: true, bothClientsRows: 1, lateUnverified: 'denied' };
  });
  await test('R13-literal-upsert-and-size-bound', async () => {
    const devices = db.collection('db02_ingest_devices'), raw = db.collection('db02_ingest_measurements');
    const body = { cliente_id: 'untrusted-commercial', nested: { $where: 'synthetic-not-code' }, _lastSeen: 'forged' };
    await devices.updateOne({ sourceId: 'synthetic-source', clientid: 'technical-a' }, [{ $replaceWith: { $mergeObjects: [
      '$$ROOT', { $literal: body }, { clientid: 'technical-a', _lastSeen: new Date(at) }] } }], { upsert: true });
    const row = await devices.findOne({ sourceId: 'synthetic-source', clientid: 'technical-a' }); assert.ok(row);
    assert.equal(row.nested.$where, 'synthetic-not-code'); assert.ok(row._lastSeen instanceof Date);
    assert.equal(row.cliente_id, 'untrusted-commercial'); // Demonstrates risk, not a mitigation in IoT.
    await assert.rejects(raw.insertOne({ clientid: 'oversized', payload: 'x'.repeat(17 * 1024 * 1024) }));
    assert.equal(await raw.countDocuments({ clientid: 'oversized' }), 0);
    return { operator: 'stored as literal', businessField: 'untrusted field persisted; never authorization', size: 'BSON/driver bound, not IoT 1mb HTTP limit' };
  });
  await test('R14-native-index-missing-null-and-types', async () => {
    const devices = db.collection('db02_ingest_devices');
    await devices.insertOne({ sourceId: 'edge-missing' });
    await assert.rejects(devices.insertOne({ sourceId: 'edge-missing', clientid: null }), duplicate);
    await devices.insertMany([{ sourceId: 'edge-types', clientid: 7 }, { sourceId: 'edge-types', clientid: '7' }]);
    assert.equal(await devices.countDocuments({ sourceId: 'edge-types' }), 2);
    await assert.rejects(devices.insertOne({ sourceId: 'synthetic-source', clientid: ['technical-a'] }), duplicate);
    return { warning: 'unique index does not establish schema or trustworthy identity; scalar guards still required' };
  });
  await test('R15-connection-loss-fail-closed', async () => {
    // Existing connection is closed by runner after this final test as well.
    await connection.close();
    await assert.rejects(p.administration.findUser('user-a'), failure('DEPENDENCY_UNAVAILABLE'));
    return { fault: 'explicit client close; not network partition or failover' };
  });
}
