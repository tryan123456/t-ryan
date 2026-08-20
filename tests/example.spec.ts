import { expect, test } from '@playwright/test';

test('smoke: playwright.dev loads', async ({ page }) => {
  await page.goto('https://playwright.dev/');
  await expect(page).toHaveTitle(/Playwright/);
});
