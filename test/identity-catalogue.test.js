import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { Mongoose, mongo } from 'mongoose';
import { createMongooseIdentityCatalogueStore } from '../dist/src/repositories/mongoose-identity-catalogue.store.js';
import { defineIdentityCatalogueModels } from '../dist/src/models/identity-catalogue.models.js';
import { fromCatalogueUserDocument, toCatalogueUserDocument } from '../dist/src/repositories/identity-catalogue.mapper.js';
import { createIdentityCatalogueAdministration } from '../dist/src/services/identity-catalogue-admin.service.js';
import { createIdentityCatalogue } from '../dist/src/repositories/identity-catalogue.repository.js';
import { createMongooseSessionRepository } from '../dist/src/repositories/mongoose-session.repository.js';
import { createMongooseCatalogueSessionInvalidator } from '../dist/src/repositories/mongoose-session-invalidator.repository.js';
import { createSessionService } from '../dist/src/services/session.service.js';
import { ApplicationError } from '../dist/src/errors/application.error.js';
import { validateCatalogueAuditRequest } from '../dist/scripts/audit-catalogue-mongodb-local.js';
import { catalogueCollectionValidators } from '../dist/src/models/identity-catalogue.validators.js';
import { spawnSync } from 'node:child_process';
import { digestSecret, newOpaqueSecret } from '../dist/src/auth/session-security.js';

const options = { collectionPrefix: 'agro_auth_catalogue_test', realm: 'test', operationTimeoutMs: 1000 };
const diagnostic = 'PRIVATE_CATALOGUE_DIAGNOSTIC_OR_CREDENTIAL';
const code = expected => error => error.code === expected && !inspect(error, { showHidden: true }).includes(diagnostic);
const clone = value => value === undefined ? undefined : structuredClone(value);
const equal = (a, b) => { try { assert.deepEqual(a, b); return true; } catch { return false; } };
function barrier() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const userInput = (id = 'user-a', subject = 'subject-a', clientId = 'client-a') => ({ id, issuer: 'https://accounts.google.com', subject,
  name: 'Synthetic User', email: 'synthetic@example.invalid', clientId });

