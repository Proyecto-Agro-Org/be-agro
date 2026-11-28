// BE13-11D — LOCAL_TEST_ONLY child process: a REAL consumer process that the campaign can kill with SIGKILL at an exact point
// (before persisting, after persisting but before the ACK, or after the ACK but before the measurement). Config comes from the
// environment of the parent (credentials are TEST_ONLY and never printed). Not a production worker.
import { connectMultiNode } from '../be13-07/connect.js';
import { validateMultiNodeRequest, verifyOwnedMultiNode } from '../be13-07/guard.js';
import { startLabConsumer, type LabConsumerHooks } from './lab-consumer.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const die = (): void => { process.kill(process.pid, 'SIGKILL'); };            // no handlers, no flush: a hard process death

async function main() {
  const request = validateMultiNodeRequest(process.env); verifyOwnedMultiNode(request);
  const crash = process.env.LAB_CRASH ?? 'none';
  const hooks: LabConsumerHooks = {};
  if (crash === 'before-persist') hooks.beforePersist = die;
  if (crash === 'after-persist') hooks.afterPersist = die;                            // record durable + receipted, ACK never sent
  if (crash === 'freeze-processing') hooks.beforeProcess = () => new Promise<void>(() => { /* BE13-11E: acked + receipted forever; the parent kills this process */ });
  if (crash === 'after-ack') hooks.beforeProcess = async () => { await sleep(500); die(); };   // PUBACK flushed, measurement never written
  const conn = await connectMultiNode(request);
  const sink: { name: string; labels: object }[] = [];
  const consumer = await startLabConsumer({ conn, brokerUrl: String(process.env.LAB_BROKER_URL), password: String(process.env.LAB_CONSUMER_PASSWORD),
    clientId: process.env.LAB_CLIENT_ID ?? 'lab-consumer-1', hooks, metricsSink: sink });
  console.log('LAB_CONSUMER_READY ' + consumer.adapter.connectionReference());
  process.on('SIGTERM', () => { void consumer.stop().then(() => conn.close()).then(() => process.exit(0)); });
  await new Promise(() => { /* serve until killed */ });
}
main().catch(error => { console.error('LAB_CONSUMER_FAILED ' + (error instanceof Error ? error.name : 'Unknown')); process.exit(1); });
