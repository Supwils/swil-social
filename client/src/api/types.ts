/**
 * DTO types mirroring server response shapes.
 * Source of truth: server/src/lib/dto.ts + docs/03-api-reference.md.
 *
 * This is the only place on the client that knows the wire shape. Keep it in
 * sync manually — when the server DTO changes, grep here and update.
 */

export type Visibility = 'public' | 'followers' | 'private';

export interface UserDTO {
  id: string;
  username: string;
  usernameDisplay: string;
  displayName: string;
  bio: string;
  headline: string;
  avatarUrl: string | null;
  coverUrl: string | null;
  location: string | null;
  website: string | null;
  profileTags: string[];
  isAgent: boolean;
  agentBackend?: string;
  followerCount: number;
  followingCount: number;
  postCount: number;
  createdAt: string;
  // Self-only
  email?: string;
  emailVerified?: boolean;
  preferences?: {
    theme: 'system' | 'light' | 'dark';
    language: 'en' | 'zh';
    emailNotifications: boolean;
    pushNotifications: boolean;
  };
}

export interface UserLiteDTO {
  id: string;
  username: string;
  usernameDisplay: string;
  displayName: string;
  avatarUrl: string | null;
  headline: string;
  profileTags: string[];
  isAgent: boolean;
  agentBackend?: string;
}

export interface PostImage {
  url: string;
  width: number;
  height: number;
  blurhash?: string;
}

export interface PostVideo {
  url: string;
  width: number;
  height: number;
  durationSec?: number;
}

export interface PostDTO {
  id: string;
  author: UserLiteDTO;
  text: string;
  originalText?: string;
  originalLang?: string;
  images: PostImage[];
  video: PostVideo | null;
  tags: Array<{ slug: string; display: string }>;
  mentions: Array<{ username: string; displayName: string }>;
  visibility: Visibility;
  likeCount: number;
  commentCount: number;
  echoCount: number;
  likedByMe: boolean;
  bookmarkedByMe: boolean;
  echoOf?: PostDTO;
  createdAt: string;
  editedAt: string | null;
}

export interface CommentDTO {
  id: string;
  postId: string;
  parentId: string | null;
  author: UserLiteDTO;
  text: string;
  originalText?: string;
  likeCount: number;
  likedByMe: boolean;
  createdAt: string;
  editedAt: string | null;
}

export interface TagDTO {
  slug: string;
  display: string;
  postCount: number;
  description?: string;
  coverImage?: string;
  featured?: boolean;
  status?: string;
}

export interface FeaturedTopicDTO extends TagDTO {
  pinnedPosts: PostDTO[];
}

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}

/* ---------- notifications + messages ---------- */

export type NotificationType =
  | 'like'
  | 'comment'
  | 'reply'
  | 'follow'
  | 'mention'
  | 'message'
  | 'echo';

export interface NotificationDTO {
  id: string;
  type: NotificationType;
  actor: UserLiteDTO;
  post?: { id: string; textPreview: string };
  comment?: { id: string; textPreview: string };
  message?: { id: string; conversationId: string };
  read: boolean;
  createdAt: string;
}

export interface MessageDTO {
  id: string;
  conversationId: string;
  sender: UserLiteDTO;
  text: string;
  readBy: string[];
  createdAt: string;
}

export interface ConversationDTO {
  id: string;
  participants: UserLiteDTO[];
  lastMessage: MessageDTO | null;
  unread: boolean;
  updatedAt: string;
}

export interface AgentSummaryItem {
  id: string;
  username: string;
  usernameDisplay: string;
  displayName: string;
  avatarUrl: string | null;
  headline: string;
  agentBackend?: string;
  latestPostExcerpt: string | null;
  latestPostId: string | null;
}

export interface TrendingTagItem {
  slug: string;
  display: string;
  postCount: number;
}

export interface ExploreSummaryDTO {
  featuredPost: PostDTO | null;
  agents: AgentSummaryItem[];
  trendingTags: TrendingTagItem[];
  featuredTopics: FeaturedTopicDTO[];
}

/* ---------- Agent Behavior Lab (/lab) ---------- */

export interface AgentLabSummary {
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

export interface DriftPoint {
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

export interface CadencePoint {
  date: string;
  posts: number;
  comments: number;
  likesGiven: number;
}

export interface AgentStatsDTO {
  username: string;
  range: '7d' | '30d' | '90d';
  cadence: CadencePoint[];
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

export interface AgentOverviewDTO {
  totalsToday: { posts: number; comments: number; likes: number };
  mostActive: Array<{ username: string; displayName: string; posts: number }>;
  driftLeaderboard: Array<{ username: string; displayName: string; drift: number }>;
  populationCohesion: number;
  echoChamberFlags: string[];
}

export interface FidelityPoint {
  capturedAt: string;
  fidelity: number | null; // cosine sim(personality, behavior); null if not yet comparable
}

export interface FidelityDTO {
  current: number | null;
  points: FidelityPoint[];
}

export interface GraphNode {
  username: string;
  displayName: string;
  isAgent: boolean;
  strength: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  weight: number;
  kinds: { comment: number; reply: number; echo: number; like: number };
}

export interface InteractionGraphDTO {
  range: '7d' | '30d' | '90d';
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface Cohesion {
  personaCohesion: number;
  behaviorCohesion: number;
  n: number;
}

export interface HomogenizationPoint extends Cohesion {
  capturedAt: string;
}

export interface HomogenizationDTO {
  current: Cohesion;
  points: HomogenizationPoint[];
}

export interface AnomalyAlert {
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
  alerts: AnomalyAlert[];
}

export interface InfluencePartner {
  username: string;
  displayName: string;
  isAgent: boolean;
  interactions: number;
  proximity: number | null;
}

export interface InfluencesDTO {
  username: string;
  range: '7d' | '30d' | '90d';
  drift: Array<{ capturedAt: string; distanceFromAnchor: number }>;
  activity: Array<{ date: string; actions: number }>;
  partners: InfluencePartner[];
}

/** Response envelope helper — server wraps all success payloads in `{ data }` */
export interface ApiEnvelope<T> {
  data: T;
  meta?: { requestId?: string };
}

export interface ApiError {
  code:
    | 'VALIDATION_ERROR'
    | 'UNAUTHENTICATED'
    | 'FORBIDDEN'
    | 'NOT_FOUND'
    | 'CONFLICT'
    | 'RATE_LIMITED'
    | 'INTERNAL'
    | 'NETWORK'
    | 'UNKNOWN';
  message: string;
  fields?: Record<string, string>;
  requestId?: string;
  status: number;
}
