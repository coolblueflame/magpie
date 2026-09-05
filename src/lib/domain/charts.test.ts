import { describe, expect, test } from 'vitest';
import { categorySpendSeries, incomeSpendSeries, investmentIncomeSeries, lastMonths, loanSeries, netWorthSeries, niceTicks } from './charts';
import { computeBudget } from './budget';
import { seedData } from './seed';

describe('chart series on the seed', () => {
  const s = seedData('2026-09');
  const months = lastMonths('2026-09', 3);
  test('lastMonths and niceTicks', () => {
    expect(months).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(niceTicks(487000)).toEqual([0, 200000, 400000, 600000]);
    expect(niceTicks(9000)).toEqual([0, 2500, 5000, 7500, 10000]);
    expect(niceTicks(0)).toEqual([0]);
  });
  test('net worth splits budget and tracking and ends at the current balances', () => {
    const n = netWorthSeries(s.accounts, s.transactions, months);
    expect(n.total[2]).toEqual({ month: '2026-09', value: 536900 + 50000 });
    expect(n.tracking.map((p) => p.value)).toEqual([50000, 50000, 50000]);
    expect(n.budget[0]!.value).toBe(400000 - 150000 - 45000 - 20000 - 18000 - 50000);
  });
  test('income and spending per month as magnitudes', () => {
    const r = incomeSpendSeries(s.accounts, s.transactions, months);
    expect(r.income.map((p) => p.value)).toEqual([400000, 400000, 400000]);
    expect(r.spending.map((p) => p.value)).toEqual([150000 + 45000 + 20000 + 18000 + 50000, 150000 + 62000, 150000 + 12345]);
  });
  test('category spending flips activity to a positive magnitude', () => {
    const b = computeBudget({ ...s, history: [], currentMonth: '2026-09' }, '2026-09');
    expect(categorySpendSeries(b.activityByCategory.get('cat_groc'), months).map((p) => p.value)).toEqual([45000, 62000, 12345]);
    expect(categorySpendSeries(undefined, months).map((p) => p.value)).toEqual([0, 0, 0]);
  });
  test('investment income counts adjustments, not transfers, and runs cumulatively', () => {
    const adj = { ...s.transactions[0]!, id: 'adj', accountId: 'acc_inv', date: '2026-08-31', amount: 900, lines: [{ amount: 900, memo: '' }] };
    const r = investmentIncomeSeries(s.accounts, [...s.transactions, adj], months);
    expect(r.monthly.map((p) => p.value)).toEqual([0, 900, 0]);
    expect(r.cumulative.map((p) => p.value)).toEqual([0, 900, 900]);
  });
  test('loan series: history from the ledger, projection from the terms', () => {
    const loan = { ...s.accounts[2]!, id: 'loan', kind: 'loan' as const, onBudget: false, loan: { annualRatePct: 12, standardPayment: 10000, generateInterest: false, interestDay: 1 } };
    const rows = [{ ...s.transactions[0]!, id: 'o', accountId: 'loan', date: '2026-07-01', amount: -100000, lines: [{ amount: -100000, memo: '' }] }];
    const r = loanSeries(loan, rows, '2026-09', 50000);
    expect(r.history.map((p) => p.value)).toEqual([100000, 100000, 100000]);
    expect(r.projected[0]!.month).toBe('2026-10');
    expect(r.projected[r.projected.length - 1]!.value).toBe(0);
    expect(r.whatIf.length).toBeLessThan(r.projected.length);
  });
});
