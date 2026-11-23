import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';

const root=join(dirname(fileURLToPath(import.meta.url)),'..','docs','be13-01','fixtures');
const manifest=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8'));
const read=id=>{const item=manifest.find(row=>row.id===id);assert.ok(item);return JSON.parse(readFileSync(join(root,item.file),'utf8'));};
const technical=/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function protectedEnvelope(value){
  if(!plain(value))return false;
  const allowed=['version','eventId','sentAt','clientid','payload','deviceTimestamp','mqtt'];
  if(Object.keys(value).some(key=>!allowed.includes(key))||value.version!==1||!technical.test(value.eventId??'')||
    !technical.test(value.clientid??'')||!Number.isSafeInteger(value.sentAt)||value.sentAt<0||!plain(value.payload))return false;
  for(const alias of ['clientid','clientId','client_id'])if(value.payload[alias]!==undefined&&value.payload[alias]!==value.clientid)return false;
  if(value.deviceTimestamp!==undefined&&value.deviceTimestamp!==null&&
    !((typeof value.deviceTimestamp==='string'&&value.deviceTimestamp.length<=128)||(typeof value.deviceTimestamp==='number'&&Number.isFinite(value.deviceTimestamp))))return false;
  if(value.mqtt!==undefined){
    if(!plain(value.mqtt)||Object.keys(value.mqtt).some(key=>!['topic','messageType','dataOrigin'].includes(key)))return false;
    if(!['telemetry','device-status','connected','disconnected'].includes(value.mqtt.messageType)||
      !['simulated','physical-unverified','unknown'].includes(value.mqtt.dataOrigin))return false;
    if(value.mqtt.topic!==null&&(typeof value.mqtt.topic!=='string'||value.mqtt.topic.length===0||Buffer.byteLength(value.mqtt.topic)>1024||/[+#\0]/.test(value.mqtt.topic)))return false;
    if(value.mqtt.messageType==='telemetry'&&value.mqtt.topic===null)return false;
  }
  return true;
}
function keys(value,result=[]){if(!plain(value))return result;for(const [key,nested] of Object.entries(value)){result.push(key);keys(nested,result);}return result;}

test('BE13-01 catalogue is complete, unique and never labels synthetic data as real',()=>{
  assert.equal(manifest.length,14);assert.equal(new Set(manifest.map(row=>row.id)).size,14);
  assert.deepEqual([...new Set(manifest.map(row=>row.classification))].sort(),['OBSERVADO_EN_CODIGO','SINTETICO']);
  for(const row of manifest){assert.match(row.id,/^F\d{2}$/);assert.ok(row.source.includes(':'));assert.ok(Array.isArray(row.limitations));read(row.id);}
});

test('BE13-01 positive protected fixtures match only the observed envelope v1 contract',()=>{
  for(const id of ['F01','F02','F03','F04','F05','F06','F07','F11','F12'])assert.equal(protectedEnvelope(read(id)),true,id);
  assert.equal(read('F01').mqtt.messageType,'telemetry');
  for(const id of ['F02','F03','F04'])assert.notEqual(read(id).mqtt.messageType,'telemetry');
});

test('BE13-01 negative fixtures demonstrate missing identity, contradiction and invalid time',()=>{
  for(const id of ['F08','F09','F10'])assert.equal(protectedEnvelope(read(id)),false,id);
  assert.equal('eventId' in read('F08'),false);
  assert.notEqual(read('F09').payload.clientId,read('F09').clientid);
  assert.equal(typeof read('F10').sentAt,'string');
});

test('BE13-01 retry identity is stable while altered bytes remain a conflict candidate',()=>{
  const original=read('F05'),altered=read('F06');assert.equal(original.eventId,altered.eventId);
  const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
  assert.notEqual(digest(original),digest(altered));
  assert.equal(manifest.find(row=>row.id==='F05').ingestResult,'accepted-then-duplicate-ack');
  assert.equal(manifest.find(row=>row.id==='F06').ingestResult,'rejected-conflict');
});

test('BE13-01 accepted fixtures contain no business authority or credentials',()=>{
  const forbidden=new Set(['entityId','cliente_id','fieldId','areaId','sensorId','physicalDeviceId','password','secret','token','authorization','x-emqx-key']);
  for(const id of ['F01','F02','F03','F04','F05','F06','F07','F11','F12'])for(const key of keys(read(id)))assert.equal(forbidden.has(key),false,`${id}:${key}`);
});

test('BE13-01 deep sleep and unknown magnitude stay blocked before BE12 attribution',()=>{
  const delayed=read('F11');assert.ok(delayed.deviceTimestamp<delayed.sentAt);
  assert.equal(manifest.find(row=>row.id==='F11').be12Result,'blocked');
  assert.equal(manifest.find(row=>row.id==='F12').be12Result,'blocked-invalid-catalogue');
});

test('BE13-01 legacy examples remain explicitly separate from the protected contract',()=>{
  for(const id of ['F13','F14']){assert.equal(protectedEnvelope(read(id)),false);assert.equal(manifest.find(row=>row.id===id).classification,'OBSERVADO_EN_CODIGO');}
});
