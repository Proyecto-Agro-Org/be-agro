import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mongo } from 'mongoose';
import { createSessionService } from '../dist/src/services/session.service.js';
import { createAssociatedTelemetryPlanner } from '../dist/src/repositories/associated-telemetry.planner.js';
import { mapIngestMeasurementMetadata, buildIngestMeasurementFilter } from '../dist/src/repositories/telemetry-metadata.mapper.js';
import { validateDb01AuditRequest } from '../dist/scripts/audit-agro-db01-mongodb-local.js';
import { spawnSync } from 'node:child_process';

const copy=value=>structuredClone(value);
const code=value=>error=>error.code===value;
const source={sourceId:'synthetic-ingest',clockId:'synthetic-receipt-clock',deviceKind:'mqtt-clientid',deviceField:'clientid',authenticatedIdentity:true,verifiedTemporalAttribution:true};
const association=extra=>({id:'association-a',revision:0,realm:'test',clientId:'client-a',fieldId:'field-a',areaId:'area-a',sensorId:'sensor-a',sourceId:source.sourceId,
  device:{kind:'mqtt-clientid',value:'technical-a'},clockId:source.clockId,validFrom:100,validTo:null,attribution:'verified',...extra});
const range=extra=>({fieldId:'field-a',areaId:'area-a',sensorId:'sensor-a',from:0,to:1000,limit:100,...extra});
function barrier(){let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};}
async function fixture({clientId='client-a',records=[association()],policies=[source],realm='test'}={}){
  const state={revoked:false,membershipActive:true,now:900},calls=[],hooks={};
  const challenges=new Map(),stored=new Map();
  const lookup=row=>row?copy({...row,revokedAt:state.revoked?state.now:row.revokedAt}):null;
  const user=()=>({id:'user-a',issuer:'https://accounts.google.com',subject:'synthetic-sub',name:'Synthetic',email:'synthetic@example.invalid',active:true,securityVersion:0,
    client:{id:clientId,name:'Synthetic client',active:state.membershipActive}});
  const repository={async insertChallenge(row){challenges.set(row.digest,copy(row));},async findChallenge(id){return copy(challenges.get(id));},
    async consumeChallenge(id,nonce,scope,now){const r=challenges.get(id);if(!r||r.nonceDigest!==nonce||r.realm!==scope||r.expiresAt<=now||r.consumedAt!==null)return false;r.consumedAt=now;return true;},
    async insertSession(row){stored.set(row.id,copy(row));},async findSessionByDigest(digest){return lookup([...stored.values()].find(r=>r.digest===digest));},async findSessionById(id){return lookup(stored.get(id));},
    async touchSession(id,scope,now,idle){const r=stored.get(id);if(!r||state.revoked||r.realm!==scope||r.absoluteExpiresAt<=now||r.idleExpiresAt<=now)return null;r.idleExpiresAt=Math.max(r.idleExpiresAt,idle);return lookup(r);},async revokeSession(){state.revoked=true;}};
  const auth=createSessionService({repository,catalogue:{async findById(){return user();},async findByPrincipal(){return user();}},verifier:{async verify(){return{status:'verified',identity:{issuer:'https://accounts.google.com',subject:'synthetic-sub'}};}}},
    {realm:'test',audience:'123-synthetic.apps.googleusercontent.com',allowedOrigins:['https://synthetic.example.invalid']},()=>state.now);
  const attempt=await auth.challenge(),issued=await auth.login('synthetic-only',attempt.challengeId);
  const context=await auth.authorization.authorize(await auth.authorization.authenticate(issued.token));
  const overlaps=(r,q)=>r.validFrom<q.to&&(r.validTo===null||r.validTo>q.from);
  const ports={associations:{async findForSensor(q){calls.push({kind:'sensor',query:copy(q)});await hooks.sensor?.(q);return{complete:true,records:copy(records.filter(r=>r.realm===q.realm&&r.clientId===q.clientId&&r.fieldId===q.fieldId&&r.areaId===q.areaId&&r.sensorId===q.sensorId&&overlaps(r,q)))};},
    async findForDevice(q){calls.push({kind:'windows',query:copy(q)});await hooks.windows?.(q);return{complete:true,records:copy(records.filter(r=>r.realm===q.realm&&r.sourceId===q.sourceId&&r.device.kind===q.device.kind&&r.device.value===q.device.value&&overlaps(r,q)))};}},
    devices:{async findExact(q){calls.push({kind:'device',query:copy(q)});await hooks.device?.(q);return[{sourceId:q.sourceId,device:copy(q.device),recordId:{kind:'object-id',value:'507f1f77bcf86cd799439011'}}];}}};
  const planner=createAssociatedTelemetryPlanner(auth,context,ports,{realm,sources:policies},()=>state.now);
  return{planner,auth,context,ports,records,state,calls,hooks};
}

