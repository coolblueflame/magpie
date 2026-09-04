import { describe, expect, test } from 'vitest';
import {
  buildYnabImport, inferAccounts, isYnabPlan, isYnabRegister, parseYnabDate, parseYnabMoney, parseYnabMonth,
  readYnabPlan, readYnabRegister,
} from './ynab';
import { lineEffect, validateTransaction } from './ledger';
import { RTA } from './types';
import { PLAN_CSV, REGISTER_CSV } from './ynabFixture';

describe('YNAB value parsers', () => {
  test('money in the shapes the export uses', () => {
    expect(parseYnabMoney('$1,234.56')).toBe(123456);
    expect(parseYnabMoney('$0.00')).toBe(0);
    expect(parseYnabMoney('-$50.00')).toBe(-5000);
    expect(parseYnabMoney('$-50.00')).toBe(-5000);
    expect(parseYnabMoney('')).toBe(0);
    expect(() => parseYnabMoney('nope')).toThrow(/unreadable/);
  });
  test('dates and months', () => {
    expect(parseYnabDate('09/04/2026')).toBe('2026-09-04');
    expect(parseYnabMonth('Sep 2026')).toBe('2026-09');
    expect(parseYnabMonth('Dec 2018')).toBe('2018-12');
    expect(() => parseYnabDate('2026-09-04')).toThrow(/unreadable/);
  });
  test('header detection tolerates quotes and a BOM', () => {
    expect(isYnabRegister(REGISTER_CSV.split('\n')[0]!)).toBe(true);
    expect(isYnabPlan('﻿' + PLAN_CSV.split('\n')[0]!)).toBe(true);
    expect(isYnabRegister(PLAN_CSV.split('\n')[0]!)).toBe(false);
  });
});

describe('readers on the fixture', () => {
  const reg = readYnabRegister(REGISTER_CSV);
  const plan = readYnabPlan(PLAN_CSV);
  test('register rows, signs, cleared mapping, split memos', () => {
    expect(reg).toHaveLength(17);
    expect(reg[0]).toMatchObject({ account: 'Chequing', date: '2026-07-01', amount: 100000, cleared: 'cleared', groupCategory: 'Inflow: Ready to Assign', line: 1 });
    expect(reg[1]!.amount).toBe(-4500);
    expect(reg[2]!.cleared).toBe('uncleared');
    expect(reg.filter((r) => r.memo.startsWith('Split'))).toHaveLength(3);
  });
  test('plan rows and month keys', () => {
    expect(plan).toHaveLength(15);
    expect(plan[0]).toMatchObject({ month: '2026-07', groupCategory: 'Everyday: Groceries', assigned: 10000, activity: -5500, available: 4500 });
    expect(plan[6]!.available).toBe(-1500);
  });
  test('inferAccounts: categorised rows make an account on-budget', () => {
    expect(inferAccounts(reg)).toEqual([
      { name: 'Chequing', rows: 8, onBudget: true, kind: 'chequing' },
      { name: 'Card', rows: 5, onBudget: true, kind: 'chequing' },
      { name: 'Partner', rows: 2, onBudget: true, kind: 'chequing' },
      { name: 'Brokerage', rows: 2, onBudget: false, kind: 'other' },
    ]);
  });
});

