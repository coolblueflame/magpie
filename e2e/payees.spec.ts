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

test('rename and merge payees, and undo the merge', async ({ page }) => {
  await resetWithSeed(page);
  await page.goto('./#/payees');
  await page.getByTestId('pay-search').waitFor();
  await page.getByTestId('pay-name-pay_grocer').click();
  await page.getByTestId('pay-rename-pay_grocer').fill('Grocer Co');
  await page.getByTestId('pay-rename-pay_grocer').press('Enter');
  await expect(page.getByTestId('pay-name-pay_grocer')).toHaveText('Grocer Co');

  await page.getByTestId('pay-pick-pay_arcade').check();
  await page.getByTestId('pay-pick-pay_mystery').check();
  await page.getByTestId('merge-into').selectOption('pay_arcade');
  await page.getByTestId('merge').click();
  await expect(page.getByTestId('pay-pay_mystery')).toHaveCount(0);
  await expect(page.getByTestId('pay-pay_arcade')).toContainText('mystery');

  await page.goto('./#/account/acc_card');
  await page.getByTestId('ledger-working').waitFor();
  await expect(page.getByTestId('row-seed_t14')).toContainText('Arcade');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByTestId('row-seed_t14')).toContainText('Mystery');

  await page.getByTestId('pay-search').waitFor({ state: 'detached' });
  await page.goto('./#/payees');
  await page.getByTestId('pay-search').fill('myst');
  await expect(page.locator('[data-testid^="pay-pay_"]')).toHaveCount(1);
});
