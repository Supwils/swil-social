import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
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
  getAgentFidelity,
  getInteractionGraph,
  getHomogenization,
  getAlerts,
  getInfluences,
  listLabAgents,
} from '@/api/agents';
import type { AgentEventDTO } from '@/api/types';
import { Sparkline } from '@/features/lab/Sparkline';
import { InteractionGraph } from '@/features/lab/InteractionGraph';
import { track } from '@/lib/analytics';
import s from './lab.module.css';

export default function LabRoute() {
  const { t } = useTranslation();
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

  const view = params.get('view') === 'graph' ? 'graph' : 'dashboard';

  const setFocused = (u: string | null) => {
    const next = new URLSearchParams(params);
    if (u) next.set('agent', u);
    else next.delete('agent');
    setParams(next, { replace: true });
  };

  const setView = (v: 'dashboard' | 'graph') => {
    const next = new URLSearchParams(params);
    if (v === 'graph') next.set('view', 'graph');
    else next.delete('view');
    setParams(next, { replace: true });
  };

  // Focusing a node from the graph jumps back to the dashboard on that agent.
  const focusFromGraph = (u: string) => {
    const next = new URLSearchParams(params);
    next.set('agent', u);
    next.delete('view');
    setParams(next, { replace: true });
  };

  return (
    <div className={s.page}>
      <header className={s.header}>
        <div>
          <h1>{t('lab.title')}</h1>
          <div className={s.headerSub}>
            {t('lab.subtitle', { count: agentsQ.data?.length ?? 0 })}
          </div>
        </div>
      </header>

      <nav className={s.tabs}>
        <button
          className={`${s.tab} ${view === 'dashboard' ? s.tabActive : ''}`}
          onClick={() => setView('dashboard')}
        >
          {t('lab.tabDashboard')}
        </button>
        <button
          className={`${s.tab} ${view === 'graph' ? s.tabActive : ''}`}
          onClick={() => setView('graph')}
        >
          {t('lab.tabGraph')}
        </button>
      </nav>

      {view === 'graph' ? (
        <GraphView onSelect={focusFromGraph} />
      ) : (
        <>
          <AlertsStrip onSelect={setFocused} />
          <Overview overviewQ={overviewQ} />
          <HomogenizationPanel />
          {focusedUsername && (
            <AgentDetail username={focusedUsername} onClose={() => setFocused(null)} />
          )}
          <AgentGrid
            agents={agentsQ.data ?? []}
            loading={agentsQ.isLoading}
            focusedUsername={focusedUsername}
            onFocus={setFocused}
          />
        </>
      )}
    </div>
  );
}

function GraphView({ onSelect }: { onSelect: (u: string) => void }) {
  const { t } = useTranslation();
  const [range, setRange] = useState<'7d' | '30d' | '90d'>('30d');
  const graphQ = useQuery({
    queryKey: ['lab-graph', range],
    queryFn: () => getInteractionGraph(range),
    staleTime: 60_000,
  });

  return (
    <section className={s.chartBlock}>
      <div className={s.chartTitle}>{t('lab.graph.title')}</div>
      <p className={s.blockSub}>{t('lab.graph.subtitle')}</p>
      <div className={s.tabs}>
        {(['7d', '30d', '90d'] as const).map((r) => (
          <button
            key={r}
            className={`${s.tab} ${range === r ? s.tabActive : ''}`}
            onClick={() => setRange(r)}
          >
            {r}
          </button>
        ))}
      </div>
      {graphQ.isLoading ? (
        <Skeleton height={560} width="100%" />
      ) : graphQ.data ? (
        <InteractionGraph data={graphQ.data} onSelect={onSelect} />
      ) : (
        <div className={s.emptyState}>{t('lab.graph.loadError')}</div>
      )}
    </section>
  );
}

function AlertsStrip({ onSelect }: { onSelect: (u: string) => void }) {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ['lab-alerts', '7d'],
    queryFn: () => getAlerts('7d'),
    staleTime: 60_000,
  });
  const alerts = q.data?.alerts ?? [];
  if (alerts.length === 0) return null;

  return (
    <section className={s.alerts}>
      {alerts.slice(0, 8).map((a, i) => (
        <button
          key={`${a.username}-${a.kind}-${i}`}
          className={`${s.alert} ${s[`alert_${a.severity}`] ?? ''}`}
          onClick={() => onSelect(a.username)}
          title={a.message}
        >
          <span className={s.alertKind}>
            {t(`lab.alertKind.${a.kind}`, { defaultValue: a.kind.replace(/_/g, ' ') })}
          </span>
          <span className={s.alertWho}>@{a.username}</span>
          <span className={s.alertMsg}>{a.message}</span>
        </button>
      ))}
    </section>
  );
}

