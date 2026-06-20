import { Types } from 'mongoose';
import { User, type UserDocument } from '../../models/user.model';
import { Post } from '../../models/post.model';
import { Comment } from '../../models/comment.model';
import { Like } from '../../models/like.model';
import {
  PersonalitySnapshot,
  type PersonalitySnapshotDocument,
} from '../../models/personalitySnapshot.model';
import { BehaviorSnapshot } from '../../models/behaviorSnapshot.model';
import { PopulationMetric } from '../../models/populationMetric.model';
import { AppError } from '../../lib/errors';
import { AgentEvent, type AgentEventDocument } from '../../models/agentEvent.model';
import { cosineDist, cosineSim, meanPairwiseCosine } from '../../lib/vector';
import { TTLCache } from '../../lib/ttlCache';
import type {
  AgentEventIngestInput,
  BehaviorSnapshotIngestInput,
  SnapshotIngestInput,
} from './agents.schemas';

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
  /** Latest persona-fidelity (cosine sim of stated self vs revealed behavior); null until a behavior sample exists. */
  currentFidelity: number | null;
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
  diffNarrative?: string;
}

export interface AgentEventDTO {
  id: string;
  type: 'cycle' | 'dream' | 'snapshot' | 'memory' | 'echo_flag' | 'rule_check' | 'anomaly';
  phase: 'act' | 'dream' | 'snapshot' | 'memory' | 'echo' | 'rule' | 'anomaly';
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

export interface FidelityPointDTO {
  capturedAt: string;
  fidelity: number | null; // cosine sim(personality, behavior); null if not yet comparable
}

export interface FidelityDTO {
  current: number | null;
  points: FidelityPointDTO[];
}

export interface GraphNodeDTO {
  username: string;
  displayName: string;
  isAgent: boolean;
  strength: number; // total incident edge weight (in + out)
}

export interface GraphEdgeDTO {
  source: string; // username
  target: string; // username
  weight: number; // total directed interactions source → target
  kinds: { comment: number; reply: number; echo: number; like: number };
}

export interface InteractionGraphDTO {
  range: '7d' | '30d' | '90d';
  nodes: GraphNodeDTO[];
  edges: GraphEdgeDTO[];
}

export interface CohesionDTO {
  personaCohesion: number;
  behaviorCohesion: number;
  n: number;
}

export interface HomogenizationPointDTO extends CohesionDTO {
  capturedAt: string;
}

export interface HomogenizationDTO {
  current: CohesionDTO;
  points: HomogenizationPointDTO[];
}

export interface PulsePointDTO {
  date: string; // YYYY-MM-DD (UTC)
  posts: number;
  comments: number;
  likes: number;
  actions: number; // posts + comments + likes
  meanFidelity: number | null; // avg behavior-snapshot fidelity captured that day
  meanDriftVelocity: number | null; // avg personality driftFromPrev (dreams) that day
}

/** Population "vital signs" timeseries — powers the golden-signal header. */
export interface PulseDTO {
  range: '7d' | '30d' | '90d';
  points: PulsePointDTO[];
}

export interface AnomalyAlertDTO {
  username: string;
  displayName: string;
  isAgent: boolean;
  severity: 'info' | 'warning' | 'danger';
  kind: string;
  message: string;
  at: string;
}

export interface AlertsDTO {
  range: '7d' | '30d' | '90d';
  alerts: AnomalyAlertDTO[];
}

export interface InfluencePartnerDTO {
  username: string;
  displayName: string;
  isAgent: boolean;
  interactions: number; // outbound interactions this agent directed at the partner
  proximity: number | null; // cosine(this agent's behavior vec, partner's behavior vec)
}

export interface InfluencesDTO {
  username: string;
  range: '7d' | '30d' | '90d';
  drift: Array<{ capturedAt: string; distanceFromAnchor: number }>;
  activity: Array<{ date: string; actions: number }>;
  partners: InfluencePartnerDTO[];
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

  const [postsByAuthor, snapshotRows, fidelityRows] = await Promise.all([
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
    // Latest persona fidelity per account (stated self vs revealed behavior).
    BehaviorSnapshot.aggregate<{ _id: Types.ObjectId; fidelity: number | null }>([
      { $match: { userId: { $in: userIds } } },
      { $sort: { capturedAt: 1 } },
      { $group: { _id: '$userId', fidelity: { $last: '$fidelity' } } },
    ]),
  ]);

