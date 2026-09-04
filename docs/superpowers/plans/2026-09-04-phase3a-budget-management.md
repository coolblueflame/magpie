# Phase 3a: Budget Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the budget screen enough to run a month on: set goals (with suggestions from assignment history, since the YNAB export carries none), fill a category or every category to its goal, move money between categories and Ready to Assign, see per-category spending stats, and add / rename / hide categories and groups. Everything undoable.

**Architecture:** Pure helpers in `domain/` produce assignment patches and stats; the store gains a generic undoable `patchRow`/`createRow` plus `applyAssignments` that writes several assignment rows as one undo entry; the budget screen grows editable goal cells, a move popover and a row menu. `computeBudget` exposes per-category activity by month so stats need no second scan.

**Tech Stack:** as before.

**Spec:** `docs/superpowers/specs/2026-09-04-magpie-design.md` §4.2 (fill, fill all), §4.7 (undo), §6 Budget (stats columns, move money), decisions in `CLAUDE.md` (monthly goal, fill-all each to its own goal, stats: all-time average, trailing 12 months, last month).

## Global Constraints

As phase 1 and 2. Plus: averages divide by the number of months the category has existed within the window (min 1), never by a fixed 12 for a category younger than a year; averages round half away from zero (`roundHalfAway` in `money.ts`; JS `Math.round` rounds -500.5 to -500).

---

## File structure

```
src/lib/domain/budget.ts        BudgetMonth gains activityByCategory: Map<categoryId, Map<MonthKey, Cents>>
src/lib/domain/stats.ts         categoryStats
src/lib/domain/goals.ts         suggestGoal, fillPatches
src/lib/domain/moves.ts         movePatches
src/lib/state/app.svelte.ts     patchRow, createRow, applyAssignments, setGoal, fillGoal, fillAllGoals, moveMoney,
                                addCategory, renameCategory, setCategoryHidden, addGroup, renameGroup, setGroupHidden
src/lib/ui/MoneyCell.svelte     inline-editable money cell (assigned and goal share it)
src/lib/ui/MovePopover.svelte   amount + destination, anchored to an available cell or the RTA header
src/lib/ui/RowMenu.svelte       "…" menu: rename, hide/unhide, add category (on a group row)
src/lib/ui/BudgetView.svelte    wires it all; stats columns behind a toggle; group total rows
e2e/budget-manage.spec.ts
```

---

### Task 1: Domain helpers

**Files:** Modify `src/lib/domain/budget.ts` (+test); create `stats.ts`, `goals.ts`, `moves.ts` with tests.

**Interfaces:**
```ts
// budget.ts: add to BudgetMonth
activityByCategory: Map<string, Map<MonthKey, Cents>>;   // every month with activity, all time, budget effect only

// stats.ts
export interface CategoryStats { allTimeAvg: Cents | null; trailing12Avg: Cents | null; lastMonth: Cents; firstMonth: MonthKey | null }
export function categoryStats(activity: Map<MonthKey, Cents> | undefined, currentMonth: MonthKey): CategoryStats
//   lastComplete = currentMonth − 1; firstMonth = earliest key ≤ lastComplete (null → both averages null)
//   allTimeAvg = round(Σ activity[firstMonth..lastComplete] / monthsBetween(firstMonth, lastComplete).length)
//   trailing12Avg = window = (lastComplete − 11)..lastComplete, start = max(window start, firstMonth);
//                  round(Σ activity[start..lastComplete] / monthsBetween(start, lastComplete).length)
//   lastMonth = activity[lastComplete] ?? 0

// goals.ts
export function suggestGoal(assigned: Map<MonthKey, Cents> | undefined, currentMonth: MonthKey): Cents | null
//   nonzero assigned amounts in (currentMonth − 11)..currentMonth; the most frequent; tie → the most recent; null if none
export interface AssignmentPatch { categoryId: string; month: MonthKey; amount: Cents }
export function fillPatches(categories: Category[], assignedOf: (categoryId: string) => Cents, month: MonthKey): { patches: AssignmentPatch[]; total: Cents }
//   for each category (hidden excluded, goal > assigned): patch to goal; total = Σ (goal − assigned)

// moves.ts
export type MoveEnd = string;   // a categoryId, or RTA
export function movePatches(from: MoveEnd, to: MoveEnd, month: MonthKey, amount: Cents, assignedOf: (categoryId: string) => Cents): AssignmentPatch[]
//   amount must be > 0 and from !== to, else throw; RTA end contributes no patch
```

- [ ] Tests: stats on a 14-month synthetic map (all-time vs trailing window differ; a 2-month-old category divides by 2; no history → nulls, lastMonth 0); suggestGoal (mode, tie → most recent, ignores zeros and months older than 12, null); fillPatches (skips hidden, skips at-or-above goal, total); movePatches (category→category, RTA→category, category→RTA, rejects 0 and same ends). budget.test: `activityByCategory` for the rollover case equals `{ groc: { '2026-07': -15000 } }`.
- [ ] Commit: "Domain: category stats, goal suggestions, fill and move patches".

---

### Task 2: Store

**Files:** Modify `src/lib/state/app.svelte.ts`, `app.test.ts`

