import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createHash, randomBytes } from 'crypto';
import { agentsRouter } from './agents.routes';
import { createApp } from '../../app';
import { db } from '../../db/client';
import { resetDb } from '../../test/db-reset';
import { apiKeys, users } from '../../db/schema';

/**
 * The lab router is the one place in the API where reads are deliberately
 * public and writes are not. That asymmetry used to be enforced by a single
 * `agentsRouter.use(requireUser)`; it is now per-route, which is safer for
 * reads but means a new POST added without `requireUser` would silently be
 * world-writable — and these endpoints ingest the personality snapshots the
 * whole drift experiment is measured from.
 *
 * So the invariant is asserted structurally, over the actual Express stack,
 * rather than trusted to review.
 */

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ name: string }>;
  };
}

function routes(): Array<{ path: string; method: string; handlers: string[] }> {
  const stack = (agentsRouter as unknown as { stack: RouteLayer[] }).stack;
  return stack
    .filter((layer): layer is Required<RouteLayer> => Boolean(layer.route))
    .flatMap((layer) =>
      Object.keys(layer.route.methods).map((method) => ({
        path: layer.route.path,
        method,
        handlers: layer.route.stack.map((h) => h.name),
      })),
    );
}

describe('agentsRouter auth boundary', () => {
  it('registers the expected number of routes', () => {
    // Guards against this suite silently passing because introspection broke.
    expect(routes().length).toBeGreaterThanOrEqual(18);
  });

  it('requires auth on every write route', () => {
    const unguarded = routes()
      .filter((r) => r.method !== 'get')
      .filter((r) => !r.handlers.includes('requireUser'))
      .map((r) => `${r.method.toUpperCase()} ${r.path}`);

    expect(unguarded).toEqual([]);
  });

  it('leaves every read route public', () => {
    const gated = routes()
      .filter((r) => r.method === 'get')
      .filter((r) => r.handlers.includes('requireUser'))
      .map((r) => `GET ${r.path}`);

    expect(gated).toEqual([]);
  });

  it('covers both a read and a write, so the two assertions above are not vacuous', () => {
    const methods = new Set(routes().map((r) => r.method));
    expect(methods.has('get')).toBe(true);
    expect(methods.has('post')).toBe(true);
  });
});

/**
 * `occurredAt` over the real HTTP stack.
 *
 * The service-level tests in `agents.service.test.ts` hand `ingestAgentEvent` a
 * `Date` directly, which cannot answer the two questions that decide whether a
 * backfill lands where it belongs:
 *
 * 1. Does `validate(agentEventIngest, 'body')` write its PARSED result back to
 *    `req.body`? If it only validated, the service would receive the raw ISO
 *    string rather than a `Date`.
 * 2. What does a server WITHOUT this field do with it? zod's `.object()` strips
 *    unknown keys, so the answer is "silently drops it and stamps now()" — no
 *    400, no warning. That is why a backfill must not be run against a
 *    deployment that predates this change, and it is asserted here rather than
 *    argued: `capturedAt` (the plausible wrong spelling, and the name the other
 *    three ingest DTOs use) stands in for any unknown key.
 */
describe('POST /agents/:username/events — occurredAt over HTTP', () => {
  // 01:35:04 PDT is 08:35:04 UTC — an offset silently dropped is a different
  // number, and either is weeks away from `now()`.
  const OCCURRED_AT = '2026-08-05T01:35:04-07:00';
  const OCCURRED_AT_UTC = '2026-08-05T08:35:04.000Z';

  const body = (over: Record<string, unknown> = {}) => ({
    type: 'anomaly',
    phase: 'anomaly',
    outcome: 'flagged',
    summary: 'personality.md hand-rolled back',
    metrics: { intervention: 'personality_rollback', gateBypassed: true },
    ...over,
  });

  async function agentWithKey(username: string): Promise<string> {
    const [user] = await db
      .insert(users)
      .values({
        username,
        usernameDisplay: username,
        email: `${username}@example.test`,
        displayName: username,
        isAgent: true,
      })
      .returning();
    const raw = `sk-swil-${randomBytes(8).toString('hex')}`;
    await db.insert(apiKeys).values({
      userId: user.id,
      name: 'test',
      keyHash: createHash('sha256').update(raw).digest('hex'),
    });
    return raw;
  }

  beforeEach(resetDb);

  it('stamps created_at with the instant the event is about', async () => {
    const key = await agentWithKey('zenith');

    const res = await request(createApp())
      .post('/api/v1/agents/zenith/events')
      .set('Authorization', `Bearer ${key}`)
      .send(body({ occurredAt: OCCURRED_AT }));

    expect(res.status).toBe(201);
    expect(res.body.data.event.createdAt).toBe(OCCURRED_AT_UTC);
    expect(res.body.data.event.metrics).toEqual({
      intervention: 'personality_rollback',
      gateBypassed: true,
    });
  });

  it('stamps now() when the field is absent — the live-runtime path', async () => {
    const key = await agentWithKey('zenith');
    const before = Date.now() - 1000;

    const res = await request(createApp())
      .post('/api/v1/agents/zenith/events')
      .set('Authorization', `Bearer ${key}`)
      .send(body());

    expect(res.status).toBe(201);
    expect(Date.parse(res.body.data.event.createdAt)).toBeGreaterThanOrEqual(before);
  });

  it('SILENTLY drops an unknown timestamp key rather than rejecting it', async () => {
    // The failure mode a backfill against an older deployment would hit: 201,
    // a well-formed event, and the wrong week.
    const key = await agentWithKey('zenith');
    const before = Date.now() - 1000;

    const res = await request(createApp())
      .post('/api/v1/agents/zenith/events')
      .set('Authorization', `Bearer ${key}`)
      .send(body({ capturedAt: OCCURRED_AT }));

    expect(res.status).toBe(201);
    expect(Date.parse(res.body.data.event.createdAt)).toBeGreaterThanOrEqual(before);
  });

  it('rejects a malformed occurredAt with a 400 rather than a bad row', async () => {
    const key = await agentWithKey('zenith');

    const res = await request(createApp())
      .post('/api/v1/agents/zenith/events')
      .set('Authorization', `Bearer ${key}`)
      .send(body({ occurredAt: 'yesterday' }));

    expect(res.status).toBe(400);
  });

  it('refuses a nested metrics value — the defect that ran six weeks unseen', async () => {
    const key = await agentWithKey('zenith');

    const res = await request(createApp())
      .post('/api/v1/agents/zenith/events')
      .set('Authorization', `Bearer ${key}`)
      .send(body({ metrics: { aspects: { values: 0.6 } } }));

    expect(res.status).toBe(400);
  });
});
