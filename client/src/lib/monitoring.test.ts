import { beforeEach, describe, expect, it, vi } from 'vitest';

// Each web-vitals hook immediately invokes the callback with a fake metric so
// we can assert the full report path synchronously.
vi.mock('web-vitals', () => {
  const fire =
    (name: string, value: number) =>
    (cb: (m: { name: string; value: number; rating: string; id: string }) => void) =>
      cb({ name, value, rating: 'good', id: `${name}-1` });
  return {
    onCLS: fire('CLS', 0.05),
    onLCP: fire('LCP', 1200.4),
    onINP: fire('INP', 80),
    onFCP: fire('FCP', 900),
    onTTFB: fire('TTFB', 200),
  };
});

vi.mock('./analytics', () => ({ track: vi.fn() }));

import { track } from './analytics';
import { initClientMonitoring } from './monitoring';

describe('client monitoring', () => {
  beforeEach(() => {
    vi.mocked(track).mockClear();
  });

  it('reports all five web vitals through the analytics pipeline', async () => {
    await initClientMonitoring();
    // dynamic import + fire-and-forget — give the microtask queue a tick
    await new Promise((r) => setTimeout(r, 0));

    const calls = vi.mocked(track).mock.calls;
    const names = calls.map(([type, ctx]) => {
      expect(type).toBe('web_vital');
      return (ctx as { name: string }).name;
    });
    expect(names.sort()).toEqual(['CLS', 'FCP', 'INP', 'LCP', 'TTFB']);
  });

  it('scales CLS to integer milli-units and rounds ms metrics', async () => {
    await initClientMonitoring();
    await new Promise((r) => setTimeout(r, 0));

    const byName = new Map(
      vi.mocked(track).mock.calls.map(([, ctx]) => {
        const c = ctx as { name: string; value: number };
        return [c.name, c.value];
      }),
    );
    expect(byName.get('CLS')).toBe(50); // 0.05 × 1000
    expect(byName.get('LCP')).toBe(1200); // rounded
  });
});
