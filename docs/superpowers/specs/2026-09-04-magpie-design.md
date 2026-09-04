# Magpie design spec

Status: approved by Ben in conversation on 2026-09-04 (product decisions) with architecture
delegated to Claude. This document is the durable record; `CLAUDE.md` summarises it and
`docs/PLAYBOOK.md` supplies the engineering recipe it leans on. Later sections cite playbook
sections as `PB §n`.

## 1. Vision and locked decisions

A personal budgeting app replacing YNAB for one user, on a desktop browser, with every
transaction arriving from files the user downloads by hand. The one rule that differs from
YNAB: category balances roll forward every month **including negative balances**; nothing is
ever reset or forgiven.

Locked (revisit only with Ben):

- Desktop-only UI; no phone layout work. A private GitHub data repo is the cloud source of
  truth so a second device or a mobile helper view can come later.
- No live bank connections, ever. Files only.
- Credit cards are ordinary accounts that go negative.
- No formal statement reconciliation; cleared/uncleared exists as a gap-finding aid.
- Money is integer cents; balances are derived from rows, never stored.
- Nothing personal in the public repo: institutions, card products, merchants, partner's
  name, real amounts, account digits, real files. Test fixtures are synthetic.
- Vocabulary: **monthly goal** (the amount a category normally gets), **Ready to Assign**
  (unassigned money), **new** (an imported transaction awaiting review), **share claim**
  (a shared-expense row awaiting its bank transaction).

## 2. Platform and architecture

Stack and versions per PB §2.1: Svelte 5 (runes), TypeScript 5, Vite, vite-plugin-pwa,
Dexie, Vitest + fake-indexeddb, Playwright, svelte-check. Node 22 on CI. Copy and trim
`vite.config.ts`, `playwright.config.ts`, `tsconfig.json`, `src/tests/setup.ts`,
`.github/workflows/deploy.yml` from the Organized Chaos repo.

Layout and layer rules per PB §2.2:

```
src/lib/domain/    pure functions + types; money, budget math, matcher, parsers, importers
src/lib/storage/   db.ts (Dexie schema), repo.ts (the only Dexie caller)
src/lib/state/     app.svelte.ts (the store), undo.svelte.ts
src/lib/sync/      copied from OC: githubClient, files, merge, engine
src/lib/ui/        screens and components
e2e/               Playwright specs
docs/              this spec, plans, the playbook, human setup docs
private/           gitignored: real files and personal notes
```

Domain is pure and exhaustively unit-tested. One store singleton holds a `$state` mirror of
living rows; every mutation persists first, then patches the mirror in place. Screens never
touch the repo. Sync is a separate engine with an injectable client.

Import adapters are keyed by **format**, never by institution: an OFX/QFX parser, a CSV
parser driven by user-saved column profiles, and the YNAB export importer.

## 3. Data model

Every synced row carries `{ id, updatedAt, editedAt?, deleted }` per PB §2.3; `updatedAt`
via `nextStamp`, tombstones never hard deletes, deterministic ids where two devices could
mint the same logical row. All amounts are integer cents, **outflows negative, inflows
positive**, in every row and every function; formatting happens at the UI edge.

**Account** `{ id, name, kind, onBudget, closed, sortOrder, note }`
- `kind`: `chequing | savings | credit | cash | person | loan | investment | other`.
- `onBudget`: money that belongs to the budget. `person` accounts are on-budget (a receivable
  is money you have). `loan`, `investment` and other tracking accounts are off-budget.
- Balance is derived: own transactions plus incoming transfer lines (§4.3).

**CategoryGroup** `{ id, name, sortOrder, hidden }`

**Category** `{ id, groupId, name, goal, sortOrder, hidden, note, carriedIn? }`
- `goal`: monthly goal in cents, 0 when unset.
- `carriedIn`: the available amount YNAB carried into the cutover month, set by the YNAB
  import (§4.1); absent for categories created after cutover.
- The reserved id `rta` is Ready to Assign. Income lines target it. It has no group and is
  never listed as a category.

**Assignment** `{ id: "asg_<categoryId>_<YYYY-MM>", categoryId, month, amount }`
- One row per category-month, deterministic id so two devices collapse instead of twinning.
- "Move money" writes two assignments in one undoable action.

