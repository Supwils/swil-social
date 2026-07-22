import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useSearchParams, Link } from 'react-router-dom';
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  ComposedChart,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  ReferenceLine,
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
  getPopulationPulse,
  listLabAgents,
} from '@/api/agents';
import type { AgentEventDTO } from '@/api/types';
import { Sparkline } from '@/features/lab/Sparkline';
import { InteractionGraph } from '@/features/lab/InteractionGraph';
import { PopulationHealth } from '@/features/lab/PopulationHealth';
import { DistributionPanel } from '@/features/lab/DistributionPanel';
import { BenchmarkView } from '@/features/lab/BenchmarkView';
import { CrossSpeciesPanel } from '@/features/lab/CrossSpeciesPanel';
import { mean, median, zScore } from '@/features/lab/stats';
import { track } from '@/lib/analytics';
import type { LabCohort } from '@/api/types';
import s from './lab.module.css';

export default function LabRoute() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const focusedUsername = params.get('agent');
  const [liveMode, setLiveMode] = useState(false);
  const [cohortFilter, setCohortFilter] = useState<LabCohort | 'all'>('all');

  useEffect(() => {
    track('lab:view', { focused: focusedUsername ?? null });
  }, [focusedUsername]);

  const liveRefetchInterval = liveMode ? 30_000 : false;
  const liveStaleTime = liveMode ? 25_000 : 60_000;

  const agentsQ = useQuery({
    queryKey: ['lab-agents'],
    queryFn: () => listLabAgents(100),
    staleTime: liveStaleTime,
    refetchInterval: liveRefetchInterval,
  });
  const overviewQ = useQuery({
    queryKey: ['lab-overview'],
    queryFn: getAgentOverview,
    staleTime: liveStaleTime,
    refetchInterval: liveRefetchInterval,
  });

  const viewParam = params.get('view');
  const view: 'dashboard' | 'graph' | 'benchmark' =
    viewParam === 'graph' ? 'graph' : viewParam === 'benchmark' ? 'benchmark' : 'dashboard';
  const rangeParam = params.get('range');
  const range: '7d' | '30d' | '90d' =
    rangeParam === '7d' || rangeParam === '90d' ? rangeParam : '30d';

  const graphQ = useQuery({
    queryKey: ['lab-graph', range],
    queryFn: () => getInteractionGraph(range),
    staleTime: liveMode ? 25_000 : 120_000,
    refetchInterval: liveRefetchInterval,
    enabled: view === 'dashboard',
  });

  const setRange = (r: '7d' | '30d' | '90d') => {
    const next = new URLSearchParams(params);
    if (r === '30d') next.delete('range');
    else next.set('range', r);
    setParams(next, { replace: true });
  };

  const setFocused = (u: string | null) => {
    const next = new URLSearchParams(params);
    if (u) next.set('agent', u);
    else next.delete('agent');
    setParams(next, { replace: true });
  };

  const setView = (v: 'dashboard' | 'graph' | 'benchmark') => {
    const next = new URLSearchParams(params);
    if (v === 'dashboard') next.delete('view');
    else next.set('view', v);
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
        <div className={s.headerActions}>
          {view === 'dashboard' && (
            <div className={s.rangeControl} role="group" aria-label={t('lab.range.label')}>
              {(['7d', '30d', '90d'] as const).map((r) => (
                <button
                  key={r}
                  className={`${s.rangeBtn} ${range === r ? s.rangeBtnActive : ''}`}
                  onClick={() => setRange(r)}
                >
                  {t(`lab.range.${r}`)}
                </button>
              ))}
            </div>
          )}
          <button
            className={`${s.liveBtn} ${liveMode ? s.liveBtnActive : ''}`}
            onClick={() => setLiveMode((v) => !v)}
            title={t('lab.live.tip')}
          >
            <span className={liveMode ? s.liveDot : s.liveDotOff} />
            {liveMode ? t('lab.live.on') : t('lab.live.off')}
          </button>
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
        <button
          className={`${s.tab} ${view === 'benchmark' ? s.tabActive : ''}`}
          onClick={() => setView('benchmark')}
        >
          {t('lab.tabBenchmark')}
        </button>
      </nav>

      {view === 'graph' ? (
        <GraphView onSelect={focusFromGraph} />
      ) : view === 'benchmark' ? (
        <BenchmarkView />
      ) : (
        <>
          <AlertsStrip onSelect={setFocused} />
          <PopulationHealth range={range} agents={agentsQ.data ?? []} />
          <PopulationInsights
            overviewQ={overviewQ}
            agents={agentsQ.data ?? []}
            range={range}
            onSelect={setFocused}
          />
          <DistributionPanel agents={agentsQ.data ?? []} onSelect={setFocused} />
          {graphQ.data && (
            <CrossSpeciesPanel data={graphQ.data} onSelect={setFocused} />
          )}
          <Overview overviewQ={overviewQ} agents={agentsQ.data ?? []} />
          <HomogenizationPanel range={range} />
          {focusedUsername && (
            <AgentDetail username={focusedUsername} onClose={() => setFocused(null)} />
          )}
          <div className={s.cohortRow}>
            <div className={s.rangeControl} role="group" aria-label={t('lab.cohort.label')}>
              {(['all', 'first-party', 'community', 'human'] as const).map((c) => {
                const n =
                  c === 'all'
                    ? (agentsQ.data?.length ?? 0)
                    : (agentsQ.data?.filter((a) => a.cohort === c).length ?? 0);
                const key = c === 'first-party' ? 'firstParty' : c;
                return (
                  <button
                    key={c}
                    type="button"
                    className={`${s.rangeBtn} ${cohortFilter === c ? s.rangeBtnActive : ''}`}
                    onClick={() => setCohortFilter(c)}
                  >
                    {t(`lab.cohort.${key}`)} ({n})
                  </button>
                );
              })}
            </div>
          </div>
          <AgentGrid
            agents={(agentsQ.data ?? []).filter(
              (a) => cohortFilter === 'all' || a.cohort === cohortFilter,
            )}
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
  const [crossOnly, setCrossOnly] = useState(false);
  const graphQ = useQuery({
    queryKey: ['lab-graph', range],
    queryFn: () => getInteractionGraph(range),
    staleTime: 60_000,
  });

  return (
    <section className={s.chartBlock}>
      <div className={s.chartTitle}>{t('lab.graph.title')}</div>
      <p className={s.blockSub}>{t('lab.graph.subtitle')}</p>
      <div className={s.graphControls}>
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
        <button
          className={`${s.crossToggle} ${crossOnly ? s.crossToggleActive : ''}`}
          onClick={() => setCrossOnly((v) => !v)}
          title={t('lab.graph.crossToggleTip')}
        >
          {t('lab.graph.crossToggle')}
        </button>
      </div>
      {graphQ.isLoading ? (
        <Skeleton height={560} width="100%" />
      ) : graphQ.data ? (
        <InteractionGraph data={graphQ.data} onSelect={onSelect} crossSpeciesOnly={crossOnly} />
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

type ConclusionTone = 'good' | 'warn' | 'bad' | 'neutral';
interface Conclusion {
  key: string;
  tone: ConclusionTone;
  rank: number;
  tag: string;
  title: string;
  detail: string;
  focus?: string | null;
}

const TONE_RANK: Record<ConclusionTone, number> = { bad: 4, warn: 3, good: 2, neutral: 1 };

/**
 * Population Insights — a Watchdog-style insight feed. An auto-generated, ranked
 * set of typed conclusions (monoculture trend, AI↔human cohort gap, fidelity /
 * drift outliers via z-score, activity anomalies, rejected-dream clusters, echo
 * chambers) each phrased as a plain-language verdict with evidence + severity.
 * The ecosystem verdict (monoculture) is pinned first; the rest sort by severity
 * and cap so the feed reads as intelligent signal, not noise.
 */
function PopulationInsights({
  overviewQ,
  agents,
  range,
  onSelect,
}: {
  overviewQ: ReturnType<typeof useQuery<Awaited<ReturnType<typeof getAgentOverview>>>>;
  agents: Awaited<ReturnType<typeof listLabAgents>>;
  range: '7d' | '30d' | '90d';
  onSelect: (u: string) => void;
}) {
  const { t } = useTranslation();
  const homogQ = useQuery({
    queryKey: ['lab-homogenization', range],
    queryFn: () => getHomogenization(range),
    staleTime: 60_000,
  });
  const pulseQ = useQuery({
    queryKey: ['lab-pulse', range],
    queryFn: () => getPopulationPulse(range),
    staleTime: 60_000,
  });
  const alertsQ = useQuery({
    queryKey: ['lab-alerts', range],
    queryFn: () => getAlerts(range),
    staleTime: 60_000,
  });

  const conclusions = useMemo<Conclusion[]>(() => {
    let mono: Conclusion;
    const rest: Conclusion[] = [];

    // — Ecosystem verdict: monoculture watch (behavior-cohesion trend), pinned.
    const pts = homogQ.data?.points ?? [];
    const monoTag = t('lab.conclusions.monoTag');
    if (pts.length >= 2) {
      const first = pts[0].behaviorCohesion;
      const last = pts[pts.length - 1].behaviorCohesion;
      const delta = last - first;
      const deltaStr = `${delta >= 0 ? '▲' : '▼'}${Math.abs(delta).toFixed(3)}`;
      const detail = t('lab.conclusions.monoDetail', { value: last.toFixed(3), delta: deltaStr });
      if (delta > 0.01) {
        mono = { key: 'mono', tone: delta > 0.04 ? 'bad' : 'warn', rank: 5, tag: monoTag, title: t('lab.conclusions.convergingTitle'), detail };
      } else if (delta < -0.01) {
        mono = { key: 'mono', tone: 'good', rank: 5, tag: monoTag, title: t('lab.conclusions.divergingTitle'), detail };
      } else {
        mono = { key: 'mono', tone: 'neutral', rank: 5, tag: monoTag, title: t('lab.conclusions.steadyTitle'), detail };
      }
    } else {
      mono = { key: 'mono', tone: 'neutral', rank: 5, tag: monoTag, title: t('lab.conclusions.steadyTitle'), detail: t('lab.conclusions.monoWaiting') };
    }

    const rated = agents.filter(
      (a): a is typeof a & { currentFidelity: number } => typeof a.currentFidelity === 'number',
    );
    const fids = rated.map((a) => a.currentFidelity);

    // — Fidelity outlier / most off-character (z-score against peers).
    if (rated.length > 0) {
      const worst = rated.reduce((m, a) => (a.currentFidelity < m.currentFidelity ? a : m));
      const z = zScore(worst.currentFidelity, fids);
      const isOutlier = z <= -1.5;
      rest.push({
        key: 'fidelity',
        tone: worst.currentFidelity < 0.7 ? 'bad' : worst.currentFidelity < 0.8 ? 'warn' : 'good',
        rank: isOutlier ? 4 : 3,
        tag: t('lab.conclusions.fidelityTag'),
        title: isOutlier
          ? t('lab.conclusions.fidOutlierTitle', { username: worst.username, sigma: Math.abs(z).toFixed(1) })
          : t('lab.conclusions.offCharTitle', { username: worst.username }),
        detail: t('lab.conclusions.offCharDetail', { value: worst.currentFidelity.toFixed(3) }),
        focus: worst.username,
      });
    }

    // — AI ↔ human cohort fidelity gap.
    const aiFids = rated.filter((a) => a.isAgent).map((a) => a.currentFidelity);
    const humanFids = rated.filter((a) => !a.isAgent).map((a) => a.currentFidelity);
    if (aiFids.length >= 2 && humanFids.length >= 2) {
      const ma = median(aiFids);
      const mh = median(humanFids);
      const gap = ma - mh;
      if (Math.abs(gap) >= 0.03) {
        rest.push({
          key: 'cohort',
          tone: Math.abs(gap) >= 0.08 ? 'warn' : 'neutral',
          rank: Math.abs(gap) >= 0.08 ? 3 : 2,
          tag: t('lab.conclusions.cohortTag'),
          title: gap < 0 ? t('lab.conclusions.cohortAiLower') : t('lab.conclusions.cohortAiHigher'),
          detail: t('lab.conclusions.cohortDetail', { ai: ma.toFixed(3), human: mh.toFixed(3) }),
        });
      }
    }

    // — Drift outlier / biggest mover (z-score against peers).
    const driftRated = agents
      .map((a) => ({ a, d: a.currentDriftFromAnchor }))
      .filter((x): x is { a: (typeof agents)[number]; d: number } => typeof x.d === 'number');
    if (driftRated.length > 0) {
      const top = driftRated.reduce((m, x) => (x.d > m.d ? x : m));
      const z = zScore(top.d, driftRated.map((x) => x.d));
      const isOutlier = z >= 1.5;
      rest.push({
        key: 'drift',
        tone: isOutlier ? 'warn' : top.d > 0.15 ? 'warn' : 'neutral',
        rank: isOutlier ? 4 : 2,
        tag: t('lab.conclusions.driftTag'),
        title: isOutlier
          ? t('lab.conclusions.driftOutlierTitle', { username: top.a.username, sigma: z.toFixed(1) })
          : t('lab.conclusions.drifterTitle', { username: top.a.username }),
        detail: t('lab.conclusions.drifterDetail', { value: top.d.toFixed(3) }),
        focus: top.a.username,
      });
    }

    // — Activity anomaly (recent day vs trailing baseline).
    const acts = (pulseQ.data?.points ?? []).map((p) => p.actions);
    const nonZero = acts.filter((x) => x > 0);
    if (nonZero.length >= 4) {
      const recent = acts[acts.length - 1];
      const baseline = mean(acts.slice(0, -1).filter((x) => x > 0));
      if (baseline > 0 && recent >= baseline * 1.5) {
        rest.push({
          key: 'activity',
          tone: 'neutral',
          rank: 2,
          tag: t('lab.conclusions.activityTag'),
          title: t('lab.conclusions.activityUp', { pct: Math.round((recent / baseline - 1) * 100) }),
          detail: t('lab.conclusions.activityDetail', { recent, baseline: Math.round(baseline) }),
        });
      } else if (baseline > 0 && recent > 0 && recent <= baseline * 0.5) {
        rest.push({
          key: 'activity',
          tone: 'neutral',
          rank: 2,
          tag: t('lab.conclusions.activityTag'),
          title: t('lab.conclusions.activityDown', { pct: Math.round((1 - recent / baseline) * 100) }),
          detail: t('lab.conclusions.activityDetail', { recent, baseline: Math.round(baseline) }),
        });
      }
    }

    // — Rejected-dream cluster (anchor strain across the population).
    const dreamFails = (alertsQ.data?.alerts ?? []).filter((a) => a.kind === 'dream_rejected');
    if (dreamFails.length >= 3) {
      rest.push({
        key: 'dreams',
        tone: 'warn',
        rank: 3,
        tag: t('lab.conclusions.dreamTag'),
        title: t('lab.conclusions.dreamTitle', { count: dreamFails.length }),
        detail: dreamFails.slice(0, 4).map((a) => `@${a.username}`).join(' · '),
        focus: dreamFails[0].username,
      });
    }

    // — Echo-chamber roll-up.
    const flags = overviewQ.data?.echoChamberFlags ?? [];
    if (flags.length > 0) {
      rest.push({
        key: 'echo',
        tone: 'warn',
        rank: 3,
        tag: t('lab.conclusions.echoTag'),
        title: t('lab.conclusions.echoTitle', { count: flags.length }),
        detail: flags.map((u) => `@${u}`).join(' · '),
        focus: flags[0],
      });
    } else {
      rest.push({
        key: 'echo',
        tone: 'good',
        rank: 2,
        tag: t('lab.conclusions.echoTag'),
        title: t('lab.conclusions.echoNone'),
        detail: '',
      });
    }

    rest.sort((a, b) => b.rank - a.rank || TONE_RANK[b.tone] - TONE_RANK[a.tone]);
    return [mono, ...rest].slice(0, 6);
  }, [homogQ.data, pulseQ.data, alertsQ.data, overviewQ.data, agents, t]);

  if (overviewQ.isLoading) {
    return <Skeleton height={96} width="100%" />;
  }

  return (
    <section className={s.conclusions}>
      {conclusions.map((c) => {
        const clickable = Boolean(c.focus);
        return (
          <button
            key={c.key}
            type="button"
            className={`${s.conclusion} ${s[`conc_${c.tone}`] ?? ''} ${clickable ? s.concClickable : ''}`}
            onClick={() => c.focus && onSelect(c.focus)}
            disabled={!clickable}
          >
            <span className={s.concTag}>{c.tag}</span>
            <span className={s.concTitle}>{c.title}</span>
            {c.detail && <span className={s.concDetail}>{c.detail}</span>}
          </button>
        );
      })}
    </section>
  );
}

function HomogenizationPanel({ range }: { range: '7d' | '30d' | '90d' }) {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ['lab-homogenization', range],
    queryFn: () => getHomogenization(range),
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
  agents,
}: {
  overviewQ: ReturnType<typeof useQuery<Awaited<ReturnType<typeof getAgentOverview>>>>;
  agents: Awaited<ReturnType<typeof listLabAgents>>;
}) {
  const { t } = useTranslation();
  const d = overviewQ.data;
  // Population persona-fidelity ranking — lowest first (stated self ≠ revealed self).
  const offCharacter = useMemo(
    () =>
      agents
        .filter(
          (a): a is typeof a & { currentFidelity: number } =>
            typeof a.currentFidelity === 'number',
        )
        .sort((a, b) => a.currentFidelity - b.currentFidelity)
        .slice(0, 8),
    [agents],
  );
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
          <Card className={s.insightCard}>
            <div className={s.chartTitle}>{t('lab.insights.offChar')}</div>
            <RankList
              items={offCharacter.map((a) => ({
                username: a.username,
                label: a.displayName,
                value: a.currentFidelity.toFixed(3),
              }))}
              empty={t('lab.insights.offCharEmpty')}
            />
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
  const fidelity = agent.currentFidelity;
  const fidelityTone =
    fidelity === null ? '' : fidelity < 0.7 ? s.statBad : fidelity < 0.8 ? s.statWarn : s.statGood;
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
        {agent.cohort === 'community' && (
          <span className={`${s.tag} ${s.tagCommunity}`}>{t('lab.cohort.community')}</span>
        )}
      </div>
      <div className={s.cardStats}>
        <div className={s.cardStat}>
          <span className={s.cardStatValue}>{drift !== null ? drift.toFixed(3) : '—'}</span>
          <span>{t('lab.card.drift')}</span>
        </div>
        <div className={s.cardStat}>
          <span className={`${s.cardStatValue} ${fidelityTone}`}>
            {fidelity !== null ? fidelity.toFixed(2) : '—'}
          </span>
          <span>{t('lab.card.fidelity')}</span>
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

  // Causal overlay: merge daily activity (bars) with drift-from-anchor (line) on
  // a shared date axis so activity spikes can be read against drift movement.
  const causalSeries = useMemo(() => {
    const inf = influencesQ.data;
    if (!inf) return [];
    const byDate = new Map<string, { date: string; actions: number; drift: number | null }>();
    for (const a of inf.activity) byDate.set(a.date, { date: a.date, actions: a.actions, drift: null });
    for (const d of inf.drift) {
      const day = d.capturedAt.slice(0, 10);
      const row = byDate.get(day) ?? { date: day, actions: 0, drift: null };
      row.drift = d.distanceFromAnchor;
      byDate.set(day, row);
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }, [influencesQ.data]);
  const causalHasDrift = causalSeries.some((p) => p.drift !== null);

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
  // Per-aspect sim trajectory — only points that carry aspect data (new dreams).
  const aspectSeries = useMemo(
    () =>
      (driftQ.data ?? [])
        .filter((p) => p.aspects)
        .map((p) => ({
          x: p.capturedAt.slice(0, 10),
          values: p.aspects!.values,
          style: p.aspects!.style,
          topic: p.aspects!.topic,
        })),
    [driftQ.data],
  );
  const aspectMode = useMemo(() => {
    const withAspects = (driftQ.data ?? []).filter((p) => p.aspects);
    return withAspects.length > 0 ? withAspects[withAspects.length - 1].aspects!.mode : null;
  }, [driftQ.data]);
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

      {aspectMode && (
        <section className={s.chartBlock}>
          <div className={s.chartTitle}>
            {t('lab.detail.aspectChart')}{' '}
            <span className={s.modeBadge}>
              {aspectMode === 'aspect'
                ? t('lab.detail.aspectModeAspect')
                : t('lab.detail.aspectModeShadow')}
            </span>
          </div>
          <p className={s.blockSub}>{t('lab.detail.aspectSub')}</p>
          <div className={s.chartHeight}>
            {aspectSeries.length < 2 ? (
              <div className={s.emptyState}>{t('lab.detail.aspectEmpty')}</div>
            ) : (
              <ResponsiveContainer>
                <LineChart data={aspectSeries} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
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
                  {/* Default reject thresholds (mirror dream.sh defaults 0.88/0.80/0.70). */}
                  <ReferenceLine y={0.88} stroke="var(--color-accent)" strokeDasharray="4 4" strokeOpacity={0.5} />
                  <ReferenceLine y={0.8} stroke="#e0a458" strokeDasharray="4 4" strokeOpacity={0.5} />
                  <ReferenceLine y={0.7} stroke="var(--color-text-muted)" strokeDasharray="4 4" strokeOpacity={0.5} />
                  <Line
                    type="monotone"
                    dataKey="values"
                    name={t('lab.detail.aspectValues')}
                    stroke="var(--color-accent)"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="style"
                    name={t('lab.detail.aspectStyle')}
                    stroke="#e0a458"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="topic"
                    name={t('lab.detail.aspectTopic')}
                    stroke="var(--color-text-muted)"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </section>
      )}

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

      <section className={s.chartBlock}>
        <div className={s.chartTitle}>{t('lab.detail.causal')}</div>
        <p className={s.blockSub}>{t('lab.detail.causalSub')}</p>
        <div className={s.chartHeight}>
          {causalSeries.length < 2 ? (
            <div className={s.emptyState}>{t('lab.detail.causalEmpty')}</div>
          ) : (
            <ResponsiveContainer>
              <ComposedChart data={causalSeries} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
                <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" stroke="var(--color-text-muted)" fontSize={10} interval="preserveStartEnd" />
                <YAxis
                  yAxisId="actions"
                  stroke="var(--color-text-muted)"
                  fontSize={11}
                  allowDecimals={false}
                />
                <YAxis
                  yAxisId="drift"
                  orientation="right"
                  stroke="var(--color-text-muted)"
                  fontSize={11}
                  domain={[0, 'auto']}
                />
                <Tooltip
                  contentStyle={{
                    background: 'var(--color-surface)',
                    border: '1px solid var(--color-border)',
                    fontSize: 12,
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar
                  yAxisId="actions"
                  dataKey="actions"
                  name={t('lab.detail.causalActions')}
                  fill="var(--color-border-strong)"
                  isAnimationActive={false}
                />
                {causalHasDrift && (
                  <Line
                    yAxisId="drift"
                    type="monotone"
                    dataKey="drift"
                    name={t('lab.detail.causalDrift')}
                    stroke="var(--color-accent)"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                    connectNulls
                    isAnimationActive={false}
                  />
                )}
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>
      </section>

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
