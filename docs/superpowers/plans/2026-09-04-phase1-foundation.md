# Phase 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A running Svelte 5 app with the storage layer, the store, undo, the money and budget-math domain fully tested, and a budget screen over synthetic seed data where editing an assigned amount persists, recomputes availability and Ready to Assign, and undoes.

**Architecture:** Pure domain functions over plain rows (`src/lib/domain`), one Dexie gateway (`src/lib/storage`), one `$state` store that persists first and patches its mirror second (`src/lib/state`), screens that only read the store and call its methods (`src/lib/ui`). Budget numbers are never stored; `computeBudget` derives them from rows on every render.

**Tech Stack:** Svelte 5 (runes), TypeScript 5, Vite 6, Dexie 4, Vitest 3 + fake-indexeddb, Playwright 1.62 (chromium only), svelte-check 4, nanoid 5.

**Spec:** `docs/superpowers/specs/2026-09-04-magpie-design.md` (§2 platform, §3 data model, §4.1 to §4.3 and §4.7 rules, §6 Budget and Settings screens, §8 testing). Engineering recipe: `docs/PLAYBOOK.md` §2.1 to §2.5, §2.14.

## Global Constraints

- TypeScript stays on 5.x: "TypeScript 7.x breaks svelte-check" (PB §2.1). Pin `typescript: ^5.9.3`.
- Svelte `^5.56.8` runes only; no stores API.
- Money is integer cents in every row and function; outflows negative, inflows positive; formatting only at the UI edge.
- Dates in rows are ISO `YYYY-MM-DD` strings; months are `YYYY-MM` strings. No `Date` objects in rows.
- `$state.snapshot()` before anything reaches IndexedDB; every patch is one read-modify-write inside one `rw` transaction; deletes are tombstones; `updatedAt = max(Date.now(), current + 1)`.
- Nothing personal in the repo: seed data and fixtures are synthetic (generic names, round numbers).
- No em dashes in user-facing copy.
- Desktop-only layout; no phone work, but nothing that breaks at 1024 px.
- Gates before every commit, in order: `npm run check` → `npx vitest run` → `npx playwright test`.
- Commit messages via `git commit -F <file>`; stage files by name; `private/` never staged.
- Copy from `/Users/ben/Noodlevault/organizedchaos` (read-only) where the plan says so; never modify that repo.
- Installing npm packages inside this project folder is allowed. Anything that writes outside it (a Playwright browser download to `~/Library/Caches/ms-playwright`) needs Ben's permission first: check `ls ~/Library/Caches/ms-playwright` for a chromium matching the pinned Playwright before running `npx playwright install`.

---

## File structure

```
package.json, tsconfig.json, svelte.config.js, vite.config.ts, playwright.config.ts
index.html
src/main.ts                     boot: init store, mount App
src/App.svelte                  shell: boot splash, route switch, global keys (undo)
src/app.css                     theme tokens (magpie palette) and base rules
src/vite-env.d.ts
src/tests/setup.ts              fake-indexeddb
src/lib/domain/types.ts         every row type from spec §3
src/lib/domain/money.ts         formatCents, formatMoney, parseCents
src/lib/domain/month.ts         monthOf, addMonths, monthsBetween, compareMonths
src/lib/domain/ledger.ts        needsCategory, lineEffect, validateTransaction, accountBalances
src/lib/domain/budget.ts        computeBudget (availability, activity, RTA, uncategorised)
src/lib/domain/seed.ts          synthetic dataset for dev and e2e
src/lib/storage/db.ts           Dexie schema
src/lib/storage/repo.ts         Repo: loadState, create, patch, remove, putAssignment, settings, importRows
src/lib/state/undo.svelte.ts    copied from OC
src/lib/state/app.svelte.ts     AppStore
src/lib/ui/router.svelte.ts     hash routes: budget/<month>, settings
src/lib/ui/toast.svelte.ts      undo toast state (copied from OC)
src/lib/ui/UndoToast.svelte
src/lib/ui/BudgetView.svelte
src/lib/ui/SettingsView.svelte
e2e/budget.spec.ts
```

Each domain file has a `.test.ts` beside it; `repo.test.ts` and `app.test.ts` run against fake-indexeddb.

---

### Task 1: Scaffold and gates

**Files:**
- Create: `package.json`, `tsconfig.json`, `svelte.config.js`, `vite.config.ts`, `index.html`, `src/main.ts`, `src/App.svelte`, `src/app.css`, `src/vite-env.d.ts`, `src/tests/setup.ts`, `src/lib/domain/smoke.test.ts` (deleted in Task 2)

**Interfaces:**
- Produces: `npm run check`, `npx vitest run`, `npm run build` all green on an app that renders "Magpie".

- [ ] **Step 1: package.json**

```json
{
  "name": "magpie",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "check": "svelte-check --tsconfig ./tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "e2e": "playwright test"
  },
  "dependencies": {
    "dexie": "^4.4.4",
    "nanoid": "^5.1.16",
    "svelte": "^5.56.8"
  },
  "devDependencies": {
    "@playwright/test": "^1.62.0",
    "@sveltejs/vite-plugin-svelte": "^5.1.1",
    "@tsconfig/svelte": "^5.0.8",
    "fake-indexeddb": "^6.2.5",
    "svelte-check": "^4.7.3",
    "typescript": "^5.9.3",
    "vite": "^6.4.3",
    "vitest": "^3.2.7"
  }
}
```

No `vite-plugin-pwa` in phase 1; it arrives with deploy in phase 5.

- [ ] **Step 2: tsconfig.json, svelte.config.js, vite-env.d.ts, tests/setup.ts**

Copy verbatim from OC: `tsconfig.json`, `svelte.config.js`, `src/tests/setup.ts`. For `src/vite-env.d.ts` copy OC's and drop the `vite-plugin-pwa/client` reference line.

- [ ] **Step 3: vite.config.ts**

```ts
/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  // Served from a GitHub Pages project site eventually, so every asset URL lives under this base.
  base: '/magpie/',
  plugins: [svelte()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['src/tests/setup.ts'],
  },
});
```

- [ ] **Step 4: index.html, main.ts, App.svelte, app.css**

`index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#0a0d12" />
    <meta name="description" content="A personal budget that carries every month forward." />
    <title>Magpie</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

`src/main.ts` (store wiring lands in Task 8; this version only mounts):
```ts
import './app.css';
import { mount } from 'svelte';
import App from './App.svelte';

export default mount(App, { target: document.getElementById('app')! });
```

`src/App.svelte` placeholder:
```svelte
<main><h1>Magpie</h1></main>
```

`src/app.css`: the magpie palette. Near-black blue-tinted ground, white text, iridescent blue accents, greys for structure. Every colour in the app references these tokens.
```css
:root {
  --bg0: #0a0d12;   /* app ground: black with a blue tint */
  --bg1: #10151d;   /* panels, table rows */
  --bg2: #182029;   /* raised elements, inputs */
  --line: #223040;  /* hairlines */
  --text: #eef3f8;  /* magpie white */
  --dim: #8c9bab;   /* secondary text */
  --blue: #6fb7ff;  /* primary accent, the wing sheen */
  --blue-deep: #2f6fd6;
  --teal: #4fd1c5;  /* the tail iridescence; positive money */
  --amber: #f0b45a; /* warnings */
  --red: #ff7b72;   /* negative money */
  --font-sans: -apple-system, system-ui, "Segoe UI", Roboto, sans-serif;
  --font-mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  background: var(--bg0);
  color: var(--text);
  font-family: var(--font-sans);
  -webkit-font-smoothing: antialiased;
}
button { font: inherit; color: var(--text); background: none; border: 1px solid var(--line); border-radius: 6px; padding: 4px 10px; cursor: pointer; }
button:hover { border-color: var(--blue); }
input { font: inherit; color: var(--text); background: var(--bg2); border: 1px solid var(--line); border-radius: 4px; padding: 3px 6px; }
input:focus { outline: 1px solid var(--blue); border-color: var(--blue); }
.money { font-family: var(--font-mono); font-variant-numeric: tabular-nums; text-align: right; }
.money.neg { color: var(--red); }
.money.pos { color: var(--teal); }
```

- [ ] **Step 5: a smoke test so vitest has something to run**

`src/lib/domain/smoke.test.ts`:
```ts
import { expect, test } from 'vitest';
test('vitest runs', () => { expect(1 + 1).toBe(2); });
```

- [ ] **Step 6: install and run the gates**

Run: `npm install` (inside the project; allowed). Then `npm run check`, `npx vitest run`, `npm run build`.
Expected: check reports 0 errors; vitest "1 passed"; build writes `dist/`.

- [ ] **Step 7: Commit**

Stage `package.json package-lock.json tsconfig.json svelte.config.js vite.config.ts index.html src/` by name. Message: "Scaffold Svelte 5 + Vite + Vitest with the magpie theme tokens".

---

### Task 2: Domain types and money

**Files:**
- Create: `src/lib/domain/types.ts`, `src/lib/domain/money.ts`, `src/lib/domain/money.test.ts`
- Delete: `src/lib/domain/smoke.test.ts`

**Interfaces:**
- Produces: all row types below; `formatCents(cents: Cents): string`, `formatMoney(cents: Cents): string`, `parseCents(text: string): Cents | null`.

- [ ] **Step 1: types.ts (spec §3, complete)**

```ts
/** Integer minor units. Outflows negative, inflows positive, everywhere. */
export type Cents = number;
/** ISO calendar date, YYYY-MM-DD. */
export type IsoDate = string;
/** YYYY-MM. Sorts lexicographically, which is why months are strings. */
export type MonthKey = string;