test('DB01-01 MQTT clientid never becomes a commercial client ID',async()=>{
  const f=await fixture({records:[association({device:{kind:'mqtt-clientid',value:'client-b'}})]});const[p]=await f.planner.history(range());
  assert.equal(p.clientId,'client-a');assert.equal(p.device.value,'client-b');assert.equal(p.filter.clientid.$eq,'client-b');
  assert.ok(f.calls.filter(c=>c.kind==='sensor').every(c=>c.query.clientId==='client-a'));assert.equal(p.filter.cliente_id,undefined);
});
test('DB01-02 raw filters contain exact technical identity, scalar guards and bounded reception time',async()=>{
  const f=await fixture();const[p]=await f.planner.history(range());assert.equal(+p.filter._receivedAt.$gte,100);assert.equal(+p.filter._receivedAt.$lt,900);
  assert.deepEqual(p.sort,{_receivedAt:-1,_id:-1});assert.equal(p.limit,100);assert.ok(JSON.stringify(p.filter.$expr).includes('$literal'));
});
test('DB01-03 unknown physical device fails before planning a measurement query',async()=>{
  const f=await fixture();f.ports.devices.findExact=async()=>[];
  // Ports are captured; construct a separate planner to use the changed trusted port.
  const p=createAssociatedTelemetryPlanner(f.auth,f.context,f.ports,{realm:'test',sources:[source]},()=>900);
  await assert.rejects(p.history(range()),code('RESOURCE_NOT_FOUND'));
});
test('DB01-04 duplicate physical device identity is never resolved by choosing first',async()=>{
  const f=await fixture();const one=await f.ports.devices.findExact({sourceId:source.sourceId,device:association().device});f.ports.devices.findExact=async()=>[...one,...one];
  const p=createAssociatedTelemetryPlanner(f.auth,f.context,f.ports,{realm:'test',sources:[source]},()=>900);await assert.rejects(p.history(range()),code('INTERNAL_ERROR'));
});
test('DB01-05 association without attribution proof or source authentication remains quarantined',async()=>{
  for(const change of [{authenticatedIdentity:false},{verifiedTemporalAttribution:false}]){const f=await fixture({policies:[{...source,...change}]});await assert.rejects(f.planner.history(range()),code('FORBIDDEN'));assert.equal(f.calls.some(c=>c.kind==='device'),false);}
  const f=await fixture({records:[association({attribution:'quarantined'})]});await assert.rejects(f.planner.history(range()),code('FORBIDDEN'));
});
test('DB01-06 public clientId or trust flags cannot override capability scope',async()=>{
  const f=await fixture();for(const extra of [{clientId:'client-b'},{realm:'production'},{authenticatedIdentity:true},{sourceId:'other'}])await assert.rejects(f.planner.history(range(extra)),code('VALIDATION_ERROR'));
  assert.equal(f.calls.length,0);
});
test('DB01-07 foreign client/field/area/sensor output from a faulty store fails closed',async()=>{
  const f=await fixture();for(const patch of [{clientId:'client-b'},{fieldId:'other'},{areaId:'other'},{sensorId:'other'},{realm:'preview'}]){
    f.ports.associations.findForSensor=async()=>({complete:true,records:[association(patch)]});const p=createAssociatedTelemetryPlanner(f.auth,f.context,f.ports,{realm:'test',sources:[source]},()=>900);
    await assert.rejects(p.history(range()),code('RESOURCE_NOT_FOUND'));
  }
});
test('DB01-08 reassignment uses half-open windows; neither client inherits the other history',async()=>{
  const records=[association({validTo:500}),association({id:'association-b',clientId:'client-b',validFrom:500,sensorId:'sensor-b',fieldId:'field-b',areaId:'area-b'})];
  const a=await fixture({records});const[ap]=await a.planner.history(range());assert.deepEqual([ap.from,ap.to],[100,500]);
  const b=await fixture({records,clientId:'client-b'});const[bp]=await b.planner.history(range({fieldId:'field-b',areaId:'area-b',sensorId:'sensor-b'}));assert.deepEqual([bp.from,bp.to],[500,900]);
});
test('DB01-09 moving area/field cannot change the scope of an existing logical sensor',async()=>{
  const f=await fixture({records:[association({validTo:500}),association({id:'association-b',validFrom:500,fieldId:'field-b',areaId:'area-b',sensorId:'sensor-b'})]});
  const[p]=await f.planner.history(range());assert.equal(p.to,500);assert.deepEqual(await f.planner.history(range({areaId:'area-b'})),[]);
});
test('DB01-10 overlapping assignments, including another client, stop planning',async()=>{
  const f=await fixture({records:[association(),association({id:'foreign',clientId:'client-b',sensorId:'sensor-b',validFrom:400})]});await assert.rejects(f.planner.history(range()),code('CONFLICT'));
});
test('DB01-11 duplicated or truncated association pages are not trusted',async()=>{
  const f=await fixture();for(const page of [{complete:false,records:[association()]},{complete:true,records:[association(),association()]}]){
    f.ports.associations.findForSensor=async()=>page;const p=createAssociatedTelemetryPlanner(f.auth,f.context,f.ports,{realm:'test',sources:[source]},()=>900);
    await assert.rejects(p.history(range()),error=>['CONFLICT','INTERNAL_ERROR'].includes(error.code));
  }
});
test('DB01-12 invalid interval, missing hierarchy and operator objects never reach a port',async()=>{
  const f=await fixture();for(const patch of [{from:500,to:500},{from:1000,to:1},{sensorId:{$ne:''}},{fieldId:null},{areaId:undefined},{limit:1001},{limit:0}])await assert.rejects(f.planner.history(range(patch)),code('VALIDATION_ERROR'));assert.equal(f.calls.length,0);
});
test('DB01-13 invalid received time or device type is not accepted as metadata',()=>{
  const base={_id:new mongo.ObjectId('507f1f77bcf86cd799439011'),clientid:'technical-a',_receivedAt:new Date(200)};
  for(const patch of [{_receivedAt:'2026-01-01'},{_receivedAt:[new Date(200)]},{clientid:7},{clientid:{$ne:''}},{clientid:['technical-a']},{_id:7}])assert.throws(()=>mapIngestMeasurementMetadata({...base,...patch},'clientid',association().device));
});
test('DB01-14 ObjectId and string IDs remain explicitly different, even with identical text',()=>{
  const id='507f1f77bcf86cd799439011',base={clientid:'technical-a',_receivedAt:new Date(200)};
  const a=mapIngestMeasurementMetadata({...base,_id:new mongo.ObjectId(id)},'clientid',association().device),b=mapIngestMeasurementMetadata({...base,_id:id},'clientid',association().device);
  assert.equal(a.measurementId.kind,'object-id');assert.equal(b.measurementId.kind,'string');assert.equal(a.measurementId.value,b.measurementId.value);
});
test('DB01-15 manipulated device timestamps/payload client fields never select ownership or reception time',()=>{
  const result=mapIngestMeasurementMetadata({_id:'raw-string',clientid:'technical-a',_receivedAt:new Date(200),timestamp:'2999-01-01',cliente_id:'foreign',password:'SYNTHETIC_PRIVATE_MARKER',readings:{hum:0}},'clientid',association().device);
  assert.equal(result.receivedAt,200);assert.equal(JSON.stringify(result).includes('foreign'),false);assert.equal(JSON.stringify(result).includes('SYNTHETIC_PRIVATE_MARKER'),false);assert.equal(Object.hasOwn(result,'readings'),false);
});
test('DB01-16 unsafe field paths, numeric coercions and raw filter injection are rejected',()=>{
  for(const patch of [{deviceField:'$where'},{deviceField:'payload.clientid'},{device:{kind:'mqtt-clientid',value:5}},{device:{kind:'mqtt-clientid',value:{$gt:''}}},{from:'100'},{to:0},{unexpected:true}])assert.throws(()=>buildIngestMeasurementFilter({deviceField:'clientid',device:association().device,from:100,to:200,...patch}));
});
test('DB01-17 revoked session while association lookup waits cannot produce a plan',async()=>{
  const f=await fixture(),gate=barrier(),entered=barrier();let once=true;f.hooks.sensor=async()=>{if(once){once=false;entered.resolve();await gate.promise;}};
  const pending=f.planner.history(range());await entered.promise;f.state.revoked=true;gate.resolve();await assert.rejects(pending,code('UNAUTHENTICATED'));
});
test('DB01-18 revoked membership during planning is revalidated',async()=>{
  const f=await fixture();f.hooks.windows=async()=>{f.state.membershipActive=false;};await assert.rejects(f.planner.history(range()),code('UNAUTHENTICATED'));
});
test('DB01-19 changed association revision/boundary invalidates the prepared plan',async()=>{
  const f=await fixture();f.hooks.device=async()=>{f.records[0].validTo=500;f.records[0].revision++;};await assert.rejects(f.planner.history(range()),code('CONFLICT'));
});
test('DB01-20 clocks and technical namespaces cannot be silently mixed',async()=>{
  for(const patch of [{clockId:'other-clock'},{device:{kind:'device-id',value:'technical-a'}}]){const f=await fixture({records:[association(patch)]});await assert.rejects(f.planner.history(range()),code('INTERNAL_ERROR'));}
});
test('DB01-21 future ranges produce no query and no current assignment gives an empty history',async()=>{
  const f=await fixture();assert.deepEqual(await f.planner.history(range({from:901,to:1000})),[]);assert.equal(f.calls.length,0);
  const empty=await fixture({records:[]});assert.deepEqual(await empty.planner.history(range()),[]);
});
test('DB01-22 fabricated authorization context and cross-realm composition are rejected',async()=>{
  const f=await fixture();assert.throws(()=>createAssociatedTelemetryPlanner(f.auth,{identity:{source:'agro-session:test'},clientId:'client-a'},f.ports,{realm:'test',sources:[source]}),code('FORBIDDEN'));
  assert.throws(()=>createAssociatedTelemetryPlanner(f.auth,f.context,f.ports,{realm:'preview',sources:[source]}),code('FORBIDDEN'));
});
test('DB01-23 source/store exceptions are sanitized without echoing private diagnostics',async()=>{
  const f=await fixture();f.ports.associations.findForSensor=async()=>{throw new Error('SYNTHETIC_PRIVATE_STORE');};const p=createAssociatedTelemetryPlanner(f.auth,f.context,f.ports,{realm:'test',sources:[source]},()=>900);
  await assert.rejects(p.history(range()),error=>error.code==='DEPENDENCY_UNAVAILABLE'&&!String(error).includes('SYNTHETIC_PRIVATE_STORE'));
});
test('DB01-24 partial input is not treated as a complete attributed measurement',()=>{
  for(const row of [{},{_id:'a'},{_id:'a',clientid:'technical-a'},{_id:'a',_receivedAt:new Date(1)}])assert.throws(()=>mapIngestMeasurementMetadata(row,'clientid',association().device));
});

