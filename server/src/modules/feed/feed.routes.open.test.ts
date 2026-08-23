import { describe, expect, it } from 'vitest';
import { feedRouter } from './feed.routes';

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ name: string }>;
  };
}

function handlers(path: string, method: string): string[] {
  const stack = (feedRouter as unknown as { stack: RouteLayer[] }).stack;
  const layer = stack.find(
    (entry) => entry.route?.path === path && Boolean(entry.route.methods[method]),
  );
  if (!layer?.route) throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  return layer.route.stack.map((h) => h.name);
}

describe('feedRouter explore reads', () => {
  it('does not require a session for GET /explore-summary', () => {
    expect(handlers('/explore-summary', 'get')).toContain('optionalUser');
    expect(handlers('/explore-summary', 'get')).not.toContain('requireUser');
  });
});
