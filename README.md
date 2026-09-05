# Magpie

Magpie is a personal budgeting app that runs entirely in your browser. You give every dollar
a category, the categories carry their balances from month to month, and the transactions
come from statement files you download from your bank yourself. There is no server, no bank
connection and no account: the data lives in your browser and syncs, if you want it to, to a
private GitHub repository you own.

## What it does

**Budget**
- Categories in groups, each with a monthly goal. Ready to Assign shows what is not yet
  given a job.
- Balances roll forward every month, including negative ones. Overspend a category and the
  hole carries into next month until you dig out; nothing is reset or forgiven.
- Fill a category to its goal in one click, or fill every category at once (each to its own
  goal, with the total shown before it commits). Move money between categories, or to and
  from Ready to Assign, from the cell itself.
- Suggested goals from your own assignment history, and per-category stats on the same row:
  all-time monthly average, trailing twelve months, last month.
- Undo for everything, twelve deep.

**Accounts and ledgers**
- Chequing, savings, credit cards, cash, tracking accounts (investments, loans) and "person"
  accounts for money owed between you and someone else.
- A transfer is one row shown in both ledgers. Splits across categories. Cleared and
  uncleared balances side by side. A running balance on every row.
- Imported rows arrive flagged as new and wait in a Review queue until you have looked at
  them. The category pre-fills from the payee's last transaction, and a statement descriptor
  that matches no payee yet offers its likely twin ("Same as Grocer?"), recording the alias
  when you accept.

**Imports** (files only, never a live connection)
- OFX/QFX statements. Rows already imported are skipped by the bank's own id; rows you
  entered by hand, or the other side of a transfer imported from the other account, are
  matched by exact amount, a directional date window and payee similarity; the rest are new.
  Re-importing a file, or an end-of-month statement that overlaps a mid-month one, adds only
  what is missing.
- Any CSV, through a column mapping you set up once per layout and never see again.
- A YNAB "Export budget" as a one-time cutover: accounts, categories, payees, the full
  transaction history with splits and transfers folded correctly, months of history shown as
  YNAB had them, and a verification to the penny before anything is written.
- A shared-expense sheet (two people, a percentage split per row): rows you paid become
  claims that match your bank rows and split them between your category and the other
  person's account; rows they paid become your share in that account.

**And**
- Payees: rename, merge, aliases, usage counts.
- Loans: terms per loan, generated monthly interest for loans without statements, payoff
  projection at the standard payment, a lump-sum what-if, and a balance chart.
- Balance adjustments for investment accounts, with an optional reporting-only category so
  gains show in reports without touching the budget.
- Charts: net worth, income and spending by month, one category's spending against its
  average and goal, investment income. Every chart has a table view.
- Sync through the GitHub Contents API to a private repository, with the repository's
  commit history as a point-in-time backup. A JSON export for when you would rather not.
- Installable as a web app. Dark, magpie-coloured, desktop-first.

## Privacy, plainly

Everything stays on your machine unless you connect sync. With sync on, the only network
destination is api.github.com; GitHub can read a private repository; git history keeps
everything ever synced, including deleted rows; the token is stored unencrypted on the
device and never synced or exported. Keep the data repository private.

## Run it

```
npm install
npm run dev        # http://localhost:5173/magpie/
```

Settings has a "Load sample data" button to look around. To start from a YNAB budget, use
the Import screen; otherwise add accounts and categories and import your first statement.
Sync setup is in Settings, and the steps to mint a token are in `docs/BEN-PAT-SETUP.md`.

## Develop

```
npm run check        # svelte-check
npx vitest run       # unit tests (the domain layer is close to fully covered)
npx playwright test  # end-to-end against the production build
```

Svelte 5, TypeScript, Vite, Dexie (IndexedDB), Playwright. Money is integer cents
everywhere; balances are derived from rows, never stored. The design spec and per-phase
plans are under `docs/superpowers/`; `docs/PLAYBOOK.md` is the engineering handoff the
architecture follows.

Single currency, desktop browsers, one user per data repository. Early software: back up
before you trust it with the only copy of anything.
