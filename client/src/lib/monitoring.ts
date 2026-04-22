/**
 * Client monitoring scaffolding.
 *
 * This is a stub. To enable Sentry in production:
 *
 *   1. `npm i @sentry/react`
 *   2. Replace the body of `initClientMonitoring` below with:
 *
 *        const dsn = import.meta.env.VITE_SENTRY_DSN;
 *        if (!dsn) return;
 *        const Sentry = await import('@sentry/react');
 *        Sentry.init({
 *          dsn,
 *          environment: import.meta.env.MODE,
 *          tracesSampleRate: 0.1,
 *        });
 *
 *   3. Set `VITE_SENTRY_DSN` at build time (CI secret, `.env.production`).
 *
 * Kept inert here so the default client build has zero monitoring-related
 * code and zero dependency cost. Vendor swap (Sentry → OpenTelemetry /
 * Axiom / Better Stack) happens at this file only.
 */
export async function initClientMonitoring(): Promise<void> {
  // No-op by default.
  return;
}
