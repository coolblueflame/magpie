# Phase 3b: Ledgers, Review Queue, Payees Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** See and edit transactions: an accounts list with balances, a ledger per account (transfers on both sides, running balance, render budget), a transaction editor with splits and transfers, delete, cleared toggles, a review queue for `new` rows with payee pre-fill, and a payees screen with rename and merge. Everything undoable.

**Architecture:** `domain/ledger.ts` derives ledger rows; `domain/transactions.ts` turns an editor draft into transaction fields and back; `domain/payees.ts` holds payee memory and normalisation. The store gains `commitEdits`, a multi-table undo batch that `patchRows`/`createRow` become wrappers over, so a merge (payees + transactions) or an add-with-new-payee is one undo entry. Screens: Accounts, Ledger, Review, Payees, plus shared `CategoryPicker` and `TransactionEditor` components.

**Spec:** §3 Transaction/Payee, §4.3 transfers, §4.5 payees and pre-fill, §4.6 cleared and new, §4.7 undo, §6 Accounts/Ledger, Review, Payees.

## Global Constraints

As before. Plus: ledger rows never mutate transactions; a far-side row edits the owning transaction; the editor takes outflow and inflow fields (both positive) and stores `amount = inflow − outflow`.

---

## File structure

```
src/lib/domain/ledger.ts          + LedgerRow, ledgerRows(accountId, transactions)
src/lib/domain/payees.ts          normalisePayeeKey, payeeLastCategory, payeeUsage
src/lib/domain/transactions.ts    TxDraft, LineDraft, draftFromTransaction, fieldsFromDraft
src/lib/domain/seed.ts            payees + a second new row
src/lib/state/app.svelte.ts       commitEdits; addTransaction, updateTransaction, deleteTransaction, setCleared,
                                  confirmTransaction, confirmAll, ensurePayee, renamePayee, mergePayees
src/lib/ui/CategoryPicker.svelte  select: Ready to Assign, categories by group, transfers by account
src/lib/ui/TransactionEditor.svelte
src/lib/ui/AccountsView.svelte    #/accounts
src/lib/ui/LedgerView.svelte      #/account/<id>
src/lib/ui/ReviewView.svelte      #/review
src/lib/ui/PayeesView.svelte      #/payees
e2e/ledger.spec.ts, e2e/review.spec.ts, e2e/payees.spec.ts
```

---

### Task 1: Domain

```ts
// ledger.ts
export type LedgerKind =
  | { type: 'category'; categoryId?: string }
  | { type: 'transfer'; accountId: string; categoryId?: string }
  | { type: 'split'; lines: number };
export interface LedgerRow {
  id: string;            // txId for own rows, `${txId}:${lineIndex}` for far rows
  txId: string; far: boolean; ownerAccountId: string;
  date: IsoDate; payeeId?: string; memo: string;
  amount: Cents;         // this account's view (far rows: −line.amount)
  cleared: ClearedState; // own: tx.cleared; far: line.farCleared ?? 'uncleared'
  status: TxStatus; kind: LedgerKind; running: Cents;
}
export function ledgerRows(accountId: string, transactions: Transaction[]): LedgerRow[]
//   own rows + far rows; tombstones skipped; sorted date desc then id asc; running balance = cumulative in date asc order

// payees.ts
export function normalisePayeeKey(name: string): string          // trim, collapse whitespace, lower-case
export function payeeLastCategory(payeeId: string, transactions: Transaction[], accountsById: Map<string, Account>): string | undefined
//   newest `ok` transaction of that payee in an on-budget account with exactly one line that has a categoryId and no transfer; RTA counts
export function payeeUsage(transactions: Transaction[]): Map<string, { count: number; last: IsoDate }>

// transactions.ts
export type LineTarget = { type: 'none' } | { type: 'category'; categoryId: string } | { type: 'transfer'; accountId: string; categoryId?: string; farCleared?: ClearedState; farExternalId?: string };
export interface LineDraft { target: LineTarget; amount: Cents; memo: string }
export interface TxDraft { accountId: string; date: IsoDate; payeeId?: string; memo: string; outflow: Cents; inflow: Cents; cleared: ClearedState; split: boolean; target: LineTarget; lines: LineDraft[] }
export function draftFromTransaction(tx: Transaction): TxDraft
export function fieldsFromDraft(draft: TxDraft, accountsById: Map<string, Account>): Pick<Transaction, 'accountId' | 'date' | 'payeeId' | 'memo' | 'amount' | 'cleared' | 'status' | 'lines'>
//   amount = inflow − outflow; lines from target (or draft.lines when split); throws on validation errors other than a missing category; status 'new' when a budget-touching line lacks a category, else 'ok'
export function emptyDraft(accountId: string, date: IsoDate): TxDraft
```
Seed: payees `pay_grocer, pay_landlord, pay_arcade, pay_power, pay_employer, pay_mystery` attached to the matching rows; a fifteenth transaction `seed_t15` in Card on day 05 of the current month, −$15.55, payee Grocer, uncategorised, `new`. Seed test: `onBudgetTotal` 536900, uncategorised −5755; `e2e/budget.spec.ts` chip text `Uncategorised -$57.55`.