test('DB01-25 late data after cross-client transfer stays quarantined without verified temporal attribution',async()=>{
  const f=await fixture({clientId:'client-b',records:[association({clientId:'client-b',validFrom:500})],policies:[{...source,verifiedTemporalAttribution:false}]});
  await assert.rejects(f.planner.history(range({from:600,to:800})),code('FORBIDDEN'));assert.equal(f.calls.some(c=>c.kind==='device'),false);
});
test('DB01-26 malformed stored associations are not treated as business ownership',async()=>{
  const f=await fixture();for(const patch of [{validFrom:500,validTo:500},{revision:-1},{device:{kind:'mqtt-clientid',value:7}},{validFrom:'100'},{unexpected:true}]){
    f.ports.associations.findForSensor=async()=>({complete:true,records:[association(patch)]});const p=createAssociatedTelemetryPlanner(f.auth,f.context,f.ports,{realm:'test',sources:[source]},()=>900);
    await assert.rejects(p.history(range()),code('INTERNAL_ERROR'));
  }
});
test('DB01-27 DB01 real probe requires both explicit disposable-local permissions and a valid port',()=>{
  const env={AGRO_AUTH_LOCAL_AUDIT:'AUTHORIZED_DISPOSABLE_LOOPBACK_ONLY',AGRO_DB01_LOCAL_AUDIT:'AUTHORIZED_DISPOSABLE_DB01_ONLY',AGRO_AUTH_LOCAL_PORT:'27019'};
  assert.equal(validateDb01AuditRequest(env).port,27019);for(const patch of [{AGRO_AUTH_LOCAL_AUDIT:''},{AGRO_DB01_LOCAL_AUDIT:''},{AGRO_AUTH_LOCAL_PORT:'0'}])assert.throws(()=>validateDb01AuditRequest({...env,...patch}));
});
test('DB01-28 unauthorized DB01 CLI stops before connections or collection creation',()=>{
  const child=spawnSync(process.execPath,['dist/scripts/audit-agro-db01-mongodb-local.js'],{encoding:'utf8',timeout:5000,env:{...process.env,AGRO_AUTH_LOCAL_AUDIT:'',AGRO_DB01_LOCAL_AUDIT:''}});
  assert.equal(child.status,1);assert.equal(child.stdout,'');assert.match(child.stderr,/DB01_LOCAL_AUDIT_NOT_COMPLETED/);
});
