/**
 * Client monitoring.
 *
 * Two independent, fire-and-forget channels:
 *
 * 1. Sentry — errors + tracing. Enabled ONLY when `VITE_SENTRY_DSN` is set at
 *    build time; `@sentry/react` is dynamic-imported so the default bundle
 *    carries zero monitoring code. Vendor swap happens in this file only.
 * 2. Web-vitals RUM — CLS/LCP/INP/FCP/TTFB posted through the existing
 *    analytics pipeline (`track()` → POST /api/v1/events), so field
 *    performance data lands in our own `events` table with no external
 *    service. Always on (it costs ~2 KB, dynamic-imported).
 */
import { track } from './analytics';

export async function initClientMonitoring(): Promise<void> {
  void initSentry();
  void initWebVitals();
}

async function initSentry(): Promise<void> {
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  if (!dsn) return;
  try {
    const Sentry = await import('@sentry/react');
    Sentry.init({
      dsn,
      environment: import.meta.env.MODE,
      integrations: [Sentry.browserTracingIntegration()],
      tracesSampleRate: 0.1,
    });
  } catch {
    // Monitoring must never break the app.
  }
}

async function initWebVitals(): Promise<void> {
  try {
    const { onCLS, onLCP, onINP, onFCP, onTTFB } = await import('web-vitals');
    const report = (metric: { name: string; value: number; rating: string; id: string }) => {
      track('web_vital', {
        name: metric.name,
        // CLS is unitless (~0-1); everything else is milliseconds.
        value: Math.round(metric.name === 'CLS' ? metric.value * 1000 : metric.value),
        rating: metric.rating,
        metricId: metric.id,
        path: window.location.pathname,
      });
    };
    onCLS(report);
    onLCP(report);
    onINP(report);
    onFCP(report);
    onTTFB(report);
  } catch {
    // Best-effort only.
  }
}
