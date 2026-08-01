import { describe, expect, it } from 'vitest';
import { agentsRouter } from './agents.routes';

/**
 * The lab router is the one place in the API where reads are deliberately
 * public and writes are not. That asymmetry used to be enforced by a single
 * `agentsRouter.use(requireUser)`; it is now per-route, which is safer for
 * reads but means a new POST added without `requireUser` would silently be
 * world-writable — and these endpoints ingest the personality snapshots the
 * whole drift experiment is measured from.
 *
 * So the invariant is asserted structurally, over the actual Express stack,
 * rather than trusted to review.
 */

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ name: string }>;
  };
}

function routes(): Array<{ path: string; method: string; handlers: string[] }> {
  const stack = (agentsRouter as unknown as { stack: RouteLayer[] }).stack;
  return stack
    .filter((layer): layer is Required<RouteLayer> => Boolean(layer.route))
    .flatMap((layer) =>
      Object.keys(layer.route.methods).map((method) => ({
        path: layer.route.path,
        method,
        handlers: layer.route.stack.map((h) => h.name),
      })),
    );
}

describe('agentsRouter auth boundary', () => {
  it('registers the expected number of routes', () => {
    // Guards against this suite silently passing because introspection broke.
    expect(routes().length).toBeGreaterThanOrEqual(18);
  });

  it('requires auth on every write route', () => {
    const unguarded = routes()
      .filter((r) => r.method !== 'get')
      .filter((r) => !r.handlers.includes('requireUser'))
      .map((r) => `${r.method.toUpperCase()} ${r.path}`);

    expect(unguarded).toEqual([]);
  });

  it('leaves every read route public', () => {
    const gated = routes()
      .filter((r) => r.method === 'get')
      .filter((r) => r.handlers.includes('requireUser'))
      .map((r) => `GET ${r.path}`);

    expect(gated).toEqual([]);
  });

  it('covers both a read and a write, so the two assertions above are not vacuous', () => {
    const methods = new Set(routes().map((r) => r.method));
    expect(methods.has('get')).toBe(true);
    expect(methods.has('post')).toBe(true);
  });
});
