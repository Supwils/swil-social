import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDisplayText } from './useDisplayText';

describe('useDisplayText', () => {
  it('returns the fallback for short posts (<5 non-empty lines)', () => {
    const { result } = renderHook(() => useDisplayText('one\ntwo\nthree', 'fallback'));
    expect(result.current).toBe('fallback');
  });

  it('joins entirely-fragmented posts (>65% of lines ≤6 chars)', () => {
    const fragmented = '我\n是\n谁\n#\nAI\n#\nnow';
    const { result } = renderHook(() => useDisplayText(fragmented, 'orig'));
    expect(result.current).toBe('我是谁#AI#now');
  });

  it('joins runs of ≥4 short lines but keeps long lines intact', () => {
    const mixed = [
      'This is a normal paragraph.',
      '',
      '#',
      'mTOR',
      '#',
      '分子营养学',
      '',
      'Another paragraph with normal length.',
    ].join('\n');
    const { result } = renderHook(() => useDisplayText(mixed, 'orig'));
    expect(result.current).toContain('#mTOR#分子营养学');
    expect(result.current).toContain('This is a normal paragraph.');
    expect(result.current).toContain('Another paragraph with normal length.');
  });

  it('does NOT join runs shorter than 4 short lines', () => {
    // Need ≥5 non-empty lines to enter the case-2 branch at all
    const text = ['#', 'AI', 'normal long enough line', 'Another normal line', 'Closing line'].join('\n');
    const { result } = renderHook(() => useDisplayText(text, 'orig'));
    // First two short lines are <4 in a run, so they stay separate
    expect(result.current).toBe(text);
  });

  it('case-1 dominates when most lines are short — joins everything regardless of long-line breakers', () => {
    // 7 short + 1 long = 87.5% short — exceeds the 65% case-1 threshold,
    // so the whole post collapses without honoring the long-line breaker.
    const text = ['1', '2', '3', 'this line is longer than six chars', '4', '5', '6', '7'].join('\n');
    const { result } = renderHook(() => useDisplayText(text, 'orig'));
    expect(result.current).toBe('123this line is longer than six chars4567');
  });

  it('memoizes — same input produces same reference', () => {
    const { result, rerender } = renderHook(
      ({ text, fb }: { text: string; fb: string }) => useDisplayText(text, fb),
      { initialProps: { text: 'a\nb\nc\nd\ne', fb: 'orig' } },
    );
    const first = result.current;
    rerender({ text: 'a\nb\nc\nd\ne', fb: 'orig' });
    expect(result.current).toBe(first);
  });
});
