import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Mongoose } from 'mongoose';
import { createApp } from '../dist/src/app.js';
import { createAuthorizationService } from '../dist/src/services/authorization.service.js';
import { createSensorService } from '../dist/src/services/sensor.service.js';
import { defineSensorModels, sensorCollections } from '../dist/src/models/sensor.models.js';
import { sensorCreateSchema, deviceCreateSchema, areaReassignmentSchema, lifecycleInputSchema } from '../dist/src/sensors/schemas.js';
import { toSensorResponse, toPhysicalDeviceResponse, toTemporalAssociationResponse } from '../dist/src/dto/sensor.dto.js';
import { ApplicationError } from '../dist/src/errors/application.error.js';

function fixture(verification={status:'verified',authority:'synthetic-authority'}) {
  const calls=[];
  const authorization=createAuthorizationService({
    verifier:{async verify(token){return {status:'verified',subject:token,sessionReference:token,expiresAt:100000};}},
    identities:{async resolve(p){return {userId:p.subject,active:true};}},memberships:{async resolve(id){return {clientId:'client-'+id,active:true};}},
    sessions:{async inspect(){return {status:'active',expiresAt:100000};},async revoke(){}},
  },{source:'sensor-tests',now:()=>1000});
  const sensor={id:'sensor-1',clientId:'client-A',fieldId:'field-1',areaId:'area-1',name:'Sonda',description:null,lifecycle:'active',version:0,createdAt:1000,updatedAt:1000};
  const device={id:'device-1',sourceId:'ingest-1',key:{kind:'mqtt-clientid',value:'edge-1'},verification:verification.status,lifecycle:'active',version:0,createdAt:1000,updatedAt:1000};
  const association={id:'assoc-1',revision:0,clientId:'client-A',sensorId:sensor.id,fieldId:sensor.fieldId,areaId:sensor.areaId,physicalDeviceId:device.id,sourceId:device.sourceId,device:device.key,validFrom:1000,validTo:null,state:'active',auditReason:'operator-approved'};
  const repository={
    async listSensors(s,p){calls.push(['list',s,p]);return {rows:[sensor],next:null};},async getSensor(s,id){calls.push(['get',s,id]);if(s.clientId!=='client-A')throw new ApplicationError('RESOURCE_NOT_FOUND');return sensor;},
    async createSensor(s,input){calls.push(['create',s,input]);return sensor;},async patchSensor(){return {...sensor,version:1};},async setSensorLifecycle(s,id,lifecycle){return {...sensor,lifecycle,version:1};},async reassignSensorArea(){return {...sensor,fieldId:'field-2',areaId:'area-2',version:1};},
    async createDevice(s,input,v){calls.push(['device',s,input,v]);return device;},async setDeviceVerification(){return {...device,verification:'verified',version:1};},async getDevice(){return device;},async setDeviceLifecycle(s,id,lifecycle){return {...device,lifecycle,version:1};},
    async createAssociation(){return association;},async closeAssociation(){return {...association,state:'closed',validTo:2000,revision:1};},async reassignDevice(){return {...association,id:'assoc-2'};},async listAssociations(){return [association];},async listAreaAssignments(){return [];},
  };
  const service=createSensorService({authorization,repository,verifier:{async verify(){return verification;}},realm:'test'});
  return {authorization,repository,service,calls,sensor,device,association};
}
async function context(f,token='A'){return f.authorization.authorize(await f.authorization.authenticate(token));}

