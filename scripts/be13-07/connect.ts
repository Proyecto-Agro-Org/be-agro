import { Mongoose, type Connection } from 'mongoose';
import { assertLocalMultiNodeHello, assertLocalMultiNodeUri, multiNodeUri, type MultiNodeRequest } from './guard.js';

// Connects to the owned local replica set only (guards checked before and after).
export async function connectMultiNode(request: MultiNodeRequest, monitorCommands = false): Promise<Connection> {
  const database = 'agro_mn_test_' + request.runId;
  const uri = multiNodeUri(request, database);
  assertLocalMultiNodeUri(uri, request.ports);
  const connection = new Mongoose().createConnection(); connection.on('error', () => {});
  await connection.openUri(uri, { family: 4, autoCreate: false, autoIndex: false, bufferCommands: false, serverSelectionTimeoutMS: 30000,
    connectTimeoutMS: 5000, socketTimeoutMS: 20000, heartbeatFrequencyMS: 500, maxPoolSize: 5, minPoolSize: 0, monitorCommands });
  assertLocalMultiNodeHello(await connection.db!.command({ hello: 1 }), request.ports);
  return connection;
}
