/**
 * Monitoring (Sentry).
 *
 * Env-gated: when `SENTRY_DSN` is unset every function here is a no-op and
 * the app runs with zero telemetry. `@sentry/node` is dynamic-imported so it
 * never sits on the cold-start path when disabled. Vendor swap (Axiom /
 * Better Stack / OpenTelemetry) happens in this file only.
 */
import { env, sentryEnabled } from '../config/env';
import { logger } from './logger';

type SentryModule = typeof import('@sentry/node');

let initialized = false;
let sentry: SentryModule | null = null;

export async function initMonitoring(): Promise<void> {
  if (initialized || !sentryEnabled) return;
  initialized = true;

  try {
    sentry = await import('@sentry/node');
    sentry.init({
      dsn: env.SENTRY_DSN,
      environment: env.NODE_ENV,
      tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
    });
    logger.info({ env: env.NODE_ENV }, 'sentry initialized');
  } catch (err) {
    sentry = null;
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
    if (!sentry) await initMonitoring();
    sentry?.captureException(err);
  } catch {
    /* no-op */
  }
}
