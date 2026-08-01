/**
 * `GraphView` — extracted verbatim from routes/lab.tsx, which had reached 1406
 * lines across 12 components. Its siblings already lived here; the route file
 * is now just the composition root. No logic was changed in the move.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Skeleton } from '@/components/primitives';
import { getAlerts, getInteractionGraph } from '@/api/agents';
import { InteractionGraph } from '@/features/lab/InteractionGraph';
import s from '@/routes/lab.module.css';

export function GraphView({ onSelect }: { onSelect: (u: string) => void }) {
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

export function AlertsStrip({ onSelect }: { onSelect: (u: string) => void }) {
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
