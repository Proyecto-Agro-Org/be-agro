import mongoose, { type Connection } from 'mongoose';
import { loadMongoConfig, MongoConfigurationError, type MongoConfig } from '../config/mongodb.js';

export class MongoConnectionError extends Error {
  readonly code = 'MONGODB_CONNECTION_FAILED';

  constructor() {
    super('No se pudo establecer la conexión MongoDB.');
    this.name = 'MongoConnectionError';
  }
}

export class MongoDisconnectionError extends Error {
  readonly code = 'MONGODB_DISCONNECTION_FAILED';

  constructor() {
    super('No se pudo cerrar la conexión MongoDB.');
    this.name = 'MongoDisconnectionError';
  }
}

export type MongoConnectionState = 'disconnected' | 'connecting' | 'connected' | 'disconnecting' | 'error';

// The injected factory creates an unopened connection. No factory runs at import.
export function createMongoConnectionManager(
  createConnection: () => Connection = () => mongoose.createConnection(),
) {
  let connection: Connection | undefined;
  let activeConfig: MongoConfig | undefined;
  let opening: Promise<Connection> | undefined;
  let closing: Promise<void> | undefined;
  let failed = false;
  let blocked = false;

  function getState(): MongoConnectionState {
    if (closing) return 'disconnecting';
    if (opening) return 'connecting';
    if (blocked) return 'error';
    switch (connection?.readyState) {
      case 1: return 'connected';
      case 2: return 'connecting';
      case 3: return 'disconnecting';
      default: return failed ? 'error' : 'disconnected';
    }
  }

  async function connect(environment: Record<string, unknown> = process.env): Promise<Connection> {
    const config = loadMongoConfig(environment);
    if (closing) await closing;
    if (blocked) throw new MongoConnectionError();
    if (activeConfig && (opening || connection?.readyState === 1) &&
      (activeConfig.uri !== config.uri || activeConfig.serverSelectionTimeoutMS !== config.serverSelectionTimeoutMS)) {
      // Do not silently switch a live manager to another database or configuration.
      throw new MongoConfigurationError();
    }
    if (opening) return opening;
    if (connection?.readyState === 1) return connection;
    if (connection && connection.readyState !== 0) throw new MongoConnectionError();

    activeConfig = config;
    opening = Promise.resolve().then(async () => {
      try {
        if (!connection) {
          connection = createConnection();
          // Mongoose emits error events as well as rejecting openUri(). Never log
          // raw event payloads, which may contain credentials or host details.
          connection.on('error', () => { failed = true; });
        } else {
          // readyState=0 may follow a network interruption while the driver's
          // old client still exists. Close it before opening another pool.
          try {
            await connection.close();
          } catch {
            blocked = true;
            throw new MongoDisconnectionError();
          }
        }
        await connection.openUri(config.uri, {
          serverSelectionTimeoutMS: config.serverSelectionTimeoutMS,
          connectTimeoutMS: config.serverSelectionTimeoutMS,
          maxPoolSize: 5,
          minPoolSize: 0,
          autoCreate: false,
          autoIndex: false,
          bufferCommands: false,
        });
        if (connection.readyState !== 1) throw new MongoConnectionError();
        failed = false;
        return connection;
      } catch {
        failed = true;
        if (!blocked) {
          try { await connection?.close(); } catch { blocked = true; }
        }
        activeConfig = undefined;
        throw new MongoConnectionError();
      } finally {
        opening = undefined;
      }
    });
    return opening;
  }

  async function disconnect(): Promise<void> {
    if (closing) return closing;
    // Mongoose can stay in readyState=3 after close() rejects. Calling close()
    // again then waits for a close event that may never arrive. Keep this
    // manager quarantined; disposal requires controlled worker shutdown.
    if (blocked) throw new MongoDisconnectionError();
    closing = Promise.resolve().then(async () => {
      try {
        // Serialize shutdown after any opening attempt; an opening error is
        // already sanitized for its caller. Never retry a failed cleanup.
        try { await opening; } catch { /* Continue cleanup. */ }
        if (blocked) throw new MongoDisconnectionError();
        await connection?.close();
        activeConfig = undefined;
        failed = false;
        blocked = false;
      } catch {
        failed = true;
        blocked = true;
        throw new MongoDisconnectionError();
      } finally {
        closing = undefined;
      }
    });
    return closing;
  }

  return { connect, disconnect, getState };
}

// Reuse per warm process; consumers must explicitly connect after authorization.
export const mongoConnection = createMongoConnectionManager();
