/**
 * YNAB "Export budget" import: readers for the Register and Plan CSVs,
 * account inference, and (below) the builder that turns them into rows.
 * Column names and value shapes are those of the export as of 2026.
 */
import { csvObjects } from './csv';
import { parseCents } from './money';
import type { AccountKind, Cents, ClearedState, IsoDate, MonthKey } from './types';

export interface YnabRegisterRow {
  account: string;
  date: IsoDate;
  payee: string;
  group: string;
  category: string;
  /** "Group: Category" as exported; '' for uncategorised rows. */
  groupCategory: string;
  memo: string;
  /** inflow − outflow, in cents. */
  amount: Cents;
  cleared: ClearedState;
  /** 1-based data line, for error messages. */
  line: number;
}

export interface YnabPlanRow {
  month: MonthKey;
  group: string;
  category: string;
  groupCategory: string;
  assigned: Cents;
  activity: Cents;
  available: Cents;
}

export const REGISTER_HEADER = 'Account,Flag,Date,Payee,Category Group/Category,Category Group,Category,Memo,Outflow,Inflow,Cleared';
export const PLAN_HEADER = 'Month,Category Group/Category,Category Group,Category,Assigned,Activity,Available';

const normaliseHeader = (line: string) => line.replace(/^﻿/, '').replace(/"/g, '').trim();

export function isYnabRegister(headerLine: string): boolean {
  return normaliseHeader(headerLine) === REGISTER_HEADER;
}

export function isYnabPlan(headerLine: string): boolean {
  return normaliseHeader(headerLine) === PLAN_HEADER;
}

/** "$1,234.56" → 123456; "-$50.00" and "$-50.00" → -5000; '' → 0. */
export function parseYnabMoney(s: string): Cents {
  const t = s.trim();
  if (!t) return 0;
  const cents = parseCents(t.replace('$-', '-$'));
  if (cents === null) throw new Error(`unreadable YNAB amount "${s}"`);
  return cents;
}

/** "09/04/2026" → "2026-09-04". */
export function parseYnabDate(s: string): IsoDate {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s.trim());
  if (!m) throw new Error(`unreadable YNAB date "${s}"`);
  return `${m[3]}-${m[1]}-${m[2]}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Sep 2026" → "2026-09". */
export function parseYnabMonth(s: string): MonthKey {
  const m = /^([A-Z][a-z]{2}) (\d{4})$/.exec(s.trim());
  const i = m ? MONTHS.indexOf(m[1]!) : -1;
  if (!m || i === -1) throw new Error(`unreadable YNAB month "${s}"`);
  return `${m[2]}-${String(i + 1).padStart(2, '0')}`;
}

export function readYnabRegister(text: string): YnabRegisterRow[] {
  return csvObjects(text).map((r, i) => ({
    account: r['Account'] ?? '',
    date: parseYnabDate(r['Date'] ?? ''),
    payee: r['Payee'] ?? '',
    group: r['Category Group'] ?? '',
    category: r['Category'] ?? '',
    groupCategory: r['Category Group/Category'] ?? '',
    memo: r['Memo'] ?? '',
    amount: parseYnabMoney(r['Inflow'] ?? '') - parseYnabMoney(r['Outflow'] ?? ''),
    // Reconciled is a stronger "cleared"; Magpie has no separate state for it.
    cleared: (r['Cleared'] ?? '') === 'Uncleared' ? 'uncleared' : 'cleared',
    line: i + 1,
  }));
}

export function readYnabPlan(text: string): YnabPlanRow[] {
  return csvObjects(text).map((r) => ({
    month: parseYnabMonth(r['Month'] ?? ''),
    group: r['Category Group'] ?? '',
    category: r['Category'] ?? '',
    groupCategory: r['Category Group/Category'] ?? '',
    assigned: parseYnabMoney(r['Assigned'] ?? ''),
    activity: parseYnabMoney(r['Activity'] ?? ''),
    available: parseYnabMoney(r['Available'] ?? ''),
  }));
}

export const TRANSFER_PREFIX = 'Transfer : ';

export function isTransferPayee(payee: string): boolean {
  return payee.startsWith(TRANSFER_PREFIX);
}

export interface InferredAccount {
  name: string;
  rows: number;
  /** True when the account has at least one categorised non-transfer row: YNAB never categorises tracking accounts. */
  onBudget: boolean;
  kind: AccountKind;
}

export function inferAccounts(rows: YnabRegisterRow[]): InferredAccount[] {
  const seen = new Map<string, InferredAccount>();
  for (const r of rows) {
    const a = seen.get(r.account) ?? { name: r.account, rows: 0, onBudget: false, kind: 'other' as AccountKind };
    a.rows++;
    if (r.category && !isTransferPayee(r.payee)) a.onBudget = true;
    seen.set(r.account, a);
  }
  for (const a of seen.values()) a.kind = a.onBudget ? 'chequing' : 'other';
  return [...seen.values()];
}
