import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import express from 'express';
import ts from 'typescript';
import { z } from 'zod';
import { createRequestValidation } from '../dist/src/middlewares/validate-request.middleware.js';
import {
  RequestValidationError, RequestValidationExecutionError, ValidatedRequestUnavailableError,
} from '../dist/src/errors/request-validation.error.js';

async function run(validation, request) {
  const calls = [];
  await validation.middleware(request, {}, error => calls.push(error));
  assert.equal(calls.length, 1);
  return calls[0];
}

test('valid body is parsed, transformed and stripped without changing the raw request', async () => {
  const v = createRequestValidation({ body: z.object({ name: z.string().trim() }) });
  const request = { body: { name: ' test ', ignored: true } };
  assert.equal(await run(v, request), undefined);
  assert.deepEqual(v.getValidatedData(request), { body: { name: 'test' } });
  assert.deepEqual(request.body, { name: ' test ', ignored: true });
});

test('invalid body reports its part, approved field, issue code and safe message', async () => {
  const v = createRequestValidation({ body: z.object({ age: z.number() }) },
    { publicFields: { body: ['age'] } });
  const request = { body: { age: 'wrong' } };
  const error = await run(v, request);
  assert.ok(error instanceof RequestValidationError);
  assert.deepEqual(error.issues, [{ part: 'body', path: ['age'],
    code: 'invalid_type', message: 'Valor inválido.' }]);
  assert.throws(() => v.getValidatedData(request), ValidatedRequestUnavailableError);
});

test('missing required fields do not make validated data available', async () => {
  const v = createRequestValidation({ body: z.object({ name: z.string() }) });
  for (const body of [undefined, {}, null]) {
    const req = { body };
    assert.ok(await run(v, req) instanceof RequestValidationError);
    assert.throws(() => v.getValidatedData(req), ValidatedRequestUnavailableError);
  }
});

test('incorrect scalar, array and object input types are rejected', async () => {
  const v = createRequestValidation({ body: z.object({ active: z.boolean() }) });
  for (const body of ['text', 0, false, [], { active: 'true' }]) {
    assert.ok(await run(v, { body }) instanceof RequestValidationError);
  }
});

test('valid params are available with schema transformations', async () => {
  const v = createRequestValidation({ params: z.object({ id: z.coerce.number().int().positive() }) });
  const req = { params: { id: '12' } };
  assert.equal(await run(v, req), undefined);
  assert.deepEqual(v.getValidatedData(req), { params: { id: 12 } });
  assert.equal(req.params.id, '12');
});

test('invalid params prevent controller data access', async () => {
  const v = createRequestValidation({ params: z.object({ id: z.coerce.number().positive() }) });
  const req = { params: { id: 'not-a-number' } };
  const error = await run(v, req);
  assert.ok(error instanceof RequestValidationError);
  assert.equal(error.issues[0].part, 'params');
});

test('valid query is parsed without assigning to a read-only getter', async () => {
  const v = createRequestValidation({ query: z.object({ limit: z.coerce.number().int() }) });
  const query = { limit: '5' };
  const req = {};
  Object.defineProperty(req, 'query', { get: () => query });
  assert.equal(await run(v, req), undefined);
  assert.equal(v.getValidatedData(req).query.limit, 5);
  assert.equal(req.query, query);
  assert.equal(req.query.limit, '5');
});

test('invalid query is identified separately from other parts', async () => {
  const v = createRequestValidation({ query: z.object({ limit: z.coerce.number().min(1) }) });
  const error = await run(v, { query: { limit: '0' } });
  assert.ok(error instanceof RequestValidationError);
  assert.equal(error.issues[0].part, 'query');
  assert.equal(error.issues[0].code, 'too_small');
});

test('all configured parts are validated and failures are aggregated without partial success', async () => {
  const v = createRequestValidation({ body: z.string(), params: z.string(), query: z.string() });
  const req = { body: 'ok', params: 1, query: 2 };
  const error = await run(v, req);
  assert.deepEqual(error.issues.map(i => i.part), ['params', 'query']);
  assert.throws(() => v.getValidatedData(req), ValidatedRequestUnavailableError);
});

test('only configured parts are read and an empty configuration does not inspect input', async () => {
  const req = { body: 'ok' };
  for (const part of ['params', 'query']) Object.defineProperty(req, part,
    { get() { throw new Error('Unconfigured property was read'); } });
  const v = createRequestValidation({ body: z.string() });
  assert.equal(await run(v, req), undefined);
  assert.deepEqual(v.getValidatedData(req), { body: 'ok' });
  const empty = createRequestValidation({});
  assert.equal(await run(empty, req), undefined);
  assert.deepEqual(empty.getValidatedData(req), {});
});