test('BE11 schemas reject ownership, malformed identity and implicit lifecycle fields',()=>{
  assert.equal(sensorCreateSchema.safeParse({fieldId:'field-1',areaId:'area-1',name:'Sonda',description:null}).success,true);
  for(const value of [{fieldId:'field-1',areaId:'area-1',name:'Sonda',description:null,clientId:'other'},{fieldId:'field-1',areaId:'area-1',name:'',description:null}])assert.equal(sensorCreateSchema.safeParse(value).success,false);
  assert.equal(deviceCreateSchema.safeParse({sourceId:'ingest-1',key:{kind:'mqtt-clientid',value:'edge-1'}}).success,true);
  assert.equal(deviceCreateSchema.safeParse({sourceId:'ingest-1',key:{kind:'mqtt-clientid',value:'edge-1'},verified:true}).success,false);
  assert.equal(areaReassignmentSchema.safeParse({sensorId:'sensor-1',fieldId:'field-2',areaId:'area-2',validFrom:1000,sensorVersion:0,auditReason:'approved'}).success,true);
  assert.equal(lifecycleInputSchema.safeParse({version:0,auditReason:'retired',active:true}).success,false);
});

test('BE11 service derives client scope from an authenticated capability',async()=>{const f=fixture(),ctx=await context(f);await f.service.create(ctx,{fieldId:'field-1',areaId:'area-1',name:'Sonda',description:null});assert.deepEqual(f.calls[0][1],{realm:'test',clientId:'client-A'});});
test('BE11 static context forgery cannot select another tenant',()=>{const f=fixture();assert.throws(()=>f.service.get({clientId:'client-A',identity:{}},'sensor-1'),e=>e.code==='FORBIDDEN');});
test('BE11 device verification is a trusted port result, never a request field',async()=>{const f=fixture(),ctx=await context(f);await f.service.registerDevice(ctx,{sourceId:'ingest-1',key:{kind:'mqtt-clientid',value:'edge-1'}});assert.deepEqual(f.calls[0][3],{status:'verified',authority:'synthetic-authority'});});
test('BE11 verifier failure is sanitized and storage is not called',async()=>{const f=fixture();f.service=createSensorService({authorization:f.authorization,repository:f.repository,verifier:{async verify(){throw Error('PRIVATE_DEVICE_SECRET');}},realm:'test'});const ctx=await context(f);await assert.rejects(f.service.registerDevice(ctx,{sourceId:'ingest-1',key:{kind:'device-id',value:'d-1'}}),e=>e.code==='DEPENDENCY_UNAVAILABLE'&&!String(e).includes('PRIVATE'));assert.equal(f.calls.length,0);});

test('BE11 response mappers expose explicit DTOs without persistence ownership fields',()=>{const f=fixture();assert.deepEqual(toSensorResponse(f.sensor),{sensor_id:'sensor-1',campo_id:'field-1',area_id:'area-1',nombre:'Sonda',descripcion:null,estado:'active',version:0,creado_en:'1970-01-01T00:00:01.000Z',actualizado_en:'1970-01-01T00:00:01.000Z'});assert.equal(toPhysicalDeviceResponse(f.device).cliente_id,undefined);assert.equal(toTemporalAssociationResponse(f.association).auditReason,undefined);});

test('BE11 model definitions perform no DDL and use separate logical/physical identities',async()=>{const connection=new Mongoose().createConnection(),models=defineSensorModels(connection,'agro_sensors_unit','agro_business_unit');assert.equal(connection.readyState,0);assert.equal(models.sensors.schema.options.autoCreate,false);assert.equal(models.devices.schema.path('keyKind').enumValues.includes('mqtt-clientid'),true);assert.throws(()=>new models.devices({clientid:'forged'}));const names=sensorCollections('agro_sensors_unit','agro_business_unit');assert.notEqual(names.devices,names.sensors);await connection.close();});

test('BE11 routes remain absent from default public composition',async()=>{const app=createApp(),server=app.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();try{for(const [method,path] of [['GET','/api/v1/sensores'],['POST','/api/v1/sensores'],['POST','/api/v1/dispositivos'],['POST','/api/v1/asociaciones'],['PATCH','/api/v1/sensores/x/reasignar']])assert.equal((await fetch('http://127.0.0.1:'+address.port+path,{method})).status,404);}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}});
