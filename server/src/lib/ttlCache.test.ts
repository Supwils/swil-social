import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TTLCache } from './ttlCache';

describe('TTLCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns undefined for missing keys', () => {
    const c = new TTLCache<string, number>(1000);
    expect(c.get('x')).toBeUndefined();
  });

  it('returns set values within the TTL window', () => {
    const c = new TTLCache<string, number>(1000);
    c.set('x', 42);
    expect(c.get('x')).toBe(42);
  });

  it('expires values after the TTL elapses', () => {
    const c = new TTLCache<string, number>(1000);
    c.set('x', 42);
    vi.advanceTimersByTime(1001);
    expect(c.get('x')).toBeUndefined();
  });

  it('does not expire values just before the TTL boundary', () => {
    const c = new TTLCache<string, number>(1000);
    c.set('x', 42);
    vi.advanceTimersByTime(999);
    expect(c.get('x')).toBe(42);
  });

  it('delete removes a single entry', () => {
    const c = new TTLCache<string, number>(1000);
    c.set('x', 1);
    c.set('y', 2);
    c.delete('x');
    expect(c.get('x')).toBeUndefined();
    expect(c.get('y')).toBe(2);
  });

  it('clear removes everything', () => {
    const c = new TTLCache<string, number>(1000);
    c.set('a', 1);
    c.set('b', 2);
    c.clear();
    expect(c.get('a')).toBeUndefined();
    expect(c.get('b')).toBeUndefined();
  });

  describe('getOrLoad', () => {
    it('runs the loader on miss and caches the result', async () => {
      const c = new TTLCache<string, number>(1000);
      const loader = vi.fn().mockResolvedValue(42);
      const v = await c.getOrLoad('x', loader);
      expect(v).toBe(42);
      expect(loader).toHaveBeenCalledTimes(1);
    });

    it('skips the loader on hit', async () => {
      const c = new TTLCache<string, number>(1000);
      const loader = vi.fn().mockResolvedValue(42);
      await c.getOrLoad('x', loader);
      const v = await c.getOrLoad('x', loader);
      expect(v).toBe(42);
      expect(loader).toHaveBeenCalledTimes(1);
    });

    it('re-runs loader after TTL expiry', async () => {
      const c = new TTLCache<string, number>(1000);
      const loader = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);
      const a = await c.getOrLoad('x', loader);
      vi.advanceTimersByTime(1001);
      const b = await c.getOrLoad('x', loader);
      expect(a).toBe(1);
      expect(b).toBe(2);
      expect(loader).toHaveBeenCalledTimes(2);
    });
  });
});
