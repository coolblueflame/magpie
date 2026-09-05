# Magpie — Project Context

## What this is

**Magpie** — a lightweight personal budgeting app to replace YNAB. Owner: Ben. Built because
YNAB's philosophy doesn't fit how he budgets, its price keeps climbing, and its transaction
matching creates duplicates on bank-file import. Dramatically simpler than YNAB, and simpler
than the todo app built before it.

The name: a magpie's reputation for hoarding shiny things (mythical, as it turns out; a 2014
University of Exeter study found no evidence magpies are drawn to shiny objects) fits an app
about squirreling away money. Key differentiator from YNAB: budgets roll forward cleanly into
future months, including negative balances, building a continuous history of spending over
time. That continuity is the app's link to "Throughline", an earlier name that didn't survive
a trademark check.

Easter egg idea, not the app name: work "to the moon" into a clean reconciliation message or a
savings-growth chart somewhere.

## Read this first

`docs/PLAYBOOK.md` is the architecture handoff from the previous project ("Organized Chaos",
284 commits over 39 days, same local-first / no-hosting shape). It is the recipe this app is
built from: stack and pinned versions, layer rules, row and merge conventions, the
private-GitHub-repo-as-backend sync design, and a lesson bank where every entry cost a real
debugging round. Read it fully before scaffolding anything; grep it before debugging anything
that smells familiar. Section 5 maps the recipe onto a budgeting app; section 6 is the
day-one checklist.

The Organized Chaos repo itself is at `/Users/ben/Noodlevault/organizedchaos` (read-only from
here; copy, never modify). Its `vite.config.ts`, `playwright.config.ts`, `tsconfig.json`,
`src/lib/storage`, `src/lib/sync`, `src/lib/state` and `.github/workflows/deploy.yml` are the
files the playbook says to copy and trim.

Where the playbook and running code disagree, the code wins and the playbook is stale.

`private/` is gitignored. It holds Ben's real exports and `private/NOTES.md`, the personal
specifics behind everything generic in this file (institutions, the shared sheet's layout,
anecdotes). Read it when doing import work; never quote it into the repo.

## Where things live

- `docs/superpowers/specs/2026-09-04-magpie-design.md` is the design; the plans beside it
  record how each phase was built. Phases 1 to 6 are done: budget, accounts and ledgers,
  review queue, payees, YNAB cutover import, statement and CSV and shared-sheet import with
  matching and share claims, sync to a private GitHub repo, PWA and CI deploy, loans, charts.
- `src/lib/domain/`: pure rules, one `.test.ts` beside each file. Start with `budget.ts`
  (availability and Ready to Assign), `ledger.ts` (transfer rules, balances), `importPlan.ts`
  (skip / match / create), `ynab.ts` (the cutover builder), `sheet.ts` and `shares.ts`.
- `src/lib/storage/repo.ts` is the only Dexie caller; `src/lib/state/app.svelte.ts` is the
  one store (`commitEdits` is the undoable multi-table batch every mutation goes through);
  `src/lib/sync/` is the engine copied from Organized Chaos.
- `src/lib/ui/`: one `.svelte` per screen plus `charts/`; `router.svelte.ts` lists routes.
- `e2e/`: one spec per feature area, run against the production build with the seed dataset
  (`src/lib/domain/seed.ts`) or the synthetic YNAB fixture.
- `private/`: Ben's real files and `verify-*.ts` scripts that run the domain code against them
  headlessly (`npx vite-node private/verify-ynab.ts <Register.csv> <Plan.csv>`).

## The brief (Ben, 2026-09-04)

Ben's own words, condensed. `docs/superpowers/specs/2026-09-04-magpie-design.md` is the
approved design and wins wherever the two differ.

Very similar to YNAB, with different month-to-month rollover and room for extra tools.

1. Import all of Ben's YNAB history.
2. Categories, each with its own monthly budget; every purchase classifies to one.
3. Totals flow month to month **including negative balances**: blow a category's budget and
   the hole carries forward, so the usual monthly amount digs you out (or you have less next
   month). No YNAB-style overspending reset.
4. Each category remembers a **monthly goal** that can be assigned in one click and edited
   afterwards. Categories sit in groups, as in YNAB.
5. Move money between categories in one step ("some of X's budget into Y this month").
6. Import statements from a file: QFX from banks and cards, plus a spreadsheet export from a
   shared expense tracker. Never a live bank connection.
7. Payee + category per transaction, optional note. A payee's next transaction pre-fills the
   category from that payee's last one.
8. Split a transaction across categories.
9. Income lands in a prominent **Ready to Assign** pool that decrements as money is assigned.
10. Multiple accounts, each with its own ledger of imported transactions; all drain the budget.
11. Bulk-imported transactions carry a **new** flag that needs an action before it clears, so
    every row gets a category and a look before moving on.

