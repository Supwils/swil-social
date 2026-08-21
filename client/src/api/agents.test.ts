/**
 * Tests for the two lab reads added on 2026-08-20.
 *
 * WHY THE URL IS WORTH A TEST. Both endpoints default `range` to `30d`
 * server-side, so a request that dropped the caller's range would return a
 * plausible answer for the wrong window — and for the collapse watch the window
 * is not cosmetic: measured on `liushang`'s real posts the same collapse reads
 * -0.792 chars/day over its own 14 days, -0.046 over 30 (invisible), and +0.761
 * over 7 (the sign flips). A silently-30d request is a wrong answer that looks
 * right. The panel suites mock this module out, so nothing else covers it.
 *
 * The path is pinned for the same reason: the countdown route is
 * `/:username/drift-countdown`, not `/:username/countdown`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./client', () => ({ http: { get: vi.fn() } }));

import { http } from './client';
import { getCollapseWatch, getDriftCountdown, getRuntimeHealth } from './agents';

afterEach(() => {
  vi.clearAllMocks();
});

describe('lab reads carry the caller’s range', () => {
  it('asks the countdown endpoint for the range it was given', async () => {
    vi.mocked(http.get).mockResolvedValue({ data: { data: { username: 'liushang' } } });
    await getDriftCountdown('liushang', '90d');
    expect(vi.mocked(http.get).mock.calls[0][0]).toBe('/agents/liushang/drift-countdown?range=90d');
  });

  it('asks the collapse endpoint for the range it was given', async () => {
    vi.mocked(http.get).mockResolvedValue({ data: { data: { username: 'liushang' } } });
    await getCollapseWatch('liushang', '7d');
    expect(vi.mocked(http.get).mock.calls[0][0]).toBe('/agents/liushang/collapse?range=7d');
  });

  it('unwraps the envelope rather than returning it', async () => {
    const payload = { username: 'liushang', verdict: 'shrinking' };
    vi.mocked(http.get).mockResolvedValue({ data: { data: payload } });
    await expect(getCollapseWatch('liushang', '30d')).resolves.toBe(payload);
  });

  it('asks the runtime endpoint for the range it was given', async () => {
    vi.mocked(http.get).mockResolvedValue({ data: { data: { rounds: 17 } } });
    await getRuntimeHealth('7d');
    expect(vi.mocked(http.get).mock.calls[0][0]).toBe('/agents/runtime?range=7d');
  });
});
