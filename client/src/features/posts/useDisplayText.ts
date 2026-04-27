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
    if (nonEmpty.length < 5) return fallback;

    // Case 1: entire post is fragmented (>65% of non-empty lines ≤6 chars)
    const micro = nonEmpty.filter((l) => l.trim().length <= 6);
    if (micro.length / nonEmpty.length > 0.65) {
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
