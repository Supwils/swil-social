import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client';
import { resetDb } from '../../test/db-reset';
import {
  users,
  posts,
  comments,
  likes,
  personalitySnapshots,
  behaviorSnapshots,
  agentEvents,
  benchmarkRuns,
  populationMetrics,
} from '../../db/schema';
import type { UserRow } from '../../lib/dto';
import {
  ingestSnapshot,
  getDrift,
  listAgents,
  ingestAgentEvent,
  getAgentEvents,
  ingestBehaviorSnapshot,
  getFidelity,
  getInteractionGraph,
  getHomogenization,
  getAlerts,
  getInfluences,
  getPulse,
  getBenchmarkLeaderboard,
} from './agents.service';
import { snapshotIngest } from './agents.schemas';

/**
 * Integration rewrite: these suites run against the real test Postgres (migrated
 * by vitest globalSetup, truncated per test by resetDb). Where the old test
 * mocked a Mongoose model, we now seed real rows and assert on the service's
 * returned shape and/or the resulting DB rows.
 */

// --- embedding fixtures (vector column is fixed at 1024 dims) ---
const DIM = 1024;
/** Unit vector on axis `i` (predictable cosine sims: axis(0)·axis(0)=1, axis(0)·axis(1)=0). */
const axis = (i: number): number[] => {
  const a = Array(DIM).fill(0);
  a[i] = 1;
  return a;
};
/** [0.6, 0.8, 0, ...] — a unit vector whose cosine with axis(0) is exactly 0.6. */
const mixed06 = (): number[] => {
  const a = Array(DIM).fill(0);
  a[0] = 0.6;
  a[1] = 0.8;
  return a;
};

let seq = 0;
const uniqHash = (label: string): string => `${label}-${(seq += 1)}`;

async function seedUser(over: Partial<typeof users.$inferInsert> = {}): Promise<UserRow> {
  seq += 1;
  const base = {
    username: `u${seq}`,
    usernameDisplay: `u${seq}`,
    email: `u${seq}@example.com`,
    displayName: `U${seq}`,
  } satisfies Partial<typeof users.$inferInsert>;
  const [u] = await db
    .insert(users)
    .values({ ...base, ...over })
    .returning();
  return u;
}

async function seedSnapshot(
  userId: string,
  over: Partial<typeof personalitySnapshots.$inferInsert> = {},
) {
  const [s] = await db
    .insert(personalitySnapshots)
    .values({
      userId,
      capturedAt: new Date(),
      contentHash: uniqHash('psnap'),
      embedding: axis(0),
      snapshotType: 'dream',
      archivePath: 'agents/x/personality.archive.md',
      ...over,
    })
    .returning();
  return s;
}

async function seedBehavior(
  userId: string,
  over: Partial<typeof behaviorSnapshots.$inferInsert> = {},
) {
  const [s] = await db
    .insert(behaviorSnapshots)
    .values({
      userId,
      capturedAt: new Date(),
      contentHash: uniqHash('bsnap'),
      embedding: axis(0),
      ...over,
    })
    .returning();
  return s;
}

async function seedPost(authorId: string, over: Partial<typeof posts.$inferInsert> = {}) {
  const [p] = await db
    .insert(posts)
    .values({ authorId, text: 'hello', ...over })
    .returning();
  return p;
}

async function seedComment(
  postId: string,
  authorId: string,
  over: Partial<typeof comments.$inferInsert> = {},
) {
  const [c] = await db
    .insert(comments)
    .values({ postId, authorId, text: 'nice', ...over })
    .returning();
  return c;
}

async function seedLike(userId: string, targetId: string) {
  const [l] = await db
    .insert(likes)
    .values({ userId, targetType: 'post', targetId })
    .returning();
  return l;
}

beforeEach(resetDb);