describe('buildYnabImport on the fixture', () => {
  let n = 0;
  const built = buildYnabImport(readYnabRegister(REGISTER_CSV), readYnabPlan(PLAN_CSV), {
    accounts: {
      Chequing: { kind: 'chequing', onBudget: true },
      Card: { kind: 'credit', onBudget: true },
      Partner: { kind: 'other', onBudget: false, person: true },
      Brokerage: { kind: 'investment', onBudget: false },
    },
    now: 1000,
    idFor: () => `id${++n}`,
  });
  const byName = <T extends { name: string }>(xs: T[], name: string) => xs.find((x) => x.name === name)!;
  const acct = (name: string) => byName(built.accounts, name);
  const cat = (name: string) => byName(built.categories, name);
  const accountsById = new Map(built.accounts.map((a) => [a.id, a]));

  test('counts and dropped groups', () => {
    expect(built.report.counts).toEqual({
      accounts: 4, groups: 3, categories: 4, payees: 9, transactions: 12,
      splits: 1, transfers: 3, newRows: 1, assignments: 5, history: 8,
    });
    expect(built.report.droppedGroups).toEqual(['Credit Card Payments']);
    expect(built.cutoverMonth).toBe('2026-09');
  });
  test('accounts take the choices; person forces kind and on-budget', () => {
    expect(acct('Partner')).toMatchObject({ kind: 'person', onBudget: true });
    expect(acct('Brokerage')).toMatchObject({ kind: 'investment', onBudget: false });
  });
  test('hidden category lands in a hidden group', () => {
    const hobby = cat('Old Hobby');
    expect(hobby.hidden).toBe(true);
    expect(built.groups.find((g) => g.id === hobby.groupId)).toMatchObject({ name: 'Hidden', hidden: true });
  });
  test('carriedIn reproduces what YNAB carried into the cutover month', () => {
    expect(cat('Groceries').carriedIn).toBe(13700);
    expect(cat('Fun').carriedIn).toBeUndefined();   // YNAB reset the -$15.00
    expect(cat('Rent').carriedIn).toBeUndefined();
  });
  test('the split folds into one transaction with a line per row', () => {
    const split = built.transactions.find((t) => t.lines.length === 3)!;
    expect(split.accountId).toBe(acct('Chequing').id);
    expect(split.amount).toBe(-3500);
    expect(split.memo).toBe('tape');
    expect(built.payees.find((p) => p.id === split.payeeId)!.name).toBe('Shop');
    expect(split.lines[0]).toEqual({ amount: -1000, memo: 'tape', categoryId: cat('Groceries').id });
    expect(split.lines[1]).toEqual({ amount: -500, memo: 'Other Shop', categoryId: cat('Fun').id });
    expect(split.lines[2]).toEqual({ transferAccountId: acct('Partner').id, amount: -2000, memo: '', farCleared: 'uncleared' });
    // The mirror row in Partner produced no transaction of its own.
    expect(built.transactions.filter((t) => t.accountId === acct('Partner').id)).toHaveLength(1);
  });
  test('transfers are single rows owned by the on-budget side', () => {
    const toCard = built.transactions.find((t) => t.lines[0]!.transferAccountId === acct('Card').id)!;
    expect(toCard).toMatchObject({ accountId: acct('Chequing').id, amount: -10000, status: 'ok' });
    expect(toCard.lines[0]!.categoryId).toBeUndefined();
    const toBrokerage = built.transactions.find((t) => t.lines[0]!.transferAccountId === acct('Brokerage').id)!;
    expect(toBrokerage.lines[0]!.categoryId).toBe(cat('Rent').id);
    expect(lineEffect(toBrokerage.lines[0]!, acct('Chequing'), acct('Brokerage'))).toBe(-20000);
    expect(built.transactions.filter((t) => t.accountId === acct('Brokerage').id)).toHaveLength(1); // only the uncategorised row
  });
  test('uncategorised rows: new in a budget account, ok off-budget', () => {
    const mystery = built.transactions.find((t) => t.amount === -700)!;
    expect(mystery.status).toBe('new');
    const ether = built.transactions.find((t) => t.amount === 900)!;
    expect(ether).toMatchObject({ status: 'ok', accountId: acct('Brokerage').id });
  });
  test('income rows target RTA', () => {
    expect(built.transactions.find((t) => t.amount === 100000)!.lines[0]!.categoryId).toBe(RTA);
  });
  test('every transaction validates and carries a ynab external id', () => {
    for (const t of built.transactions) {
      expect(validateTransaction(t, accountsById)).toEqual([]);
      expect(t.externalId).toMatch(/^ynab:[0-9a-f]{8}$/);
    }
  });
  test('verification: cutover and activity match the Plan; CC available folds into RTA', () => {
    expect(built.report.cutoverMismatches).toBe(0);
    expect(built.report.activityMismatches).toBe(0);
    expect(built.report.cutover.find((c) => c.name === 'Groceries')).toMatchObject({ ynab: 22466, magpie: 22466 });
    expect(built.report.creditCardFolded).toBe(1734);
    expect(built.report.balances).toEqual([
      { name: 'Chequing', working: 116200 }, { name: 'Card', working: -2434 },
      { name: 'Partner', working: 1200 }, { name: 'Brokerage', working: 20900 },
    ]);
  });
  test('a register account without a choice is an error', () => {
    expect(() => buildYnabImport(readYnabRegister(REGISTER_CSV), readYnabPlan(PLAN_CSV), { accounts: {}, now: 1 })).toThrow(/no import choice/);
  });
});