// Native command double with real Mongoose schemas. NOT a MongoDB server: these
// deterministic tests do not certify distributed indexes/atomicity/durability.
function database() {
  const rows = new Map(), commands = [], hooks = {}, indexOverrides = new Map();
  let acknowledged = true, failure;
  async function before(kind, name, details) {
    commands.push({ kind, name, ...clone(details) });
    if (failure === kind) throw new Error(diagnostic);
    await hooks[kind]?.(name, details);
  }
  const field = (row, key) => key.split('.').reduce((v, k) => v?.[k], row);
  function expression(value, row) {
    if (value && typeof value === 'object' && Object.hasOwn(value, '$literal')) return value.$literal;
    if (value === '$$NOW') return new Date(100000);
    if (typeof value === 'string' && value.startsWith('$')) return field(row, value.slice(1));
    if (value?.$and) return value.$and.every(v => expression(v, row));
    if (value?.$type) { const v = expression(value.$type, row); return v === null ? 'null' : v === undefined ? 'missing' : Array.isArray(v) ? 'array' : v instanceof Date ? 'date' : typeof v === 'number' ? 'double' : typeof v; }
    if (value?.$eq) return equal(expression(value.$eq[0], row), expression(value.$eq[1], row));
    if (value?.$in) return value.$in[1].includes(expression(value.$in[0], row));
    for (const op of ['$gt', '$gte', '$lt']) if (value?.[op]) { const a = expression(value[op][0], row), b = expression(value[op][1], row); return op === '$gt' ? a > b : op === '$gte' ? a >= b : a < b; }
    return value;
  }
  function matches(row, query) {
    return Object.entries(query).every(([key, wanted]) => {
      if (key === '$expr') return expression(wanted, row) === true;
      const actual = field(row, key);
      if (wanted && typeof wanted === 'object' && !(wanted instanceof Date)) return Object.entries(wanted).every(([op, target]) => {
        if (op === '$type') return target === 10 && (actual === null || Array.isArray(actual) && actual.includes(null));
        if (op === '$gt') return actual > target;
        if (op === '$gte') return actual >= target;
        if (op === '$lte') return actual <= target;
        if (op === '$lt') return actual < target;
        throw new Error('Unsupported test query operator '+op);
      });
      return equal(actual, wanted) || Array.isArray(actual) && actual.some(v => equal(v, wanted));
    });
  }
  function indexes(name) {
    return indexOverrides.get(name) ?? [{ key: { _id: 1 } },
      ...(name.endsWith('_users') ? [{ key: { realm: 1, id: 1 }, unique: true }, { key: { realm: 1, issuer: 1, subject: 1 }, unique: true }] : []),
      ...(name.endsWith('_clients') ? [{ key: { realm: 1, id: 1 }, unique: true }] : []),
      ...(name.endsWith('_sessions') ? [{ key: { realm: 1, digest: 1 }, unique: true }] : [])];
  }
  function collection(name) {
    if (!rows.has(name)) rows.set(name, []);
    const data = rows.get(name);
    function update(row, changes) {
      Object.assign(row, clone(changes.$set ?? {}));
      for (const [k, v] of Object.entries(changes.$max ?? {})) if (v > row[k]) row[k] = clone(v);
    }
    return {
      collectionName: name,
      listIndexes(opts) { return { async toArray() { await before('listIndexes', name, { options: opts }); return clone(indexes(name)); } }; },
      find(filter, opts) {
        let limit = Infinity;
        return { limit(n) { limit = n; return this; }, async toArray() { await before('find', name, { filter, options: opts }); return data.filter(r => matches(r, filter)).slice(0, limit).map(clone); } };
      },
      async findOne(filter, opts) {
        await before('findOne', name, { filter, options: opts }); const row = data.find(r => matches(r, filter)); if (!row) return null;
        return opts?.projection ? Object.fromEntries(Object.keys(opts.projection).filter(k => opts.projection[k] && Object.hasOwn(row, k)).map(k => [k, clone(row[k])])) : clone(row);
      },
      async insertOne(document, opts) {
        await before('insertOne', name, { document, options: opts });
        const duplicate = data.some(r => r._id === document._id || r.realm === document.realm &&
          (name.endsWith('_users') ? r.id === document.id || r.issuer === document.issuer && r.subject === document.subject :
            name.endsWith('_clients') ? r.id === document.id : name.endsWith('_sessions') && r.digest === document.digest));
        if (duplicate) throw new mongo.MongoServerError({ message: diagnostic, code: 11000 });
        data.push(clone(document)); return { acknowledged, insertedId: document._id };
      },
      async findOneAndUpdate(filter, changes, opts) {
        await before('findOneAndUpdate', name, { filter, changes, options: opts });
        const row = data.find(r => matches(r, filter)); if (!row) return null; update(row, changes); return clone(row);
      },
      async updateOne(filter, changes, opts) {
        await before('updateOne', name, { filter, changes, options: opts });const row = data.find(r => matches(r, filter));if (row) update(row, changes);
        return { acknowledged, matchedCount: row ? 1 : 0, modifiedCount: row ? 1 : 0 };
      },
      async updateMany(filter, changes, opts) {
        await before('updateMany', name, { filter, changes, options: opts });const found = data.filter(r => matches(r, filter));found.forEach(r => update(r, changes));
        return { acknowledged, matchedCount: found.length, modifiedCount: found.length };
      },
      async createIndex() { throw new Error('Unauthorized DDL'); },
    };
  }
  function connection() {
    const c = new Mongoose().createConnection(); c.db = { collection, async createCollection() { throw new Error('Unauthorized DDL'); } }; c.readyState = 1; return c;
  }
  return { rows, commands, hooks, indexOverrides, connection,
    setFailure: value => { failure = value; }, setAcknowledged: value => { acknowledged = value; } };
}
async function fixture(db = database()) {
  const connection = db.connection(); const persistence = await createMongooseIdentityCatalogueStore(connection, options);
  const sessions = await createMongooseSessionRepository(connection, options);
  const invalidator = createMongooseCatalogueSessionInvalidator(connection, options);
  let time = 100000;
  const administration = createIdentityCatalogueAdministration({ store: persistence.administration, invalidator }, 'test', () => time);
  const catalogue = createIdentityCatalogue(persistence.store, 'test');
  await administration.createClient({ id: 'client-a', name: 'Synthetic A' });
  await administration.createClient({ id: 'client-b', name: 'Synthetic B' });
  const service = createSessionService({ repository: sessions, catalogue, verifier: { async verify() {
    return { status: 'verified', identity: { issuer: 'https://accounts.google.com', subject: 'subject-a' } };
  } } }, { realm: 'test', audience: '123-offline.apps.googleusercontent.com', allowedOrigins: ['https://frontend.example.invalid'] }, () => time);
  async function login() { const c = await service.challenge(); return service.login('synthetic-verifier-input', c.challengeId); }
  async function authorize(token) { return service.authorization.authorize(await service.authorization.authenticate(token)); }
  return { db, connection, ...persistence, admin: administration, invalidator, catalogue, sessions, service, login, authorize,
    user: () => db.rows.get(options.collectionPrefix+'_users')[0], client: id => db.rows.get(options.collectionPrefix+'_clients').find(c => c.id === id), advance: n => { time += n; } };
}

test('C01 models: isolated namespace, unique principal/IDs, Date fields, no DDL/import connections', async () => {
  const connection = new Mongoose().createConnection(); const models = defineIdentityCatalogueModels(connection, options);
  assert.equal(connection.readyState, 0); assert.equal(connection.getClient(), undefined);
  assert.equal(defineIdentityCatalogueModels(connection, options), models);
  for (const m of Object.values(models)) for (const key of ['autoCreate', 'autoIndex', 'bufferCommands']) assert.equal(m.schema.get(key), false);
  assert.equal(models.users.schema.path('updatedAt').instance, 'Date');
  assert.equal(models.users.schema.indexes().filter(([,v]) => v.unique).length, 2);
  assert.equal(models.clients.schema.indexes().filter(([,v]) => v.unique).length, 1);
  assert.ok(models.users.schema.indexes().every(([,v]) => v.expireAfterSeconds === undefined));
});

