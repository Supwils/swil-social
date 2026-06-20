import { afterEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { User, type UserDocument } from '../../models/user.model';
import { PersonalitySnapshot } from '../../models/personalitySnapshot.model';
import { BehaviorSnapshot } from '../../models/behaviorSnapshot.model';
import { PopulationMetric } from '../../models/populationMetric.model';
import { Post } from '../../models/post.model';
import { Comment } from '../../models/comment.model';
import { Like } from '../../models/like.model';
import { AgentEvent } from '../../models/agentEvent.model';
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
} from './agents.service';

function makeAgent(id = new Types.ObjectId(), username = 'zenith'): UserDocument {
  return {
    _id: id,
    id: id.toString(),
    username,
    isAgent: true,
    status: 'active',
    equals(other: { _id: Types.ObjectId }) {
      return this._id.equals(other._id);
    },
  } as unknown as UserDocument;
}

describe('agents.service.ingestSnapshot', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects when the actor is not the agent itself', async () => {
    const agent = makeAgent();
    const other = makeAgent(new Types.ObjectId(), 'someoneelse');

    vi.spyOn(User, 'findOne').mockResolvedValue(agent);
    vi.spyOn(PersonalitySnapshot, 'findOne').mockResolvedValue(null);

    await expect(
      ingestSnapshot('zenith', other, {
        contentHash: 'a'.repeat(64),
        embedding: Array(64).fill(0.01),
        snapshotType: 'dream',
        archivePath: 'agents/zenith/personality.archive.md#1',
        excerpt: '',
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('returns the existing snapshot if contentHash already ingested (idempotent backfill)', async () => {
    const agent = makeAgent();
    vi.spyOn(User, 'findOne').mockResolvedValue(agent);
    vi.spyOn(PersonalitySnapshot, 'findOne').mockResolvedValue({
      _id: new Types.ObjectId(),
      driftFromAnchor: 0.12,
      driftFromPrev: 0.05,
    } as never);

    const out = await ingestSnapshot('zenith', agent, {
      contentHash: 'b'.repeat(64),
      embedding: Array(64).fill(0.01),
      snapshotType: 'dream',
      archivePath: 'agents/zenith/personality.archive.md#2',
      excerpt: '',
    });

    expect(out.driftFromAnchor).toBe(0.12);
    expect(out.driftFromPrev).toBe(0.05);
  });

  it('computes drift = 0 when no anchor or prev snapshot exists yet', async () => {
    const agent = makeAgent();
    vi.spyOn(User, 'findOne').mockResolvedValue(agent);
    // First lookup: dedupe check by contentHash → not found
    // Subsequent: anchor + prev → both null
    vi.spyOn(PersonalitySnapshot, 'findOne').mockImplementation(() => {
      const chain = {
        sort: () => chain,
        lean: () => Promise.resolve(null),
        then: (onFulfilled: (v: unknown) => unknown) => Promise.resolve(null).then(onFulfilled),
      };
      return chain as never;
    });
    vi.spyOn(PersonalitySnapshot, 'create').mockResolvedValue({
      _id: new Types.ObjectId(),
    } as never);
    // Anchor insert also triggers a recompute pass that queries Mongo for siblings.
    const findChain = {
      select: () => findChain,
      lean: () => Promise.resolve([]),
    };
    vi.spyOn(PersonalitySnapshot, 'find').mockReturnValue(findChain as never);
    vi.spyOn(PersonalitySnapshot, 'bulkWrite').mockResolvedValue({} as never);

    const out = await ingestSnapshot('zenith', agent, {
      contentHash: 'c'.repeat(64),
      embedding: Array(64).fill(0.01),
      snapshotType: 'anchor',
      archivePath: 'agents/zenith/personality.md',
      excerpt: 'hello',
    });

    expect(out.driftFromAnchor).toBe(0);
    expect(out.driftFromPrev).toBe(0);
  });
});

describe('agents.service.getDrift', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns empty list for an agent with no snapshots', async () => {
    const agent = makeAgent();
    vi.spyOn(User, 'findOne').mockResolvedValue(agent);
    const chain = {
      sort: () => chain,
      lean: () => Promise.resolve([]),
    };
    vi.spyOn(PersonalitySnapshot, 'find').mockReturnValue(chain as never);

    const out = await getDrift('zenith');
    expect(out).toEqual([]);
  });

  it('surfaces diffNarrative when present and omits it otherwise (Feature 5)', async () => {
    const agent = makeAgent();
    vi.spyOn(User, 'findOne').mockResolvedValue(agent);
    const chain = {
      sort: () => chain,
      lean: () =>
        Promise.resolve([
          {
            capturedAt: new Date('2026-06-01T00:00:00.000Z'),
            driftFromAnchor: 0.1,
            driftFromPrev: 0.1,
            snapshotType: 'anchor',
            excerpt: 'x',
          },
          {
            capturedAt: new Date('2026-06-02T00:00:00.000Z'),
            driftFromAnchor: 0.2,
            driftFromPrev: 0.12,
            snapshotType: 'dream',
            excerpt: 'y',
            diffNarrative: '强化了对“在场”的关注，淡化了早期的技术腔。',
          },
        ]),
    };
    vi.spyOn(PersonalitySnapshot, 'find').mockReturnValue(chain as never);

    const out = await getDrift('zenith');
    expect(out[0].diffNarrative).toBeUndefined();
    expect(out[1].diffNarrative).toContain('在场');
  });
});

