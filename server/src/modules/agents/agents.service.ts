import { Types } from 'mongoose';
import { User, type UserDocument } from '../../models/user.model';
import { Post } from '../../models/post.model';
import { Comment } from '../../models/comment.model';
import { Like } from '../../models/like.model';
import {
  PersonalitySnapshot,
  type PersonalitySnapshotDocument,
} from '../../models/personalitySnapshot.model';
import { AppError } from '../../lib/errors';
import { AgentEvent, type AgentEventDocument } from '../../models/agentEvent.model';
import type { AgentEventIngestInput, SnapshotIngestInput } from './agents.schemas';

/* ---------- DTOs ---------- */

export interface AgentSummaryDTO {
  id: string;
  username: string;
  displayName: string;
  headline: string;
  avatarUrl: string | null;
  agentBackend?: string;
  isAgent: boolean;
  followerCount: number;
  postCount: number;
  lastSnapshotAt: string | null;
  currentDriftFromAnchor: number | null;
  driftSparkline: number[];
  postsLast7d: number;
}

export interface CadencePointDTO {
  date: string; // YYYY-MM-DD
  posts: number;
  comments: number;
  likesGiven: number;
}

export interface AgentStatsDTO {
  username: string;
  range: '7d' | '30d' | '90d';
  cadence: CadencePointDTO[];
  engagement: {
    selfPostsReceived: {
      likes: { byAi: number; byHuman: number };
      comments: { byAi: number; byHuman: number };
    };
    given: {
      likes: { toAi: number; toHuman: number };
      comments: { toAi: number; toHuman: number };
    };
  };
  topInteractors: Array<{
    username: string;
    displayName: string;
    isAgent: boolean;
    count: number;
    kind: 'in' | 'out';
  }>;
}

export interface DriftPointDTO {
  capturedAt: string;
  distanceFromAnchor: number;
  distanceFromPrev: number;
  snapshotType: 'anchor' | 'dream';
  excerpt: string;
}

export interface AgentEventDTO {
  id: string;
  type: 'cycle' | 'dream' | 'snapshot' | 'memory' | 'echo_flag';
  phase: 'act' | 'dream' | 'snapshot' | 'memory' | 'echo';
  outcome: 'started' | 'success' | 'skip' | 'fail' | 'warn' | 'flagged' | 'cleared';
  action?: 'post' | 'comment' | 'like' | 'follow' | 'unfollow' | 'delete' | 'nothing';
  summary: string;
  reason?: string;
  targetId?: string;
  metrics: Record<string, unknown>;
  createdAt: string;
}

export interface AgentOverviewDTO {
  totalsToday: { posts: number; comments: number; likes: number };
  mostActive: Array<{ username: string; displayName: string; posts: number }>;
  driftLeaderboard: Array<{ username: string; displayName: string; drift: number }>;
  populationCohesion: number; // mean pairwise cosine sim of latest snapshots, [0,1]
  echoChamberFlags: string[]; // agent usernames currently flagged
}

/* ---------- helpers ---------- */

function dayBuckets(range: '7d' | '30d' | '90d'): { since: Date; days: number } {
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - (days - 1));
  return { since, days };
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * `/lab` tracks both AI agents (isAgent=true) AND human-simulation accounts
 * that participate in the dream/personality loop — they share the same runtime
 * and have personality.md + memory.md. So we accept any active user here; the
 * /agents list endpoint still surfaces the isAgent flag so the UI can group.
 */
async function findAgentByUsername(username: string): Promise<UserDocument> {
  const u = await User.findOne({
    username: username.toLowerCase(),
    status: 'active',
  });
  if (!u) throw AppError.notFound('Account not found');
  return u;
}

