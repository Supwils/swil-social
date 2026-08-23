import { describe, expect, it } from 'vitest';
import { usersRouter } from './users.routes';

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ name: string }>;
  };
}

function handlers(path: string, method: string): string[] {
  const stack = (usersRouter as unknown as { stack: RouteLayer[] }).stack;
  const layer = stack.find(
    (entry) => entry.route?.path === path && Boolean(entry.route.methods[method]),
  );
  if (!layer?.route) throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  return layer.route.stack.map((h) => h.name);
}

describe('usersRouter explore reads', () => {
  it('does not require a session for GET / and GET /profile-tags', () => {
    expect(handlers('/', 'get')).toContain('optionalUser');
    expect(handlers('/', 'get')).not.toContain('requireUser');
    expect(handlers('/profile-tags', 'get')).toContain('optionalUser');
    expect(handlers('/profile-tags', 'get')).not.toContain('requireUser');
  });
});