**Transaction**
```
{ id, accountId, date, payeeId, memo, amount, cleared, status,
  externalId, source, shared, lines: Line[] }
Line: { categoryId?, transferAccountId?, amount, memo,
        farCleared?, farExternalId? }
```
- `amount` is the account's view; `lines` sum to `amount` exactly (domain-enforced).
- A line has a `categoryId`, a `transferAccountId`, or (transfer to/from an off-budget
  account) both. Never neither on a confirmed transaction; a `new` transaction may have an
  uncategorised line.
- `cleared`: `uncleared | cleared`. YNAB's Reconciled imports as cleared.
- `status`: `new | ok`. Imports create `new`; confirming sets `ok`.
- `externalId`: the bank's id for this row (OFX `FITID`, a CSV id column, or a stable hash
  of the source row when the format has no id). Unique per account; the dedup key across
  repeated imports. `source`: `{ kind: 'ynab' | 'ofx' | 'csv' | 'sheet' | 'manual',
  profileId?, batchId }` for the import summary and troubleshooting.
- `shared`: `{ accountId, percent }` when the transaction is split with a person account;
  `percent` is the other person's share. Editing it re-derives the two lines (§4.4).
- Transfers are **one row** shown in both ledgers (§4.3); `farCleared` / `farExternalId`
  hold the other account's cleared state and bank id.

**Payee** `{ id, name, aliases: string[], note }`
- `aliases` are normalised raw descriptors from imports that resolve to this payee. Rename
  changes `name`; merge moves aliases and transactions to the survivor and tombstones the
  other. The category to pre-fill is derived at use time: the most recent `ok` transaction
  of this payee in an on-budget account with a single category line.

**ShareClaim** `{ id, date, total, percent, description, status, transactionId? }`
- From the shared-sheet import, rows where Ben paid. `id` is a stable hash of the source row.
  `status`: `open | applied | dismissed`. `percent` is the partner's share.

**CsvProfile** `{ id, headerSignature, name, mapping, dateFormat, amountMode }`
- `headerSignature` is the normalised header row; `mapping` names the date, payee, memo, id
  and either amount or outflow/inflow columns; `amountMode` says how sign is expressed.
  Saved the first time an unknown CSV is imported, applied automatically after.

**YnabHistory** `{ id: "yh_<categoryId>_<YYYY-MM>", categoryId, month, assigned,
activity, available }` for months before cutover, display-only (§4.1). Static after import.

**Settings** (kv table, sparse per PB §2.3): `cutoverMonth`, `currency` (CAD), theme, sync
config. The GitHub token lives in a separate device-local table and never syncs.

## 4. Core rules

All rules are pure functions in `src/lib/domain/`, computed from a snapshot of rows.

### 4.1 Category availability

For a category `c` and month `m` (calendar months):

```
activity(c, m)  = Σ budget effect of lines with categoryId = c dated in m (§4.3)
assigned(c, m)  = the assignment row's amount, else 0
available(c, m) = m < cutover ? ynabHistory(c, m).available
                : available(c, m − 1) + assigned(c, m) + activity(c, m)
available(c, cutover − 1) = anchor(c)
```

`anchor(c)` is `Category.carriedIn`: what YNAB carried into the cutover month, derived at
import as `ynabAvailable(c, cutover) − ynabAssigned(c, cutover) − ynabActivity(c, cutover)`
so the cutover month matches YNAB to the penny on day one. From then on the Magpie rule applies and
negatives carry. Months with no rows are computed, not stored; future months compute the same
way (assignments may exist, activity is zero).

### 4.2 Ready to Assign

One global number, derived from the conservation identity rather than tracked:

```
uncategorised = Σ amount of lines with no categoryId on `new` transactions in on-budget accounts
M*            = max(current month, latest month with any assignment)
RTA           = Σ balance(on-budget accounts) − Σ_c available(c, M*) − uncategorised
```

Assigning to a future month raises `available(c, M*)` and lowers RTA immediately, which is
what lets a future month be partly funded without going negative. Income raises balances
and RTA. A `new` transaction moves value into `uncategorised` until it is confirmed, so RTA
does not jump during import review; the budget header shows the uncategorised total while
it is non-zero.

