import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { Connection } from 'mongoose';
import { validateDb02Request, verifyOwnedDocker } from './agro-db02/guard.js';
import { connectOwned } from './agro-db02/resources.js';
import { createMongooseSensorRepository } from '../src/repositories/sensor.repository.js';

async function main() {
  if (!process.send) throw new Error('BE11_WORKER_REQUIRES_IPC');
  const request=validateDb02Request(process.env);verifyOwnedDocker(request);let connection:Connection|undefined;
  try {
    connection=await connectOwned(request,'agro_db02_test_'+request.runId);
    const {repository}=await createMongooseSensorRepository({connection,prefix:'agro_sensors_be11',businessPrefix:'agro_business_be11'});
    process.send({status:'ready',pid:process.pid});
    const message=await new Promise<unknown>(resolve=>process.once('message',resolve));
    const command=z.object({sensorId:z.string().min(1),physicalDeviceId:z.string().min(1),validFrom:z.number().int().nonnegative()}).strict().parse(message);
    let won=true;try{await repository.createAssociation({realm:'test',clientId:'client-A'},{...command,auditReason:'two-process-race'});}catch(error){if(!(error instanceof Error&&'code'in error&&error.code==='CONFLICT'))throw error;won=false;}
    process.send({status:'done',pid:process.pid,won});
  } catch { process.send?.({status:'failed',pid:process.pid});process.exitCode=1; }
  finally { await connection?.close();process.disconnect?.(); }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
