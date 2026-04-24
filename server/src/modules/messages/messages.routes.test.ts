import { afterEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import type { Router } from 'express';

const mocks = vi.hoisted(() => ({
  listForViewer: vi.fn(),
  findOrCreateWith: vi.fn(),
  unreadCount: vi.fn(),
  listMessages: vi.fn(),
  send: vi.fn(),
  markRead: vi.fn(),
  userFind: vi.fn(),
}));

vi.mock('../../middlewares/auth', () => ({
  requireUser: (req: { user?: unknown }, _res: unknown, next: (err?: unknown) => void) => {
    req.user = {
      _id: new Types.ObjectId(),
      id: 'viewer-id',
      username: 'viewer',
      displayName: 'Viewer',
      usernameDisplay: 'viewer',
      avatarUrl: null,
      headline: '',
      profileTags: [],
      isAgent: false,
    };
    next();
  },
}));

vi.mock('./messages.service', () => ({
  listForViewer: mocks.listForViewer,
  findOrCreateWith: mocks.findOrCreateWith,
  unreadCount: mocks.unreadCount,
  listMessages: mocks.listMessages,
  send: mocks.send,
  markRead: mocks.markRead,
}));

vi.mock('../../middlewares/rateLimit', () => ({
  messageWriteLimiter: (_req: unknown, _res: unknown, next: (err?: unknown) => void) => next(),
}));

vi.mock('../../models/user.model', async () => {
  const actual = await vi.importActual<typeof import('../../models/user.model')>('../../models/user.model');
  return {
    ...actual,
    User: {
      ...actual.User,
      find: mocks.userFind,
    },
  };
});

import { conversationsRouter } from './messages.routes';

async function runRoute(
  router: Router,
  path: string,
  method: 'get' | 'post',
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

describe('messages routes', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns the unread conversation count', async () => {
    mocks.unreadCount.mockResolvedValue(2);

    const { res, error } = await runRoute(conversationsRouter, '/unread-count', 'get');

    expect(error).toBeUndefined();
    expect(res.payload).toEqual({
      data: { count: 2 },
      meta: { requestId: undefined },
    });
  });

  it('creates a conversation and returns 201 when new', async () => {
    const me = { _id: new Types.ObjectId(), id: 'viewer-id' };
    const peerId = new Types.ObjectId();
    const conversation = {
      _id: new Types.ObjectId(),
      participantIds: [me._id, peerId],
      unreadBy: [],
      lastMessageAt: new Date('2026-04-23T00:00:00.000Z'),
      lastMessageId: null,
    };
    mocks.findOrCreateWith.mockResolvedValue({ conversation, created: true });
    mocks.userFind.mockResolvedValue([
      {
        _id: me._id,
        username: 'viewer',
        usernameDisplay: 'viewer',
        displayName: 'Viewer',
        avatarUrl: null,
        headline: '',
        profileTags: [],
        isAgent: false,
      },
      {
        _id: peerId,
        username: 'bob',
        usernameDisplay: 'bob',
        displayName: 'Bob',
        avatarUrl: null,
        headline: '',
        profileTags: [],
        isAgent: false,
      },
    ]);

    const { res, error } = await runRoute(conversationsRouter, '/', 'post', {
      body: { recipientUsername: 'bob' },
    });

    expect(error).toBeUndefined();
    expect(res.statusCode).toBe(201);
    expect((res.payload as { data: { conversation: { id: string } } }).data.conversation.id)
      .toBe(conversation._id.toString());
  });

  it('rejects blank message bodies after validation trim', async () => {
    const { error } = await runRoute(conversationsRouter, '/:id/messages', 'post', {
      params: { id: new Types.ObjectId().toString() },
      body: { text: '   ' },
    });

    expect(error).toMatchObject({
      code: 'VALIDATION_ERROR',
      status: 400,
    });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('passes parsed paging params to listMessages', async () => {
    mocks.listMessages.mockResolvedValue({ items: [], nextCursor: null });
    const id = new Types.ObjectId().toString();

    const { res, error } = await runRoute(conversationsRouter, '/:id/messages', 'get', {
      params: { id },
      query: { limit: '10' },
    });

    expect(error).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(mocks.listMessages).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'viewer-id' }),
      id,
      null,
      10,
    );
  });
});
