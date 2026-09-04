import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { PLAN_CSV, REGISTER_CSV } from '../src/lib/domain/ynabFixture';

const DIR = 'e2e/fixtures';
test.beforeAll(() => {
  mkdirSync(DIR, { recursive: true });
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
  await page.getByTestId('file-register').waitFor();
}

async function loadFixture(page: Page) {
  await page.getByTestId('file-register').setInputFiles(`${DIR}/ynab-register.csv`);
  await page.getByTestId('file-plan').setInputFiles(`${DIR}/ynab-plan.csv`);
  await page.getByTestId('account-row-3').waitFor();
}

const availableOf = (page: Page, name: string) =>
  page.locator('tr', { hasText: name }).locator('[data-testid^="available-"]');

test('imports the fixture export and shows the verified budget', async ({ page }) => {
  await reset(page, false);
  await loadFixture(page);
  await page.getByTestId('kind-1').selectOption('credit');
  await page.getByTestId('person-2').check();
  await page.getByTestId('kind-3').selectOption('investment');
  await expect(page.getByTestId('onbudget-3')).not.toBeChecked();
  await expect(page.getByTestId('onbudget-2')).toBeChecked();
  await page.getByTestId('analyse').click();
  await expect(page.getByTestId('report-mismatches')).toHaveText('0 cutover mismatches, 0 activity mismatches');
  await expect(page.getByTestId('report-cc')).toContainText('$17.34 higher');
  await expect(page.getByTestId('report-counts')).toContainText('12 transactions');
  await page.getByTestId('import').click();
  await page.getByTestId('rta').waitFor();

  await page.goto('./#/budget/2026-09');
  await expect(page.getByTestId('month-label')).toHaveText('Sep 2026');
  await expect(page.getByTestId('rta')).toHaveText('$932.00');
  await expect(page.getByTestId('uncategorised')).toHaveText('Uncategorised -$7.00');
  await expect(availableOf(page, 'Groceries')).toHaveText('$224.66');
  await expect(availableOf(page, 'Fun')).toHaveText('$0.00');
  await expect(page.locator('tr', { hasText: 'Old Hobby' })).toHaveCount(0);
  await page.getByTestId('show-hidden').check();
  await expect(page.locator('tr', { hasText: 'Old Hobby' })).toHaveClass(/hidden/);

  // August shows YNAB's own numbers, including the overspend YNAB later reset.
  await page.getByTestId('month-prev').click();
  await expect(availableOf(page, 'Fun')).toHaveText('-$15.00');

  // A second import is refused while data exists.
  await page.goto('./#/import');
  await loadFixture(page);
  await page.getByTestId('analyse').click();
  await expect(page.getByTestId('import-blocked')).toBeVisible();
  await expect(page.getByTestId('import')).toHaveCount(0);
});

test('delete all data is armed, then clears the database', async ({ page }) => {
  await reset(page, true);
  await page.goto('./#/settings');
  await page.getByTestId('delete-all').click();
  await expect(page.getByTestId('delete-all-armed')).toBeVisible();
  await page.getByTestId('delete-all').click();
  await expect(page.getByTestId('delete-all-armed')).toHaveCount(0);
  await page.goto('./#/');
  await page.getByTestId('rta').waitFor();
  await expect(page.getByTestId('rta')).toHaveText('$0.00');
  await expect(page.locator('[data-testid^="cat-row-"]')).toHaveCount(0);
});
