import type { ThemePreference } from '@/stores/ui.store';

/**
 * Resolve the theme preference to an effective theme and apply it to the
 * document root via `data-theme`. The CSS token layer reads from this attr.
 */
export function applyTheme(pref: ThemePreference): void {
  const effective =
    pref === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : pref;
  document.documentElement.setAttribute('data-theme', effective);
}

export function watchSystemTheme(onChange: () => void): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = () => onChange();
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}