test('C02 factory refuses unopened connections and partial/sparse/non-simple/missing unique indexes', async () => {
  await assert.rejects(createMongooseIdentityCatalogueStore(new Mongoose().createConnection(), options), code('DEPENDENCY_UNAVAILABLE'));
  for (const bad of [{ unique: false }, { sparse: true }, { partialFilterExpression: { active: true } }, { hidden: true }, { collation: { locale: 'en' } }, { expireAfterSeconds: 10 }]) {
    const db = database(); db.indexOverrides.set(options.collectionPrefix+'_users', [{ key: {_id:1} },{ key:{realm:1,id:1},unique:true },{key:{realm:1,issuer:1,subject:1},unique:true,...bad}]);
    await assert.rejects(createMongooseIdentityCatalogueStore(db.connection(), options), code('DEPENDENCY_UNAVAILABLE'));
    assert.ok(db.commands.every(c => c.kind === 'listIndexes'));
  }
});

test('C03 mapper round-trips Date, generations and immutable logical views without _id/realm', async () => {
  const f = await fixture(); await f.admin.createUser(userInput());
  const row = await f.store.findUserById({ realm:'test', userId:'user-a' });
  assert.equal(row.securityVersion,0); assert.equal(row.membership.clientSecurityVersion,0); assert.ok(Object.isFrozen(row.membership));
  assert.ok(f.user().updatedAt instanceof Date); assert.deepEqual(fromCatalogueUserDocument(toCatalogueUserDocument(row,'test')),row);
  assert.equal(Object.hasOwn(row,'_id'),false); assert.equal(Object.hasOwn(row,'realm'),false);
  assert.equal((await f.catalogue.findById('user-a')).client.id,'client-a');
});

test('C04 strict inputs reject absent/null/operator/type/extra fields before writes', async () => {
  const f=await fixture(); const n=f.db.commands.length;
  for(const patch of [{id:undefined},{id:null},{id:''},{id:{$ne:''}},{subject:[]},{issuer:'evil'},{email:'not-email'},{clientId:undefined},{unexpected:true}])
    await assert.rejects(f.admin.createUser({...userInput(),...patch}),code('INTERNAL_ERROR'));
  assert.equal(f.db.commands.length,n);
});

for(const [name,patch]of Object.entries({missing:{membership:undefined},nullVersion:{securityVersion:null},arrayRealm:{realm:['test']},badDate:{updatedAt:'2026-01-01'},arrayId:{id:['user-a']},wrongId:{_id:'test:wrong'},extra:{password:diagnostic},versionString:{securityVersion:'0'},fraction:{securityVersion:0.5},memberArray:{membership:[]}}))
test('C05 BSON rejection: '+name,async()=>{
  const f=await fixture();await f.admin.createUser(userInput());Object.assign(f.user(),patch);
  await assert.rejects(f.store.findUserById({realm:'test',userId:'user-a'}),code('INTERNAL_ERROR'));
});

test('C06 two concurrent creates of one principal have one winner and safe CONFLICT',async()=>{
  const f=await fixture(),gate=barrier(),entered=barrier();let count=0;
  f.db.hooks.insertOne=async name=>{if(name.endsWith('_users')){if(++count===2)entered.resolve();await gate.promise;}};
  const operations=[f.admin.createUser(userInput()),f.admin.createUser(userInput('user-b'))];await entered.promise;gate.resolve();
  const results=await Promise.allSettled(operations);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.ok(code('CONFLICT')(results.find(r=>r.status==='rejected').reason));assert.equal(f.db.rows.get(options.collectionPrefix+'_users').length,1);
});

test('C07 IDs are unique by realm and email is never an identity key',async()=>{
  const f=await fixture();await f.admin.createUser(userInput());await f.admin.createUser(userInput('user-b','subject-b'));
  await assert.rejects(f.admin.createUser(userInput('user-a','subject-c')),code('CONFLICT'));
  await assert.rejects(f.admin.createClient({id:'client-a',name:'duplicate'}),code('CONFLICT'));
  assert.equal((await f.catalogue.findByPrincipal({issuer:'https://accounts.google.com',subject:'subject-b'})).id,'user-b');
  assert.equal(await f.store.findUserById({realm:'preview',userId:'user-a'}),null);
  assert.equal(await f.store.findUserByPrincipal({realm:'preview',issuer:'https://accounts.google.com',subject:'subject-a'}),null);
  assert.equal(await f.catalogue.findByPrincipal({issuer:'https://accounts.google.com',subject:'not-provisioned'}),null);
});

