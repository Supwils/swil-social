import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { createHash, randomBytes } from 'crypto';
import type { Request, Response } from 'express';
import request from 'supertest';
import { newId } from '../../lib/id';
import { AppError } from '../../lib/errors';
import { env } from '../../config/env';
import { SESSION_COOKIE_NAME, sessionCookieClearOptions } from '../../config/session';
import { db } from '../../db/client';
import { resetDb } from '../../test/db-reset';
import { apiKeys, comments, posts, users } from '../../db/schema';
import { createApp } from '../../app';
import * as dto from '../../lib/dto';
import * as authService from './auth.service';
import * as ctrl from './auth.controller';

let seq = 0;

function makeResponse(): Response {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
    clearCookie: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response;
}

function makeRequest(overrides: Partial<Request> = {}): Request {
  const session = {
    userId: undefined as string | undefined,
    regenerate: (cb: (err?: unknown) => void) => cb(),
    save: (cb: (err?: unknown) => void) => cb(),
    destroy: (cb: (err?: unknown) => void) => cb(),
  };

  return {
    body: {},
    params: {},
    query: {},
    sessionID: 'sid-current',
    session,
    ...overrides,
  } as unknown as Request;
}

function makeUser() {
  return {
    id: newId(),
  };
}

describe('auth.controller', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers a user and persists the new session', async () => {
    const req = makeRequest({
      body: { username: 'ada', email: 'ada@example.com', password: 'password123' },
    });
    const res = makeResponse();
    const user = makeUser();

    vi.spyOn(authService, 'register').mockResolvedValue(user as never);
    vi.spyOn(dto, 'toUserDTO').mockReturnValue({ id: user.id } as never);

    await ctrl.register(req, res);

    expect(authService.register).toHaveBeenCalledWith(req.body);
    expect(req.session.userId).toBe(user.id);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({
      data: { user: { id: user.id } },
      meta: { requestId: undefined },
    });
  });

  it('logs out by destroying the session and clearing the cookie', async () => {
    const req = makeRequest();
    const res = makeResponse();

    await ctrl.logout(req, res);

    expect(res.clearCookie).toHaveBeenCalledWith(SESSION_COOKIE_NAME, sessionCookieClearOptions());
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.end).toHaveBeenCalled();
  });

  it('throws on /me when no authenticated user is attached', async () => {
    const req = makeRequest({ user: undefined });
    const res = makeResponse();

    await expect(ctrl.me(req, res)).rejects.toMatchObject<AppError>({
      code: 'UNAUTHENTICATED',
      status: 401,
    });
  });

  it('changes password, destroys other sessions, and rotates the current session', async () => {
    const user = makeUser();
    const req = makeRequest({
      user: user as never,
      body: { currentPassword: 'old-password', newPassword: 'new-password-123' },
    });
    const res = makeResponse();

    vi.spyOn(authService, 'changePassword').mockResolvedValue(undefined);
    vi.spyOn(authService, 'destroyOtherSessions').mockResolvedValue(undefined);

    await ctrl.changePassword(req, res);

    expect(authService.changePassword).toHaveBeenCalledWith(
      user,
      'old-password',
      'new-password-123',
    );
    expect(authService.destroyOtherSessions).toHaveBeenCalledWith(user.id, 'sid-current');
    expect(req.session.userId).toBe(user.id);
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.end).toHaveBeenCalled();
  });
});

/**
 * `/auth/me` agentOps — spec §9. Only an agent-flagged caller gets the object,
 * and it never appears on a public profile DTO.
 */
describe('GET /auth/me agentOps (spec §9)', () => {
  beforeEach(resetDb);

  async function seedWithKey(over: Partial<typeof users.$inferInsert> = {}) {
    seq += 1;
    const username = over.username ?? `meops${seq}`;
    const [user] = await db
      .insert(users)
      .values({
        username,
        usernameDisplay: username,
        email: `${username}@example.test`,
        displayName: username,
        ...over,
      })
      .returning();
    const raw = `sk-swil-${randomBytes(8).toString('hex')}`;
    await db.insert(apiKeys).values({
      userId: user.id,
      name: 'test',
      keyHash: createHash('sha256').update(raw).digest('hex'),
    });
    return { user, key: raw };
  }

  it('includes agentOps for an agent, with pause and UTC-midnight usage', async () => {
    const { user, key } = await seedWithKey({ isAgent: true, agentPaused: true });
    await db.insert(posts).values({ authorId: user.id, text: 'today' });
    await db.insert(comments).values({ postId: newId(), authorId: user.id, text: 'today' });
    await db.insert(comments).values({ postId: newId(), authorId: user.id, text: 'today' });

    const res = await request(createApp())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${key}`);

    expect(res.status).toBe(200);
    expect(res.body.data.user.id).toBe(user.id);
    expect(res.body.data.user).not.toHaveProperty('agentOps');
    expect(res.body.data.agentOps).toEqual({
      paused: true,
      postsToday: 1,
      postsLimit: env.AGENT_DAILY_POST_LIMIT,
      commentsToday: 2,
      commentsLimit: env.AGENT_DAILY_COMMENT_LIMIT,
    });
  });

  it('omits agentOps for a human, including a simulated-human account', async () => {
    const { key } = await seedWithKey({
      isAgent: false,
      agentPaused: false,
      agentBackend: 'haiku',
    });

    const res = await request(createApp())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${key}`);

    expect(res.status).toBe(200);
    expect(res.body.data.agentOps).toBeUndefined();
    expect(res.body.data.user).not.toHaveProperty('agentOps');
  });

  it('does not put agentOps on a public profile DTO', async () => {
    const { user } = await seedWithKey({ username: 'zenith', isAgent: true, agentPaused: true });

    const res = await request(createApp()).get(`/api/v1/users/${user.username}`);

    expect(res.status).toBe(200);
    expect(res.body.data.user.id).toBe(user.id);
    expect(res.body.data.user).not.toHaveProperty('agentOps');
    expect(res.body.data).not.toHaveProperty('agentOps');
  });
});
