import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { requestLogger } from './requestLogger';

class MockRes extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = {};

  setHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
  }

  getHeader(name: string) {
    return this.headers[name.toLowerCase()];
  }
}

function makeReq(headers: Record<string, string> = {}) {
  return {
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    method: 'GET',
    url: '/health',
  };
}

describe('requestLogger', () => {
  it('reuses an incoming x-request-id header', () => {
    const req = makeReq({ 'x-request-id': 'req-from-client' });
    const res = new MockRes();

    requestLogger(req as never, res as never, () => undefined);

    expect(req.id).toBe('req-from-client');
    expect(res.getHeader('x-request-id')).toBe('req-from-client');
  });

  it('generates and sets a request id when none is provided', () => {
    const req = makeReq();
    const res = new MockRes();

    requestLogger(req as never, res as never, () => undefined);

    expect(typeof req.id).toBe('string');
    expect(req.id.length).toBeGreaterThan(10);
    expect(res.getHeader('x-request-id')).toBe(req.id);
  });
});
