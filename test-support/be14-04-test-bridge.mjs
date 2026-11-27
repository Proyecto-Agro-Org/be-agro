// BE14-04 — HARNESS SELF-TEST BRIDGE. NOT a publisher and NOT a certification target.
// It wraps the BE14-01 REFERENCE publisher behind the stdio JSON-lines protocol, with a REAL clock and a REAL MQTT connection (mqtt.js -> the local EMQX lab).
// It declares itself a TEST DOUBLE (op "identity"), so the kit can never label a run against it `CONFORMANCE PASS EXTERNAL` — only `HARNESS_SELF_TEST`.
// Broker credentials arrive in the boot args at runtime (never in a file / argv / report).
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { createReferenceAdapter } = await import(pathToFileURL(resolve(root, 'dist/scripts/be14-03/reference-adapter.js')).href);
const adapter = createReferenceAdapter({}, undefined, { realClock: true, ackTimeoutMs: 2500, connectTimeoutMs: 4000 });
const reply = (id, ok, v) => process.stdout.write(JSON.stringify(ok ? { id, ok, result: v ?? null } : { id, ok, error: String(v) }) + '\n');
let chain = Promise.resolve();                                   // strictly serial, like a device main loop
createInterface({ input: process.stdin }).on('line', line => {
  const { id, op, args } = JSON.parse(line);
  chain = chain.then(async () => {
    try {
      if (op === 'identity') return reply(id, true, { name: 'be14-04-harness-test-bridge(reference-publisher)', testDouble: true });
      if (op === 'capabilities') return reply(id, true, await adapter.capabilities());
      if (op === 'boot') return reply(id, true, await adapter.boot(args));
      if (op === 'createEvent') return reply(id, true, await adapter.createEvent(args));
      if (op === 'advance') return reply(id, true, await adapter.advance(args.ms));
      if (op === 'inspectPending') return reply(id, true, await adapter.inspectPending());
      if (op === 'armCrash') return reply(id, true, await adapter.armCrash(args.point));
      if (op === 'setClock') return reply(id, true, await adapter.setClock(args.ms));
      if (op === 'corruptOutbox') return reply(id, true, await adapter.corruptOutbox(args.kind));
      if (op === 'restart') return reply(id, true, await adapter.restart());
      if (op === 'shutdown') { await adapter.shutdown(); reply(id, true, null); return process.exit(0); }
      reply(id, false, 'unknown op ' + op);
    } catch (e) { reply(id, false, e && e.message ? e.message : e); }
  });
});