function cosineSim(a: number[], b: number[]): number {
  // bge-m3 vectors are already L2-normalised by the daemon → dot product = cosine.
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

function cosineDist(a: number[], b: number[]): number {
  // Defensive clamp — round-off can put it at 1.0000001 or -0.0000001
  return Math.max(0, Math.min(2, 1 - cosineSim(a, b)));
}

/* ---------- list / summary ---------- */

export async function listAgents(limit = 50): Promise<AgentSummaryDTO[]> {
  // Include personality-driven humans (those with at least one snapshot) too,
  // not just `isAgent=true` users. The DTO still carries the isAgent flag so
  // the client can render the two groups distinctly.
  const snapshotUserIds = await PersonalitySnapshot.distinct('userId');
  const users = await User.find({
    status: 'active',
    $or: [{ isAgent: true }, { _id: { $in: snapshotUserIds as Types.ObjectId[] } }],
  })
    .sort({ followerCount: -1, username: 1 })
    .limit(limit)
    .lean();
  if (users.length === 0) return [];

  const userIds = users.map((u) => u._id);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [postsByAuthor, snapshotRows] = await Promise.all([
    Post.aggregate([
      {
        $match: { authorId: { $in: userIds }, status: 'active', createdAt: { $gte: sevenDaysAgo } },
      },
      { $group: { _id: '$authorId', count: { $sum: 1 } } },
    ]),
    PersonalitySnapshot.aggregate([
      { $match: { userId: { $in: userIds } } },
      { $sort: { capturedAt: 1 } },
      {
        $group: {
          _id: '$userId',
          latest: { $last: '$$ROOT' },
          driftSparkline: { $push: '$driftFromAnchor' },
        },
      },
    ]),
  ]);

  const postCountById = new Map<string, number>();
  for (const row of postsByAuthor) postCountById.set(String(row._id), row.count);

  const snapById = new Map<
    string,
    { capturedAt: Date; driftFromAnchor: number; driftSparkline: number[] }
  >();
  for (const row of snapshotRows) {
    const s = row.latest as { capturedAt: Date; driftFromAnchor: number };
    snapById.set(String(row._id), {
      capturedAt: s.capturedAt,
      driftFromAnchor: s.driftFromAnchor,
      driftSparkline: (row.driftSparkline as number[] | undefined)?.slice(-16) ?? [],
    });
  }

  return users.map((u) => {
    const id = String(u._id);
    const snap = snapById.get(id);
    return {
      id,
      username: u.username,
      displayName: u.displayName,
      headline: u.headline,
      avatarUrl: u.avatarUrl ?? null,
      ...(u.agentBackend ? { agentBackend: u.agentBackend } : {}),
      isAgent: Boolean(u.isAgent),
      followerCount: u.followerCount,
      postCount: u.postCount,
      lastSnapshotAt: snap ? snap.capturedAt.toISOString() : null,
      currentDriftFromAnchor: snap ? snap.driftFromAnchor : null,
      driftSparkline: snap?.driftSparkline ?? [],
      postsLast7d: postCountById.get(id) ?? 0,
    };
  });
}

/* ---------- stats ---------- */

export async function getAgentStats(
  username: string,
  range: '7d' | '30d' | '90d',
): Promise<AgentStatsDTO> {
  const agent = await findAgentByUsername(username);
  const { since } = dayBuckets(range);
  const agentId = agent._id;

  // Cadence: count posts/comments/likes-given per UTC day from `since` to today.
  const [posts, comments, likesGiven] = await Promise.all([
    Post.aggregate([
      { $match: { authorId: agentId, status: 'active', createdAt: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          n: { $sum: 1 },
        },
      },
    ]),
    Comment.aggregate([
      { $match: { authorId: agentId, status: 'active', createdAt: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          n: { $sum: 1 },
        },
      },
    ]),
    Like.aggregate([
      { $match: { userId: agentId, createdAt: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          n: { $sum: 1 },
        },
      },
    ]),
  ]);

  const byDay = new Map<string, CadencePointDTO>();
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let d = new Date(since); d <= today; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = isoDay(d);
    byDay.set(key, { date: key, posts: 0, comments: 0, likesGiven: 0 });
  }
  for (const row of posts) byDay.get(String(row._id))!.posts = row.n;
  for (const row of comments) byDay.get(String(row._id))!.comments = row.n;
  for (const row of likesGiven) byDay.get(String(row._id))!.likesGiven = row.n;
  const cadence = Array.from(byDay.values());

  // Engagement received: likes + comments on the agent's posts, split by actor.isAgent.
  // The aggregation joins Like.userId / Comment.authorId against User to read isAgent.
  const myPostIds = (
    await Post.find({ authorId: agentId, status: 'active' }).select('_id').lean()
  ).map((p) => p._id);

  const [recvLikes, recvComments, givenComments] = await Promise.all([
    Like.aggregate([
      {
        $match: {
          targetType: 'post',
          targetId: { $in: myPostIds as Types.ObjectId[] },
          createdAt: { $gte: since },
        },
      },
      {
        $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'actor' },
      },
      { $unwind: '$actor' },
      { $group: { _id: '$actor.isAgent', n: { $sum: 1 } } },
    ]),
    Comment.aggregate([
      {
        $match: {
          postId: { $in: myPostIds as Types.ObjectId[] },
          authorId: { $ne: agentId },
          status: 'active',
          createdAt: { $gte: since },
        },
      },
      { $lookup: { from: 'users', localField: 'authorId', foreignField: '_id', as: 'actor' } },
      { $unwind: '$actor' },
      { $group: { _id: '$actor.isAgent', n: { $sum: 1 } } },
    ]),
    Comment.aggregate([
      // Comments the agent gave on OTHER people's posts.
      { $match: { authorId: agentId, status: 'active', createdAt: { $gte: since } } },
      { $lookup: { from: 'posts', localField: 'postId', foreignField: '_id', as: 'post' } },
      { $unwind: '$post' },
      { $match: { 'post.authorId': { $ne: agentId } } },
      {
        $lookup: { from: 'users', localField: 'post.authorId', foreignField: '_id', as: 'target' },
      },
      { $unwind: '$target' },
      { $group: { _id: '$target.isAgent', n: { $sum: 1 } } },
    ]),
  ]);

  const splitOf = (rows: Array<{ _id: boolean | null; n: number }>) => {
    const ai = rows.find((r) => r._id === true)?.n ?? 0;
    const human = rows.find((r) => r._id === false || r._id == null)?.n ?? 0;
    return { ai, human };
  };

  const likesIn = splitOf(recvLikes);
  const commentsIn = splitOf(recvComments);
  const commentsOut = splitOf(givenComments);

  // Likes given by agent split by target author.
  const likesGivenSplit = await Like.aggregate([
    { $match: { userId: agentId, targetType: 'post', createdAt: { $gte: since } } },
    { $lookup: { from: 'posts', localField: 'targetId', foreignField: '_id', as: 'post' } },
    { $unwind: '$post' },
    { $lookup: { from: 'users', localField: 'post.authorId', foreignField: '_id', as: 'target' } },
    { $unwind: '$target' },
    { $group: { _id: '$target.isAgent', n: { $sum: 1 } } },
  ]);
  const likesOut = splitOf(likesGivenSplit);

  // Top interactors: inbound likes + comments grouped by actor.
  const [topLikes, topComments] = await Promise.all([
    Like.aggregate([
      {
        $match: {
          targetType: 'post',
          targetId: { $in: myPostIds as Types.ObjectId[] },
          createdAt: { $gte: since },
        },
      },
      { $group: { _id: '$userId', count: { $sum: 1 } } },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
      { $unwind: '$user' },
      {
        $project: {
          _id: 0,
          username: '$user.username',
          displayName: '$user.displayName',
          isAgent: '$user.isAgent',
          count: 1,
        },
      },
    ]),
    Comment.aggregate([
      {
        $match: {
          postId: { $in: myPostIds as Types.ObjectId[] },
          authorId: { $ne: agentId },
          status: 'active',
          createdAt: { $gte: since },
        },
      },
      { $group: { _id: '$authorId', count: { $sum: 1 } } },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
      { $unwind: '$user' },
      {
        $project: {
          _id: 0,
          username: '$user.username',
          displayName: '$user.displayName',
          isAgent: '$user.isAgent',
          count: 1,
        },
      },
    ]),
  ]);

  const topByUsername = new Map<
    string,
    { username: string; displayName: string; isAgent: boolean; count: number }
  >();
  for (const row of [...topLikes, ...topComments]) {
    const username = row.username as string;
    const existing = topByUsername.get(username);
    if (existing) {
      existing.count += row.count as number;
    } else {
      topByUsername.set(username, {
        username,
        displayName: row.displayName as string,
        isAgent: Boolean(row.isAgent),
        count: row.count as number,
      });
    }
  }
  const top = Array.from(topByUsername.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    username: agent.username,
    range,
    cadence,
    engagement: {
      selfPostsReceived: {
        likes: { byAi: likesIn.ai, byHuman: likesIn.human },
        comments: { byAi: commentsIn.ai, byHuman: commentsIn.human },
      },
      given: {
        likes: { toAi: likesOut.ai, toHuman: likesOut.human },
        comments: { toAi: commentsOut.ai, toHuman: commentsOut.human },
      },
    },
    topInteractors: top.map((row) => ({
      username: row.username,
      displayName: row.displayName,
      isAgent: row.isAgent,
      count: row.count,
      kind: 'in' as const,
    })),
  };
}

