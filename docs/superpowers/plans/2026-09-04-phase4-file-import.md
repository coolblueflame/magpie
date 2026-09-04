# Phase 4: File Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import bank and card statements (OFX/QFX), arbitrary CSVs through saved column profiles, and the shared-expense sheet, through one pipeline: skip what is already known, match what was entered or imported from the other side, create the rest as `new`; apply share claims to the matching card rows; all as one undoable batch per file.

**Architecture:** Pure adapters turn a file into `ImportCandidate[]` (`domain/ofx.ts`, `domain/csvImport.ts`, `domain/sheet.ts`); `domain/matcher.ts` is the proven pairing algorithm; `domain/importPlan.ts` resolves candidates against existing rows into an `ImportPlan` of edits plus a summary; the store applies a plan with `commitEdits`. The import screen becomes a format-detecting driver over those pieces.

**Spec:** §5 (pipeline), §5.2 OFX, §5.3 CSV profiles, §5.4 sheet, §5.5 matcher, §4.4 shared expenses, §6 Import and Review. Real-file shapes are in `private/NOTES.md`; fixtures mirror them synthetically.

## Global Constraints

As before. Plus: the bank account identifier from a statement is hashed with `fnv1a` and never stored or shown; partner names are never in code (the sheet header is detected structurally); a file import is one undo entry.

---

### Task 1: OFX parser (`domain/ofx.ts`, `ofxFixture.ts`)

```ts
export interface OfxTxn { date: IsoDate; amount: Cents; fitid: string; name: string; memo: string; trntype: string; descriptor: string }
export interface OfxStatement { transactions: OfxTxn[]; ledgerBalance?: Cents; ledgerDate?: IsoDate; accountRef?: string; accountType?: string; currency?: string; start?: IsoDate; end?: IsoDate }
export function isOfx(text: string): boolean                 // OFXHEADER line or an <OFX> tag
export function ofxCharset(head: string): string             // 'windows-1252' for CHARSET:1252, 'utf-8' otherwise
export function decodeOfx(bytes: ArrayBuffer): string        // TextDecoder with the sniffed charset
export function parseOfx(text: string): OfxStatement         // regex over <STMTTRN>…</STMTTRN>; descriptor = NAME || MEMO || TRNTYPE; dates = first 8 digits; accountRef = fnv1a(BANKID|ACCTID)
```
- [ ] Fixture: two synthetic statements (a card `CCSTMTRS` with LF and `[-4:EDT]` dates; a bank `STMTRS` with CRLF, `.000[-6:CST]` dates, `ACCTTYPE`, an `INT` row with only `MEMO`). Tests: counts, amounts in cents, descriptor fallback, ledger balance and date, accountRef is 8 hex and differs between fixtures, `isOfx` on CSV text is false, charset sniffing.
- [ ] Commit.

### Task 2: Matcher (`domain/matcher.ts`)

```ts
export interface MatchCandidate { id: string; date: IsoDate; amount: Cents; name: string }
export interface MatchPair { incomingId: string; existingId: string; similarity: number; lag: number }
export function similarity(a: string, b: string): number     // token overlap → 1; else Ratcliff/Obershelp on the first 14 letters
export function matchTransactions(incoming, existing, opts?: { minLag?: number; maxLag?: number }): { pairs: MatchPair[]; unmatchedIncoming: string[]; unmatchedExisting: string[] }
```
- [ ] Tests: amount must be exact; window −2..+9 directional; higher similarity wins a contested register row; identical repeats pair one-to-one; ties broken by smaller |lag|; unmatched lists.
- [ ] Commit.

### Task 3: Import plan (`domain/importPlan.ts`) and store application

