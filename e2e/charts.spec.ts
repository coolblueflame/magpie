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

test('charts render from the seed, hover shows a tooltip, and every chart has a table twin', async ({ page }) => {
  await resetWithSeed(page);
  await page.getByTestId('nav-charts').click();
  await expect(page.getByTestId('chart-networth').locator('svg')).toBeVisible();
  await expect(page.getByTestId('chart-flow').locator('svg')).toBeVisible();
  await expect(page.getByTestId('chart-invest').locator('svg')).toBeVisible();

  const net = page.getByTestId('chart-networth');
  await net.locator('svg').hover({ position: { x: 500, y: 100 } });
  await expect(page.getByTestId('chart-networth-tip')).toContainText('Total');
  await page.getByTestId('chart-networth-table-toggle').click();
  const rows = page.getByTestId('chart-networth-table').locator('tbody tr');
  await expect(rows).toHaveCount(24);
  await expect(rows.last()).toContainText('$5,869.00');

  await page.getByTestId('range-12').click();
  await page.getByTestId('chart-flow-table-toggle').click();
  await expect(page.getByTestId('chart-flow-table').locator('tbody tr')).toHaveCount(12);
  await expect(page.getByTestId('chart-flow-table').locator('tbody tr').last()).toContainText('$4,000.00');

  await expect(page.getByTestId('chart-category-pick')).toHaveValue('cat_fun');   // first visible category by name, shown in the picker
  await page.getByTestId('chart-category-pick').selectOption('cat_groc');
  await page.getByTestId('chart-category-table-toggle').click();
  await expect(page.getByTestId('chart-category-table').locator('tbody tr').last()).toContainText('$123.45');
  await expect(page.getByTestId('chart-category')).toContainText('Goal $600.00');
});