The YNAB export carries no goals, so a category with no goal shows a **suggested goal**: the
most frequent non-zero amount assigned to it in the last twelve months (tie: the most
recent), adoptable in one click, per category or all at once.

Filling a category's goal for month `m` sets `assigned(c, m) = goal` (no-op if already at
or above goal). A "fill all goals" action does this for every visible category in the
month, each to its own goal, and shows the total it will take from Ready to Assign before
it commits; it is one undo entry.

### 4.3 Transfers and budget effect

A transfer is one transaction row. The ledger of account `B` shows, besides its own rows,
every row from another account with a line `transferAccountId = B`, displayed with the line's
amount negated. `balance(B)` follows the same rule.

Budget effect of a line, for `activity`:

- Both accounts on-budget: effect 0. A category here is allowed but reporting-only.
- Own account on-budget, no transfer or transfer to off-budget: effect `line.amount`.
- Own account off-budget, transfer to on-budget: effect `−line.amount`.
- Neither on-budget, or an off-budget account's own row: effect 0. A category here is
  allowed but reporting-only, which is how investment gains keep a category (§10) without
  ever touching the budget.

The domain validator requires a category wherever the budget is touched on an `ok`
transaction; it never strips one elsewhere.

### 4.4 Shared expenses

The partner is a `person` account (imported from its YNAB account; its history stays as it
was). Rules:

- Ben pays, partner share `p`%: the bank transaction is split into a category line for
  `total − share` and a transfer line to the person account for `share`, where
  `share = round_half_up(total × p / 100)` and the category line is the exact remainder.
- Partner pays: a transaction in the person account for Ben's share, categorised, no bank
  account involved.
- Settling up is a transfer between a bank account and the person account.

The sheet import (§5.4) produces the second kind directly and the first kind via share
claims matched to bank transactions. `shared.percent` on a transaction is editable; editing
re-derives both lines.

### 4.5 Payees and pre-fill

Import normalises a descriptor (trim, collapse whitespace, case-fold) and looks it up in
payee aliases. Hit: that payee. Miss: a new payee named from the descriptor, with the
descriptor as its first alias. A `new` transaction pre-fills its category from the payee's
derived last category (§3), or nothing. Renaming a payee never touches aliases, so the next
import still lands on it. Every view groups by payee, never by descriptor.

### 4.6 Cleared and new

`cleared` is per account side and set by imports (a bank row is cleared by definition) or by
hand. Manual transactions start uncleared. The ledger shows working balance and cleared
balance side by side; the difference is the gap-finding aid Ben uses.

`new` transactions appear in the review queue and in their ledger with a visible flag.
Confirming requires every line to have a category or a valid transfer. "Confirm all
pre-filled" confirms the ones whose category came from payee memory, listing them first.

### 4.7 Undo

Session-only undo, 12 deep, for every mutation (PB §2.12). Armed before the mutation.
Bulk actions (confirm all, import) undo as one entry. Armed confirm for anything touching
more than a handful of rows (PB §4 UX patterns).

## 5. Import

Every importer follows the same pipeline: parse the file into candidate rows → resolve each
candidate against existing data → write inside one transaction → report a summary
("42 in file: 30 already imported, 5 matched, 7 new"). Imports are idempotent: running the
same file twice changes nothing, and overlapping files (an end-of-month statement over a
mid-month one; a sheet re-export) add only what is missing.

Resolution order per candidate:

1. `externalId` already present on a transaction in this account → skip.
2. The matcher (§5.5) pairs it with an existing transaction lacking an `externalId` on this
   account side (a manual entry, or the far side of a transfer imported from the other
   account) → attach the id, mark that side cleared, skip creation.
3. Otherwise create a `new` transaction with payee resolution and category pre-fill.

### 5.1 YNAB export (one-time cutover)

Input: the Register and Plan CSVs from YNAB's "Export budget". Register columns: Account,
Flag, Date, Payee, Category Group/Category, Category Group, Category, Memo, Outflow, Inflow,
Cleared. Plan columns: Month, Category Group/Category, Category Group, Category, Assigned,
Activity, Available. Money cells are formatted strings (`$1,234.56`); parse to cents.

