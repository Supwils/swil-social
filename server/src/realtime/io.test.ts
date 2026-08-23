import { describe, expect, it } from 'vitest';
import { env } from '../config/env';
import { allowSocketOrigin } from './io';

describe('allowSocketOrigin', () => {
  it('allows a missing Origin (non-browser clients)', () => {
    expect(allowSocketOrigin(undefined)).toBe(true);
  });

  it('allows an origin on the CORS allowlist', () => {
    expect(env.CORS_ORIGINS.length).toBeGreaterThan(0);
    expect(allowSocketOrigin(env.CORS_ORIGINS[0])).toBe(true);
  });

  it('rejects an unknown origin', () => {
    expect(allowSocketOrigin('https://evil.example')).toBe(false);
  });

  it('allows the request host itself (same-origin deploy)', () => {
    expect(allowSocketOrigin('https://api.example.com', 'api.example.com')).toBe(true);
    expect(allowSocketOrigin('http://api.example.com', 'api.example.com')).toBe(true);
  });
});