test('C08 unexpected duplicate user/principal/client rows fail closed instead of selecting first',async()=>{
  const f=await fixture();await f.admin.createUser(userInput());
  f.db.rows.get(options.collectionPrefix+'_users').push(clone(f.user()));
  await assert.rejects(f.store.findUserById({realm:'test',userId:'user-a'}),code('INTERNAL_ERROR'));
  await assert.rejects(f.catalogue.findByPrincipal({issuer:'https://accounts.google.com',subject:'subject-a'}),code('DEPENDENCY_UNAVAILABLE'));
  f.db.rows.get(options.collectionPrefix+'_clients').push(clone(f.client('client-a')));
  await assert.rejects(f.store.findClientById({realm:'test',clientId:'client-a'}),code('INTERNAL_ERROR'));
});

test('C09 simultaneous membership CAS operations have exactly one winner',async()=>{
  const f=await fixture();await f.admin.createUser(userInput());const gate=barrier(),entered=barrier();let n=0;
  f.db.hooks.findOneAndUpdate=async name=>{if(name.endsWith('_users')){if(++n===2)entered.resolve();await gate.promise;}};
  const operations=[f.admin.changeMembership({userId:'user-a',expectedVersion:0,clientId:'client-b'}),f.admin.changeMembership({userId:'user-a',expectedVersion:0,clientId:null})];
  await entered.promise;gate.resolve();const results=await Promise.allSettled(operations);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.ok(code('CONFLICT')(results.find(r=>r.status==='rejected').reason));assert.equal(f.user().securityVersion,1);
});

test('C10 A-B-A never restores an old session; unlink denies login and old capabilities',async()=>{
  const f=await fixture();await f.admin.createUser(userInput());const old=await f.login();await f.authorize(old.token);
  await f.admin.changeMembership({userId:'user-a',expectedVersion:0,clientId:'client-b'});await assert.rejects(f.authorize(old.token),code('UNAUTHENTICATED'));
  const middle=await f.login();assert.equal((await f.authorize(middle.token)).clientId,'client-b');
  await f.admin.changeMembership({userId:'user-a',expectedVersion:1,clientId:'client-a'});
  await assert.rejects(f.authorize(old.token),code('UNAUTHENTICATED'));await assert.rejects(f.authorize(middle.token),code('UNAUTHENTICATED'));
  await f.admin.changeMembership({userId:'user-a',expectedVersion:2,clientId:null});await assert.rejects(f.login(),code('FORBIDDEN'));assert.equal(f.user().securityVersion,3);
});

test('C11 disabling and enabling a user never revives its old session',async()=>{
  const f=await fixture();await f.admin.createUser(userInput());const old=await f.login();
  await f.admin.setUserActive({userId:'user-a',expectedVersion:0,active:false});await assert.rejects(f.login(),code('FORBIDDEN'));
  await f.admin.setUserActive({userId:'user-a',expectedVersion:1,active:true});await assert.rejects(f.authorize(old.token),code('UNAUTHENTICATED'));await f.authorize((await f.login()).token);
});

test('C12 client disable/re-enable changes epoch; relink versions user before access returns',async()=>{
  const f=await fixture();await f.admin.createUser(userInput());const old=await f.login();
  await f.admin.setClientActive({clientId:'client-a',expectedVersion:0,active:false});await assert.rejects(f.authorize(old.token),code('UNAUTHENTICATED'));
  await f.admin.setClientActive({clientId:'client-a',expectedVersion:1,active:true});
  await assert.rejects(f.authorize(old.token),code('UNAUTHENTICATED'));await assert.rejects(f.login(),code('FORBIDDEN'));
  await f.admin.changeMembership({userId:'user-a',expectedVersion:0,clientId:'client-a'});
  await assert.rejects(f.authorize(old.token),code('UNAUTHENTICATED'));assert.equal(f.user().membership.clientSecurityVersion,2);await f.authorize((await f.login()).token);
});

test('C13 reactivation between user and client reads cannot hide generation mismatch',async()=>{
  const f=await fixture();await f.admin.createUser(userInput());let once=true;
  f.db.hooks.find=async name=>{if(name.endsWith('_clients')&&once){once=false;f.client('client-a').securityVersion=2;}};
  assert.equal((await f.catalogue.findById('user-a')).client.active,false);
});

test('C14 disable while touch waits: accounting may finish but authorization rejects',async()=>{
  const f=await fixture();await f.admin.createUser(userInput());const old=await f.login();f.advance(100);
  const gate=barrier(),entered=barrier();f.db.hooks.findOneAndUpdate=async name=>{if(name.endsWith('_sessions')){entered.resolve();await gate.promise;}};
  const pending=f.authorize(old.token);await entered.promise;
  f.db.setFailure('updateMany');const update=await f.admin.setUserActive({userId:'user-a',expectedVersion:0,active:false});assert.equal(update.revocation,'pending');f.db.setFailure(undefined);
  gate.resolve();await assert.rejects(pending,code('UNAUTHENTICATED'));
  const row=f.db.rows.get(options.collectionPrefix+'_sessions')[0];assert.ok(row.idleExpiresAt>new Date(1900000));assert.equal(f.user().active,false);
});

test('C15 revocation during a blocked touch does not resurrect the session',async()=>{
  const f=await fixture();await f.admin.createUser(userInput());const old=await f.login();const gate=barrier(),entered=barrier();
  f.db.hooks.findOneAndUpdate=async name=>{if(name.endsWith('_sessions')){entered.resolve();await gate.promise;}};
  const pending=f.authorize(old.token);await entered.promise;await f.service.logout(old.token);gate.resolve();await assert.rejects(pending,code('UNAUTHENTICATED'));
});

