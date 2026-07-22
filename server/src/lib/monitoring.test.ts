import { describe, expect, it } from 'vitest';
import { captureException, initMonitoring } from './monitoring';

// SENTRY_DSN is unset in the test env, so every call must be a silent no-op —
// the app runs with zero telemetry and nothing throws.
describe('monitoring (disabled without SENTRY_DSN)', () => {
  it('initMonitoring resolves without initializing anything', async () => {
    await expect(initMonitoring()).resolves.toBeUndefined();
  });

  it('captureException swallows everything', async () => {
    await expect(captureException(new Error('boom'))).resolves.toBeUndefined();
    await expect(captureException('not-an-error')).resolves.toBeUndefined();
  });
});
