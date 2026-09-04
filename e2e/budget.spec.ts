import { expect, test, type Page } from '@playwright/test';

/** Fresh database with the seed flag set, then a reload so init() sees both. */
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

test('the budget screen shows the seed month', async ({ page }) => {
  await resetWithSeed(page);
  await expect(page.getByTestId('rta')).toHaveText('$4,000.00');
  await expect(page.getByTestId('uncategorised')).toHaveText('Uncategorised -$42.00');
  await expect(page.getByTestId('group-grp_every')).toBeVisible();
  await expect(page.getByTestId('assigned-cat_groc')).toHaveText('$600.00');
  await expect(page.getByTestId('activity-cat_groc')).toHaveText('-$123.45');
  await expect(page.getByTestId('available-cat_groc')).toHaveText('$606.55');
  await expect(page.getByTestId('available-cat_fun')).toHaveText('$100.00');
  await expect(page.getByTestId('available-cat_save')).toHaveText('$500.00');
});

test('two months back shows the carried overspend', async ({ page }) => {
  await resetWithSeed(page);
  await page.getByTestId('month-prev').click();
  await page.getByTestId('month-prev').click();
  await expect(page.getByTestId('available-cat_fun')).toHaveText('-$50.00');
  await expect(page.getByTestId('available-cat_fun')).toHaveClass(/neg/);
});

test('editing assigned recomputes, persists across reload, and undoes', async ({ page }) => {
  await resetWithSeed(page);
  await page.getByTestId('assigned-cat_groc').click();
  const input = page.getByTestId('assigned-input-cat_groc');
  await expect(input).toHaveValue('600.00');
  await input.fill('700');
  await input.press('Enter');
  await expect(page.getByTestId('assigned-cat_groc')).toHaveText('$700.00');
  await expect(page.getByTestId('available-cat_groc')).toHaveText('$706.55');
  await expect(page.getByTestId('rta')).toHaveText('$3,900.00');
  await expect(page.getByTestId('undo-toast')).toBeVisible();

  await page.reload();
  await page.getByTestId('rta').waitFor();
  await expect(page.getByTestId('assigned-cat_groc')).toHaveText('$700.00');
  await expect(page.getByTestId('rta')).toHaveText('$3,900.00');

  // Undo is session-only: make a fresh edit, then Ctrl+Z it.
  await page.getByTestId('assigned-cat_groc').click();
  await page.getByTestId('assigned-input-cat_groc').fill('650');
  await page.getByTestId('assigned-input-cat_groc').press('Enter');
  await expect(page.getByTestId('assigned-cat_groc')).toHaveText('$650.00');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByTestId('assigned-cat_groc')).toHaveText('$700.00');
  await expect(page.getByTestId('rta')).toHaveText('$3,900.00');
});

test('invalid text keeps the editor open and Escape cancels', async ({ page }) => {
  await resetWithSeed(page);
  await page.getByTestId('assigned-cat_fun').click();
  const input = page.getByTestId('assigned-input-cat_fun');
  await input.fill('abc');
  await input.press('Enter');
  await expect(input).toHaveClass(/invalid/);
  await input.press('Escape');
  await expect(page.getByTestId('assigned-cat_fun')).toHaveText('$0.00');
});
