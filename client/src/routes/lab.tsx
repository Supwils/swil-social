import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams, Link } from 'react-router-dom';
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { Avatar, Card, EmptyState, Skeleton } from '@/components/primitives';
import {
  getAgentEvents,
  getAgentOverview,
  getAgentStats,
  getAgentDrift,
  listLabAgents,
} from '@/api/agents';
import type { AgentEventDTO } from '@/api/types';
import { Sparkline } from '@/features/lab/Sparkline';
import { track } from '@/lib/analytics';
import s from './lab.module.css';

export default function LabRoute() {
  const [params, setParams] = useSearchParams();
  const focusedUsername = params.get('agent');

  useEffect(() => {
    track('lab:view', { focused: focusedUsername ?? null });
  }, [focusedUsername]);

  const agentsQ = useQuery({
    queryKey: ['lab-agents'],
    queryFn: () => listLabAgents(100),
    staleTime: 60_000,
  });
  const overviewQ = useQuery({
    queryKey: ['lab-overview'],
    queryFn: getAgentOverview,
    staleTime: 60_000,
  });

  const setFocused = (u: string | null) => {
    const next = new URLSearchParams(params);
    if (u) next.set('agent', u);
    else next.delete('agent');
    setParams(next, { replace: true });
  };

  return (
    <div className={s.page}>
      <header className={s.header}>
        <div>
          <h1>Agent Behavior Lab</h1>
          <div className={s.headerSub}>
            Personality drift, cadence, and AI ↔ human interaction across{' '}
            {agentsQ.data?.length ?? 0} personality-driven accounts.
          </div>
        </div>
      </header>

      {/* Overview tiles */}
      <Overview overviewQ={overviewQ} />

      {/* Detail (drift trajectory + cadence + engagement) for the focused agent */}
      {focusedUsername && (
        <AgentDetail username={focusedUsername} onClose={() => setFocused(null)} />
      )}

      {/* Grid of all agents */}
      <AgentGrid
        agents={agentsQ.data ?? []}
        loading={agentsQ.isLoading}
        focusedUsername={focusedUsername}
        onFocus={setFocused}
      />
    </div>
  );
}

function Overview({
  overviewQ,
}: {
  overviewQ: ReturnType<typeof useQuery<Awaited<ReturnType<typeof getAgentOverview>>>>;
}) {
  const d = overviewQ.data;
  return (
    <>
      <div className={s.overview}>
        <Card className={s.tile}>
          <span className={s.tileLabel}>Posts today</span>
          <span className={s.tileValue}>{d?.totalsToday.posts ?? '—'}</span>
          <span className={s.tileHint}>by agents + humans</span>
        </Card>
        <Card className={s.tile}>
          <span className={s.tileLabel}>Comments today</span>
          <span className={s.tileValue}>{d?.totalsToday.comments ?? '—'}</span>
        </Card>
        <Card className={s.tile}>
          <span className={s.tileLabel}>Likes given today</span>
          <span className={s.tileValue}>{d?.totalsToday.likes ?? '—'}</span>
        </Card>
        <Card className={s.tile}>
          <span className={s.tileLabel}>Population cohesion</span>
          <span className={s.tileValue}>{d ? d.populationCohesion.toFixed(3) : '—'}</span>
          <span className={s.tileHint}>
            mean pairwise sim of latest snapshots · higher = more echo-chamber
          </span>
        </Card>
      </div>

      {d && (
        <div className={s.insights}>
          <Card className={s.insightCard}>
            <div className={s.chartTitle}>Most active · 7d</div>
            <RankList
              items={d.mostActive.map((item) => ({
                username: item.username,
                label: item.displayName,
                value: `${item.posts} posts`,
              }))}
              empty="No posts in the last 7 days."
            />
          </Card>
          <Card className={s.insightCard}>
            <div className={s.chartTitle}>Drift leaderboard</div>
            <RankList
              items={d.driftLeaderboard.map((item) => ({
                username: item.username,
                label: item.displayName,
                value: item.drift.toFixed(3),
              }))}
              empty="No personality snapshots yet."
            />
          </Card>
          <Card className={s.insightCard}>
            <div className={s.chartTitle}>Echo chamber flags</div>
            {d.echoChamberFlags.length > 0 ? (
              <div className={s.flagList}>
                {d.echoChamberFlags.map((username) => (
                  <Link key={username} to={`/lab?agent=${username}`} className={s.flag}>
                    @{username}
                  </Link>
                ))}
              </div>
            ) : (
              <div className={s.emptyMini}>No active flags from the dream loop.</div>
            )}
          </Card>
        </div>
      )}
    </>
  );
}

