import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import { once } from 'node:events';
import ts from 'typescript';
import { createApp } from '../dist/src/app.js';
const base='d504c8e6c4df9417e35028726fce32f63150f01a';
const source=execFileSync('git',['show',base+':src/app.ts'],{encoding:'utf8'});
const changed=execFileSync('git',['diff','--name-only',base,'--','src/app.ts','src/http','src/middlewares','src/config','src/routes/health.routes.ts','src/controllers/health.controller.ts','src/services/health.service.ts'],{encoding:'utf8'}).trim();
assert.equal(changed,'','The default app dependencies must remain unchanged for this comparison');
const file=new URL('../dist/src/be10-comparison-'+randomUUID()+'.mjs',import.meta.url);
await writeFile(file,ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);
async function probe(factory,options,path='/health',init={}){
 const server=factory(options).listen(0,'127.0.0.1');await once(server,'listening');
 try{const r=await fetch('http://127.0.0.1:'+server.address().port+path,init);return{status:r.status,body:await r.text(),headers:Object.fromEntries(['content-type','access-control-allow-origin','access-control-allow-methods','x-powered-by'].map(k=>[k,r.headers.get(k)]))};}
 finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
try{
 const original=(await import(file.href)).createApp,origin='https://synthetic.example.invalid';
 class Broken extends Set{has(){throw Error('Synthetic diagnostic');}}
 const cases=[
 ['health',new Set([origin]),'/health',{}],['allowed',new Set([origin]),'/health',{headers:{Origin:origin}}],
 ['denied',new Set([origin]),'/health',{headers:{Origin:'https://foreign.invalid'}}],
 ['exact',new Set([origin]),'/health',{headers:{Origin:origin+'/'}}],
 ['HEAD',new Set([origin]),'/health',{method:'HEAD'}],
 ['preflight',new Set([origin]),'/health',{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'GET'}}],
 ['denied preflight',new Set([origin]),'/health',{method:'OPTIONS',headers:{Origin:'https://foreign.invalid','Access-Control-Request-Method':'GET'}}],
 ['missing',new Set([origin]),'/missing',{}],['POST health',new Set([origin]),'/health',{method:'POST'}],
 ['wildcard',new Set(['*']),'/health',{headers:{Origin:origin}}],['empty no Origin',new Set(),'/health',{}],
 ['empty with Origin',new Set(),'/health',{headers:{Origin:origin}}],['500',new Broken(),'/health',{headers:{Origin:origin}}],
 ];
 const results=[];for(const[name,allowedOrigins,path,init]of cases){assert.deepEqual(await probe(createApp,{allowedOrigins},path,init),await probe(original,{allowedOrigins},path,init));results.push(name);}
 await writeFile(new URL('../.local-evidence/be10-http.json',import.meta.url),JSON.stringify({base,passed:results.length,failed:0,scenarios:results},null,2));
 console.log('13/13 HTTP scenarios equivalent to '+base);
}finally{await unlink(file);}
