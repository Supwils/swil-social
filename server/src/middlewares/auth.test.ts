import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { resetDb } from '../test/db-reset';
import { db } from '../db/client';
import { users, apiKeys } from '../db/schema';
import type { UserRow } from '../lib/dto';
import { optionalUser, requireUser } from './auth';

async function seedUser(over: Partial<typeof users.$inferInsert> = {}): Promise<UserRow> {
  const [u] = await db
    .insert(users)
    .values({
      username: 'ada',
      usernameDisplay: 'ada',
      email: 'ada@example.com',
      displayName: 'Ada',
      ...over,
    })
    .returning();
  return u;
}

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    session: {
      userId: undefined,
      destroy: vi.fn((cb?: () => void) => cb?.()),
    },
    ...overrides,
  } as unknown as Request;
}

describe('auth middleware', () => {
  beforeEach(resetDb);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('attaches the active session user', async () => {
    const user = await seedUser();
    const req = makeReq({ session: { userId: user.id, destroy: vi.fn() } as never });
    const next = vi.fn() as NextFunction;

    await requireUser(req, {} as Response, next);

    expect(req.user?.id).toBe(user.id);
    expect(next).toHaveBeenCalledWith();
  });

  it('destroys invalid sessions when the user can no longer be loaded', async () => {
    const destroy = vi.fn((cb?: () => void) => cb?.());
    const req = makeReq({ session: { userId: 'missing-user', destroy } as never });
    const next = vi.fn() as NextFunction;

    await optionalUser(req, {} as Response, next);

    expect(destroy).toHaveBeenCalled();
    expect(req.user).toBeUndefined();
    expect(next).toHaveBeenCalledWith();
  });

  it('destroys sessions for users that are no longer active', async () => {
    const user = await seedUser({ status: 'suspended' });
    const destroy = vi.fn((cb?: () => void) => cb?.());
    const req = makeReq({ session: { userId: user.id, destroy } as never });
    const next = vi.fn() as NextFunction;

    await optionalUser(req, {} as Response, next);

    expect(destroy).toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  });

  it('prefers API key auth over session auth', async () => {
    const sessionUser = await seedUser();
    const apiUser = await seedUser({
      username: 'grace',
      usernameDisplay: 'grace',
      email: 'grace@example.com',
      displayName: 'Grace',
    });

    const rawKey = 'sk-swil-test-key';
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    const [key] = await db
      .insert(apiKeys)
      .values({ userId: apiUser.id, name: 'default', keyHash })
      .returning();

    const req = makeReq({
      headers: { authorization: `Bearer ${rawKey}` },
      session: { userId: sessionUser.id, destroy: vi.fn() } as never,
    });
    const next = vi.fn() as NextFunction;

    await requireUser(req, {} as Response, next);

    expect(req.user?.id).toBe(apiUser.id);
    expect(next).toHaveBeenCalledWith();

    // lastUsedAt is updated fire-and-forget; give the microtask a tick to land.
    await new Promise((r) => setTimeout(r, 20));
    const [updated] = await db.select().from(apiKeys).where(eq(apiKeys.id, key.id));
    expect(updated?.lastUsedAt).not.toBeNull();
  });

  it('fails with unauthenticated when no auth context exists', async () => {
    const req = makeReq();
    const next = vi.fn() as NextFunction;

    await requireUser(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'UNAUTHENTICATED',
        status: 401,
      }),
    );
  });
});
