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

test('accounts and the card ledger: far transfer row, add, split, cleared, delete, undo', async ({ page }) => {
  await resetWithSeed(page);
  await page.getByTestId('nav-accounts').click();
  await expect(page.getByTestId('acct-working-acc_card')).toHaveText('-$801.00');
  await expect(page.getByTestId('acct-total-tracking')).toHaveText('$500.00');
  await page.getByTestId('acct-acc_card').click();
  await expect(page.getByTestId('ledger-working')).toHaveText('-$801.00');

  const far = page.getByTestId('row-seed_t10:0');
  await expect(far).toContainText('Transfer: Chequing');
  await expect(far).toContainText('$380.00');
  await expect(page.getByTestId('clr-seed_t10:0')).toHaveText('●');
  await expect(page.locator('[data-testid^="running-"]').first()).toHaveText('-$801.00');
  await expect(page.getByTestId('new-seed_t15')).toBeVisible();

  await page.getByTestId('add-tx').click();
  await page.getByTestId('ed-payee').fill('Corner Shop');
  await page.getByTestId('ed-outflow').fill('12');
  await page.getByTestId('ed-target').selectOption('cat:cat_groc');
  await page.getByTestId('ed-save').click();
  await expect(page.getByTestId('editor')).toHaveCount(0);
  await expect(page.getByTestId('ledger-working')).toHaveText('-$813.00');
  const row = page.locator('tr', { hasText: 'Corner Shop' }).first();
  await expect(row).toContainText('Groceries');

  await page.goto('./#/');
  await page.getByTestId('rta').waitFor();
  await expect(page.getByTestId('available-cat_groc')).toHaveText('$594.55');

  await page.goto('./#/account/acc_card');
  await page.getByTestId('ledger-working').waitFor();
  await page.locator('tr', { hasText: 'Corner Shop' }).first().click();
  await page.getByTestId('ed-split').click();
  await page.getByTestId('ed-line-0-amount').fill('8');
  await page.getByTestId('ed-line-1-target').selectOption('cat:cat_fun');
  await page.getByTestId('ed-line-1-amount').fill('4');
  await expect(page.getByTestId('ed-remainder')).toHaveText('Remainder $0.00');
  await page.getByTestId('ed-save').click();
  await expect(page.locator('tr', { hasText: 'Corner Shop' }).first()).toContainText('Split (2)');

  const clr = page.locator('tr', { hasText: 'Corner Shop' }).first().locator('[data-testid^="clr-"]');
  await expect(clr).toHaveText('○');
  await clr.click();
  await expect(clr).toHaveText('●');
  await expect(page.getByTestId('ledger-cleared')).toHaveText('-$813.00');

  await page.locator('tr', { hasText: 'Corner Shop' }).first().click();
  await page.getByTestId('ed-delete').click();
  await expect(page.locator('tr', { hasText: 'Corner Shop' })).toHaveCount(0);
  await expect(page.getByTestId('ledger-working')).toHaveText('-$801.00');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('tr', { hasText: 'Corner Shop' }).first()).toBeVisible();
  await expect(page.getByTestId('ledger-working')).toHaveText('-$813.00');
});

test('rename and close an account; Import from a ledger preselects that account', async ({ page }) => {
  await resetWithSeed(page);
  await page.goto('./#/accounts');
  await page.getByTestId('acct-menu-acc_card').locator('summary').click();
  await page.getByTestId('acct-menu-acc_card-rename').click();
  await page.getByTestId('acct-rename-acc_card').fill('Visa');
  await page.getByTestId('acct-rename-acc_card').press('Enter');
  await expect(page.getByTestId('acct-acc_card')).toContainText('Visa');
  await page.getByTestId('acct-menu-acc_inv').locator('summary').click();
  await page.getByTestId('acct-menu-acc_inv-close').click();
  await expect(page.getByTestId('acct-acc_inv')).toHaveCount(0);
  await page.getByTestId('show-closed').check();
  await expect(page.getByTestId('acct-acc_inv')).toHaveClass(/closed/);

  await page.goto('./#/account/acc_chq');
  await page.getByTestId('import-here').click();
  await expect(page).toHaveURL(/#\/import\/acc_chq$/);
  await expect(page.locator('h2', { hasText: 'Import' })).toContainText('into Chequing');
});

test('a far-side row edits the owning transaction', async ({ page }) => {
  await resetWithSeed(page);
  await page.goto('./#/account/acc_card');
  await page.getByTestId('ledger-working').waitFor();
  await page.getByTestId('row-seed_t10:0').click();
  await expect(page.getByTestId('editor')).toContainText('Entered in Chequing');
  await expect(page.getByTestId('ed-outflow')).toHaveValue('380.00');
  await page.getByTestId('ed-memo').fill('card payment');
  await page.getByTestId('ed-save').click();
  await expect(page.getByTestId('row-seed_t10:0')).toContainText('card payment');
});
