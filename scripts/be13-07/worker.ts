import type { Connection } from 'mongoose';
import { z } from 'zod';
import { validateMultiNodeRequest, verifyOwnedMultiNode } from './guard.js';
import { connectMultiNode } from './connect.js';
import { createMongoMeasurementPersistence } from '../../src/repositories/mongo-measurement-persistence.repository.js';

// BE13-07 multi-node concurrency worker: child process with IPC parent only.
const setupSchema = z.object({ prefix: z.string(), input: z.record(z.string(), z.unknown()) }).strict();

async function runWorker() {
  let connection: Connection | undefined;
  const deadline = setTimeout(() => { process.exitCode = 1; void connection?.close().finally(() => process.exit(1)); }, 90000);
  try {
    if (!process.send) throw new Error('MN_WORKER_REQUIRES_PARENT');
    const request = validateMultiNodeRequest(process.env); verifyOwnedMultiNode(request);
    connection = await connectMultiNode(request);
    const setupMessage = new Promise(resolve => process.once('message', resolve));
    process.send({ status: 'ready', pid: process.pid });
    const setup = setupSchema.parse(await setupMessage);
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
