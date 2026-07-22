import { afterEach, describe, expect, it } from 'vitest';
import { Server as IOServer } from 'socket.io';
import { attachRedisAdapter, closeRedisAdapter } from './adapter';

// Live-redis cases run only when TEST_REDIS_URL is provided (local dev:
// `TEST_REDIS_URL=redis://127.0.0.1:6379 npx vitest run src/realtime/adapter.test.ts`).
// CI has no Redis service for this suite, so they skip there by design.
const LIVE_REDIS = process.env.TEST_REDIS_URL;

describe('attachRedisAdapter', () => {
  let server: IOServer | null = null;

  afterEach(async () => {
    await closeRedisAdapter();
    if (server) {
      // Standalone IOServer (no http server attached) — its close() rejects
      // internally on the missing httpServer; harmless here.
      await server.close().catch(() => undefined);
      server = null;
    }
  });

  it('returns false and stays on the memory adapter when no URL is configured', async () => {
    server = new IOServer();
    // Empty string (not undefined) — undefined would fall back to env.REDIS_URL.
    await expect(attachRedisAdapter(server, '')).resolves.toBe(false);
  });

  it('fails fast and falls back when Redis is unreachable', async () => {
    server = new IOServer();
    const attached = await attachRedisAdapter(server, 'redis://127.0.0.1:6390');
    expect(attached).toBe(false);
  }, 15_000);

  it.skipIf(!LIVE_REDIS)('attaches the Redis adapter against a live Redis', async () => {
    server = new IOServer();
    const attached = await attachRedisAdapter(server, LIVE_REDIS);
    expect(attached).toBe(true);
    // The default namespace now uses the redis-adapter implementation.
    expect(server.of('/').adapter.constructor.name).toBe('RedisAdapter');
  });

  it.skipIf(!LIVE_REDIS)('closeRedisAdapter disconnects cleanly', async () => {
    server = new IOServer();
    await attachRedisAdapter(server, LIVE_REDIS);
    await expect(closeRedisAdapter()).resolves.toBeUndefined();
  });
});
