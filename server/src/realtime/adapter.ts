/**
 * Optional Redis adapter for Socket.IO horizontal scale.
 *
 * When REDIS_URL is set, room broadcasts go through Redis pub/sub so multiple
 * server instances see each other's rooms. Without it (or when Redis is
 * unreachable) we log and stay on the default in-memory adapter —
 * single-instance behavior, which is exactly what production runs today.
 *
 * Attached asynchronously right after the Socket.IO server is created; the
 * boot window before attach completes has no connected clients, so no events
 * can be lost to the adapter swap.
 */
import type { Server as IOServer } from 'socket.io';
import { createClient } from 'redis';
import { createAdapter } from '@socket.io/redis-adapter';
import { env } from '../config/env';
import { logger } from '../lib/logger';

type RedisClient = ReturnType<typeof createClient>;

let clients: RedisClient[] = [];

export async function attachRedisAdapter(
  server: IOServer,
  url: string | undefined = env.REDIS_URL,
): Promise<boolean> {
  if (!url) return false;

  let pub: RedisClient | null = null;
  let sub: RedisClient | null = null;
  try {
    pub = createClient({
      url,
      socket: {
        connectTimeout: 3000,
        // Fail fast at boot; a flapping Redis should not wedge startup.
        reconnectStrategy: (retries) => (retries > 3 ? new Error('redis unavailable') : 250),
      },
    });
    sub = pub.duplicate();
    for (const c of [pub, sub]) {
      c.on('error', (err) => logger.warn({ err }, 'socket.io redis client error'));
    }
    // allSettled, not all: when both connects reject, Promise.all would leave
    // the second rejection unhandled (crashes the process via unhandledRejection).
    const results = await Promise.allSettled([pub.connect(), sub.connect()]);
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (rejected) throw rejected.reason;

    server.adapter(createAdapter(pub, sub));
    clients = [pub, sub];
    logger.info('socket.io redis adapter attached — multi-instance broadcasts enabled');
    return true;
  } catch (err) {
    // Stop any reconnect loops on half-connected clients.
    for (const c of [pub, sub]) {
      if (!c) continue;
      try {
        c.destroy();
      } catch {
        /* already closed */
      }
    }
    logger.warn(
      { err },
      'redis adapter unavailable — staying on the in-memory adapter (single instance)',
    );
    return false;
  }
}

/** Close the adapter's Redis connections (graceful shutdown). */
export async function closeRedisAdapter(): Promise<void> {
  const toClose = clients;
  clients = [];
  await Promise.allSettled(toClose.map((c) => c.close()));
}
