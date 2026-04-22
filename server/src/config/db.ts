import mongoose from 'mongoose';
import { env } from './env';
import { logger } from '../lib/logger';

let connected = false;

export async function connectDb(): Promise<typeof mongoose> {
  if (connected) return mongoose;

  mongoose.set('strictQuery', true);

  mongoose.connection.on('connected', () => {
    logger.info({ uri: redact(env.MONGODB_URI) }, 'mongo connected');
  });
  mongoose.connection.on('disconnected', () => {
    logger.warn('mongo disconnected');
    connected = false;
  });
  mongoose.connection.on('error', (err) => {
    logger.error({ err }, 'mongo error');
  });

  await mongoose.connect(env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10_000,
  });

  connected = true;
  return mongoose;
}

export async function syncAllIndexes(): Promise<void> {
  const modelNames = mongoose.modelNames();
  await Promise.all(
    modelNames.map(async (name) => {
      const model = mongoose.model(name);
      try {
        await model.syncIndexes();
        logger.debug({ model: name }, 'indexes synced');
      } catch (err) {
        logger.error({ err, model: name }, 'index sync failed');
      }
    }),
  );
}

export async function disconnectDb(): Promise<void> {
  if (!connected) return;
  await mongoose.disconnect();
  connected = false;
}

export function isDbHealthy(): boolean {
  return mongoose.connection.readyState === 1;
}

function redact(uri: string): string {
  return uri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@');
}