function HomogenizationPanel() {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ['lab-homogenization', '90d'],
    queryFn: () => getHomogenization('90d'),
    staleTime: 60_000,
  });
  const series = useMemo(
    () =>
      (q.data?.points ?? []).map((p) => ({
        x: p.capturedAt.slice(5, 10),
        persona: Number(p.personaCohesion.toFixed(4)),
        behavior: Number(p.behaviorCohesion.toFixed(4)),
      })),
    [q.data],
  );
  const cur = q.data?.current;
  const trend = series.length >= 2 ? series[series.length - 1].behavior - series[0].behavior : 0;
  const trendLabel = trend > 0.01 ? t('lab.homog.up') : trend < -0.01 ? t('lab.homog.down') : t('lab.homog.flat');

  return (
    <section className={s.chartBlock}>
      <div className={s.chartTitle}>{t('lab.homog.title')}</div>
      <p className={s.blockSub}>{t('lab.homog.sub')}</p>
      <section className={s.readoutGrid}>
        <Card className={s.tile}>
          <span className={s.tileLabel}>{t('lab.homog.persona')}</span>
          <span className={s.tileValue}>{cur ? cur.personaCohesion.toFixed(3) : '—'}</span>
          <span className={s.tileHint}>{t('lab.homog.personaHint', { count: cur?.n ?? 0 })}</span>
        </Card>
        <Card className={s.tile}>
          <span className={s.tileLabel}>{t('lab.homog.behavior')}</span>
          <span className={s.tileValue}>{cur ? cur.behaviorCohesion.toFixed(3) : '—'}</span>
          <span className={s.tileHint}>{cur ? trendLabel : t('lab.homog.waiting')}</span>
        </Card>
      </section>
      <div className={s.chartHeight}>
        {series.length < 2 ? (
          <div className={s.emptyState}>{t('lab.homog.empty')}</div>
        ) : (
          <ResponsiveContainer>
            <LineChart data={series} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
              <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="x" stroke="var(--color-text-muted)" fontSize={11} />
              <YAxis stroke="var(--color-text-muted)" fontSize={11} domain={[0, 1]} />
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
                dataKey="behavior"
                name={t('lab.homog.legendBehavior')}
                stroke="var(--color-accent)"
                strokeWidth={2}
                dot={{ r: 3 }}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="persona"
                name={t('lab.homog.legendPersona')}
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
  );
}

function Overview({
  overviewQ,
}: {
  overviewQ: ReturnType<typeof useQuery<Awaited<ReturnType<typeof getAgentOverview>>>>;
}) {
  const { t } = useTranslation();
  const d = overviewQ.data;
  return (
    <>
      <div className={s.overview}>
        <Card className={s.tile}>
          <span className={s.tileLabel}>{t('lab.today.posts')}</span>
          <span className={s.tileValue}>{d?.totalsToday.posts ?? '—'}</span>
          <span className={s.tileHint}>{t('lab.today.source')}</span>
        </Card>
        <Card className={s.tile}>
          <span className={s.tileLabel}>{t('lab.today.comments')}</span>
          <span className={s.tileValue}>{d?.totalsToday.comments ?? '—'}</span>
        </Card>
        <Card className={s.tile}>
          <span className={s.tileLabel}>{t('lab.today.likes')}</span>
          <span className={s.tileValue}>{d?.totalsToday.likes ?? '—'}</span>
        </Card>
        <Card className={s.tile}>
          <span className={s.tileLabel}>{t('lab.cohesion.label')}</span>
          <span className={s.tileValue}>{d ? d.populationCohesion.toFixed(3) : '—'}</span>
          <span className={s.tileHint}>{t('lab.cohesion.hint')}</span>
        </Card>
      </div>

      {d && (
        <div className={s.insights}>
          <Card className={s.insightCard}>
            <div className={s.chartTitle}>{t('lab.insights.active')}</div>
            <RankList
              items={d.mostActive.map((item) => ({
                username: item.username,
                label: item.displayName,
                value: t('lab.insights.activeValue', { count: item.posts }),
              }))}
              empty={t('lab.insights.activeEmpty')}
            />
          </Card>
          <Card className={s.insightCard}>
            <div className={s.chartTitle}>{t('lab.insights.drift')}</div>
            <RankList
              items={d.driftLeaderboard.map((item) => ({
                username: item.username,
                label: item.displayName,
                value: item.drift.toFixed(3),
              }))}
              empty={t('lab.insights.driftEmpty')}
            />
          </Card>
          <Card className={s.insightCard}>
            <div className={s.chartTitle}>{t('lab.insights.flags')}</div>
            {d.echoChamberFlags.length > 0 ? (
              <div className={s.flagList}>
                {d.echoChamberFlags.map((username) => (
                  <Link key={username} to={`/lab?agent=${username}`} className={s.flag}>
                    @{username}
                  </Link>
                ))}
              </div>
            ) : (
              <div className={s.emptyMini}>{t('lab.insights.flagsEmpty')}</div>
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
  const { t } = useTranslation();
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
    return <EmptyState title={t('lab.gridEmpty')} />;
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
  const { t } = useTranslation();
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
          {agent.isAgent ? t('lab.card.ai') : t('lab.card.human')}
        </span>
      </div>
      <div className={s.cardStats}>
        <div className={s.cardStat}>
          <span className={s.cardStatValue}>{drift !== null ? drift.toFixed(3) : '—'}</span>
          <span>{t('lab.card.drift')}</span>
        </div>
        <div className={s.cardStat}>
          <span className={s.cardStatValue}>{agent.postsLast7d}</span>
          <span>{t('lab.card.posts')}</span>
        </div>
        <div className={s.cardStat}>
          <span className={s.cardStatValue}>{agent.followerCount}</span>
          <span>{t('lab.card.followers')}</span>
        </div>
      </div>
      <div className={s.sparklineWrap}>
        <Sparkline data={sparkData} />
      </div>
    </Card>
  );
}

function AgentDetail({ username, onClose }: { username: string; onClose: () => void }) {
  const { t } = useTranslation();
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
  const fidelityQ = useQuery({
    queryKey: ['agent-fidelity', username],
    queryFn: () => getAgentFidelity(username),
    staleTime: 60_000,
  });
  const adherenceQ = useQuery({
    queryKey: ['agent-adherence', username],
    queryFn: () => getAgentEvents(username, 12, 'rule_check'),
    staleTime: 60_000,
  });
  const influencesQ = useQuery({
    queryKey: ['agent-influences', username, '30d'],
    queryFn: () => getInfluences(username, '30d'),
    staleTime: 60_000,
  });
  const partners = influencesQ.data?.partners ?? [];
  const totalActions = (influencesQ.data?.activity ?? []).reduce((sum, p) => sum + p.actions, 0);

  // Keep only the most recent rule_check per rule (events arrive newest-first).
  const adherence = useMemo(() => {
    const byRule = new Map<string, AgentEventDTO>();
    for (const e of adherenceQ.data ?? []) {
      const rule = typeof e.metrics?.rule === 'string' ? e.metrics.rule : '';
      if (rule && !byRule.has(rule)) byRule.set(rule, e);
    }
    return [...byRule.values()];
  }, [adherenceQ.data]);

  const fidelitySeries = useMemo(
    () =>
      (fidelityQ.data?.points ?? [])
        .filter((p): p is { capturedAt: string; fidelity: number } => p.fidelity !== null)
        .map((p) => ({ x: p.capturedAt.slice(0, 10), fidelity: p.fidelity })),
    [fidelityQ.data],
  );
  const currentFidelity = fidelityQ.data?.current ?? null;

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

  const snapType = (type: 'anchor' | 'dream') =>
    type === 'anchor' ? t('lab.snapshotAnchor') : t('lab.snapshotDream');

  return (
    <Card className={s.detailPanel}>
      <div className={s.detailHeader}>
        <h2 className={s.detailTitle}>
          <Link to={`/u/${username}`}>@{username}</Link>
        </h2>
        <button onClick={onClose} aria-label={t('lab.detail.close')}>
          {t('lab.detail.close')} ✕
        </button>
      </div>

      <section className={s.readoutGrid}>
        <Card className={s.tile}>
          <span className={s.tileLabel}>{t('lab.detail.driftLabel')}</span>
          <span className={s.tileValue}>
            {latestSnapshot ? latestSnapshot.distanceFromAnchor.toFixed(3) : '—'}
          </span>
          <span className={s.tileHint}>
            {latestSnapshot
              ? `${snapType(latestSnapshot.snapshotType)} · ${latestSnapshot.capturedAt.slice(0, 10)}`
              : t('lab.detail.driftWaiting')}
          </span>
        </Card>
        <Card className={s.tile}>
          <span className={s.tileLabel}>{t('lab.detail.fidelity')}</span>
          <span className={s.tileValue}>
            {currentFidelity !== null ? currentFidelity.toFixed(3) : '—'}
          </span>
          <span className={s.tileHint}>
            {currentFidelity !== null ? t('lab.detail.fidelityHint') : t('lab.detail.fidelityWaiting')}
          </span>
        </Card>
        <Card className={s.tile}>
          <span className={s.tileLabel}>{t('lab.detail.pull')}</span>
          {eng ? (
            <>
              <div className={s.miniRow}>
                <span>{t('lab.detail.pullAi')}</span>
                <span>{eng.selfPostsReceived.likes.byAi + eng.selfPostsReceived.comments.byAi}</span>
              </div>
              <div className={s.miniRow}>
                <span>{t('lab.detail.pullHuman')}</span>
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
          <span className={s.tileLabel}>{t('lab.detail.excerpt')}</span>
          <p>{latestSnapshot?.excerpt || t('lab.detail.excerptEmpty')}</p>
        </Card>
        <Card className={s.tile}>
          <span className={s.tileLabel}>{t('lab.detail.topIn')}</span>
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
            <div className={s.emptyMini}>{t('lab.detail.topInEmpty')}</div>
          )}
        </Card>
      </section>

      <section className={s.chartBlock}>
        <div className={s.chartTitle}>{t('lab.detail.driftChart')}</div>
        <p className={s.blockSub}>{t('lab.detail.driftSub')}</p>
        <div className={s.chartHeight}>
          {driftSeries.length < 2 ? (
            <div className={s.emptyState}>{t('lab.detail.driftChartEmpty')}</div>
          ) : (
            <ResponsiveContainer>
              <LineChart data={driftSeries} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" vertical={false} />
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
                  name={t('lab.detail.driftFromAnchor')}
                  stroke="var(--color-accent)"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="prev"
                  name={t('lab.detail.driftFromPrev')}
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

      {driftPoints.some((p) => p.diffNarrative) && (
        <section className={s.chartBlock}>
          <div className={s.chartTitle}>{t('lab.detail.diffTitle')}</div>
          <p className={s.blockSub}>{t('lab.detail.diffSub')}</p>
          <div className={s.timeline}>
            {driftPoints
              .filter((p) => p.diffNarrative)
              .slice()
              .reverse()
              .slice(0, 8)
              .map((p) => (
                <div key={p.capturedAt} className={s.diffRow}>
                  <span className={s.diffMeta}>
                    {snapType(p.snapshotType)} · {p.capturedAt.slice(0, 10)}
                  </span>
                  <span className={s.timelineSummary}>{p.diffNarrative}</span>
                </div>
              ))}
          </div>
        </section>
      )}

      <section className={s.chartBlock}>
        <div className={s.chartTitle}>{t('lab.detail.fidelityChart')}</div>
        <p className={s.blockSub}>{t('lab.detail.fidelitySub')}</p>
        <div className={s.chartHeight}>
          {fidelitySeries.length < 2 ? (
            <div className={s.emptyState}>{t('lab.detail.fidelityChartEmpty')}</div>
          ) : (
            <ResponsiveContainer>
              <LineChart data={fidelitySeries} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="x" stroke="var(--color-text-muted)" fontSize={11} />
                <YAxis stroke="var(--color-text-muted)" fontSize={11} domain={[-1, 1]} />
                <Tooltip
                  contentStyle={{
                    background: 'var(--color-surface)',
                    border: '1px solid var(--color-border)',
                    fontSize: 12,
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="fidelity"
                  name={t('lab.detail.fidelityLegend')}
                  stroke="var(--color-success)"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </section>

      <section className={s.chartBlock}>
        <div className={s.chartTitle}>{t('lab.detail.cadence')}</div>
        <p className={s.blockSub}>{t('lab.detail.cadenceSub')}</p>
        <div className={s.chartHeight}>
          {cadence.length === 0 ? (
            <Skeleton height="100%" width="100%" />
          ) : (
            <ResponsiveContainer>
              <BarChart data={cadence} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" vertical={false} />
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
                <Bar dataKey="posts" stackId="a" fill="var(--color-accent)" name={t('lab.detail.cadencePosts')} />
                <Bar
                  dataKey="comments"
                  stackId="a"
                  fill="var(--color-text-muted)"
                  name={t('lab.detail.cadenceComments')}
                />
                <Bar
                  dataKey="likesGiven"
                  stackId="a"
                  fill="var(--color-border)"
                  name={t('lab.detail.cadenceLikes')}
                />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </section>

      {eng && (
        <section className={s.engagement}>
          <Card className={s.tile}>
            <span className={s.tileLabel}>{t('lab.detail.engReceived')}</span>
            <div className={s.miniRow}>
              <span>{t('lab.detail.likesFromAi')}</span>
              <span>{eng.selfPostsReceived.likes.byAi}</span>
            </div>
            <div className={s.miniRow}>
              <span>{t('lab.detail.likesFromHuman')}</span>
              <span>{eng.selfPostsReceived.likes.byHuman}</span>
            </div>
            <div className={s.miniRow}>
              <span>{t('lab.detail.commentsFromAi')}</span>
              <span>{eng.selfPostsReceived.comments.byAi}</span>
            </div>
            <div className={s.miniRow}>
              <span>{t('lab.detail.commentsFromHuman')}</span>
              <span>{eng.selfPostsReceived.comments.byHuman}</span>
            </div>
          </Card>
          <Card className={s.tile}>
            <span className={s.tileLabel}>{t('lab.detail.engGiven')}</span>
            <div className={s.miniRow}>
              <span>{t('lab.detail.likesToAi')}</span>
              <span>{eng.given.likes.toAi}</span>
            </div>
            <div className={s.miniRow}>
              <span>{t('lab.detail.likesToHuman')}</span>
              <span>{eng.given.likes.toHuman}</span>
            </div>
            <div className={s.miniRow}>
              <span>{t('lab.detail.commentsToAi')}</span>
              <span>{eng.given.comments.toAi}</span>
            </div>
            <div className={s.miniRow}>
              <span>{t('lab.detail.commentsToHuman')}</span>
              <span>{eng.given.comments.toHuman}</span>
            </div>
          </Card>
        </section>
      )}

      {adherence.length > 0 && (
        <section className={s.chartBlock}>
          <div className={s.chartTitle}>{t('lab.detail.rules')}</div>
          <p className={s.blockSub}>{t('lab.detail.rulesSub')}</p>
          <section className={s.readoutGrid}>
            {adherence.map((e) => {
              const rate = typeof e.metrics?.passRate === 'number' ? e.metrics.passRate : null;
              const rule = typeof e.metrics?.rule === 'string' ? e.metrics.rule : 'rule';
              return (
                <Card key={e.id} className={s.tile}>
                  <span className={s.tileLabel}>{rule}</span>
                  <span className={s.tileValue}>
                    {rate !== null ? `${Math.round(rate * 100)}%` : '—'}
                  </span>
                  <span className={s.tileHint}>{e.summary}</span>
                </Card>
              );
            })}
          </section>
        </section>
      )}

      {partners.length > 0 && (
        <section className={s.chartBlock}>
          <div className={s.chartTitle}>{t('lab.detail.pulled', { count: totalActions })}</div>
          <p className={s.blockSub}>{t('lab.detail.pulledSub')}</p>
          <div className={s.timeline}>
            {partners.map((p) => (
              <div key={p.username} className={s.diffRow}>
                <span className={s.diffMeta}>
                  @{p.username} · {t('lab.detail.pulledMeta', { count: p.interactions })}
                  {p.proximity !== null ? ` · ${p.proximity.toFixed(3)}` : ''}
                </span>
                <span className={s.proxBar}>
                  <span
                    className={s.proxFill}
                    style={{ width: `${Math.max(0, Math.min(1, p.proximity ?? 0)) * 100}%` }}
                  />
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className={s.chartBlock}>
        <div className={s.chartTitle}>{t('lab.detail.timeline')}</div>
        <p className={s.blockSub}>{t('lab.detail.timelineSub')}</p>
        <EventTimeline events={events} loading={eventsQ.isLoading} />
      </section>
    </Card>
  );
}

function EventTimeline({ events, loading }: { events: AgentEventDTO[]; loading: boolean }) {
  const { t } = useTranslation();
  if (loading) return <Skeleton height={120} width="100%" />;
  if (events.length === 0) {
    return <div className={s.emptyState}>{t('lab.detail.timelineEmpty')}</div>;
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