- Accounts: created from distinct names; Ben assigns `kind` and `onBudget` in the import
  screen before commit (defaults guessed from names are fine but personal, so the guesser
  stays generic). The person account is picked there.
- Groups and categories: created from the Plan file. YNAB's automatic credit-card-payment
  group has no meaning under §1 and is dropped; its assignments are discarded and its
  available folds into RTA by the identity in §4.2.
- Transactions: one row per register row, except:
  - split rows (memo prefixed `Split (i/n)`) fold into one transaction with `n` lines;
  - transfer rows (payee `Transfer : <Account>`) appear once per side in the export and
    collapse into one row, keeping the category from the on-budget side when the other side
    is off-budget;
  - `Inflow: Ready to Assign` maps to `rta`; `Starting Balance` rows are ordinary income.
  - `externalId` is a stable hash of the source row so a re-import is a no-op.
- Plan rows for months before `cutoverMonth` become `YnabHistory`; assignments for every
  month become `Assignment` rows (history charts want them); the cutover anchors follow §4.1.
- `cutoverMonth` is the month of the export.
- Verification before commit: per-account balances and per-category availability for the
  cutover month are recomputed from the imported rows and compared with the export's own
  numbers; any mismatch is shown to the penny and blocks commit until acknowledged.

### 5.2 OFX / QFX

The regex-based OFX 1.x SGML reader from `statement_reconcile.py`, ported to TypeScript
with integer cents: `STMTTRN` blocks, `DTPOSTED`, `TRNAMT`, `FITID`, `NAME`, `TRNTYPE`.
`FITID` is the `externalId`. The file's `LEDGERBAL` is shown in the summary as a cross-check
against the derived balance and never trusted (it can be stale).

### 5.3 CSV with column profiles

The first time a CSV with an unknown header signature is imported, the mapping screen asks
which columns are date, payee, memo, optional id, and either a signed amount column or
outflow/inflow columns, plus the date format, with a preview of the parsed first rows. The
answer is saved as a `CsvProfile` and applied automatically to every later file with the
same signature. Rows without an id column get `externalId = hash(date, amount, payee, memo,
row ordinal within identical rows)` so identical legitimate repeats survive and re-imports
dedupe.

### 5.4 Shared expense sheet

A CSV export of the current year's tab, imported through a dedicated adapter (the columns
are stable enough per year to be a built-in profile: date, amount each person paid, the
partner's percentage, merchant, category text). Rows before `cutoverMonth` and the
carry-over row are ignored; the person account's balance already comes from YNAB.

- Partner paid: a `new` transaction in the person account for Ben's share, payee from the
  merchant text, `externalId = hash(row)`.
- Ben paid: a `ShareClaim` (`total`, `percent`, date, merchant). Claims are matched against
  bank transactions in on-budget non-person accounts that have no `shared` yet, by the §5.5
  rules with the claim's total as the amount. A match applies §4.4 and marks the claim
  `applied`. Matching runs in both directions: on sheet import against existing
  transactions, and on every bank import against open claims. Open claims show in the
  review queue with a "pick the transaction" and a "dismiss" action.

### 5.5 Matcher

The algorithm from `statement_reconcile.py`, verified at 186/186 on real data:

1. Candidates require an **exact amount** match in cents.
2. Directional date window: `incoming.date − existing.date` within `[−2, +9]` days.
3. Rank by payee similarity (token overlap after case-folding, dropping tokens of two or
   fewer characters and a stopword list of province codes, city names and card-processor
   prefixes; fall back to a sequence-similarity ratio on the first 14 letters), tie-break on
   smaller lag; greedy assignment, each side used at most once.
4. Never dedupe on field equality; identical repeats are legitimate.

A pure function over two arrays, with golden tests built from synthetic fixtures.

## 6. Screens

Desktop layout, dark theme in magpie colours (near-black ground, white text, blue accents,
greys for structure). Keyboard-first where the user spends time.