test('asynchronous refinements and transforms finish before next runs', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const v = createRequestValidation({ body: z.string().refine(async value => {
    await gate; return value === 'ok';
  }).transform(async value => value.toUpperCase()) });
  const req = { body: 'ok' };
  let nextCalls = 0;
  const pending = v.middleware(req, {}, () => { nextCalls++; });
  assert.equal(nextCalls, 0);
  assert.throws(() => v.getValidatedData(req), ValidatedRequestUnavailableError);
  release(); await pending;
  assert.equal(nextCalls, 1);
  assert.equal(v.getValidatedData(req).body, 'OK');
  assert.ok(await run(v, { body: 'bad' }) instanceof RequestValidationError);
});

test('thrown and rejected schema failures become safe execution errors without cause', async () => {
  const secret = 'SYNTHETIC_REQUEST_SECRET';
  for (const transform of [() => { throw new Error(secret); }, async () => { throw secret; }]) {
    const v = createRequestValidation({ body: z.string().transform(transform) });
    const req = { body: secret };
    const error = await run(v, req);
    assert.ok(error instanceof RequestValidationExecutionError);
    assert.equal(error.cause, undefined);
    assert.ok(!String(error.stack).includes(secret));
    assert.ok(!JSON.stringify(error).includes(secret));
    assert.throws(() => v.getValidatedData(req), ValidatedRequestUnavailableError);
  }
});

test('Zod messages, enum values, unknown keys and dynamic paths cannot expose input secrets', async () => {
  const secret = 'SYNTHETIC_REQUEST_SECRET';
  const schemas = [
    z.record(z.string(), z.number()),
    z.strictObject({ safe: z.string() }),
    z.enum([secret]),
    z.string().superRefine((_value, ctx) => ctx.addIssue({ code: 'custom', message: secret,
      path: [secret, 123456789] })),
  ];
  const inputs = [{ [secret]: secret }, { safe: 'ok', [secret]: secret }, 'wrong', secret];
  for (let i = 0; i < schemas.length; i++) {
    const v = createRequestValidation({ body: schemas[i] }, { publicFields: { body: ['safe'] } });
    const error = await run(v, { body: inputs[i] });
    assert.ok(error instanceof RequestValidationError);
    assert.ok(!JSON.stringify(error).includes(secret));
    assert.ok(!String(error.stack).includes(secret));
    assert.equal(error.cause, undefined);
    assert.ok(!JSON.stringify(error).includes('123456789'));
    assert.ok(Object.isFrozen(error.issues));
    assert.ok(Object.isFrozen(error.issues[0].path));
  }
});

test('concurrent requests keep independent parsed results and do not leak a current request', async () => {
  const v = createRequestValidation({ body: z.object({ value: z.string() }).transform(async data => {
    await Promise.resolve(); return data;
  }) });
  const a = { body: { value: 'a' } }, b = { body: { value: 'b' } };
  assert.deepEqual(await Promise.all([run(v, a), run(v, b)]), [undefined, undefined]);
  const first = v.getValidatedData(a), second = v.getValidatedData(b);
  assert.notEqual(first, second);
  assert.notEqual(first.body, a.body);
  first.body.value = 'changed locally';
  assert.equal(second.body.value, 'b');
  assert.ok(Object.isFrozen(first));
});

test('accessor rejects a request not validated by its own middleware instance', async () => {
  const a = createRequestValidation({ body: z.string() });
  const b = createRequestValidation({ body: z.string() });
  const req = { body: 'ok' };
  assert.throws(() => a.getValidatedData(req), ValidatedRequestUnavailableError);
  await run(a, req);
  assert.throws(() => b.getValidatedData(req), ValidatedRequestUnavailableError);
});

test('a failed repeat validation invalidates previous data on the same request', async () => {
  const v = createRequestValidation({ body: z.string() });
  const req = { body: 'ok' };
  await run(v, req);
  req.body = null;
  assert.ok(await run(v, req) instanceof RequestValidationError);
  assert.throws(() => v.getValidatedData(req), ValidatedRequestUnavailableError);
});

