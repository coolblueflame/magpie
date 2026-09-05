import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { BANK_QFX, CARD_QFX } from '../src/lib/domain/ofxFixture';
import { SHEET_ROWS_FOR_YNAB_FIXTURE, toCsv } from '../src/lib/domain/sheetFixture';
import { PLAN_CSV, REGISTER_CSV } from '../src/lib/domain/ynabFixture';

const DIR = 'e2e/fixtures';
test.beforeAll(() => {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}/card.qfx`, CARD_QFX);
  writeFileSync(`${DIR}/bank.qfx`, BANK_QFX);
  writeFileSync(`${DIR}/unknown.csv`, 'Posted,Details,Debit,Credit\n09/03/2026,COFFEE PLACE,4.50,\n09/04/2026,PAYROLL,,2000.00\n');
  writeFileSync(`${DIR}/sheet.csv`, toCsv(SHEET_ROWS_FOR_YNAB_FIXTURE));
  writeFileSync(`${DIR}/ynab-register.csv`, REGISTER_CSV);
  writeFileSync(`${DIR}/ynab-plan.csv`, PLAN_CSV);
});

async function reset(page: Page, seed: boolean) {
  await page.goto('./');
  await page.evaluate(([s]) => new Promise<void>((resolve) => {
    if (s) localStorage.setItem('magpie:seed', '1'); else localStorage.removeItem('magpie:seed');
    const req = indexedDB.deleteDatabase('magpie');
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  }), [seed]);
  await page.goto('./#/import');
  await page.reload();
  await page.getByTestId('file-any').waitFor();
}

test('statements: new rows, remembered account, all-skipped re-import, a matched transfer', async ({ page }) => {
  await reset(page, true);
  await page.getByTestId('file-any').setInputFiles(`${DIR}/card.qfx`);
  await page.getByTestId('panel').waitFor();
  await page.getByTestId('imp-account').selectOption('acc_card');
  await expect(page.getByTestId('imp-summary')).toHaveText('5 in file: 0 already imported, 0 matched, 5 new');
  await expect(page.getByTestId('imp-ledger')).toContainText("The file's balance is -$1,234.56");
  await expect(page.getByTestId('cand-fitid:2026090300001')).toHaveClass(/new/);
  await page.getByTestId('commit-import').click();
  await expect(page.getByTestId('panel')).toHaveCount(0);
  await expect(page.getByTestId('nav-review-count')).toHaveText('7');

  await page.getByTestId('file-any').setInputFiles(`${DIR}/card.qfx`);
  await page.getByTestId('panel').waitFor();
  await expect(page.getByTestId('imp-account')).toHaveValue('acc_card');
  await expect(page.getByTestId('imp-summary')).toHaveText('5 in file: 5 already imported, 0 matched, 0 new');
  await page.getByTestId('skip-file').click();

  await page.getByTestId('file-any').setInputFiles(`${DIR}/bank.qfx`);
  await page.getByTestId('panel').waitFor();
  await page.getByTestId('imp-account').selectOption('acc_chq');
  await expect(page.getByTestId('imp-summary')).toHaveText('3 in file: 0 already imported, 1 matched, 2 new');
  await expect(page.getByTestId('cand-fitid:90002')).toHaveClass(/match/);
  await page.getByTestId('commit-import').click();
  await expect(page.getByTestId('nav-review-count')).toHaveText('9');

  // A raw statement descriptor with no history offers its likely twin; accepting pre-fills the category.
  await page.getByTestId('nav-review').click();
  const grocerRow = page.locator('tr', { hasText: 'GROCER MART #12' }).first();
  await expect(grocerRow.locator('[data-testid^="rv-same-"]')).toHaveText('Same as Grocer?');
  await grocerRow.locator('[data-testid^="rv-same-"]').click();
  const merged = page.locator('tr', { hasText: '$45.10' });
  await expect(merged).toHaveClass(/prefilled/);
  await expect(merged.locator('[data-testid^="rv-target-"]')).toHaveValue('cat:cat_groc');
  await merged.locator('[data-testid^="rv-target-"]').press('Enter');
  await expect(page.locator('tr', { hasText: '$45.10' })).toHaveCount(0);
});

test('an unknown CSV header is mapped once and remembered', async ({ page }) => {
  await reset(page, true);
  await page.getByTestId('file-any').setInputFiles(`${DIR}/unknown.csv`);
  await page.getByTestId('start-mapping').click();
  await expect(page.getByTestId('map-date')).toHaveValue('Posted');
  await expect(page.getByTestId('map-payee')).toHaveValue('Details');
  await expect(page.getByTestId('map-mode')).toHaveValue('outflow-inflow');
  await expect(page.getByTestId('map-dateformat')).toHaveValue('MM/DD/YYYY');
  await page.getByTestId('imp-account').selectOption('acc_chq');
  await expect(page.getByTestId('imp-summary')).toHaveText('2 in file: 0 already imported, 0 matched, 2 new');
  await page.getByTestId('commit-import').click();
  await expect(page.getByTestId('panel')).toHaveCount(0);

  await page.getByTestId('file-any').setInputFiles(`${DIR}/unknown.csv`);
  await page.getByTestId('panel').waitFor();
  await expect(page.getByTestId('start-mapping')).toHaveCount(0);
  await expect(page.getByTestId('imp-account')).toHaveValue('acc_chq');
  await expect(page.getByTestId('imp-summary')).toHaveText('2 in file: 2 already imported, 0 matched, 0 new');

  await page.goto('./#/account/acc_chq');
  await expect(page.locator('tr', { hasText: 'PAYROLL' })).toContainText('$2,000.00');
});

test('the shared sheet: one claim applies to the matching card row, one partner-paid row is created', async ({ page }) => {
  await reset(page, false);
  await page.getByTestId('file-register').setInputFiles(`${DIR}/ynab-register.csv`);
  await page.getByTestId('file-plan').setInputFiles(`${DIR}/ynab-plan.csv`);
  await page.getByTestId('account-row-3').waitFor();
  await page.getByTestId('person-2').check();
  await page.getByTestId('analyse').click();
  await page.getByTestId('import').click();
  await page.getByTestId('rta').waitFor();

  await page.goto('./#/import');
  await page.getByTestId('file-any').setInputFiles(`${DIR}/sheet.csv`);
  await page.getByTestId('sheet-person').selectOption({ label: 'Partner' });
  await page.getByTestId('sheet-save-settings').click();
  await expect(page.getByTestId('sheet-summary')).toContainText('1 rows you paid become claims (1 match a bank row already)');
  await expect(page.getByTestId('sheet-summary')).toContainText('1 rows the other person paid');
  await expect(page.getByTestId('sheet-summary')).toContainText('1 already imported');
  await page.getByTestId('commit-sheet').click();
  await expect(page.getByTestId('panel')).toHaveCount(0);

  await page.getByTestId('nav-accounts').click();
  await page.locator('tr', { hasText: 'Card' }).first().click();
  const shared = page.locator('tr', { hasText: 'Grocer' }).filter({ hasText: '2026-09-03' });
  await expect(shared).toContainText('Split (2)');
  await expect(shared).toContainText('shared 35%');
  await page.getByTestId('nav-accounts').click();
  await page.locator('tr', { hasText: 'Partner' }).first().click();
  const petRow = page.locator('tr', { hasText: 'Pet Store' });
  await expect(petRow).toContainText('$39.00');
  await expect(petRow.locator('[data-testid^="new-"]')).toBeVisible();
  await page.getByTestId('nav-review').click();
  await expect(page.getByTestId('claim-count')).toHaveCount(0);
});

test('add a person account by hand and share a transaction from the editor', async ({ page }) => {
  await reset(page, true);
  await page.goto('./#/accounts');
  await page.getByTestId('add-account').click();
  await page.getByTestId('new-account-name').fill('Roomie');
  await page.getByTestId('new-account-kind').selectOption('person');
  await page.getByTestId('new-account-save').click();
  await expect(page.locator('tr', { hasText: 'Roomie' })).toContainText('person');

  await page.goto('./#/account/acc_card');
  await page.getByTestId('row-seed_t13').click();
  await page.getByTestId('ed-shared-person').selectOption({ label: 'Roomie' });
  await page.getByTestId('ed-shared-percent').fill('50');
  await page.getByTestId('ed-save').click();
  await expect(page.getByTestId('row-seed_t13')).toContainText('Split (2)');
  await expect(page.getByTestId('shared-seed_t13')).toHaveText('· shared 50%');
  await page.goto('./#/');
  await page.getByTestId('rta').waitFor();
  await expect(page.getByTestId('available-cat_groc')).toHaveText('$668.28');
});
