import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
