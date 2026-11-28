import { z } from 'zod';
import { validateDb02Request, verifyOwnedDocker } from './guard.js';
import { connectOwned, realPorts } from './resources.js';
import type { Connection } from 'mongoose';
import { pathToFileURL } from 'node:url';
import { digestSecret } from '../../src/auth/session-security.js';
import { createSessionService } from '../../src/services/session.service.js';

// Not a server or runtime adapter. Only child processes with an IPC parent may run.
async function runWorker() {
let connection: Connection | undefined;
const timer = setTimeout(() => { process.exitCode = 1; void connection?.close().finally(() => process.exit(1)); }, 30000);
try {
  if (!process.send) throw new Error('DB02_WORKER_REQUIRES_PARENT');
  const request = validateDb02Request(process.env); verifyOwnedDocker(request);
  connection = await connectOwned(request, 'agro_db02_test_' + request.runId);
  const ports = await realPorts(connection);
  const message = new Promise<unknown>(resolve => process.once('message', resolve));
  process.send({ status: 'ready', pid: process.pid });
  const command = z.discriminatedUnion('operation', [
    z.object({ operation: z.literal('claim'), digest: z.string().regex(/^[a-f0-9]{64}$/), nonce: z.string().regex(/^[a-f0-9]{64}$/), at: z.number().int() }).strict(),
    z.object({ operation: z.literal('cas') }).strict(),
    z.object({ operation: z.enum(['revoke', 'inspect-revoked']), token: z.string().min(43).max(256), at: z.number().int().nonnegative().safe() }).strict(),
  ]).parse(await message);
  let won: boolean;
  if (command.operation === 'claim') won = await ports.repository.consumeChallenge(command.digest, command.nonce, 'test', command.at);
  else if (command.operation === 'revoke') {
    await ports.repository.revokeSession(digestSecret(command.token), 'test', command.at);
    won = typeof (await ports.repository.findSessionByDigest(digestSecret(command.token), 'test'))?.revokedAt === 'number';
  } else if (command.operation === 'inspect-revoked') {
    const sessions = createSessionService({ repository: ports.repository, catalogue: ports.catalogue,
      verifier: { async verify() { throw new Error('Google verifier is not used in this fixture check'); } } },
    { realm: 'test', audience: '123-local-audit.apps.googleusercontent.com', allowedOrigins: ['http://127.0.0.1:3000'],
      challengeTtlMs: 60000, absoluteTtlMs: 600000, idleTtlMs: 60000 }, () => command.at);
    won = false;
    try { await sessions.authorization.authenticate(command.token); }
    catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && error.code === 'UNAUTHENTICATED')) throw error;
      won = true;
    }
  } else {
    try { await ports.admin.changeMembership({ userId: 'race-user', expectedVersion: 0, clientId: 'client-b' }); won = true; }
    catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && error.code === 'CONFLICT')) throw error;
      won = false;
    }
  }
  process.send({ status: 'done', won, pid: process.pid });
} catch { process.send?.({ status: 'failed', pid: process.pid }); process.exitCode = 1; }
finally { clearTimeout(timer); await connection?.close(); process.disconnect?.(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runWorker();