describe('agents.service.getPulse', () => {
  afterEach(() => vi.restoreAllMocks());

  it('builds a population pulse with activity, fidelity and drift velocity per day', async () => {
    const id = new Types.ObjectId();
    vi.spyOn(PersonalitySnapshot, 'distinct').mockResolvedValue([id] as never);
    vi.spyOn(AgentEvent, 'distinct').mockResolvedValue([] as never);
    const userChain = {
      select: () => userChain,
      lean: () =>
        Promise.resolve([{ _id: id, username: 'zenith', displayName: 'Zenith', isAgent: true }]),
    };
    vi.spyOn(User, 'find').mockReturnValue(userChain as never);

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const day = today.toISOString().slice(0, 10);

    vi.spyOn(Post, 'aggregate').mockResolvedValue([{ _id: day, n: 2 }] as never);
    vi.spyOn(Comment, 'aggregate').mockResolvedValue([{ _id: day, n: 3 }] as never);
    vi.spyOn(Like, 'aggregate').mockResolvedValue([{ _id: day, n: 5 }] as never);
    vi.spyOn(BehaviorSnapshot, 'aggregate').mockResolvedValue([{ _id: day, avg: 0.8 }] as never);
    vi.spyOn(PersonalitySnapshot, 'aggregate').mockResolvedValue([{ _id: day, avg: 0.12 }] as never);

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
    const id = new Types.ObjectId();
    const user = {
      _id: id,
      username: 'zenith',
      displayName: 'Zenith',
      headline: 'Quiet observer',
      avatarUrl: null,
      isAgent: true,
      followerCount: 4,
      postCount: 12,
    };
    const userFindChain = {
      sort: () => userFindChain,
      limit: () => userFindChain,
      lean: () => Promise.resolve([user]),
    };
    vi.spyOn(PersonalitySnapshot, 'distinct').mockResolvedValue([id]);
    vi.spyOn(User, 'find').mockReturnValue(userFindChain as never);
    const postAggregate = vi
      .spyOn(Post, 'aggregate')
      .mockResolvedValue([{ _id: id, count: 3 }] as never);
    vi.spyOn(PersonalitySnapshot, 'aggregate').mockResolvedValue([
      {
        _id: id,
        latest: { capturedAt: new Date('2026-05-30T00:00:00.000Z'), driftFromAnchor: 0.22 },
        driftSparkline: [0, 0.1, 0.22],
      },
    ] as never);
    vi.spyOn(BehaviorSnapshot, 'aggregate').mockResolvedValue([
      { _id: id, fidelity: 0.81 },
    ] as never);

    const out = await listAgents(10);
    const postPipeline = postAggregate.mock.calls[0][0];

    expect(postPipeline[0]).toMatchObject({ $match: { status: 'active' } });
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
    const agent = makeAgent();
    const other = makeAgent(new Types.ObjectId(), 'someoneelse');
    vi.spyOn(User, 'findOne').mockResolvedValue(agent);

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
    const agent = makeAgent();
    const eventId = new Types.ObjectId();
    vi.spyOn(User, 'findOne').mockResolvedValue(agent);
    vi.spyOn(AgentEvent, 'create').mockResolvedValue({
      _id: eventId,
      type: 'cycle',
      phase: 'act',
      outcome: 'success',
      action: 'post',
      summary: 'posted a note',
      metrics: {},
      createdAt: new Date('2026-05-30T00:00:00.000Z'),
    } as never);

    const out = await ingestAgentEvent('zenith', agent, {
      type: 'cycle',
      phase: 'act',
      outcome: 'success',
      action: 'post',
      summary: 'posted a note',
      metrics: {},
    });

    expect(AgentEvent.create).toHaveBeenCalledWith(expect.objectContaining({ userId: agent._id }));
    expect(out).toMatchObject({
      id: eventId.toString(),
      type: 'cycle',
      phase: 'act',
      outcome: 'success',
      action: 'post',
      summary: 'posted a note',
    });
  });

  it('accepts a rule_check event (Feature 4 enum)', async () => {
    const agent = makeAgent();
    const eventId = new Types.ObjectId();
    vi.spyOn(User, 'findOne').mockResolvedValue(agent);
    vi.spyOn(AgentEvent, 'create').mockResolvedValue({
      _id: eventId,
      type: 'rule_check',
      phase: 'rule',
      outcome: 'flagged',
      summary: 'hashtag count 2-4: 7/12 posts adherent (58%)',
      metrics: { rule: 'hashtag_count', passRate: 0.58, checked: 12 },
      createdAt: new Date('2026-06-12T00:00:00.000Z'),
    } as never);

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

  it('lists recent events for a focused agent', async () => {
    const agent = makeAgent();
    vi.spyOn(User, 'findOne').mockResolvedValue(agent);
    const findChain = {
      sort: () => findChain,
      limit: () => findChain,
      lean: () =>
        Promise.resolve([
          {
            _id: new Types.ObjectId(),
            type: 'memory',
            phase: 'memory',
            outcome: 'success',
            summary: 'memory synced',
            metrics: {},
            createdAt: new Date('2026-05-30T00:00:00.000Z'),
          },
        ]),
    };
    vi.spyOn(AgentEvent, 'find').mockReturnValue(findChain as never);

    const out = await getAgentEvents('zenith', 5, 'memory');

    expect(AgentEvent.find).toHaveBeenCalledWith({ userId: agent._id, type: 'memory' });
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('memory');
  });
});

describe('agents.service persona fidelity', () => {
  afterEach(() => vi.restoreAllMocks());

  it('rejects behavior ingest when the actor is not the agent itself', async () => {
    const agent = makeAgent();
    const other = makeAgent(new Types.ObjectId(), 'someoneelse');
    vi.spyOn(User, 'findOne').mockResolvedValue(agent);
    vi.spyOn(BehaviorSnapshot, 'findOne').mockResolvedValue(null);

    await expect(
      ingestBehaviorSnapshot('zenith', other, {
        contentHash: 'a'.repeat(64),
        embedding: Array(64).fill(0.125),
        postCount: 3,
        commentCount: 0,
        excerpt: '',
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('is idempotent — returns the existing row on a contentHash hit', async () => {
    const agent = makeAgent();
    vi.spyOn(User, 'findOne').mockResolvedValue(agent);
    vi.spyOn(BehaviorSnapshot, 'findOne').mockResolvedValue({
      _id: new Types.ObjectId(),
      fidelity: 0.91,
    } as never);

    const out = await ingestBehaviorSnapshot('zenith', agent, {
      contentHash: 'b'.repeat(64),
      embedding: Array(64).fill(0.125),
      postCount: 5,
      commentCount: 0,
      excerpt: '',
    });

    expect(out.fidelity).toBe(0.91);
  });

  it('computes fidelity = cosine(behavior, latest personality vector)', async () => {
    const agent = makeAgent();
    vi.spyOn(User, 'findOne').mockResolvedValue(agent);
    vi.spyOn(BehaviorSnapshot, 'findOne').mockResolvedValue(null);
    // latest personality snapshot — same unit vector → cosine = 1
    const personaChain = {
      sort: () => personaChain,
      select: () => personaChain,
      lean: () => Promise.resolve({ embedding: Array(64).fill(0.125) }),
    };
    vi.spyOn(PersonalitySnapshot, 'findOne').mockReturnValue(personaChain as never);
    vi.spyOn(BehaviorSnapshot, 'create').mockResolvedValue({
      _id: new Types.ObjectId(),
    } as never);

    const out = await ingestBehaviorSnapshot('zenith', agent, {
      contentHash: 'c'.repeat(64),
      embedding: Array(64).fill(0.125),
      postCount: 7,
      commentCount: 0,
      excerpt: 'recent posts',
    });

    expect(out.fidelity).toBeCloseTo(1);
  });

  it('computes a fractional fidelity for partially-aligned vectors', async () => {
    const agent = makeAgent();
    vi.spyOn(User, 'findOne').mockResolvedValue(agent);
    vi.spyOn(BehaviorSnapshot, 'findOne').mockResolvedValue(null);
    // persona = [1,0,...]; behavior = [0.6,0.8,0,...] → cosine = 0.6 (both unit vectors)
    const persona = [1, 0, ...Array(62).fill(0)];
    const behavior = [0.6, 0.8, ...Array(62).fill(0)];
    const personaChain = {
      sort: () => personaChain,
      select: () => personaChain,
      lean: () => Promise.resolve({ embedding: persona }),
    };
    vi.spyOn(PersonalitySnapshot, 'findOne').mockReturnValue(personaChain as never);
    vi.spyOn(BehaviorSnapshot, 'create').mockResolvedValue({ _id: new Types.ObjectId() } as never);

    const out = await ingestBehaviorSnapshot('zenith', agent, {
      contentHash: 'e'.repeat(64),
      embedding: behavior,
      postCount: 4,
      commentCount: 0,
      excerpt: '',
    });

    expect(out.fidelity).toBeCloseTo(0.6);
  });

  it('records null fidelity when there is no personality snapshot yet', async () => {
    const agent = makeAgent();
    vi.spyOn(User, 'findOne').mockResolvedValue(agent);
    vi.spyOn(BehaviorSnapshot, 'findOne').mockResolvedValue(null);
    const personaChain = {
      sort: () => personaChain,
      select: () => personaChain,
      lean: () => Promise.resolve(null),
    };
    vi.spyOn(PersonalitySnapshot, 'findOne').mockReturnValue(personaChain as never);
    vi.spyOn(BehaviorSnapshot, 'create').mockResolvedValue({
      _id: new Types.ObjectId(),
    } as never);

    const out = await ingestBehaviorSnapshot('zenith', agent, {
      contentHash: 'd'.repeat(64),
      embedding: Array(64).fill(0.125),
      postCount: 2,
      commentCount: 0,
      excerpt: '',
    });

    expect(out.fidelity).toBeNull();
  });

  it('returns the fidelity trajectory with the latest as current', async () => {
    const agent = makeAgent();
    vi.spyOn(User, 'findOne').mockResolvedValue(agent);
    const findChain = {
      sort: () => findChain,
      select: () => findChain,
      lean: () =>
        Promise.resolve([
          { capturedAt: new Date('2026-06-01T00:00:00.000Z'), fidelity: 0.8 },
          { capturedAt: new Date('2026-06-02T00:00:00.000Z'), fidelity: 0.74 },
        ]),
    };
    vi.spyOn(BehaviorSnapshot, 'find').mockReturnValue(findChain as never);

    const out = await getFidelity('zenith');
    expect(out.points).toHaveLength(2);
    expect(out.current).toBe(0.74);
  });
});

describe('agents.service interaction graph', () => {
  afterEach(() => vi.restoreAllMocks());

  it('merges comment/reply/echo/like edges within the lab population', async () => {
    const a = new Types.ObjectId();
    const b = new Types.ObjectId();

    // loadLabUsers: distinct ids + a User.find chain
    vi.spyOn(PersonalitySnapshot, 'distinct').mockResolvedValue([a, b] as never);
    vi.spyOn(AgentEvent, 'distinct').mockResolvedValue([] as never);
    const userChain = {
      select: () => userChain,
      lean: () =>
        Promise.resolve([
          { _id: a, username: 'alice', displayName: 'Alice', isAgent: true },
          { _id: b, username: 'bob', displayName: 'Bob', isAgent: false },
        ]),
    };
    vi.spyOn(User, 'find').mockReturnValue(userChain as never);

    // Comment.aggregate is called twice: top-level comments, then replies.
    vi.spyOn(Comment, 'aggregate')
      .mockResolvedValueOnce([{ _id: { s: a, t: b }, count: 1 }] as never)
      .mockResolvedValueOnce([{ _id: { s: b, t: a }, count: 1 }] as never);
    // echoes a→b — proves the echo pipeline merges onto the same s|t key.
    vi.spyOn(Post, 'aggregate').mockResolvedValue([{ _id: { s: a, t: b }, count: 1 }] as never);
    vi.spyOn(Like, 'aggregate').mockResolvedValue([
      { _id: { s: a, t: b }, count: 2 },
    ] as never);

    const out = await getInteractionGraph('7d');

    expect(out.range).toBe('7d');
    expect(out.nodes).toHaveLength(2);
    expect(out.edges).toHaveLength(2);

    // a→b accumulates comment(1) + echo(1) + like(2) on one edge = weight 4.
    const ab = out.edges.find((e) => e.source === 'alice' && e.target === 'bob');
    const ba = out.edges.find((e) => e.source === 'bob' && e.target === 'alice');
    expect(ab).toMatchObject({ weight: 4, kinds: { comment: 1, reply: 0, echo: 1, like: 2 } });
    expect(ba).toMatchObject({ weight: 1, kinds: { reply: 1 } });

    // strength = in + out: alice 4(out)+1(in)=5, bob 1(out)+4(in)=5
    const alice = out.nodes.find((n) => n.username === 'alice');
    expect(alice).toMatchObject({ isAgent: true, strength: 5 });
  });

  it('drops edges whose endpoints are outside the lab population', async () => {
    const a = new Types.ObjectId();
    const outsider = new Types.ObjectId();
    vi.spyOn(PersonalitySnapshot, 'distinct').mockResolvedValue([a] as never);
    vi.spyOn(AgentEvent, 'distinct').mockResolvedValue([] as never);
    const userChain = {
      select: () => userChain,
      lean: () => Promise.resolve([{ _id: a, username: 'alice', displayName: 'Alice', isAgent: true }]),
    };
    vi.spyOn(User, 'find').mockReturnValue(userChain as never);
    vi.spyOn(Comment, 'aggregate')
      .mockResolvedValueOnce([{ _id: { s: a, t: outsider }, count: 5 }] as never)
      .mockResolvedValueOnce([] as never);
    vi.spyOn(Post, 'aggregate').mockResolvedValue([] as never);
    vi.spyOn(Like, 'aggregate').mockResolvedValue([] as never);

    const out = await getInteractionGraph('30d');
    expect(out.edges).toHaveLength(0);
    expect(out.nodes).toHaveLength(0);
  });
});

describe('agents.service homogenization', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns stored points plus a freshly-computed current cohesion', async () => {
    const findChain = {
      sort: () => findChain,
      lean: () =>
        Promise.resolve([
          {
            capturedAt: new Date('2026-06-01T00:00:00.000Z'),
            personaCohesion: 0.82,
            behaviorCohesion: 0.7,
            n: 5,
          },
        ]),
    };
    vi.spyOn(PopulationMetric, 'find').mockReturnValue(findChain as never);
    // current: persona vectors identical → cohesion 1; behavior orthogonal → 0
    vi.spyOn(PersonalitySnapshot, 'aggregate').mockResolvedValue([
      { _id: new Types.ObjectId(), embedding: [1, 0] },
      { _id: new Types.ObjectId(), embedding: [1, 0] },
    ] as never);
    vi.spyOn(BehaviorSnapshot, 'aggregate').mockResolvedValue([
      { _id: new Types.ObjectId(), embedding: [1, 0] },
      { _id: new Types.ObjectId(), embedding: [0, 1] },
    ] as never);

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
    const a = new Types.ObjectId();
    vi.spyOn(PersonalitySnapshot, 'distinct').mockResolvedValue([a] as never);
    vi.spyOn(AgentEvent, 'distinct').mockResolvedValue([] as never);
    const userChain = {
      select: () => userChain,
      lean: () =>
        Promise.resolve([{ _id: a, username: 'alice', displayName: 'Alice', isAgent: true }]),
    };
    vi.spyOn(User, 'find').mockReturnValue(userChain as never);

    vi.spyOn(PersonalitySnapshot, 'aggregate').mockResolvedValue([
      { _id: a, driftFromPrev: 0.3, capturedAt: new Date() },
    ] as never);
    vi.spyOn(BehaviorSnapshot, 'aggregate').mockResolvedValue([
      { _id: a, fidelity: 0.4, capturedAt: new Date() },
    ] as never);
    // dreamFails, echoFlags, ruleFlags — all empty
    vi.spyOn(AgentEvent, 'aggregate')
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never);

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
    const alice = new Types.ObjectId();
    const bob = new Types.ObjectId();
    vi.spyOn(User, 'findOne').mockResolvedValue(makeAgent(alice, 'alice'));

    const driftChain = {
      sort: () => driftChain,
      select: () => driftChain,
      lean: () => Promise.resolve([]),
    };
    vi.spyOn(PersonalitySnapshot, 'find').mockReturnValue(driftChain as never);

    // loadLabUsers
    vi.spyOn(PersonalitySnapshot, 'distinct').mockResolvedValue([alice, bob] as never);
    vi.spyOn(AgentEvent, 'distinct').mockResolvedValue([] as never);
    const userChain = {
      select: () => userChain,
      lean: () =>
        Promise.resolve([
          { _id: alice, username: 'alice', displayName: 'Alice', isAgent: true },
          { _id: bob, username: 'bob', displayName: 'Bob', isAgent: false },
        ]),
    };
    vi.spyOn(User, 'find').mockReturnValue(userChain as never);

    // Outbound aggregations (Comment ×3: cOut, rOut, commentsByDay;
    // Post ×2: eOut, postsByDay; Like ×2: lOut, likesByDay; BehaviorSnapshot ×1)
    vi.spyOn(Comment, 'aggregate')
      .mockResolvedValueOnce([{ _id: bob, count: 2 }] as never) // cOut
      .mockResolvedValueOnce([] as never) // rOut
      .mockResolvedValueOnce([] as never); // commentsByDay
    vi.spyOn(Post, 'aggregate')
      .mockResolvedValueOnce([] as never) // eOut
      .mockResolvedValueOnce([] as never); // postsByDay
    vi.spyOn(Like, 'aggregate')
      .mockResolvedValueOnce([{ _id: bob, count: 1 }] as never) // lOut
      .mockResolvedValueOnce([] as never); // likesByDay
    vi.spyOn(BehaviorSnapshot, 'aggregate').mockResolvedValue([
      { _id: alice, embedding: [1, 0] },
      { _id: bob, embedding: [1, 0] },
    ] as never);

    const out = await getInfluences('alice', '30d');
    expect(out.partners).toHaveLength(1);
    expect(out.partners[0]).toMatchObject({ username: 'bob', interactions: 3 });
    expect(out.partners[0].proximity).toBeCloseTo(1);
    expect(out.activity).toHaveLength(30); // zero-filled days
  });
});
