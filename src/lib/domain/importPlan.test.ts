import { describe, expect, test } from 'vitest';
import { foldEdits, planImport, type ImportCandidate, type ImportState, type PlanEdit } from './importPlan';
import { seedData } from './seed';
import type { Transaction } from './types';

const cand = (externalId: string, date: string, amount: number, descriptor: string, memo = ''): ImportCandidate =>
  ({ externalId, date, amount, descriptor, memo, source: { kind: 'ofx', batchId: 'b1' } });

function stateFrom(over: Partial<ImportState> = {}): ImportState {
  const s = seedData('2026-09');
  return { transactions: s.transactions, payees: s.payees, accountsById: new Map(s.accounts.map((a) => [a.id, a])), ...over };
}

describe('planImport', () => {
  test('known ids skip, manual rows link and clear, far transfer sides get the id on their line, the rest are new', () => {
    const s = stateFrom();
    const known: Transaction = { ...s.transactions[0]!, id: 'k', accountId: 'acc_card', externalId: 'fit-known', amount: -100, lines: [{ categoryId: 'cat_fun', amount: -100, memo: '' }] };
    const manual: Transaction = { ...s.transactions[0]!, id: 'm', accountId: 'acc_card', date: '2026-09-03', amount: -999, cleared: 'uncleared', payeeId: 'pay_arcade', lines: [{ categoryId: 'cat_fun', amount: -999, memo: '' }] };
    delete (manual as Partial<Transaction>).externalId;
    s.transactions = [...s.transactions, known, manual];
    let n = 0;
    const plan = planImport([
      cand('fit-known', '2026-09-01', -100, 'ANYTHING'),
      cand('fit-manual', '2026-09-05', -999, 'ARCADE FUN CENTRE'),
      cand('fit-payment', '2026-08-14', 38000, 'PAYMENT THANK YOU'),
      cand('fit-new', '2026-09-06', -1234, 'GROCER MART #12'),
      cand('fit-new2', '2026-09-06', -500, 'grocer mart #12'),
    ], 'acc_card', s, () => `id${++n}`);

    expect(plan.summary).toBe('5 in file: 1 already imported, 2 matched, 2 new');
    expect(plan.matched.map((m) => [m.txId, m.side])).toEqual([['m', 'own'], ['seed_t10', 'far']]);
    const own = plan.edits.find((e) => 'patch' in e && e.id === 'm')!;
    expect(own).toMatchObject({ patch: { externalId: 'fit-manual', cleared: 'cleared' } });
    const far = plan.edits.find((e) => 'patch' in e && e.id === 'seed_t10') as unknown as { patch: { lines: { farExternalId?: string; farCleared?: string }[] } };
    expect(far.patch.lines[0]).toMatchObject({ farExternalId: 'fit-payment', farCleared: 'cleared' });
    // One new payee for both new rows (same descriptor, different case), created once.
    expect(plan.payeesToCreate).toEqual([{ id: 'id1', name: 'GROCER MART #12' }]);
    const creates = plan.edits.filter((e) => 'create' in e && e.table === 'transactions') as { create: Record<string, unknown> }[];
    expect(creates).toHaveLength(2);
    expect(creates[0]!.create).toMatchObject({ accountId: 'acc_card', status: 'new', externalId: 'fit-new', payeeId: 'id1', cleared: 'cleared', lines: [{ amount: -1234, memo: '' }] });
    expect(creates[1]!.create).toMatchObject({ payeeId: 'id1' });
  });

  test('an existing payee is reused by alias; tracking accounts create rows already ok', () => {
    const s = stateFrom();
    s.payees = s.payees.map((p) => (p.id === 'pay_grocer' ? { ...p, aliases: ['grocer mart #12 townsville'] } : p));
    const plan = planImport([cand('x1', '2026-09-06', -1234, 'GROCER MART #12  TOWNSVILLE')], 'acc_card', s);
    expect(plan.payeesToCreate).toEqual([]);
    expect((plan.edits[0] as unknown as { create: { payeeId: string } }).create.payeeId).toBe('pay_grocer');
    const inv = planImport([cand('y1', '2026-09-06', 900, 'DIVIDEND')], 'acc_inv', s);
    expect((inv.edits.find((e) => e.table === 'transactions') as unknown as { create: { status: string } }).create.status).toBe('ok');
  });

  test('a row imported from YNAB is still matchable; a row already linked to a bank id is not', () => {
    const s = stateFrom();
    const fromYnab: Transaction = { ...s.transactions[0]!, id: 'y', accountId: 'acc_card', date: '2026-09-03', amount: -777, externalId: 'ynab:abcd1234', payeeId: 'pay_arcade', lines: [{ categoryId: 'cat_fun', amount: -777, memo: '' }] };
    const linked: Transaction = { ...fromYnab, id: 'l', amount: -778, externalId: 'fitid:old' };
    s.transactions = [...s.transactions, fromYnab, linked];
    const plan = planImport([cand('fitid:new1', '2026-09-05', -777, 'ARCADE'), cand('fitid:new2', '2026-09-05', -778, 'ARCADE')], 'acc_card', s);
    expect(plan.matched.map((m) => m.txId)).toEqual(['y']);
    expect(plan.edits.find((e) => 'patch' in e && e.id === 'y')).toMatchObject({ patch: { externalId: 'fitid:new1' } });
    expect(plan.created.map((c) => c.externalId)).toEqual(['fitid:new2']);
  });

  test('foldEdits merges a patch into an earlier create of the same row and leaves others alone', () => {
    const edits: PlanEdit[] = [
      { table: 'claims', id: 'c1', create: { status: 'open', total: 5 } },
      { table: 'transactions', id: 't9', patch: { status: 'ok' } },
      { table: 'claims', id: 'c1', patch: { status: 'applied', transactionId: 't9' } },
    ];
    expect(foldEdits(edits)).toEqual([
      { table: 'claims', id: 'c1', create: { status: 'applied', total: 5, transactionId: 't9' } },
      { table: 'transactions', id: 't9', patch: { status: 'ok' } },
    ]);
  });

  test('two far-side lines of one transaction matched in one plan keep both links', () => {
    const s = stateFrom();
    const twin: Transaction = { ...s.transactions[0]!, id: 'tw', accountId: 'acc_chq', date: '2026-09-02', amount: -3000, lines: [
      { transferAccountId: 'acc_card', amount: -1000, memo: '' }, { transferAccountId: 'acc_card', amount: -2000, memo: '' }] };
    delete (twin as Partial<Transaction>).externalId;
    s.transactions = [...s.transactions, twin];
    const plan = planImport([cand('f1', '2026-09-03', 1000, 'PAYMENT'), cand('f2', '2026-09-03', 2000, 'PAYMENT')], 'acc_card', s);
    const patches = plan.edits.filter((e) => 'patch' in e && e.id === 'tw') as unknown as { patch: { lines: { farExternalId?: string }[] } }[];
    expect(patches).toHaveLength(1);
    expect(patches[0]!.patch.lines.map((l) => l.farExternalId)).toEqual(['f1', 'f2']);
  });

  test('a matched candidate never creates; unknown account throws', () => {
    const s = stateFrom();
    const plan = planImport([cand('p', '2026-08-14', 38000, 'PAYMENT')], 'acc_card', s);
    expect(plan.created).toEqual([]);
    expect(() => planImport([], 'nope', s)).toThrow(/unknown account/);
  });
});