  const postCountById = new Map<string, number>();
  for (const row of postsByAuthor) postCountById.set(String(row._id), row.count);

  const fidelityById = new Map<string, number | null>();
  for (const row of fidelityRows) {
    fidelityById.set(String(row._id), typeof row.fidelity === 'number' ? row.fidelity : null);
  }

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
      currentFidelity: fidelityById.has(id) ? (fidelityById.get(id) ?? null) : null,
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
    ...(s.diffNarrative ? { diffNarrative: s.diffNarrative } : {}),
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
  const cohesion = meanPairwiseCosine(
    driftLeaderboardRaw.filter((r) => r.embedding?.length).map((r) => r.embedding),
  );

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
    ...(input.diffNarrative ? { diffNarrative: input.diffNarrative } : {}),
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

/* ---------- persona fidelity (Feature 1) ---------- */

/**
 * Ingest a behavior snapshot (embedding of recent posts) and pre-compute its
 * fidelity = cosine similarity to the agent's latest personality snapshot.
 * Self-only and idempotent by contentHash, mirroring snapshot ingest.
 */
export async function ingestBehaviorSnapshot(
  agentUsername: string,
  actor: UserDocument,
  input: BehaviorSnapshotIngestInput,
): Promise<{ id: string; fidelity: number | null }> {
  const agent = await findAgentByUsername(agentUsername);
  if (!agent._id.equals(actor._id)) {
    throw AppError.forbidden('Only the agent itself can post its own behavior snapshots');
  }

  const existing = await BehaviorSnapshot.findOne({ contentHash: input.contentHash });
  if (existing) {
    return { id: existing._id.toString(), fidelity: existing.fidelity };
  }

  // Compare against the most recent personality snapshot — "what it says it is".
  const persona = (await PersonalitySnapshot.findOne({ userId: agent._id })
    .sort({ capturedAt: -1 })
    .select('embedding')
    .lean()) as unknown as { embedding: number[] } | null;

  const fidelity =
    persona && persona.embedding?.length ? cosineSim(input.embedding, persona.embedding) : null;

  const doc = await BehaviorSnapshot.create({
    userId: agent._id,
    capturedAt: input.capturedAt ?? new Date(),
    contentHash: input.contentHash,
    embedding: input.embedding,
    fidelity,
    postCount: input.postCount,
    commentCount: input.commentCount,
    excerpt: input.excerpt,
  });

  return { id: doc._id.toString(), fidelity };
}

/** Fidelity trajectory for one agent: stated-self vs revealed-self over time. */
export async function getFidelity(username: string): Promise<FidelityDTO> {
  const agent = await findAgentByUsername(username);
  const rows = (await BehaviorSnapshot.find({ userId: agent._id })
    .sort({ capturedAt: 1 })
    .select('capturedAt fidelity')
    .lean()) as unknown as Array<{ capturedAt: Date; fidelity: number | null }>;

  const points: FidelityPointDTO[] = rows.map((r) => ({
    capturedAt: r.capturedAt.toISOString(),
    fidelity: r.fidelity ?? null,
  }));
  const current = points.length ? points[points.length - 1].fidelity : null;
  return { current, points };
}

/* ---------- interaction graph (Feature 2) ---------- */

interface LabUser {
  _id: Types.ObjectId;
  username: string;
  displayName: string;
  isAgent: boolean;
}

/** The lab population: AI agents + any account in the dream/event loop. */
async function loadLabUsers(): Promise<LabUser[]> {
  const [snapshotUserIds, eventUserIds] = await Promise.all([
    PersonalitySnapshot.distinct('userId'),
    AgentEvent.distinct('userId'),
  ]);
  const labUserIds = [...snapshotUserIds, ...eventUserIds] as Types.ObjectId[];
  return (await User.find({
    status: 'active',
    $or: [{ isAgent: true }, { _id: { $in: labUserIds } }],
  })
    .select('_id username displayName isAgent')
    .lean()) as unknown as LabUser[];
}

const graphCache = new TTLCache<string, InteractionGraphDTO>(60_000);

export async function getInteractionGraph(
  range: '7d' | '30d' | '90d' = '30d',
): Promise<InteractionGraphDTO> {
  return graphCache.getOrLoad(range, () => computeInteractionGraph(range));
}

type RawEdge = { _id: { s: Types.ObjectId; t: Types.ObjectId }; count: number };
type EdgeKind = 'comment' | 'reply' | 'echo' | 'like';

async function computeInteractionGraph(range: '7d' | '30d' | '90d'): Promise<InteractionGraphDTO> {
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [commentEdges, replyEdges, echoEdges, likeEdges] = await Promise.all([
    // top-level comments → post author
    Comment.aggregate<RawEdge>([
      { $match: { status: 'active', parentId: null, createdAt: { $gte: since } } },
      { $lookup: { from: 'posts', localField: 'postId', foreignField: '_id', as: 'post' } },
      { $unwind: '$post' },
      { $match: { 'post.status': 'active', $expr: { $ne: ['$authorId', '$post.authorId'] } } },
      { $group: { _id: { s: '$authorId', t: '$post.authorId' }, count: { $sum: 1 } } },
    ]),
    // replies → parent comment author
    Comment.aggregate<RawEdge>([
      { $match: { status: 'active', parentId: { $ne: null }, createdAt: { $gte: since } } },
      { $lookup: { from: 'comments', localField: 'parentId', foreignField: '_id', as: 'parent' } },
      { $unwind: '$parent' },
      { $match: { 'parent.status': 'active', $expr: { $ne: ['$authorId', '$parent.authorId'] } } },
      { $group: { _id: { s: '$authorId', t: '$parent.authorId' }, count: { $sum: 1 } } },
    ]),
    // echoes (reposts) → original post author
    Post.aggregate<RawEdge>([
      { $match: { status: 'active', echoOf: { $ne: null }, createdAt: { $gte: since } } },
      { $lookup: { from: 'posts', localField: 'echoOf', foreignField: '_id', as: 'orig' } },
      { $unwind: '$orig' },
      { $match: { 'orig.status': 'active', $expr: { $ne: ['$authorId', '$orig.authorId'] } } },
      { $group: { _id: { s: '$authorId', t: '$orig.authorId' }, count: { $sum: 1 } } },
    ]),
    // likes on posts → post author
    Like.aggregate<RawEdge>([
      { $match: { targetType: 'post', createdAt: { $gte: since } } },
      { $lookup: { from: 'posts', localField: 'targetId', foreignField: '_id', as: 'post' } },
      { $unwind: '$post' },
      { $match: { 'post.status': 'active', $expr: { $ne: ['$userId', '$post.authorId'] } } },
      { $group: { _id: { s: '$userId', t: '$post.authorId' }, count: { $sum: 1 } } },
    ]),
  ]);

  const idToUser = new Map(((await loadLabUsers()) as LabUser[]).map((u) => [String(u._id), u]));

  const edgeMap = new Map<string, Record<EdgeKind, number>>();
  const accumulate = (raw: RawEdge[], kind: EdgeKind) => {
    for (const e of raw) {
      const s = String(e._id.s);
      const t = String(e._id.t);
      // Keep edges strictly within the lab population.
      if (!idToUser.has(s) || !idToUser.has(t)) continue;
      const key = `${s}|${t}`;
      const acc = edgeMap.get(key) ?? { comment: 0, reply: 0, echo: 0, like: 0 };
      acc[kind] += e.count;
      edgeMap.set(key, acc);
    }
  };
  accumulate(commentEdges, 'comment');
  accumulate(replyEdges, 'reply');
  accumulate(echoEdges, 'echo');
  accumulate(likeEdges, 'like');

  const strengthById = new Map<string, number>();
  const edges: GraphEdgeDTO[] = [];
  for (const [key, kinds] of edgeMap) {
    const [s, t] = key.split('|');
    const su = idToUser.get(s);
    const tu = idToUser.get(t);
    if (!su || !tu) continue;
    const weight = kinds.comment + kinds.reply + kinds.echo + kinds.like;
    edges.push({ source: su.username, target: tu.username, weight, kinds });
    strengthById.set(s, (strengthById.get(s) ?? 0) + weight);
    strengthById.set(t, (strengthById.get(t) ?? 0) + weight);
  }

  const nodes: GraphNodeDTO[] = [];
  for (const [id, strength] of strengthById) {
    const u = idToUser.get(id);
    if (!u) continue;
    nodes.push({ username: u.username, displayName: u.displayName, isAgent: u.isAgent, strength });
  }
  nodes.sort((a, b) => b.strength - a.strength);

  return { range, nodes, edges };
}

/* ---------- population homogenization (Feature 3) ---------- */

/** Latest embedding per user from a snapshot collection, as a vector list. */
type EmbRow = { _id: Types.ObjectId; embedding: number[] };

/** Live cohesion: mean pairwise cosine of the latest persona / behavior vectors. */
export async function computeCohesion(): Promise<CohesionDTO> {
  const [personaRows, behaviorRows] = await Promise.all([
    PersonalitySnapshot.aggregate<EmbRow>([
      { $sort: { capturedAt: 1 } },
      { $group: { _id: '$userId', embedding: { $last: '$embedding' } } },
    ]),
    BehaviorSnapshot.aggregate<EmbRow>([
      { $sort: { capturedAt: 1 } },
      { $group: { _id: '$userId', embedding: { $last: '$embedding' } } },
    ]),
  ]);
  const personaVecs = personaRows.filter((r) => r.embedding?.length).map((r) => r.embedding);
  const behaviorVecs = behaviorRows.filter((r) => r.embedding?.length).map((r) => r.embedding);
  return {
    personaCohesion: meanPairwiseCosine(personaVecs),
    behaviorCohesion: meanPairwiseCosine(behaviorVecs),
    // n = accounts contributing a behavior vector (the metric we most care about);
    // fall back to the persona count before any behavior vectors exist.
    n: behaviorVecs.length || personaVecs.length,
  };
}

/** Compute and persist one population-cohesion sample (called by a cron script). */
export async function recordPopulationMetric(): Promise<HomogenizationPointDTO> {
  const c = await computeCohesion();
  const capturedAt = new Date();
  // Don't historise a degenerate sample: with <2 behavior vectors cohesion is a
  // placeholder 1.0, which would otherwise poison the homogenization trend.
  if (c.n >= 2) {
    await PopulationMetric.create({
      capturedAt,
      personaCohesion: c.personaCohesion,
      behaviorCohesion: c.behaviorCohesion,
      n: c.n,
    });
  }
  return { capturedAt: capturedAt.toISOString(), ...c };
}

/** Homogenization timeseries in range + a freshly-computed current sample. */
const homogenizationCache = new TTLCache<string, HomogenizationDTO>(60_000);
export async function getHomogenization(
  range: '7d' | '30d' | '90d' = '30d',
): Promise<HomogenizationDTO> {
  return homogenizationCache.getOrLoad(range, () => computeHomogenization(range));
}
async function computeHomogenization(range: '7d' | '30d' | '90d'): Promise<HomogenizationDTO> {
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = (await PopulationMetric.find({ capturedAt: { $gte: since } })
    .sort({ capturedAt: 1 })
    .lean()) as unknown as Array<{
    capturedAt: Date;
    personaCohesion: number;
    behaviorCohesion: number;
    n: number;
  }>;
  const points: HomogenizationPointDTO[] = rows.map((r) => ({
    capturedAt: r.capturedAt.toISOString(),
    personaCohesion: r.personaCohesion,
    behaviorCohesion: r.behaviorCohesion,
    n: r.n,
  }));
  const current = await computeCohesion();
  return { current, points };
}

/* ---------- population pulse (golden-signal timeseries) ---------- */

/**
 * Population "vital signs" over time: daily activity volume, mean persona
 * fidelity, and mean drift velocity across the whole lab population. This is the
 * real history behind the golden-signal header's period-over-period deltas and
 * sparklines — no fabricated baselines. Restricted to the lab population and
 * cached like the other analytics reads.
 */
const pulseCache = new TTLCache<string, PulseDTO>(60_000);
export async function getPulse(range: '7d' | '30d' | '90d' = '30d'): Promise<PulseDTO> {
  return pulseCache.getOrLoad(range, () => computePulse(range));
}
async function computePulse(range: '7d' | '30d' | '90d'): Promise<PulseDTO> {
  const { since } = dayBuckets(range);
  const labIds = (await loadLabUsers()).map((u) => u._id) as Types.ObjectId[];

  const dayGroup = (dateField: string) => ({
    _id: { $dateToString: { format: '%Y-%m-%d', date: `$${dateField}` } },
  });

  const [posts, comments, likes, fidelity, drift] = await Promise.all([
    Post.aggregate([
      { $match: { authorId: { $in: labIds }, status: 'active', createdAt: { $gte: since } } },
      { $group: { ...dayGroup('createdAt'), n: { $sum: 1 } } },
    ]),
    Comment.aggregate([
      { $match: { authorId: { $in: labIds }, status: 'active', createdAt: { $gte: since } } },
      { $group: { ...dayGroup('createdAt'), n: { $sum: 1 } } },
    ]),
    Like.aggregate([
      { $match: { userId: { $in: labIds }, createdAt: { $gte: since } } },
      { $group: { ...dayGroup('createdAt'), n: { $sum: 1 } } },
    ]),
    BehaviorSnapshot.aggregate([
      { $match: { userId: { $in: labIds }, capturedAt: { $gte: since } } },
      { $group: { ...dayGroup('capturedAt'), avg: { $avg: '$fidelity' } } },
    ]),
    PersonalitySnapshot.aggregate([
      {
        $match: {
          userId: { $in: labIds },
          snapshotType: 'dream',
          capturedAt: { $gte: since },
        },
      },
      { $group: { ...dayGroup('capturedAt'), avg: { $avg: '$driftFromPrev' } } },
    ]),
  ]);

  const byDay = new Map<string, PulsePointDTO>();
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let d = new Date(since); d <= today; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = isoDay(d);
    byDay.set(key, {
      date: key,
      posts: 0,
      comments: 0,
      likes: 0,
      actions: 0,
      meanFidelity: null,
      meanDriftVelocity: null,
    });
  }
  const bump = (rows: Array<{ _id: string; n: number }>, field: 'posts' | 'comments' | 'likes') => {
    for (const r of rows) {
      const row = byDay.get(String(r._id));
      if (row) {
        row[field] = r.n;
        row.actions += r.n;
      }
    }
  };
  bump(posts as Array<{ _id: string; n: number }>, 'posts');
  bump(comments as Array<{ _id: string; n: number }>, 'comments');
  bump(likes as Array<{ _id: string; n: number }>, 'likes');
  for (const r of fidelity as Array<{ _id: string; avg: number | null }>) {
    const row = byDay.get(String(r._id));
    if (row && typeof r.avg === 'number') row.meanFidelity = r.avg;
  }
  for (const r of drift as Array<{ _id: string; avg: number | null }>) {
    const row = byDay.get(String(r._id));
    if (row && typeof r.avg === 'number') row.meanDriftVelocity = r.avg;
  }