- [ ] Tests: ledgerRows on the seed Chequing and Card ledgers (far transfer row present with negated amount and farCleared, running balances end at the account balance, sort order, split kind); payeeLastCategory (newest wins, ignores splits/transfers/new rows/off-budget); normalisePayeeKey; draft round trip on a split transaction and on a transfer; fieldsFromDraft status new/ok; throws on transfer to own account.
- [ ] Commit: "Domain: ledger rows, payee memory, transaction drafts; seed payees".

### Task 2: Store

```ts
export type Edit =
  | { table: TableName; id: string; patch: Partial<Row> }
  | { table: TableName; id: string; create: Omit<Row, keyof Row> & Record<string, unknown> };
commitEdits(edits: Edit[], label: string): Promise<void>
//   priors captured from the mirror before any write; undo reverses in reverse order (creates → deleted:true; patches → priors); redo re-applies (creates → deleted:false)
patchRows / createRow / applyAssignments unchanged in behaviour, implemented over commitEdits where natural
ensurePayee(name): { id: string; edits: Edit[] }            // existing by normalised key (name or alias) → no edits; else a create edit
addTransaction(draft: TxDraft, payeeName?: string): Promise<Transaction>   // one entry incl. a new payee
updateTransaction(id, draft: TxDraft, payeeName?: string): Promise<void>
deleteTransaction(id): Promise<void>
setCleared(txId: string, side: string /* accountId */, cleared: ClearedState): Promise<void>   // own side patches tx.cleared; far side patches the matching line's farCleared
confirmTransaction(id, categoryId?: string): Promise<void>    // sets the single line's category when given; status 'ok'; throws if still uncategorised
confirmAll(items: { id: string; categoryId: string }[]): Promise<void>   // one entry
renamePayee(id, name), mergePayees(ids: string[], into: string)   // merge: transactions repointed, aliases + old names appended to the survivor, others tombstoned; one entry
```
- [ ] Tests: addTransaction with a new payee name creates both and undo removes both; updateTransaction on a split; deleteTransaction undo; setCleared on the far side patches `farCleared`; confirmTransaction sets category and status; mergePayees repoints and undo restores every transaction and un-tombstones.
- [ ] Commit: "Store: multi-table undo batches; transaction, cleared, confirm and payee operations".

### Task 3: Components and screens

