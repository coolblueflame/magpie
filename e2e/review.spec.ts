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

test('the review queue pre-fills from payee history and confirms one by one or in bulk', async ({ page }) => {
  await resetWithSeed(page);
  await expect(page.getByTestId('nav-review-count')).toHaveText('2');
  await page.getByTestId('nav-review').click();
  await expect(page.getByTestId('rv-count')).toHaveText('2 to categorise');
  await expect(page.getByTestId('rv-seed_t15')).toHaveClass(/prefilled/);
  await expect(page.getByTestId('rv-target-seed_t15')).toHaveValue('cat:cat_groc');
  await expect(page.getByTestId('rv-seed_t14')).not.toHaveClass(/prefilled/);

  await page.getByTestId('rv-confirm-seed_t14').click();
  await expect(page.getByTestId('rv-error')).toContainText('category');
  await page.getByTestId('rv-target-seed_t14').selectOption('cat:cat_fun');
  await page.getByTestId('rv-confirm-seed_t14').click();
  await expect(page.getByTestId('rv-seed_t14')).toHaveCount(0);

  await page.getByTestId('confirm-prefilled').click();
  await expect(page.getByTestId('confirm-prefilled')).toHaveText('Confirm 1 pre-filled rows?');
  await page.getByTestId('confirm-prefilled').click();
  await expect(page.getByTestId('rv-empty')).toBeVisible();
  await expect(page.getByTestId('nav-review-count')).toHaveCount(0);

  await page.goto('./#/');
  await page.getByTestId('rta').waitFor();
  await expect(page.getByTestId('uncategorised')).toHaveCount(0);
  await expect(page.getByTestId('available-cat_groc')).toHaveText('$591.00');
  await expect(page.getByTestId('available-cat_fun')).toHaveText('$58.00');
  await expect(page.getByTestId('rta')).toHaveText('$4,000.00');
});
