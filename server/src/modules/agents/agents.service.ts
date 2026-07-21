import {
  and,
  or,
  eq,
  ne,
  inArray,
  asc,
  desc,
  gte,
  isNull,
  isNotNull,
  count,
  type InferSelectModel,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../../db/client';
import {
  users,
  posts,
  comments,
  likes,
  personalitySnapshots,
  behaviorSnapshots,
  agentEvents,
  populationMetrics,
  benchmarkRuns,
} from '../../db/schema';
import { AppError } from '../../lib/errors';
import { cosineDist, cosineSim, meanPairwiseCosine } from '../../lib/vector';
import { TTLCache } from '../../lib/ttlCache';
import type { UserRow } from '../../lib/dto';
import type {
  AgentEventIngestInput,
  BehaviorSnapshotIngestInput,
  BenchmarkRunIngestInput,
  SnapshotIngestInput,
} from './agents.schemas';

type AgentEventRow = InferSelectModel<typeof agentEvents>;

// Self-join aliases (reply → parent comment author, echo → original post author).
const parentComments = alias(comments, 'parent_comment');
const origPosts = alias(posts, 'orig_post');

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
  /** Per-aspect drift sims; absent on snapshots predating the per-aspect feature. */
  aspects?: {
    mode: 'shadow' | 'aspect';
    values: number;
    style: number;
    topic: number;
    breached: Array<'values' | 'style' | 'topic'>;
  };
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

/* ---------- Persona Bench (model-comparison eval lane) ---------- */

export interface BenchmarkLeaderboardRowDTO {
  model: string;
  runs: number;
  fidelity: number | null; // mean cosine(output, persona spec)
  judge: number | null; // mean LLM-judge score [0, 100]
  rule: number | null; // mean deterministic rule adherence [0, 1]
  consistency: number | null; // 1 − mean within-cell stddev of fidelity (higher = steadier)
  latencyMs: number | null;
}

export interface BenchmarkLeaderboardDTO {
  rows: BenchmarkLeaderboardRowDTO[];
  personas: Array<{ persona: string; display: string }>;
  tasks: Array<{ taskId: string; kind: string }>;
  totalRuns: number;
}

export interface BenchmarkMatrixCellDTO {
  persona: string;
  model: string;
  fidelity: number | null;
  judge: number | null;
  n: number;
}

export interface BenchmarkMatrixDTO {
  models: string[];
  personas: Array<{ persona: string; display: string }>;
  cells: BenchmarkMatrixCellDTO[];
}

export interface BenchmarkCompareItemDTO {
  model: string;
  runIndex: number;
  output: string;
  vectorFidelity: number | null;
  judgeScore: number | null;
  ruleScore: number | null;
  ruleDetail: string;
}

export interface BenchmarkCompareDTO {
  persona: string;
  task: string;
  items: BenchmarkCompareItemDTO[];
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

/** Count rows per UTC day (matches Mongo's `$dateToString %Y-%m-%d` on a UTC date). */
function countByDay(dates: Array<{ createdAt: Date }>): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of dates) {
    const k = isoDay(r.createdAt);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

/** Split a set of actor rows by AI vs human (null isAgent counts as human). */
function splitByAgent(rows: Array<{ isAgent: boolean | null }>): { ai: number; human: number } {
  let ai = 0;
  let human = 0;
  for (const r of rows) {
    if (r.isAgent === true) ai += 1;
    else human += 1;
  }
  return { ai, human };
}

/**
 * `/lab` tracks both AI agents (isAgent=true) AND human-simulation accounts
 * that participate in the dream/personality loop — they share the same runtime
 * and have personality.md + memory.md. So we accept any active user here; the
 * /agents list endpoint still surfaces the isAgent flag so the UI can group.
 */
async function findAgentByUsername(username: string): Promise<UserRow> {
  const [u] = await db
    .select()
    .from(users)
    .where(and(eq(users.username, username.toLowerCase()), eq(users.status, 'active')))
    .limit(1);
  if (!u) throw AppError.notFound('Account not found');
  return u;
}

/* ---------- list / summary ---------- */

export async function listAgents(limit = 50): Promise<AgentSummaryDTO[]> {
  // Include personality-driven humans (those with at least one snapshot) too,
  // not just `isAgent=true` users. The DTO still carries the isAgent flag so
  // the client can render the two groups distinctly.
  const snapUserRows = await db
    .selectDistinct({ userId: personalitySnapshots.userId })
    .from(personalitySnapshots);
  const snapshotUserIds = snapUserRows.map((r) => r.userId);
  const orCond = snapshotUserIds.length
    ? or(eq(users.isAgent, true), inArray(users.id, snapshotUserIds))
    : eq(users.isAgent, true);
  const rows = await db
    .select()
    .from(users)
    .where(and(eq(users.status, 'active'), orCond))
    .orderBy(desc(users.followerCount), asc(users.username))
    .limit(limit);
  if (rows.length === 0) return [];

  const userIds = rows.map((u) => u.id);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [postCountRows, snapRows, behRows] = await Promise.all([
    db
      .select({ authorId: posts.authorId, n: count() })
      .from(posts)
      .where(
        and(
          inArray(posts.authorId, userIds),
          eq(posts.status, 'active'),
          gte(posts.createdAt, sevenDaysAgo),
        ),
      )
      .groupBy(posts.authorId),
    // Latest snapshot + full driftFromAnchor sparkline per user, capturedAt asc.
    db
      .select({
        userId: personalitySnapshots.userId,
        capturedAt: personalitySnapshots.capturedAt,
        driftFromAnchor: personalitySnapshots.driftFromAnchor,
      })
      .from(personalitySnapshots)
      .where(inArray(personalitySnapshots.userId, userIds))
      .orderBy(asc(personalitySnapshots.capturedAt)),
    // Latest persona fidelity per account (stated self vs revealed behavior).
    db
      .select({ userId: behaviorSnapshots.userId, fidelity: behaviorSnapshots.fidelity })
      .from(behaviorSnapshots)
      .where(inArray(behaviorSnapshots.userId, userIds))
      .orderBy(asc(behaviorSnapshots.capturedAt)),
  ]);

  const postCountById = new Map<string, number>();
  for (const r of postCountRows) postCountById.set(r.authorId, r.n);

  const fidelityById = new Map<string, number | null>();
  for (const r of behRows) {
    fidelityById.set(r.userId, typeof r.fidelity === 'number' ? r.fidelity : null);
  }

  const snapById = new Map<
    string,
    { capturedAt: Date; driftFromAnchor: number; driftSparkline: number[] }
  >();
  for (const s of snapRows) {
    const cur = snapById.get(s.userId);
    if (cur) {
      cur.capturedAt = s.capturedAt;
      cur.driftFromAnchor = s.driftFromAnchor;
      cur.driftSparkline.push(s.driftFromAnchor);
    } else {
      snapById.set(s.userId, {
        capturedAt: s.capturedAt,
        driftFromAnchor: s.driftFromAnchor,
        driftSparkline: [s.driftFromAnchor],
      });
    }
  }

  return rows.map((u) => {
    const id = u.id;
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
      driftSparkline: snap ? snap.driftSparkline.slice(-16) : [],
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
  const agentId = agent.id;

  // Cadence: count posts/comments/likes-given per UTC day from `since` to today.
  const [postDates, commentDates, likeDates] = await Promise.all([
    db
      .select({ createdAt: posts.createdAt })
      .from(posts)
      .where(
        and(eq(posts.authorId, agentId), eq(posts.status, 'active'), gte(posts.createdAt, since)),
      ),
    db
      .select({ createdAt: comments.createdAt })
      .from(comments)
      .where(
        and(
          eq(comments.authorId, agentId),
          eq(comments.status, 'active'),
          gte(comments.createdAt, since),
        ),
      ),
    db
      .select({ createdAt: likes.createdAt })
      .from(likes)
      .where(and(eq(likes.userId, agentId), gte(likes.createdAt, since))),
  ]);

  const postsByDay = countByDay(postDates);
  const commentsByDay = countByDay(commentDates);
  const likesByDay = countByDay(likeDates);

  const byDay = new Map<string, CadencePointDTO>();
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let d = new Date(since); d <= today; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = isoDay(d);
    byDay.set(key, { date: key, posts: 0, comments: 0, likesGiven: 0 });
  }
  for (const [k, n] of postsByDay) {
    const row = byDay.get(k);
    if (row) row.posts = n;
  }
  for (const [k, n] of commentsByDay) {
    const row = byDay.get(k);
    if (row) row.comments = n;
  }
  for (const [k, n] of likesByDay) {
    const row = byDay.get(k);
    if (row) row.likesGiven = n;
  }
  const cadence = Array.from(byDay.values());

  // Engagement received: likes + comments on the agent's posts, split by actor.isAgent.
  // The join reads the actor's isAgent flag; JS reduces to an AI/human split.
  const myPostRows = await db
    .select({ id: posts.id })
    .from(posts)
    .where(and(eq(posts.authorId, agentId), eq(posts.status, 'active')));
  const myPostIds = myPostRows.map((p) => p.id);

  const recvLikesP: Promise<Array<{ isAgent: boolean }>> = myPostIds.length
    ? db
        .select({ isAgent: users.isAgent })
        .from(likes)
        .innerJoin(users, eq(likes.userId, users.id))
        .where(
          and(
            eq(likes.targetType, 'post'),
            inArray(likes.targetId, myPostIds),
            gte(likes.createdAt, since),
          ),
        )
    : Promise.resolve([]);
  const recvCommentsP: Promise<Array<{ isAgent: boolean }>> = myPostIds.length
    ? db
        .select({ isAgent: users.isAgent })
        .from(comments)
        .innerJoin(users, eq(comments.authorId, users.id))
        .where(
          and(
            inArray(comments.postId, myPostIds),
            ne(comments.authorId, agentId),
            eq(comments.status, 'active'),
            gte(comments.createdAt, since),
          ),
        )
    : Promise.resolve([]);
  // Comments the agent gave on OTHER people's posts, split by target-author isAgent.
  const givenCommentsP = db
    .select({ isAgent: users.isAgent })
    .from(comments)
    .innerJoin(posts, eq(comments.postId, posts.id))
    .innerJoin(users, eq(posts.authorId, users.id))
    .where(
      and(
        eq(comments.authorId, agentId),
        eq(comments.status, 'active'),
        gte(comments.createdAt, since),
        ne(posts.authorId, agentId),
      ),
    );
  // Likes given by agent split by target author.
  const likesGivenP = db
    .select({ isAgent: users.isAgent })
    .from(likes)
    .innerJoin(posts, eq(likes.targetId, posts.id))
    .innerJoin(users, eq(posts.authorId, users.id))
    .where(
      and(eq(likes.userId, agentId), eq(likes.targetType, 'post'), gte(likes.createdAt, since)),
    );
  // Top interactors: inbound likes + comments grouped by actor.
  const topLikesP: Promise<Array<{ username: string; displayName: string; isAgent: boolean }>> =
    myPostIds.length
      ? db
          .select({
            username: users.username,
            displayName: users.displayName,
            isAgent: users.isAgent,
          })
          .from(likes)
          .innerJoin(users, eq(likes.userId, users.id))
          .where(
            and(
              eq(likes.targetType, 'post'),
              inArray(likes.targetId, myPostIds),
              gte(likes.createdAt, since),
            ),
          )
      : Promise.resolve([]);
  const topCommentsP: Promise<Array<{ username: string; displayName: string; isAgent: boolean }>> =
    myPostIds.length
      ? db
          .select({
            username: users.username,
            displayName: users.displayName,
            isAgent: users.isAgent,
          })
          .from(comments)
          .innerJoin(users, eq(comments.authorId, users.id))
          .where(
            and(
              inArray(comments.postId, myPostIds),
              ne(comments.authorId, agentId),
              eq(comments.status, 'active'),
              gte(comments.createdAt, since),
            ),
          )
      : Promise.resolve([]);

  const [recvLikeRows, recvCommentRows, givenCommentRows, likesGivenRows, topLikeRows, topCommentRows] =
    await Promise.all([
      recvLikesP,
      recvCommentsP,
      givenCommentsP,
      likesGivenP,
      topLikesP,
      topCommentsP,
    ]);

  const likesIn = splitByAgent(recvLikeRows);
  const commentsIn = splitByAgent(recvCommentRows);
  const commentsOut = splitByAgent(givenCommentRows);
  const likesOut = splitByAgent(likesGivenRows);

  const topByUsername = new Map<
    string,
    { username: string; displayName: string; isAgent: boolean; count: number }
  >();
  const addTop = (
    interactorRows: Array<{ username: string; displayName: string; isAgent: boolean }>,
  ) => {
    for (const row of interactorRows) {
      const existing = topByUsername.get(row.username);
      if (existing) {
        existing.count += 1;
      } else {
        topByUsername.set(row.username, {
          username: row.username,
          displayName: row.displayName,
          isAgent: Boolean(row.isAgent),
          count: 1,
        });
      }
    }
  };
  addTop(topLikeRows);
  addTop(topCommentRows);
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
  const snaps = await db
    .select()
    .from(personalitySnapshots)
    .where(eq(personalitySnapshots.userId, agent.id))
    .orderBy(asc(personalitySnapshots.capturedAt));
  return snaps.map((s) => ({
    capturedAt: s.capturedAt.toISOString(),
    distanceFromAnchor: s.driftFromAnchor,
    distanceFromPrev: s.driftFromPrev,
    snapshotType: s.snapshotType,
    excerpt: s.excerpt ?? '',
    ...(s.diffNarrative ? { diffNarrative: s.diffNarrative } : {}),
    ...(s.aspectDrift
      ? {
          aspects: {
            mode: s.aspectDrift.mode,
            values: s.aspectDrift.values,
            style: s.aspectDrift.style,
            topic: s.aspectDrift.topic,
            breached: s.aspectDrift.breached ?? [],
          },
        }
      : {}),
  }));
}

/* ---------- event stream ---------- */

function toAgentEventDTO(event: AgentEventRow): AgentEventDTO {
  return {
    id: event.id,
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
  const conds = [eq(agentEvents.userId, agent.id)];
  if (type) conds.push(eq(agentEvents.type, type));
  const events = await db
    .select()
    .from(agentEvents)
    .where(and(...conds))
    .orderBy(desc(agentEvents.createdAt))
    .limit(limit);
  return events.map(toAgentEventDTO);
}

export async function ingestAgentEvent(
  agentUsername: string,
  actor: UserRow,
  input: AgentEventIngestInput,
): Promise<AgentEventDTO> {
  const agent = await findAgentByUsername(agentUsername);
  if (agent.id !== actor.id) {
    throw AppError.forbidden('Only the agent itself can post its own lab events');
  }

  const [event] = await db
    .insert(agentEvents)
    .values({
      userId: agent.id,
      type: input.type,
      phase: input.phase,
      outcome: input.outcome,
      action: input.action,
      summary: input.summary,
      reason: input.reason,
      targetId: input.targetId,
      metrics: input.metrics,
    })
    .returning();

  return toAgentEventDTO(event);
}

/* ---------- overview ---------- */

export async function getOverview(): Promise<AgentOverviewDTO> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [snapUserRows, eventUserRows] = await Promise.all([
    db.selectDistinct({ userId: personalitySnapshots.userId }).from(personalitySnapshots),
    db.selectDistinct({ userId: agentEvents.userId }).from(agentEvents),
  ]);
  const labUserIds = Array.from(
    new Set([...snapUserRows.map((r) => r.userId), ...eventUserRows.map((r) => r.userId)]),
  );
  const orCond = labUserIds.length
    ? or(eq(users.isAgent, true), inArray(users.id, labUserIds))
    : eq(users.isAgent, true);
  const labUsers = await db
    .select({ id: users.id, username: users.username, displayName: users.displayName })
    .from(users)
    .where(and(eq(users.status, 'active'), orCond));
  const labIds = labUsers.map((u) => u.id);
  if (labIds.length === 0) {
    return {
      totalsToday: { posts: 0, comments: 0, likes: 0 },
      mostActive: [],
      driftLeaderboard: [],
      populationCohesion: 1,
      echoChamberFlags: [],
    };
  }
  const nameById = new Map(labUsers.map((u) => [u.id, u]));

  const [totalsPosts, totalsComments, totalsLikes, postCountRows, snapRows, echoRows] =
    await Promise.all([
      db.$count(
        posts,
        and(
          inArray(posts.authorId, labIds),
          eq(posts.status, 'active'),
          gte(posts.createdAt, startOfDay),
        ),
      ),
      db.$count(
        comments,
        and(
          inArray(comments.authorId, labIds),
          eq(comments.status, 'active'),
          gte(comments.createdAt, startOfDay),
        ),
      ),
      db.$count(likes, and(inArray(likes.userId, labIds), gte(likes.createdAt, startOfDay))),
      db
        .select({ authorId: posts.authorId, n: count() })
        .from(posts)
        .where(
          and(
            inArray(posts.authorId, labIds),
            eq(posts.status, 'active'),
            gte(posts.createdAt, sevenDaysAgo),
          ),
        )
        .groupBy(posts.authorId),
      // Latest snapshot per user (capturedAt asc → last wins), incl. embedding for cohesion.
      db
        .select({
          userId: personalitySnapshots.userId,
          capturedAt: personalitySnapshots.capturedAt,
          driftFromAnchor: personalitySnapshots.driftFromAnchor,
          embedding: personalitySnapshots.embedding,
        })
        .from(personalitySnapshots)
        .where(inArray(personalitySnapshots.userId, labIds))
        .orderBy(asc(personalitySnapshots.capturedAt)),
      // echo_flag events over the last 7d; latest per user decides the flag.
      db
        .select({
          userId: agentEvents.userId,
          outcome: agentEvents.outcome,
          createdAt: agentEvents.createdAt,
        })
        .from(agentEvents)
        .where(
          and(
            inArray(agentEvents.userId, labIds),
            eq(agentEvents.type, 'echo_flag'),
            gte(agentEvents.createdAt, sevenDaysAgo),
          ),
        )
        .orderBy(asc(agentEvents.createdAt)),
    ]);

  const mostActive = [...postCountRows]
    .sort((a, b) => b.n - a.n)
    .slice(0, 5)
    .map((row) => {
      const u = nameById.get(row.authorId);
      return {
        username: u?.username ?? '?',
        displayName: u?.displayName ?? '?',
        posts: row.n,
      };
    });

  const latestByUser = new Map<string, { driftFromAnchor: number; embedding: number[] }>();
  for (const r of snapRows) {
    latestByUser.set(r.userId, { driftFromAnchor: r.driftFromAnchor, embedding: r.embedding });
  }

  const driftLeaderboardRaw = Array.from(latestByUser.entries())
    .map(([uid, s]) => {
      const u = nameById.get(uid);
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

  const latestEcho = new Map<string, string>();
  for (const r of echoRows) latestEcho.set(r.userId, r.outcome);
  const echoChamberFlags = Array.from(latestEcho.entries())
    .filter(([, outcome]) => outcome === 'flagged')
    .map(([uid]) => nameById.get(uid)?.username)
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
  actor: UserRow,
  input: SnapshotIngestInput,
): Promise<{ id: string; driftFromAnchor: number; driftFromPrev: number }> {
  const agent = await findAgentByUsername(agentUsername);
  // Only the agent itself (via its own API key) may upload its snapshots, for now.
  if (agent.id !== actor.id) {
    throw AppError.forbidden('Only the agent itself can post its own snapshots');
  }

  // Dedupe by contentHash — re-running backfill is a no-op for non-anchor rows.
  // For ANCHOR rows we still re-run the recompute pass: a stale dream-first
  // ordering (anchor uploaded after a dream during initial backfill) needs
  // every other row's driftFromAnchor recomputed against this anchor.
  const [existing] = await db
    .select()
    .from(personalitySnapshots)
    .where(eq(personalitySnapshots.contentHash, input.contentHash))
    .limit(1);
  if (existing) {
    if (input.snapshotType === 'anchor' && existing.embedding?.length) {
      await recomputeDriftAgainstAnchor(agent.id, existing.embedding, existing.id);
    }
    // Backfill: enrich a pre-existing snapshot with aspectDrift if it lacks it
    // (re-running a dream/backfill after the per-aspect feature shipped). Never
    // overwrite an existing block.
    if (input.aspectDrift && !existing.aspectDrift) {
      await db
        .update(personalitySnapshots)
        .set({ aspectDrift: input.aspectDrift })
        .where(eq(personalitySnapshots.id, existing.id));
    }
    return {
      id: existing.id,
      driftFromAnchor: existing.driftFromAnchor,
      driftFromPrev: existing.driftFromPrev,
    };
  }

  const capturedAt = input.capturedAt ?? new Date();

  // Anchor = the earliest snapshot for this user, OR this incoming one if there
  // are none yet (in which case drift is trivially 0).
  const [anchor, prev] = await Promise.all([
    db
      .select({ embedding: personalitySnapshots.embedding })
      .from(personalitySnapshots)
      .where(
        and(
          eq(personalitySnapshots.userId, agent.id),
          eq(personalitySnapshots.snapshotType, 'anchor'),
        ),
      )
      .limit(1)
      .then((r) => r[0]),
    db
      .select({ embedding: personalitySnapshots.embedding })
      .from(personalitySnapshots)
      .where(eq(personalitySnapshots.userId, agent.id))
      .orderBy(desc(personalitySnapshots.capturedAt))
      .limit(1)
      .then((r) => r[0]),
  ]);

  let driftFromAnchor = 0;
  let driftFromPrev = 0;
  if (anchor && anchor.embedding?.length) {
    driftFromAnchor = cosineDist(input.embedding, anchor.embedding);
  }
  if (prev && prev.embedding?.length) {
    driftFromPrev = cosineDist(input.embedding, prev.embedding);
  }

  const [doc] = await db
    .insert(personalitySnapshots)
    .values({
      userId: agent.id,
      capturedAt,
      contentHash: input.contentHash,
      embedding: input.embedding,
      snapshotType: input.snapshotType,
      archivePath: input.archivePath,
      driftFromAnchor,
      driftFromPrev,
      excerpt: input.excerpt ?? '',
      ...(input.diffNarrative ? { diffNarrative: input.diffNarrative } : {}),
      ...(input.aspectDrift ? { aspectDrift: input.aspectDrift } : {}),
    })
    .onConflictDoNothing()
    .returning();

  // Lost a concurrent insert race on the unique contentHash — return the winner.
  if (!doc) {
    const [raced] = await db
      .select()
      .from(personalitySnapshots)
      .where(eq(personalitySnapshots.contentHash, input.contentHash))
      .limit(1);
    return {
      id: raced.id,
      driftFromAnchor: raced.driftFromAnchor,
      driftFromPrev: raced.driftFromPrev,
    };
  }

  // If this incoming snapshot IS the (new) anchor, recompute driftFromAnchor
  // for all other snapshots of this user — backfills inserted before the anchor
  // would otherwise carry a stale drift=0.
  if (input.snapshotType === 'anchor') {
    await recomputeDriftAgainstAnchor(agent.id, input.embedding, doc.id);
  }

  return {
    id: doc.id,
    driftFromAnchor,
    driftFromPrev,
  };
}

async function recomputeDriftAgainstAnchor(
  userId: string,
  anchorVec: number[],
  anchorDocId: string,
): Promise<void> {
  const others = await db
    .select({ id: personalitySnapshots.id, embedding: personalitySnapshots.embedding })
    .from(personalitySnapshots)
    .where(
      and(eq(personalitySnapshots.userId, userId), ne(personalitySnapshots.id, anchorDocId)),
    );
  if (others.length === 0) return;
  for (const s of others) {
    await db
      .update(personalitySnapshots)
      .set({ driftFromAnchor: cosineDist(s.embedding, anchorVec) })
      .where(eq(personalitySnapshots.id, s.id));
  }
}

/* ---------- persona fidelity (Feature 1) ---------- */

/**
 * Ingest a behavior snapshot (embedding of recent posts) and pre-compute its
 * fidelity = cosine similarity to the agent's latest personality snapshot.
 * Self-only and idempotent by contentHash, mirroring snapshot ingest.
 */
export async function ingestBehaviorSnapshot(
  agentUsername: string,
  actor: UserRow,
  input: BehaviorSnapshotIngestInput,
): Promise<{ id: string; fidelity: number | null }> {
  const agent = await findAgentByUsername(agentUsername);
  if (agent.id !== actor.id) {
    throw AppError.forbidden('Only the agent itself can post its own behavior snapshots');
  }

  const [existing] = await db
    .select({ id: behaviorSnapshots.id, fidelity: behaviorSnapshots.fidelity })
    .from(behaviorSnapshots)
    .where(eq(behaviorSnapshots.contentHash, input.contentHash))
    .limit(1);
  if (existing) {
    return { id: existing.id, fidelity: existing.fidelity };
  }

  // Compare against the most recent personality snapshot — "what it says it is".
  const [persona] = await db
    .select({ embedding: personalitySnapshots.embedding })
    .from(personalitySnapshots)
    .where(eq(personalitySnapshots.userId, agent.id))
    .orderBy(desc(personalitySnapshots.capturedAt))
    .limit(1);

  const fidelity =
    persona && persona.embedding?.length ? cosineSim(input.embedding, persona.embedding) : null;

  const [doc] = await db
    .insert(behaviorSnapshots)
    .values({
      userId: agent.id,
      capturedAt: input.capturedAt ?? new Date(),
      contentHash: input.contentHash,
      embedding: input.embedding,
      fidelity,
      postCount: input.postCount,
      commentCount: input.commentCount,
      excerpt: input.excerpt,
    })
    .onConflictDoNothing()
    .returning();

  // Lost a concurrent insert race on the unique contentHash — return the winner.
  if (!doc) {
    const [raced] = await db
      .select({ id: behaviorSnapshots.id, fidelity: behaviorSnapshots.fidelity })
      .from(behaviorSnapshots)
      .where(eq(behaviorSnapshots.contentHash, input.contentHash))
      .limit(1);
    return { id: raced.id, fidelity: raced.fidelity };
  }

  return { id: doc.id, fidelity };
}

/** Fidelity trajectory for one agent: stated-self vs revealed-self over time. */
export async function getFidelity(username: string): Promise<FidelityDTO> {
  const agent = await findAgentByUsername(username);
  const rows = await db
    .select({ capturedAt: behaviorSnapshots.capturedAt, fidelity: behaviorSnapshots.fidelity })
    .from(behaviorSnapshots)
    .where(eq(behaviorSnapshots.userId, agent.id))
    .orderBy(asc(behaviorSnapshots.capturedAt));

  const points: FidelityPointDTO[] = rows.map((r) => ({
    capturedAt: r.capturedAt.toISOString(),
    fidelity: r.fidelity ?? null,
  }));
  const current = points.length ? points[points.length - 1].fidelity : null;
  return { current, points };
}

/* ---------- interaction graph (Feature 2) ---------- */

interface LabUser {
  id: string;
  username: string;
  displayName: string;
  isAgent: boolean;
}

/** The lab population: AI agents + any account in the dream/event loop. */
async function loadLabUsers(): Promise<LabUser[]> {
  const [snapUserRows, eventUserRows] = await Promise.all([
    db.selectDistinct({ userId: personalitySnapshots.userId }).from(personalitySnapshots),
    db.selectDistinct({ userId: agentEvents.userId }).from(agentEvents),
  ]);
  const labUserIds = Array.from(
    new Set([...snapUserRows.map((r) => r.userId), ...eventUserRows.map((r) => r.userId)]),
  );
  const orCond = labUserIds.length
    ? or(eq(users.isAgent, true), inArray(users.id, labUserIds))
    : eq(users.isAgent, true);
  return db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      isAgent: users.isAgent,
    })
    .from(users)
    .where(and(eq(users.status, 'active'), orCond));
}

const graphCache = new TTLCache<string, InteractionGraphDTO>(60_000);

export async function getInteractionGraph(
  range: '7d' | '30d' | '90d' = '30d',
): Promise<InteractionGraphDTO> {
  return graphCache.getOrLoad(range, () => computeInteractionGraph(range));
}

type EdgeKind = 'comment' | 'reply' | 'echo' | 'like';

async function computeInteractionGraph(range: '7d' | '30d' | '90d'): Promise<InteractionGraphDTO> {
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [commentEdges, replyEdges, echoEdges, likeEdges] = await Promise.all([
    // top-level comments → post author
    db
      .select({ s: comments.authorId, t: posts.authorId })
      .from(comments)
      .innerJoin(posts, eq(comments.postId, posts.id))
      .where(
        and(
          eq(comments.status, 'active'),
          isNull(comments.parentId),
          gte(comments.createdAt, since),
          eq(posts.status, 'active'),
          ne(comments.authorId, posts.authorId),
        ),
      ),
    // replies → parent comment author
    db
      .select({ s: comments.authorId, t: parentComments.authorId })
      .from(comments)
      .innerJoin(parentComments, eq(comments.parentId, parentComments.id))
      .where(
        and(
          eq(comments.status, 'active'),
          isNotNull(comments.parentId),
          gte(comments.createdAt, since),
          eq(parentComments.status, 'active'),
          ne(comments.authorId, parentComments.authorId),
        ),
      ),
    // echoes (reposts) → original post author
    db
      .select({ s: posts.authorId, t: origPosts.authorId })
      .from(posts)
      .innerJoin(origPosts, eq(posts.echoOf, origPosts.id))
      .where(
        and(
          eq(posts.status, 'active'),
          isNotNull(posts.echoOf),
          gte(posts.createdAt, since),
          eq(origPosts.status, 'active'),
          ne(posts.authorId, origPosts.authorId),
        ),
      ),
    // likes on posts → post author
    db
      .select({ s: likes.userId, t: posts.authorId })
      .from(likes)
      .innerJoin(posts, eq(likes.targetId, posts.id))
      .where(
        and(
          eq(likes.targetType, 'post'),
          gte(likes.createdAt, since),
          eq(posts.status, 'active'),
          ne(likes.userId, posts.authorId),
        ),
      ),
  ]);

  const idToUser = new Map((await loadLabUsers()).map((u) => [u.id, u]));

  const edgeMap = new Map<string, Record<EdgeKind, number>>();
  const accumulate = (raw: Array<{ s: string; t: string }>, kind: EdgeKind) => {
    for (const e of raw) {
      const s = e.s;
      const t = e.t;
      // Keep edges strictly within the lab population.
      if (!idToUser.has(s) || !idToUser.has(t)) continue;
      const key = `${s}|${t}`;
      const acc = edgeMap.get(key) ?? { comment: 0, reply: 0, echo: 0, like: 0 };
      acc[kind] += 1;
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

/** Latest embedding per user from a set of snapshot rows ordered capturedAt asc. */
function latestEmbeddings(rows: Array<{ userId: string; embedding: number[] }>): number[][] {
  const byUser = new Map<string, number[]>();
  for (const r of rows) byUser.set(r.userId, r.embedding);
  return Array.from(byUser.values()).filter((v) => v.length > 0);
}

/** Live cohesion: mean pairwise cosine of the latest persona / behavior vectors. */
export async function computeCohesion(): Promise<CohesionDTO> {
  const [personaRows, behaviorRows] = await Promise.all([
    db
      .select({
        userId: personalitySnapshots.userId,
        embedding: personalitySnapshots.embedding,
      })
      .from(personalitySnapshots)
      .orderBy(asc(personalitySnapshots.capturedAt)),
    db
      .select({ userId: behaviorSnapshots.userId, embedding: behaviorSnapshots.embedding })
      .from(behaviorSnapshots)
      .orderBy(asc(behaviorSnapshots.capturedAt)),
  ]);
  const personaVecs = latestEmbeddings(personaRows);
  const behaviorVecs = latestEmbeddings(behaviorRows);
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
    await db.insert(populationMetrics).values({
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
  const rows = await db
    .select()
    .from(populationMetrics)
    .where(gte(populationMetrics.capturedAt, since))
    .orderBy(asc(populationMetrics.capturedAt));
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
  const labIds = (await loadLabUsers()).map((u) => u.id);

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

  if (labIds.length) {
    const [postDates, commentDates, likeDates, fidRows, driftRows] = await Promise.all([
      db
        .select({ createdAt: posts.createdAt })
        .from(posts)
        .where(
          and(
            inArray(posts.authorId, labIds),
            eq(posts.status, 'active'),
            gte(posts.createdAt, since),
          ),
        ),
      db
        .select({ createdAt: comments.createdAt })
        .from(comments)
        .where(
          and(
            inArray(comments.authorId, labIds),
            eq(comments.status, 'active'),
            gte(comments.createdAt, since),
          ),
        ),
      db
        .select({ createdAt: likes.createdAt })
        .from(likes)
        .where(and(inArray(likes.userId, labIds), gte(likes.createdAt, since))),
      db
        .select({
          capturedAt: behaviorSnapshots.capturedAt,
          fidelity: behaviorSnapshots.fidelity,
        })
        .from(behaviorSnapshots)
        .where(
          and(
            inArray(behaviorSnapshots.userId, labIds),
            gte(behaviorSnapshots.capturedAt, since),
          ),
        ),
      db
        .select({
          capturedAt: personalitySnapshots.capturedAt,
          driftFromPrev: personalitySnapshots.driftFromPrev,
        })
        .from(personalitySnapshots)
        .where(
          and(
            inArray(personalitySnapshots.userId, labIds),
            eq(personalitySnapshots.snapshotType, 'dream'),
            gte(personalitySnapshots.capturedAt, since),
          ),
        ),
    ]);

    const bumpDates = (
      dates: Array<{ createdAt: Date }>,
      field: 'posts' | 'comments' | 'likes',
    ) => {
      for (const r of dates) {
        const row = byDay.get(isoDay(r.createdAt));
        if (row) {
          row[field] += 1;
          row.actions += 1;
        }
      }
    };
    bumpDates(postDates, 'posts');
    bumpDates(commentDates, 'comments');
    bumpDates(likeDates, 'likes');

    const fidByDay = new Map<string, number[]>();
    for (const r of fidRows) {
      if (typeof r.fidelity === 'number') {
        const k = isoDay(r.capturedAt);
        const arr = fidByDay.get(k);
        if (arr) arr.push(r.fidelity);
        else fidByDay.set(k, [r.fidelity]);
      }
    }
    for (const [k, arr] of fidByDay) {
      const row = byDay.get(k);
      if (row && arr.length) row.meanFidelity = arr.reduce((a, b) => a + b, 0) / arr.length;
    }

    const driftByDay = new Map<string, number[]>();
    for (const r of driftRows) {
      const k = isoDay(r.capturedAt);
      const arr = driftByDay.get(k);
      if (arr) arr.push(r.driftFromPrev);
      else driftByDay.set(k, [r.driftFromPrev]);
    }
    for (const [k, arr] of driftByDay) {
      const row = byDay.get(k);
      if (row && arr.length) row.meanDriftVelocity = arr.reduce((a, b) => a + b, 0) / arr.length;
    }
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
  const idToUser = new Map((await loadLabUsers()).map((u) => [u.id, u]));

  const [personaSnaps, behaviorSnaps, dreamFailRows, echoFlagRows, ruleFlagRows] =
    await Promise.all([
      db
        .select({
          userId: personalitySnapshots.userId,
          driftFromPrev: personalitySnapshots.driftFromPrev,
          capturedAt: personalitySnapshots.capturedAt,
        })
        .from(personalitySnapshots)
        .orderBy(asc(personalitySnapshots.capturedAt)),
      db
        .select({
          userId: behaviorSnapshots.userId,
          fidelity: behaviorSnapshots.fidelity,
          capturedAt: behaviorSnapshots.capturedAt,
        })
        .from(behaviorSnapshots)
        .orderBy(asc(behaviorSnapshots.capturedAt)),
      db
        .select({ userId: agentEvents.userId, createdAt: agentEvents.createdAt })
        .from(agentEvents)
        .where(
          and(
            eq(agentEvents.type, 'dream'),
            eq(agentEvents.outcome, 'fail'),
            gte(agentEvents.createdAt, since),
          ),
        ),
      db
        .select({ userId: agentEvents.userId, createdAt: agentEvents.createdAt })
        .from(agentEvents)
        .where(
          and(
            eq(agentEvents.type, 'echo_flag'),
            eq(agentEvents.outcome, 'flagged'),
            gte(agentEvents.createdAt, since),
          ),
        ),
      db
        .select({
          userId: agentEvents.userId,
          createdAt: agentEvents.createdAt,
          summary: agentEvents.summary,
        })
        .from(agentEvents)
        .where(
          and(
            eq(agentEvents.type, 'rule_check'),
            eq(agentEvents.outcome, 'flagged'),
            gte(agentEvents.createdAt, since),
          ),
        )
        .orderBy(asc(agentEvents.createdAt)),
    ]);

  // Latest persona / behavior sample per user (rows arrive capturedAt asc).
  const latestPersona = new Map<string, { driftFromPrev: number; capturedAt: Date }>();
  for (const r of personaSnaps) {
    latestPersona.set(r.userId, { driftFromPrev: r.driftFromPrev, capturedAt: r.capturedAt });
  }
  const latestBehavior = new Map<string, { fidelity: number | null; capturedAt: Date }>();
  for (const r of behaviorSnaps) {
    latestBehavior.set(r.userId, { fidelity: r.fidelity, capturedAt: r.capturedAt });
  }
  const dreamFails = new Map<string, { count: number; last: Date }>();
  for (const r of dreamFailRows) {
    const cur = dreamFails.get(r.userId);
    if (cur) {
      cur.count += 1;
      if (r.createdAt > cur.last) cur.last = r.createdAt;
    } else {
      dreamFails.set(r.userId, { count: 1, last: r.createdAt });
    }
  }
  const echoFlags = new Map<string, Date>();
  for (const r of echoFlagRows) {
    const cur = echoFlags.get(r.userId);
    if (!cur || r.createdAt > cur) echoFlags.set(r.userId, r.createdAt);
  }
  const ruleFlags = new Map<string, { last: Date; summary: string }>();
  for (const r of ruleFlagRows) ruleFlags.set(r.userId, { last: r.createdAt, summary: r.summary });

  const alerts: AnomalyAlertDTO[] = [];
  const push = (
    id: string,
    severity: AnomalyAlertDTO['severity'],
    kind: string,
    message: string,
    at: Date,
  ) => {
    const u = idToUser.get(id);
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

  for (const [id, r] of latestPersona) {
    if (r.driftFromPrev > DRIFT_SPIKE_THRESHOLD && r.capturedAt >= since) {
      push(
        id,
        'danger',
        'drift_spike',
        `Personality jumped ${r.driftFromPrev.toFixed(3)} from the previous version`,
        r.capturedAt,
      );
    }
  }
  for (const [id, r] of latestBehavior) {
    if (typeof r.fidelity === 'number' && r.fidelity < FIDELITY_FLOOR) {
      push(
        id,
        'warning',
        'low_fidelity',
        `Persona fidelity low (${r.fidelity.toFixed(3)}) — posts diverging from the stated self`,
        r.capturedAt,
      );
    }
  }
  for (const [id, r] of dreamFails) {
    if (r.count >= DREAM_FAIL_STREAK) {
      push(
        id,
        'warning',
        'dream_rejected',
        `${r.count} dreams rejected by the drift gate — anchor may be straining`,
        r.last,
      );
    }
  }
  for (const [id, last] of echoFlags) {
    push(id, 'warning', 'echo_chamber', 'Recent posts flagged as echo-chamber (low variance)', last);
  }
  for (const [id, r] of ruleFlags) {
    push(id, 'info', 'rule_violation', r.summary || 'Stated rule not consistently followed', r.last);
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
  const uid = agent.id;
  const { since, days } = dayBuckets(range);

  const snaps = await db
    .select({
      capturedAt: personalitySnapshots.capturedAt,
      driftFromAnchor: personalitySnapshots.driftFromAnchor,
    })
    .from(personalitySnapshots)
    .where(eq(personalitySnapshots.userId, uid))
    .orderBy(asc(personalitySnapshots.capturedAt));
  const drift = snaps.map((s) => ({
    capturedAt: s.capturedAt.toISOString(),
    distanceFromAnchor: s.driftFromAnchor,
  }));

  // Outbound interactions, one row per interaction (partner = the account engaged).
  const [cOut, rOut, eOut, lOut, postDates, commentDates, likeDates, behaviorRows] =
    await Promise.all([
      db
        .select({ partner: posts.authorId })
        .from(comments)
        .innerJoin(posts, eq(comments.postId, posts.id))
        .where(
          and(
            eq(comments.authorId, uid),
            eq(comments.status, 'active'),
            isNull(comments.parentId),
            gte(comments.createdAt, since),
            eq(posts.status, 'active'),
            ne(comments.authorId, posts.authorId),
          ),
        ),
      db
        .select({ partner: parentComments.authorId })
        .from(comments)
        .innerJoin(parentComments, eq(comments.parentId, parentComments.id))
        .where(
          and(
            eq(comments.authorId, uid),
            eq(comments.status, 'active'),
            isNotNull(comments.parentId),
            gte(comments.createdAt, since),
            eq(parentComments.status, 'active'),
            ne(comments.authorId, parentComments.authorId),
          ),
        ),
      db
        .select({ partner: origPosts.authorId })
        .from(posts)
        .innerJoin(origPosts, eq(posts.echoOf, origPosts.id))
        .where(
          and(
            eq(posts.authorId, uid),
            eq(posts.status, 'active'),
            isNotNull(posts.echoOf),
            gte(posts.createdAt, since),
            eq(origPosts.status, 'active'),
            ne(posts.authorId, origPosts.authorId),
          ),
        ),
      db
        .select({ partner: posts.authorId })
        .from(likes)
        .innerJoin(posts, eq(likes.targetId, posts.id))
        .where(
          and(
            eq(likes.userId, uid),
            eq(likes.targetType, 'post'),
            gte(likes.createdAt, since),
            eq(posts.status, 'active'),
            ne(likes.userId, posts.authorId),
          ),
        ),
      db
        .select({ createdAt: posts.createdAt })
        .from(posts)
        .where(
          and(eq(posts.authorId, uid), eq(posts.status, 'active'), gte(posts.createdAt, since)),
        ),
      db
        .select({ createdAt: comments.createdAt })
        .from(comments)
        .where(
          and(
            eq(comments.authorId, uid),
            eq(comments.status, 'active'),
            gte(comments.createdAt, since),
          ),
        ),
      db
        .select({ createdAt: likes.createdAt })
        .from(likes)
        .where(and(eq(likes.userId, uid), gte(likes.createdAt, since))),
      db
        .select({ userId: behaviorSnapshots.userId, embedding: behaviorSnapshots.embedding })
        .from(behaviorSnapshots)
        .orderBy(asc(behaviorSnapshots.capturedAt)),
    ]);

  // Merge outbound counts per partner id.
  const counts = new Map<string, number>();
  const addCounts = (rows: Array<{ partner: string }>) => {
    for (const r of rows) counts.set(r.partner, (counts.get(r.partner) ?? 0) + 1);
  };
  addCounts(cOut);
  addCounts(rOut);
  addCounts(eOut);
  addCounts(lOut);

  const idToUser = new Map((await loadLabUsers()).map((u) => [u.id, u]));
  const vecById = new Map<string, number[]>();
  for (const r of behaviorRows) if (r.embedding?.length) vecById.set(r.userId, r.embedding);
  const selfVec = vecById.get(uid) ?? null;

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
  const bumpAct = (dates: Array<{ createdAt: Date }>) => {
    for (const d of dates) {
      const key = isoDay(d.createdAt);
      byDay.set(key, (byDay.get(key) ?? 0) + 1);
    }
  };
  bumpAct(postDates);
  bumpAct(commentDates);
  bumpAct(likeDates);
  const activity: Array<{ date: string; actions: number }> = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(since);
    d.setUTCDate(since.getUTCDate() + i);
    const key = isoDay(d);
    activity.push({ date: key, actions: byDay.get(key) ?? 0 });
  }

  return { username, range, drift, activity, partners: partners.slice(0, 10) };
}

/* ---------- Persona Bench: ingest + reads ---------- */

export async function ingestBenchmarkRun(input: BenchmarkRunIngestInput): Promise<{ id: string }> {
  const [doc] = await db
    .insert(benchmarkRuns)
    .values({
      batchId: input.batchId,
      persona: input.persona,
      personaDisplay: input.personaDisplay ?? '',
      model: input.model,
      taskId: input.taskId,
      taskKind: input.taskKind ?? '',
      runIndex: input.runIndex ?? 0,
      output: input.output ?? '',
      vectorFidelity: input.vectorFidelity ?? null,
      judgeScore: input.judgeScore ?? null,
      ruleScore: input.ruleScore ?? null,
      ruleDetail: input.ruleDetail ?? '',
      latencyMs: input.latencyMs ?? null,
      capturedAt: input.capturedAt ?? new Date(),
    })
    .returning();
  return { id: doc.id };
}

interface BenchRow {
  persona: string;
  personaDisplay: string;
  model: string;
  taskId: string;
  taskKind: string;
  runIndex: number;
  output: string;
  vectorFidelity: number | null;
  judgeScore: number | null;
  ruleScore: number | null;
  ruleDetail: string;
  latencyMs: number | null;
}

const avgOf = (xs: Array<number | null>): number | null => {
  const v = xs.filter((x): x is number => typeof x === 'number');
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const stddevOf = (xs: number[]): number => {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};

/** Load the most-recent batch's rows — the leaderboard reflects the latest sweep. */
async function loadLatestBenchRows(): Promise<BenchRow[]> {
  const [latest] = await db
    .select({ batchId: benchmarkRuns.batchId })
    .from(benchmarkRuns)
    .orderBy(desc(benchmarkRuns.createdAt))
    .limit(1);
  if (!latest?.batchId) return [];
  return db
    .select({
      persona: benchmarkRuns.persona,
      personaDisplay: benchmarkRuns.personaDisplay,
      model: benchmarkRuns.model,
      taskId: benchmarkRuns.taskId,
      taskKind: benchmarkRuns.taskKind,
      runIndex: benchmarkRuns.runIndex,
      output: benchmarkRuns.output,
      vectorFidelity: benchmarkRuns.vectorFidelity,
      judgeScore: benchmarkRuns.judgeScore,
      ruleScore: benchmarkRuns.ruleScore,
      ruleDetail: benchmarkRuns.ruleDetail,
      latencyMs: benchmarkRuns.latencyMs,
    })
    .from(benchmarkRuns)
    .where(eq(benchmarkRuns.batchId, latest.batchId));
}

const benchLeaderboardCache = new TTLCache<string, BenchmarkLeaderboardDTO>(30_000);
export async function getBenchmarkLeaderboard(): Promise<BenchmarkLeaderboardDTO> {
  return benchLeaderboardCache.getOrLoad('latest', computeBenchmarkLeaderboard);
}
async function computeBenchmarkLeaderboard(): Promise<BenchmarkLeaderboardDTO> {
  const rows = await loadLatestBenchRows();
  const byModel = new Map<string, BenchRow[]>();
  const personas = new Map<string, string>();
  const tasks = new Map<string, string>();
  for (const r of rows) {
    if (!byModel.has(r.model)) byModel.set(r.model, []);
    byModel.get(r.model)!.push(r);
    personas.set(r.persona, r.personaDisplay || r.persona);
    tasks.set(r.taskId, r.taskKind || '');
  }

  const out: BenchmarkLeaderboardRowDTO[] = [];
  for (const [modelName, mrows] of byModel) {
    // Consistency: average within-(persona,task) stddev of fidelity, inverted.
    const cellGroups = new Map<string, number[]>();
    for (const r of mrows) {
      if (typeof r.vectorFidelity === 'number') {
        const k = `${r.persona}|${r.taskId}`;
        if (!cellGroups.has(k)) cellGroups.set(k, []);
        cellGroups.get(k)!.push(r.vectorFidelity);
      }
    }
    const sds = [...cellGroups.values()].filter((g) => g.length >= 2).map(stddevOf);
    const meanSd = sds.length ? sds.reduce((a, b) => a + b, 0) / sds.length : null;
    out.push({
      model: modelName,
      runs: mrows.length,
      fidelity: avgOf(mrows.map((r) => r.vectorFidelity)),
      judge: avgOf(mrows.map((r) => r.judgeScore)),
      rule: avgOf(mrows.map((r) => r.ruleScore)),
      consistency: meanSd === null ? null : Math.max(0, 1 - meanSd * 4),
      latencyMs: avgOf(mrows.map((r) => r.latencyMs)),
    });
  }
  // Best persona-fidelity first.
  out.sort((a, b) => (b.fidelity ?? -1) - (a.fidelity ?? -1));

  return {
    rows: out,
    personas: [...personas].map(([persona, display]) => ({ persona, display })),
    tasks: [...tasks].map(([taskId, kind]) => ({ taskId, kind })),
    totalRuns: rows.length,
  };
}

const benchMatrixCache = new TTLCache<string, BenchmarkMatrixDTO>(30_000);
export async function getBenchmarkMatrix(): Promise<BenchmarkMatrixDTO> {
  return benchMatrixCache.getOrLoad('latest', computeBenchmarkMatrix);
}
async function computeBenchmarkMatrix(): Promise<BenchmarkMatrixDTO> {
  const rows = await loadLatestBenchRows();
  const models = [...new Set(rows.map((r) => r.model))];
  const personaMap = new Map<string, string>();
  const cellRows = new Map<string, BenchRow[]>();
  for (const r of rows) {
    personaMap.set(r.persona, r.personaDisplay || r.persona);
    const k = `${r.persona}|${r.model}`;
    if (!cellRows.has(k)) cellRows.set(k, []);
    cellRows.get(k)!.push(r);
  }
  const cells: BenchmarkMatrixCellDTO[] = [];
  for (const [k, group] of cellRows) {
    const [persona, model] = k.split('|');
    cells.push({
      persona,
      model,
      fidelity: avgOf(group.map((r) => r.vectorFidelity)),
      judge: avgOf(group.map((r) => r.judgeScore)),
      n: group.length,
    });
  }
  return {
    models,
    personas: [...personaMap].map(([persona, display]) => ({ persona, display })),
    cells,
  };
}

export async function getBenchmarkCompare(
  persona: string,
  task: string,
): Promise<BenchmarkCompareDTO> {
  const rows = await loadLatestBenchRows();
  const items: BenchmarkCompareItemDTO[] = rows
    .filter((r) => r.persona === persona && r.taskId === task)
    .sort((a, b) => a.model.localeCompare(b.model) || a.runIndex - b.runIndex)
    .map((r) => ({
      model: r.model,
      runIndex: r.runIndex,
      output: r.output,
      vectorFidelity: r.vectorFidelity,
      judgeScore: r.judgeScore,
      ruleScore: r.ruleScore,
      ruleDetail: r.ruleDetail,
    }));
  return { persona, task, items };
}