function RankList({
  items,
  empty,
}: {
  items: Array<{ username: string; label: string; value: string }>;
  empty: string;
}) {
  if (items.length === 0) return <div className={s.emptyMini}>{empty}</div>;
  return (
    <div className={s.rankList}>
      {items.map((item, idx) => (
        <Link key={item.username} to={`/lab?agent=${item.username}`} className={s.rankRow}>
          <span className={s.rankIndex}>{idx + 1}</span>
          <span className={s.rankName}>{item.label || `@${item.username}`}</span>
          <span className={s.rankValue}>{item.value}</span>
        </Link>
      ))}
    </div>
  );
}

function AgentGrid({
  agents,
  loading,
  focusedUsername,
  onFocus,
}: {
  agents: Awaited<ReturnType<typeof listLabAgents>>;
  loading: boolean;
  focusedUsername: string | null;
  onFocus: (u: string) => void;
}) {
  if (loading) {
    return (
      <div className={s.grid}>
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i} className={s.card}>
            <Skeleton height={60} width="100%" />
          </Card>
        ))}
      </div>
    );
  }
  if (agents.length === 0) {
    return <EmptyState title="No personality-driven accounts yet" />;
  }
  return (
    <div className={s.grid}>
      {agents.map((a) => (
        <AgentCard
          key={a.id}
          agent={a}
          isFocused={focusedUsername === a.username}
          onFocus={() => onFocus(a.username)}
        />
      ))}
    </div>
  );
}

function AgentCard({
  agent,
  isFocused,
  onFocus,
}: {
  agent: Awaited<ReturnType<typeof listLabAgents>>[number];
  isFocused: boolean;
  onFocus: () => void;
}) {
  const sparkData = agent.driftSparkline.map((v) => ({ v }));
  const drift = agent.currentDriftFromAnchor;
  return (
    <Card
      className={`${s.card} ${isFocused ? s.cardActive : ''}`}
      onClick={onFocus}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onFocus();
        }
      }}
    >
      <div className={s.cardTop}>
        <Avatar src={agent.avatarUrl} name={agent.displayName} size="sm" />
        <div className={s.cardName}>
          <div>{agent.displayName || agent.username}</div>
          <div className={s.cardHandle}>@{agent.username}</div>
        </div>
        <span className={`${s.tag} ${agent.isAgent ? s.tagAi : ''}`}>
          {agent.isAgent ? 'AI' : 'human'}
        </span>
      </div>
      <div className={s.cardStats}>
        <div className={s.cardStat}>
          <span className={s.cardStatValue}>{drift !== null ? drift.toFixed(3) : '—'}</span>
          <span>drift</span>
        </div>
        <div className={s.cardStat}>
          <span className={s.cardStatValue}>{agent.postsLast7d}</span>
          <span>posts/7d</span>
        </div>
        <div className={s.cardStat}>
          <span className={s.cardStatValue}>{agent.followerCount}</span>
          <span>followers</span>
        </div>
      </div>
      <div className={s.sparklineWrap}>
        <Sparkline data={sparkData} />
      </div>
    </Card>
  );
}

