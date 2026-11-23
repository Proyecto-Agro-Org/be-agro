import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import type { Connection } from 'mongoose';
import type { Collection, Document } from 'mongodb';
import { validateDb02Request, verifyOwnedDocker } from './agro-db02/guard.js';
import { connectOwned } from './agro-db02/resources.js';
import { classifyBe11Failure, writeBe11Evidence } from './be11-diagnostics.js';

let stage='bootstrap',run:string|undefined;const results:{name:string;status:string}[]=[];
const check=async(name:string,work:()=>Promise<void>)=>{stage=name;try{await work();results.push({name,status:'passed'});console.log('PASS '+name);}catch(error){results.push({name,status:'failed'});throw error;}};
function validatedGitSha(){
  const status=execFileSync('git',['status','--porcelain'],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  if(status.trim())throw Error('BE12_GIT_TREE_NOT_CLEAN');
  const sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  if(!/^[a-f0-9]{40}$/.test(sha))throw Error('BE12_GIT_SHA_INVALID');return sha;
}
export async function readOrderedDeviceHistory(rows:Pick<Collection<Document>,'find'>,scope:{realm:string;clientId:string;physicalDeviceId:string}){
  return rows.find(scope).sort({attributedAt:-1,id:-1}).project({_id:0,id:1,clientId:1}).toArray();
}
async function main(){
  stage='validate-owned-docker';const request=validateDb02Request(process.env);run=request.runId;verifyOwnedDocker(request);
  if(request.topology!=='single-node-replica-set')throw Error('BE12_REQUIRES_REPLICA_SET');
  const sha=validatedGitSha(),database='agro_db02_test_'+request.runId,collection='agro_measurements_be12_local';let connection:Connection|undefined,owned=false;
  try{
    stage='connect';connection=await connectOwned(request,database);const db=connection.db!;assert.equal((await db.listCollections().toArray()).length,0);owned=true;
    const build=await db.command({buildInfo:1});assert.equal(build.version,'8.0.38');
    await db.createCollection(collection,{validator:{$jsonSchema:{bsonType:'object',required:['id','eventId','realm','clientId','fieldId','areaId','sensorId','physicalDeviceId','associationId','associationRevision','magnitude','unit','value','provenance','receivedAt','persistedAt','attributedAt'],additionalProperties:false,
      properties:{_id:{},id:{bsonType:'string'},eventId:{bsonType:'string'},realm:{bsonType:'string'},clientId:{bsonType:'string'},fieldId:{bsonType:'string'},areaId:{bsonType:'string'},sensorId:{bsonType:'string'},physicalDeviceId:{bsonType:'string'},associationId:{bsonType:'string'},associationRevision:{bsonType:'int'},magnitude:{bsonType:'string'},unit:{bsonType:'string'},value:{bsonType:['double','int','long','null']},missingReason:{bsonType:['string','null']},provenance:{enum:['physical','derived','estimated','simulated','manual','laboratory']},receivedAt:{bsonType:'date'},declaredAt:{bsonType:['date','null']},persistedAt:{bsonType:'date'},attributedAt:{bsonType:'date'}}}}});
    const rows=db.collection(collection);
    await rows.createIndexes([{key:{realm:1,id:1},name:'measurement_id_unique',unique:true},{key:{realm:1,eventId:1},name:'measurement_event_unique',unique:true},
      {key:{realm:1,clientId:1,sensorId:1,attributedAt:-1,id:-1},name:'measurement_sensor_history'},
      {key:{realm:1,clientId:1,physicalDeviceId:1,attributedAt:-1,id:-1},name:'measurement_device_history'},
      {key:{realm:1,clientId:1,fieldId:1,areaId:1,attributedAt:-1,id:-1},name:'measurement_area_history'}]);
    const at=(value:number)=>new Date(value),row=(id:string,clientId:string,sensorId:string,associationId:string,time:number)=>({id,eventId:'event-'+id,realm:'test',clientId,fieldId:'field-'+clientId,areaId:'area-'+clientId,sensorId,physicalDeviceId:'device-shared',associationId,associationRevision:0,magnitude:'synthetic-temperature',unit:'synthetic-unit',value:20,missingReason:null,provenance:'physical',receivedAt:at(time),declaredAt:null,persistedAt:at(time+1),attributedAt:at(time)});
    await rows.insertMany([row('a1','client-a','sensor-a','association-a',100),row('a2','client-a','sensor-a','association-a',200),row('b1','client-b','sensor-b','association-b',300),row('b2','client-b','sensor-b','association-b',400)]);
    await check('R01 version, replica set and owned database',async()=>{assert.equal(build.version,'8.0.38');assert.equal((await db.admin().command({hello:1})).setName,'agro_db02');});
    await check('R02 required indexes exist',async()=>{const names=(await rows.listIndexes().toArray()).map(x=>x.name);for(const name of ['measurement_id_unique','measurement_event_unique','measurement_sensor_history','measurement_device_history','measurement_area_history'])assert.ok(names.includes(name));});
    await check('R03 sensor history is tenant scoped',async()=>{assert.deepEqual((await rows.find({realm:'test',clientId:'client-a',sensorId:'sensor-a'}).sort({attributedAt:-1,id:-1}).toArray()).map(x=>x.id),['a2','a1']);});
    await check('R04 physical device history remains tenant scoped after transfer',async()=>{const history=await readOrderedDeviceHistory(rows,{realm:'test',clientId:'client-b',physicalDeviceId:'device-shared'});assert.ok(history.every(x=>x.clientId==='client-b'));assert.deepEqual(history.map(x=>x.id),['b2','b1']);});
    await check('R05 area and field filters do not cross clients',async()=>{assert.equal(await rows.countDocuments({realm:'test',clientId:'client-a',fieldId:'field-client-a',areaId:'area-client-a'}),2);assert.equal(await rows.countDocuments({realm:'test',clientId:'client-a',fieldId:'field-client-b'}),0);});
    await check('R06 deterministic pagination uses attributedAt and id',async()=>{const first=await rows.find({realm:'test',clientId:'client-b'}).sort({attributedAt:-1,id:-1}).limit(1).toArray();const cursor=first[0];const second=await rows.find({realm:'test',clientId:'client-b',$or:[{attributedAt:{$lt:cursor.attributedAt}},{attributedAt:cursor.attributedAt,id:{$lt:cursor.id}}]}).sort({attributedAt:-1,id:-1}).limit(1).toArray();assert.deepEqual([cursor.id,second[0].id],['b2','b1']);});
    await check('R07 historical ownership is preserved across reassignment',async()=>{assert.equal(await rows.countDocuments({clientId:'client-a',associationId:'association-a'}),2);assert.equal(await rows.countDocuments({clientId:'client-b',associationId:'association-b'}),2);});
    await check('R08 late received data cannot be reassigned by current owner query',async()=>{await rows.insertOne(row('late-a','client-a','sensor-a','association-a',150));assert.equal(await rows.countDocuments({clientId:'client-b',id:'late-a'}),0);});
    await check('R09 duplicate event is rejected atomically',async()=>{await assert.rejects(rows.insertOne({...row('duplicate','client-a','sensor-a','association-a',500),eventId:'event-a1'}),error=>typeof error==='object'&&error!==null&&'code'in error&&error.code===11000);});
    await check('R10 concurrent reads remain isolated',async()=>{const [a,b]=await Promise.all([rows.find({clientId:'client-a'}).toArray(),rows.find({clientId:'client-b'}).toArray()]);assert.ok(a.every(x=>x.clientId==='client-a'));assert.ok(b.every(x=>x.clientId==='client-b'));});
    const indexes=await rows.listIndexes().toArray();stage='write-evidence';writeBe11Evidence(process.cwd(),'be12-mongodb.json',{gitSha:sha,mongoVersion:build.version,topology:request.topology,run:request.runId,results,indexes,limitations:['provisional local BSON mapping','single node; no failover','no Atlas, EMQX or production data']});
  }finally{if(owned&&connection?.readyState===1){verifyOwnedDocker(request);await connection.db!.dropDatabase();}await connection?.close();console.log(JSON.stringify({event:'be12-summary',passed:results.filter(x=>x.status==='passed').length,failed:results.filter(x=>x.status==='failed').length}));}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{const failure=classifyBe11Failure(stage,error);writeBe11Evidence(process.cwd(),'be12-mongodb-failure.json',{run:run??null,failure,results});console.error('BE12_LOCAL_FAILED '+JSON.stringify(failure));process.exitCode=1;});
