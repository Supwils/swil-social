import { afterEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import type { Router } from 'express';

const mocks = vi.hoisted(() => ({
  following: vi.fn(),
  global: vi.fn(),
  byTag: vi.fn(),
  byAuthor: vi.fn(),
}));

vi.mock('../../middlewares/auth', () => ({
  requireUser: (req: { user?: unknown }, _res: unknown, next: (err?: unknown) => void) => {
    req.user = { _id: new Types.ObjectId(), id: 'viewer-id' };
    next();
  },
  optionalUser: (req: { user?: unknown }, _res: unknown, next: (err?: unknown) => void) => {
    next();
  },
}));

vi.mock('./feed.service', () => ({
  following: mocks.following,
  global: mocks.global,
  byTag: mocks.byTag,
  byAuthor: mocks.byAuthor,
}));

import { feedRouter, userPostsRouter } from './feed.routes';

async function runRoute(
  router: Router,
  path: string,
  method: 'get',
  reqOverrides: Record<string, unknown> = {},
) {
  const layer = router.stack.find((entry) => entry.route?.path === path && entry.route.methods[method]);
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
    headers: {} as Record<string, string | string[] | number>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.payload = payload;
      this.ended = true;
      done();
      return this;
    },
    end() {
      this.ended = true;
      done();
      return this;
    },
    setHeader(name: string, value: string | string[] | number) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    getHeader(name: string) {
      return this.headers[name.toLowerCase()];
    },
    append(name: string, value: string | string[] | number) {
      this.setHeader(name, value);
      return this;
    },
  };

  let error: unknown;
  let idx = 0;
  await new Promise<void>((resolve) => {
    resolvePromise = resolve;
    const next = (err?: unknown) => {
      if (err) {
        error = err;
        done();
        return;
      }
      const handle = layer.route.stack[idx++]?.handle;
      if (!handle) {
        done();
        return;
      }
      try {
        const out = handle(req, res, next);
        if (out && typeof (out as Promise<unknown>).then === 'function') {
          (out as Promise<unknown>)
            .then(() => {
              if (res.ended) done();
            })
            .catch(next);
        } else if (res.ended) {
          done();
        }
      } catch (caught) {
        next(caught);
      }
    };
    next();
  });

  return { req, res, error };
}

describe('feed routes', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns following feed for an authenticated viewer', async () => {
    mocks.following.mockResolvedValue({ items: [], nextCursor: null, ctxById: new Map() });

    const { res, error } = await runRoute(feedRouter, '/', 'get', {
      query: { limit: '12' },
    });

    expect(error).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(mocks.following).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'viewer-id' }),
      null,
      12,
      'recommended',
    );
  });

  it('returns global feed for anonymous viewers', async () => {
    mocks.global.mockResolvedValue({ items: [], nextCursor: null, ctxById: new Map() });

    const { res, error } = await runRoute(feedRouter, '/global', 'get');

    expect(error).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(mocks.global).toHaveBeenCalledWith(null, null, 20, 'recommended');
  });

  it('passes tag slugs through to the tag feed', async () => {
    mocks.byTag.mockResolvedValue({ items: [], nextCursor: null, ctxById: new Map() });

    const { res, error } = await runRoute(feedRouter, '/tag/:slug', 'get', {
      params: { slug: 'typescript' },
    });

    expect(error).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(mocks.byTag).toHaveBeenCalledWith('typescript', null, null, 20);
  });

  it('lists a user profile feed with validated params', async () => {
    mocks.byAuthor.mockResolvedValue({ items: [], nextCursor: null, ctxById: new Map() });

    const { res, error } = await runRoute(userPostsRouter, '/', 'get', {
      params: { username: 'ada' },
      query: { limit: '7' },
    });

    expect(error).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(mocks.byAuthor).toHaveBeenCalledWith('ada', null, null, 7);
  });
});
