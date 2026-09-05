import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { PLAN_CSV, REGISTER_CSV } from '../src/lib/domain/ynabFixture';

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

const menu = (page: Page, id: string, item: string) => async () => {
  await page.getByTestId(`menu-${id}`).locator('summary').click();
  await page.getByTestId(`menu-${id}-${item}`).click();
};

test('fill one category and fill all goals, undo as one entry', async ({ page }) => {
  await resetWithSeed(page);
  await expect(page.getByTestId('fill-all')).toHaveText('Fill all goals · $850.00');
  await page.getByTestId('fill-cat_fun').click();
  await expect(page.getByTestId('assigned-cat_fun')).toHaveText('$150.00');
  await expect(page.getByTestId('available-cat_fun')).toHaveText('$250.00');
  await expect(page.getByTestId('rta')).toHaveText('$3,850.00');
  await expect(page.getByTestId('fill-cat_fun')).toHaveCount(0);

  await expect(page.getByTestId('fill-all')).toHaveText('Fill all goals · $700.00');
  await page.getByTestId('fill-all').click();
  await expect(page.getByTestId('fill-all')).toHaveText('Take $700.00 from Ready to Assign?');
  await page.getByTestId('fill-all').click();
  await expect(page.getByTestId('rta')).toHaveText('$3,150.00');
  await expect(page.getByTestId('assigned-cat_save')).toHaveText('$500.00');
  await expect(page.getByTestId('fill-all')).toBeDisabled();
  await expect(page.getByTestId('group-assigned-grp_bills')).toHaveText('$2,200.00');

  await page.getByTestId('month-label').click();   // take focus off the button so Ctrl+Z is global
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByTestId('rta')).toHaveText('$3,850.00');
  await expect(page.getByTestId('assigned-cat_save')).toHaveText('$0.00');
});

test('move money between categories and from Ready to Assign', async ({ page }) => {
  await resetWithSeed(page);
  await page.getByTestId('available-cat_groc').click();
  await expect(page.getByTestId('move-amount')).toHaveValue('606.55');
  await page.getByTestId('move-amount').fill('100');
  await page.getByTestId('move-to').selectOption('cat_fun');
  await page.getByTestId('move-confirm').click();
  await expect(page.getByTestId('move-popover')).toHaveCount(0);
  await expect(page.getByTestId('available-cat_groc')).toHaveText('$506.55');
  await expect(page.getByTestId('available-cat_fun')).toHaveText('$200.00');
  await expect(page.getByTestId('rta')).toHaveText('$4,000.00');

  await page.getByTestId('rta').click();
  await page.getByTestId('move-amount').fill('50');
  await page.getByTestId('move-to').selectOption('cat_rent');
  await page.getByTestId('move-amount').press('Enter');
  await expect(page.getByTestId('rta')).toHaveText('$3,950.00');
  await expect(page.getByTestId('available-cat_rent')).toHaveText('$50.00');

  // Zero amount keeps the popover open; Escape closes it.
  await page.getByTestId('available-cat_fun').click();
  await page.getByTestId('move-amount').fill('0');
  await page.getByTestId('move-confirm').click();
  await expect(page.getByTestId('move-amount')).toHaveClass(/invalid/);
  await page.getByTestId('move-amount').press('Escape');
  await expect(page.getByTestId('move-popover')).toHaveCount(0);
});

test('stats columns and their toggle', async ({ page }) => {
  await resetWithSeed(page);
  await expect(page.getByTestId('avg-all-cat_groc')).toHaveText('-$535.00');
  await expect(page.getByTestId('avg-12-cat_groc')).toHaveText('-$535.00');
  await expect(page.getByTestId('last-cat_groc')).toHaveText('-$620.00');
  await expect(page.getByTestId('avg-all-cat_fun')).toHaveText('-$100.00');
  await expect(page.getByTestId('last-cat_fun')).toHaveText('$0.00');
  await page.getByTestId('show-stats').uncheck();
  await expect(page.getByTestId('avg-all-cat_groc')).toHaveCount(0);
});