describe('agents.service.ingestSnapshot', () => {
  afterEach(() => vi.restoreAllMocks());

  it('rejects when the actor is not the agent itself', async () => {
    await seedUser({ username: 'zenith', isAgent: true });
    const other = await seedUser({ username: 'someoneelse', isAgent: true });

    await expect(
      ingestSnapshot('zenith', other, {
        contentHash: uniqHash('a'),
        embedding: axis(0),
        snapshotType: 'dream',
        archivePath: 'agents/zenith/personality.archive.md#1',
        excerpt: '',
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('returns the existing snapshot if contentHash already ingested (idempotent backfill)', async () => {
    const agent = await seedUser({ username: 'zenith', isAgent: true });
    const hash = uniqHash('dup');
    await seedSnapshot(agent.id, {
      contentHash: hash,
      driftFromAnchor: 0.12,
      driftFromPrev: 0.05,
    });

    const out = await ingestSnapshot('zenith', agent, {
      contentHash: hash,
      embedding: axis(0),
      snapshotType: 'dream',
      archivePath: 'agents/zenith/personality.archive.md#2',
      excerpt: '',
    });

    expect(out.driftFromAnchor).toBe(0.12);
    expect(out.driftFromPrev).toBe(0.05);
  });

  it('backfills aspectDrift onto a pre-existing snapshot that lacks it', async () => {
    const agent = await seedUser({ username: 'zenith', isAgent: true });
    const hash = uniqHash('bf');
    const existing = await seedSnapshot(agent.id, {
      contentHash: hash,
      driftFromAnchor: 0.1,
      driftFromPrev: 0.05,
    });
    expect(existing.aspectDrift).toBeNull();

    await ingestSnapshot('zenith', agent, {
      contentHash: hash,
      embedding: axis(0),
      snapshotType: 'dream',
      archivePath: 'agents/zenith/personality.archive.md#9',
      excerpt: '',
      aspectDrift: {
        mode: 'shadow',
        promptVersion: 1,
        values: 0.9,
        style: 0.8,
        topic: 0.7,
        breached: [],
      },
    });

    const [row] = await db
      .select()
      .from(personalitySnapshots)
      .where(eq(personalitySnapshots.id, existing.id));
    expect(row.aspectDrift).toMatchObject({ mode: 'shadow', values: 0.9 });
  });

  it('does not overwrite an existing aspectDrift block on re-ingest', async () => {
    const agent = await seedUser({ username: 'zenith', isAgent: true });
    const hash = uniqHash('noov');
    const existing = await seedSnapshot(agent.id, {
      contentHash: hash,
      driftFromAnchor: 0.1,
      driftFromPrev: 0.05,
      aspectDrift: {
        mode: 'aspect',
        promptVersion: 1,
        values: 0.95,
        style: 0.9,
        topic: 0.8,
        breached: [],
      },
    });

    await ingestSnapshot('zenith', agent, {
      contentHash: hash,
      embedding: axis(0),
      snapshotType: 'dream',
      archivePath: 'agents/zenith/personality.archive.md#9',
      excerpt: '',
      aspectDrift: {
        mode: 'shadow',
        promptVersion: 1,
        values: 0.1,
        style: 0.1,
        topic: 0.1,
        breached: ['values', 'style', 'topic'],
      },
    });

    const [row] = await db
      .select()
      .from(personalitySnapshots)
      .where(eq(personalitySnapshots.id, existing.id));
    expect(row.aspectDrift?.mode).toBe('aspect');
    expect(row.aspectDrift?.values).toBe(0.95);
  });

  it('computes drift = 0 when no anchor or prev snapshot exists yet', async () => {
    const agent = await seedUser({ username: 'zenith', isAgent: true });

    const out = await ingestSnapshot('zenith', agent, {
      contentHash: uniqHash('c'),
      embedding: axis(0),
      snapshotType: 'anchor',
      archivePath: 'agents/zenith/personality.md',
      excerpt: 'hello',
    });

    expect(out.driftFromAnchor).toBe(0);
    expect(out.driftFromPrev).toBe(0);

    const rows = await db
      .select()
      .from(personalitySnapshots)
      .where(eq(personalitySnapshots.userId, agent.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].snapshotType).toBe('anchor');
  });

  it('persists aspectDrift on the created snapshot when provided', async () => {
    const agent = await seedUser({ username: 'zenith', isAgent: true });
    const hash = uniqHash('d');

    await ingestSnapshot('zenith', agent, {
      contentHash: hash,
      embedding: axis(0),
      snapshotType: 'dream',
      archivePath: 'agents/zenith/personality.archive.md#3',
      excerpt: '',
      aspectDrift: {
        mode: 'aspect',
        promptVersion: 1,
        values: 0.91,
        style: 0.78,
        topic: 0.72,
        breached: ['style'],
      },
    });

    const [row] = await db
      .select()
      .from(personalitySnapshots)
      .where(eq(personalitySnapshots.contentHash, hash));
    expect(row.aspectDrift).toMatchObject({ mode: 'aspect', style: 0.78, breached: ['style'] });
  });
});

describe('agents.service.getDrift', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns empty list for an agent with no snapshots', async () => {
    await seedUser({ username: 'zenith', isAgent: true });
    const out = await getDrift('zenith');
    expect(out).toEqual([]);
  });

  it('surfaces diffNarrative when present and omits it otherwise (Feature 5)', async () => {
    const agent = await seedUser({ username: 'zenith', isAgent: true });
    await seedSnapshot(agent.id, {
      capturedAt: new Date('2026-06-01T00:00:00.000Z'),
      driftFromAnchor: 0.1,
      driftFromPrev: 0.1,
      snapshotType: 'anchor',
      excerpt: 'x',
    });
    await seedSnapshot(agent.id, {
      capturedAt: new Date('2026-06-02T00:00:00.000Z'),
      driftFromAnchor: 0.2,
      driftFromPrev: 0.12,
      snapshotType: 'dream',
      excerpt: 'y',
      diffNarrative: '强化了对“在场”的关注，淡化了早期的技术腔。',
    });

    const out = await getDrift('zenith');
    expect(out[0].diffNarrative).toBeUndefined();
    expect(out[1].diffNarrative).toContain('在场');
  });

  it('surfaces per-aspect drift when present and omits it otherwise', async () => {
    const agent = await seedUser({ username: 'zenith', isAgent: true });
    await seedSnapshot(agent.id, {
      capturedAt: new Date('2026-06-01T00:00:00.000Z'),
      driftFromAnchor: 0.1,
      driftFromPrev: 0.1,
      snapshotType: 'anchor',
      excerpt: 'x',
    });
    await seedSnapshot(agent.id, {
      capturedAt: new Date('2026-06-02T00:00:00.000Z'),
      driftFromAnchor: 0.2,
      driftFromPrev: 0.12,
      snapshotType: 'dream',
      excerpt: 'y',
      aspectDrift: {
        mode: 'aspect',
        promptVersion: 1,
        values: 0.91,
        style: 0.78,
        topic: 0.72,
        breached: ['style'],
      },
    });

    const out = await getDrift('zenith');
    expect(out[0].aspects).toBeUndefined();
    expect(out[1].aspects).toMatchObject({ mode: 'aspect', style: 0.78, breached: ['style'] });
  });
});

describe('agents.schemas snapshotIngest aspectDrift', () => {
  const base = {
    contentHash: 'e'.repeat(64),
    embedding: Array(64).fill(0.01),
    archivePath: 'agents/zenith/personality.md',
  };

  it('accepts a valid aspectDrift block', () => {
    const parsed = snapshotIngest.parse({
      ...base,
      aspectDrift: {
        mode: 'shadow',
        promptVersion: 1,
        values: 0.9,
        style: 0.8,
        topic: 0.7,
        breached: [],
      },
    });
    expect(parsed.aspectDrift?.mode).toBe('shadow');
  });

  it('rejects a sim outside [-1, 1]', () => {
    expect(() =>
      snapshotIngest.parse({
        ...base,
        aspectDrift: {
          mode: 'aspect',
          promptVersion: 1,
          values: 1.5,
          style: 0.8,
          topic: 0.7,
          breached: [],
        },
      }),
    ).toThrow();
  });

  it('rejects an unknown breached aspect name', () => {
    expect(() =>
      snapshotIngest.parse({
        ...base,
        aspectDrift: {
          mode: 'aspect',
          promptVersion: 1,
          values: 0.9,
          style: 0.8,
          topic: 0.7,
          breached: ['vibe'],
        },
      }),
    ).toThrow();
  });

  it('is optional so legacy snapshots without it still validate', () => {
    const parsed = snapshotIngest.parse(base);
    expect(parsed.aspectDrift).toBeUndefined();
  });
});

describe('agents.service.getBenchmarkLeaderboard', () => {
  afterEach(() => vi.restoreAllMocks());

  it('aggregates the latest batch per model and ranks by fidelity', async () => {
    const rows = [
      { model: 'opus', taskId: 't1', runIndex: 0, output: 'a', vectorFidelity: 0.9, judgeScore: 90, ruleScore: 1, latencyMs: 100 },
      { model: 'opus', taskId: 't1', runIndex: 1, output: 'b', vectorFidelity: 0.88, judgeScore: 88, ruleScore: 1, latencyMs: 110 },
      { model: 'haiku', taskId: 't1', runIndex: 0, output: 'c', vectorFidelity: 0.7, judgeScore: 70, ruleScore: 0.5, latencyMs: 40 },
      { model: 'haiku', taskId: 't1', runIndex: 1, output: 'd', vectorFidelity: 0.6, judgeScore: 60, ruleScore: 0.5, latencyMs: 42 },
    ];
    await db.insert(benchmarkRuns).values(
      rows.map((r) => ({
        batchId: 'b1',
        persona: 'liushang',
        personaDisplay: '流觞',
        taskKind: 'post',
        ruleDetail: '',
        capturedAt: new Date(),
        ...r,
      })),
    );

    const out = await getBenchmarkLeaderboard();

    expect(out.totalRuns).toBe(4);
    expect(out.rows.map((r) => r.model)).toEqual(['opus', 'haiku']); // opus first (higher fidelity)
    expect(out.rows[0]).toMatchObject({ model: 'opus', runs: 2 });
    expect(out.rows[0].fidelity).toBeCloseTo(0.89, 5);
    expect(out.rows[1].fidelity).toBeCloseTo(0.65, 5);
    // opus is steadier (tighter cell) → higher consistency than haiku
    expect(out.rows[0].consistency ?? 0).toBeGreaterThan(out.rows[1].consistency ?? 0);
    expect(out.personas).toContainEqual({ persona: 'liushang', display: '流觞' });
    expect(out.tasks).toContainEqual({ taskId: 't1', kind: 'post' });
  });
});

describe('agents.service.getPulse', () => {
  afterEach(() => vi.restoreAllMocks());

  it('builds a population pulse with activity, fidelity and drift velocity per day', async () => {
    const agent = await seedUser({ username: 'zenith', isAgent: true, displayName: 'Zenith' });

    const noon = new Date();
    noon.setUTCHours(12, 0, 0, 0);
    const day = noon.toISOString().slice(0, 10);

    // 2 posts, 3 comments, 5 likes by the agent today. The comment host post is
    // authored by a non-lab user so it doesn't inflate the agent's post count.
    await Promise.all([
      seedPost(agent.id, { createdAt: noon }),
      seedPost(agent.id, { createdAt: noon }),
    ]);
    const poster = await seedUser();
    const host = await seedPost(poster.id, { createdAt: noon });
    await Promise.all([
      seedComment(host.id, agent.id, { createdAt: noon }),
      seedComment(host.id, agent.id, { createdAt: noon }),
      seedComment(host.id, agent.id, { createdAt: noon }),
    ]);
    for (let i = 0; i < 5; i++) {
      await seedLike(agent.id, uniqHash('tgt'));
    }

    // Behavior fidelity 0.8 today; a dream personality snapshot with driftFromPrev 0.12 today.
    await seedBehavior(agent.id, { capturedAt: noon, fidelity: 0.8 });
    await seedSnapshot(agent.id, {
      capturedAt: noon,
      snapshotType: 'dream',
      driftFromPrev: 0.12,
    });

    const out = await getPulse('7d');

    expect(out.range).toBe('7d');
    expect(out.points).toHaveLength(7);
    const todayPoint = out.points.find((p) => p.date === day);
    expect(todayPoint).toMatchObject({
      posts: 2,
      comments: 3,
      likes: 5,
      actions: 10,
      meanFidelity: 0.8,
      meanDriftVelocity: 0.12,
    });
    // days with no activity stay zero-filled with null means (no fabricated trend)
    const empties = out.points.filter((p) => p.date !== day);
    expect(empties.every((p) => p.actions === 0 && p.meanFidelity === null)).toBe(true);
  });
});

describe('agents.service.listAgents', () => {
  afterEach(() => vi.restoreAllMocks());

  it('counts active posts and includes drift sparkline values', async () => {
    const agent = await seedUser({
      username: 'zenith',
      isAgent: true,
      displayName: 'Zenith',
      headline: 'Quiet observer',
      followerCount: 4,
      postCount: 12,
    });

    // 3 active posts within the last 7 days.
    await Promise.all([seedPost(agent.id), seedPost(agent.id), seedPost(agent.id)]);

    // Three snapshots, capturedAt ascending → sparkline [0, 0.1, 0.22].
    await seedSnapshot(agent.id, {
      capturedAt: new Date('2026-06-01T00:00:00.000Z'),
      snapshotType: 'anchor',
      driftFromAnchor: 0,
    });
    await seedSnapshot(agent.id, {
      capturedAt: new Date('2026-06-02T00:00:00.000Z'),
      driftFromAnchor: 0.1,
    });
    await seedSnapshot(agent.id, {
      capturedAt: new Date('2026-06-03T00:00:00.000Z'),
      driftFromAnchor: 0.22,
    });

    await seedBehavior(agent.id, { fidelity: 0.81 });

    const out = await listAgents(10);

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      username: 'zenith',
      postsLast7d: 3,
      currentDriftFromAnchor: 0.22,
      driftSparkline: [0, 0.1, 0.22],
      currentFidelity: 0.81,
    });
  });
});

