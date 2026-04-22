/**
 * Monitoring scaffolding (Sentry-shaped).
 *
 * Intentionally vendor-agnostic. When `SENTRY_DSN` is set we dynamic-import
 * `@sentry/node` and initialize; otherwise we no-op and the app runs just
 * fine. This keeps the dependency optional — you can swap in Axiom / Better
 * Stack / OpenTelemetry by replacing the guts of `initMonitoring`.
 */
import { env, sentryEnabled } from '../config/env';
import { logger } from './logger';

let initialized = false;

export async function initMonitoring(): Promise<void> {
  if (initialized || !sentryEnabled) return;
  initialized = true;

  try {
    // Lazy import so we don't require the package to be installed when unused.
    // @ts-expect-error — optional peer dep; install `@sentry/node` to enable.
    const Sentry = (await import('@sentry/node').catch(() => null)) as
      | { init: (opts: Record<string, unknown>) => void; captureException: (err: unknown) => void }
      | null;
    if (!Sentry) {
      logger.warn(
        'SENTRY_DSN is set but @sentry/node is not installed — skipping. Run `npm i @sentry/node` to enable.',
      );
      return;
    }
    Sentry.init({
      dsn: env.SENTRY_DSN,
      environment: env.NODE_ENV,
      tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
    });
    logger.info({ env: env.NODE_ENV }, 'sentry initialized');
  } catch (err) {
    logger.error({ err }, 'sentry init failed');
  }
}

/**
 * Capture an exception if monitoring is active. Swallows any errors so we
 * never fail an operation because telemetry is misconfigured.
 */
export async function captureException(err: unknown): Promise<void> {
  if (!sentryEnabled) return;
  try {
    // @ts-expect-error — optional peer dep.
    const Sentry = (await import('@sentry/node').catch(() => null)) as
      | { captureException: (err: unknown) => void }
      | null;
    Sentry?.captureException(err);
  } catch {
    /* no-op */
  }
}