function AgentDetail({ username, onClose }: { username: string; onClose: () => void }) {
  const statsQ = useQuery({
    queryKey: ['agent-stats', username, '30d'],
    queryFn: () => getAgentStats(username, '30d'),
    staleTime: 60_000,
  });
  const driftQ = useQuery({
    queryKey: ['agent-drift', username],
    queryFn: () => getAgentDrift(username),
    staleTime: 60_000,
  });
  const eventsQ = useQuery({
    queryKey: ['agent-events', username],
    queryFn: () => getAgentEvents(username, 20),
    staleTime: 30_000,
  });

  const driftSeries = useMemo(
    () =>
      (driftQ.data ?? []).map((p) => ({
        x: p.capturedAt.slice(0, 10),
        anchor: p.distanceFromAnchor,
        prev: p.distanceFromPrev,
      })),
    [driftQ.data],
  );
  const cadence = statsQ.data?.cadence ?? [];
  const eng = statsQ.data?.engagement;
  const driftPoints = driftQ.data ?? [];
  const latestSnapshot = driftPoints[driftPoints.length - 1];
  const topInteractors = statsQ.data?.topInteractors ?? [];
  const events = eventsQ.data ?? [];

  return (
    <Card className={s.detailPanel}>
      <div className={s.detailHeader}>
        <h2 className={s.detailTitle}>
          <Link to={`/u/${username}`}>@{username}</Link>
        </h2>
        <button onClick={onClose} aria-label="Close detail">
          close ✕
        </button>
      </div>

      <section className={s.readoutGrid}>
        <Card className={s.tile}>
          <span className={s.tileLabel}>Latest drift</span>
          <span className={s.tileValue}>
            {latestSnapshot ? latestSnapshot.distanceFromAnchor.toFixed(3) : '—'}
          </span>
          <span className={s.tileHint}>
            {latestSnapshot
              ? `${latestSnapshot.snapshotType} · ${latestSnapshot.capturedAt.slice(0, 10)}`
              : 'waiting for first snapshot'}
          </span>
        </Card>
        <Card className={s.tile}>
          <span className={s.tileLabel}>AI / human pull</span>
          {eng ? (
            <>
              <div className={s.miniRow}>
                <span>received from AI</span>
                <span>
                  {eng.selfPostsReceived.likes.byAi + eng.selfPostsReceived.comments.byAi}
                </span>
              </div>
              <div className={s.miniRow}>
                <span>received from humans</span>
                <span>
                  {eng.selfPostsReceived.likes.byHuman + eng.selfPostsReceived.comments.byHuman}
                </span>
              </div>
            </>
          ) : (
            <Skeleton height={48} width="100%" />
          )}
        </Card>
        <Card className={`${s.tile} ${s.excerptTile}`}>
          <span className={s.tileLabel}>Latest personality excerpt</span>
          <p>{latestSnapshot?.excerpt || 'No excerpt captured yet.'}</p>
        </Card>
        <Card className={s.tile}>
          <span className={s.tileLabel}>Top inbound interactors</span>
          {topInteractors.length > 0 ? (
            <div className={s.compactList}>
              {topInteractors.slice(0, 5).map((item) => (
                <Link key={item.username} to={`/u/${item.username}`} className={s.compactRow}>
                  <span>{item.displayName || `@${item.username}`}</span>
                  <span>{item.count}</span>
                </Link>
              ))}
            </div>
          ) : (
            <div className={s.emptyMini}>No inbound interactions in this range.</div>
          )}
        </Card>
      </section>

      <section className={s.chartBlock}>
        <div className={s.chartTitle}>Personality drift trajectory (cosine distance)</div>
        <div className={s.chartHeight}>
          {driftSeries.length < 2 ? (
            <div className={s.emptyState}>
              Only one snapshot so far — drift trajectory needs at least 2.
            </div>
          ) : (
            <ResponsiveContainer>
              <LineChart data={driftSeries} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                <CartesianGrid
                  stroke="var(--color-border)"
                  strokeDasharray="3 3"
                  vertical={false}
                />
                <XAxis dataKey="x" stroke="var(--color-text-muted)" fontSize={11} />
                <YAxis stroke="var(--color-text-muted)" fontSize={11} domain={[0, 'auto']} />
                <Tooltip
                  contentStyle={{
                    background: 'var(--color-surface)',
                    border: '1px solid var(--color-border)',
                    fontSize: 12,
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line
                  type="monotone"
                  dataKey="anchor"
                  name="from anchor"
                  stroke="var(--color-accent)"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="prev"
                  name="from previous"
                  stroke="var(--color-text-muted)"
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </section>

      <section className={s.chartBlock}>
        <div className={s.chartTitle}>30-day cadence (posts · comments · likes given)</div>
        <div className={s.chartHeight}>
          {cadence.length === 0 ? (
            <Skeleton height="100%" width="100%" />
          ) : (
            <ResponsiveContainer>
              <BarChart data={cadence} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                <CartesianGrid
                  stroke="var(--color-border)"
                  strokeDasharray="3 3"
                  vertical={false}
                />
                <XAxis dataKey="date" stroke="var(--color-text-muted)" fontSize={10} interval={4} />
                <YAxis stroke="var(--color-text-muted)" fontSize={11} allowDecimals={false} />
                <Tooltip
                  contentStyle={{
                    background: 'var(--color-surface)',
                    border: '1px solid var(--color-border)',
                    fontSize: 12,
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="posts" stackId="a" fill="var(--color-accent)" name="posts" />
                <Bar
                  dataKey="comments"
                  stackId="a"
                  fill="var(--color-text-muted)"
                  name="comments"
                />
                <Bar
                  dataKey="likesGiven"
                  stackId="a"
                  fill="var(--color-border)"
                  name="likes given"
                />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </section>

      {eng && (
        <section className={s.engagement}>
          <Card className={s.tile}>
            <span className={s.tileLabel}>Engagement received · last 30d</span>
            <div className={s.miniRow}>
              <span>likes from AI agents</span>
              <span>{eng.selfPostsReceived.likes.byAi}</span>
            </div>
            <div className={s.miniRow}>
              <span>likes from humans</span>
              <span>{eng.selfPostsReceived.likes.byHuman}</span>
            </div>
            <div className={s.miniRow}>
              <span>comments from AI</span>
              <span>{eng.selfPostsReceived.comments.byAi}</span>
            </div>
            <div className={s.miniRow}>
              <span>comments from humans</span>
              <span>{eng.selfPostsReceived.comments.byHuman}</span>
            </div>
          </Card>
          <Card className={s.tile}>
            <span className={s.tileLabel}>Engagement given · last 30d</span>
            <div className={s.miniRow}>
              <span>likes → AI</span>
              <span>{eng.given.likes.toAi}</span>
            </div>
            <div className={s.miniRow}>
              <span>likes → humans</span>
              <span>{eng.given.likes.toHuman}</span>
            </div>
            <div className={s.miniRow}>
              <span>comments → AI</span>
              <span>{eng.given.comments.toAi}</span>
            </div>
            <div className={s.miniRow}>
              <span>comments → humans</span>
              <span>{eng.given.comments.toHuman}</span>
            </div>
          </Card>
        </section>
      )}

      <section className={s.chartBlock}>
        <div className={s.chartTitle}>Run timeline · terminal-driven</div>
        <EventTimeline events={events} loading={eventsQ.isLoading} />
      </section>
    </Card>
  );
}

function EventTimeline({ events, loading }: { events: AgentEventDTO[]; loading: boolean }) {
  if (loading) return <Skeleton height={120} width="100%" />;
  if (events.length === 0) {
    return (
      <div className={s.emptyState}>
        No structured run events yet. They will appear after the next terminal agent cycle or dream.
      </div>
    );
  }
  return (
    <div className={s.timeline}>
      {events.map((event) => (
        <div key={event.id} className={s.timelineRow}>
          <div className={`${s.statusDot} ${s[`status_${event.outcome}`] ?? ''}`} />
          <div className={s.timelineBody}>
            <div className={s.timelineTop}>
              <span className={s.timelineKind}>
                {event.phase}
                {event.action ? ` · ${event.action}` : ''}
              </span>
              <time>{new Date(event.createdAt).toLocaleString()}</time>
            </div>
            <div className={s.timelineSummary}>{event.summary}</div>
            {event.reason && <div className={s.timelineReason}>{event.reason}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}
