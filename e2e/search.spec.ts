import { expect, test, type Page } from '@playwright/test';

async function resetWithSeed(page: Page) {
  await page.goto('./');
  await page.evaluate(() => new Promise<void>((resolve) => {
    localStorage.setItem('magpie:seed', '1');
    const req = indexedDB.deleteDatabase('magpie');
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  }));
  await page.reload();
  await page.getByTestId('rta').waitFor();
}

test('search from the nav: / focuses, Enter searches, results open the owning ledger', async ({ page }) => {
  await resetWithSeed(page);
  await page.locator('body').press('/');
  await expect(page.getByTestId('nav-search')).toBeFocused();
  await page.getByTestId('nav-search').fill('grocer');
  await page.getByTestId('nav-search').press('Enter');
  await expect(page).toHaveURL(/#\/search\/grocer$/);
  const hits = page.locator('[data-testid^="hit-"]');
  await expect(hits.first()).toContainText('Grocer');
  const n = await hits.count();
  expect(n).toBeGreaterThan(1);
  for (let i = 0; i < n; i++) await expect(hits.nth(i)).toContainText('Grocer');

  // Live narrowing while on the results screen: an amount that only one grocer row has.
  await page.getByTestId('nav-search').fill('grocer 15.55');
  await expect(hits).toHaveCount(1);
  await expect(hits.first()).toContainText('$15.55');

  await page.getByTestId('nav-search').fill('380');
  await page.getByTestId('nav-search').press('Enter');
  await expect(hits.first()).toContainText('Transfer:');
  await hits.first().click();
  await expect(page).toHaveURL(/#\/account\/acc_chq\/seed_t10$/);
  await expect(page.getByTestId('row-seed_t10')).toHaveClass(/focus/);
  await expect(page.getByTestId('row-seed_t10')).toBeInViewport();
  await expect(page.locator('tr.focus')).toHaveCount(1);

  // The same landing works from a typed URL, and the highlight follows the URL.
  await page.goto('./#/account/acc_chq/seed_t3');
  await expect(page.getByTestId('row-seed_t3')).toHaveClass(/focus/);
  await expect(page.getByTestId('row-seed_t10')).not.toHaveClass(/focus/);
  await page.goto('./#/account/acc_chq');
  await expect(page.getByTestId('ledger-working')).toBeVisible();
  await expect(page.locator('tr.focus')).toHaveCount(0);

  await page.getByTestId('nav-search').fill('nothing-like-this');
  await page.getByTestId('nav-search').press('Enter');
  await expect(page.getByTestId('search-empty')).toBeVisible();
});
