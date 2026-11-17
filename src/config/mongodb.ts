import { mongo } from 'mongoose';
import { z } from 'zod';

export class MongoConfigurationError extends Error {
  readonly code = 'MONGODB_CONFIG_INVALID';

  constructor() {
    super('Configuración MongoDB inválida: revisar MONGODB_URI y MONGODB_SERVER_SELECTION_TIMEOUT_MS.');
    this.name = 'MongoConfigurationError';
  }
}

function isMongoUri(value: string): boolean {
  // Require an explicit database, never silently use the driver's default "test".
  if (/\s/.test(value) || !/^mongodb(?:\+srv)?:\/\/[^/?#]+\/[^/?#]+(?:\?[^#]*)?$/.test(value)) {
    return false;
  }
  try {
    // Constructor parses locally; only connect() would perform network I/O.
    const client = new mongo.MongoClient(value);
    // The URI parser does not enforce server database-name restrictions.
    // Validate its decoded result, including encoded forbidden characters.
    const database = client.options.dbName;
    return typeof database === 'string' && database.length > 0 &&
      Buffer.byteLength(database, 'utf8') < 64 && !/[\/\\."$\x00\s]/u.test(database);
  } catch {
    return false;
  }
}

const mongoEnvironmentSchema = z.object({
  MONGODB_URI: z.string().min(1).refine(isMongoUri),
  MONGODB_SERVER_SELECTION_TIMEOUT_MS: z.string()
    .regex(/^[0-9]+$/)
    .transform(Number)
    .pipe(z.number().int().min(100).max(30000))
    .default(5000),
});

export interface MongoConfig {
  readonly uri: string;
  readonly serverSelectionTimeoutMS: number;
}

export function loadMongoConfig(environment: Record<string, unknown> = process.env): MongoConfig {
  const result = mongoEnvironmentSchema.safeParse(environment);
  if (!result.success) {
    // Never expose Zod issues, driver exceptions, input values or an error cause.
    throw new MongoConfigurationError();
  }
  return Object.freeze({
    uri: result.data.MONGODB_URI,
    serverSelectionTimeoutMS: result.data.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
  });
}