test('goal edits, rename, hide, add category and group', async ({ page }) => {
  await resetWithSeed(page);
  await page.getByTestId('goal-cat_fun').click();
  await page.getByTestId('goal-input-cat_fun').fill('175');
  await page.getByTestId('goal-input-cat_fun').press('Enter');
  await expect(page.getByTestId('goal-cat_fun')).toHaveText('$175.00');

  await menu(page, 'cat_fun', 'rename')();
  await page.getByTestId('rename-input-cat_fun').fill('Play');
  await page.getByTestId('rename-input-cat_fun').press('Enter');
  await expect(page.getByTestId('cat-row-cat_fun')).toContainText('Play');

  await menu(page, 'cat_fun', 'hide')();
  await expect(page.getByTestId('cat-row-cat_fun')).toHaveCount(0);
  await page.getByTestId('show-hidden').check();
  await expect(page.getByTestId('cat-row-cat_fun')).toHaveClass(/hidden/);
  await menu(page, 'cat_fun', 'hide')();
  await expect(page.getByTestId('cat-row-cat_fun')).not.toHaveClass(/hidden/);

  await menu(page, 'grp_every', 'add')();
  await page.getByTestId('new-category-grp_every').fill('Coffee');
  await page.getByTestId('new-category-grp_every').press('Enter');
  await expect(page.locator('tr', { hasText: 'Coffee' })).toHaveCount(1);

  await page.getByTestId('add-group').click();
  await page.getByTestId('new-group').fill('Travel');
  await page.getByTestId('new-group').press('Enter');
  await expect(page.locator('tr.group', { hasText: 'Travel' })).toHaveCount(1);

  // Rows: Groceries, Play, Coffee | Rent, Utilities, Savings; moving Savings up puts it fourth from the top.
  await menu(page, 'cat_save', 'up')();
  const rows = page.locator('tr[data-testid^="cat-row-"]');
  await expect(rows.nth(4)).toHaveAttribute('data-testid', 'cat-row-cat_save');
  await expect(rows.nth(5)).toHaveAttribute('data-testid', 'cat-row-cat_util');

  await page.reload();
  await page.getByTestId('rta').waitFor();
  await expect(page.locator('tr', { hasText: 'Coffee' })).toHaveCount(1);
  await expect(page.getByTestId('cat-row-cat_fun')).toContainText('Play');
  await expect(page.locator('tr[data-testid^="cat-row-"]').nth(4)).toHaveAttribute('data-testid', 'cat-row-cat_save');

  // History panel: undo the last two steps at once.
  await page.getByTestId('assigned-cat_groc').click();
  await page.getByTestId('assigned-input-cat_groc').fill('10');
  await page.getByTestId('assigned-input-cat_groc').press('Enter');
  await page.getByTestId('assigned-cat_rent').click();
  await page.getByTestId('assigned-input-cat_rent').fill('20');
  await page.getByTestId('assigned-input-cat_rent').press('Enter');
  await page.getByTestId('nav-history').click();
  const entries = page.locator('[data-testid^="history-undo-"]');
  await expect(entries.first()).toContainText('assign Rent');
  await entries.nth(1).click();   // "assign Groceries": undoes Rent then Groceries
  await expect(page.getByTestId('assigned-cat_groc')).toHaveText('$600.00');
  await expect(page.getByTestId('assigned-cat_rent')).toHaveText('$1,500.00');
  await page.getByTestId('nav-history').click();
  await expect(page.locator('[data-testid^="history-redo-"]')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await page.getByTestId('month-label').click();
  await page.keyboard.press('Control+y');
  await expect(page.getByTestId('assigned-cat_groc')).toHaveText('$10.00');
});

test('suggested goals come from assignment history after a YNAB import', async ({ page }) => {
  mkdirSync('e2e/fixtures', { recursive: true });
  writeFileSync('e2e/fixtures/ynab-register.csv', REGISTER_CSV);
  writeFileSync('e2e/fixtures/ynab-plan.csv', PLAN_CSV);
  await page.goto('./');
  await page.evaluate(() => new Promise<void>((resolve) => {
    localStorage.removeItem('magpie:seed');
    const req = indexedDB.deleteDatabase('magpie');
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  }));
  await page.goto('./#/import');
  await page.reload();
  await page.getByTestId('file-register').setInputFiles('e2e/fixtures/ynab-register.csv');
  await page.getByTestId('file-plan').setInputFiles('e2e/fixtures/ynab-plan.csv');
  await page.getByTestId('account-row-3').waitFor();
  await page.getByTestId('person-2').check();
  await page.getByTestId('analyse').click();
  await page.getByTestId('import').click();
  await page.goto('./#/budget/2026-09');
  await page.getByTestId('rta').waitFor();

  const groc = page.locator('tr', { hasText: 'Groceries' });
  await expect(groc.locator('[data-testid^="suggest-"]')).toHaveText('$100.00?');
  await groc.locator('[data-testid^="suggest-"]').click();
  await expect(groc.locator('[data-testid^="goal-"]').first()).toHaveText('$100.00');
  await expect(groc.locator('[data-testid^="suggest-"]')).toHaveCount(0);
  // Fun ($50 in July) and Rent ($200 in July) remain; hidden Old Hobby never counts.
  await expect(page.getByTestId('adopt-suggestions')).toHaveText('Use 2 suggested goals');
  await page.getByTestId('adopt-suggestions').click();
  await expect(page.locator('tr', { hasText: 'Fun' }).locator('[data-testid^="goal-"]').first()).toHaveText('$50.00');
  await expect(page.locator('tr', { hasText: 'Rent' }).locator('[data-testid^="goal-"]').first()).toHaveText('$200.00');
  await expect(page.getByTestId('adopt-suggestions')).toHaveCount(0);
});
