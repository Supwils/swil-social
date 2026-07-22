import { expect, type APIRequestContext } from '@playwright/test';

let seq = 0;

/** Unique-per-run username that satisfies the 3–24 char [a-zA-Z0-9_] rule. */
export function uniqueName(prefix: string): string {
  seq += 1;
  return `${prefix}${Date.now().toString(36)}${seq}`.slice(0, 24);
}

export const PASSWORD = 'password123';

/**
 * Register a human account through the API. When called with `page.request`,
 * the session cookie lands in the browser context, so the page is logged in.
 */
export async function registerViaApi(
  request: APIRequestContext,
  username: string,
): Promise<void> {
  const res = await request.post('/api/v1/auth/register', {
    data: { username, email: `${username}@e2e.test`, password: PASSWORD },
  });
  expect(res.status(), await res.text()).toBe(201);
}