test('C16 failure between invalidation and revocation is explicit; retry preserves newer sessions',async()=>{
  const f=await fixture();await f.admin.createUser(userInput());const old=await f.login();f.db.setFailure('updateMany');
  const changed=await f.admin.invalidateUser({userId:'user-a',expectedVersion:0});assert.equal(changed.revocation,'pending');assert.equal(f.user().securityVersion,1);
  await assert.rejects(f.authorize(old.token),code('UNAUTHENTICATED'));f.db.setFailure(undefined);const fresh=await f.login();
  assert.equal((await f.admin.retryRevocation({userId:'user-a',version:1})).revocation,'confirmed');await f.authorize(fresh.token);
  const sessionRows=f.db.rows.get(options.collectionPrefix+'_sessions');assert.ok(sessionRows.find(r=>r.securityVersion===0).revokedAt instanceof Date);assert.equal(sessionRows.find(r=>r.securityVersion===1).revokedAt,null);
});

test('C17 stale versions, missing/inactive clients and version overflow do not cause blind writes',async()=>{
  const f=await fixture();await f.admin.createUser(userInput());
  await assert.rejects(f.admin.setUserActive({userId:'user-a',expectedVersion:99,active:false}),code('CONFLICT'));
  await assert.rejects(f.admin.changeMembership({userId:'user-a',expectedVersion:0,clientId:'missing'}),code('RESOURCE_NOT_FOUND'));
  await f.admin.setClientActive({clientId:'client-b',expectedVersion:0,active:false});
  await assert.rejects(f.admin.changeMembership({userId:'user-a',expectedVersion:0,clientId:'client-b'}),code('FORBIDDEN'));
  f.user().securityVersion=Number.MAX_SAFE_INTEGER;await assert.rejects(f.admin.invalidateUser({userId:'user-a',expectedVersion:Number.MAX_SAFE_INTEGER}),code('INTERNAL_ERROR'));assert.equal(f.user().active,true);
});

test('C18 repository failures and malformed ACKs are safe and never reported as success',async()=>{
  const f=await fixture();f.db.setFailure('find');await assert.rejects(f.catalogue.findById('user-a'),code('DEPENDENCY_UNAVAILABLE'));f.db.setFailure(undefined);
  f.db.setAcknowledged('true');await assert.rejects(f.admin.createUser(userInput()),code('DEPENDENCY_UNAVAILABLE'));
});

test('C19 native writes/read options are scoped, bounded, majority and never upsert; no DDL',async()=>{
  const f=await fixture();await f.admin.createUser(userInput());await f.admin.invalidateUser({userId:'user-a',expectedVersion:0});
  for(const c of f.db.commands.filter(c=>['find','findOneAndUpdate','updateMany'].includes(c.kind))){assert.equal(c.filter.realm,'test');assert.equal(c.options.maxTimeMS,1000);assert.equal(c.options.collation.locale,'simple');}
  for(const c of f.db.commands.filter(c=>['insertOne','findOneAndUpdate','updateMany'].includes(c.kind)))assert.equal(c.options.writeConcern.w,'majority');
  assert.ok(f.db.commands.filter(c=>c.kind==='findOneAndUpdate').every(c=>c.options.upsert===false&&c.filter.$expr));
});

test('C20 CAS includes full before snapshot and rejects mutation/arrays without changing it',async()=>{
  const f=await fixture();await f.admin.createUser(userInput());const before=await f.administration.findUser('user-a');
  f.user().active=[true];const result=await f.administration.replaceUser(before,{...before,active:false,securityVersion:1});assert.equal(result,false);assert.deepEqual(f.user().active,[true]);
});

test('C21 mixed generation metadata fails closed; legacy metadata-free ports remain compatible',async()=>{
  const f=await fixture();await f.admin.createUser(userInput());const row=await f.administration.findUser('user-a');
  const c=createIdentityCatalogue({async findUserById(){return row;},async findUserByPrincipal(){return row;},async findClientById(){return {id:'client-a',name:'A',active:true,updatedAt:100000};}},'test');
  assert.equal((await c.findById('user-a')).client.active,false);
});

test('C22 hostile typed port error is sanitized even when its code getter throws',async()=>{
  const f=await fixture();const error=new ApplicationError('CONFLICT');Object.defineProperty(error,'code',{get(){throw new Error(diagnostic);}});
  const admin=createIdentityCatalogueAdministration({store:{...f.administration,async insertClient(){throw error;}},invalidator:f.invalidator},'test',()=>100000);
  await assert.rejects(admin.createClient({id:'client-z',name:'Z'}),code('DEPENDENCY_UNAVAILABLE'));
});

