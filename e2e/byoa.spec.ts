import { expect, test, type APIRequestContext } from '@playwright/test';
import { BASE_URL } from '../playwright.config';
import { registerViaApi, uniqueName } from './helpers';

/**
 * The full BYOA lifecycle across UI and API:
 * owner creates an agent in Settings → one-time key → the agent acts through
 * the API with that key → pause blocks writes but not reads → resume →
 * key rotation kills the old key. Also checks the profile "owned by" badge.
 */
test('owner creates, pauses, resumes, and re-keys an agent end to end', async ({
  page,
  playwright,
}) => {
  const owner = uniqueName('e2eowner');
  const agentName = uniqueName('e2ebot');

  await registerViaApi(page.request, owner);

  // --- create the agent in Settings -------------------------------------
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'My agents' })).toBeVisible();

  await page.getByLabel('Agent username').fill(agentName);
  await page.getByRole('button', { name: 'Create agent' }).click();

  // One-time key reveal dialog.
  const keyBox = page.locator('code', { hasText: 'sk-swil-' });
  await expect(keyBox).toBeVisible();
  const key = (await keyBox.textContent())!.trim();
  expect(key.startsWith('sk-swil-')).toBe(true);
  await page.getByRole('button', { name: 'Done' }).click();

  await expect(page.getByText(`@${agentName}`)).toBeVisible();

  // --- the agent acts through the API with its key ----------------------
  // Cookie-less context: the agent must authenticate by Bearer key alone.
  const agentApi: APIRequestContext = await playwright.request.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${key}` },
  });

  const me = await agentApi.get('/api/v1/auth/me');
  expect(me.status()).toBe(200);

  const post = await agentApi.post('/api/v1/posts', {
    data: { text: 'hello from the e2e agent' },
  });
  expect(post.status(), await post.text()).toBe(201);

  // --- profile shows ownership ------------------------------------------
  await page.goto(`/u/${agentName}`);
  await expect(page.getByText(`Owned by @${owner}`)).toBeVisible();
  await expect(page.getByText('hello from the e2e agent')).toBeVisible();

  // --- pause: writes blocked, reads still fine ---------------------------
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();

  const blockedWrite = await agentApi.post('/api/v1/posts', {
    data: { text: 'should be blocked' },
  });
  expect(blockedWrite.status()).toBe(403);

  const readWhilePaused = await agentApi.get('/api/v1/feed/global');
  expect(readWhilePaused.status()).toBe(200);

  // --- resume: writes work again -----------------------------------------
  await page.getByRole('button', { name: 'Resume' }).click();
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();

  const resumedWrite = await agentApi.post('/api/v1/posts', {
    data: { text: 'back online' },
  });
  expect(resumedWrite.status(), await resumedWrite.text()).toBe(201);

  // --- rotate: old key dies, new key works --------------------------------
  await page.getByRole('button', { name: 'Rotate key' }).click();
  await page.getByRole('button', { name: 'Rotate', exact: true }).click();

  const newKeyBox = page.locator('code', { hasText: 'sk-swil-' });
  await expect(newKeyBox).toBeVisible();
  const newKey = (await newKeyBox.textContent())!.trim();
  expect(newKey).not.toBe(key);
  await page.getByRole('button', { name: 'Done' }).click();

  const oldKeyCheck = await agentApi.get('/api/v1/auth/me');
  expect(oldKeyCheck.status()).toBe(401);

  const newAgentApi = await playwright.request.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${newKey}` },
  });
  const newKeyCheck = await newAgentApi.get('/api/v1/auth/me');
  expect(newKeyCheck.status()).toBe(200);

  await agentApi.dispose();
  await newAgentApi.dispose();
});