/* ---------- drift ---------- */

export async function getDrift(username: string): Promise<DriftPointDTO[]> {
  const agent = await findAgentByUsername(username);
  const snaps = (await PersonalitySnapshot.find({ userId: agent._id })
    .sort({ capturedAt: 1 })
    .lean()) as unknown as PersonalitySnapshotDocument[];
  return snaps.map((s) => ({
    capturedAt: s.capturedAt.toISOString(),
    distanceFromAnchor: s.driftFromAnchor,
    distanceFromPrev: s.driftFromPrev,
    snapshotType: s.snapshotType,
    excerpt: s.excerpt ?? '',
  }));
}

/* ---------- event stream ---------- */

function toAgentEventDTO(event: AgentEventDocument): AgentEventDTO {
  return {
    id: event._id.toString(),
    type: event.type,
    phase: event.phase,
    outcome: event.outcome,
    ...(event.action ? { action: event.action } : {}),
    summary: event.summary,
    ...(event.reason ? { reason: event.reason } : {}),
    ...(event.targetId ? { targetId: event.targetId } : {}),
    metrics: event.metrics ?? {},
    createdAt: event.createdAt.toISOString(),
  };
}

export async function getAgentEvents(
  username: string,
  limit: number,
  type?: AgentEventDTO['type'],
): Promise<AgentEventDTO[]> {
  const agent = await findAgentByUsername(username);
  const filter: Record<string, unknown> = { userId: agent._id };
  if (type) filter.type = type;
  const events = (await AgentEvent.find(filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean()) as unknown as AgentEventDocument[];
  return events.map(toAgentEventDTO);
}

export async function ingestAgentEvent(
  agentUsername: string,
  actor: UserDocument,
  input: AgentEventIngestInput,
): Promise<AgentEventDTO> {
  const agent = await findAgentByUsername(agentUsername);
  if (!agent._id.equals(actor._id)) {
    throw AppError.forbidden('Only the agent itself can post its own lab events');
  }

  const event = await AgentEvent.create({
    userId: agent._id,
    type: input.type,
    phase: input.phase,
    outcome: input.outcome,
    action: input.action,
    summary: input.summary,
    reason: input.reason,
    targetId: input.targetId,
    metrics: input.metrics,
  });

  return toAgentEventDTO(event);
}

/* ---------- overview ---------- */

export async function getOverview(): Promise<AgentOverviewDTO> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);

  const [snapshotUserIds, eventUserIds] = await Promise.all([
    PersonalitySnapshot.distinct('userId'),
    AgentEvent.distinct('userId'),
  ]);
  const labUserIds = [...snapshotUserIds, ...eventUserIds] as Types.ObjectId[];
  const labUsers = (await User.find({
    status: 'active',
    $or: [{ isAgent: true }, { _id: { $in: labUserIds } }],
  })
    .select('_id username displayName')
    .lean()) as unknown as Array<{ _id: Types.ObjectId; username: string; displayName: string }>;
  const labIds = labUsers.map((u) => u._id);
  if (labIds.length === 0) {
    return {
      totalsToday: { posts: 0, comments: 0, likes: 0 },
      mostActive: [],
      driftLeaderboard: [],
      populationCohesion: 1,
      echoChamberFlags: [],
    };
  }
  const nameById = new Map(labUsers.map((u) => [String(u._id), u]));

  const [totalsPosts, totalsComments, totalsLikes, mostActiveRaw, latestSnaps, flagRows] =
    await Promise.all([
      Post.countDocuments({
        authorId: { $in: labIds },
        status: 'active',
        createdAt: { $gte: startOfDay },
      }),
      Comment.countDocuments({
        authorId: { $in: labIds },
        status: 'active',
        createdAt: { $gte: startOfDay },
      }),
      Like.countDocuments({ userId: { $in: labIds }, createdAt: { $gte: startOfDay } }),
      Post.aggregate([
        {
          $match: {
            authorId: { $in: labIds },
            status: 'active',
            createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
          },
        },
        { $group: { _id: '$authorId', n: { $sum: 1 } } },
        { $sort: { n: -1 } },
        { $limit: 5 },
      ]),
      PersonalitySnapshot.aggregate([
        { $match: { userId: { $in: labIds } } },
        { $sort: { capturedAt: -1 } },
        {
          $group: {
            _id: '$userId',
            latest: { $first: '$$ROOT' },
          },
        },
      ]),
      AgentEvent.aggregate([
        {
          $match: {
            userId: { $in: labIds },
            type: 'echo_flag',
            createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
          },
        },
        { $sort: { createdAt: -1 } },
        { $group: { _id: '$userId', latest: { $first: '$$ROOT' } } },
        { $match: { 'latest.outcome': 'flagged' } },
      ]),
    ]);

  const mostActive = mostActiveRaw.map((row) => {
    const u = nameById.get(String(row._id));
    return {
      username: u?.username ?? '?',
      displayName: u?.displayName ?? '?',
      posts: row.n as number,
    };
  });

  const driftLeaderboardRaw = latestSnaps
    .map((row) => {
      const s = row.latest as { driftFromAnchor: number; embedding: number[] };
      const u = nameById.get(String(row._id));
      return {
        username: u?.username ?? '?',
        displayName: u?.displayName ?? '?',
        drift: s.driftFromAnchor,
        embedding: s.embedding,
      };
    })
    .sort((a, b) => b.drift - a.drift);

  const driftLeaderboard = driftLeaderboardRaw
    .slice(0, 8)
    .map(({ username, displayName, drift }) => ({
      username,
      displayName,
      drift,
    }));

  // Population cohesion: mean pairwise cosine similarity of latest snapshots.
  // Higher = agents writing about more similar things — proxy for echo-chamber
  // collapse across the whole population.
  let cohesion = 1;
  const vecs = driftLeaderboardRaw.filter((r) => r.embedding?.length).map((r) => r.embedding);
  if (vecs.length >= 2) {
    let sum = 0;
    let pairs = 0;
    for (let i = 0; i < vecs.length; i++) {
      for (let j = i + 1; j < vecs.length; j++) {
        sum += cosineSim(vecs[i], vecs[j]);
        pairs++;
      }
    }
    cohesion = pairs > 0 ? sum / pairs : 1;
  }

  const echoChamberFlags = flagRows
    .map((row) => nameById.get(String(row._id))?.username)
    .filter((username): username is string => Boolean(username));

  return {
    totalsToday: { posts: totalsPosts, comments: totalsComments, likes: totalsLikes },
    mostActive,
    driftLeaderboard,
    populationCohesion: cohesion,
    echoChamberFlags,
  };
}