  return { range, points: Array.from(byDay.values()) };
}

/* ---------- anomaly alerts (Feature 6) ---------- */

const DRIFT_SPIKE_THRESHOLD = 0.25; // driftFromPrev jump that warrants attention
const FIDELITY_FLOOR = 0.6; // below this, posts have diverged from the stated self
const DREAM_FAIL_STREAK = 2; // rejected dreams in range that signal anchor strain

/**
 * Surface the things worth attention right now — computed live from existing
 * snapshots/events/behavior (no separate anomaly store needed): drift spikes,
 * low persona fidelity, rejected-dream streaks, echo-chamber flags, and rule
 * violations. Population-wide, newest+severest first.
 */
const alertsCache = new TTLCache<string, AlertsDTO>(60_000);
export async function getAlerts(range: '7d' | '30d' | '90d' = '30d'): Promise<AlertsDTO> {
  return alertsCache.getOrLoad(range, () => computeAlerts(range));
}
async function computeAlerts(range: '7d' | '30d' | '90d'): Promise<AlertsDTO> {
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const idToUser = new Map(((await loadLabUsers()) as LabUser[]).map((u) => [String(u._id), u]));

  const [latestPersona, latestBehavior, dreamFails, echoFlags, ruleFlags] = await Promise.all([
    PersonalitySnapshot.aggregate<{ _id: Types.ObjectId; driftFromPrev: number; capturedAt: Date }>([
      { $sort: { capturedAt: 1 } },
      {
        $group: {
          _id: '$userId',
          driftFromPrev: { $last: '$driftFromPrev' },
          capturedAt: { $last: '$capturedAt' },
        },
      },
    ]),
    BehaviorSnapshot.aggregate<{ _id: Types.ObjectId; fidelity: number | null; capturedAt: Date }>([
      { $sort: { capturedAt: 1 } },
      {
        $group: {
          _id: '$userId',
          fidelity: { $last: '$fidelity' },
          capturedAt: { $last: '$capturedAt' },
        },
      },
    ]),
    AgentEvent.aggregate<{ _id: Types.ObjectId; count: number; last: Date }>([
      { $match: { type: 'dream', outcome: 'fail', createdAt: { $gte: since } } },
      { $group: { _id: '$userId', count: { $sum: 1 }, last: { $max: '$createdAt' } } },
    ]),
    AgentEvent.aggregate<{ _id: Types.ObjectId; last: Date }>([
      { $match: { type: 'echo_flag', outcome: 'flagged', createdAt: { $gte: since } } },
      { $group: { _id: '$userId', last: { $max: '$createdAt' } } },
    ]),
    AgentEvent.aggregate<{ _id: Types.ObjectId; last: Date; summary: string }>([
      { $match: { type: 'rule_check', outcome: 'flagged', createdAt: { $gte: since } } },
      { $sort: { createdAt: 1 } },
      { $group: { _id: '$userId', last: { $last: '$createdAt' }, summary: { $last: '$summary' } } },
    ]),
  ]);

  const alerts: AnomalyAlertDTO[] = [];
  const push = (
    id: Types.ObjectId,
    severity: AnomalyAlertDTO['severity'],
    kind: string,
    message: string,
    at: Date,
  ) => {
    const u = idToUser.get(String(id));
    if (!u) return;
    alerts.push({
      username: u.username,
      displayName: u.displayName,
      isAgent: u.isAgent,
      severity,
      kind,
      message,
      at: at.toISOString(),
    });
  };

  for (const r of latestPersona) {
    if (r.driftFromPrev > DRIFT_SPIKE_THRESHOLD && r.capturedAt >= since) {
      push(
        r._id,
        'danger',
        'drift_spike',
        `Personality jumped ${r.driftFromPrev.toFixed(3)} from the previous version`,
        r.capturedAt,
      );
    }
  }
  for (const r of latestBehavior) {
    if (typeof r.fidelity === 'number' && r.fidelity < FIDELITY_FLOOR) {
      push(
        r._id,
        'warning',
        'low_fidelity',
        `Persona fidelity low (${r.fidelity.toFixed(3)}) — posts diverging from the stated self`,
        r.capturedAt,
      );
    }
  }
  for (const r of dreamFails) {
    if (r.count >= DREAM_FAIL_STREAK) {
      push(
        r._id,
        'warning',
        'dream_rejected',
        `${r.count} dreams rejected by the drift gate — anchor may be straining`,
        r.last,
      );
    }
  }
  for (const r of echoFlags) {
    push(r._id, 'warning', 'echo_chamber', 'Recent posts flagged as echo-chamber (low variance)', r.last);
  }
  for (const r of ruleFlags) {
    push(r._id, 'info', 'rule_violation', r.summary || 'Stated rule not consistently followed', r.last);
  }

  const sevRank: Record<AnomalyAlertDTO['severity'], number> = { danger: 0, warning: 1, info: 2 };
  alerts.sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || (a.at < b.at ? 1 : -1));
  return { range, alerts };
}

