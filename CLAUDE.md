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

## The brief (Ben, 2026-09-04)

Ben's own words, condensed. A design spec under `docs/superpowers/specs/` supersedes this once
it exists; until then this is the feature list.

Very similar to YNAB, with different month-to-month rollover and room for extra tools.

1. Import all of Ben's YNAB history.
2. Categories, each with its own monthly budget; every purchase classifies to one.
3. Totals flow month to month **including negative balances**: blow a category's budget and
   the hole carries forward, so the usual monthly amount digs you out (or you have less next
   month). No YNAB-style overspending reset.
4. Each category remembers a usual monthly amount that can be assigned in one click and
   edited afterwards.
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

Door left open for: charts and visualisation, loan tracking, asset values.

Visual: lean into magpie colours. Dark background, blues, whites, greys.

## Decisions (2026-09-04, from Ben; the spec carries the detail)

- **Desktop-only UI.** No phone layout work. A private GitHub data repo is the cloud source of
  truth (the OC model), and a mobile-friendly helper view may come later, so the sync layer
  and data model must not assume a single device.
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
- **"Usual amount" fills on a button click** (per category and for a whole month), never
  automatically, so future months can be partially assigned without going negative.
- **Spending stats live on the budget screen** per category: all-time average, trailing
  12-month average, last month's spend.
- **Shared expenses with a partner are first-class:** a percentage split per transaction and
  a running receivable between the two people. The shared-sheet import is the register side
  of the matcher.
- **Investment, mortgage and crypto accounts are off-budget tracking accounts** in v1; loan
  and asset tools come later.
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

`statement_reconcile.py` is the cleaned-up parser + matcher from that session: working QFX
parsing and the matching algorithm above. Treat it as the spec-by-example for import
behaviour. It uses floats with a half-cent epsilon because it was an analysis script; port
its *algorithm*, never its arithmetic. Money in the app is integer cents.

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

None of these commands exist here yet; they are the target from `docs/PLAYBOOK.md` §2.1 /
§2.14 and the shape to scaffold toward. Update this section the moment the scaffold lands.

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

## Working style

- Direct, technically precise. Flag gotchas proactively.
- Prefer finishing a small correct thing over starting a clever big thing.
- When Ben's stated numbers disagree with computed ones, say so plainly; verify inputs
  before building theories on them.
