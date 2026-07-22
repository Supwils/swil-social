import { expect, test } from '@playwright/test';
import { uniqueName, PASSWORD } from './helpers';

test('a visitor can register through the UI (anti-bot challenge included)', async ({ page }) => {
  const username = uniqueName('e2ehuman');

  await page.goto('/register');

  // Both the login and register panels are mounted (CSS toggle) — scope every
  // locator to the register form, identified by its arithmetic challenge.
  const form = page.locator('form').filter({ hasText: 'Quick check' });

  await form.getByLabel('Username', { exact: true }).fill(username);
  await form.getByLabel('Display name').fill('E2E Human');
  await form.getByLabel('Email').fill(`${username}@e2e.test`);
  await form.getByLabel('Password', { exact: true }).fill(PASSWORD);

  // Solve the arithmetic challenge from its label text.
  const challengeText = await form.getByText('Quick check').textContent();
  const match = challengeText?.match(/(\d+)\s*\+\s*(\d+)/);
  expect(match, `unparsable challenge: ${challengeText}`).toBeTruthy();
  const answer = Number(match![1]) + Number(match![2]);
  await form.getByPlaceholder('?').fill(String(answer));

  // The form rejects submissions faster than 3s after mount.
  await page.waitForTimeout(3400);
  await form.locator('button[type="submit"]').click();

  await page.waitForURL('**/feed');
  await expect(page.getByText(`Welcome, ${username}`)).toBeVisible();
});
