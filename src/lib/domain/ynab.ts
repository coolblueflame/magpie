/**
 * YNAB "Export budget" import: readers for the Register and Plan CSVs,
 * account inference, and (below) the builder that turns them into rows.
 * Column names and value shapes are those of the export as of 2026.
 */
import { nanoid } from 'nanoid';
import { computeBudget } from './budget';
import { csvObjects } from './csv';
import { accountBalances, lineEffect, needsCategory } from './ledger';
import { parseCents } from './money';
import { monthOf } from './month';
import {
  assignmentId, RTA, ynabHistoryId,
  type Account, type AccountKind, type Assignment, type Category, type CategoryGroup, type Cents, type ClearedState,
  type IsoDate, type Line, type MonthKey, type Payee, type Transaction, type YnabHistory,
} from './types';

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

// ── builder ────────────────────────────────────────────────────────────────

export const CC_GROUP = 'Credit Card Payments';
export const HIDDEN_GROUP = 'Hidden Categories';
export const RTA_GROUP_CATEGORY = 'Inflow: Ready to Assign';

export interface YnabAccountChoice {
  kind: AccountKind;
  onBudget: boolean;
  /** The partner's account (spec §4.4): forces kind 'person' and on-budget. */
  person?: boolean;
}

export interface YnabBuildOptions {
  /** One entry per account name in the register; missing names are an error. */
  accounts: Record<string, YnabAccountChoice>;
  now: number;
  /** Row id source; tests pass a counter for stable ids. */
  idFor?: () => string;
  /** Override for the cutover month; see defaultCutoverMonth. */
  cutoverMonth?: MonthKey;
}

/**
 * The month Magpie's rules take over: the month of the latest register row,
 * capped by the latest Plan month. The Plan alone would move the cutover into
 * the future whenever money was assigned ahead in YNAB.
 */
export function defaultCutoverMonth(register: YnabRegisterRow[], plan: YnabPlanRow[]): MonthKey {
  const planMax = plan.reduce((m, r) => (r.month > m ? r.month : m), plan[0]?.month ?? '');
  const registerMax = register.reduce((m, r) => (r.date.slice(0, 7) > m ? r.date.slice(0, 7) : m), '');
  if (!planMax) throw new Error('the Plan file has no rows');
  return registerMax && registerMax < planMax ? registerMax : planMax;
}

export interface YnabReport {
  counts: {
    accounts: number; groups: number; categories: number; payees: number; transactions: number;
    splits: number; transfers: number; newRows: number; assignments: number; history: number;
  };
  /** Per imported category: YNAB's available at cutover vs what the built rows compute. */
  cutover: { categoryId: string; name: string; ynab: Cents; magpie: Cents }[];
  cutoverMismatches: number;
  /** Plan cells outside the dropped group whose activity differs from the built rows. */
  activityMismatches: number;
  /** Σ Credit Card Payments available at cutover; under Magpie's rules it is part of Ready to Assign. */
  creditCardFolded: Cents;
  droppedGroups: string[];
  balances: { name: string; working: Cents }[];
}

export interface YnabImport {
  accounts: Account[];
  groups: CategoryGroup[];
  categories: Category[];
  payees: Payee[];
  transactions: Transaction[];
  assignments: Assignment[];
  history: YnabHistory[];
  cutoverMonth: MonthKey;
  report: YnabReport;
}

/** 32-bit FNV-1a as 8 hex chars; a stable, cheap row fingerprint. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const SPLIT_RE = /^Split \((\d+)\/(\d+)\)\s?(.*)$/s;

/**
 * Turn a YNAB export into a complete row set plus a verification report.
 * Splits fold into one transaction with a line per export row (a line's payee
 * survives in its memo when it differs); a transfer's two export rows become
 * one transaction owned by the on-budget side; the Credit Card Payments group
 * is dropped; Hidden Categories become a hidden group. See spec §5.1.
 */