test('schema and public-field configuration are snapshotted per middleware factory', async () => {
  const schemas = { body: z.record(z.string(), z.number()) };
  const fields = [];
  const v = createRequestValidation(schemas, { publicFields: { body: fields } });
  fields.push('SYNTHETIC_REQUEST_SECRET');
  schemas.body = z.unknown();
  const error = await run(v, { body: { SYNTHETIC_REQUEST_SECRET: 'bad' } });
  assert.ok(error instanceof RequestValidationError);
  assert.deepEqual(error.issues[0].path, ['[field]']);
  assert.throws(() => createRequestValidation({ headers: z.string() }), TypeError);
  assert.throws(() => createRequestValidation({ body: {} }), TypeError);
});

test('downstream next errors are not caught and forwarded a second time as validation failures', async () => {
  const v = createRequestValidation({ body: z.string() });
  const failure = new Error('downstream test failure');
  let calls = 0;
  await assert.rejects(v.middleware({ body: 'ok' }, {}, () => { calls++; throw failure; }),
    error => error === failure);
  assert.equal(calls, 1);
});

async function withTestRoute(validation, runHttp) {
  const app = express();
  app.use(express.json());
  let controllers = 0;
  // Isolated test routes and an adapter only; production app remains unchanged.
  app.post('/probe/:id', validation.middleware, (req, res) => {
    controllers++;
    res.json({ data: validation.getValidatedData(req), queryUnchanged: typeof req.query.limit === 'string' });
  });
  app.use((error, _req, res, _next) => {
    res.status(error instanceof RequestValidationError ? 400 : 500)
      .json({ code: error.code ?? 'TEST_INTERNAL_ERROR', issues: error.issues ?? [] });
  });
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    await runHttp(`http://127.0.0.1:${server.address().port}`, () => controllers);
  } finally {
    await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  }
}

function post(url, body) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

test('real Express 5 validates body/params/query and keeps its query getter unchanged', async () => {
  const v = createRequestValidation({ body: z.object({ name: z.string().trim() }),
    params: z.object({ id: z.coerce.number().positive() }),
    query: z.object({ limit: z.coerce.number().int().positive() }) });
  await withTestRoute(v, async (url, count) => {
    const response = await post(`${url}/probe/2?limit=5`, { name: ' test ', ignored: 'removed' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: { body: { name: 'test' }, params: { id: 2 },
      query: { limit: 5 } }, queryUnchanged: true });
    assert.equal(count(), 1);
  });
});

test('real Express 5 stops invalid requests before controllers without publishing an error contract', async () => {
  const v = createRequestValidation({ body: z.object({ name: z.string() }) });
  await withTestRoute(v, async (url, count) => {
    const response = await post(`${url}/probe/2`, { name: 1 });
    assert.equal(response.status, 400); // Only the test adapter chooses this HTTP shape.
    assert.equal((await response.json()).code, 'REQUEST_VALIDATION_FAILED');
    assert.equal(count(), 0);
  });
});

test('real Express 5 awaits async validation and handles execution failures without secrets', async () => {
  const v = createRequestValidation({ body: z.object({ name: z.string() }).transform(async data => {
    await Promise.resolve(); return { name: data.name.toUpperCase() };
  }) });
  await withTestRoute(v, async (url, count) => {
    const response = await post(`${url}/probe/2`, { name: 'test' });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, { body: { name: 'TEST' } });
    assert.equal(count(), 1);
  });
  const objectValidation = createRequestValidation({ body: z.object({ name: z.string() }).transform(async () => {
    throw new Error('SYNTHETIC_REQUEST_SECRET');
  }) });
  await withTestRoute(objectValidation, async (url, count) => {
    const response = await post(`${url}/probe/2`, { name: 'test' });
    assert.equal(response.status, 500);
    const body = await response.text();
    assert.match(body, /REQUEST_VALIDATION_EXECUTION_FAILED/);
    assert.ok(!body.includes('SYNTHETIC_REQUEST_SECRET'));
    assert.equal(count(), 0);
  });
});

