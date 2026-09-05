# Phase 6a: Loans and Tracking Balances Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Loan accounts with terms, generated monthly interest for loans without statements, a projection with payoff date and a lump-sum what-if, and a balance-adjustment action for tracking accounts (spec §4.8).

**Architecture:** `domain/loans.ts` is pure arithmetic (monthly interest, projection, what-if, the interest rows due). The store owns the interest sweep (idempotent by deterministic id; not an undo entry) and `setBalance`. A Loans screen shows terms, projection and what-if; the ledger of a tracking account gets "Set balance". The loan chart waits for phase 6b with the other charts.

**Spec:** §4.8, §3 (`Account.loan`, `Settings.adjustment`), §6.

### Task 1: Domain (`src/lib/domain/loans.ts`)
```ts
export function monthlyInterest(owed: Cents, annualRatePct: number): Cents          // roundHalfAway(owed × rate / 1200); 0 for owed ≤ 0
export interface ProjectionStep { month: MonthKey; interest: Cents; payment: Cents; owed: Cents }
export interface Projection { steps: ProjectionStep[]; payoffMonth: MonthKey | null; months: number; totalInterest: Cents; stalls: boolean }
export function projectLoan(owed: Cents, terms: LoanTerms, fromMonth: MonthKey, opts?: { lumpSum?: Cents; maxMonths?: number }): Projection
export function whatIf(owed: Cents, terms: LoanTerms, fromMonth: MonthKey, lumpSum: Cents): { base: Projection; withLump: Projection; monthsSaved: number; interestSaved: Cents }
export function dueInterest(account: Account, transactions: Transaction[], today: IsoDate): { month: MonthKey; date: IsoDate; amount: Cents; id: string }[]
//   months from the loan's earliest transaction month to today's month whose interest date ≤ today and whose id is absent; each computed on the balance owed before that date, in order, including earlier rows this call adds
```
- [ ] Tests: zero-rate schedule; a 12% loan; lump sum saves months and interest; a payment equal to the interest stalls; dueInterest is idempotent and sequential.

### Task 2: Store
- `setLoanTerms(accountId, terms)` (undoable patch), `runInterestSweep()` (writeBatch, no undo entry; called from init and visibility), `setBalance(accountId, newBalance, payeeName, categoryId?)` → addTransaction with amount = new − working and a remembered `settings.adjustment`.
- [ ] Tests: sweep posts rows once, on the right dates and amounts, and again only for new months; setBalance writes the difference and remembers the choice.

### Task 3: Screens and e2e
- `#/loans` (`LoansView`): per loan account: owed, terms form (`loan-rate-<id>`, `loan-payment-<id>`, `loan-generate-<id>`, `loan-day-<id>`, `loan-save-<id>`), projection (`loan-payoff-<id>`, `loan-months-<id>`, `loan-interest-<id>`, stall warning), what-if (`loan-lump-<id>`, `loan-saved-<id>`).
- Ledger of an off-budget non-loan account: `set-balance` → form (`sb-amount`, `sb-payee`, `sb-category`, `sb-save`).
- Nav entry "Loans" only when a loan account exists. `visibilitychange` also runs the sweep.
- e2e: add a loan account, set terms with interest generation, see interest rows appear, projection numbers; set balance on the seed Brokerage and see the adjustment row.
