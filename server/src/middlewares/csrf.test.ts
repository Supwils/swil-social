import { describe, expect, it, vi } from 'vitest';
import { csrfOriginGuard } from './csrf';
import { AppError } from '../lib/errors';

vi.mock('../config/env', () => ({
  env: { CORS_ORIGINS: ['https://swilsocial.vercel.app', 'http://localhost:5947'] },
}));

function call(method: string, headers: Record<string, string> = {}) {
  const req = {
    method,
    get: (name: string) => headers[name.toLowerCase()],
  } as unknown as Parameters<typeof csrfOriginGuard>[0];
  const next = vi.fn();
  const run = () => csrfOriginGuard(req, {} as never, next);
  return { run, next };
}

describe('csrfOriginGuard', () => {
  it('rejects a state-changing request from an unknown origin', () => {
    const { run, next } = call('POST', { origin: 'https://evil.example' });
    expect(run).toThrow(AppError);
    expect(next).not.toHaveBeenCalled();
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('guards %s', (method) => {
    const { run } = call(method, { origin: 'https://evil.example' });
    expect(run).toThrow(/Cross-origin/);
  });

  it('allows an allowlisted origin', () => {
    const { run, next } = call('POST', { origin: 'https://swilsocial.vercel.app' });
    run();
    expect(next).toHaveBeenCalledOnce();
  });

  it('allows a request with no Origin — non-browser clients cannot be CSRF-ed', () => {
    // The agent runtime and the MCP server call the API from curl/node, which
    // sends no Origin. Requiring one would break them for no security gain.
    const { run, next } = call('POST');
    run();
    expect(next).toHaveBeenCalledOnce();
  });

  it('allows same-origin when the app serves the SPA itself', () => {
    const { run, next } = call('POST', { origin: 'https://swil.example', host: 'swil.example' });
    run();
    expect(next).toHaveBeenCalledOnce();
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('never blocks safe method %s', (method) => {
    const { run, next } = call(method, { origin: 'https://evil.example' });
    run();
    expect(next).toHaveBeenCalledOnce();
  });

  it('does not treat a host substring as same-origin', () => {
    // `https://swil.example.evil.com` must not pass because it ends with the host.
    const { run } = call('POST', {
      origin: 'https://swil.example.evil.com',
      host: 'swil.example',
    });
    expect(run).toThrow(/Cross-origin/);
  });
});
