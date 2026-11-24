import type { Connection } from 'mongoose';
import { z } from 'zod';
import { validateDb02Request, verifyOwnedDocker } from '../agro-db02/guard.js';
import { connectOwned } from '../agro-db02/resources.js';
import { createMongoMeasurementPersistence } from '../../src/repositories/mongo-measurement-persistence.repository.js';

// BE13-06 concurrency worker. Not a server/runtime adapter: it only runs as a
// child process with an IPC parent, against the owned disposable database.
const commandSchema = z.object({ prefix: z.string(), input: z.record(z.string(), z.unknown()) }).strict();

async function runWorker() {
  let connection: Connection | undefined;
  const deadline = setTimeout(() => { process.exitCode = 1; void connection?.close().finally(() => process.exit(1)); }, 45000);
  try {
    if (!process.send) throw new Error('BE1306_WORKER_REQUIRES_PARENT');
    const request = validateDb02Request(process.env); verifyOwnedDocker(request);
    connection = await connectOwned(request, 'agro_db02_test_' + request.runId);
    // Each listener is registered BEFORE announcing the state, so no IPC message can be lost.
    const setupMessage = new Promise(resolve => process.once('message', resolve));
    process.send({ status: 'ready', pid: process.pid });
    const setup = commandSchema.parse(await setupMessage);
    let attempts = 0;
    const persistence = createMongoMeasurementPersistence({ connection, prefix: setup.prefix, realm: 'test', testSeams: { onAttempt: n => { attempts = n; } } });
    const go = new Promise(resolve => process.once('message', resolve));
    process.send({ status: 'armed', pid: process.pid });
    await go;
    let outcome: string;
    try { outcome = (await persistence.persistAtomically(setup.input as never)).status; } catch { outcome = 'error'; }
    process.send({ status: 'done', pid: process.pid, outcome, attempts });
  } catch {
    process.send?.({ status: 'failed', pid: process.pid });
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    await connection?.close().catch(() => {});
  }
}

void runWorker();
