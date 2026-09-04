import { describe, expect, test } from 'vitest';
import { accountBalances, lineEffect, needsCategory, validateTransaction } from './ledger';
import type { Account, Transaction } from './types';

const acct = (id: string, onBudget: boolean): Account => ({
  id, name: id, kind: onBudget ? 'chequing' : 'investment', onBudget, closed: false,
  sortOrder: 0, note: '', updatedAt: 1, deleted: false,
});
const chq = acct('chq', true);
const card = acct('card', true);
const inv = acct('inv', false);
const loan = acct('loan', false);
const byId = new Map([chq, card, inv, loan].map((a) => [a.id, a]));

const tx = (over: Partial<Transaction>): Transaction => ({
  id: 't', accountId: 'chq', date: '2026-09-04', memo: '', amount: -100, cleared: 'cleared',
  status: 'ok', source: { kind: 'manual', batchId: 'b' }, lines: [{ categoryId: 'groc', amount: -100, memo: '' }],
  updatedAt: 1, deleted: false, ...over,
});

describe('needsCategory and lineEffect', () => {
  test('plain spend from an on-budget account', () => {
    const line = { amount: -100, memo: '' };
    expect(needsCategory(line, chq, undefined)).toBe(true);
    expect(lineEffect(line, chq, undefined)).toBe(-100);
  });
  test('plain row in an off-budget account never touches the budget', () => {
    const line = { amount: -100, memo: '' };
    expect(needsCategory(line, inv, undefined)).toBe(false);
    expect(lineEffect(line, inv, undefined)).toBe(0);
  });
  test('transfer between two on-budget accounts has no category and no effect', () => {
    const line = { transferAccountId: 'card', amount: -380, memo: '' };
    expect(needsCategory(line, chq, card)).toBe(false);
    expect(lineEffect(line, chq, card)).toBe(0);
  });
  test('transfer from on-budget to off-budget leaves the budget by the line amount', () => {
    const line = { transferAccountId: 'inv', categoryId: 'save', amount: -500, memo: '' };
    expect(needsCategory(line, chq, inv)).toBe(true);
    expect(lineEffect(line, chq, inv)).toBe(-500);
  });
  test('transfer entered on the off-budget side into the budget is negated', () => {
    const line = { transferAccountId: 'chq', categoryId: 'rta', amount: -500, memo: '' };
    expect(needsCategory(line, inv, chq)).toBe(true);
    expect(lineEffect(line, inv, chq)).toBe(500);
  });
  test('transfer between two off-budget accounts is invisible', () => {
    const line = { transferAccountId: 'loan', amount: -500, memo: '' };
    expect(needsCategory(line, inv, loan)).toBe(false);
    expect(lineEffect(line, inv, loan)).toBe(0);
  });
});

describe('validateTransaction', () => {
  test('a well-formed spend is valid', () => {
    expect(validateTransaction(tx({}), byId)).toEqual([]);
  });
  test('lines must sum to the amount', () => {
    expect(validateTransaction(tx({ lines: [{ categoryId: 'groc', amount: -90, memo: '' }] }), byId))
      .toContain('lines sum to -90, amount is -100');
  });
  test('an ok transaction needs a category where the budget is touched', () => {
    expect(validateTransaction(tx({ lines: [{ amount: -100, memo: '' }] }), byId))
      .toContain('line 1 needs a category');
  });
  test('a new transaction may leave the category empty', () => {
    expect(validateTransaction(tx({ status: 'new', lines: [{ amount: -100, memo: '' }] }), byId)).toEqual([]);
  });
  test('a category where the budget is not touched is allowed and reporting-only', () => {
    const line = { transferAccountId: 'card', categoryId: 'groc', amount: -100, memo: '' };
    expect(validateTransaction(tx({ lines: [line] }), byId)).toEqual([]);
    expect(lineEffect(line, chq, card)).toBe(0);
    const drift = { categoryId: 'invincome', amount: 1234, memo: '' };
    expect(validateTransaction(tx({ accountId: 'inv', amount: 1234, lines: [drift] }), byId)).toEqual([]);
    expect(lineEffect(drift, inv, undefined)).toBe(0);
  });
  test('a transfer to the same account and to an unknown account are rejected', () => {
    expect(validateTransaction(tx({ lines: [{ transferAccountId: 'chq', amount: -100, memo: '' }] }), byId))
      .toContain('line 1 transfers to its own account');
    expect(validateTransaction(tx({ lines: [{ transferAccountId: 'nope', amount: -100, memo: '' }] }), byId))
      .toContain('line 1 transfers to unknown account nope');
  });
  test('an unknown account is rejected', () => {
    expect(validateTransaction(tx({ accountId: 'nope' }), byId)).toContain('unknown account nope');
  });
});

describe('accountBalances', () => {
  test('own rows, transfers on both sides, cleared vs working, tombstones ignored', () => {
    const rows: Transaction[] = [
      tx({ id: 'a', amount: 1000, lines: [{ categoryId: 'rta', amount: 1000, memo: '' }] }),
      tx({ id: 'b', amount: -380, cleared: 'uncleared',
        lines: [{ transferAccountId: 'card', amount: -380, memo: '', farCleared: 'cleared' }] }),
      tx({ id: 'c', accountId: 'card', amount: -200, lines: [{ categoryId: 'groc', amount: -200, memo: '' }] }),
      tx({ id: 'd', amount: -999, deleted: true }),
    ];
    const b = accountBalances([chq, card, inv, loan], rows);
    expect(b.get('chq')).toEqual({ working: 620, cleared: 1000 });
    expect(b.get('card')).toEqual({ working: 180, cleared: 180 });
    expect(b.get('inv')).toEqual({ working: 0, cleared: 0 });
  });
});
