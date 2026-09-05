import { describe, expect, test } from 'vitest';
import { normalisePayeeKey, payeeLastCategories, payeeLastCategory, payeeUsage } from './payees';
import { seedData } from './seed';

describe('payees', () => {
  const s = seedData('2026-09');
  const accountsById = new Map(s.accounts.map((a) => [a.id, a]));
  test('normalisePayeeKey folds case and whitespace', () => {
    expect(normalisePayeeKey('  SQ *Coffee   Co ')).toBe('sq *coffee co');
  });
  test('payeeLastCategory takes the newest confirmed single-line budget row', () => {
    expect(payeeLastCategory('pay_grocer', s.transactions, accountsById)).toBe('cat_groc');
    expect(payeeLastCategory('pay_employer', s.transactions, accountsById)).toBe('rta');
    expect(payeeLastCategory('pay_mystery', s.transactions, accountsById)).toBeUndefined();   // only a new row
    expect(payeeLastCategory('nobody', s.transactions, accountsById)).toBeUndefined();
  });
  test('payeeLastCategories agrees with payeeLastCategory for every payee', () => {
    const all = payeeLastCategories(s.transactions, accountsById);
    for (const p of s.payees) expect(all.get(p.id)).toBe(payeeLastCategory(p.id, s.transactions, accountsById));
  });
  test('payeeUsage counts and dates', () => {
    const u = payeeUsage(s.transactions);
    expect(u.get('pay_grocer')).toEqual({ count: 4, last: '2026-09-05' });
    expect(u.get('pay_landlord')!.count).toBe(3);
  });
});
