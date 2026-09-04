import { addMonths } from './month';
import { assignmentId, RTA, type Account, type Assignment, type Category, type CategoryGroup, type Line, type MonthKey, type Transaction } from './types';

const base = { updatedAt: 1, deleted: false } as const;

/**
 * A small synthetic budget for development and e2e: three months ending at
 * `currentMonth`, one overspend that carries, one transfer of each kind, one
 * uncategorised import. Nothing here resembles anyone's real data.
 */
export function seedData(currentMonth: MonthKey) {
  const m0 = currentMonth, m1 = addMonths(currentMonth, -1), m2 = addMonths(currentMonth, -2);
  const accounts: Account[] = [
    { ...base, id: 'acc_chq', name: 'Chequing', kind: 'chequing', onBudget: true, closed: false, sortOrder: 0, note: '' },
    { ...base, id: 'acc_card', name: 'Card', kind: 'credit', onBudget: true, closed: false, sortOrder: 1, note: '' },
    { ...base, id: 'acc_inv', name: 'Brokerage', kind: 'investment', onBudget: false, closed: false, sortOrder: 2, note: '' },
  ];
  const groups: CategoryGroup[] = [
    { ...base, id: 'grp_every', name: 'Everyday', sortOrder: 0, hidden: false },
    { ...base, id: 'grp_bills', name: 'Bills', sortOrder: 1, hidden: false },
  ];
  const cat = (id: string, groupId: string, name: string, goal: number, sortOrder: number): Category =>
    ({ ...base, id, groupId, name, goal, sortOrder, hidden: false, note: '' });
  const categories: Category[] = [
    cat('cat_groc', 'grp_every', 'Groceries', 60000, 0),
    cat('cat_fun', 'grp_every', 'Fun', 15000, 1),
    cat('cat_rent', 'grp_bills', 'Rent', 150000, 0),
    cat('cat_util', 'grp_bills', 'Utilities', 20000, 1),
    cat('cat_save', 'grp_bills', 'Savings', 50000, 2),
  ];
  const asg = (categoryId: string, month: MonthKey, amount: number): Assignment =>
    ({ ...base, id: assignmentId(categoryId, month), categoryId, month, amount });
  const assignments: Assignment[] = [
    asg('cat_groc', m2, 60000), asg('cat_fun', m2, 15000), asg('cat_rent', m2, 150000), asg('cat_util', m2, 20000), asg('cat_save', m2, 50000),
    asg('cat_groc', m1, 60000), asg('cat_fun', m1, 15000), asg('cat_rent', m1, 150000), asg('cat_util', m1, 20000), asg('cat_save', m1, 50000),
    asg('cat_groc', m0, 60000), asg('cat_rent', m0, 150000),
  ];
  let n = 0;
  const tx = (accountId: string, date: string, amount: number, lines: Line[], over: Partial<Transaction> = {}): Transaction => ({
    ...base, id: `seed_t${++n}`, accountId, date, memo: '', amount, cleared: 'cleared', status: 'ok',
    source: { kind: 'manual', batchId: 'seed' }, lines, ...over,
  });
  const cl = (categoryId: string, amount: number): Line => ({ categoryId, amount, memo: '' });
  const transactions: Transaction[] = [
    tx('acc_chq', `${m2}-01`, 400000, [cl(RTA, 400000)]),
    tx('acc_chq', `${m2}-01`, -150000, [cl('cat_rent', -150000)]),
    tx('acc_chq', `${m2}-05`, -45000, [cl('cat_groc', -45000)]),
    tx('acc_card', `${m2}-10`, -20000, [cl('cat_fun', -20000)]),
    tx('acc_card', `${m2}-15`, -18000, [cl('cat_util', -18000)]),
    tx('acc_chq', `${m2}-20`, -50000, [{ transferAccountId: 'acc_inv', categoryId: 'cat_save', amount: -50000, memo: '', farCleared: 'cleared' }]),
    tx('acc_chq', `${m1}-01`, 400000, [cl(RTA, 400000)]),
    tx('acc_chq', `${m1}-01`, -150000, [cl('cat_rent', -150000)]),
    tx('acc_card', `${m1}-07`, -62000, [cl('cat_groc', -62000)]),
    tx('acc_chq', `${m1}-12`, -38000, [{ transferAccountId: 'acc_card', amount: -38000, memo: '', farCleared: 'cleared' }]),
    tx('acc_chq', `${m0}-01`, 400000, [cl(RTA, 400000)]),
    tx('acc_chq', `${m0}-01`, -150000, [cl('cat_rent', -150000)]),
    tx('acc_card', `${m0}-03`, -12345, [cl('cat_groc', -12345)]),
    tx('acc_card', `${m0}-04`, -4200, [{ amount: -4200, memo: '' }], { status: 'new' }),
  ];
  return { accounts, groups, categories, assignments, transactions };
}