test('C23 client generation change before user insert leaves an unauthorized stale membership',async()=>{
  const f=await fixture();let once=true;f.db.hooks.insertOne=async name=>{if(name.endsWith('_users')&&once){once=false;
    await f.admin.setClientActive({clientId:'client-a',expectedVersion:0,active:false});
    await f.admin.setClientActive({clientId:'client-a',expectedVersion:1,active:true});}};
  await f.admin.createUser(userInput());await assert.rejects(f.login(),code('FORBIDDEN'));
  assert.equal(f.user().membership.clientSecurityVersion,0);assert.equal(f.client('client-a').securityVersion,2);
});

test('C24 two client state writes with one expected version have one winner',async()=>{
  const f=await fixture(),entered=barrier(),gate=barrier();let n=0;
  f.db.hooks.findOneAndUpdate=async name=>{if(name.endsWith('_clients')){if(++n===2)entered.resolve();await gate.promise;}};
  const ops=[f.admin.setClientActive({clientId:'client-a',expectedVersion:0,active:false}),f.admin.setClientActive({clientId:'client-a',expectedVersion:0,active:true})];
  await entered.promise;gate.resolve();const r=await Promise.allSettled(ops);assert.equal(r.filter(v=>v.status==='fulfilled').length,1);assert.equal(r.find(v=>v.status==='rejected').reason.code,'CONFLICT');assert.equal(f.client('client-a').securityVersion,1);
});

test('C25 physical user and client generations cannot be omitted or converted from strings',async()=>{
  const f=await fixture();await f.admin.createUser(userInput());delete f.user().membership.clientSecurityVersion;
  await assert.rejects(f.catalogue.findById('user-a'),code('DEPENDENCY_UNAVAILABLE'));
  f.user().membership.clientSecurityVersion=0;delete f.client('client-a').securityVersion;
  await assert.rejects(f.catalogue.findById('user-a'),code('DEPENDENCY_UNAVAILABLE'));
});

test('C26 Mongoose schemas validate explicit null membership but do not accept defaults/casts',async()=>{
  const c=new Mongoose().createConnection(),m=defineIdentityCatalogueModels(c,options);
  const logical={...userInput(),active:true,securityVersion:0,updatedAt:100000,membership:null};delete logical.clientId;
  const document=toCatalogueUserDocument(logical,'test');await new m.users(document).validate();
  for(const patch of [{membership:undefined},{active:'true'},{securityVersion:'0'},{updatedAt:100000},{email:'bad'},{subject:''}])await assert.rejects(new m.users({...document,...patch}).validate());
});

test('C27 cross-client resources stay scoped using the physical catalogue integration',async()=>{
  const f=await fixture();await f.admin.createUser(userInput());const session=await f.login();const queries=[];
  const own=f.service.authorization.createScopedRepository(await f.authorize(session.token),{async findResource(q){queries.push(q);return q.id==='field-a'?{...q}:null;}});
  assert.equal((await own.getField('field-a')).clientId,'client-a');await assert.rejects(own.getField('field-b'),code('RESOURCE_NOT_FOUND'));assert.ok(queries.every(q=>q.clientId==='client-a'));
});

test('C28 revocation scopes cannot revoke another realm or newer user version',async()=>{
  const f=await fixture();await f.admin.createUser(userInput());await f.login();
  const sessions=f.db.rows.get(options.collectionPrefix+'_sessions');sessions.push({...clone(sessions[0]),_id:'preview:foreign',realm:'preview'});
  await f.invalidator.revokeBeforeVersion('test','user-a',1,100000);assert.equal(sessions[1].revokedAt,null);assert.ok(sessions[0].revokedAt instanceof Date);
  await assert.rejects(f.invalidator.revokeBeforeVersion('preview','user-a',1,100000),code('INTERNAL_ERROR'));
});

test('C29 revocation does not match malformed scalar fields and false ACK remains pending',async()=>{
  const f=await fixture();await f.admin.createUser(userInput());await f.login();const row=f.db.rows.get(options.collectionPrefix+'_sessions')[0];
  row.realm=['test'];await f.invalidator.revokeBeforeVersion('test','user-a',1,100000);assert.equal(row.revokedAt,null);
  row.realm='test';row.revokedAt=[null];await f.invalidator.revokeBeforeVersion('test','user-a',1,100000);assert.deepEqual(row.revokedAt,[null]);
  row.revokedAt=null;f.db.setAcknowledged('true');assert.equal((await f.admin.invalidateUser({userId:'user-a',expectedVersion:0})).revocation,'pending');
});

test('C30 unexpected provider proxies are sanitized and ports are captured at construction',async()=>{
  const f=await fixture();const mutable={...f.administration};const admin=createIdentityCatalogueAdministration({store:mutable,invalidator:f.invalidator},'test',()=>100000);
  mutable.insertClient=async()=>{throw new Error(diagnostic);};await admin.createClient({id:'client-z',name:'Z'});
  f.db.hooks.find=async()=>{throw new Proxy({}, {getPrototypeOf(){throw new Error(diagnostic);},getOwnPropertyDescriptor(){throw new Error(diagnostic);}});};
  await assert.rejects(f.catalogue.findById('none'),code('DEPENDENCY_UNAVAILABLE'));
});

