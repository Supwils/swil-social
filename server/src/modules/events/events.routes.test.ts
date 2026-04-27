import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Router } from 'express';

const mocks = vi.hoisted(() => ({
  insertMany: vi.fn(),
}));

vi.mock('../../models/event.model', () => ({
  Event: { insertMany: mocks.insertMany },
}));

vi.mock('../../middlewares/auth', () => ({
  optionalUser: (req: { user?: unknown }, _res: unknown, next: (err?: unknown) => void) => {
    // Tests opt into a user by overriding req in runRoute
    next();
  },
}));

import { eventsRouter } from './events.routes';

type TestRes = {
  statusCode: number;
  payload: unknown;
  ended: boolean;
};

async function runRoute(
  router: Router,
  path: string,
  method: 'post',
  reqOverrides: Record<string, unknown> = {},
) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === path && entry.route.methods[method],
  );
  if (!layer?.route) throw new Error(`Route ${method.toUpperCase()} ${path} not found`);

  const req = {
    body: {},
    params: {},
    query: {},
    headers: {},
    method: method.toUpperCase(),
    ip: '127.0.0.1',
    originalUrl: path,
    ...reqOverrides,
  };

  let resolvePromise: (() => void) | null = null;
  const done = () => {
    if (!resolvePromise) return;
    const resolve = resolvePromise;
    resolvePromise = null;
    resolve();
  };

  const res = {
    statusCode: 200,
    payload: undefined as unknown,
    ended: false,
    reqId: 'req-1',
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.payload = payload; this.ended = true; done(); return this; },
    end() { this.ended = true; done(); return this; },
    setHeader() { return this; },
    getHeader() { return undefined; },
    append() { return this; },
  };

  let error: unknown;
  let idx = 0;
  await new Promise<void>((resolve) => {
    resolvePromise = resolve;
    const next = (err?: unknown) => {
      if (err) { error = err; done(); return; }
      const handle = layer.route.stack[idx++]?.handle;
      if (!handle) { done(); return; }
      try {
        const out = handle(req, res, next);
        if (out && typeof (out as Promise<unknown>).then === 'function') {
          (out as Promise<unknown>).then(() => { if (res.ended) done(); }).catch(next);
        } else if (res.ended) {
          done();
        }
      } catch (caught) { next(caught); }
    };
    next();
  });

  return { req, res: res as TestRes, error };
}

describe('events ingest route', () => {
  afterEach(() => { vi.clearAllMocks(); });

  it('inserts a batch of events with the resolved user and ip', async () => {
    mocks.insertMany.mockResolvedValue([]);
    const { res, error } = await runRoute(eventsRouter, '/', 'post', {
      body: { events: [{ type: 'post_view', sessionId: 's-1', context: { postId: 'p1' } }] },
      user: { _id: 'user-1' },
      ip: '203.0.113.5',
    });

    expect(error).toBeUndefined();
    expect(mocks.insertMany).toHaveBeenCalledWith(
      [{ type: 'post_view', userId: 'user-1', sessionId: 's-1', context: { postId: 'p1' }, ip: '203.0.113.5' }],
      { ordered: false },
    );
    expect(res.payload).toMatchObject({ data: { received: 1 } });
  });

  it('uses null for userId when no user is attached', async () => {
    mocks.insertMany.mockResolvedValue([]);
    await runRoute(eventsRouter, '/', 'post', {
      body: { events: [{ type: 'page', sessionId: 's-2' }] },
    });

    expect(mocks.insertMany).toHaveBeenCalledWith(
      [{ type: 'page', userId: null, sessionId: 's-2', context: {}, ip: '127.0.0.1' }],
      { ordered: false },
    );
  });

  it('rejects an empty batch via schema validation', async () => {
    const { error } = await runRoute(eventsRouter, '/', 'post', {
      body: { events: [] },
    });
    // validate middleware passes a ZodError to next() — error is non-undefined
    expect(error).toBeDefined();
    expect(mocks.insertMany).not.toHaveBeenCalled();
  });

  it('rejects more than 50 events in one batch', async () => {
    const events = Array.from({ length: 51 }, (_, i) => ({ type: 't', sessionId: `s-${i}` }));
    const { error } = await runRoute(eventsRouter, '/', 'post', { body: { events } });
    expect(error).toBeDefined();
    expect(mocks.insertMany).not.toHaveBeenCalled();
  });

  it('still returns success when insertMany throws — analytics never breaks the request', async () => {
    mocks.insertMany.mockRejectedValue(new Error('mongo down'));
    const { res, error } = await runRoute(eventsRouter, '/', 'post', {
      body: { events: [{ type: 'post_view', sessionId: 's-3' }] },
    });

    expect(error).toBeUndefined();
    expect(res.payload).toMatchObject({ data: { received: 1 } });
  });
});
