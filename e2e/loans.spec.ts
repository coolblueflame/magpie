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

const firstOfThisMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`; };

test('a loan with generated interest: terms, an interest row, projection and what-if', async ({ page }) => {
  await resetWithSeed(page);
  await expect(page.getByTestId('nav-loans')).toHaveCount(0);
  await page.goto('./#/accounts');
  await page.getByTestId('add-account').click();
  await page.getByTestId('new-account-name').fill('Family loan');
  await page.getByTestId('new-account-kind').selectOption('loan');
  await page.getByTestId('new-account-onbudget').uncheck();
  await page.getByTestId('new-account-save').click();
  await page.locator('tr', { hasText: 'Family loan' }).click();
  await page.getByTestId('add-tx').click();
  await page.getByTestId('ed-date').fill(firstOfThisMonth());
  await page.getByTestId('ed-payee').fill('Opening');
  await page.getByTestId('ed-outflow').fill('1000');
  await page.getByTestId('ed-save').click();
  await expect(page.getByTestId('ledger-working')).toHaveText('-$1,000.00');

  await page.getByTestId('nav-loans').click();
  const rate = page.locator('[data-testid^="loan-rate-"]');
  await rate.fill('12');
  await page.locator('[data-testid^="loan-payment-"]').fill('100');
  await page.locator('[data-testid^="loan-generate-"]').check();
  await page.locator('[data-testid^="loan-day-"]').fill('1');
  await page.locator('[data-testid^="loan-save-"]').click();
  await expect(page.locator('[data-testid^="loan-owed-"]')).toHaveText('$1,010.00');   // one month of interest posted
  await expect(page.locator('[data-testid^="loan-months-"]')).toHaveText('11');
  await expect(page.locator('[data-testid^="loan-interest-"]')).toBeVisible();
  await page.locator('[data-testid^="loan-lump-"]').fill('500');
  await expect(page.locator('[data-testid^="loan-saved-"]')).toContainText('months sooner');
  await page.locator('[data-testid^="loan-lump-"]').fill('1010');
  await expect(page.locator('[data-testid^="loan-saved-"]')).toContainText('clears the loan today');

  await page.goto('./#/accounts');
  await page.locator('tr', { hasText: 'Family loan' }).click();
  await expect(page.locator('tr', { hasText: 'Interest' })).toContainText('$10.00');
  await expect(page.locator('tr', { hasText: 'Interest' })).toHaveCount(1);
  await page.reload();
  await page.getByTestId('ledger-working').waitFor();
  await expect(page.locator('tr', { hasText: 'Interest' })).toHaveCount(1);   // the boot sweep posts nothing twice
});

test('set balance on a tracking account writes the difference with a remembered payee', async ({ page }) => {
  await resetWithSeed(page);
  await page.goto('./#/account/acc_inv');
  await page.getByTestId('ledger-working').waitFor();
  await expect(page.getByTestId('ledger-working')).toHaveText('$500.00');
  await page.getByTestId('set-balance').click();
  await expect(page.getByTestId('sb-amount')).toHaveValue('500.00');
  await page.getByTestId('sb-amount').fill('612.34');
  await page.getByTestId('sb-payee').fill('The Ether');
  await page.getByTestId('sb-category').selectOption('cat:cat_save');
  await page.getByTestId('sb-save').click();
  await expect(page.getByTestId('ledger-working')).toHaveText('$612.34');
  await expect(page.locator('tr', { hasText: 'The Ether' })).toContainText('$112.34');
  await page.getByTestId('set-balance').click();
  await expect(page.getByTestId('sb-payee')).toHaveValue('The Ether');
  await expect(page.getByTestId('sb-category')).toHaveValue('cat:cat_save');
});