```ts
export interface ImportCandidate { externalId: string; date: IsoDate; amount: Cents; descriptor: string; memo: string; source: TxSource }
export interface ImportPlan {
  accountId: string;
  skipped: number;
  matched: { candidate: ImportCandidate; txId: string; side: 'own' | 'far'; lineIndex?: number }[];
  created: ImportCandidate[];
  payeesToCreate: { id: string; name: string; alias: string }[];
  edits: Edit[];                       // everything, ready for commitEdits
  summary: string;                     // "42 in file: 30 already imported, 5 matched, 7 new"
}
export function planImport(candidates: ImportCandidate[], accountId: string, state: { transactions; payees; accountsById }, ids: () => string): ImportPlan
```
Resolution per candidate (spec §5): externalId already on this account (own `externalId`, or a far line's `farExternalId` for this account) → skipped; else matcher against this account's ledger rows without an id on this side (amount = ledger view) → patch (`externalId` + `cleared` on own rows; `farExternalId` + `farCleared` on far lines); else create `new` with payee by alias (`normalisePayeeKey(descriptor)` against names and aliases; else a new payee named with the descriptor and that key as its alias).
Store: `applyImport(plan): Promise<void>` → `commitEdits(plan.edits, 'import N rows')`; `rememberAccountRef(accountId, ref)`.
- [ ] Tests on the seed: a candidate whose externalId is already stored is skipped; one matching a manual row attaches the id and clears it; one matching the far side of a transfer patches the line; one new row creates a payee once and reuses it for a second candidate with the same descriptor; re-running the same plan's candidates after apply yields all skipped (idempotent).
- [ ] Commit.

### Task 4: CSV profiles (`domain/csvImport.ts`)

```ts
export function headerSignature(header: string[]): string
export function detectDateFormat(samples: string[]): string | null        // 'YYYY-MM-DD' | 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'MMM D, YYYY'
export function parseDateWith(format: string, s: string): IsoDate | null
export function candidatesFromCsv(rows: Record<string, string>[], profile: CsvProfile, batchId: string): ImportCandidate[]
//   externalId = profile.mapping.id ? `csv:${value}` : `csv:${fnv1a(date|amount|payee|memo)}:${ordinal among identical rows}`
```
- [ ] Tests: each date format; signed vs outflow/inflow vs negate; ordinal ids for identical rows; missing columns throw with the column name.
- [ ] Commit.

### Task 5: Sheet import and share claims (`domain/sheet.ts`, `domain/shares.ts`)

```ts
// sheet.ts
export function isSheetHeader(header: string[]): { paidColumns: [number, number]; percentColumn: number } | null   // two headers ending in " Paid" then one ending in "%"
export interface SheetRow { key: string; date: IsoDate; mine: Cents; theirs: Cents; percent: number; where: string; what: string }
export function parseSheet(rows: string[][], mineFirst: boolean): SheetRow[]   // rows with a date only; carry-over rows skipped; dates 'MMM D, YYYY' or ISO
// shares.ts
export function shareSplit(total: Cents, percent: number): { mine: Cents; theirs: Cents }        // theirs = roundHalfAway(total × p / 100)
export function sharedLines(amount: Cents /* the bank row, negative */, total: Cents, percent: number, categoryId: string | undefined, personAccountId: string): Line[]
//   [{ categoryId?, amount: −(T − S) }, { transferAccountId: person, amount: −(X − (T − S)) }] with X = −amount; drops a zero transfer line
export function planSheet(rows: SheetRow[], settings: { mineFirst; personAccountId }, state, ids): { claims: ShareClaim[]; partnerPaid: ImportCandidate[] /* into the person account, amount −(T − S) */; edits: Edit[] }
export function planClaims(openClaims: ShareClaim[], transactions: Transaction[], accountsById, personAccountId): { applied: { claimId; txId }[]; edits: Edit[] }
//   candidates: on-budget, non-person, single-line, no `shared`, amount = −paid; matcher with the claim description
```
- [ ] Tests: split rounding sums exactly; the general rule with X < share, X = T, p = 0, p = 100; parseSheet skips formula-only rows and carry-over; header detection is structural (fixture headers use placeholder names); planClaims matches and produces the two lines plus `shared`.
- [ ] Commit.

### Task 6: Screens and e2e

- Import screen: one file input (multiple allowed) → per file: detect OFX (bytes → decode → `isOfx`), YNAB (header), sheet (header), else CSV. OFX/CSV: an account select preselected by `externalRef` / profile; preview table of candidates with their resolution (`skip` / `match` / `new`), the LEDGERBAL cross-check line, `commit-import`. CSV first time: the mapping form (`map-date`, `map-payee`, `map-memo`, `map-id`, `map-mode`, `map-amount` / `map-outflow` / `map-inflow`, `map-dateformat`), saved as a profile on commit. Sheet first time: `sheet-mine` radio (which Paid column is you) and `sheet-person` select, saved to settings; preview shows claims matched now, partner-paid rows to create, claims left open.
- Review screen: a "Share claims" section listing open claims (`claim-<id>`: date, description, paid, percent) with `claim-pick-<id>` (candidate transactions: same amount within the window) and `claim-dismiss-<id>`.
- Ledger: `shared` rows show "· shared p%"; the editor gains `ed-shared-person` and `ed-shared-percent` for on-budget non-person accounts; saving with a percent re-derives the lines via `sharedLines`.
- e2e (`import-files.spec.ts`): synthetic QFX fixture files written at test time; import into the seed's Card: rows that match seed manual rows are linked, the rest appear as `new` in Review; a second import of the same file is all skipped; a synthetic sheet CSV creates a claim that applies to a matching card row and one partner-paid row in the person account; a CSV with an unknown header walks the mapping form and the profile is reused on the next file.
- Full gates; commit; push; memory.

## Self-review

Every §5 clause has a task; §4.4's general rule is in Task 5 and the spec was updated to state it; the person account for the sheet comes from settings chosen once in the UI (Task 6). Types match earlier phases; new fields were added to `types.ts` and the spec together.
