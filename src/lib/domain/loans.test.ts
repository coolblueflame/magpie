import { describe, expect, test } from 'vitest';
import { dueInterest, interestRowId, monthlyInterest, projectLoan, whatIf } from './loans';
import type { Account, Line, Transaction } from './types';

const terms = (over = {}) => ({ annualRatePct: 12, standardPayment: 10000, generateInterest: true, interestDay: 1, ...over });

describe('loan arithmetic', () => {
  test('monthly interest rounds half away from zero and is zero when nothing is owed', () => {
    expect(monthlyInterest(100000, 12)).toBe(1000);
    expect(monthlyInterest(100050, 12)).toBe(1001);   // 1000.5
    expect(monthlyInterest(0, 12)).toBe(0);
    expect(monthlyInterest(-500, 12)).toBe(0);
  });
  test('a zero-rate schedule pays down in equal steps', () => {
    const p = projectLoan(100000, terms({ annualRatePct: 0, standardPayment: 40000 }), '2026-09');
    expect(p.steps.map((s) => s.owed)).toEqual([60000, 20000, 0]);
    expect(p).toMatchObject({ payoffMonth: '2026-11', months: 3, totalInterest: 0, stalls: false });
  });
  test('interest accrues before each payment', () => {
    const p = projectLoan(100000, terms(), '2026-09');
    expect(p.steps[0]).toEqual({ month: '2026-09', interest: 1000, payment: 10000, owed: 91000 });
    expect(p.payoffMonth).not.toBeNull();
    expect(p.totalInterest).toBeGreaterThan(0);
    expect(p.steps[p.steps.length - 1]!.owed).toBe(0);
  });
  test('a lump sum saves months and interest', () => {
    const w = whatIf(100000, terms(), '2026-09', 50000);
    expect(w.monthsSaved).toBeGreaterThan(0);
    expect(w.interestSaved).toBeGreaterThan(0);
    expect(w.withLump.months + w.monthsSaved).toBe(w.base.months);
    const all = whatIf(100000, terms(), '2026-09', 100000);
    expect(all.withLump).toMatchObject({ months: 0, payoffMonth: '2026-09' });
  });
  test('a payment that cannot outrun the interest stalls instead of looping', () => {
    const p = projectLoan(100000, terms({ standardPayment: 1000 }), '2026-09');
    expect(p).toMatchObject({ stalls: true, payoffMonth: null, months: 0 });
  });
});

describe('dueInterest', () => {
  const loan: Account = { id: 'loan', name: 'Family loan', kind: 'loan', onBudget: false, closed: false, sortOrder: 0, note: '', updatedAt: 1, deleted: false, loan: terms({ interestDay: 15 }) };
  const chq: Account = { ...loan, id: 'chq', kind: 'chequing', onBudget: true, loan: undefined };
  const tx = (id: string, accountId: string, date: string, amount: number, lines: Line[] = [{ amount, memo: '' }]): Transaction =>
    ({ id, accountId, date, memo: '', amount, cleared: 'cleared', status: 'ok', source: { kind: 'manual', batchId: 'b' }, lines, updatedAt: 1, deleted: false });
  test('one row per elapsed month, each on the balance before its date, including rows added earlier in the pass', () => {
    const rows = [
      tx('open', 'loan', '2026-06-01', -100000),
      tx('pay1', 'chq', '2026-07-10', -10000, [{ transferAccountId: 'loan', categoryId: 'c', amount: -10000, memo: '' }]),
    ];
    const due = dueInterest(loan, rows, '2026-09-20');
    expect(due.map((d) => [d.month, d.date, d.amount])).toEqual([
      ['2026-06', '2026-06-15', -1000],          // on 100000
      ['2026-07', '2026-07-15', -910],           // 100000 + 1000 − 10000 = 91000
      ['2026-08', '2026-08-15', -919],           // 91000 + 910 = 91910 → 919.1
      ['2026-09', '2026-09-15', -928],           // 92829 → 928.29
    ]);
    expect(due[0]!.id).toBe(interestRowId('loan', '2026-06'));
  });
  test('idempotent: posted months are skipped; a future interest day waits; no rows without a first transaction or generation', () => {
    const rows = [tx('open', 'loan', '2026-08-01', -100000), tx(interestRowId('loan', '2026-08'), 'loan', '2026-08-15', -1000)];
    expect(dueInterest(loan, rows, '2026-09-10').map((d) => d.month)).toEqual([]);
    expect(dueInterest(loan, rows, '2026-09-15').map((d) => d.month)).toEqual(['2026-09']);
    expect(dueInterest(loan, [], '2026-09-20')).toEqual([]);
    expect(dueInterest({ ...loan, loan: terms({ generateInterest: false }) }, rows, '2026-12-01')).toEqual([]);
  });
});