/** Fields every synced row carries (PB §2.3). */
export interface Row {
  id: string;
  /** Merge key. Written as max(now, current + 1); never a bare Date.now(). */
  updatedAt: number;
  /** Honest wall-clock write time; tie-breaker when clamped stamps collide. */
  editedAt?: number;
  /** Tombstone. Deleted rows stay on disk and in sync; the mirror hides them. */
  deleted: boolean;
}

export type AccountKind =
  | 'chequing' | 'savings' | 'credit' | 'cash' | 'person' | 'loan' | 'investment' | 'other';

export interface Account extends Row {
  name: string;
  kind: AccountKind;
  /** Money that belongs to the budget. Person accounts are on-budget (a receivable is money you have). */
  onBudget: boolean;
  closed: boolean;
  sortOrder: number;
  note: string;
}

export interface CategoryGroup extends Row {
  name: string;
  sortOrder: number;
  hidden: boolean;
}

/** Reserved category id for Ready to Assign. Income lines target it; it is never listed. */
export const RTA = 'rta';

export interface Category extends Row {
  groupId: string;
  name: string;
  /** Monthly goal in cents; 0 when unset. */
  goal: Cents;
  sortOrder: number;
  hidden: boolean;
  note: string;
  /**
   * The available amount carried into the cutover month, set by the YNAB
   * import so the cutover month matches YNAB to the penny (spec §4.1).
   * Absent or 0 for categories created after cutover.
   */
  carriedIn?: Cents;
}

export interface Assignment extends Row {
  categoryId: string;
  month: MonthKey;
  amount: Cents;
}

/** Deterministic id so two devices assigning the same month collapse into one row. */
export function assignmentId(categoryId: string, month: MonthKey): string {
  return `asg_${categoryId}_${month}`;
}

export type ClearedState = 'uncleared' | 'cleared';
export type TxStatus = 'new' | 'ok';

export interface Line {
  categoryId?: string;
  transferAccountId?: string;
  amount: Cents;
  memo: string;
  /** Cleared state and bank id of the far side of a transfer (spec §4.3). */
  farCleared?: ClearedState;
  farExternalId?: string;
}

export interface TxSource {
  kind: 'ynab' | 'ofx' | 'csv' | 'sheet' | 'manual';
  profileId?: string;
  batchId: string;
}

export interface Transaction extends Row {
  accountId: string;
  date: IsoDate;
  payeeId?: string;
  memo: string;
  /** The account's view; lines sum to this exactly. */
  amount: Cents;
  cleared: ClearedState;
  status: TxStatus;
  /** The bank's id for this row in this account; the dedup key across imports. */
  externalId?: string;
  source: TxSource;
  /** Present when split with a person account; percent is the other person's share. */
  shared?: { accountId: string; percent: number };
  lines: Line[];
}

export interface Payee extends Row {
  name: string;
  /** Normalised raw import descriptors that resolve to this payee. */
  aliases: string[];
  note: string;
}

export interface ShareClaim extends Row {
  date: IsoDate;
  total: Cents;
  percent: number;
  description: string;
  status: 'open' | 'applied' | 'dismissed';
  transactionId?: string;
}

export interface CsvProfile extends Row {
  headerSignature: string;
  name: string;
  mapping: {
    date: string; payee: string; memo?: string; id?: string;
    amount?: string; outflow?: string; inflow?: string;
  };
  dateFormat: string;
  amountMode: 'signed' | 'outflow-inflow' | 'negate';
}

/** YNAB's own numbers for months before cutover; display-only (spec §4.1). */
export interface YnabHistory extends Row {
  categoryId: string;
  month: MonthKey;
  assigned: Cents;
  activity: Cents;
  available: Cents;
}

export function ynabHistoryId(categoryId: string, month: MonthKey): string {
  return `yh_${categoryId}_${month}`;
}

export interface Settings {
  cutoverMonth?: MonthKey;
  currency: string;
}

export const DEFAULT_SETTINGS: Settings = { currency: 'CAD' };
```

- [ ] **Step 2: money.test.ts (failing)**

```ts
import { describe, expect, test } from 'vitest';
import { formatCents, formatMoney, parseCents } from './money';

describe('formatCents', () => {
  test('groups thousands and always shows two decimals', () => {
    expect(formatCents(0)).toBe('0.00');
    expect(formatCents(5)).toBe('0.05');
    expect(formatCents(123456)).toBe('1,234.56');
    expect(formatCents(-123456)).toBe('-1,234.56');
    expect(formatCents(-5)).toBe('-0.05');
  });
});

describe('formatMoney', () => {
  test('puts the sign before the symbol', () => {
    expect(formatMoney(60655)).toBe('$606.55');
    expect(formatMoney(-4200)).toBe('-$42.00');
  });
});