Door left open for: charts and visualisation, loan tracking (repayment chart, payoff
estimate, lump-sum what-if, editable interest rate), asset values, reading the shared sheet
live instead of via export, a mobile helper view.

Visual: lean into magpie colours. Dark background, blues, whites, greys.

## Decisions (2026-09-04, from Ben; the spec carries the detail)

- **Desktop-only UI, used mainly on Windows.** No phone layout work. One device until sync
  exists. A private GitHub data repo is the cloud source of truth (the OC model), and a
  mobile-friendly helper view may come later, so the data model must not assume one device.
- **YNAB cutover:** import the full history for reporting; each category starts at YNAB's
  Available as of the export.
- **Transactions enter almost only by file import.** Hand entry exists for cash purchases and
  rare adjustments. Re-importing a file that overlaps earlier imports is normal (end-of-month
  statements, the shared sheet), so import must be idempotent and matching is a v1 feature.
  Nobody enters a transaction on a phone to be matched later.
- **No formal statement reconciliation.** Cleared/uncleared exists per transaction as a
  gap-finding aid. A month is "done" when every transaction is categorised and the money
  moved; nothing enforces it.
- **Credit cards are ordinary accounts** that go negative. No card-specific tooling.
- **Payees are entities.** Many raw import descriptors map to one payee; rename or merge once,
  and every view (search, history, stats) groups by the payee, never the descriptor.
- **The monthly goal fills on a button click,** per category or all categories at once (each
  to its own goal), never automatically, so future months can be partially assigned without
  going negative.
- **Spending stats live on the budget screen** per category: all-time average, trailing
  12-month average, last month's spend.
- **Shared expenses with a partner are first-class:** the partner is an on-budget "person"
  account (imported from its YNAB account, balance and history intact), a percentage split
  per transaction, and share claims from the sheet export matched to bank rows.
- **Investment accounts track a CAD total only;** the drift is a transaction to a designated
  payee with a reporting-only category so gains show up in reports, never in the budget.
- **Investment, mortgage and crypto accounts are off-budget tracking accounts** in v1. Loan
  tools come later with a concrete brief (spec §10): the mortgage's interest arrives in its
  statements; a family loan needs generated monthly interest at an agreed, editable rate.
- **Nothing personal in the repo.** Institution names, card products, merchants, the
  partner's name, real amounts and account digits stay in `private/`. Import adapters are
  keyed by format (OFX/QFX; CSV column profiles stored as user data), never by institution.
- **Push to `origin/main` at will;** no PRs, no code review.
- Assumed without asking: CAD only; calendar months; Ready to Assign is one global pool.

## Hard constraints

- **No provider auto-import / bank sync. Ever.** Ben downloads statement files and feeds them
  in by hand. This is a deliberate simplification and a privacy choice, not a missing feature.
- Local-first: the app runs entirely in the browser against IndexedDB; the only network
  destination is the private data repo on `api.github.com`.
- Single user. No accounts, no sharing, no server.

## Domain knowledge from a real reconciliation session (2026)

Observed in real Canadian bank QFX exports and a multi-hour forensic reconciliation. Bake
them into the design; do not rediscover them.

### QFX/OFX parsing

- Big-bank QFX is OFX 1.x SGML: headers, then unclosed tags. Regex extraction of
  `<STMTTRN>...</STMTTRN>` blocks works fine; don't reach for an XML parser.
- Fields per transaction: `TRNTYPE`, `DTPOSTED`, `TRNAMT` (negative = charge, positive =
  payment/credit), `FITID` (the bank's unique id; persist it, it is the dedup key across
  repeated imports), `NAME` (merchant descriptor).
- **`<LEDGERBAL>` can be stale.** Files have shipped whose transaction list includes a charge
  the ledger balance doesn't yet reflect (same-day authorisation). Never treat the file's
  balance as ground truth; derive balances from transactions and surface any mismatch
  instead of silently trusting either number.
- The download feed, the web portal's posted list, and the portal's pending list are three
  pipelines with different lag. A transaction can appear in the QFX while absent from the
  portal entirely.

### Matching imported transactions to existing register entries

This algorithm beat YNAB's matcher on real data (186/186 correct, zero false pairs):

1. Candidate pairs require **exact amount match** (to the cent).
2. Date window is **directional**: register (transaction) date is 0–4 days *before* the
   file's posting date typically; allow roughly −2..+9 days for safety.