test('validation imports and execution have no MongoDB dependency', () => {
  const moduleUrl = new URL('../dist/src/middlewares/validate-request.middleware.js', import.meta.url).href;
  const code = `
    import {registerHooks} from 'node:module';
    import {z} from 'zod';
    const hook=registerHooks({resolve(specifier,context,next){
      if (specifier==='mongoose'||specifier==='mongodb') throw new Error('Forbidden Mongo import');
      return next(specifier,context);
    }});
    const {createRequestValidation}=await import(${JSON.stringify(moduleUrl)});
    const v=createRequestValidation({body:z.string()}); const req={body:'ok'};
    await v.middleware(req,{},error=>{if(error)throw error;});
    if(v.getValidatedData(req).body!=='ok')process.exitCode=1;
    hook.deregister();
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', code],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test('TypeScript infers schema output types and rejects raw-input types and unconfigured parts', () => {
  const filename = path.resolve('test/request-validation-types.fixture.ts');
  const code = `
    import type {Request} from 'express';
    import {z} from 'zod';
    import {createRequestValidation} from '../src/middlewares/validate-request.middleware.js';
    const v=createRequestValidation({body:z.string().transform(s=>s.length),
      query:z.object({limit:z.coerce.number()})});
    function controller(request:Request){
      const data=v.getValidatedData(request);
      const length:number=data.body;
      const limit:number=data.query.limit;
      // @ts-expect-error transformed body is a number, not the input string
      const raw:string=data.body;
      // @ts-expect-error params were not configured
      data.params;
      // @ts-expect-error the validated container is readonly
      data.body=3;
      return [length,limit,raw];
    }
  `;
  const config = ts.readConfigFile('tsconfig.json', ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
  const host = ts.createCompilerHost(parsed.options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, ...rest) => path.resolve(file) === filename
    ? ts.createSourceFile(file, code, languageVersion, true) : getSourceFile(file, languageVersion, ...rest);
  const program = ts.createProgram([filename], { ...parsed.options, noEmit: true }, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => process.cwd(), getCanonicalFileName: f => f, getNewLine: () => '\n',
  }));
});

test('an older async validation cannot overwrite or revive data after a newer invocation', async () => {
  for (const latestValue of ['new', 'invalid']) {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const v = createRequestValidation({ body: z.string().refine(async value => {
      if (value === 'old') await gate;
      return value !== 'invalid';
    }) });
    const req = { body: 'old' };
    const old = run(v, req);
    req.body = latestValue;
    const latestError = await run(v, req);
    if (latestValue === 'invalid') {
      assert.ok(latestError instanceof RequestValidationError);
      assert.throws(() => v.getValidatedData(req), ValidatedRequestUnavailableError);
    } else {
      assert.equal(latestError, undefined);
      assert.equal(v.getValidatedData(req).body, 'new');
    }
    release();
    assert.ok(await old instanceof RequestValidationExecutionError);
    if (latestValue === 'invalid') {
      assert.throws(() => v.getValidatedData(req), ValidatedRequestUnavailableError);
    } else {
      assert.equal(v.getValidatedData(req).body, 'new');
    }
  }
});

test('validation error constructor drops extra metadata rather than copying sensitive input', () => {
  const issue = { part: 'body', path: ['safe'], code: 'custom', message: 'Valor inválido.',
    input: 'SYNTHETIC_REQUEST_SECRET', nested: { raw: 'SYNTHETIC_REQUEST_SECRET' } };
  const error = new RequestValidationError([issue]);
  assert.ok(!JSON.stringify(error).includes('SYNTHETIC_REQUEST_SECRET'));
  assert.deepEqual(Object.keys(error.issues[0]).sort(), ['code', 'message', 'part', 'path']);
  assert.equal(error.issues[0].message, 'Valor inválido.');
  assert.equal(error.cause, undefined);
});

test('optional fields preserve absence versus explicit undefined and handle null according to schema', async () => {
  const v = createRequestValidation({ body: z.object({
    optional: z.string().optional(), nullable: z.string().nullable().optional(),
  }) });
  const missing = { body: {} }, explicit = { body: { optional: undefined, nullable: null } };
  assert.equal(await run(v, missing), undefined);
  assert.equal(await run(v, explicit), undefined);
  assert.equal(Object.hasOwn(v.getValidatedData(missing).body, 'optional'), false);
  assert.equal(Object.hasOwn(v.getValidatedData(explicit).body, 'optional'), true);
  assert.equal(v.getValidatedData(explicit).body.optional, undefined);
  assert.equal(v.getValidatedData(explicit).body.nullable, null);
  assert.ok(await run(v, { body: { optional: null } }) instanceof RequestValidationError);
});

test('validated undefined output remains distinct from an unconfigured request part', async () => {
  const configured = createRequestValidation({ body: z.string().transform(() => undefined) });
  const empty = createRequestValidation({});
  const req = { body: 'value' };
  assert.equal(await run(configured, req), undefined);
  assert.equal(await run(empty, req), undefined);
  assert.equal(Object.hasOwn(configured.getValidatedData(req), 'body'), true);
  assert.equal(configured.getValidatedData(req).body, undefined);
  assert.equal(Object.hasOwn(empty.getValidatedData(req), 'body'), false);
});