export function buildYnabImport(register: YnabRegisterRow[], plan: YnabPlanRow[], opts: YnabBuildOptions): YnabImport {
  const now = opts.now;
  const newId = opts.idFor ?? nanoid;
  const stamp = () => ({ updatedAt: now, editedAt: now, deleted: false as const });
  const batchId = `ynab-${now}`;
  if (!plan.length) throw new Error('the Plan file has no rows');
  const cutoverMonth = opts.cutoverMonth ?? defaultCutoverMonth(register, plan);

  // Groups and categories from the Plan, in order of first appearance.
  const groups = new Map<string, CategoryGroup>();
  const categories = new Map<string, Category>();
  const droppedGroups: string[] = [];
  const ensureGroup = (name: string, hidden: boolean): CategoryGroup => {
    let g = groups.get(name);
    if (!g) { g = { ...stamp(), id: newId(), name, sortOrder: groups.size, hidden }; groups.set(name, g); }
    return g;
  };
  const ensureCategory = (groupName: string, name: string, groupCategory: string, hidden: boolean): Category => {
    let c = categories.get(groupCategory);
    if (!c) {
      const g = ensureGroup(groupName, hidden);
      const siblings = [...categories.values()].filter((x) => x.groupId === g.id).length;
      c = { ...stamp(), id: newId(), groupId: g.id, name, goal: 0, sortOrder: siblings, hidden, note: '' };
      categories.set(groupCategory, c);
    }
    return c;
  };
  for (const r of plan) {
    if (r.group === CC_GROUP) { if (!droppedGroups.includes(CC_GROUP)) droppedGroups.push(CC_GROUP); continue; }
    const hidden = r.group === HIDDEN_GROUP;
    ensureCategory(hidden ? 'Hidden' : r.group, r.category, r.groupCategory, hidden);
  }
  const planAt = new Map(plan.map((r) => [`${r.groupCategory}|${r.month}`, r]));
  for (const [gc, c] of categories) {
    const cut = planAt.get(`${gc}|${cutoverMonth}`);
    const carried = cut ? cut.available - cut.assigned - cut.activity : 0;
    if (carried !== 0) c.carriedIn = carried;
  }

  // Accounts, in register order, from Ben's choices.
  const accounts = new Map<string, Account>();
  for (const r of register) {
    if (accounts.has(r.account)) continue;
    const choice = opts.accounts[r.account];
    if (!choice) throw new Error(`account "${r.account}" has no import choice`);
    accounts.set(r.account, {
      ...stamp(), id: newId(), name: r.account,
      kind: choice.person ? 'person' : choice.kind,
      onBudget: choice.person ? true : choice.onBudget,
      closed: false, sortOrder: accounts.size, note: '',
    });
  }
  const accountByName = (name: string): Account => {
    const a = accounts.get(name);
    if (!a) throw new Error(`transfer names unknown account "${name}"`);
    return a;
  };

  // Payees.
  const payees = new Map<string, Payee>();
  for (const r of register) {
    if (!r.payee || isTransferPayee(r.payee) || payees.has(r.payee)) continue;
    payees.set(r.payee, { ...stamp(), id: newId(), name: r.payee, aliases: [], note: '' });
  }

  const categoryIdOf = (r: YnabRegisterRow): string | undefined => {
    if (!r.groupCategory) return undefined;
    if (r.groupCategory === RTA_GROUP_CATEGORY) return RTA;
    return (categories.get(r.groupCategory) ?? ensureCategory('Imported', r.category || r.groupCategory, r.groupCategory, false)).id;
  };

  // Transactions. Mirror lookup for transfers: the other account's row that names this one.
  const byKey = new Map<string, number[]>();
  const keyOf = (account: string, payee: string, date: string, amount: number) => `${account}|${payee}|${date}|${amount}`;
  register.forEach((r, i) => {
    const k = keyOf(r.account, r.payee, r.date, r.amount);
    const list = byKey.get(k) ?? [];
    list.push(i);
    byKey.set(k, list);
  });
  const consumed = new Set<number>();
  const isSplitLine = (i: number) => SPLIT_RE.test(register[i]!.memo);
  /**
   * The other account's unconsumed row that names this one, same date,
   * opposite amount. Plain rows are preferred; a split line is returned only
   * when nothing else matches, so a plain row whose mirror sits inside a
   * split can be deferred until that split consumes it.
   */
  const findMirror = (i: number): number => {
    const r = register[i]!;
    const other = r.payee.slice(TRANSFER_PREFIX.length);
    const list = (byKey.get(keyOf(other, TRANSFER_PREFIX + r.account, r.date, -r.amount)) ?? [])
      .filter((x) => x !== i && !consumed.has(x));
    const j = list.find((x) => !isSplitLine(x)) ?? list[0];
    if (j === undefined) throw new Error(`transfer on line ${r.line} has no mirror row in "${other}"`);
    return j;
  };
  const externalId = (r: YnabRegisterRow) => `ynab:${fnv1a([r.account, r.date, r.payee, r.memo, r.amount, r.line].join('|'))}`;

  const transactions: Transaction[] = [];
  const counts = { splits: 0, transfers: 0, newRows: 0 };

  /** A line for one export row; a transfer row also consumes its mirror. */
  const lineFor = (i: number, memo: string): Line => {
    const r = register[i]!;
    if (!isTransferPayee(r.payee)) return { amount: r.amount, memo, ...(categoryIdOf(r) ? { categoryId: categoryIdOf(r)! } : {}) };
    const j = findMirror(i);
    if (isSplitLine(j)) throw new Error(`transfer on line ${r.line} mirrors another split line (${register[j]!.line}); not supported`);
    consumed.add(j);
    counts.transfers++;
    const mirror = register[j]!;
    const categoryId = categoryIdOf(r) ?? categoryIdOf(mirror);
    return {
      transferAccountId: accountByName(mirror.account).id, amount: r.amount, memo,
      ...(categoryId ? { categoryId } : {}), farCleared: mirror.cleared,
    };
  };

  const push = (own: Account, first: YnabRegisterRow, payee: string | undefined, amount: Cents, memo: string, cleared: ClearedState, lines: Line[]) => {
    const isNew = lines.some((l) => {
      const far = l.transferAccountId ? [...accounts.values()].find((a) => a.id === l.transferAccountId) : undefined;
      return !l.categoryId && needsCategory(l, own, far);
    });
    if (isNew) counts.newRows++;
    transactions.push({
      ...stamp(), id: newId(), accountId: own.id, date: first.date, memo, amount, cleared,
      status: isNew ? 'new' : 'ok', externalId: externalId(first), source: { kind: 'ynab', batchId },
      ...(payee && payees.has(payee) ? { payeeId: payees.get(payee)!.id } : {}),
      lines,
    });
  };

  for (let i = 0; i < register.length; i++) {
    if (consumed.has(i)) continue;
    const r = register[i]!;
    const own = accountByName(r.account);
    const split = SPLIT_RE.exec(r.memo);
    if (split && split[1] === '1') {
      const n = Number(split[2]);
      const rows = register.slice(i, i + n);
      rows.forEach((x, k) => {
        const m = SPLIT_RE.exec(x.memo);
        if (!m || Number(m[1]) !== k + 1 || Number(m[2]) !== n || x.account !== r.account || x.date !== r.date) {
          throw new Error(`split starting on line ${r.line} is not ${n} consecutive rows`);
        }
      });
      const payee = rows.find((x) => !isTransferPayee(x.payee))?.payee;
      const lines = rows.map((x, k) => {
        const rest = (SPLIT_RE.exec(x.memo)![3] ?? '').trim();
        const memo = x.payee !== payee && !isTransferPayee(x.payee) ? (rest ? `${x.payee}: ${rest}` : x.payee) : rest;
        return lineFor(i + k, memo);
      });
      counts.splits++;
      push(own, r, payee, lines.reduce((s, l) => s + l.amount, 0), (SPLIT_RE.exec(r.memo)![3] ?? '').trim(), r.cleared, lines);
      i += n - 1;
      continue;
    }
    if (isTransferPayee(r.payee)) {
      const j = findMirror(i);
      // The mirror is a line of a split further down; that split owns the transaction.
      if (isSplitLine(j)) continue;
      const mirror = register[j]!;
      const mirrorAccount = accountByName(mirror.account);
      // The on-budget side owns the row so its category attaches naturally.
      const ownerIsThis = own.onBudget || !mirrorAccount.onBudget;
      const [ownerRow, otherRow, ownerAcct, otherAcct] = ownerIsThis ? [r, mirror, own, mirrorAccount] : [mirror, r, mirrorAccount, own];
      consumed.add(j);
      counts.transfers++;
      const categoryId = categoryIdOf(ownerRow) ?? categoryIdOf(otherRow);
      push(ownerAcct, ownerRow, undefined, ownerRow.amount, ownerRow.memo, ownerRow.cleared, [{
        transferAccountId: otherAcct.id, amount: ownerRow.amount, memo: ownerRow.memo,
        ...(categoryId ? { categoryId } : {}), farCleared: otherRow.cleared,
      }]);
      continue;
    }
    push(own, r, r.payee, r.amount, r.memo, r.cleared, [lineFor(i, r.memo)]);
  }

  const assignments: Assignment[] = plan
    .filter((r) => r.group !== CC_GROUP && r.assigned !== 0)
    .map((r) => ({ ...stamp(), id: assignmentId(categories.get(r.groupCategory)!.id, r.month), categoryId: categories.get(r.groupCategory)!.id, month: r.month, amount: r.assigned }));
  const history: YnabHistory[] = plan
    .filter((r) => r.group !== CC_GROUP && r.month < cutoverMonth)
    .map((r) => ({ ...stamp(), id: ynabHistoryId(categories.get(r.groupCategory)!.id, r.month), categoryId: categories.get(r.groupCategory)!.id, month: r.month, assigned: r.assigned, activity: r.activity, available: r.available }));

  // Verification: the rows about to be written must reproduce the Plan.
  const accountList = [...accounts.values()];
  const categoryList = [...categories.values()];
  const budget = computeBudget({ accounts: accountList, categories: categoryList, assignments, transactions, history, cutoverMonth, currentMonth: cutoverMonth }, cutoverMonth);
  const cutover = [...categories.entries()].map(([gc, c]) => ({
    categoryId: c.id, name: c.name, ynab: planAt.get(`${gc}|${cutoverMonth}`)?.available ?? 0, magpie: budget.rows.get(c.id)?.available ?? 0,
  }));
  const accountsById = new Map(accountList.map((a) => [a.id, a]));
  const activity = new Map<string, Cents>();
  for (const tx of transactions) {
    const own = accountsById.get(tx.accountId)!;
    for (const l of tx.lines) {
      const far = l.transferAccountId ? accountsById.get(l.transferAccountId) : undefined;
      if (!l.categoryId || l.categoryId === RTA || !needsCategory(l, own, far)) continue;
      const k = `${l.categoryId}|${monthOf(tx.date)}`;
      activity.set(k, (activity.get(k) ?? 0) + lineEffect(l, own, far));
    }
  }
  const activityMismatches = plan.filter((r) => r.group !== CC_GROUP && (activity.get(`${categories.get(r.groupCategory)!.id}|${r.month}`) ?? 0) !== r.activity).length;
  const creditCardFolded = plan.filter((r) => r.group === CC_GROUP && r.month === cutoverMonth).reduce((s, r) => s + r.available, 0);
  const balances = accountBalances(accountList, transactions);

  return {
    accounts: accountList, groups: [...groups.values()], categories: categoryList, payees: [...payees.values()],
    transactions, assignments, history, cutoverMonth,
    report: {
      counts: {
        accounts: accountList.length, groups: groups.size, categories: categoryList.length, payees: payees.size,
        transactions: transactions.length, splits: counts.splits, transfers: counts.transfers, newRows: counts.newRows,
        assignments: assignments.length, history: history.length,
      },
      cutover, cutoverMismatches: cutover.filter((c) => c.ynab !== c.magpie).length, activityMismatches, creditCardFolded, droppedGroups,
      balances: accountList.map((a) => ({ name: a.name, working: balances.get(a.id)?.working ?? 0 })),
    },
  };
}
