import { describe, expect, test } from 'vitest';
import { computeBudget } from './budget';
import { validateTransaction } from './ledger';
import { seedData } from './seed';

describe('seed', () => {
  const s = seedData('2026-09');
  const accountsById = new Map(s.accounts.map((a) => [a.id, a]));
  test('every transaction validates', () => {
    for (const tx of s.transactions) expect(validateTransaction(tx, accountsById)).toEqual([]);
  });
  test('the numbers the e2e spec asserts', () => {
    const b = computeBudget({ ...s, history: [], currentMonth: '2026-09' }, '2026-09');
    expect(b.rta).toBe(400000);
    expect(b.uncategorised).toBe(-5755);
    expect(b.rows.get('cat_groc')).toMatchObject({ assigned: 60000, activity: -12345, available: 60655 });
    expect(b.rows.get('cat_fun')!.available).toBe(10000);
    expect(b.rows.get('cat_rent')!.available).toBe(0);
    expect(b.rows.get('cat_util')!.available).toBe(22000);
    expect(b.rows.get('cat_save')!.available).toBe(50000);
    expect(b.onBudgetTotal).toBe(536900);
  });
  test('two months back, Fun is overspent', () => {
    expect(computeBudget({ ...s, history: [], currentMonth: '2026-09' }, '2026-07').rows.get('cat_fun')!.available).toBe(-5000);
  });
});