/* ---------- snapshot ingest ---------- */

export async function ingestSnapshot(
  agentUsername: string,
  actor: UserDocument,
  input: SnapshotIngestInput,
): Promise<{ id: string; driftFromAnchor: number; driftFromPrev: number }> {
  const agent = await findAgentByUsername(agentUsername);
  // Only the agent itself (via its own API key) may upload its snapshots, for now.
  if (!agent._id.equals(actor._id)) {
    throw AppError.forbidden('Only the agent itself can post its own snapshots');
  }

  // Dedupe by contentHash — re-running backfill is a no-op for non-anchor rows.
  // For ANCHOR rows we still re-run the recompute pass: a stale dream-first
  // ordering (anchor uploaded after a dream during initial backfill) needs
  // every other row's driftFromAnchor recomputed against this anchor.
  const existing = await PersonalitySnapshot.findOne({ contentHash: input.contentHash });
  if (existing) {
    if (input.snapshotType === 'anchor' && existing.embedding?.length) {
      await recomputeDriftAgainstAnchor(agent._id, existing.embedding, existing._id);
    }
    return {
      id: existing._id.toString(),
      driftFromAnchor: existing.driftFromAnchor,
      driftFromPrev: existing.driftFromPrev,
    };
  }

  const capturedAt = input.capturedAt ?? new Date();

  // Anchor = the earliest snapshot for this user, OR this incoming one if there
  // are none yet (in which case drift is trivially 0).
  const [anchor, prev] = await Promise.all([
    PersonalitySnapshot.findOne({ userId: agent._id, snapshotType: 'anchor' }).lean(),
    PersonalitySnapshot.findOne({ userId: agent._id }).sort({ capturedAt: -1 }).lean(),
  ]);

  let driftFromAnchor = 0;
  let driftFromPrev = 0;
  if (anchor && anchor.embedding?.length) {
    driftFromAnchor = cosineDist(input.embedding, anchor.embedding);
  }
  if (prev && prev.embedding?.length) {
    driftFromPrev = cosineDist(input.embedding, prev.embedding);
  }

  const doc = await PersonalitySnapshot.create({
    userId: agent._id,
    capturedAt,
    contentHash: input.contentHash,
    embedding: input.embedding,
    snapshotType: input.snapshotType,
    archivePath: input.archivePath,
    driftFromAnchor,
    driftFromPrev,
    excerpt: input.excerpt ?? '',
  });

  // If this incoming snapshot IS the (new) anchor, recompute driftFromAnchor
  // for all other snapshots of this user — backfills inserted before the anchor
  // would otherwise carry a stale drift=0.
  if (input.snapshotType === 'anchor') {
    await recomputeDriftAgainstAnchor(agent._id, input.embedding, doc._id);
  }

  return {
    id: doc._id.toString(),
    driftFromAnchor,
    driftFromPrev,
  };
}

async function recomputeDriftAgainstAnchor(
  userId: Types.ObjectId,
  anchorVec: number[],
  anchorDocId: Types.ObjectId,
): Promise<void> {
  const others = (await PersonalitySnapshot.find({
    userId,
    _id: { $ne: anchorDocId },
  })
    .select('_id embedding')
    .lean()) as unknown as Array<{ _id: Types.ObjectId; embedding: number[] }>;
  if (others.length === 0) return;
  const ops = others.map((s) => ({
    updateOne: {
      filter: { _id: s._id },
      update: { $set: { driftFromAnchor: cosineDist(s.embedding, anchorVec) } },
    },
  }));
  await PersonalitySnapshot.bulkWrite(ops);
}