test('C31 retrying revocation cannot invalidate a future version and clock rollback does not write',async()=>{
  const f=await fixture();await f.admin.createUser(userInput());await assert.rejects(f.admin.retryRevocation({userId:'user-a',version:9}),code('CONFLICT'));
  const admin=createIdentityCatalogueAdministration({store:f.administration,invalidator:f.invalidator},'test',()=>99999);const n=f.db.commands.filter(c=>c.kind==='findOneAndUpdate').length;
  await assert.rejects(admin.invalidateUser({userId:'user-a',expectedVersion:0}),code('INTERNAL_ERROR'));assert.equal(f.db.commands.filter(c=>c.kind==='findOneAndUpdate').length,n);
});

test('C32 readonly lookup input rejects extra/email/operator fields without sending a query',async()=>{
  const f=await fixture();const n=f.db.commands.length;
  for(const q of [{realm:'test',email:'a@example.invalid'},{realm:'test',userId:{$ne:''}},{realm:'test',userId:'user-a',extra:true}])await assert.rejects(f.store.findUserById(q),code('INTERNAL_ERROR'));
  assert.equal(f.db.commands.length,n);
});

test('C33 DDL validators require scalar fields and both client/user generations without TTL',()=>{
  const users=catalogueCollectionValidators.users.$jsonSchema,clients=catalogueCollectionValidators.clients.$jsonSchema;
  assert.equal(users.additionalProperties,false);assert.ok(users.required.includes('membership'));assert.ok(clients.required.includes('securityVersion'));
  assert.ok(users.properties.membership.required.includes('clientSecurityVersion'));assert.deepEqual(users.properties.securityVersion.bsonType,['int','long','double']);
});

test('C34 opt-in catalogue probe rejects unauthorized or invalid local requests before sockets',()=>{
  const env={AGRO_AUTH_LOCAL_AUDIT:'AUTHORIZED_DISPOSABLE_LOOPBACK_ONLY',AGRO_CATALOGUE_LOCAL_AUDIT:'AUTHORIZED_DISPOSABLE_CATALOGUE_ONLY',AGRO_AUTH_LOCAL_PORT:'27019'};
  assert.equal(validateCatalogueAuditRequest(env).port,27019);
  for(const change of [{AGRO_AUTH_LOCAL_AUDIT:''},{AGRO_CATALOGUE_LOCAL_AUDIT:''},{AGRO_AUTH_LOCAL_PORT:'0'},{AGRO_AUTH_LOCAL_REPLICA_SET:'bad/name'}])assert.throws(()=>validateCatalogueAuditRequest({...env,...change}));
});

test('C35 CLI without either authorization refuses without connection or DDL',()=>{
  const child=spawnSync(process.execPath,['dist/scripts/audit-catalogue-mongodb-local.js'],{encoding:'utf8',timeout:5000,env:{...process.env,AGRO_AUTH_LOCAL_AUDIT:'',AGRO_CATALOGUE_LOCAL_AUDIT:''}});
  assert.equal(child.status,1);assert.equal(child.stdout,'');assert.match(child.stderr,/LOCAL_CATALOGUE_AUDIT_NOT_COMPLETED/);assert.equal(child.stderr.includes(diagnostic),false);
});

test('C36 malformed void port results cannot be reported as confirmed persistence/revocation',async()=>{
  const f=await fixture();await f.admin.createUser(userInput());
  const admin=createIdentityCatalogueAdministration({store:{...f.administration,async insertClient(){return false;}},invalidator:{realm:'test',async revokeBeforeVersion(){return false;}}},'test',()=>100000);
  const result=await admin.invalidateUser({userId:'user-a',expectedVersion:0});assert.equal(result.revocation,'pending');
  await assert.rejects(admin.createClient({id:'client-z',name:'Z'}),code('INTERNAL_ERROR'));
});

test('C37 administrative composition rejects a mismatched realm before any write',async()=>{
  const f=await fixture();assert.throws(()=>createIdentityCatalogueAdministration({store:f.administration,invalidator:f.invalidator},'production',()=>100000),TypeError);
});

test('A01 audit: a void no-op insert is not evidence of persistent creation',async()=>{
  const f=await fixture();const admin=createIdentityCatalogueAdministration({store:{...f.administration,async insertClient(){}},invalidator:f.invalidator},'test',()=>100000);
  await assert.rejects(admin.createClient({id:'no-write',name:'Synthetic'}),code('INTERNAL_ERROR'));
});

test('A02 audit: a void no-op revocation cannot be reported as confirmed',async()=>{
  const f=await fixture();await f.admin.createUser(userInput());const admin=createIdentityCatalogueAdministration({store:f.administration,invalidator:{realm:'test',async revokeBeforeVersion(){}}},'test',()=>100000);
  assert.equal((await admin.invalidateUser({userId:'user-a',expectedVersion:0})).revocation,'pending');
});

