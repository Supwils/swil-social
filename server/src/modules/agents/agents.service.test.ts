import { afterEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { User, type UserDocument } from '../../models/user.model';
import { PersonalitySnapshot } from '../../models/personalitySnapshot.model';
import { Post } from '../../models/post.model';
import { AgentEvent } from '../../models/agentEvent.model';
import {
  ingestSnapshot,
  getDrift,
  listAgents,
  ingestAgentEvent,
  getAgentEvents,
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

    const out = await listAgents(10);
    const postPipeline = postAggregate.mock.calls[0][0];

    expect(postPipeline[0]).toMatchObject({ $match: { status: 'active' } });
    expect(out[0]).toMatchObject({
      username: 'zenith',
      postsLast7d: 3,
      currentDriftFromAnchor: 0.22,
      driftSparkline: [0, 0.1, 0.22],
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