describe('parseCents', () => {
  test('accepts the shapes people type and files contain', () => {
    expect(parseCents('1,234.56')).toBe(123456);
    expect(parseCents('$1,234.56')).toBe(123456);
    expect(parseCents('-12')).toBe(-1200);
    expect(parseCents('-$12.5')).toBe(-1250);
    expect(parseCents('(12.34)')).toBe(-1234);
    expect(parseCents(' 0.05 ')).toBe(5);
    expect(parseCents('.5')).toBe(50);
  });
  test('rejects what it cannot represent exactly', () => {
    expect(parseCents('')).toBeNull();
    expect(parseCents('abc')).toBeNull();
    expect(parseCents('12.345')).toBeNull();
    expect(parseCents('1.2.3')).toBeNull();
  });
  test('never goes through floating point', () => {
    expect(parseCents('0.29')).toBe(29);      // 0.29 * 100 = 28.999... as a float
    expect(parseCents('1000000.01')).toBe(100000001);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/lib/domain/money.test.ts`
Expected: FAIL, cannot resolve `./money`.

- [ ] **Step 4: money.ts**

```ts
import type { Cents } from './types';

/** "1,234.56" / "-0.05". No symbol; the UI decides the symbol. */
export function formatCents(cents: Cents): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${grouped}.${frac}`;
}

/** "$606.55" / "-$42.00". Single currency, so the symbol is fixed. */
export function formatMoney(cents: Cents): string {
  const s = formatCents(cents);
  return s.startsWith('-') ? `-$${s.slice(1)}` : `$${s}`;
}

/**
 * Text to cents by string arithmetic, never via parseFloat: 0.29 * 100 is
 * 28.999999999999996 as a float. Accepts a leading sign or accounting
 * parentheses, an optional $ and thousands separators, up to two decimals.
 * Returns null for anything else, including three decimals.
 */
export function parseCents(text: string): Cents | null {
  let s = text.trim();
  if (!s) return null;
  let neg = false;
  if (s.startsWith('(') && s.endsWith(')')) { neg = true; s = s.slice(1, -1); }
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  else if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('$')) s = s.slice(1);
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  s = s.replace(/,/g, '');
  const m = /^(\d*)(?:\.(\d{0,2}))?$/.exec(s);
  if (!m || (m[1] === '' && !m[2])) return null;
  const whole = Number(m[1] || '0');
  const frac = Number((m[2] ?? '').padEnd(2, '0'));
  const cents = whole * 100 + frac;
  return neg ? -cents : cents;
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/lib/domain/money.test.ts`
Expected: PASS, all cases.

- [ ] **Step 6: Delete the smoke test, run check, commit**

Delete `src/lib/domain/smoke.test.ts`. Run `npm run check` and `npx vitest run`. Commit `src/lib/domain/types.ts src/lib/domain/money.ts src/lib/domain/money.test.ts` and the deletion: "Add row types and integer-cent money helpers".

---

### Task 3: Month helpers

**Files:**
- Create: `src/lib/domain/month.ts`, `src/lib/domain/month.test.ts`

**Interfaces:**
- Produces: `monthOf(date: IsoDate): MonthKey`, `addMonths(month: MonthKey, n: number): MonthKey`, `monthsBetween(from: MonthKey, to: MonthKey): MonthKey[]` (inclusive, empty when from > to), `compareMonths(a, b): number`, `maxMonth(...ms)`, `minMonth(...ms)`, `monthLabel(month): string` ("Sep 2026"), `monthKeyOf(d: Date): MonthKey` (local time).

- [ ] **Step 1: month.test.ts (failing)**

```ts
import { describe, expect, test } from 'vitest';
import { addMonths, compareMonths, maxMonth, minMonth, monthKeyOf, monthLabel, monthOf, monthsBetween } from './month';

describe('month keys', () => {
  test('monthOf takes the first seven characters of an ISO date', () => {
    expect(monthOf('2026-09-04')).toBe('2026-09');
  });
  test('addMonths crosses year boundaries both ways', () => {
    expect(addMonths('2026-09', 1)).toBe('2026-10');
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-01', -13)).toBe('2024-12');
    expect(addMonths('2026-06', 0)).toBe('2026-06');
  });
  test('monthsBetween is inclusive and empty when reversed', () => {
    expect(monthsBetween('2026-11', '2027-02')).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
    expect(monthsBetween('2026-11', '2026-11')).toEqual(['2026-11']);
    expect(monthsBetween('2026-12', '2026-11')).toEqual([]);
  });
  test('compare, min, max are lexicographic', () => {
    expect(compareMonths('2026-09', '2026-10')).toBeLessThan(0);
    expect(maxMonth('2026-09', '2027-01', '2025-12')).toBe('2027-01');
    expect(minMonth('2026-09', '2027-01', '2025-12')).toBe('2025-12');
  });
  test('label and local key', () => {
    expect(monthLabel('2026-09')).toBe('Sep 2026');
    expect(monthKeyOf(new Date(2026, 8, 4, 23, 59))).toBe('2026-09');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/domain/month.test.ts` → FAIL, cannot resolve `./month`.

- [ ] **Step 3: month.ts**

```ts
import type { IsoDate, MonthKey } from './types';

export function monthOf(date: IsoDate): MonthKey {
  return date.slice(0, 7);
}

export function addMonths(month: MonthKey, n: number): MonthKey {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + n;
  const year = y + Math.floor(m / 12);
  const mon = ((m % 12) + 12) % 12;
  return `${year}-${String(mon + 1).padStart(2, '0')}`;
}

export function compareMonths(a: MonthKey, b: MonthKey): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function maxMonth(first: MonthKey, ...rest: MonthKey[]): MonthKey {
  return rest.reduce((m, x) => (x > m ? x : m), first);
}

export function minMonth(first: MonthKey, ...rest: MonthKey[]): MonthKey {
  return rest.reduce((m, x) => (x < m ? x : m), first);
}

/** Inclusive; empty when from is after to. */
export function monthsBetween(from: MonthKey, to: MonthKey): MonthKey[] {
  const out: MonthKey[] = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m);
  return out;
}

const NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function monthLabel(month: MonthKey): string {
  return `${NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

/** The month of a local-time Date; the budget follows the wall clock, not UTC. */
export function monthKeyOf(d: Date): MonthKey {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
```

- [ ] **Step 4: Run to verify it passes; commit**

`npx vitest run src/lib/domain/month.test.ts` → PASS. Commit both files: "Add month key helpers".

---

### Task 4: Ledger rules (spec §4.3, balances)

**Files:**
- Create: `src/lib/domain/ledger.ts`, `src/lib/domain/ledger.test.ts`

**Interfaces:**
- Consumes: types from Task 2.
- Produces:
  - `needsCategory(line: Line, own: Account, far: Account | undefined): boolean`
  - `lineEffect(line: Line, own: Account, far: Account | undefined): Cents` (the budget-side amount; 0 when no category is allowed)
  - `validateTransaction(tx: Transaction, accountsById: Map<string, Account>): string[]` (empty when valid)
  - `accountBalances(accounts: Account[], transactions: Transaction[]): Map<string, { working: Cents; cleared: Cents }>`

- [ ] **Step 1: ledger.test.ts (failing)**

```ts
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
  test('a category is rejected where the budget is not touched', () => {
    expect(validateTransaction(tx({ lines: [{ transferAccountId: 'card', categoryId: 'groc', amount: -100, memo: '' }] }), byId))
      .toContain('line 1 must not have a category');
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
```

- [ ] **Step 2: Run to verify it fails** → `npx vitest run src/lib/domain/ledger.test.ts`, cannot resolve `./ledger`.

- [ ] **Step 3: ledger.ts**

```ts
import type { Account, Cents, Line, Transaction } from './types';

/**
 * Whether a line touches the budget and therefore needs a category (spec §4.3).
 * Own on-budget + no transfer: yes. Transfer: only when exactly one side is
 * on-budget (money entering or leaving the budget). Both on-budget or both
 * off-budget: no category allowed.
 */
export function needsCategory(line: Line, own: Account, far: Account | undefined): boolean {
  if (!line.transferAccountId) return own.onBudget;
  const farOn = far?.onBudget ?? false;
  return own.onBudget !== farOn;
}

/**
 * The line's amount as the budget sees it. Signed from the on-budget side:
 * a transfer entered in an off-budget account that lands in an on-budget one
 * is income to the budget, so the sign flips.
 */
export function lineEffect(line: Line, own: Account, far: Account | undefined): Cents {
  if (!needsCategory(line, own, far)) return 0;
  return own.onBudget ? line.amount : -line.amount;
}

/** Problems with a transaction, in plain words; empty means valid. */
export function validateTransaction(tx: Transaction, accountsById: Map<string, Account>): string[] {
  const errors: string[] = [];
  const own = accountsById.get(tx.accountId);
  if (!own) return [`unknown account ${tx.accountId}`];
  const sum = tx.lines.reduce((s, l) => s + l.amount, 0);
  if (sum !== tx.amount) errors.push(`lines sum to ${sum}, amount is ${tx.amount}`);
  tx.lines.forEach((line, i) => {
    const n = i + 1;
    let far: Account | undefined;
    if (line.transferAccountId) {
      if (line.transferAccountId === tx.accountId) { errors.push(`line ${n} transfers to its own account`); return; }
      far = accountsById.get(line.transferAccountId);
      if (!far) { errors.push(`line ${n} transfers to unknown account ${line.transferAccountId}`); return; }
    }
    const needs = needsCategory(line, own, far);
    if (needs && !line.categoryId && tx.status === 'ok') errors.push(`line ${n} needs a category`);
    if (!needs && line.categoryId) errors.push(`line ${n} must not have a category`);
  });
  return errors;
}

/**
 * Working and cleared balance per account. A transfer is one row: its own
 * account takes `amount`, the far account takes the line amount negated, and
 * the far side's cleared state is the line's `farCleared` (spec §4.3).
 */
export function accountBalances(
  accounts: Account[],
  transactions: Transaction[],
): Map<string, { working: Cents; cleared: Cents }> {
  const out = new Map(accounts.map((a) => [a.id, { working: 0, cleared: 0 }]));
  for (const tx of transactions) {
    if (tx.deleted) continue;
    const own = out.get(tx.accountId);
    if (own) {
      own.working += tx.amount;
      if (tx.cleared === 'cleared') own.cleared += tx.amount;
    }
    for (const line of tx.lines) {
      if (!line.transferAccountId) continue;
      const far = out.get(line.transferAccountId);
      if (!far) continue;
      far.working -= line.amount;
      if (line.farCleared === 'cleared') far.cleared -= line.amount;
    }
  }
  return out;
}
```

- [ ] **Step 4: Run to verify it passes; commit**

`npx vitest run src/lib/domain/ledger.test.ts` → PASS. Commit: "Add ledger rules: budget effect of a line, validation, balances".

---

### Task 5: Budget math (spec §4.1, §4.2)

**Files:**
- Create: `src/lib/domain/budget.ts`, `src/lib/domain/budget.test.ts`

**Interfaces:**
- Consumes: `lineEffect`, `needsCategory`, `accountBalances` (Task 4); month helpers (Task 3).
- Produces:
```ts
export interface BudgetInput {
  accounts: Account[]; categories: Category[]; assignments: Assignment[];
  transactions: Transaction[]; history: YnabHistory[];
  cutoverMonth?: MonthKey; currentMonth: MonthKey;
}
export interface CategoryMonth { categoryId: string; month: MonthKey; assigned: Cents; activity: Cents; available: Cents }
export interface BudgetMonth {
  month: MonthKey; rows: Map<string, CategoryMonth>;
  rta: Cents; uncategorised: Cents; onBudgetTotal: Cents; horizon: MonthKey;
}
export function computeBudget(input: BudgetInput, month: MonthKey): BudgetMonth
```

- [ ] **Step 1: budget.test.ts (failing)**

```ts
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
```

- [ ] **Step 2: Run to verify it fails** → cannot resolve `./budget`.

- [ ] **Step 3: budget.ts**

```ts
import { accountBalances, lineEffect, needsCategory } from './ledger';
import { addMonths, maxMonth, minMonth, monthOf, monthsBetween } from './month';
import type { Account, Assignment, Category, Cents, MonthKey, Transaction, YnabHistory } from './types';

export interface BudgetInput {
  accounts: Account[];
  categories: Category[];
  assignments: Assignment[];
  transactions: Transaction[];
  history: YnabHistory[];
  cutoverMonth?: MonthKey;
  currentMonth: MonthKey;
}

export interface CategoryMonth {
  categoryId: string;
  month: MonthKey;
  assigned: Cents;
  activity: Cents;
  available: Cents;
}

export interface BudgetMonth {
  month: MonthKey;
  rows: Map<string, CategoryMonth>;
  /** Ready to Assign, one global number (spec §4.2). */
  rta: Cents;
  /** Lines on `new` transactions that touch the budget but have no category yet. */
  uncategorised: Cents;
  onBudgetTotal: Cents;
  /** The later of the current month and the last month anything is assigned to. */
  horizon: MonthKey;
}

const key = (categoryId: string, month: MonthKey) => `${categoryId}|${month}`;

/**
 * Everything the budget screen shows for one month, derived from rows.
 *
 *   available(c, m) = m < cutover ? history : available(c, m-1) + assigned + activity
 *   RTA = Σ on-budget balances − Σ available(c, horizon) − uncategorised
 *
 * Availability walks month by month from the start month so negatives carry;
 * before cutover the YNAB numbers are shown as they were. With no cutover
 * (nothing imported yet) the walk starts at the earliest month with any row.
 */
export function computeBudget(input: BudgetInput, month: MonthKey): BudgetMonth {
  const accountsById = new Map(input.accounts.map((a) => [a.id, a]));

  const activity = new Map<string, Cents>();
  let uncategorised = 0;
  let earliest: MonthKey | undefined;
  for (const tx of input.transactions) {
    if (tx.deleted) continue;
    const own = accountsById.get(tx.accountId);
    if (!own) continue;
    const m = monthOf(tx.date);
    for (const line of tx.lines) {
      const far = line.transferAccountId ? accountsById.get(line.transferAccountId) : undefined;
      if (!needsCategory(line, own, far)) continue;
      const effect = lineEffect(line, own, far);
      if (line.categoryId) {
        const k = key(line.categoryId, m);
        activity.set(k, (activity.get(k) ?? 0) + effect);
        earliest = earliest ? minMonth(earliest, m) : m;
      } else {
        uncategorised += effect;
      }
    }
  }

  const assigned = new Map<string, Cents>();
  let lastAssigned: MonthKey | undefined;
  for (const a of input.assignments) {
    if (a.deleted) continue;
    assigned.set(key(a.categoryId, a.month), a.amount);
    lastAssigned = lastAssigned ? maxMonth(lastAssigned, a.month) : a.month;
    earliest = earliest ? minMonth(earliest, a.month) : a.month;
  }

  const history = new Map<string, YnabHistory>();
  for (const h of input.history) if (!h.deleted) history.set(key(h.categoryId, h.month), h);

  const horizon = lastAssigned ? maxMonth(input.currentMonth, lastAssigned) : input.currentMonth;
  const start = input.cutoverMonth ?? earliest ?? month;
  const end = maxMonth(month, horizon);

  const rows = new Map<string, CategoryMonth>();
  let sumAtHorizon = 0;
  for (const c of input.categories) {
    if (c.deleted) continue;
    if (input.cutoverMonth && month < input.cutoverMonth) {
      const h = history.get(key(c.id, month));
      rows.set(c.id, { categoryId: c.id, month, assigned: h?.assigned ?? 0, activity: h?.activity ?? 0, available: h?.available ?? 0 });
    }
    let available = input.cutoverMonth ? (c.carriedIn ?? 0) : 0;
    for (const m of monthsBetween(start, end)) {
      const asg = assigned.get(key(c.id, m)) ?? 0;
      const act = activity.get(key(c.id, m)) ?? 0;
      available += asg + act;
      if (m === month && !rows.has(c.id)) rows.set(c.id, { categoryId: c.id, month, assigned: asg, activity: act, available });
      if (m === horizon) sumAtHorizon += available;
    }
    if (!rows.has(c.id)) rows.set(c.id, { categoryId: c.id, month, assigned: 0, activity: 0, available: 0 });
  }

  let onBudgetTotal = 0;
  for (const [id, b] of accountBalances(input.accounts, input.transactions)) {
    if (accountsById.get(id)?.onBudget) onBudgetTotal += b.working;
  }

  return { month, rows, rta: onBudgetTotal - sumAtHorizon - uncategorised, uncategorised, onBudgetTotal, horizon };
}
```

Note the subtlety the tests pin: when `month < start` (a month before anything exists) the row is all zeros, and when `end < horizon` cannot happen because `end = max(month, horizon)`.

- [ ] **Step 4: Run to verify it passes**

`npx vitest run src/lib/domain/budget.test.ts` → PASS. If "months before cutover" fails on `available` for 2026-10, check that the walk continues past `month` to `end` and that `sumAtHorizon` only adds at `horizon`.

- [ ] **Step 5: Commit** both files: "Add budget math: availability rollover, Ready to Assign, uncategorised".

---

### Task 6: Seed dataset

**Files:**
- Create: `src/lib/domain/seed.ts`, `src/lib/domain/seed.test.ts`

**Interfaces:**
- Produces: `seedData(currentMonth: MonthKey): { accounts, groups, categories, assignments, transactions }` with every row fully stamped (`updatedAt: 1`, `deleted: false`), ids fixed as below.
- The e2e spec in Task 10 asserts these exact numbers for the current month `M`: Ready to Assign `$4,000.00`; uncategorised `-$42.00`; Groceries assigned `$600.00`, activity `-$123.45`, available `$606.55`; Fun available `$100.00`; Utilities available `$220.00`; Savings available `$500.00`; Rent available `$0.00`.

- [ ] **Step 1: seed.test.ts (failing)**

```ts
import { describe, expect, test } from 'vitest';
import { computeBudget } from './budget';
import { validateTransaction } from './ledger';
import { seedData } from './seed';

describe('seed', () => {
  const s = seedData('2026-09');
  const accountsById = new Map(s.accounts.map((a) => [a.id, a]));
  test('every transaction validates', () => {
    for (const tx of s.transactions) expect(validateTransaction(tx, accountsById)).toEqual([]);
  });
  test('the numbers the e2e spec asserts', () => {
    const b = computeBudget({ ...s, history: [], currentMonth: '2026-09' }, '2026-09');
    expect(b.rta).toBe(400000);
    expect(b.uncategorised).toBe(-4200);
    expect(b.rows.get('cat_groc')).toMatchObject({ assigned: 60000, activity: -12345, available: 60655 });
    expect(b.rows.get('cat_fun')!.available).toBe(10000);
    expect(b.rows.get('cat_rent')!.available).toBe(0);
    expect(b.rows.get('cat_util')!.available).toBe(22000);
    expect(b.rows.get('cat_save')!.available).toBe(50000);
    expect(b.onBudgetTotal).toBe(538455);
  });
  test('two months back, Fun is overspent', () => {
    expect(computeBudget({ ...s, history: [], currentMonth: '2026-09' }, '2026-07').rows.get('cat_fun')!.available).toBe(-5000);
  });
});
```

- [ ] **Step 2: Run to verify it fails** → cannot resolve `./seed`.

- [ ] **Step 3: seed.ts**

```ts
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
```

- [ ] **Step 4: Run to verify it passes; commit** → "Add the synthetic seed dataset".

---

### Task 7: Storage (Dexie schema and Repo)

**Files:**
- Create: `src/lib/storage/db.ts`, `src/lib/storage/repo.ts`, `src/lib/storage/repo.test.ts`

**Interfaces:**
- Produces:
```ts
export type TableName = 'accounts' | 'groups' | 'categories' | 'assignments' | 'transactions' | 'payees' | 'claims' | 'profiles' | 'history';
export interface AppState { accounts: Account[]; groups: CategoryGroup[]; categories: Category[]; assignments: Assignment[]; transactions: Transaction[]; history: YnabHistory[]; settings: Settings; settingsUpdatedAt: number }
export function nextStamp(current: number): number
export function stampNew(): { id: string; updatedAt: number; editedAt: number; deleted: false }
export class Repo {
  constructor(db: MagpieDb)
  loadState(): Promise<AppState>              // living rows only
  create<T extends Row>(table: TableName, draft: Omit<T, keyof Row> & { id?: string }): Promise<T>
  patch<T extends Row>(table: TableName, id: string, patch: Partial<T>): Promise<T | undefined>   // returns the row written
  remove(table: TableName, id: string): Promise<void>   // tombstone
  putAssignment(categoryId: string, month: MonthKey, amount: Cents): Promise<Assignment>
  getSettings(): Promise<Settings>
  updateSettings(patch: Partial<Settings>): Promise<number>
  importRows(rows: Partial<Record<TableName, Row[]>>): Promise<void>   // one transaction; rows already stamped
  isEmpty(): Promise<boolean>
}
```

- [ ] **Step 1: db.ts**

```ts
/**
 * Dexie schema. Index strings list only queryable keys; whole objects are
 * stored regardless. Once real data exists, a schema change needs a new
 * version() block with a migration (PB §2.4).
 */
import Dexie, { type Table } from 'dexie';
import type { Account, Assignment, Category, CategoryGroup, CsvProfile, Payee, ShareClaim, Transaction, YnabHistory } from '../domain/types';

export class MagpieDb extends Dexie {
  accounts!: Table<Account, string>;
  groups!: Table<CategoryGroup, string>;
  categories!: Table<Category, string>;
  assignments!: Table<Assignment, string>;
  transactions!: Table<Transaction, string>;
  payees!: Table<Payee, string>;
  claims!: Table<ShareClaim, string>;
  profiles!: Table<CsvProfile, string>;
  history!: Table<YnabHistory, string>;
  /** Singletons: settings (sparse, stamped). The sync token lives in `device`. */
  kv!: Table<{ key: string; value: unknown }, string>;
  /** Device-local values that never sync. */
  device!: Table<{ key: string; value: unknown }, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      accounts: 'id, updatedAt',
      groups: 'id, updatedAt',
      categories: 'id, groupId, updatedAt',
      assignments: 'id, categoryId, month, updatedAt',
      transactions: 'id, accountId, date, status, externalId, updatedAt',
      payees: 'id, updatedAt',
      claims: 'id, status, updatedAt',
      profiles: 'id, headerSignature, updatedAt',
      history: 'id, categoryId, month, updatedAt',
      kv: 'key',
      device: 'key',
    });
  }
}

export function openDb(name = 'magpie'): MagpieDb {
  return new MagpieDb(name);
}
```

- [ ] **Step 2: repo.test.ts (failing)**

```ts
import { beforeEach, describe, expect, test } from 'vitest';
import { openDb, type MagpieDb } from './db';
import { nextStamp, Repo } from './repo';
import type { Account, Category } from '../domain/types';

let db: MagpieDb;
let repo: Repo;
let n = 0;
beforeEach(() => {
  db = openDb(`test-${++n}-${Date.now()}`);
  repo = new Repo(db);
});

const draft = { name: 'Chequing', kind: 'chequing' as const, onBudget: true, closed: false, sortOrder: 0, note: '' };

describe('nextStamp', () => {
  test('is now, or one past a future stamp', () => {
    const now = Date.now();
    expect(nextStamp(0)).toBeGreaterThanOrEqual(now);
    expect(nextStamp(now + 100000)).toBe(now + 100001);
  });
});

describe('Repo', () => {
  test('create stamps and loadState returns it', async () => {
    const a = await repo.create<Account>('accounts', draft);
    expect(a.id).toBeTruthy();
    expect(a.deleted).toBe(false);
    expect(a.updatedAt).toBeGreaterThan(0);
    const s = await repo.loadState();
    expect(s.accounts.map((x) => x.id)).toEqual([a.id]);
  });
  test('create honours a supplied id', async () => {
    const a = await repo.create<Account>('accounts', { ...draft, id: 'acc_fixed' });
    expect(a.id).toBe('acc_fixed');
  });
  test('patch bumps updatedAt past the old one and sets editedAt', async () => {
    const a = await repo.create<Account>('accounts', draft);
    await db.accounts.put({ ...a, updatedAt: Date.now() + 100000 });
    const p = await repo.patch<Account>('accounts', a.id, { name: 'Main' });
    expect(p!.name).toBe('Main');
    expect(p!.updatedAt).toBe(Date.now() + 100001);
    expect(p!.editedAt).toBeGreaterThan(0);
    expect((await db.accounts.get(a.id))!.name).toBe('Main');
  });
  test('patch of a missing row is a no-op', async () => {
    expect(await repo.patch<Account>('accounts', 'nope', { name: 'x' })).toBeUndefined();
  });
  test('remove tombstones; loadState hides it; the row stays on disk', async () => {
    const a = await repo.create<Account>('accounts', draft);
    await repo.remove('accounts', a.id);
    expect((await repo.loadState()).accounts).toEqual([]);
    expect((await db.accounts.get(a.id))!.deleted).toBe(true);
  });
  test('putAssignment upserts by deterministic id and restamps', async () => {
    const first = await repo.putAssignment('cat_groc', '2026-09', 60000);
    const second = await repo.putAssignment('cat_groc', '2026-09', 70000);
    expect(second.id).toBe(first.id);
    expect(second.id).toBe('asg_cat_groc_2026-09');
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
    expect(await db.assignments.count()).toBe(1);
    expect((await repo.loadState()).assignments[0]!.amount).toBe(70000);
  });
  test('settings are sparse on disk and defaulted on read', async () => {
    expect(await repo.getSettings()).toEqual({ currency: 'CAD' });
    const stamp = await repo.updateSettings({ cutoverMonth: '2026-09' });
    expect(stamp).toBeGreaterThan(0);
    expect((await db.kv.get('settings'))!.value).toEqual({ data: { cutoverMonth: '2026-09' }, updatedAt: stamp });
    expect(await repo.getSettings()).toEqual({ currency: 'CAD', cutoverMonth: '2026-09' });
    expect((await repo.loadState()).settingsUpdatedAt).toBe(stamp);
  });
  test('importRows writes several tables atomically and isEmpty flips', async () => {
    expect(await repo.isEmpty()).toBe(true);
    const c: Category = { id: 'cat_x', groupId: 'g', name: 'X', goal: 0, sortOrder: 0, hidden: false, note: '', updatedAt: 1, deleted: false };
    await repo.importRows({ accounts: [{ ...draft, id: 'acc_a', updatedAt: 1, deleted: false }], categories: [c] });
    expect(await repo.isEmpty()).toBe(false);
    const s = await repo.loadState();
    expect(s.accounts).toHaveLength(1);
    expect(s.categories).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run to verify it fails** → `npx vitest run src/lib/storage/repo.test.ts`, cannot resolve `./repo`.

- [ ] **Step 4: repo.ts**

```ts
/**
 * Persistence gateway: the only code that touches IndexedDB.
 *
 * Invariants the sync layer will depend on (PB §2.3, §2.4):
 * - every create stamps id/updatedAt/editedAt; every write restamps with nextStamp
 * - deletes are tombstones, never physical removals
 * - loadState() returns living rows only
 * - a patch is one read-modify-write inside one rw transaction
 */
import { nanoid } from 'nanoid';
import type { Table } from 'dexie';
import {
  assignmentId, DEFAULT_SETTINGS,
  type Account, type Assignment, type Category, type CategoryGroup, type Cents, type MonthKey,
  type Row, type Settings, type Transaction, type YnabHistory,
} from '../domain/types';
import type { MagpieDb } from './db';

export type TableName =
  | 'accounts' | 'groups' | 'categories' | 'assignments' | 'transactions'
  | 'payees' | 'claims' | 'profiles' | 'history';

export interface AppState {
  accounts: Account[];
  groups: CategoryGroup[];
  categories: Category[];
  assignments: Assignment[];
  transactions: Transaction[];
  history: YnabHistory[];
  settings: Settings;
  /** Merge key for the settings singleton; 0 = never written. */
  settingsUpdatedAt: number;
}

/**
 * Now, or one tick past what the row already claims. updatedAt is the merge
 * key; a write that lowers it loses to the copy it meant to replace, so a
 * change must always supersede what it changed, even a future-stamped row.
 */
export function nextStamp(current: number): number {
  return Math.max(Date.now(), current + 1);
}

export function stampNew(): { id: string; updatedAt: number; editedAt: number; deleted: false } {
  const now = Date.now();
  return { id: nanoid(), updatedAt: now, editedAt: now, deleted: false };
}

type Stamped<T> = { data: T; updatedAt: number };

export class Repo {
  constructor(private db: MagpieDb) {}

  private table<T extends Row>(name: TableName): Table<T, string> {
    return this.db[name] as unknown as Table<T, string>;
  }

  async loadState(): Promise<AppState> {
    const [accounts, groups, categories, assignments, transactions, history, settingsRow] = await Promise.all([
      this.db.accounts.toArray(), this.db.groups.toArray(), this.db.categories.toArray(),
      this.db.assignments.toArray(), this.db.transactions.toArray(), this.db.history.toArray(),
      this.db.kv.get('settings'),
    ]);
    const live = <T extends Row>(rows: T[]) => rows.filter((r) => !r.deleted);
    const s = (settingsRow?.value ?? { data: {}, updatedAt: 0 }) as Stamped<Partial<Settings>>;
    return {
      accounts: live(accounts), groups: live(groups), categories: live(categories),
      assignments: live(assignments), transactions: live(transactions), history: live(history),
      settings: { ...DEFAULT_SETTINGS, ...s.data },
      settingsUpdatedAt: s.updatedAt,
    };
  }

  async isEmpty(): Promise<boolean> {
    const counts = await Promise.all([this.db.accounts.count(), this.db.categories.count(), this.db.transactions.count()]);
    return counts.every((c) => c === 0);
  }

  /** A draft may bring its own id (deterministic rows do). */
  async create<T extends Row>(table: TableName, draft: Omit<T, keyof Row> & { id?: string }): Promise<T> {
    const row = { ...stampNew(), ...draft } as unknown as T;
    await this.table<T>(table).put(row);
    return row;
  }

  /**
   * Read-modify-put inside one rw transaction: a sync write-back can commit a
   * newer merged row in the gap, and a patch built on a stale read would
   * erase that merge with a stamp high enough to propagate the erasure.
   * put() rather than update() so optional keys can be cleared reliably.
   */
  async patch<T extends Row>(table: TableName, id: string, patch: Partial<T>): Promise<T | undefined> {
    const t = this.table<T>(table);
    return this.db.transaction('rw', t, async () => {
      const row = await t.get(id);
      if (!row) return undefined;
      const next = { ...row, ...patch, updatedAt: nextStamp(row.updatedAt), editedAt: Date.now() } as T;
      await t.put(next);
      return next;
    });
  }

  async remove(table: TableName, id: string): Promise<void> {
    await this.patch(table, id, { deleted: true } as Partial<Row>);
  }

  /** Upsert by deterministic id so two devices assigning the same month collapse into one row. */
  async putAssignment(categoryId: string, month: MonthKey, amount: Cents): Promise<Assignment> {
    const id = assignmentId(categoryId, month);
    return this.db.transaction('rw', this.db.assignments, async () => {
      const prior = await this.db.assignments.get(id);
      const now = Date.now();
      const row: Assignment = {
        id, categoryId, month, amount,
        updatedAt: nextStamp(prior?.updatedAt ?? 0), editedAt: now, deleted: false,
      };
      await this.db.assignments.put(row);
      return row;
    });
  }

  async getSettings(): Promise<Settings> {
    const row = await this.db.kv.get('settings');
    const s = (row?.value ?? { data: {} }) as Stamped<Partial<Settings>>;
    return { ...DEFAULT_SETTINGS, ...s.data };
  }

  /** Sparse on purpose: only explicit choices are stored; defaults apply on read (PB §2.3). */
  async updateSettings(patch: Partial<Settings>): Promise<number> {
    return this.db.transaction('rw', this.db.kv, async () => {
      const row = await this.db.kv.get('settings');
      const prior = (row?.value ?? { data: {}, updatedAt: 0 }) as Stamped<Partial<Settings>>;
      const updatedAt = nextStamp(prior.updatedAt);
      await this.db.kv.put({ key: 'settings', value: { data: { ...prior.data, ...patch }, updatedAt } });
      return updatedAt;
    });
  }

  /** Bulk write of already-stamped rows across tables, all or nothing. */
  async importRows(rows: Partial<Record<TableName, Row[]>>): Promise<void> {
    const names = Object.keys(rows) as TableName[];
    const tables = names.map((n) => this.table(n));
    await this.db.transaction('rw', tables, async () => {
      for (const n of names) await this.table(n).bulkPut(rows[n]!);
    });
  }
}
```

- [ ] **Step 5: Run to verify it passes**

`npx vitest run src/lib/storage/repo.test.ts` → PASS. If Dexie complains about the transaction table list, pass the tables array directly (`this.db.transaction('rw', tables, fn)` accepts an array).

- [ ] **Step 6: check and commit** → `npm run check`; commit the three files: "Add Dexie schema and the Repo gateway".

---

### Task 8: Undo and the store

**Files:**
- Create: `src/lib/state/undo.svelte.ts` (copy of OC `src/lib/state/undo.svelte.ts`, verbatim), `src/lib/state/app.svelte.ts`, `src/lib/state/app.test.ts`
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: `Repo`, `AppState` (Task 7), `seedData` (Task 6), `undoStack` (OC copy: `push(label, run, redo?)`, `undo()`, `redo()`, `latest`, `clear()`).
- Produces:
```ts
export class AppStore {
  state: AppState            // $state mirror, living rows only
  ready: boolean             // $state
  persistentStorage: 'granted' | 'denied' | 'unsupported' | 'unknown'
  init(dbName?: string): Promise<void>        // hydrate; seed if empty and localStorage 'magpie:seed' === '1'
  loadSeed(): Promise<void>                   // importRows(seedData(current month)) then rehydrate
  setAssigned(categoryId: string, month: MonthKey, amount: Cents): Promise<void>   // undoable
  currentMonth: MonthKey                      // monthKeyOf(new Date()) at init
}
export const app: AppStore
```

- [ ] **Step 1: copy undo.svelte.ts**

`cp /Users/ben/Noodlevault/organizedchaos/src/lib/state/undo.svelte.ts src/lib/state/undo.svelte.ts`. Runes files need no Svelte component to be imported in vitest; `.svelte.ts` is compiled by the svelte vite plugin, which vitest uses through `vite.config.ts`.

- [ ] **Step 2: app.test.ts (failing)**

```ts
import { beforeEach, describe, expect, test } from 'vitest';
import { AppStore } from './app.svelte';
import { undoStack } from './undo.svelte';
import { seedData } from '../domain/seed';

let n = 0;
async function fresh(): Promise<AppStore> {
  const store = new AppStore();
  await store.init(`app-test-${++n}-${Date.now()}`);
  return store;
}

describe('AppStore', () => {
  beforeEach(() => undoStack.clear());

  test('init on an empty database is ready with nothing', async () => {
    const s = await fresh();
    expect(s.ready).toBe(true);
    expect(s.state.accounts).toEqual([]);
  });

  test('loadSeed populates the mirror', async () => {
    const s = await fresh();
    await s.loadSeed();
    const seed = seedData(s.currentMonth);
    expect(s.state.categories.map((c) => c.id).sort()).toEqual(seed.categories.map((c) => c.id).sort());
    expect(s.state.transactions).toHaveLength(seed.transactions.length);
  });

  test('setAssigned persists, patches the mirror, and undoes', async () => {
    const s = await fresh();
    await s.loadSeed();
    const m = s.currentMonth;
    await s.setAssigned('cat_groc', m, 70000);
    const find = () => s.state.assignments.find((a) => a.categoryId === 'cat_groc' && a.month === m);
    expect(find()!.amount).toBe(70000);
    const reloaded = new AppStore();
    await reloaded.init(s.dbName);
    expect(reloaded.state.assignments.find((a) => a.categoryId === 'cat_groc' && a.month === m)!.amount).toBe(70000);
    expect(await undoStack.undo()).toBe('assign Groceries');
    expect(find()!.amount).toBe(60000);
    expect(await undoStack.redo()).toBe('assign Groceries');
    expect(find()!.amount).toBe(70000);
  });

  test('setAssigned creates a row where none existed and undo removes it', async () => {
    const s = await fresh();
    await s.loadSeed();
    const m = s.currentMonth;
    await s.setAssigned('cat_fun', m, 5000);
    const find = () => s.state.assignments.find((a) => a.categoryId === 'cat_fun' && a.month === m);
    expect(find()!.amount).toBe(5000);
    await undoStack.undo();
    expect(find()).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run to verify it fails** → cannot resolve `./app.svelte`.

- [ ] **Step 4: app.svelte.ts**

```ts
/**
 * The single state layer: a runes mirror of AppState. Every mutation persists
 * through the Repo first, then patches the mirror in place. Screens import
 * `app` and never touch the Repo or Dexie.
 */
import { seedData } from '../domain/seed';
import { monthKeyOf } from '../domain/month';
import type { Cents, MonthKey } from '../domain/types';
import { DEFAULT_SETTINGS } from '../domain/types';
import { openDb } from '../storage/db';
import { Repo, type AppState } from '../storage/repo';
import { undoStack } from './undo.svelte';

export const SEED_FLAG = 'magpie:seed';

export class AppStore {
  state: AppState = $state({
    accounts: [], groups: [], categories: [], assignments: [], transactions: [], history: [],
    settings: { ...DEFAULT_SETTINGS }, settingsUpdatedAt: 0,
  });
  ready = $state(false);
  persistentStorage = $state<'granted' | 'denied' | 'unsupported' | 'unknown'>('unknown');
  currentMonth: MonthKey = monthKeyOf(new Date());
  dbName = 'magpie';
  private repo!: Repo;

  async init(dbName = 'magpie'): Promise<void> {
    this.dbName = dbName;
    this.repo = new Repo(openDb(dbName));
    this.currentMonth = monthKeyOf(new Date());
    if (typeof localStorage !== 'undefined' && localStorage.getItem(SEED_FLAG) === '1' && await this.repo.isEmpty()) {
      await this.repo.importRows(seedData(this.currentMonth));
    }
    await this.hydrate();
    void this.requestPersistence();
    this.ready = true;
  }

  private async hydrate(): Promise<void> {
    const s = await this.repo.loadState();
    Object.assign(this.state, s);
  }

  private async requestPersistence(): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) { this.persistentStorage = 'unsupported'; return; }
    try { this.persistentStorage = (await navigator.storage.persist()) ? 'granted' : 'denied'; }
    catch { this.persistentStorage = 'unknown'; }
  }

  async loadSeed(): Promise<void> {
    await this.repo.importRows(seedData(this.currentMonth));
    await this.hydrate();
    undoStack.clear();
  }

  private categoryName(id: string): string {
    return this.state.categories.find((c) => c.id === id)?.name ?? id;
  }

  /** Write an assignment (or clear it to 0) without touching the undo stack. */
  private async writeAssigned(categoryId: string, month: MonthKey, amount: Cents): Promise<void> {
    const row = await this.repo.putAssignment(categoryId, month, amount);
    const i = this.state.assignments.findIndex((a) => a.id === row.id);
    if (i === -1) this.state.assignments.push(row);
    else Object.assign(this.state.assignments[i]!, row);
  }

  /**
   * Undo restores the prior amount; a row that did not exist before is set
   * back to 0, which the budget treats as absent. Captured before the write
   * (PB §2.5: undo arms before the mutation).
   */
  async setAssigned(categoryId: string, month: MonthKey, amount: Cents): Promise<void> {
    const prior = this.state.assignments.find((a) => a.categoryId === categoryId && a.month === month)?.amount;
    if ((prior ?? 0) === amount) return;
    undoStack.push(`assign ${this.categoryName(categoryId)}`,
      () => this.restoreAssigned(categoryId, month, prior),
      () => this.writeAssigned(categoryId, month, amount));
    await this.writeAssigned(categoryId, month, amount);
  }

  private async restoreAssigned(categoryId: string, month: MonthKey, prior: Cents | undefined): Promise<void> {
    if (prior === undefined) {
      const id = `asg_${categoryId}_${month}`;
      await this.repo.remove('assignments', id);
      const i = this.state.assignments.findIndex((a) => a.id === id);
      if (i !== -1) this.state.assignments.splice(i, 1);
      return;
    }
    await this.writeAssigned(categoryId, month, prior);
  }
}

export const app = new AppStore();
```

Note: `restoreAssigned` tombstones the row rather than writing 0 so "undo creates nothing" holds; a later `putAssignment` on the same id resurrects it with a higher stamp, which is the correct merge behaviour.

- [ ] **Step 5: Run to verify it passes**

`npx vitest run src/lib/state/app.test.ts` → PASS. If `$state` is reported as undefined, the file is not being compiled as a runes module: confirm the file name ends in `.svelte.ts` and `vite.config.ts` includes `svelte()`.

- [ ] **Step 6: wire main.ts**

```ts
import './app.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { app as store } from './lib/state/app.svelte';

// Hydrate before mounting; App shows a boot line until store.ready.
void store.init();

export default mount(App, { target: document.getElementById('app')! });
```

- [ ] **Step 7: check, all unit tests, commit** → `npm run check && npx vitest run`; commit `src/lib/state/*.ts src/main.ts`: "Add the store with seed loading and undoable assignment edits".

---

### Task 9: Screens

**Files:**
- Create: `src/lib/ui/router.svelte.ts`, `src/lib/ui/toast.svelte.ts` (copy of OC `src/lib/ui/toast.svelte.ts`, verbatim), `src/lib/ui/UndoToast.svelte`, `src/lib/ui/BudgetView.svelte`, `src/lib/ui/SettingsView.svelte`
- Modify: `src/App.svelte`

**Interfaces:**
- Consumes: `app` (Task 8), `computeBudget` (Task 5), `formatMoney`, `parseCents` (Task 2), `monthLabel`, `addMonths` (Task 3), `undoStack`, `toast`.
- Produces (test ids the e2e spec uses): `boot`, `nav-budget`, `nav-settings`, `month-label`, `month-prev`, `month-next`, `rta`, `uncategorised`, `group-<id>`, `cat-row-<id>`, `goal-<id>`, `assigned-<id>`, `assigned-input-<id>`, `activity-<id>`, `available-<id>`, `load-seed`, `undo-toast`, `undo-toast-button`, `version`, `persistence`.

- [ ] **Step 1: router.svelte.ts**

```ts
/** Hash router. #/ and #/budget/<YYYY-MM> show the budget; #/settings the settings. */
import type { MonthKey } from '../domain/types';

export type Route = { name: 'budget'; month?: MonthKey } | { name: 'settings' };

function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'settings') return { name: 'settings' };
  if (parts[0] === 'budget' && parts[1] && /^\d{4}-\d{2}$/.test(parts[1])) return { name: 'budget', month: parts[1] };
  return { name: 'budget' };
}

export function toHash(r: Route): string {
  if (r.name === 'settings') return '#/settings';
  return r.month ? `#/budget/${r.month}` : '#/';
}

class Router {
  current: Route = $state({ name: 'budget' });
  constructor() {
    if (typeof window !== 'undefined') {
      this.current = parse(window.location.hash);
      window.addEventListener('hashchange', () => { this.current = parse(window.location.hash); });
    }
  }
}

export const router = new Router();

export function navigate(r: Route): void {
  window.location.hash = toHash(r);
}
```

- [ ] **Step 2: UndoToast.svelte**

```svelte
<script lang="ts">
  import { toast } from './toast.svelte';
</script>

{#if toast.current}
  <div class="toast" data-testid="undo-toast">
    <span>{toast.current.label}</span>
    <button data-testid="undo-toast-button" onclick={() => toast.undo()}>Undo</button>
  </div>
{/if}

<style>
  .toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
    background: var(--bg2); border: 1px solid var(--line); border-radius: 8px;
    padding: 8px 12px; display: flex; gap: 12px; align-items: center; }
</style>
```

- [ ] **Step 3: BudgetView.svelte**

Behaviour: month from the route or `app.currentMonth`; ‹ › navigate by `addMonths`; header shows Ready to Assign (`formatMoney(b.rta)`, class `neg` when negative) and, when `b.uncategorised !== 0`, a chip "Uncategorised -$42.00". Groups in `sortOrder`, categories in `sortOrder` within each; hidden groups and categories omitted. Columns: Category, Goal, Assigned, Activity, Available. The assigned cell is a button showing the value; click turns it into an input pre-filled with `formatCents(assigned)`; Enter or blur commits via `parseCents` (invalid text: keep editing, red outline); Escape cancels. After commit, `toast.show('assign <name>', () => undoStack.undoEntry(entry.id))` is not needed here: undo comes from Ctrl/Cmd+Z in App and the toast shows the label from `undoStack.latest`. Keep it simple: after a successful `setAssigned`, call `toast.show(`Assigned ${name}`, () => void undoStack.undo())`.

```svelte
<script lang="ts">
  import { app } from '../state/app.svelte';
  import { undoStack } from '../state/undo.svelte';
  import { toast } from './toast.svelte';
  import { computeBudget } from '../domain/budget';
  import { formatCents, formatMoney, parseCents } from '../domain/money';
  import { addMonths, monthLabel } from '../domain/month';
  import { navigate, router } from './router.svelte';
  import type { MonthKey } from '../domain/types';

  const month = $derived<MonthKey>(router.current.name === 'budget' && router.current.month ? router.current.month : app.currentMonth);
  // Snapshot first: computeBudget scans every row, and proxy reads at that scale are slow (PB §2.13).
  const budget = $derived(computeBudget({ ...$state.snapshot(app.state), currentMonth: app.currentMonth, cutoverMonth: app.state.settings.cutoverMonth }, month));
  const groups = $derived([...app.state.groups].filter((g) => !g.hidden).sort((a, b) => a.sortOrder - b.sortOrder));
  const categoriesOf = (groupId: string) => app.state.categories.filter((c) => c.groupId === groupId && !c.hidden).sort((a, b) => a.sortOrder - b.sortOrder);

  let editing = $state<string | null>(null);
  let draft = $state('');
  let invalid = $state(false);

  function startEdit(id: string, cents: number) { editing = id; draft = formatCents(cents); invalid = false; }
  async function commit(id: string, name: string) {
    if (editing !== id) return;
    const cents = parseCents(draft);
    if (cents === null) { invalid = true; return; }
    editing = null;
    await app.setAssigned(id, month, cents);
    toast.show(`Assigned ${name}`, () => void undoStack.undo());
  }
  function cancel() { editing = null; invalid = false; }
  const cls = (cents: number) => `money ${cents < 0 ? 'neg' : cents > 0 ? 'pos' : ''}`;
</script>

<section class="budget">
  <header>
    <button data-testid="month-prev" onclick={() => navigate({ name: 'budget', month: addMonths(month, -1) })}>‹</button>
    <h2 data-testid="month-label">{monthLabel(month)}</h2>
    <button data-testid="month-next" onclick={() => navigate({ name: 'budget', month: addMonths(month, 1) })}>›</button>
    <div class="rta">
      <span class="label">Ready to Assign</span>
      <span class={cls(budget.rta)} data-testid="rta">{formatMoney(budget.rta)}</span>
      {#if budget.uncategorised !== 0}
        <span class="chip" data-testid="uncategorised">Uncategorised {formatMoney(budget.uncategorised)}</span>
      {/if}
    </div>
  </header>
  <table>
    <thead><tr><th>Category</th><th class="money">Goal</th><th class="money">Assigned</th><th class="money">Activity</th><th class="money">Available</th></tr></thead>
    <tbody>
      {#each groups as g (g.id)}
        <tr class="group" data-testid={`group-${g.id}`}><td colspan="5">{g.name}</td></tr>
        {#each categoriesOf(g.id) as c (c.id)}
          {@const row = budget.rows.get(c.id)}
          <tr data-testid={`cat-row-${c.id}`}>
            <td>{c.name}</td>
            <td class="money" data-testid={`goal-${c.id}`}>{formatMoney(c.goal)}</td>
            <td class="money">
              {#if editing === c.id}
                <input data-testid={`assigned-input-${c.id}`} class:invalid bind:value={draft}
                  onkeydown={(e) => { if (e.key === 'Enter') void commit(c.id, c.name); if (e.key === 'Escape') cancel(); }}
                  onblur={() => void commit(c.id, c.name)} />
              {:else}
                <button class="cell" data-testid={`assigned-${c.id}`} onclick={() => startEdit(c.id, row?.assigned ?? 0)}>{formatMoney(row?.assigned ?? 0)}</button>
              {/if}
            </td>
            <td class={cls(row?.activity ?? 0)} data-testid={`activity-${c.id}`}>{formatMoney(row?.activity ?? 0)}</td>
            <td class={cls(row?.available ?? 0)} data-testid={`available-${c.id}`}>{formatMoney(row?.available ?? 0)}</td>
          </tr>
        {/each}
      {/each}
    </tbody>
  </table>
</section>

<style>
  .budget { max-width: 960px; margin: 0 auto; padding: 16px 24px; }
  header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
  h2 { margin: 0; min-width: 120px; text-align: center; }
  .rta { margin-left: auto; display: flex; align-items: baseline; gap: 10px; }
  .rta .label { color: var(--dim); }
  .rta .money { font-size: 1.4rem; }
  .chip { background: var(--bg2); border: 1px solid var(--amber); color: var(--amber); border-radius: 999px; padding: 2px 10px; font-size: 0.85rem; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; color: var(--dim); font-weight: 500; padding: 6px 8px; border-bottom: 1px solid var(--line); }
  td { padding: 6px 8px; border-bottom: 1px solid var(--line); }
  tr.group td { background: var(--bg1); color: var(--blue); font-weight: 600; padding-top: 12px; }
  .cell { border: none; padding: 0; width: 100%; text-align: right; font-family: var(--font-mono); }
  .cell:hover { color: var(--blue); }
  input { width: 110px; text-align: right; font-family: var(--font-mono); }
  input.invalid { outline: 1px solid var(--red); border-color: var(--red); }
</style>
```

`autofocus` is a no-op on dynamically inserted elements (PB §4): add a tiny action `focusOnMount` (copy OC `src/lib/ui/focusOnMount.ts`) and `use:focusOnMount` on the input so the click puts the caret in the field.

- [ ] **Step 4: SettingsView.svelte**

```svelte
<script lang="ts">
  import { app } from '../state/app.svelte';
  async function loadSeed() {
    if (app.state.transactions.length && !confirm('Add the sample data on top of what is here?')) return;
    await app.loadSeed();
  }
</script>

<section class="settings">
  <h2>Settings</h2>
  <p>Version <span data-testid="version">{__APP_VERSION__}</span></p>
  <p>Storage persistence: <span data-testid="persistence">{app.persistentStorage}</span></p>
  <p><button data-testid="load-seed" onclick={loadSeed}>Load sample data</button></p>
</section>

<style>
  .settings { max-width: 960px; margin: 0 auto; padding: 16px 24px; }
</style>
```

- [ ] **Step 5: App.svelte**

```svelte
<script lang="ts">
  import { app } from './lib/state/app.svelte';
  import { undoStack } from './lib/state/undo.svelte';
  import { toast } from './lib/ui/toast.svelte';
  import { navigate, router } from './lib/ui/router.svelte';
  import BudgetView from './lib/ui/BudgetView.svelte';
  import SettingsView from './lib/ui/SettingsView.svelte';
  import UndoToast from './lib/ui/UndoToast.svelte';

  // Global undo/redo. A focused input owns its own Ctrl+Z, so skip when one is active.
  function onKey(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod || e.key.toLowerCase() !== 'z') return;
    if (document.activeElement instanceof HTMLInputElement) return;
    e.preventDefault();
    void (e.shiftKey ? undoStack.redo() : undoStack.undo()).then((label) => {
      if (label) toast.show(`${e.shiftKey ? 'Redid' : 'Undid'} ${label}`, () => {});
    });
  }
</script>

<svelte:window onkeydown={onKey} />

{#if !app.ready}
  <p data-testid="boot" class="boot">Opening the nest…</p>
{:else}
  <nav>
    <span class="brand">Magpie</span>
    <button data-testid="nav-budget" onclick={() => navigate({ name: 'budget' })}>Budget</button>
    <button data-testid="nav-settings" onclick={() => navigate({ name: 'settings' })}>Settings</button>
  </nav>
  {#if router.current.name === 'settings'}
    <SettingsView />
  {:else}
    <BudgetView />
  {/if}
  <UndoToast />
{/if}

<style>
  nav { display: flex; align-items: center; gap: 8px; padding: 10px 24px; border-bottom: 1px solid var(--line); background: var(--bg1); }
  .brand { color: var(--blue); font-weight: 700; margin-right: 12px; }
  .boot { color: var(--dim); padding: 24px; }
</style>
```

The boot copy "Opening the nest…" uses a real ellipsis character, not an em dash; fine.

- [ ] **Step 6: check, run dev, look**

`npm run check` must be clean. `npm run dev`, open `http://localhost:5173/magpie/#/settings`, click Load sample data, go to Budget: groups, five categories, Ready to Assign $4,000.00, Uncategorised -$42.00. Click Groceries assigned, type 700, Enter: available $706.55, RTA $3,900.00. Ctrl/Cmd+Z: back. Reload: the edit persists (undo stack is session-only, so after reload it stays at whatever was last written).

- [ ] **Step 7: Commit** `src/App.svelte src/lib/ui/*`: "Add the budget and settings screens".

---

### Task 10: End-to-end and the gate run

**Files:**
- Create: `playwright.config.ts`, `e2e/budget.spec.ts`
- Modify: `.gitignore` (already lists `test-results/` and `playwright-report/`), `CLAUDE.md` "Build discipline" section (commands now exist)

**Interfaces:**
- Consumes: test ids from Task 9; seed numbers from Task 6; `SEED_FLAG = 'magpie:seed'` (Task 8).

- [ ] **Step 1: playwright.config.ts** (chromium only; desktop)

```ts
import { defineConfig, devices } from '@playwright/test';

/** e2e runs against the production build via `vite preview` at the real base path. */
export default defineConfig({
  testDir: 'e2e',
  webServer: {
    command: 'npm run build && npm run preview',
    url: 'http://localhost:4173/magpie/',
    reuseExistingServer: !process.env.CI,
  },
  use: { baseURL: 'http://localhost:4173/magpie/' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
```

- [ ] **Step 2: check the browser is already installed**

Run: `ls ~/Library/Caches/ms-playwright`. Expected: a `chromium-*` directory from the Organized Chaos work. If none matches the installed `@playwright/test` (a later `npx playwright test` says "Executable doesn't exist"), stop and ask Ben before running `npx playwright install chromium`, which writes outside the project.

- [ ] **Step 3: e2e/budget.spec.ts (failing until the build serves the screens)**

```ts
import { expect, test, type Page } from '@playwright/test';

/** Fresh database with the seed flag set, then a reload so init() sees both. */
async function resetWithSeed(page: Page) {
  await page.goto('./');
  await page.evaluate(() => new Promise<void>((resolve) => {
    localStorage.setItem('magpie:seed', '1');
    const req = indexedDB.deleteDatabase('magpie');
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  }));
  await page.reload();
  await page.getByTestId('rta').waitFor();
}

test('the budget screen shows the seed month', async ({ page }) => {
  await resetWithSeed(page);
  await expect(page.getByTestId('rta')).toHaveText('$4,000.00');
  await expect(page.getByTestId('uncategorised')).toHaveText('Uncategorised -$42.00');
  await expect(page.getByTestId('group-grp_every')).toBeVisible();
  await expect(page.getByTestId('assigned-cat_groc')).toHaveText('$600.00');
  await expect(page.getByTestId('activity-cat_groc')).toHaveText('-$123.45');
  await expect(page.getByTestId('available-cat_groc')).toHaveText('$606.55');
  await expect(page.getByTestId('available-cat_fun')).toHaveText('$100.00');
  await expect(page.getByTestId('available-cat_save')).toHaveText('$500.00');
});

test('two months back shows the carried overspend', async ({ page }) => {
  await resetWithSeed(page);
  await page.getByTestId('month-prev').click();
  await page.getByTestId('month-prev').click();
  await expect(page.getByTestId('available-cat_fun')).toHaveText('-$50.00');
  await expect(page.getByTestId('available-cat_fun')).toHaveClass(/neg/);
});

test('editing assigned recomputes, persists across reload, and undoes', async ({ page }) => {
  await resetWithSeed(page);
  await page.getByTestId('assigned-cat_groc').click();
  const input = page.getByTestId('assigned-input-cat_groc');
  await expect(input).toHaveValue('600.00');
  await input.fill('700');
  await input.press('Enter');
  await expect(page.getByTestId('assigned-cat_groc')).toHaveText('$700.00');
  await expect(page.getByTestId('available-cat_groc')).toHaveText('$706.55');
  await expect(page.getByTestId('rta')).toHaveText('$3,900.00');
  await expect(page.getByTestId('undo-toast')).toBeVisible();

  await page.reload();
  await page.getByTestId('rta').waitFor();
  await expect(page.getByTestId('assigned-cat_groc')).toHaveText('$700.00');
  await expect(page.getByTestId('rta')).toHaveText('$3,900.00');

  // Undo is session-only: make a fresh edit, then Ctrl+Z it.
  await page.getByTestId('assigned-cat_groc').click();
  await page.getByTestId('assigned-input-cat_groc').fill('650');
  await page.getByTestId('assigned-input-cat_groc').press('Enter');
  await expect(page.getByTestId('assigned-cat_groc')).toHaveText('$650.00');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByTestId('assigned-cat_groc')).toHaveText('$700.00');
  await expect(page.getByTestId('rta')).toHaveText('$3,900.00');
});

test('invalid text keeps the editor open and Escape cancels', async ({ page }) => {
  await resetWithSeed(page);
  await page.getByTestId('assigned-cat_fun').click();
  const input = page.getByTestId('assigned-input-cat_fun');
  await input.fill('abc');
  await input.press('Enter');
  await expect(input).toHaveClass(/invalid/);
  await input.press('Escape');
  await expect(page.getByTestId('assigned-cat_fun')).toHaveText('$0.00');
});
```

- [ ] **Step 4: Run the full gates from the top**

`npm run check` → `npx vitest run` → `npx playwright test`. Expected: all green. A failing text assertion usually means a formatting difference; read the actual string in the report before touching the seed.

- [ ] **Step 5: Update CLAUDE.md "Build discipline"**

Replace the first sentence ("None of these commands exist here yet…") with: "These commands are real; `npm run dev` serves `http://localhost:5173/magpie/`, and Settings → Load sample data seeds an empty database (or set `localStorage['magpie:seed']='1'` before boot, which the e2e specs do)."

- [ ] **Step 6: Commit and push**

Stage `playwright.config.ts e2e/budget.spec.ts CLAUDE.md package.json package-lock.json` (if playwright changed the lockfile). Message: "Add Playwright budget spec; phase 1 complete". Push `origin/main`. Update the memory file: phase 1 done, next is phase 2 (YNAB import).

---

## Self-review

**Spec coverage for phase 1:** §2 layout and layer rules (Tasks 1, 7, 8, 9); §3 every row type (Task 2) and the deterministic assignment id (Task 2, used in Task 7); §4.1 availability with cutover/history/carriedIn (Task 5, tests "months before cutover"); §4.2 RTA and uncategorised (Task 5); §4.3 line rules and single-row transfer balances (Task 4); §4.7 undo armed before the mutation, session-only (Task 8); §6 Budget screen (month nav, RTA, uncategorised chip, groups, goal/assigned/activity/available columns) and the Settings items that exist yet (version, persistence, sample data) (Task 9); §8 gates and synthetic fixtures (Tasks 6, 10). Deliberately out of phase 1: goal fill, move money, stats columns, JSON export (spec phases 2 and 3).

**Placeholders:** none; the OC copies are named by exact path and the only edits to them are stated.

**Type consistency:** `computeBudget` returns `rows: Map<string, CategoryMonth>` and the screen reads `budget.rows.get(c.id)`; `Repo.patch` returns the written row and `remove` builds on it; `AppStore.setAssigned` uses `putAssignment` and `remove('assignments', id)` with the `asg_` id shape from `assignmentId`; the e2e test ids match Task 9's markup; `SEED_FLAG` value matches the spec's `localStorage['magpie:seed']`.
