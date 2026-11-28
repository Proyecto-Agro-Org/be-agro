import { fork } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateDb02Request, verifyOwnedDocker } from './agro-db02/guard.js';
import { collectionNames, connectOwned, provisionOwned } from './agro-db02/resources.js';
import { runDatabaseCases, type CaseResult } from './agro-db02/cases.js';
import type { Connection } from 'mongoose';

// Nothing runs on import. The entry point is opt-in, never reached by app/npm test.
async function auditOwnedDatabase() {
  const request = validateDb02Request(process.env), docker = verifyOwnedDocker(request);
  const database = 'agro_db02_test_' + request.runId, created: string[] = [], results: CaseResult[] = [];
  let connection: Connection | undefined, cleanup = 'not-needed';
  console.log(JSON.stringify({ event: 'db02-start', database, docker, topologyRequested: request.topology,
    authorization: 'AGRO-DB-02 / explicit disposable container', parentPid: process.ppid, pid: process.pid }));
  try {
    connection = await connectOwned(request, database);
    const info = await connection.db!.command({ buildInfo: 1 }, { timeoutMS: 3000 });
    console.log(JSON.stringify({ event: 'db02-server', version: info.version, topology: request.topology,
      failoverProven: false, multiNodeDurabilityProven: false }));
    try { await provisionOwned(connection, created); }
    catch (error: unknown) {
      const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'number' ? error.code : null;
      const codeName = typeof error === 'object' && error !== null && 'codeName' in error && typeof error.codeName === 'string' && /^[A-Za-z0-9_]+$/.test(error.codeName) ? error.codeName : null;
      console.info(JSON.stringify({ event: 'db02-provision-error', code, codeName })); throw error;
    }
    console.log(JSON.stringify({ event: 'db02-created', database, collections: created }));
    await runDatabaseCases(connection, result => {
      results.push(result); console.log(JSON.stringify({ event: 'db02-case', ...result }));
    });
  } finally {
    let failed = false;
    if (created.length) {
      try {
        verifyOwnedDocker(request); // Check ownership again before any cleanup.
        if (connection?.readyState !== 1) connection = await connectOwned(request, database);
        if (connection.name !== database || connection.db?.databaseName !== database) throw new Error();
        for (const name of created) {
          if (!collectionNames.includes(name as typeof collectionNames[number])) throw new Error();
          await connection.db.dropCollection(name);
        }
        if ((await connection.db.listCollections({}, { nameOnly: true }).toArray()).length !== 0) throw new Error();
        cleanup = 'owned-collections-removed-and-verified';
      } catch { failed = true; cleanup = 'unconfirmed-inspect-owned-container'; }
    }
    try { await connection?.close(); } catch { failed = true; }
    console.log(JSON.stringify({ event: 'db02-summary', passed: results.filter(r => r.status === 'passed').length,
      failed: results.filter(r => r.status === 'failed').length, cleanup, database,
      omitted: ['physical TTL timing', 'multi-node failover', 'journal restart durability', 'real network ACK loss',
        'real Google', 'current IoT authenticated attribution', 'Atlas', 'Preview'] }));
    if (failed) throw new Error('DB02_CLEANUP_UNCONFIRMED');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    validateDb02Request(process.env); verifyOwnedDocker(validateDb02Request(process.env));
    if (process.argv[2] === '--owned-worker') await auditOwnedDatabase();
    else {
      // Hard ceiling for the whole campaign, including both process races.
      const child = fork(fileURLToPath(import.meta.url), ['--owned-worker'], { execArgv: [], windowsHide: true,
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      let deadline = false;
      const timer = setTimeout(() => { deadline = true; child.kill(); }, 180000);
      try {
        await new Promise<void>((resolve, reject) => {
          child.once('error', () => reject(new Error()));
          child.once('exit', code => code === 0 && !deadline ? resolve() : reject(new Error()));
        });
      } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill(); }
    }
  } catch {
    console.error('DB02_NOT_COMPLETED: verify opt-in, owned local Docker resources, case results and cleanup; no public error detail.');
    process.exitCode = 1;
  }
}
