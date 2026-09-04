# Phase 2: YNAB Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import a YNAB "Export budget" (Register + Plan CSVs) into an empty database so the budget screen shows Ben's real categories and numbers, with the cutover month verified against YNAB to the penny before anything is written; plus a JSON export/import safety net.

**Architecture:** A pure `domain/ynab.ts` turns the two CSV texts plus Ben's per-account choices into a complete row set and a verification report; the store writes the rows in one transaction; the import screen is a thin driver over those two calls. Verification reuses `computeBudget` on the rows about to be written, so what is checked is what gets stored.

**Tech Stack:** as phase 1. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-04-magpie-design.md` §5 (pipeline), §5.1 (YNAB), §4.1 (cutover, `carriedIn`), §6 Import and Settings, §8 testing. Structural facts about the real export are in `private/NOTES.md` ("YNAB export structure"); everything there was verified against the real files, and the synthetic fixture below mirrors those shapes.

## Global Constraints

Everything in the phase 1 plan's Global Constraints, plus:

- Fixtures are synthetic. Real files stay in `private/`; the only thing that touches them is the local-only script in Task 4, which prints counts and mismatch totals, never rows.
- The YNAB import writes only into an empty database. Redoing it means Settings → Delete all data first (armed confirm).
- Deviations from spec §5.1 decided here: (1) import requires an empty database instead of relying on per-row `externalId` idempotency (the row hash is still stored for traceability); (2) YNAB's `Hidden Categories` group is imported as a hidden group rather than restored to the categories' original groups, which the export does not record.

---

## File structure

```
src/lib/domain/csv.ts            parseCsv (RFC 4180)
src/lib/domain/ynab.ts           readers, inferAccounts, buildYnabImport, verification
src/lib/domain/ynabFixture.ts    the synthetic Register/Plan CSV texts used by unit and e2e tests
src/lib/state/app.svelte.ts      importYnab, exportJson, importJson, deleteAllData
src/lib/ui/ImportView.svelte     the import screen
src/lib/ui/SettingsView.svelte   export / import / delete all
src/lib/ui/BudgetView.svelte     show-hidden toggle
src/lib/ui/router.svelte.ts      #/import
e2e/fixtures/ynab-register.csv, e2e/fixtures/ynab-plan.csv   written from ynabFixture at test time
e2e/import.spec.ts
private/verify-ynab.ts           local-only: runs buildYnabImport on the real files (never committed)
```

---

### Task 1: CSV parser

**Files:** Create `src/lib/domain/csv.ts`, `src/lib/domain/csv.test.ts`

**Interfaces:**
- Produces: `parseCsv(text: string): string[][]` (handles quoted fields, doubled quotes, embedded newlines and commas, CRLF and LF, a UTF-8 BOM, a trailing newline; no header handling), `csvObjects(text: string): Record<string, string>[]` (first row as keys; rows shorter than the header get `''` for missing keys).

- [ ] Test cases (write first, watch them fail):
  - `a,b\n1,2\n` → `[['a','b'],['1','2']]`
  - `"x, y","he said ""hi"""\r\n` → `[['x, y','he said "hi"']]`
  - `"multi\nline",z` → one row with an embedded newline
  - BOM prefix `﻿a,b` → header `a`
  - `csvObjects('a,b\n1\n')` → `[{a:'1', b:''}]`
  - empty text → `[]`
- [ ] Implement as a single pass over characters with an `inQuotes` flag; strip a leading `﻿`; drop a final empty row produced by a trailing newline.
- [ ] Commit: "Add an RFC 4180 CSV parser".

---

### Task 2: YNAB readers and account inference

**Files:** Create `src/lib/domain/ynab.ts` (readers only for now), `src/lib/domain/ynab.test.ts`, `src/lib/domain/ynabFixture.ts`

**Interfaces:**
```ts
export interface YnabRegisterRow { account: string; date: IsoDate; payee: string; group: string; category: string; groupCategory: string; memo: string; amount: Cents; cleared: ClearedState; line: number }
export interface YnabPlanRow { month: MonthKey; group: string; category: string; groupCategory: string; assigned: Cents; activity: Cents; available: Cents }
export function parseYnabMoney(s: string): Cents            // "$1,234.56" → 123456; "-$50.00" and "$-50.00" → -5000; "" → 0
export function parseYnabDate(s: string): IsoDate           // "09/04/2026" → "2026-09-04"
export function parseYnabMonth(s: string): MonthKey         // "Sep 2026" → "2026-09"
export function readYnabRegister(text: string): YnabRegisterRow[]   // amount = inflow − outflow; cleared: Reconciled → 'cleared'
export function readYnabPlan(text: string): YnabPlanRow[]
export function isYnabRegister(headerLine: string): boolean  // exact header match, used by the import screen's format detection
export function isYnabPlan(headerLine: string): boolean
export interface InferredAccount { name: string; rows: number; onBudget: boolean; kind: AccountKind }
export function inferAccounts(rows: YnabRegisterRow[]): InferredAccount[]
```
`inferAccounts`: `onBudget` is true when the account has at least one categorised non-transfer row; `kind` defaults to `'chequing'` for on-budget and `'other'` for off-budget (Ben sets the real kind in the screen). Sorted by first appearance.

**Fixture** (`ynabFixture.ts` exports `REGISTER_CSV` and `PLAN_CSV` strings). Accounts: `Chequing`, `Card`, `Partner`, `Brokerage`. Groups: `Everyday` (Groceries, Fun), `Bills` (Rent), `Hidden Categories` (Old Hobby), `Credit Card Payments` (Card). Months Jul, Aug, Sep 2026. Rows must cover, in this order of appearance:
1. `Starting Balance` inflow to `Inflow: Ready to Assign` in Chequing (07/01/2026, $1,000.00, Reconciled).
2. Plain Groceries outflow in Card (07/05, $45.00, Cleared).
3. A 3-line split in Chequing on 07/10: `Split (1/3) tape` Groceries $10.00 payee `Shop`; `Split (2/3)` Fun $5.00 payee `Other Shop` (different payee); `Split (3/3)` payee `Transfer : Partner`, no category, outflow $20.00; plus the mirror row in Partner (`Transfer : Chequing`, inflow $20.00, 07/10).
4. Transfer pair Chequing → Card on 07/15 ($100.00), no category on either side.
5. Transfer pair Chequing → Brokerage on 07/20 ($200.00): Chequing side categorised `Bills: Rent` (stands in for a savings category), Brokerage side uncategorised.
6. Fun outflow in Card 08/03 $60.00 (Fun assigned $50 in Aug → overspent by $10, so Aug available is −$10 and YNAB's Sep carried-in is $0).
7. An uncategorised Card outflow 08/20 $7.00 (becomes `new`).
8. Hidden category row: `Hidden Categories: Old Hobby` outflow Chequing 07/22 $3.00.
9. A row in Brokerage with a category `Everyday: Fun` inflow $9.00 08/25 (reporting-only category in an off-budget account) — wait: inference would then make Brokerage on-budget. Make this row uncategorised instead and keep Brokerage off-budget; the reporting-only case is already covered by ledger tests.
10. Sep: income $500 to RTA 09/01 Chequing; Groceries outflow $12.34 09/03 Card.

Plan rows for every (category, month) with Assigned/Activity/Available consistent with the register under YNAB's rules: Groceries assigned 100/100/100, Fun 50/50/0, Rent 200/0/0, Old Hobby 0/0/0, Card (CC payments) activity as YNAB would compute (assign 0; activity 45 in Jul, 60 in Aug, 12.34 in Sep; available whatever). Aug Fun available −$10.00; Sep Fun carried-in 0 (available = 0 + 0 + 0). Write the Plan numbers by hand and assert them in tests; the point is that the builder reproduces them.

- [ ] Tests for the parsers (money/date/month shapes above, including `-$50.00`), `readYnabRegister` on the fixture (row count, split rows present, amount sign, cleared mapping), `readYnabPlan` (row count, month keys), `inferAccounts` (Chequing/Card on-budget, Partner on-budget because the split's transfer line does not count but Partner needs one categorised row: add a Partner-account row categorised Groceries $8.00 08/10 to the fixture; Brokerage off-budget).
- [ ] Implement; commit: "Add YNAB export readers, account inference and the synthetic fixture".

---

### Task 3: The YNAB builder and verification

**Files:** Modify `src/lib/domain/ynab.ts`, `src/lib/domain/ynab.test.ts`

**Interfaces:**
```ts
export interface YnabAccountChoice { kind: AccountKind; onBudget: boolean; person?: boolean }
export interface YnabBuildOptions { accounts: Record<string, YnabAccountChoice>; now: number; idFor?: () => string }
export interface YnabImport {
  accounts: Account[]; groups: CategoryGroup[]; categories: Category[]; payees: Payee[];
  transactions: Transaction[]; assignments: Assignment[]; history: YnabHistory[];
  cutoverMonth: MonthKey;
  report: YnabReport;
}
export interface YnabReport {
  counts: { accounts: number; groups: number; categories: number; payees: number; transactions: number; splits: number; transfers: number; newRows: number; assignments: number; history: number };
  cutover: { categoryId: string; name: string; ynab: Cents; magpie: Cents }[];   // one per imported category, non-CC
  cutoverMismatches: number;
  activityMismatches: number;        // plan cells outside the CC group whose activity differs from the rows
  creditCardFolded: Cents;           // Σ CC-payment available at cutover, now part of RTA
  droppedGroups: string[];           // ['Credit Card Payments'] when present
  balances: { name: string; working: Cents }[];
}
export function buildYnabImport(register: YnabRegisterRow[], plan: YnabPlanRow[], opts: YnabBuildOptions): YnabImport
```

**Algorithm** (all rows stamped `{ updatedAt: now, editedAt: now, deleted: false }`, ids from `opts.idFor ?? nanoid`):

1. `cutoverMonth` = max month in the plan.
2. Groups: distinct plan `group` values except `Credit Card Payments` (recorded in `droppedGroups`), in order of first appearance; `Hidden Categories` → `{ name: 'Hidden', hidden: true }`. Categories: distinct plan `groupCategory` except CC ones; `hidden` when the group is hidden; `carriedIn` = plan(cutover).available − assigned − activity (0 when no cutover row); `goal` = 0. Map `groupCategory → categoryId`. A register `groupCategory` absent from the plan (defensive) gets a category in a group named `Imported`.
3. Accounts from `opts.accounts` keys in register order; `closed: false`; the `person` choice sets `kind: 'person'` and `onBudget: true`.
4. Payees: distinct register payees excluding those starting with `Transfer : `; `aliases: []`.
5. Transactions, scanning the register in order with a cursor:
   - **Split group**: current memo matches `Split (1/n)`; take the next `n` rows (assert `Split (k/n)` in sequence, same account and date; otherwise throw with the line number). Transaction: account/date/cleared from line 1, payee = line 1's payee (if line 1's payee is a transfer, use the first non-transfer line's payee, else the transfer text stripped), memo = line 1's memo after the prefix, `amount` = Σ line amounts, lines: per row `{ amount, memo: rest-of-memo, categoryId }`, where a row whose payee is `Transfer : X` becomes `{ transferAccountId: X's id, categoryId if the row has one }` and a row whose payee differs from the transaction payee and is not a transfer gets memo `"<payee>: <memo>"` (trim the colon when memo is empty). Each transfer line consumes its mirror row (see below) and takes `farCleared` from it.
   - **Transfer row** (payee `Transfer : X`, not inside a split): find the mirror = the first unconsumed row in account X with payee `Transfer : <this account>`, same date, amount = −this amount. Owner side: this row if `this.onBudget || !mirror.onBudget`, else the mirror. Emit one transaction on the owner: `amount` = owner amount, one line `{ transferAccountId: other, amount, categoryId: owner category ?? mirror category, memo }`, `cleared` = owner cleared, `farCleared` = mirror cleared. Mark both consumed. A transfer row with no mirror throws with its line number (the real file has none; the fixture must not either).
   - **Plain row**: one line. `groupCategory === 'Inflow: Ready to Assign'` → `categoryId: RTA`. Empty category: in an on-budget account → `status: 'new'`, line without category; in an off-budget account → status ok, line without category. Non-empty category → mapped id (reporting-only if off-budget, allowed by §4.3).
   - Every transaction: `source: { kind: 'ynab', batchId }`, `externalId: 'ynab:' + fnv1a(account|date|payee|memo|amount|line)`, `payeeId` from the map (none for transfer-only rows).
   - Skip a consumed row when the cursor reaches it.
6. Assignments: plan rows with `assigned !== 0` outside CC → `{ id: assignmentId(cat, month), categoryId, month, amount }`.
7. History: plan rows outside CC with `month < cutoverMonth` → `YnabHistory` with `ynabHistoryId`.
8. Report: `computeBudget({ accounts, categories, assignments, transactions, history, cutoverMonth, currentMonth: cutoverMonth }, cutoverMonth)`; `cutover[]` compares `rows.get(id).available` with the plan's cutover `available` per category; `cutoverMismatches` counts differences. `activityMismatches`: derive per (category, month) activity from the built transactions with `lineEffect` and compare against every non-CC plan row. `creditCardFolded` = Σ plan(cutover).available over CC categories. `balances` from `accountBalances`.

- [ ] Tests on the fixture with `opts.accounts` = Chequing chequing/on, Card credit/on, Partner person/on, Brokerage investment/off, `idFor` = a counter for stable ids:
  - counts: 4 accounts, 3 groups (Everyday, Bills, Hidden), 4 categories, splits 1, transfers 3 (one inside the split), `newRows` 1, droppedGroups `['Credit Card Payments']`.
  - the split transaction has 3 lines summing to its amount, the second line's memo starts with `Other Shop:`, the third is a transfer to Partner with `farCleared` set; the Partner mirror row produced no separate transaction.
  - Chequing → Card transfer: one row, owner Chequing, no category; Chequing → Brokerage: one row, category Rent, `lineEffect` −20000.
  - the uncategorised Card row is `status: 'new'`; the Brokerage uncategorised row is `ok`.
  - `Old Hobby` is hidden and its group is `Hidden` with `hidden: true`.
  - `carriedIn`: Fun = 0 (YNAB reset the −$10.00), Groceries = its Aug available.
  - `cutoverMismatches === 0`, `activityMismatches === 0`, `creditCardFolded` equals the fixture's CC Sep available.
  - every transaction passes `validateTransaction`.
  - a register row referencing an account missing from `opts.accounts` throws.
- [ ] Implement; commit: "Build a full row set from a YNAB export and verify it against the Plan".

---

### Task 4: Local-only verification against the real export

**Files:** Create `private/verify-ynab.ts` (gitignored; never staged)

```ts
import { readFileSync } from 'node:fs';
import { buildYnabImport, inferAccounts, readYnabPlan, readYnabRegister } from '../src/lib/domain/ynab';
const [reg, plan] = process.argv.slice(2).map((p) => readFileSync(p, 'utf8'));
const register = readYnabRegister(reg!); const planRows = readYnabPlan(plan!);
const accounts = Object.fromEntries(inferAccounts(register).map((a) => [a.name, { kind: a.kind, onBudget: a.onBudget }]));
const out = buildYnabImport(register, planRows, { accounts, now: Date.now() });
const { counts, cutoverMismatches, activityMismatches, creditCardFolded, droppedGroups } = out.report;
console.log({ counts, cutoverMismatches, activityMismatches, creditCardFolded, droppedGroups, cutoverMonth: out.cutoverMonth });
```

- [ ] Run: `npx vite-node private/verify-ynab.ts "private/ynab/<Register>.csv" "private/ynab/<Plan>.csv"` (vite-node ships with vitest). Expected: `cutoverMismatches: 0`, `activityMismatches: 0`, transactions ≈ 7522 − 325 split rows + splits − 249 mirror rows, `newRows` small (the 2026-08 uncategorised rows). Any nonzero mismatch is a builder bug: fix it in `ynab.ts` with a fixture case that reproduces it, never by special-casing the real data. Print nothing but the object above.

---

### Task 5: Store methods

**Files:** Modify `src/lib/state/app.svelte.ts`, `src/lib/state/app.test.ts`

**Interfaces:**
```ts
importYnab(build: YnabImport): Promise<void>      // throws if !isEmpty(); importRows all tables; updateSettings({ cutoverMonth }); hydrate; undoStack.clear()
exportJson(): Promise<string>                     // { schema: 1, exportedAt, settings, accounts, groups, categories, payees, transactions, assignments, history } incl. tombstones (read via repo.loadSnapshot)
importJson(text: string): Promise<void>           // throws if !isEmpty() or schema unsupported; importRows; settings; hydrate
deleteAllData(): Promise<void>                    // db.delete() then re-init on the same name
```
Repo gains `loadSnapshot(): Promise<Record<TableName, Row[]> & { settings: Partial<Settings>; settingsUpdatedAt: number }>` (all rows including tombstones, sparse settings) and `deleteDatabase()`.

- [ ] Tests: importYnab on the fixture build populates the mirror and sets `settings.cutoverMonth`; importYnab on a non-empty db throws; exportJson → importJson round trip into a fresh store reproduces every table including a tombstoned row; deleteAllData leaves `isEmpty()` true and the store ready.
- [ ] Commit: "Store: YNAB import, JSON export/import, delete all data".

---

### Task 6: Import screen, settings, hidden toggle

**Files:** Create `src/lib/ui/ImportView.svelte`; modify `src/lib/ui/router.svelte.ts` (`{ name: 'import' }` at `#/import`), `src/App.svelte` (nav button `nav-import`, route), `src/lib/ui/SettingsView.svelte`, `src/lib/ui/BudgetView.svelte`

Import screen behaviour and test ids:
- Two `<input type="file">`: `file-register`, `file-plan`. Reading a file: `await file.text()`; detect with `isYnabRegister`/`isYnabPlan` on the first line; a wrong file shows `import-error` text.
- When both are read: the accounts table (`account-row-<index>`) with a `kind` select (`kind-<index>`), an on-budget checkbox (`onbudget-<index>`), a person radio (`person-<index>`); defaults from `inferAccounts`. Choosing person sets kind `person` and on-budget.
- `analyse` button → `buildYnabImport` → report panel: counts line (`report-counts`), verification table rows `verify-<categoryId>` with YNAB and Magpie values and a `mismatch` class when they differ, `report-mismatches` ("0 cutover mismatches, 0 activity mismatches"), `report-cc` ("Ready to Assign includes $X previously reserved for card payments" when non-zero), balances list.
- `import` button, enabled only when the database is empty and the report exists; on click `app.importYnab(build)` then `navigate({ name: 'budget' })`. When the database is not empty, show `import-blocked` with a link to Settings.
- Copy has no em dashes.

Settings additions: `export-json` (creates a Blob URL and clicks a hidden `<a download="magpie-<date>.json">`), `import-json` file input (enabled only when empty; error text `settings-error` otherwise), `delete-all` armed confirm: first click arms (`delete-all-armed` visible, button text "Really delete everything?"), second click within 5 s runs `deleteAllData()`; any other click disarms.

Budget: a `show-hidden` checkbox in the header; when on, hidden groups and hidden categories render with a `hidden` class.

- [ ] `npm run check` clean; `npm run dev`, walk the import with the fixture files (write them with the e2e helper below), see the budget.
- [ ] Commit: "Import screen for YNAB exports; JSON export/import and delete-all in Settings".

---

### Task 7: e2e and gates

**Files:** Create `e2e/import.spec.ts`, `e2e/fixtures/.gitkeep`; modify `CLAUDE.md` (mention `#/import` and the fixture writer)

- [ ] `e2e/import.spec.ts`: a `test.beforeAll` writes `REGISTER_CSV`/`PLAN_CSV` from `src/lib/domain/ynabFixture.ts` to `e2e/fixtures/ynab-register.csv` and `ynab-plan.csv` (import the module directly; Playwright runs TS). Flow: fresh db (no seed flag) → `#/import` → `setInputFiles` on both inputs → set Partner as person, Brokerage off-budget → `analyse` → expect `report-mismatches` to have text `0 cutover mismatches, 0 activity mismatches` → `import` → budget shows Sep 2026 with Groceries available equal to the fixture's Plan value and Fun `$0.00`; `#/settings` shows `import-blocked` behaviour on a second attempt at `#/import`; `show-hidden` reveals `Old Hobby`.
- [ ] Add `e2e/fixtures/*.csv` to `.gitignore` (they are generated).
- [ ] Full gates from the top; commit "Add the YNAB import e2e; phase 2 complete"; push; update the memory file (phase 2 done, next phase 3).

---

## Self-review

Spec coverage: §5.1 accounts with per-account kind/on-budget and person pick (Task 6), groups and categories incl. CC drop and hidden (Task 3), splits with per-line payees and transfer lines (Task 3), transfer pairing keeping the on-budget side's category (Task 3), RTA inflow and Starting Balance as ordinary rows (Task 3), externalId hash (Task 3), history and assignments and `carriedIn` (Task 3), cutover verification blocking commit (Tasks 3, 6), JSON export as the pre-sync safety net (Tasks 5, 6). Deviations are listed under Global Constraints. Type names match phase 1 (`Account`, `Category.carriedIn`, `assignmentId`, `ynabHistoryId`, `computeBudget`, `lineEffect`, `accountBalances`, `validateTransaction`).
