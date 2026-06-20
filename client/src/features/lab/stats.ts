// Pure statistics helpers for the lab's population analytics — distributions,
// outlier detection (z-score), medians, and period-over-period deltas. Kept
// framework-free so they can be reused across the health header, distribution
// panel, and insight engine.

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

/** z-score of `x` against the sample; 0 when the sample has no spread. */
export function zScore(x: number, xs: number[]): number {
  const sd = stddev(xs);
  if (sd === 0) return 0;
  return (x - mean(xs)) / sd;
}

/** Last non-null value of a sparse series, or null if entirely empty. */
export function lastNonNull(xs: Array<number | null>): number | null {
  for (let i = xs.length - 1; i >= 0; i--) {
    if (xs[i] !== null) return xs[i];
  }
  return null;
}

/**
 * Period-over-period delta: compares the mean of the most recent half of the
 * series to the mean of the earlier half. Returns the absolute delta and the
 * signed percentage change (null when there isn't enough signal to compare).
 */
export function periodDelta(xs: Array<number | null>): { delta: number; pct: number | null } {
  const vals = xs.filter((x): x is number => x !== null);
  if (vals.length < 2) return { delta: 0, pct: null };
  const half = Math.floor(vals.length / 2);
  const prior = mean(vals.slice(0, half || 1));
  const recent = mean(vals.slice(half));
  const delta = recent - prior;
  const pct = prior !== 0 ? (delta / Math.abs(prior)) * 100 : null;
  return { delta, pct };
}

/** Clamp a value into [lo, hi]. */
export function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
