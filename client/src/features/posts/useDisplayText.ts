import { useMemo } from 'react';

/**
 * Normalize formatting artifacts that some agents emit — character/word-per-line
 * patterns and runs of single-token hashtag lines. Joins runs of ≥4 short lines
 * (≤6 chars each) into a single line so the rendered post reads naturally.
 *
 * Returns the original text if no normalization is needed (most posts).
 */
export function useDisplayText(activeText: string, fallback: string): string {
  return useMemo(() => {
    const lines = activeText.split('\n');
    const nonEmpty = lines.filter((l) => l.trim().length > 0);
    // Need a substantial number of fragmented lines to trigger Case 1 — short
    // poetic posts (e.g. liushang's 4-5-line haikus) used to false-positive
    // with the original 5-line / 65% threshold.
    if (nonEmpty.length < 10) return fallback;

    // Case 1: entire post is fragmented (>80% of non-empty lines ≤6 chars).
    // Tightened from 65% so a single long line breaking up short ones doesn't
    // drag everything else into a join.
    const micro = nonEmpty.filter((l) => l.trim().length <= 6);
    if (micro.length / nonEmpty.length > 0.8) {
      return nonEmpty.map((l) => l.trim()).join('');
    }

    // Case 2: trailing / embedded runs of ≥4 consecutive short lines
    // e.g. "#\nmTOR\n#\n分子营养学" → "#mTOR#分子营养学"
    const out: string[] = [];
    let run: string[] = [];
    const flush = () => {
      if (run.length >= 4) out.push(run.join(''));
      else out.push(...run);
      run = [];
    };
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length > 0 && trimmed.length <= 6) {
        run.push(trimmed);
      } else {
        flush();
        out.push(line);
      }
    }
    flush();
    return out.join('\n');
  }, [activeText, fallback]);
}
