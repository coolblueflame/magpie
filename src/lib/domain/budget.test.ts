import { describe, expect, test } from 'vitest';
import { computeBudget, type BudgetInput } from './budget';
import type { Account, Assignment, Category, Transaction } from './types';
import { assignmentId, RTA } from './types';

const acct = (id: string, onBudget: boolean): Account => ({
  id, name: id, kind: onBudget ? 'chequing' : 'investment', onBudget, closed: false,
  sortOrder: 0, note: '', updatedAt: 1, deleted: false,
});
const cat = (id: string, carriedIn?: number): Category => ({
  id, groupId: 'g', name: id, goal: 0, sortOrder: 0, hidden: false, note: '', updatedAt: 1, deleted: false,
  ...(carriedIn === undefined ? {} : { carriedIn }),
});
const asg = (categoryId: string, month: string, amount: number): Assignment => ({
  id: assignmentId(categoryId, month), categoryId, month, amount, updatedAt: 1, deleted: false,
});
let n = 0;
const spend = (accountId: string, date: string, categoryId: string | undefined, amount: number, over: Partial<Transaction> = {}): Transaction => ({
  id: `t${++n}`, accountId, date, memo: '', amount, cleared: 'cleared', status: categoryId ? 'ok' : 'new',
  source: { kind: 'manual', batchId: 'b' }, lines: [{ ...(categoryId ? { categoryId } : {}), amount, memo: '' }],
  updatedAt: 1, deleted: false, ...over,
});

function base(over: Partial<BudgetInput> = {}): BudgetInput {
  return {
    accounts: [acct('chq', true), acct('inv', false)],
    categories: [cat('groc'), cat('fun')],
    assignments: [], transactions: [], history: [], currentMonth: '2026-09', ...over,
  };
}

describe('availability rollover', () => {
  test('overspending carries as a negative into the next month', () => {
    const input = base({
      assignments: [asg('groc', '2026-07', 10000), asg('groc', '2026-08', 10000)],
      transactions: [spend('chq', '2026-07-10', 'groc', -15000)],
    });
    expect(computeBudget(input, '2026-07').rows.get('groc')!.available).toBe(-5000);
    expect(computeBudget(input, '2026-08').rows.get('groc')!.available).toBe(5000);
    expect(computeBudget(input, '2026-09').rows.get('groc')!.available).toBe(5000);
    expect(computeBudget(input, '2026-09').activityByCategory).toEqual(new Map([['groc', new Map([['2026-07', -15000]])]]));
  });
  test('activity is the budget effect of lines, so off-budget rows and on-on transfers are ignored', () => {
    const input = base({
      transactions: [
        spend('inv', '2026-09-01', 'groc', -999, { status: 'ok' }),
        spend('chq', '2026-09-02', undefined, -380, { status: 'ok',
          lines: [{ transferAccountId: 'inv', categoryId: 'fun', amount: -380, memo: '' }] }),
      ],
    });
    const b = computeBudget(input, '2026-09');
    expect(b.rows.get('groc')!.activity).toBe(0);
    expect(b.rows.get('fun')!.activity).toBe(-380);
  });
  test('months before cutover show YNAB history and cutover starts from carriedIn', () => {
    const input = base({
      cutoverMonth: '2026-09',
      categories: [cat('groc', 2500)],
      history: [{ id: 'yh_groc_2026-08', categoryId: 'groc', month: '2026-08', assigned: 100, activity: -50, available: 7777, updatedAt: 1, deleted: false }],
      assignments: [asg('groc', '2026-09', 1000)],
      transactions: [spend('chq', '2026-09-03', 'groc', -300)],
    });
    expect(computeBudget(input, '2026-08').rows.get('groc')).toEqual({ categoryId: 'groc', month: '2026-08', assigned: 100, activity: -50, available: 7777 });
    expect(computeBudget(input, '2026-09').rows.get('groc')!.available).toBe(2500 + 1000 - 300);
    expect(computeBudget(input, '2026-10').rows.get('groc')!.available).toBe(3200);
  });
  test('a category with no rows at all is zero everywhere', () => {
    expect(computeBudget(base(), '2026-09').rows.get('fun')).toEqual({ categoryId: 'fun', month: '2026-09', assigned: 0, activity: 0, available: 0 });
  });
});

describe('ready to assign', () => {
  test('income minus everything assigned, including future months', () => {
    const input = base({
      transactions: [spend('chq', '2026-09-01', RTA, 100000)],
      assignments: [asg('groc', '2026-09', 30000), asg('fun', '2026-11', 20000)],
    });
    const b = computeBudget(input, '2026-09');
    expect(b.rta).toBe(50000);
    expect(b.horizon).toBe('2026-11');
    expect(b.onBudgetTotal).toBe(100000);
  });
  test('an uncategorised new transaction is held aside, not taken from RTA', () => {
    const input = base({
      transactions: [spend('chq', '2026-09-01', RTA, 100000), spend('chq', '2026-09-02', undefined, -4200)],
      assignments: [asg('groc', '2026-09', 30000)],
    });
    const b = computeBudget(input, '2026-09');
    expect(b.uncategorised).toBe(-4200);
    expect(b.rta).toBe(70000);
  });
  test('conservation: moving money and categorising never change RTA', () => {
    const before = base({
      transactions: [spend('chq', '2026-09-01', RTA, 100000), spend('chq', '2026-09-02', undefined, -4200)],
      assignments: [asg('groc', '2026-09', 30000), asg('fun', '2026-09', 10000)],
    });
    const moved = { ...before, assignments: [asg('groc', '2026-09', 25000), asg('fun', '2026-09', 15000)] };
    const categorised = { ...before, transactions: [before.transactions[0]!, spend('chq', '2026-09-02', 'groc', -4200)] };
    const r = (i: BudgetInput) => computeBudget(i, '2026-09');
    expect(r(moved).rta).toBe(r(before).rta);
    expect(r(categorised).rta).toBe(r(before).rta);
    expect(r(categorised).rows.get('groc')!.available).toBe(30000 - 4200);
    expect(r(categorised).uncategorised).toBe(0);
  });
  test('tombstoned rows are ignored', () => {
    const input = base({
      transactions: [spend('chq', '2026-09-01', RTA, 100000, { deleted: true })],
      assignments: [{ ...asg('groc', '2026-09', 30000), deleted: true }],
    });
    const b = computeBudget(input, '2026-09');
    expect(b.rta).toBe(0);
    expect(b.rows.get('groc')!.assigned).toBe(0);
  });
});
