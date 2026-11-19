import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export async function raceProcesses(command: { operation: 'cas' } | { operation: 'claim'; digest: string; nonce: string; at: number }) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(PATH|Path|SystemRoot|WINDIR|TEMP|TMP|HOME|USERPROFILE|DOCKER_HOST|DOCKER_CONTEXT|DOCKER_CONFIG|AGRO_DB02_.*)$/.test(key)));
  const children = [0, 1].map(() => fork(fileURLToPath(new URL('./worker.js', import.meta.url)), [],
    { env: environment, execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }));
  const messageSchema = z.object({ status: z.enum(['ready', 'done', 'failed']), pid: z.number().int(), won: z.boolean().optional() }).strict();
  try {
    const results = children.map(child => new Promise<{ won: boolean; pid: number }>((resolve, reject) => {
      child.on('error', () => reject(new Error('DB02_CHILD_FAILED')));
      child.on('exit', code => { if (code !== 0) reject(new Error('DB02_CHILD_EXIT')); });
      child.on('message', input => {
        const parsed = messageSchema.safeParse(input);
        if (!parsed.success || parsed.data.status === 'failed' || parsed.data.pid !== child.pid) { reject(new Error('DB02_CHILD_PROTOCOL')); return; }
        if (parsed.data.status === 'ready') { ready.add(child); if (ready.size === 2) for (const c of children) c.send(command); }
        if (parsed.data.status === 'done') {
          if (typeof parsed.data.won !== 'boolean') reject(new Error('DB02_CHILD_PROTOCOL'));
          else resolve({ won: parsed.data.won, pid: parsed.data.pid });
        }
      });
    }));
    const ready = new Set<typeof children[number]>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([Promise.all(results), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('DB02_CHILD_DEADLINE')), 45000);
      })]);
      assert.equal(new Set(outcome.map(r => r.pid)).size, 2);
      assert.ok(outcome.every(r => r.pid !== process.pid));
      assert.equal(outcome.filter(r => r.won).length, 1);
      return { pids: outcome.map(r => r.pid), winners: 1 };
    } finally { clearTimeout(timer); }
  } finally {
    await Promise.all(children.map(child => new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      const timer = setTimeout(() => child.kill(), 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    })));
  }
}
