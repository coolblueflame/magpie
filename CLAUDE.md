# Magpie — Project Context

## What this is

**Magpie** is a local-first personal budgeting web app: categories with monthly goals,
balances that roll forward every month including negative ones, transactions imported from
statement files, sync to a private GitHub repository. It grew out of dissatisfaction with
YNAB's philosophy and its transaction matching; the one rule that most defines it is that
category balances carry forward and are never reset or forgiven. The name is the bird that
supposedly hoards shiny things.

## Read this first

`docs/PLAYBOOK.md` is the architecture handoff from the previous project ("Organized Chaos",
same local-first / no-hosting shape). It is the recipe this app is built from: stack and
pinned versions, layer rules, row and merge conventions, the private-GitHub-repo-as-backend
sync design, and a lesson bank where every entry cost a real debugging round. Grep it before
debugging anything that smells familiar. Where the playbook and running code disagree, the
code wins and the playbook is stale.

The Organized Chaos repo lives beside this one (`../organizedchaos`, read-only; copy, never
modify). `src/lib/sync/` was copied from it.

`private/` is gitignored. It holds the owner's real exports and `private/NOTES.md`, the
personal specifics behind everything generic in this file (institutions, the shared sheet's
layout, anecdotes). Read it when doing import work; never quote it into the repo.

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
- `private/`: real files and `verify-*.ts` scripts that run the domain code against them
  headlessly (`npx vite-node private/verify-ynab.ts <Register.csv> <Plan.csv>`).

## Product rules (decided; the spec carries the detail)

- Desktop-first UI. A private GitHub data repo is the cloud source of truth; a mobile helper
  view may come later, so the data model must not assume one device.
- Money is integer cents; balances derive from rows; nothing stored is a running total.
- No provider auto-import or bank sync, ever. Files only. This is a privacy choice and a
  simplification, not a missing feature.
- Category balances roll forward including negatives. Ready to Assign is one global pool.
  The monthly goal fills on a click (one category or all, each to its own goal), never
  automatically, so future months can be partly funded without going negative.
- Stats on the budget row: all-time monthly average, trailing 12 complete months, last month.
- Credit cards are ordinary accounts that go negative. No card-specific tooling.
- Transactions enter almost only by file import; re-importing overlapping files is normal, so
  import is idempotent and matching is core. No formal statement reconciliation; cleared and
  uncleared exist as a gap-finding aid. Months before the YNAB cutover are read-only history.
- Payees are entities: many raw descriptors map to one payee; every view groups by payee.
- Shared expenses: the partner is an on-budget "person" account; a percentage split per row;
  share claims from the sheet export match bank rows. The general rule (both people may have
  paid part) is in spec §4.4.
- Investment accounts track a CAD total only; the drift is a transaction with a designated
  payee and a reporting-only category. Loans carry terms; loans without statements get
  generated monthly interest (spec §4.8).
- Nothing personal in the public repo: institution names, card products, merchants, the
  partner's name, real amounts and account digits stay in `private/`. Import adapters are
  keyed by format (OFX/QFX; CSV column profiles stored as user data), never by institution.
  Test fixtures are synthetic.
- Assumed: CAD only; calendar months.

## Domain knowledge from a real reconciliation session (2026)

Observed in real Canadian bank QFX exports and a multi-hour forensic reconciliation. Bake
them into the design; do not rediscover them.

### QFX/OFX parsing

- Big-bank QFX is OFX 1.x SGML: headers, then unclosed tags. Regex extraction of
  `<STMTTRN>...</STMTTRN>` blocks works fine; don't reach for an XML parser.
- Fields per transaction: `TRNTYPE`, `DTPOSTED`, `TRNAMT` (negative = charge, positive =
  payment/credit), `FITID` (the bank's unique id; persist it, it is the dedup key across
  repeated imports), `NAME` (merchant descriptor; some banks put it in `MEMO` instead).
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
6. A row imported from YNAB carries a `ynab:` id for traceability only; it is still a valid
   match target for a bank row (measured: 26 of 38 card rows link to history).

### Reconciliation lessons (checkpoints deliberately not built)

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

## Working agreements

- Claude owns the architecture; ask the owner product questions, not design questions.
- Commit and push to `main` at will; no PRs. No environment changes and nothing outside this
  project folder without asking first (installs, global config, other repos).
- Keep the test suite real; the playbook's gate discipline applies. New rules agreed in
  conversation go into this file, not only into memory.
- Work in small chunks that can be resumed cold: keep the project memory file current,
  commit finished pieces, write the next step down before a chunk ends.
- Stage files by name, never `git add -A`. The repo is public; `private/` never enters
  history.

## Build discipline

`npm run dev` serves `http://localhost:5173/magpie/`. Settings → Load sample data seeds an
empty database (the e2e specs set `localStorage['magpie:seed']='1'` before boot instead);
`#/import` takes a YNAB export into an empty database. Real files live in `private/`; to
check the importer against them without the UI: `npx vite-node private/verify-ynab.ts <Register.csv> <Plan.csv>`.

- Gates before every commit, in order: `npm run check` → `npx vitest run` →
  `npx playwright test`. Re-run from the top after the last edit; vitest does not typecheck
  what svelte-check does. Never claim "full gates" otherwise. Gate a commit on the commands'
  exit codes, not on grepping their output.
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
- `@playwright/test` is pinned exact to match the chromium build already in
  `~/Library/Caches/ms-playwright`; bumping it means a browser download outside the project,
  which needs the owner's go-ahead.

Deploy: `.github/workflows/deploy.yml` runs check → vitest → chromium e2e → build → GitHub
Pages on every push to `main` (Pages must be enabled with source "GitHub Actions"). Sync:
Settings → Sync connects a private data repo via a fine-grained PAT (`docs/BEN-PAT-SETUP.md`);
the token lives in the `device` table only. e2e blocks service workers so route stubs work;
nothing tests offline behaviour.

## Working style

- Direct, technically precise. Flag gotchas proactively.
- Prefer finishing a small correct thing over starting a clever big thing.
- When stated numbers disagree with computed ones, say so plainly; verify inputs before
  building theories on them.
- No em dashes in user-facing copy.
