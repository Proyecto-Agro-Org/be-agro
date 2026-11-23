import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyBe11Failure, writeBe11Evidence } from '../dist/scripts/be11-diagnostics.js';
import { ApplicationError } from '../dist/src/errors/application.error.js';

test('BE11 launcher diagnostics retain safe stage/code and discard private messages',()=>{
  const error=new ApplicationError('CONFLICT');error.message='PRIVATE_URI mongodb://private.invalid';
  assert.deepEqual(classifyBe11Failure('M06 setup initial association',error),{stage:'M06 setup initial association',category:'CONFLICT',errorClass:'ApplicationError'});
  assert.equal(JSON.stringify(classifyBe11Failure('M06 setup initial association',error)).includes('private'),false);
});

test('BE11 diagnostics survive hostile errors without invoking string coercion',()=>{
  const hostile={get name(){throw Error('PRIVATE');},get code(){throw Error('PRIVATE');},toString(){throw Error('PRIVATE');}};
  assert.deepEqual(classifyBe11Failure('stage',hostile),{stage:'stage',category:'unreadable-error',errorClass:'UnknownError'});
});

test('BE11 diagnostics classify owned Docker guard failures without exposing arbitrary messages',()=>{
  assert.deepEqual(classifyBe11Failure('validate-owned-docker',new Error('DB02_NETWORK_IDENTITY_MISMATCH')),
    {stage:'validate-owned-docker',category:'network-identity-mismatch',errorClass:'Error'});
  assert.deepEqual(classifyBe11Failure('validate-owned-docker',new Error('mongodb://private.invalid')),
    {stage:'validate-owned-docker',category:'unexpected-error',errorClass:'Error'});
});

test('BE11 evidence writer creates the missing local directory without changing its payload',()=>{
  const root=mkdtempSync(join(tmpdir(),'be11-evidence-'));
  try{const path=writeBe11Evidence(root,'be11-mongodb-failure.json',{failure:{stage:'M06',category:'CONFLICT'}});assert.deepEqual(JSON.parse(readFileSync(path,'utf8')),{failure:{stage:'M06',category:'CONFLICT'}});}
  finally{rmSync(root,{recursive:true,force:true});}
});

test('BE11 real fixture never backdates an association before sensor-area validity',()=>{
  const source=readFileSync(new URL('../scripts/audit-be11-mongodb-local.ts',import.meta.url),'utf8');
  assert.match(source,/validFrom:clock,auditReason:'initial-link'/);
  assert.match(source,/processRace\(\{sensorId:raceSensor\.id,physicalDeviceId:raceDevice\.id,validFrom:clock\}\)/);
});

test('BE11 Windows readiness tolerates transient mongosh stderr and rejects a stopped container', {skip:process.platform!=='win32'},()=>{
  const root=mkdtempSync(join(tmpdir(),'be11-readiness-'));
  try{
    const helper=fileURLToPath(new URL('../scripts/be11-readiness.ps1',import.meta.url)).replaceAll("'","''");
    const probe=join(root,'probe.ps1');
    writeFileSync(probe,`\uFEFF$ErrorActionPreference='Stop'
. '${helper}'
$script:mode='transient';$script:attempts=0
function docker {
  if($args[0] -eq 'inspect') { if($script:mode -eq 'stopped'){Write-Output 'false|14|exited'}else{Write-Output 'true|0|running'};$global:LASTEXITCODE=0;return }
  if($args[0] -eq 'exec') {$script:attempts++;if($script:mode -eq 'deadline' -or $script:attempts -lt 3){Write-Error 'MongoNetworkError PRIVATE_DIAGNOSTIC' -ErrorAction Continue;$global:LASTEXITCODE=1}else{$global:LASTEXITCODE=0};return}
  throw 'unexpected fake docker operation'
}
$result=Wait-Be11MongoProbe -ContainerId 'owned' -JavaScript 'ping' -MaximumAttempts 3 -IntervalMilliseconds 0 -DeadlineMessage 'deadline'
if($result -ne 3 -or $script:attempts -ne 3){throw 'transient probe was not retried'}
$script:mode='stopped';$script:attempts=0
try{Wait-Be11MongoProbe -ContainerId 'owned' -JavaScript 'ping' -MaximumAttempts 3 -IntervalMilliseconds 0 -DeadlineMessage 'deadline';throw 'stopped container was accepted'}catch{if($_.Exception.Message -notlike 'Owned MongoDB container stopped*'){throw}}
if($script:attempts -ne 0){throw 'mongosh ran after definitive container failure'}
$script:mode='deadline';$script:attempts=0
try{Wait-Be11MongoProbe -ContainerId 'owned' -JavaScript 'ping' -MaximumAttempts 2 -IntervalMilliseconds 0 -DeadlineMessage 'bounded deadline';throw 'deadline was accepted'}catch{if($_.Exception.Message -ne 'bounded deadline'){throw}}
if($script:attempts -ne 2){throw 'deadline attempts were not bounded'}
Write-Output 'READINESS_REGRESSION_OK'
`,'utf8');
    const result=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',probe],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr||result.stdout);
    assert.match(result.stdout,/READINESS_REGRESSION_OK/);
    assert.doesNotMatch(result.stderr+result.stdout,/PRIVATE_DIAGNOSTIC/);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('BE11 launcher captures owned container diagnostics before removal',()=>{
  const source=readFileSync(new URL('../scripts/be11-local.ps1',import.meta.url),'utf8');
  assert.match(source,/\$resource="agro-db02-\$runId"/);
  assert.doesNotMatch(source,/\$resource="agro-be11-\$runId"/);
  assert.ok(source.indexOf('docker logs $containerId')<source.indexOf('docker rm --force $containerId'));
  assert.match(source,/Select-Object Id,State,Mounts/);
  assert.match(source,/NetworkSettings\.Networks/);
});