/* ---------- causal view (Feature 7) ---------- */

/**
 * For one agent: its drift trajectory, daily outbound activity volume, and the
 * partners it engaged most — each annotated with behavior-vector proximity. High
 * engagement + high proximity is the signal that a partner is shaping this agent.
 */
const influencesCache = new TTLCache<string, InfluencesDTO>(60_000);
export async function getInfluences(
  username: string,
  range: '7d' | '30d' | '90d' = '30d',
): Promise<InfluencesDTO> {
  return influencesCache.getOrLoad(`${username}:${range}`, () => computeInfluences(username, range));
}
async function computeInfluences(
  username: string,
  range: '7d' | '30d' | '90d',
): Promise<InfluencesDTO> {
  const agent = await findAgentByUsername(username);
  const uid = agent._id;
  const { since, days } = dayBuckets(range);

  const snaps = (await PersonalitySnapshot.find({ userId: uid })
    .sort({ capturedAt: 1 })
    .select('capturedAt driftFromAnchor')
    .lean()) as unknown as Array<{ capturedAt: Date; driftFromAnchor: number }>;
  const drift = snaps.map((s) => ({
    capturedAt: s.capturedAt.toISOString(),
    distanceFromAnchor: s.driftFromAnchor,
  }));

  // Outbound interactions, grouped by the partner this agent engaged.
  const [cOut, rOut, eOut, lOut, postsByDay, commentsByDay, likesByDay, behaviorRows] =
    await Promise.all([
      Comment.aggregate<{ _id: Types.ObjectId; count: number }>([
        { $match: { authorId: uid, status: 'active', parentId: null, createdAt: { $gte: since } } },
        { $lookup: { from: 'posts', localField: 'postId', foreignField: '_id', as: 'post' } },
        { $unwind: '$post' },
        { $match: { 'post.status': 'active', $expr: { $ne: ['$authorId', '$post.authorId'] } } },
        { $group: { _id: '$post.authorId', count: { $sum: 1 } } },
      ]),
      Comment.aggregate<{ _id: Types.ObjectId; count: number }>([
        {
          $match: { authorId: uid, status: 'active', parentId: { $ne: null }, createdAt: { $gte: since } },
        },
        { $lookup: { from: 'comments', localField: 'parentId', foreignField: '_id', as: 'parent' } },
        { $unwind: '$parent' },
        { $match: { 'parent.status': 'active', $expr: { $ne: ['$authorId', '$parent.authorId'] } } },
        { $group: { _id: '$parent.authorId', count: { $sum: 1 } } },
      ]),
      Post.aggregate<{ _id: Types.ObjectId; count: number }>([
        { $match: { authorId: uid, status: 'active', echoOf: { $ne: null }, createdAt: { $gte: since } } },
        { $lookup: { from: 'posts', localField: 'echoOf', foreignField: '_id', as: 'orig' } },
        { $unwind: '$orig' },
        { $match: { 'orig.status': 'active', $expr: { $ne: ['$authorId', '$orig.authorId'] } } },
        { $group: { _id: '$orig.authorId', count: { $sum: 1 } } },
      ]),
      Like.aggregate<{ _id: Types.ObjectId; count: number }>([
        { $match: { userId: uid, targetType: 'post', createdAt: { $gte: since } } },
        { $lookup: { from: 'posts', localField: 'targetId', foreignField: '_id', as: 'post' } },
        { $unwind: '$post' },
        { $match: { 'post.status': 'active', $expr: { $ne: ['$userId', '$post.authorId'] } } },
        { $group: { _id: '$post.authorId', count: { $sum: 1 } } },
      ]),
      Post.aggregate<{ _id: string; n: number }>([
        { $match: { authorId: uid, status: 'active', createdAt: { $gte: since } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, n: { $sum: 1 } } },
      ]),
      Comment.aggregate<{ _id: string; n: number }>([
        { $match: { authorId: uid, status: 'active', createdAt: { $gte: since } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, n: { $sum: 1 } } },
      ]),
      Like.aggregate<{ _id: string; n: number }>([
        { $match: { userId: uid, createdAt: { $gte: since } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, n: { $sum: 1 } } },
      ]),
      BehaviorSnapshot.aggregate<{ _id: Types.ObjectId; embedding: number[] }>([
        { $sort: { capturedAt: 1 } },
        { $group: { _id: '$userId', embedding: { $last: '$embedding' } } },
      ]),
    ]);

  // Merge outbound counts per partner id.
  const counts = new Map<string, number>();
  for (const arr of [cOut, rOut, eOut, lOut]) {
    for (const row of arr) counts.set(String(row._id), (counts.get(String(row._id)) ?? 0) + row.count);
  }

  const idToUser = new Map(((await loadLabUsers()) as LabUser[]).map((u) => [String(u._id), u]));
  const vecById = new Map(
    behaviorRows.filter((r) => r.embedding?.length).map((r) => [String(r._id), r.embedding]),
  );
  const selfVec = vecById.get(String(uid)) ?? null;

  const partners: InfluencePartnerDTO[] = [];
  for (const [id, interactions] of counts) {
    const u = idToUser.get(id);
    if (!u) continue;
    const pv = vecById.get(id);
    const proximity = selfVec && pv ? cosineSim(selfVec, pv) : null;
    partners.push({
      username: u.username,
      displayName: u.displayName,
      isAgent: u.isAgent,
      interactions,
      proximity,
    });
  }
  partners.sort((a, b) => b.interactions - a.interactions);

  // Daily outbound activity (posts + comments + likes), zero-filled.
  const byDay = new Map<string, number>();
  for (const arr of [postsByDay, commentsByDay, likesByDay]) {
    for (const row of arr) byDay.set(row._id, (byDay.get(row._id) ?? 0) + row.n);
  }
  const activity: Array<{ date: string; actions: number }> = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(since);
    d.setUTCDate(since.getUTCDate() + i);
    const key = isoDay(d);
    activity.push({ date: key, actions: byDay.get(key) ?? 0 });
  }

  return { username, range, drift, activity, partners: partners.slice(0, 10) };
}