3. Rank candidates by **payee-name similarity**: token overlap after lowercasing, stripping
   short tokens and stopwords (city names, "SQ", "TST-", province codes), falling back to a
   sequence-similarity ratio on normalised prefixes. Greedy-assign highest similarity first,
   each side matched at most once.
4. A dozen-plus identical small charges on one day are legitimate; dedup on `FITID`, never on
   (date, amount, payee) alone.
5. Anything unmatched after this is a genuinely new transaction: import it.

### Reconciliation lessons (checkpoints deferred by Ben's decision)

- Cleared balance and working balance are different numbers; both must be visible.
- Sub-dollar drift can survive months of eyeballing; a to-the-penny check per statement
  period catches it the month it appears. Cleared state and per-period sums keep this cheap
  to add later.
- The two-date model from OFX (transaction date vs posting date) survives into the data model.
- When balances disagree, show the *math*: which side, which period, what residual.
  Transposition errors are divisible by 9; worth a hint in any mismatch UI.

## Reference code

`statement_reconcile.py` is the cleaned-up parser + matcher from that session; its algorithm
is ported to `src/lib/domain/ofx.ts` and `matcher.ts` with integer cents. It stays as the
spec-by-example for import behaviour; the TypeScript is what runs.

## Working agreements (this project; override the global CLAUDE.md where they conflict)

- Ben is not reviewing code or making architectural decisions here. Claude owns the
  architecture; ask Ben product questions, not design questions.
- Commit at will. No environment changes and nothing outside this project folder without
  asking first (installs, global config, other repos).
- Keep a real test suite and be diligent; the playbook's gate discipline applies.
- New rules agreed in conversation go into this file, not only into memory.
- Ben's Claude usage is tightly limited, especially early on. Work in small chunks that can be
  resumed cold: keep the project memory file current, commit finished pieces, and write the
  next step down before a chunk ends.
- Ben has not read `docs/PLAYBOOK.md`, `statement_reconcile.py`, or the domain-knowledge
  section above; other Claude sessions produced them from conversations with him. Their
  constraints are strong signals, not confirmed decisions. Ask when one would change what
  gets built.
- Stage files by name, never `git add -A`. The repo will be public; `private/` never enters
  history.

## Build discipline

`npm run dev` serves `http://localhost:5173/magpie/`. Settings → Load sample data seeds an
empty database (the e2e specs set `localStorage['magpie:seed']='1'` before boot instead);
`#/import` takes a YNAB export into an empty database. Real files live in `private/`; to
check the importer against them without the UI: `npx vite-node private/verify-ynab.ts <Register.csv> <Plan.csv>`.
`@playwright/test` is pinned exact to match the chromium build already in
`~/Library/Caches/ms-playwright`; bumping it means a browser download outside the project,
which needs Ben's go-ahead.

Deploy: `.github/workflows/deploy.yml` runs check → vitest → chromium e2e → build → GitHub
Pages on every push to `main` (Pages must be enabled with source "GitHub Actions", and the
repo public or on a plan that serves private Pages). Sync: Settings → Sync connects a private
data repo via a fine-grained PAT (`docs/BEN-PAT-SETUP.md`); the token lives in the `device`
table only. e2e blocks service workers so route stubs work; nothing tests offline behaviour.

- Gates before every commit, in order: `npm run check` → `npx vitest run` →
  `npx playwright test`. Re-run from the top after the last edit; vitest does not typecheck
  what svelte-check does. Never claim "full gates" otherwise.
- e2e runs against the production build (`npm run build && npm run preview` under the
  Playwright `webServer`); rebuild after source edits mid-session or the run tests stale code.
- One unit file: `npx vitest run <path>.test.ts`; one case: add `-t "<name>"`.
  One e2e spec: `npx playwright test e2e/<name>.spec.ts`; one browser: `--project=chromium`.
- Fixes ship with teeth: the test is shown to fail without the fix and pass with it. Pair
  every "does not happen" assertion with a "does happen" one.
- Verify CI by full SHA (`git rev-parse`, never a SHA from memory) and the deployed bundle by
  grepping a literal chunk of the change.
- Domain layer (`src/lib/domain/`) is pure functions over plain data, every file with a
  `.test.ts` beside it. Screens call the store; the store calls domain functions and the
  repo; nothing else touches Dexie.
- Measure on the real files before theorising about import behaviour: the `private/verify-*`
  scripts exist for that, and every import rule so far was corrected by one of them.
- Reviews run as bounded workflows (a few dimension reviewers, one skeptic per batch), and
  findings are fixed by root cause, never by patching each symptom.

## Working style

- Direct, technically precise. Flag gotchas proactively.
- Prefer finishing a small correct thing over starting a clever big thing.
- When Ben's stated numbers disagree with computed ones, say so plainly; verify inputs
  before building theories on them.