- **CategoryPicker** props `{ value: LineTarget; accountId: string; onChange }`: `<select>` with options `none` ("Choose…"), `rta` ("Ready to Assign"), optgroups per visible group, optgroup "Transfer to" per open account except `accountId`. Value encoding `cat:<id>` / `xfer:<id>` / `rta` / `''`. Test id from a prop.
- **TransactionEditor** props `{ draft: TxDraft; payees: Payee[]; onSave(draft, payeeName); onCancel; onDelete? }`: fields `ed-date` (type=date), `ed-payee` (text + datalist of payee names), `ed-target` (CategoryPicker) or, when split, a lines table (`ed-line-<i>-target`, `ed-line-<i>-amount`, `ed-line-<i>-memo`, `ed-line-remove-<i>`, `ed-line-add`) with a remainder line `ed-remainder`; `ed-memo`, `ed-outflow`, `ed-inflow`, `ed-cleared`; `ed-split` toggles split (converting the single target into line 1); `ed-save` (disabled while split remainder ≠ 0 or amount is 0), `ed-cancel`, `ed-delete`. Enter in a text field saves; Escape cancels.
- **AccountsView** (`#/accounts`): sections Budget / Tracking with rows `acct-<id>` (name, kind, working `acct-working-<id>`, cleared `acct-cleared-<id>`), section totals, `show-closed` toggle, click → ledger.
- **LedgerView** (`#/account/<id>`): header with name, working/cleared balances (`ledger-working`, `ledger-cleared`), `add-tx`; table rows `row-<rowId>` with date, payee, category label (`Split (3)`, `Transfer: <Account>`, category name, `Ready to Assign`), memo, outflow, inflow, running (`running-<rowId>`), cleared toggle `clr-<rowId>` (click toggles; far rows toggle `farCleared`), a `new` badge; click a row → editor inline under it (far rows edit the owner, the editor shows "Entered in <owner>"); first 100 rows + `show-more`.
- **ReviewView** (`#/review`): rows `rv-<txId>` sorted by date: account, date, payee, memo, amount, a CategoryPicker `rv-target-<txId>` pre-filled from `payeeLastCategory` (row gets class `prefilled`), `rv-confirm-<txId>`; header `rv-count`, `confirm-prefilled` (armed) confirming every prefilled row; empty state text.
- **PayeesView** (`#/payees`): search `pay-search`, rows `pay-<id>` (name, count, last used, aliases), rename inline (`pay-rename-<id>`), checkbox `pay-pick-<id>`, when ≥2 picked a bar with `merge-into` select (the picked ones) and `merge` button.
- Nav gains Accounts, Review (with count badge `nav-review-count` when > 0), Payees. Router routes accordingly.
- [ ] check clean; walk with the seed.
- [ ] Commit: "Accounts, ledger with editor, review queue, payees screens".

### Task 4: e2e and gates

- `ledger.spec.ts` (seed): Card ledger shows the incoming transfer row from Chequing with `+$380.00` and cleared; running balance of the newest row equals the header working balance; add a manual outflow $12.00 to Groceries with a new payee "Corner Shop" → appears, budget Groceries available drops $12; edit it to a split (Groceries 8 / Fun 4) → label `Split (2)`; toggle cleared; delete → gone, Ctrl+Z → back.
- `review.spec.ts` (seed): two rows; the Grocer row is prefilled with Groceries; confirm it → gone, uncategorised chip on the budget drops to `-$42.00`; pick Fun for the other and confirm → review empty, nav badge gone.
- `payees.spec.ts` (seed): rename Grocer → "Grocer Co"; pick Arcade + Mystery, merge into Arcade → Mystery gone, Card ledger shows Arcade on the old Mystery row; Ctrl+Z restores.
- Full gates; commit "Phase 3b e2e"; push; memory.

## Self-review

Covers §6 Accounts/Ledger (Tasks 1, 3), manual entry and splits and shared-percent editor (percent editing lands with phase 4's person flows, deliberately deferred), §4.5 pre-fill (Tasks 1–3), §4.6 cleared and new (Tasks 1–3), payees rename/merge/aliases (Tasks 2, 3), undo for everything (Task 2). Types match phases 1–3a.