describe('agents.service events', () => {
  afterEach(() => vi.restoreAllMocks());

  it('rejects event ingest when the actor is not the agent itself', async () => {
    await seedUser({ username: 'zenith', isAgent: true });
    const other = await seedUser({ username: 'someoneelse', isAgent: true });

    await expect(
      ingestAgentEvent('zenith', other, {
        type: 'cycle',
        phase: 'act',
        outcome: 'success',
        action: 'nothing',
        summary: 'chose to do nothing',
        metrics: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('stores and returns structured lab events', async () => {
    const agent = await seedUser({ username: 'zenith', isAgent: true });

    const out = await ingestAgentEvent('zenith', agent, {
      type: 'cycle',
      phase: 'act',
      outcome: 'success',
      action: 'post',
      summary: 'posted a note',
      metrics: {},
    });

    expect(out).toMatchObject({
      type: 'cycle',
      phase: 'act',
      outcome: 'success',
      action: 'post',
      summary: 'posted a note',
    });

    // The row is persisted against the agent's own id.
    const [row] = await db.select().from(agentEvents).where(eq(agentEvents.id, out.id));
    expect(row.userId).toBe(agent.id);
  });

  it('accepts a rule_check event (Feature 4 enum)', async () => {
    const agent = await seedUser({ username: 'zenith', isAgent: true });

    const out = await ingestAgentEvent('zenith', agent, {
      type: 'rule_check',
      phase: 'rule',
      outcome: 'flagged',
      summary: 'hashtag count 2-4: 7/12 posts adherent (58%)',
      metrics: { rule: 'hashtag_count', passRate: 0.58, checked: 12 },
    });

    expect(out).toMatchObject({ type: 'rule_check', phase: 'rule', outcome: 'flagged' });
    expect(out.metrics).toMatchObject({ rule: 'hashtag_count', passRate: 0.58 });
  });

  it('lists recent events for a focused agent, filtered by type', async () => {
    const agent = await seedUser({ username: 'zenith', isAgent: true });
    await db.insert(agentEvents).values([
      {
        userId: agent.id,
        type: 'memory',
        phase: 'memory',
        outcome: 'success',
        summary: 'memory synced',
      },
      {
        userId: agent.id,
        type: 'cycle',
        phase: 'act',
        outcome: 'success',
        summary: 'acted',
      },
    ]);

    const out = await getAgentEvents('zenith', 5, 'memory');

    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('memory');
  });
});

describe('agents.service persona fidelity', () => {
  afterEach(() => vi.restoreAllMocks());

  it('rejects behavior ingest when the actor is not the agent itself', async () => {
    await seedUser({ username: 'zenith', isAgent: true });
    const other = await seedUser({ username: 'someoneelse', isAgent: true });

    await expect(
      ingestBehaviorSnapshot('zenith', other, {
        contentHash: uniqHash('a'),
        embedding: axis(0),
        postCount: 3,
        commentCount: 0,
        excerpt: '',
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('is idempotent — returns the existing row on a contentHash hit', async () => {
    const agent = await seedUser({ username: 'zenith', isAgent: true });
    const hash = uniqHash('bdup');
    await seedBehavior(agent.id, { contentHash: hash, fidelity: 0.91 });

    const out = await ingestBehaviorSnapshot('zenith', agent, {
      contentHash: hash,
      embedding: axis(0),
      postCount: 5,
      commentCount: 0,
      excerpt: '',
    });

    expect(out.fidelity).toBe(0.91);
  });

  it('computes fidelity = cosine(behavior, latest personality vector)', async () => {
    const agent = await seedUser({ username: 'zenith', isAgent: true });
    // latest personality snapshot — same unit vector → cosine = 1
    await seedSnapshot(agent.id, { embedding: axis(0) });

    const out = await ingestBehaviorSnapshot('zenith', agent, {
      contentHash: uniqHash('bc'),
      embedding: axis(0),
      postCount: 7,
      commentCount: 0,
      excerpt: 'recent posts',
    });

    expect(out.fidelity).toBeCloseTo(1);
  });

  it('computes a fractional fidelity for partially-aligned vectors', async () => {
    const agent = await seedUser({ username: 'zenith', isAgent: true });
    // persona = axis(0); behavior = [0.6, 0.8, 0, ...] → cosine = 0.6 (both unit vectors)
    await seedSnapshot(agent.id, { embedding: axis(0) });

    const out = await ingestBehaviorSnapshot('zenith', agent, {
      contentHash: uniqHash('be'),
      embedding: mixed06(),
      postCount: 4,
      commentCount: 0,
      excerpt: '',
    });

    expect(out.fidelity).toBeCloseTo(0.6);
  });

  it('records null fidelity when there is no personality snapshot yet', async () => {
    const agent = await seedUser({ username: 'zenith', isAgent: true });

    const out = await ingestBehaviorSnapshot('zenith', agent, {
      contentHash: uniqHash('bd'),
      embedding: axis(0),
      postCount: 2,
      commentCount: 0,
      excerpt: '',
    });

    expect(out.fidelity).toBeNull();
  });

  it('returns the fidelity trajectory with the latest as current', async () => {
    const agent = await seedUser({ username: 'zenith', isAgent: true });
    await seedBehavior(agent.id, {
      capturedAt: new Date('2026-06-01T00:00:00.000Z'),
      fidelity: 0.8,
    });
    await seedBehavior(agent.id, {
      capturedAt: new Date('2026-06-02T00:00:00.000Z'),
      fidelity: 0.74,
    });

    const out = await getFidelity('zenith');
    expect(out.points).toHaveLength(2);
    expect(out.current).toBe(0.74);
  });
});

describe('agents.service interaction graph', () => {
  afterEach(() => vi.restoreAllMocks());

  it('merges comment/reply/echo/like edges within the lab population', async () => {
    const alice = await seedUser({ username: 'alice', isAgent: true, displayName: 'Alice' });
    const bob = await seedUser({ username: 'bob', isAgent: false, displayName: 'Bob' });
    // bob joins the lab population via a personality snapshot.
    await seedSnapshot(bob.id);

    // Posts: P0 (alice, host for the parent comment), P1 & P2 (bob), P3 (alice's echo of P2).
    const p0 = await seedPost(alice.id);
    const p1 = await seedPost(bob.id);
    const p2 = await seedPost(bob.id);
    await seedPost(alice.id, { echoOf: p2.id }); // echo alice→bob

    // top-level comment alice→bob on P1
    await seedComment(p1.id, alice.id);
    // parent comment by alice on her own post (self → excluded from edges) + a reply by bob
    const parent = await seedComment(p0.id, alice.id);
    await seedComment(p0.id, bob.id, { parentId: parent.id }); // reply bob→alice

    // likes alice→bob on P1 and P2 (weight 2)
    await seedLike(alice.id, p1.id);
    await seedLike(alice.id, p2.id);

    const out = await getInteractionGraph('7d');

    expect(out.range).toBe('7d');
    expect(out.nodes).toHaveLength(2);
    expect(out.edges).toHaveLength(2);

    // a→b accumulates comment(1) + echo(1) + like(2) on one edge = weight 4.
    const ab = out.edges.find((e) => e.source === 'alice' && e.target === 'bob');
    const ba = out.edges.find((e) => e.source === 'bob' && e.target === 'alice');
    expect(ab).toMatchObject({ weight: 4, kinds: { comment: 1, reply: 0, echo: 1, like: 2 } });
    expect(ba).toMatchObject({ weight: 1, kinds: { reply: 1 } });

    // strength = in + out: alice 4(out)+1(in)=5
    const aliceNode = out.nodes.find((n) => n.username === 'alice');
    expect(aliceNode).toMatchObject({ isAgent: true, strength: 5 });
  });

  it('drops edges whose endpoints are outside the lab population', async () => {
    const alice = await seedUser({ username: 'alice', isAgent: true, displayName: 'Alice' });
    const outsider = await seedUser({ username: 'outsider', isAgent: false });

    const p = await seedPost(outsider.id);
    await seedComment(p.id, alice.id); // alice→outsider, but outsider is not in the lab

    const out = await getInteractionGraph('30d');
    expect(out.edges).toHaveLength(0);
    expect(out.nodes).toHaveLength(0);
  });
});

describe('agents.service homogenization', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns stored points plus a freshly-computed current cohesion', async () => {
    // One stored metric within the 30d window.
    await db.insert(populationMetrics).values({
      capturedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      personaCohesion: 0.82,
      behaviorCohesion: 0.7,
      n: 5,
    });

    // current: persona vectors identical → cohesion 1; behavior orthogonal → 0
    const u1 = await seedUser({ isAgent: true });
    const u2 = await seedUser({ isAgent: true });
    await seedSnapshot(u1.id, { embedding: axis(0) });
    await seedSnapshot(u2.id, { embedding: axis(0) });
    await seedBehavior(u1.id, { embedding: axis(0) });
    await seedBehavior(u2.id, { embedding: axis(1) });

    const out = await getHomogenization('30d');
    expect(out.points).toHaveLength(1);
    expect(out.current.personaCohesion).toBeCloseTo(1);
    expect(out.current.behaviorCohesion).toBeCloseTo(0);
    expect(out.current.n).toBe(2);
  });
});

describe('agents.service alerts', () => {
  afterEach(() => vi.restoreAllMocks());

  it('raises drift-spike (danger) and low-fidelity (warning) alerts, severest first', async () => {
    const alice = await seedUser({ username: 'alice', isAgent: true, displayName: 'Alice' });

    // drift spike (driftFromPrev 0.3 > 0.25) captured now
    await seedSnapshot(alice.id, { snapshotType: 'dream', driftFromPrev: 0.3 });
    // low fidelity (0.4 < 0.6)
    await seedBehavior(alice.id, { fidelity: 0.4 });

    const out = await getAlerts('30d');
    expect(out.alerts).toHaveLength(2);
    expect(out.alerts[0].severity).toBe('danger');
    expect(out.alerts[0].kind).toBe('drift_spike');
    expect(out.alerts.some((x) => x.kind === 'low_fidelity' && x.severity === 'warning')).toBe(true);
  });
});

describe('agents.service influences', () => {
  afterEach(() => vi.restoreAllMocks());

  it('ranks outbound partners with behavior-vector proximity', async () => {
    const alice = await seedUser({ username: 'alice', isAgent: true, displayName: 'Alice' });
    const bob = await seedUser({ username: 'bob', isAgent: false, displayName: 'Bob' });
    // bob joins the lab via a personality snapshot; behavior vectors give proximity.
    await seedSnapshot(bob.id);
    await seedBehavior(alice.id, { embedding: axis(0) });
    await seedBehavior(bob.id, { embedding: axis(0) });

    // alice → bob: 2 comments on bob's posts + 1 like = 3 outbound interactions.
    const pb1 = await seedPost(bob.id);
    const pb2 = await seedPost(bob.id);
    await seedComment(pb1.id, alice.id);
    await seedComment(pb2.id, alice.id);
    await seedLike(alice.id, pb1.id);

    const out = await getInfluences('alice', '30d');
    expect(out.partners).toHaveLength(1);
    expect(out.partners[0]).toMatchObject({ username: 'bob', interactions: 3 });
    expect(out.partners[0].proximity).toBeCloseTo(1);
    expect(out.activity).toHaveLength(30); // zero-filled days
  });
});
