import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { Connection } from 'mongoose';
import { validateDb02Request, verifyOwnedDocker } from './agro-db02/guard.js';
import { connectOwned } from './agro-db02/resources.js';
import { businessCollections, provisionBusinessCollections } from '../src/models/business.models.js';
import { defineIdentityCatalogueModels } from '../src/models/identity-catalogue.models.js';
import { catalogueCollectionValidators } from '../src/models/identity-catalogue.validators.js';
import { validateAuthenticationPersistenceConfig } from '../src/config/authentication-persistence.js';
import { createMongooseIdentityCatalogueStore } from '../src/repositories/mongoose-identity-catalogue.store.js';
import { createMongooseBusinessRepository } from '../src/repositories/business.repository.js';
import { createBusinessService } from '../src/services/business.service.js';
import { createAuthorizationService } from '../src/services/authorization.service.js';
const prefix = 'agro_business_be10', names = businessCollections(prefix);
const scope = { realm: 'test', clientId: 'client-A' }, other = { realm: 'test', clientId: 'client-B' };
const input = { name: 'Campo sintético', description: null };
const code = (expected: string) => (e: unknown) => typeof e === 'object' && e !== null && 'code' in e && e.code === expected;
async function main() {
  const request = validateDb02Request(process.env); verifyOwnedDocker(request);
  if (request.topology !== 'single-node-replica-set') throw new Error('BE10 requires disposable replica set');
  const database = 'agro_db02_test_' + request.runId, results: { name: string; status: string }[] = [];
  let connection: Connection | undefined, second: Connection | undefined, owned = false;
  const timer = setTimeout(() => { console.error('BE10_DEADLINE'); process.exit(1); }, 150000);
  async function check(name: string, fn: () => Promise<void>) {
    try { await fn(); results.push({ name, status: 'passed' }); console.log('PASS ' + name); }
    catch (e) { results.push({ name, status: 'failed' }); throw e; }
  }
  try {
    connection = await connectOwned(request, database); const db = connection.db!;
    assert.equal((await db.listCollections().toArray()).length, 0); owned = true;
    const info = await db.command({ buildInfo: 1 });
    await provisionBusinessCollections(connection, prefix);
    const authConfig = validateAuthenticationPersistenceConfig({ realm: 'test', collectionPrefix: 'agro_auth_be10' });
    const models = defineIdentityCatalogueModels(connection, authConfig);
    for (const [kind, model] of Object.entries(models)) {
      await db.createCollection(model.collection.name, { validator: catalogueCollectionValidators[kind as 'users' | 'clients'], validationLevel: 'strict', validationAction: 'error', collation: { locale: 'simple' } });
      await model.createIndexes();
    }
    // This fixture is not a production sensor model or a policy default.
    const dependencies = db.collection('be10_synthetic_dependencies'); await db.createCollection(dependencies.collectionName);
    const dependencyPort = {
      async inspect(s: typeof scope, fieldId: string, areaId: string, session: import('mongoose').ClientSession) {
        return await dependencies.findOne({ ...s, fieldId, areaId }, { session }) ? 'blocked' as const : 'clear' as const;
      },
      async inspectField(s: typeof scope, fieldId: string, session: import('mongoose').ClientSession) {
        return await dependencies.findOne({ ...s, fieldId }, { session }) ? 'blocked' as const : 'clear' as const;
      },
    };
    const catalogue = await createMongooseIdentityCatalogueStore(connection, authConfig);
    for (const id of ['client-A', 'client-B']) await catalogue.administration.insertClient({ id, name: 'Synthetic ' + id, active: true, securityVersion: 0, updatedAt: Date.now() });
    const repository = await createMongooseBusinessRepository({ connection, prefix, dependencies: dependencyPort });
    second = await connectOwned(request, database);
    const peer = await createMongooseBusinessRepository({ connection: second, prefix, dependencies: dependencyPort });
    const authorization = createAuthorizationService({
      verifier: { async verify(token) { return { status: 'verified', subject: token, sessionReference: token, expiresAt: Date.now() + 60000 }; } },
      identities: { async resolve(p) { return { userId: p.subject, active: true }; } },
      memberships: { async resolve(id) { return { clientId: id, active: true }; } },
      sessions: { async inspect() { return { status: 'active', expiresAt: Date.now() + 60000 }; }, async revoke() {} },
    }, { source: 'synthetic-be10' });
    const service = createBusinessService({ repository, authorization, catalogue: catalogue.store, realm: 'test' });
    const context = await authorization.authorize(await authorization.authenticate('client-A'));
    await check('M01 catalogue reused with public current-client DTO', async () => {
      assert.deepEqual(await service.current(context), { cliente_id: 'client-A', nombre: 'Synthetic client-A', activo: true, campos_url: '/api/v1/campos' });
    });
    await check('M02 unique indexes and strict BSON validation', async () => {
      const f = await repository.createField(scope, input), row = await db.collection(names.fields).findOne({ id: f.id }); assert.ok(row);
      await assert.rejects(db.collection(names.fields).insertOne({ ...row, _id: 'duplicate-id' } as never), (e: unknown) => typeof e === 'object' && e !== null && 'code' in e && e.code === 11000);
      await assert.rejects(db.collection(names.areas).insertOne({ bogus: 'invalid' }), (e: unknown) => typeof e === 'object' && e !== null && 'code' in e && e.code === 121);
    });
    const field = await service.createField(context, input);
    await check('M03 field reads and writes are client-scoped', async () => {
      assert.equal((await repository.getField(scope, field.id)).id, field.id);
      await assert.rejects(repository.getField(other, field.id), code('RESOURCE_NOT_FOUND'));
      await assert.rejects(repository.patchField(other, field.id, { name: 'forged', version: 0 }), code('RESOURCE_NOT_FOUND'));
      await assert.rejects(repository.createArea(other, field.id, input), code('RESOURCE_NOT_FOUND'));
      assert.equal((await repository.getField(scope, field.id)).name, input.name);
    });
    await check('M04 two connections CAS yields one successful update', async () => {
      const r = await Promise.allSettled([repository.patchField(scope, field.id, { description: 'first', version: 0 }), peer.patchField(scope, field.id, { description: 'second', version: 0 })]);
      assert.equal(r.filter(x => x.status === 'fulfilled').length, 1); assert.equal(r.filter(x => x.status === 'rejected' && code('CONFLICT')(x.reason)).length, 1);
      const after = await repository.getField(scope, field.id); assert.equal(after.version, 1); assert.equal(after.name, input.name);
    });
    await check('M05 stable bounded pagination excludes foreign client', async () => {
      await repository.createField(other, input); await repository.createField(scope, input);
      const first = await repository.listFields(scope, { limit: 1 }); assert.ok(first.next);
      const rest = await repository.listFields(scope, { limit: 100, after: first.next }); assert.ok(rest.rows.length > 0);
      assert.ok(rest.rows.every(r => r.id > first.rows[0].id && r.clientId === scope.clientId));
    });
    const area = await repository.createArea(scope, field.id, input);
    await check('M06 area relation, partial update and foreign scope', async () => {
      assert.equal((await repository.getArea(scope, field.id, area.id)).fieldId, field.id);
      assert.equal((await repository.listAreas(scope, field.id, { limit: 10 })).rows.length, 1);
      await assert.rejects(repository.getArea(other, field.id, area.id), code('RESOURCE_NOT_FOUND'));
      const changed = await repository.patchArea(scope, field.id, area.id, { description: 'partial', version: 0 }); assert.equal(changed.name, input.name); assert.equal(changed.version, 1);
    });
    await check('M07 dependencies block deactivation without cascade', async () => {
      await assert.rejects(repository.deactivateField(scope, field.id, 1), code('CONFLICT'));
      const row = await dependencies.insertOne({ ...scope, fieldId: field.id, areaId: area.id });
      await assert.rejects(repository.deactivateArea(scope, field.id, area.id, 1), code('CONFLICT'));
      assert.equal((await repository.getArea(scope, field.id, area.id)).active, true); await dependencies.deleteOne({ _id: row.insertedId });
      await repository.deactivateArea(scope, field.id, area.id, 1); assert.equal((await db.collection(names.areas).findOne({ id: area.id }))?.active, false);
      await assert.rejects(repository.deactivateField(scope, field.id, 1), code('CONFLICT'));
    });
    await check('M08 unknown dependency evidence blocks both deactivations', async () => {
      const unknown = await createMongooseBusinessRepository({ connection: connection!, prefix }); const f = await repository.createField(scope, input);
      await assert.rejects(unknown.deactivateField(scope, f.id, 0), code('DEPENDENCY_UNAVAILABLE'));
      const a = await repository.createArea(scope, f.id, input); await assert.rejects(unknown.deactivateArea(scope, f.id, a.id, 0), code('DEPENDENCY_UNAVAILABLE'));
    });
    await check('M09 create-area versus field-deactivation serializes safely', async () => {
      for (let i = 0; i < 5; i++) {
        const f = await repository.createField(scope, input);
        const r = await Promise.allSettled([repository.createArea(scope, f.id, input), peer.deactivateField(scope, f.id, 0)]);
        assert.equal(r.filter(x => x.status === 'fulfilled').length, 1);
        const stored = await db.collection(names.fields).findOne({ id: f.id });
        assert.equal(await db.collection(names.areas).countDocuments({ fieldId: f.id }), stored?.active ? 1 : 0);
      }
    });
    await check('M10 valid soft deactivation preserves document and rejects foreign delete', async () => {
      const f = await repository.createField(scope, input); await assert.rejects(repository.deactivateField(other, f.id, 0), code('RESOURCE_NOT_FOUND'));
      await repository.deactivateField(scope, f.id, 0); assert.equal((await db.collection(names.fields).findOne({ id: f.id }))?.active, false);
      await assert.rejects(repository.getField(scope, f.id), code('RESOURCE_NOT_FOUND'));
    });
    await check('M11 missing index blocks existing and new repositories', async () => {
      await db.collection(names.fields).dropIndex('business_id_unique'); await assert.rejects(repository.createField(scope, input), code('DEPENDENCY_UNAVAILABLE'));
      await assert.rejects(createMongooseBusinessRepository({ connection: connection!, prefix }), code('DEPENDENCY_UNAVAILABLE'));
      await db.collection(names.fields).createIndex({ realm: 1, id: 1 }, { unique: true, name: 'business_id_unique', collation: { locale: 'simple' } });
    });
    await check('M12 unavailable connection is sanitized', async () => {
      await second!.close(); await assert.rejects(peer.getField(scope, field.id), e => code('DEPENDENCY_UNAVAILABLE')(e) && !String(e).includes('mongodb'));
    });
    await check('M13 regressing clock cannot corrupt deactivation dates', async () => {
      const f = await repository.createField(scope, input);
      const lagging = await createMongooseBusinessRepository({ connection: connection!, prefix, dependencies: dependencyPort, now: () => 1 });
      await assert.rejects(lagging.deactivateField(scope, f.id, 0), code('DEPENDENCY_UNAVAILABLE'));
      assert.equal((await repository.getField(scope, f.id)).active, true);
      assert.equal((await repository.getField(scope, f.id)).version, 0);
    });
    const indexes = Object.fromEntries(await Promise.all(Object.values(names).map(async name => [name, await db.collection(name).listIndexes().toArray()])));
    writeFileSync('.local-evidence/be10-mongodb.json', JSON.stringify({ mongoVersion: info.version, topology: request.topology, docker: verifyOwnedDocker(request), run: request.runId, results, indexes,
      limitations: ['single node; no failover proof', 'synthetic identity and dependency port', 'no Atlas or production mapping'] }, null, 2));
  } finally {
    clearTimeout(timer);
    if (owned && connection?.readyState === 1) { verifyOwnedDocker(request); await connection.db!.dropDatabase(); }
    await second?.close(); await connection?.close();
    console.log(JSON.stringify({ event: 'be10-summary', passed: results.filter(r => r.status === 'passed').length, failed: results.filter(r => r.status === 'failed').length }));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error('BE10_LOCAL_FAILED', e); process.exitCode = 1; });
}
