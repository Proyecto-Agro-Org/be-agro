import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { createApp } from '../dist/src/app.js';
import { createAuthorizationService } from '../dist/src/services/authorization.service.js';
import { createBusinessService } from '../dist/src/services/business.service.js';
import { createBusinessRouter } from '../dist/src/routes/business.routes.js';
import { createHttpInfrastructure } from '../dist/src/http/infrastructure.js';
import { businessErrorResponse } from '../dist/src/dto/business.dto.js';
import { ApplicationError } from '../dist/src/errors/application.error.js';
import { defineBusinessModels } from '../dist/src/models/business.models.js';
import { Mongoose } from 'mongoose';

// Synthetic identity and storage exist only in this test. No environment-selected fake.
function fixture() {
  let clock = 1000, count = 0;
  const fields = new Map(), areas = new Map(), sensors = new Set();
  const state = { activeClient: true, fail: false, noClient: false };
  const error = code => { throw new ApplicationError(code); };
  function get(map, s, id, fieldId) {
    const row = map.get(id);
    if (!row || row.clientId !== s.clientId || !row.active || (fieldId && row.fieldId !== fieldId)) error('RESOURCE_NOT_FOUND');
    return { ...row };
  }
  const create = (s, input, fieldId) => ({ id: 'resource-' + ++count, clientId: s.clientId, ...input, ...(fieldId ? { fieldId } : {}), active: true, version: 0, createdAt: 1000, updatedAt: 1000 });
  const list = (map, s, p, fieldId) => { const rows = [...map.values()].filter(r => r.active && r.clientId === s.clientId && (!fieldId || r.fieldId === fieldId) && (!p.after || r.id > p.after)).sort((a,b) => a.id.localeCompare(b.id)); return { rows: rows.slice(0,p.limit), next: rows.length > p.limit ? rows[p.limit-1].id : null }; };
  const patch = (map,s,id,input,fieldId) => { const row=get(map,s,id,fieldId); if(row.version!==input.version)error('CONFLICT'); const next={...row,...Object.fromEntries(Object.entries(input).filter(([k,v])=>k!=='version'&&v!==undefined)),version:row.version+1,updatedAt:1001};map.set(id,next);return next; };
  const repository = {
    async listFields(s,p) { if(state.fail)throw Error('PRIVATE_PROVIDER');return list(fields,s,p); },
    async getField(s,id) { return get(fields,s,id); },
    async createField(s,input) { const row=create(s,input);fields.set(row.id,row);return row; },
    async patchField(s,id,input) { return patch(fields,s,id,input); },
    async deactivateField(s,id,version) { const row=get(fields,s,id);if(row.version!==version)error('CONFLICT');if([...areas.values()].some(a=>a.fieldId===id))error('CONFLICT');fields.set(id,{...row,active:false}); },
    async listAreas(s,fieldId,p) { get(fields,s,fieldId);return list(areas,s,p,fieldId); },
    async getArea(s,fieldId,id) { get(fields,s,fieldId);return get(areas,s,id,fieldId); },
    async createArea(s,fieldId,input) { get(fields,s,fieldId);const row=create(s,input,fieldId);areas.set(row.id,row);return row; },
    async patchArea(s,fieldId,id,input) { get(fields,s,fieldId);return patch(areas,s,id,input,fieldId); },
    async deactivateArea(s,fieldId,id,version) { get(fields,s,fieldId);const row=get(areas,s,id,fieldId);if(row.version!==version||sensors.has(id))error('CONFLICT');areas.set(id,{...row,active:false}); },
  };
  const authorization = createAuthorizationService({
    verifier: { async verify(token) { return ['A','B','N'].includes(token) ? { status:'verified',subject:token,sessionReference:token,expiresAt:100000 } : {status:'invalid'}; } },
    identities: { async resolve(p) { return {userId:p.subject,active:true}; } },
    memberships: { async resolve(user) { return user==='N'||state.noClient ? null : {clientId:'client-'+user,active:true}; } },
    sessions: { async inspect() { return {status:'active',expiresAt:100000}; },async revoke(){} },
  }, {source:'test',now:()=>clock});
  const catalogue = { async findClientById(q) { assert.equal(q.realm,'test');return {id:q.clientId,name:'Public client',active:state.activeClient,updatedAt:1,securityVersion:0}; } };
  const service=createBusinessService({authorization,catalogue,repository,realm:'test'});
  const http=createHttpInfrastructure({logger:()=>{},errorResponse:businessErrorResponse});
  const app=express();http.protectApplication(app);app.use(http.requestContext,http.securityHeaders);
  app.use('/api/v1',createBusinessRouter(service,http));app.use(http.notFound,http.errorHandler,http.terminalErrorHandler);
  return {app,service,state,fields,areas,sensors,clock:n=>{clock=n;}};
}
async function serve(app,check) {
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();
  const send=async(method,path,body,token='A',extra={})=>fetch('http://127.0.0.1:'+address.port+path,{method,headers:{...(token?{authorization:'Bearer '+token}:{}),...(body!==undefined?{'content-type':'application/json'}:{}),...extra},body:body===undefined?undefined:JSON.stringify(body)});
  try{await check(send);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
}
const root='/api/v1';
const createField=async(send,token='A')=>{const r=await send('POST',root+'/campos',{nombre:'Campo',descripcion:'description'},token);assert.equal(r.status,201);return r.json();};
const createArea=async(send,id)=>{const r=await send('POST',root+'/campos/'+id+'/areas',{nombre:'Área'});assert.equal(r.status,201);return r.json();};

test('BE10 default app exposes none of the eleven business operations',async()=>serve(createApp(),async send=>{
  for(const [method,path] of [['GET','/clientes/actual'],['GET','/campos'],['POST','/campos'],['GET','/campos/x'],['PATCH','/campos/x'],['DELETE','/campos/x'],['GET','/areas'],['POST','/campos/x/areas'],['GET','/areas/x'],['PATCH','/areas/x'],['DELETE','/areas/x']])assert.equal((await send(method,root+path)).status,404);
}));
test('BE10 isolated router requires authentication before parsing or storage',async()=>serve(fixture().app,async send=>{
  for(const [method,path] of [['GET','/clientes/actual'],['GET','/campos'],['POST','/campos'],['GET','/campos/x'],['PATCH','/campos/x'],['DELETE','/campos/x'],['GET','/areas'],['POST','/campos/x/areas'],['GET','/areas/x'],['PATCH','/areas/x'],['DELETE','/areas/x']])assert.equal((await send(method,root+path,undefined,null)).status,401);
  assert.equal((await send('GET',root+'/campos',undefined,'invalid')).status,401);
  assert.equal((await send('GET',root+'/campos',undefined,'N')).status,403);
}));
test('BE10 current client is catalogue-derived, minimal and not selected by public input',async()=>{const f=fixture();await serve(f.app,async send=>{
  const r=await send('GET',root+'/clientes/actual',undefined,'A',{'x-client-id':'client-B'});assert.equal(r.status,200);assert.deepEqual(await r.json(),{cliente_id:'client-A',nombre:'Public client',activo:true,campos_url:root+'/campos'});
  assert.equal((await send('GET',root+'/clientes/actual?clientId=client-B')).status,400);
  assert.equal((await send('GET',root+'/clientes/client-B')).status,404);
  f.state.activeClient=false;assert.equal((await send('GET',root+'/clientes/actual')).status,403);
});});
test('BE10 field lifecycle uses explicit DTO, partial updates, CAS and soft deactivation',async()=>serve(fixture().app,async send=>{
  const row=await createField(send);assert.equal(row.cliente_id,'client-A');assert.equal(row._id,undefined);assert.equal(row.realm,undefined);
  assert.equal((await send('GET',root+'/campos/'+row.campo_id)).status,200);
  const patched=await send('PATCH',root+'/campos/'+row.campo_id,{descripcion:null,version:0});assert.equal(patched.status,200);const after=await patched.json();assert.equal(after.nombre,'Campo');assert.equal(after.descripcion,null);assert.equal(after.version,1);
  assert.equal((await send('PATCH',root+'/campos/'+row.campo_id,{nombre:'stale',version:0})).status,409);
  const del=await send('DELETE',root+'/campos/'+row.campo_id+'?version=1');assert.equal(del.status,204);assert.equal(await del.text(),'');assert.equal((await send('GET',root+'/campos/'+row.campo_id)).status,404);
}));
test('BE10 field list has bounded keyset pagination and no foreign rows',async()=>serve(fixture().app,async send=>{
  await createField(send);await createField(send);await createField(send,'B');const first=await (await send('GET',root+'/campos?limit=1')).json();assert.equal(first.campos.length,1);assert.ok(first.next);
  const second=await(await send('GET',root+'/campos?limit=1&after='+first.next)).json();assert.equal(second.campos.length,1);assert.notEqual(first.campos[0].campo_id,second.campos[0].campo_id);assert.equal(second.next,null);
  for(const q of ['limit=101','limit=-1','limit=1.5','limit=1&limit=2','clientId=client-B'])assert.equal((await send('GET',root+'/campos?'+q)).status,400);
}));
test('BE10 Zod rejects ownership/internal fields, wrong types and empty patches',async()=>serve(fixture().app,async send=>{
  for(const body of [{},{nombre:''},{nombre:' '},{nombre:'x'.repeat(121)},{nombre:5},{nombre:'ok',cliente_id:'client-B'},{nombre:'ok',active:true},{nombre:'ok',_id:'x'},[]])assert.equal((await send('POST',root+'/campos',body)).status,400);
  const f=await createField(send);for(const body of [{version:0},{nombre:'new'},{nombre:'x',version:-1},{nombre:'x',version:0,clientId:'client-B'},{nombre:'x',version:0,createdAt:0}])assert.equal((await send('PATCH',root+'/campos/'+f.campo_id,body)).status,400);
  assert.equal((await send('DELETE',root+'/campos/'+f.campo_id+'?version=0',{version:0})).status,400);
}));
test('BE10 foreign and nonexistent fields give the same 404 across mutations',async()=>serve(fixture().app,async send=>{
  const foreign=await createField(send,'B');for(const id of [foreign.campo_id,'missing']){
  for(const [m,s,b]of[['GET','',undefined],['PATCH','',{nombre:'x',version:0}],['DELETE','?version=0',undefined],['POST','/areas',{nombre:'x'}]])assert.equal((await send(m,root+'/campos/'+id+s,b)).status,404);
  assert.equal((await send('GET',root+'/areas?campo_id='+id)).status,404);}
}));
test('BE10 area lifecycle preserves parent and forbids reassignment',async()=>serve(fixture().app,async send=>{
  const f=await createField(send),a=await createArea(send,f.campo_id),url=root+'/areas/'+a.area_id+'?campo_id='+f.campo_id;
  assert.equal(a.campo_id,f.campo_id);assert.equal((await send('GET',url)).status,200);
  const p=await send('PATCH',url,{nombre:'Renamed',version:0});assert.equal(p.status,200);assert.equal((await p.json()).nombre,'Renamed');
  for(const body of [{nombre:'x',version:1,campo_id:'other'},{nombre:'x',version:1,cliente_id:'B'}])assert.equal((await send('PATCH',url,body)).status,400);
  assert.equal((await send('DELETE',url+'&version=1')).status,204);assert.equal((await send('GET',url)).status,404);
}));
test('BE10 area scope checks field and client for reads and writes',async()=>serve(fixture().app,async send=>{
  const f=await createField(send),a=await createArea(send,f.campo_id),other=await createField(send);
  for(const token of ['A','B']){const field=token==='A'?other.campo_id:f.campo_id;for(const [m,b,q]of[['GET',undefined,''],['PATCH',{nombre:'x',version:0},''],['DELETE',undefined,'&version=0']])assert.equal((await send(m,root+'/areas/'+a.area_id+'?campo_id='+field+q,b,token)).status,404);}
  assert.equal((await send('GET',root+'/areas/'+a.area_id)).status,400);
}));
test('BE10 deactivation blocks dependencies and keeps stored records',async()=>{const f=fixture();await serve(f.app,async send=>{
  const field=await createField(send),area=await createArea(send,field.campo_id);assert.equal((await send('DELETE',root+'/campos/'+field.campo_id+'?version=0')).status,409);
  f.sensors.add(area.area_id);assert.equal((await send('DELETE',root+'/areas/'+area.area_id+'?campo_id='+field.campo_id+'&version=0')).status,409);assert.equal(f.areas.get(area.area_id).active,true);
});});
test('BE10 storage errors are sanitized and expired contexts cannot proceed',async()=>{const f=fixture();await serve(f.app,async send=>{
  f.state.fail=true;const r=await send('GET',root+'/campos');assert.equal(r.status,503);assert.deepEqual(await r.json(),{error:{code:'DEPENDENCY_UNAVAILABLE',message:'Dependency unavailable'}});
  f.clock(100001);assert.equal((await send('GET',root+'/clientes/actual')).status,401);
});});
test('BE10 static context forgery fails closed',async()=>{const f=fixture();await assert.rejects(f.service.current({clientId:'client-A',identity:{}}),e=>e.code==='FORBIDDEN');});
test('BE10 simultaneous business requests retain separate client capabilities',async()=>serve(fixture().app,async send=>{
  const [a,b]=await Promise.all([createField(send,'A'),createField(send,'B')]);
  const [ra,rb]=await Promise.all([send('GET',root+'/campos',undefined,'A'),send('GET',root+'/campos',undefined,'B')]);
  assert.deepEqual((await ra.json()).campos.map(r=>r.campo_id),[a.campo_id]);
  assert.deepEqual((await rb.json()).campos.map(r=>r.campo_id),[b.campo_id]);
}));
test('BE10 model definitions perform no connection/DDL and reject unknown administrative fields',async()=>{
 const connection=new Mongoose().createConnection(),models=defineBusinessModels(connection,'agro_business_unit');assert.equal(connection.readyState,0);
 assert.equal(models.fields.schema.options.autoIndex,false);assert.equal(models.fields.schema.options.autoCreate,false);
 assert.throws(()=>new models.fields({entityId:'forged'}));await connection.close();
});
