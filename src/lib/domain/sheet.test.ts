import { describe, expect, test } from 'vitest';
import { isSheetHeader, parseSheet, planClaims, planSheet } from './sheet';
import { sharedLines, shareSplit } from './shares';
import { seedData } from './seed';
import type { ShareClaim, Transaction } from './types';

const HEADER = ['When', 'Me Paid', 'Them Paid', "T's %", 'Where', 'What', "Me's Share", "Them's Share", '', 'Me Owes Them', 'Them Owes Me', '', '', '', 'Date', 'Amount', 'Payee', 'Memo'];

describe('shares', () => {
  test('split rounds the partner share half away from zero and sums exactly', () => {
    expect(shareSplit(10001, 35)).toEqual({ mine: 6501, theirs: 3500 });   // 3500.35 → 3500
    expect(shareSplit(10005, 35)).toEqual({ mine: 6503, theirs: 3502 });   // 3501.75 → 3502
    expect(shareSplit(999, 50)).toEqual({ mine: 499, theirs: 500 });        // 499.5 → 500
  });
  test('sharedLines: the simple case, both paid, p = 0, p = 100', () => {
    expect(sharedLines(-10000, 10000, 35, 'c', 'P')).toEqual([{ amount: -6500, memo: '', categoryId: 'c' }, { transferAccountId: 'P', amount: -3500, memo: '' }]);
    // The user paid 40 of a 100 total at 35%: share 65, so the user owes 25.
    expect(sharedLines(-4000, 10000, 35, 'c', 'P')).toEqual([{ amount: -6500, memo: '', categoryId: 'c' }, { transferAccountId: 'P', amount: 2500, memo: '' }]);
    expect(sharedLines(-10000, 10000, 0, 'c', 'P')).toEqual([{ amount: -10000, memo: '', categoryId: 'c' }]);
    expect(sharedLines(-10000, 10000, 100, 'c', 'P')).toEqual([{ transferAccountId: 'P', amount: -10000, memo: '' }]);
    for (const l of [sharedLines(-4000, 10000, 35, 'c', 'P')]) expect(l.reduce((s, x) => s + x.amount, 0)).toBe(-4000);
  });
});

describe('parseSheet', () => {
  const rows = [
    HEADER,
    ['Jan 1, 2026', '0', '211.75', '0', 'Carry-over from 2025', '', '', '', '', '-1284.48', '1284.48'],
    ['Apr 9, 2026', '28.99', '0', '35', 'Grocer', 'Groceries', '18.84', '10.15'],
    ['Apr 12, 2026', '0', '$60.00', '35', 'Pet Store', 'Pets', '39', '21'],
    ['Apr 15, 2026', '40', '60', '35', 'Hardware', '', '65', '35'],
    ['', '0', '0', '35', '', '', '0', '0'],
    ['Apr 20, 2026', '10', '0', '100', 'Gift for them', '', '0', '10'],
  ];
  test('header detection is structural', () => {
    expect(isSheetHeader(HEADER)).toEqual({ date: 0, paid: [1, 2], percent: 3, where: 4, what: 5 });
    expect(isSheetHeader(['Date', 'Payee', 'Amount'])).toBeNull();
  });
  test('only dated rows, no carry-over, percent is the second person\'s share', () => {
    const r = parseSheet(rows, true);
    expect(r.map((x) => [x.date, x.mine, x.theirs, x.percent, x.where, x.what])).toEqual([
      ['2026-04-09', 2899, 0, 35, 'Grocer', 'Groceries'],
      ['2026-04-12', 0, 6000, 35, 'Pet Store', 'Pets'],
      ['2026-04-15', 4000, 6000, 35, 'Hardware', ''],
      ['2026-04-20', 1000, 0, 100, 'Gift for them', ''],
    ]);
    expect(new Set(r.map((x) => x.key)).size).toBe(4);
    // If the user is the second person, the percent flips.
    expect(parseSheet(rows, false)[0]).toMatchObject({ mine: 0, theirs: 2899, percent: 65 });
    expect(() => parseSheet([['a', 'b']], true)).toThrow(/not a shared expense sheet/);
  });
});

describe('planSheet and planClaims', () => {
  const s = seedData('2026-09');
  const accountsById = new Map(s.accounts.map((a) => [a.id, a]));
  const person = { ...s.accounts[0]!, id: 'acc_partner', name: 'Partner', kind: 'person' as const, onBudget: true };
  accountsById.set('acc_partner', person);
  const state = { transactions: s.transactions, payees: s.payees, claims: [] as ShareClaim[], accountsById };
  const rows = parseSheet([
    HEADER,
    ['Sep 3, 2026', '123.45', '0', '35', 'Grocer', 'Groceries'],
    ['Sep 6, 2026', '0', '60', '35', 'Pet Store', 'Pets'],
  ], true);
  let n = 0;
  const ids = () => `id${++n}`;

  test('claims for what the user paid, person-account rows for what the partner paid', () => {
    const plan = planSheet(rows, 'acc_partner', state, 1000, ids);
    expect(plan.claims).toHaveLength(1);
    expect(plan.claims[0]).toMatchObject({ date: '2026-09-03', total: 12345, paid: 12345, percent: 35, description: 'Grocer', categoryHint: 'Groceries', status: 'open' });
    expect(plan.partnerPaid).toHaveLength(1);
    expect(plan.partnerPaid[0]).toMatchObject({ amount: -3900, descriptor: 'Pet Store', memo: 'Pets' });
    const created = plan.edits.filter((e) => 'create' in e);
    expect(created.map((e) => e.table).sort()).toEqual(['claims', 'payees', 'transactions']);
    // Idempotent: the same rows again produce nothing new once claims and rows exist.
    const claimsNow = [...state.claims, ...plan.claims];
    const txNow = [...state.transactions, { ...s.transactions[0]!, id: 'pp', accountId: 'acc_partner', externalId: plan.partnerPaid[0]!.externalId }];
    const again = planSheet(rows, 'acc_partner', { ...state, claims: claimsNow, transactions: txNow }, 1001, ids);
    expect(again.claims).toEqual([]);
    expect(again.partnerPaid).toEqual([]);
    expect(again.skipped).toBe(2);
  });

  test('planClaims splits the matching card row and closes the claim', () => {
    const plan = planSheet(rows, 'acc_partner', state, 1000, ids);
    const r = planClaims(plan.claims, s.transactions, accountsById, 'acc_partner', (id) => s.payees.find((p) => p.id === id)?.name ?? '');
    expect(r.applied).toEqual([{ claimId: plan.claims[0]!.id, txId: 'seed_t13' }]);
    const patch = (r.edits[0] as { patch: Partial<Transaction> }).patch;
    expect(patch.lines).toEqual([{ amount: -8024, memo: '', categoryId: 'cat_groc' }, { transferAccountId: 'acc_partner', amount: -4321, memo: '' }]);
    expect(patch.shared).toEqual({ accountId: 'acc_partner', percent: 35 });
    expect(patch.status).toBe('ok');
    expect(r.edits[1]).toMatchObject({ table: 'claims', patch: { status: 'applied', transactionId: 'seed_t13' } });
  });
});
