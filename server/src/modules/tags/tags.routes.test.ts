import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Router } from 'express';
import { Types } from 'mongoose';

const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  findOne: vi.fn(),
}));

vi.mock('../../models/tag.model', async () => {
  const actual = await vi.importActual<typeof import('../../models/tag.model')>('../../models/tag.model');
  return {
    ...actual,
    Tag: {
      ...actual.Tag,
      find: mocks.find,
      findOne: mocks.findOne,
    },
  };
});

import { tagsRouter } from './tags.routes';

type TestRes = {
  statusCode: number;
  payload: unknown;
  ended: boolean;
  headers: Record<string, string | string[] | number>;
};

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
    reqId: 'req-1',
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

  return { req, res: res as TestRes, error };
}

describe('tags routes', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('lists trending tags with the provided limit', async () => {
    const limit = vi.fn().mockResolvedValue([
      { slug: 'typescript', display: 'TypeScript', postCount: 10 },
    ]);
    const sort = vi.fn().mockReturnValue({ limit });
    mocks.find.mockReturnValue({ sort });

    const { res, error } = await runRoute(tagsRouter, '/trending', 'get', {
      query: { limit: '5' },
    });

    expect(error).toBeUndefined();
    expect(mocks.find).toHaveBeenCalledWith({
      lastUsedAt: { $gte: expect.any(Date) },
      isAlias: { $ne: true },
    });
    expect(sort).toHaveBeenCalledWith({ postCount: -1 });
    expect(limit).toHaveBeenCalledWith(5);
    expect(res.payload).toEqual({
      data: {
        items: [{ slug: 'typescript', display: 'TypeScript', postCount: 10 }],
      },
      meta: { requestId: 'req-1' },
    });
  });

  it('uses the default trending limit when none is provided', async () => {
    const limit = vi.fn().mockResolvedValue([]);
    const sort = vi.fn().mockReturnValue({ limit });
    mocks.find.mockReturnValue({ sort });

    const { error } = await runRoute(tagsRouter, '/trending', 'get');

    expect(error).toBeUndefined();
    expect(limit).toHaveBeenCalledWith(10);
  });

  it('looks up tags by lower-cased slug', async () => {
    const tag = {
      _id: new Types.ObjectId(),
      slug: 'typescript',
      display: 'TypeScript',
      postCount: 42,
    };
    mocks.findOne.mockResolvedValue(tag);

    const { res, error } = await runRoute(tagsRouter, '/:slug', 'get', {
      params: { slug: 'TypeScript' },
    });

    expect(error).toBeUndefined();
    expect(mocks.findOne).toHaveBeenCalledWith({ slug: 'typescript' });
    expect(res.payload).toEqual({
      data: {
        tag: { slug: 'typescript', display: 'TypeScript', postCount: 42 },
      },
      meta: { requestId: 'req-1' },
    });
  });

  it('returns not found when a tag does not exist', async () => {
    mocks.findOne.mockResolvedValue(null);

    const { error } = await runRoute(tagsRouter, '/:slug', 'get', {
      params: { slug: 'missing' },
    });

    expect(error).toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
  });
});
