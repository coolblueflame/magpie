import { describe, expect, test } from 'vitest';
import {
  inferAccounts, isYnabPlan, isYnabRegister, parseYnabDate, parseYnabMoney, parseYnabMonth,
  readYnabPlan, readYnabRegister,
} from './ynab';
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
    expect(reg[5]!.cleared).toBe('uncleared');
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
