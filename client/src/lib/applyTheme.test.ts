import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { applyTheme, watchSystemTheme } from './applyTheme';

/**
 * `applyTheme` is the single writer of `data-theme`, which the whole CSS token
 * layer keys off. jsdom has no matchMedia, so it is stubbed per test — that
 * stub is also what lets the 'system' branch be driven both ways.
 */
function stubMatchMedia(prefersDark: boolean): { listeners: Array<() => void> } {
  const listeners: Array<() => void> = [];
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches: prefersDark,
      addEventListener: (_: string, fn: () => void) => listeners.push(fn),
      removeEventListener: (_: string, fn: () => void) => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      },
    }),
  );
  return { listeners };
}

describe('applyTheme', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes an explicit light preference through unchanged', () => {
    stubMatchMedia(true); // system says dark — an explicit choice must win
    applyTheme('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('writes an explicit dark preference through unchanged', () => {
    stubMatchMedia(false);
    applyTheme('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('resolves "system" to dark when the OS prefers dark', () => {
    stubMatchMedia(true);
    applyTheme('system');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('resolves "system" to light when the OS does not prefer dark', () => {
    stubMatchMedia(false);
    applyTheme('system');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('never leaves the attribute unset — always resolves to a concrete theme', () => {
    stubMatchMedia(false);
    applyTheme('system');
    const v = document.documentElement.getAttribute('data-theme');
    expect(v === 'light' || v === 'dark').toBe(true);
  });
});

describe('watchSystemTheme', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('invokes the callback when the OS preference changes', () => {
    const { listeners } = stubMatchMedia(false);
    const onChange = vi.fn();
    watchSystemTheme(onChange);

    expect(listeners).toHaveLength(1);
    listeners[0]();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('detaches the listener on dispose so it cannot leak across mounts', () => {
    const { listeners } = stubMatchMedia(false);
    const dispose = watchSystemTheme(vi.fn());
    expect(listeners).toHaveLength(1);

    dispose();
    expect(listeners).toHaveLength(0);
  });
});