- **Budget**: month navigation; Ready to Assign header with the uncategorised total when
  non-zero; groups collapsible; per category: goal, assigned (editable, with a fill-to-goal
  button), activity, available, and the three stats (all-time monthly average from first
  activity, trailing 12 complete months, last month). Move money from any available cell.
- **Accounts / Ledger**: account list with working and cleared balances; ledger per account
  with transfers shown on both sides; inline edit; add manual transaction; split editor;
  shared-percent editor.
- **Review**: every `new` transaction across accounts plus open share claims; arrow keys,
  category picker with payee pre-fill, confirm, confirm-all-pre-filled.
- **Import**: drop a file; format detection (OFX by content, YNAB by header, sheet by
  header, otherwise CSV profile flow); preview and summary; commit.
- **Payees**: rename, merge, see aliases and history.
- **Settings**: JSON export/import of the whole dataset (the safety net before sync exists),
  sync setup with the honest privacy paragraph, storage persistence status, version.

## 7. Sync and deploy

Phase 5. The OC engine against a private `magpie-data` repo via the Contents API (PB §2.6),
sharded from the first push: `meta.json` `{ schema }`, `active.json` (accounts, groups,
categories, payees, profiles, claims, settings), `assignments.json`, `history.json`
(`YnabHistory`, static), `tx-<year>.json`. Measure the median edit payload on real data;
hash-split a year into four files if it exceeds roughly 250 KB. Schema gate, `sameAs`
enumerating every field, round-trip test with every field populated (PB §2.6).

The app repo becomes public at that point for GitHub Pages; CI per PB §2.1. Until then the
app runs from `npm run preview` on the machine in use and the JSON export is the backup.

## 8. Testing

- Domain: near-100% unit coverage. Property tests: conservation (moving money, confirming a
  `new` transaction, and re-splitting a shared transaction never change
  `RTA + Σ available + uncategorised`); availability rollover with negatives; rounding of
  shares sums exactly; matcher goldens; parser fixtures (synthetic OFX, synthetic YNAB
  export, synthetic sheet); import idempotency (same file twice is a no-op; overlapping
  files add only the difference).
- e2e: budget screen renders from a seeded dataset; review flow confirms and clears the flag;
  import of a synthetic file end to end; move money; undo.
- Gates before every commit: `npm run check` → `npx vitest run` → `npx playwright test`
  (PB §2.14). Real files in `private/` may drive local-only verification scripts that also
  live in `private/`; nothing derived from them enters the repo.

## 9. Phases

Each phase ends with gates green, a commit pushed, and the memory file updated.

1. Scaffold, storage, store, undo, money and budget-math domain with tests, a budget screen
   over seed data.
2. YNAB import with the cutover verification, the real budget screen, JSON export/import.
3. Ledgers, review queue, manual entry, splits, move money, goal fill, stats, payees.
4. OFX import, CSV profiles, matcher, sheet import, share claims, person-account flows.
5. Sync, CI, Pages deploy; repo goes public after Ben re-reads `CLAUDE.md`.
6. Charts; loan and asset tools (§10).

## 10. Later, with what is already known

- **Loans**: `loan` accounts with an effective-dated interest rate and a standard payment.
  A loan whose statements are imported (the mortgage) takes interest from the file; a loan
  with no file (a family loan) gets a generated monthly interest transaction with a
  deterministic id. Wanted: a repayment chart, estimated payoff date at the standard
  payment, and a what-if for a yearly lump sum showing time saved.
- **Assets**: `investment` and other tracking accounts hold only a CAD total, never
  holdings. A "set balance" action writes the drift as a transaction with a designated
  payee and a reporting-only category (Ben's YNAB habit: payee "The Ether", category
  "Investment Income"), so investment gains over time are a category report while the
  budget never sees them. Imported statements may replace the manual step later.
- **Charts**: spending by category over time, assigned vs spent, net worth; the stats
  columns in §6 are the seed.
- **Live sheet link**: read the shared sheet directly instead of a CSV export.
- **Mobile helper view**: a read-mostly companion once sync exists.

## 11. Out of scope

Bank connections; multi-user; multi-currency; native apps; statement checkpoints (may return
if cleared state proves insufficient); YNAB's credit-card-payment model; goal types beyond a
monthly amount.