test('A03 audit: receipts must bind the expected realm, identity and authorization version',async()=>{
  const f=await fixture();await f.admin.createUser(userInput());
  for(const patch of [{realm:'preview'},{userId:'other'},{beforeVersion:99},{acknowledged:false},{modifiedCount:2}]){
    const invalidator={realm:'test',async revokeBeforeVersion(){return {acknowledged:true,realm:'test',userId:'user-a',beforeVersion:0,matchedCount:1,modifiedCount:1,...patch};}};
    const admin=createIdentityCatalogueAdministration({store:f.administration,invalidator},'test',()=>100000);
    const result=await admin.retryRevocation({userId:'user-a',version:0});assert.equal(result.revocation,'pending');assert.deepEqual(result.checkpoint,{realm:'test',userId:'user-a',beforeVersion:0});
  }
  const admin=createIdentityCatalogueAdministration({store:{...f.administration,async insertUser(){return {acknowledged:true,realm:'test',id:'other'};}},invalidator:f.invalidator},'test',()=>100000);
  await assert.rejects(admin.createUser(userInput('user-b','subject-b')),code('INTERNAL_ERROR'));
});

test('A04 audit: a lost response after committed CAS remains recoverable from durable user version',async()=>{
  const f=await fixture();await f.admin.createUser(userInput());const old=await f.login();
  const admin=createIdentityCatalogueAdministration({store:{...f.administration,async replaceUser(before,after){await f.administration.replaceUser(before,after);throw new Error(diagnostic);}},invalidator:f.invalidator},'test',()=>100000);
  await assert.rejects(admin.invalidateUser({userId:'user-a',expectedVersion:0}),code('DEPENDENCY_UNAVAILABLE'));
  assert.equal(f.user().securityVersion,1);await assert.rejects(f.authorize(old.token),code('UNAUTHENTICATED'));
  const persisted=await f.administration.findUser('user-a');const result=await f.admin.retryRevocation({userId:persisted.id,version:persisted.securityVersion});
  assert.equal(result.revocation,'confirmed');assert.deepEqual(result.checkpoint,{realm:'test',userId:'user-a',beforeVersion:1});
  const revoked=f.db.rows.get(options.collectionPrefix+'_sessions')[0].revokedAt;f.advance(100);
  await f.admin.retryRevocation({userId:'user-a',version:1});assert.deepEqual(f.db.rows.get(options.collectionPrefix+'_sessions')[0].revokedAt,revoked);
});

test('A05 audit: two physical realm compositions isolate identical IDs and principals',async()=>{
  const f=await fixture();await f.admin.createUser(userInput());const c=f.db.connection(),p=await createMongooseIdentityCatalogueStore(c,{...options,realm:'preview'});
  const inv=createMongooseCatalogueSessionInvalidator(c,{...options,realm:'preview'});
  const admin=createIdentityCatalogueAdministration({store:p.administration,invalidator:inv},'preview',()=>100000);
  await admin.createClient({id:'client-a',name:'Preview A'});await admin.createUser(userInput());
  await admin.setUserActive({userId:'user-a',expectedVersion:0,active:false});
  assert.equal((await f.catalogue.findById('user-a')).active,true);assert.equal((await createIdentityCatalogue(p.store,'preview').findById('user-a')).active,false);
  assert.equal((await f.administration.findUser('user-a')).securityVersion,0);
});

test('A06 audit: connection loss prevents further native reads or writes and recovers explicitly',async()=>{
  const f=await fixture();await f.admin.createUser(userInput());const count=f.db.commands.length;f.connection.readyState=0;
  await assert.rejects(f.catalogue.findById('user-a'),code('DEPENDENCY_UNAVAILABLE'));
  await assert.rejects(f.admin.createClient({id:'client-z',name:'Z'}),code('DEPENDENCY_UNAVAILABLE'));
  assert.equal(f.db.commands.length,count);f.connection.readyState=1;assert.equal((await f.catalogue.findById('user-a')).active,true);
});

test('A07 audit: native CAS cannot mutate immutable user identity or downgrade versions',async()=>{
  const f=await fixture();await f.admin.createUser(userInput());const before=await f.administration.findUser('user-a'),count=f.db.commands.length;
  for(const patch of [{id:'other'},{issuer:'https://evil.invalid'},{subject:'other'},{securityVersion:0}])
    await assert.rejects(f.administration.replaceUser(before,{...before,securityVersion:1,...patch}),code('INTERNAL_ERROR'));
  assert.equal(f.db.commands.length,count);
});

test('A08 audit: acknowledged cleanup is not a barrier against late obsolete session insertion',async()=>{
  const f=await fixture();await f.admin.createUser(userInput());await f.login();const first=f.db.rows.get(options.collectionPrefix+'_sessions')[0];
  const row=await f.sessions.findSessionById(first.id,'test');assert.equal((await f.admin.invalidateUser({userId:'user-a',expectedVersion:0})).revocation,'confirmed');
  const token=newOpaqueSecret();await f.sessions.insertSession({...row,id:'late-old-session',digest:digestSecret(token)});
  await assert.rejects(f.authorize(token),code('UNAUTHENTICATED'));assert.equal((await f.sessions.findSessionById('late-old-session','test')).revokedAt,null);
  await f.admin.retryRevocation({userId:'user-a',version:1});assert.ok((await f.sessions.findSessionById('late-old-session','test')).revokedAt!==null);
});
