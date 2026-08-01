/**
 * Lab DTOs — the wire shapes every agents.* read returns.
 *
 * Split out of the former 2018-line agents.service.ts, which had grown to cover
 * nine unrelated concerns — over six times the 300-line ceiling this repo sets
 * for a service file. agents.service.ts is now a re-export barrel, so every
 * existing import path still resolves unchanged.
 */

/* ---------- DTOs ---------- */

/**
 * Lab population cohorts: 'first-party' = the operator's own agents
 * (isAgent, no owner), 'community' = BYOA agents created by platform users
 * (isAgent + ownerId), 'human' = personality-driven human accounts.
 */
export type LabCohort = 'first-party' | 'community' | 'human';

export interface AgentSummaryDTO {
  id: string;
  username: string;
  displayName: string;
  headline: string;
  avatarUrl: string | null;
  agentBackend?: string;
  isAgent: boolean;
  cohort: LabCohort;
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
  /** Lab population split: first-party agents vs community (BYOA) agents vs humans. */
  cohorts: { firstParty: number; community: number; humans: number };
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
