import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { getRuntimeHealth } from '@/api/agents';
import type { RuntimeHealthDTO } from '@/api/types';
import { Skeleton } from '@/components/primitives';
import { Sparkline } from './Sparkline';
import { periodDelta } from './stats';
import s from '@/routes/lab.module.css';

type Status = 'good' | 'warn' | 'bad' | 'neutral';
type Range = '7d' | '30d' | '90d';

interface Signal {
  key: string;
  label: string;
  hint: string;
  value: string;
  status: Status;
  higherIsBetter: boolean | null;
  pct: number | null;
  spark: Array<{ v: number }>;
  sparkColor: string;
}

/**
 * Strip status (spec §13): fail-open or missing-samples > 0 → warn;
 * rounds = 0 → neutral; otherwise good. Per-card tints follow the same
 * rule on the card that owns the number.
 */
export function runtimeStripStatus(dto: RuntimeHealthDTO): Status {
  if (dto.failOpenGates > 0 || dto.missingSamples > 0) return 'warn';
  if (dto.rounds === 0) return 'neutral';
  return 'good';
}

function cardStatus(warnCount: number | null, rounds: number): Status {
  if (warnCount !== null && warnCount > 0) return 'warn';
  return rounds === 0 ? 'neutral' : 'good';
}

/**
 * Runtime Health — a sibling golden-signal strip above PopulationHealth.
 * Four cycle-engine vitals (Rounds, Fail-open gates, Missing samples,
 * Landed actions) backed by `GET /agents/runtime`. No new view, no new route.
 */
export function RuntimeHealth({ range }: { range: Range }) {
  const { t } = useTranslation();
  const runtimeQ = useQuery({
    queryKey: ['lab-runtime', range],
    queryFn: () => getRuntimeHealth(range),
    staleTime: 60_000,
  });

  const signals = useMemo<Signal[]>(() => {
    const dto = runtimeQ.data;
    const pts = dto?.points ?? [];
    const rounds = dto?.rounds ?? 0;
    const failOpen = dto?.failOpenGates ?? 0;
    const missing = dto?.missingSamples ?? 0;
    const landed = dto?.landedActions ?? 0;

    const roundSeries = pts.map((p) => p.rounds);
    const failSeries = pts.map((p) => p.failOpen);
    const missSeries = pts.map((p) => p.missingSamples);
    const landSeries = pts.map((p) => p.landed);

    return [
      {
        key: 'rounds',
        label: t('lab.runtime.rounds'),
        hint: t('lab.runtime.roundsHint'),
        value: String(rounds),
        status: cardStatus(null, rounds),
        higherIsBetter: null,
        pct: periodDelta(roundSeries).pct,
        spark: roundSeries.map((v) => ({ v })),
        sparkColor: 'var(--color-border-strong)',
      },
      {
        key: 'failOpen',
        label: t('lab.runtime.failOpen'),
        hint: t('lab.runtime.failOpenHint'),
        value: String(failOpen),
        status: cardStatus(failOpen, rounds),
        higherIsBetter: false,
        pct: periodDelta(failSeries).pct,
        spark: failSeries.map((v) => ({ v })),
        sparkColor: 'var(--color-warning)',
      },
      {
        key: 'missing',
        label: t('lab.runtime.missing'),
        hint: t('lab.runtime.missingHint'),
        value: String(missing),
        status: cardStatus(missing, rounds),
        higherIsBetter: false,
        pct: periodDelta(missSeries).pct,
        spark: missSeries.map((v) => ({ v })),
        sparkColor: 'var(--color-warning)',
      },
      {
        key: 'landed',
        label: t('lab.runtime.landed'),
        hint: t('lab.runtime.landedHint'),
        value: String(landed),
        status: 'neutral',
        higherIsBetter: null,
        pct: periodDelta(landSeries).pct,
        spark: landSeries.map((v) => ({ v })),
        sparkColor: 'var(--color-border-strong)',
      },
    ];
  }, [runtimeQ.data, t]);

  const composite = runtimeQ.data ? runtimeStripStatus(runtimeQ.data) : 'neutral';

  if (runtimeQ.isLoading) return <Skeleton height={150} width="100%" />;

  const verdictLabel =
    composite === 'warn'
      ? t('lab.runtime.watch')
      : composite === 'neutral'
        ? t('lab.runtime.idle')
        : t('lab.runtime.healthy');

  return (
    <section className={s.health}>
      <div className={s.healthHead}>
        <span className={`${s.healthDot} ${s[`hdot_${composite}`] ?? ''}`} />
        <span className={s.healthVerdict}>{verdictLabel}</span>
        <span className={s.healthSub}>{t('lab.runtime.sub')}</span>
      </div>
      <div className={s.signalGrid}>
        {signals.map((sig) => (
          <div
            key={sig.key}
            className={`${s.signal} ${s[`sig_${sig.status}`] ?? ''}`}
            data-signal={sig.key}
            data-status={sig.status}
          >
            <div className={s.signalTop}>
              <span className={s.signalLabel}>{sig.label}</span>
              <DeltaChip pct={sig.pct} higherIsBetter={sig.higherIsBetter} />
            </div>
            <span className={s.signalValue}>{sig.value}</span>
            <span className={s.signalHint}>{sig.hint}</span>
            <div className={s.signalSpark}>
              <Sparkline data={sig.spark} color={sig.sparkColor} strokeWidth={1.5} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function DeltaChip({
  pct,
  higherIsBetter,
}: {
  pct: number | null;
  higherIsBetter: boolean | null;
}) {
  if (pct === null || Math.abs(pct) < 0.05) {
    return <span className={`${s.delta} ${s.deltaFlat}`}>—</span>;
  }
  const up = pct > 0;
  let tone = s.deltaFlat;
  if (higherIsBetter !== null) {
    const good = higherIsBetter ? up : !up;
    tone = good ? s.deltaGood : s.deltaBad;
  }
  return (
    <span className={`${s.delta} ${tone}`}>
      {up ? '▲' : '▼'} {Math.abs(pct).toFixed(1)}%
    </span>
  );
}