**Interfaces:**
```ts
// generic, undoable; label is what the toast and Ctrl+Z report
patchRow<T extends Row>(table: TableName, id: string, patch: Partial<T>, label: string): Promise<void>   // captures the prior values of the patched keys from the mirror; undo restores them; redo re-applies
createRow<T extends Row>(table: TableName, draft: Omit<T, keyof Row>, label: string): Promise<T>        // undo tombstones; redo un-tombstones (patch deleted:false)
applyAssignments(patches: AssignmentPatch[], label: string): Promise<void>                              // one undo entry; prior amounts captured first (missing → tombstone on undo)
setGoal(categoryId, goal)                     → patchRow('categories', …, 'goal <name>')
fillGoal(categoryId, month)                   → applyAssignments([{…goal}], 'fill <name>') when goal > assigned
fillAllGoals(month): Promise<Cents>           → fillPatches over state.categories; applyAssignments(…, 'fill all goals'); returns total
moveMoney(from, to, month, amount)            → applyAssignments(movePatches(...), 'move <money>')
addCategory(groupId, name), renameCategory(id, name), setCategoryHidden(id, hidden)
addGroup(name), renameGroup(id, name), setGroupHidden(id, hidden)
```
`setAssigned` is rewritten on top of `applyAssignments`. Mirror patching stays in place (`Object.assign` on the found row; push on create; splice on tombstone). New rows get `sortOrder` = max sibling + 1.

- [ ] Tests: patchRow undo restores exactly the prior keys (and leaves unrelated later edits alone); createRow undo removes from mirror and disk shows `deleted: true`, redo restores; fillAllGoals on the seed month returns the right total and one undo reverts every row; moveMoney RTA→category and category→category conserve `rta + Σ available` (compute with `computeBudget` before/after); addCategory sortOrder.
- [ ] Commit: "Store: generic undoable patches, goals, fill, move money, category and group edits".

---

### Task 3: Screens

**Files:** Create `MoneyCell.svelte`, `MovePopover.svelte`, `RowMenu.svelte`; modify `BudgetView.svelte`

Behaviour and test ids:
- **MoneyCell** props `{ value: Cents; testid: string; onCommit: (cents) => void; allowNegative?: boolean }`; same edit semantics as phase 1's assigned cell (click, Enter/blur commit, Escape cancel, invalid keeps open with class `invalid`). Assigned uses `assigned-<id>`, goal uses `goal-<id>`; inputs `assigned-input-<id>` / `goal-input-<id>`.
- **Goal cell**: when `goal === 0` and `suggestGoal(...)` is non-null, render the suggestion dimmed inside the cell with a `suggest-<id>` button (title "Use $X as the goal"); clicking sets the goal. Header button `adopt-suggestions` sets every zero goal that has a suggestion (one undo entry "adopt suggested goals").
- **Fill**: in the assigned cell, a small `fill-<id>` button when `assigned < goal` (title "Fill to goal"). Header `fill-all` button shows the total in its label ("Fill all goals · $1,234.00"), first click arms (text "Take $X from Ready to Assign?"), second applies; disabled when the total is 0.
- **Move**: clicking an available cell (`available-<id>`) opens **MovePopover** (`move-popover`): amount input `move-amount` pre-filled with the available amount when positive, destination select `move-to` listing "Ready to Assign" then every visible category grouped by group (the source excluded), `move-confirm`, `move-cancel`, Escape closes. The RTA header value (`rta`) is also clickable: same popover with source RTA and amount blank. Invalid or zero amount keeps it open with `invalid`.
- **Stats**: toggle `show-stats` (default on) adds columns Avg (all), Avg (12 mo), Last month with ids `avg-all-<id>`, `avg-12-<id>`, `last-<id>`; null renders as "–" (an en dash is fine; never an em dash).
- **Group total rows**: the group header row shows Σ assigned / activity / available of its visible categories in the matching columns (`group-assigned-<gid>` etc.).
- **RowMenu** on each category row (`menu-<id>`) with Rename (inline: the name becomes an input `rename-input-<id>`, Enter commits, Escape cancels), Hide / Unhide; on group rows (`menu-<gid>`): Rename, Hide / Unhide, Add category (inline input `new-category-<gid>`, Enter creates). Header `add-group` button → inline input `new-group`.
- `.budget` max-width 1200 px.
- [ ] `npm run check` clean; walk it in `npm run dev` with the import fixture files and with the seed.
- [ ] Commit: "Budget screen: goals with suggestions, fill, move money, stats, row menus".

---

### Task 4: e2e and gates

**Files:** Create `e2e/budget-manage.spec.ts`

- [ ] With the seed: fill Fun to goal (assigned $150.00, RTA drops by $150.00); fill-all arms then applies (total = Fun 150 + Utilities 200 + Savings 500 = $850.00; RTA $3,150.00); Ctrl+Z reverts all three rows; move $100 from Groceries to Fun (Groceries available $506.55, Fun available up by $100, RTA unchanged); move $50 from RTA to Rent (RTA down $50); stats: Groceries avg-all `-$535.00`, avg-12 `-$535.00`, last `-$620.00` (seed months Jul/Aug/Sep relative to the current month, so compute expected strings from the seed, not the calendar); rename Fun to "Play" and hide it; unhide via show-hidden + menu.
- [ ] With the import fixture (reuse `e2e/import.spec.ts`'s helpers by exporting them from a small `e2e/helpers.ts`): Groceries goal cell shows suggestion $100.00, `suggest-<id>` adopts it, Fun suggests $50.00, `adopt-suggestions` fills the rest.
- [ ] Full gates; commit "Add budget management e2e; phase 3a complete"; push; memory update (next: phase 3b).

## Self-review

Covers decisions: monthly goal per category with one-click fill and fill-all each to its own goal (Tasks 1–3), stats (Tasks 1, 3), move money in one step (Tasks 1–3), undo for every action (Task 2), category groups (Task 3). Suggestions are the one addition beyond the spec, forced by the export carrying no goals; recorded in the spec by the commit that lands this plan.
