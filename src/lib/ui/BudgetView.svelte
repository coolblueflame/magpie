<!-- The budget screen: one month, groups and categories, Ready to Assign, goals, fill, move, stats (spec §6). -->
<script lang="ts">
  import { app } from '../state/app.svelte';
  import { undoStack } from '../state/undo.svelte';
  import { toast } from './toast.svelte';
  import { computeBudget } from '../domain/budget';
  import { fillPatches, suggestGoal } from '../domain/goals';
  import { categoryStats } from '../domain/stats';
  import { formatMoney } from '../domain/money';
  import { addMonths, monthLabel } from '../domain/month';
  import { RTA, type Category, type CategoryGroup, type Cents, type MonthKey } from '../domain/types';
  import { navigate, router } from './router.svelte';
  import { focusOnMount } from './focusOnMount';
  import MoneyCell from './MoneyCell.svelte';
  import MovePopover from './MovePopover.svelte';
  import RowMenu from './RowMenu.svelte';

  const month = $derived<MonthKey>(
    router.current.name === 'budget' && router.current.month ? router.current.month : app.currentMonth,
  );
  // Snapshot first: computeBudget scans every row, and proxy reads at that scale are slow (PB §2.13).
  const budget = $derived(computeBudget({
    accounts: app.accountsSnap, categories: app.categoriesSnap, assignments: app.assignmentsSnap,
    transactions: app.transactionsSnap, history: app.historySnap,
    currentMonth: app.currentMonth, cutoverMonth: app.state.settings.cutoverMonth,
  }, month));

  let showHidden = $state(false);
  let showStats = $state(true);
  const groups = $derived([...app.state.groups].filter((g) => showHidden || !g.hidden).sort((a, b) => a.sortOrder - b.sortOrder));
  const visibleCategories = $derived(app.state.categories.filter((c) => !c.hidden));
  const categoriesOf = (groupId: string) =>
    app.state.categories.filter((c) => c.groupId === groupId && (showHidden || !c.hidden)).sort((a, b) => a.sortOrder - b.sortOrder);
  const groupTotals = (groupId: string) => categoriesOf(groupId).reduce((t, c) => {
    const r = budget.rows.get(c.id);
    return { assigned: t.assigned + (r?.assigned ?? 0), activity: t.activity + (r?.activity ?? 0), available: t.available + (r?.available ?? 0) };
  }, { assigned: 0, activity: 0, available: 0 });

  // Goal suggestions come from assignment history; only categories with no goal get one.
  const assignedByCategory = $derived.by(() => {
    const m = new Map<string, Map<MonthKey, Cents>>();
    for (const a of app.state.assignments) {
      let byMonth = m.get(a.categoryId);
      if (!byMonth) { byMonth = new Map(); m.set(a.categoryId, byMonth); }
      byMonth.set(a.month, a.amount);
    }
    return m;
  });
  const suggestionFor = (c: Category): Cents | null => (c.goal === 0 ? suggestGoal(assignedByCategory.get(c.id), app.currentMonth) : null);
  const suggestions = $derived(visibleCategories
    .map((c) => ({ categoryId: c.id, goal: suggestionFor(c) }))
    .filter((s): s is { categoryId: string; goal: Cents } => s.goal !== null));

  const fill = $derived(fillPatches(app.state.categories, app.assignedOf(month), month));
  let fillArmed = $state(false);
  let fillTimer: ReturnType<typeof setTimeout> | undefined;
  async function fillAll() {
    if (!fillArmed) {
      fillArmed = true;
      fillTimer = setTimeout(() => (fillArmed = false), 5000);
      return;
    }
    clearTimeout(fillTimer);
    fillArmed = false;
    const total = await app.fillAllGoals(month);
    toast.show(`Filled all goals, ${formatMoney(total)}`, () => void undoStack.undo());
  }
  async function fillOne(c: Category) {
    await app.fillGoal(c.id, month);
    toast.show(`Filled ${c.name}`, () => void undoStack.undo());
  }

  let move = $state<{ from: string; fromName: string; amount: Cents } | null>(null);
  async function doMove(to: string, amount: Cents) {
    const m = move!;
    move = null;
    await app.moveMoney(m.from, to, month, amount);
    toast.show(`Moved ${formatMoney(amount)}`, () => void undoStack.undo());
  }

  let renaming = $state<string | null>(null);
  let renameDraft = $state('');
  function startRename(id: string, name: string) { renaming = id; renameDraft = name; }
  async function commitRename(kind: 'category' | 'group', id: string, old: string) {
    if (renaming !== id) return;
    renaming = null;
    const name = renameDraft.trim();
    if (!name || name === old) return;
    await (kind === 'category' ? app.renameCategory(id, name) : app.renameGroup(id, name));
    toast.show(`Renamed ${old}`, () => void undoStack.undo());
  }

  /** A group id to add a category into, or 'group' to add a new group. */
  let addingIn = $state<string | null>(null);
  let addDraft = $state('');
  async function commitAdd() {
    const target = addingIn;
    const name = addDraft.trim();
    addingIn = null;
    addDraft = '';
    if (!target || !name) return;
    await (target === 'group' ? app.addGroup(name) : app.addCategory(target, name));
    toast.show(`Added ${name}`, () => void undoStack.undo());
  }

  async function commitAssigned(c: Category, cents: Cents) {
    await app.setAssigned(c.id, month, cents);
    toast.show(`Assigned ${c.name}`, () => void undoStack.undo());
  }
  async function commitGoal(c: Category, cents: Cents) {
    await app.setGoal(c.id, cents);
    toast.show(`Goal for ${c.name}`, () => void undoStack.undo());
  }
  async function adoptAll() {
    await app.setGoals(suggestions);
    toast.show(`Adopted ${suggestions.length} suggested goals`, () => void undoStack.undo());
  }

  const stats = (id: string) => categoryStats(budget.activityByCategory.get(id), app.currentMonth);
  const fmtAvg = (v: Cents | null) => (v === null ? '–' : formatMoney(v));
  const tone = (cents: number) => (cents < 0 ? 'neg' : cents > 0 ? 'pos' : '');
  const categoryItems = (c: Category) => [
    { label: 'Rename', testid: `menu-${c.id}-rename`, run: () => startRename(c.id, c.name) },
    { label: c.hidden ? 'Unhide' : 'Hide', testid: `menu-${c.id}-hide`, run: () => void app.setCategoryHidden(c.id, !c.hidden) },
  ];
  const groupItems = (g: CategoryGroup) => [
    { label: 'Add category', testid: `menu-${g.id}-add`, run: () => { addingIn = g.id; addDraft = ''; } },
    { label: 'Rename', testid: `menu-${g.id}-rename`, run: () => startRename(g.id, g.name) },
    { label: g.hidden ? 'Unhide' : 'Hide', testid: `menu-${g.id}-hide`, run: () => void app.setGroupHidden(g.id, !g.hidden) },
  ];
</script>

<section class="budget">
  <header>
    <button data-testid="month-prev" onclick={() => navigate({ name: 'budget', month: addMonths(month, -1) })}>‹</button>
    <h2 data-testid="month-label">{monthLabel(month)}</h2>
    <button data-testid="month-next" onclick={() => navigate({ name: 'budget', month: addMonths(month, 1) })}>›</button>
    <div class="rta">
      <span class="label">Ready to Assign</span>
      <button class={`rtaval money ${tone(budget.rta)}`} data-testid="rta" title="Assign from Ready to Assign"
        onclick={() => (move = { from: RTA, fromName: 'Ready to Assign', amount: 0 })}>{formatMoney(budget.rta)}</button>
      {#if budget.uncategorised !== 0}
        <span class="chip" data-testid="uncategorised">Uncategorised {formatMoney(budget.uncategorised)}</span>
      {/if}
      {#if move?.from === RTA}
        <MovePopover from={RTA} fromName="Ready to Assign" amount={0} {groups} categories={visibleCategories} onMove={doMove} onClose={() => (move = null)} />
      {/if}
    </div>
  </header>
  <div class="toolbar">
    <label class="toggle"><input type="checkbox" data-testid="show-hidden" bind:checked={showHidden} /> Show hidden</label>
    <label class="toggle"><input type="checkbox" data-testid="show-stats" bind:checked={showStats} /> Show stats</label>
    {#if addingIn === 'group'}
      <input data-testid="new-group" placeholder="Group name" bind:value={addDraft} use:focusOnMount
        onkeydown={(e) => { if (e.key === 'Enter') void commitAdd(); if (e.key === 'Escape') addingIn = null; }} onblur={() => void commitAdd()} />
    {:else}
      <button data-testid="add-group" onclick={() => { addingIn = 'group'; addDraft = ''; }}>Add group</button>
    {/if}
    <span class="spacer"></span>
    {#if suggestions.length}
      <button data-testid="adopt-suggestions" onclick={() => void adoptAll()}>Use {suggestions.length} suggested goals</button>
    {/if}
    <button data-testid="fill-all" class:armed={fillArmed} disabled={fill.total === 0} onclick={() => void fillAll()} onblur={() => (fillArmed = false)}>
      {fillArmed ? `Take ${formatMoney(fill.total)} from Ready to Assign?` : `Fill all goals · ${formatMoney(fill.total)}`}
    </button>
  </div>
  <table>
    <thead>
      <tr>
        <th>Category</th><th class="money">Goal</th><th class="money">Assigned</th><th class="money">Activity</th><th class="money">Available</th>
        {#if showStats}<th class="money stat">Avg (all)</th><th class="money stat">Avg (12 mo)</th><th class="money stat">Last month</th>{/if}
      </tr>
    </thead>
    <tbody>
      {#each groups as g (g.id)}
        {@const t = groupTotals(g.id)}
        <tr class="group" class:hidden={g.hidden} data-testid={`group-${g.id}`}>
          <td>
            {#if renaming === g.id}
              <input data-testid={`rename-input-${g.id}`} bind:value={renameDraft} use:focusOnMount
                onkeydown={(e) => { if (e.key === 'Enter') void commitRename('group', g.id, g.name); if (e.key === 'Escape') renaming = null; }}
                onblur={() => void commitRename('group', g.id, g.name)} />
            {:else}
              {g.name}<RowMenu testid={`menu-${g.id}`} items={groupItems(g)} />
            {/if}
          </td>
          <td></td>
          <td class="money" data-testid={`group-assigned-${g.id}`}>{formatMoney(t.assigned)}</td>
          <td class={`money ${tone(t.activity)}`} data-testid={`group-activity-${g.id}`}>{formatMoney(t.activity)}</td>
          <td class={`money ${tone(t.available)}`} data-testid={`group-available-${g.id}`}>{formatMoney(t.available)}</td>
          {#if showStats}<td></td><td></td><td></td>{/if}
        </tr>
        {#if addingIn === g.id}
          <tr><td colspan={showStats ? 8 : 5}>
            <input data-testid={`new-category-${g.id}`} placeholder="Category name" bind:value={addDraft} use:focusOnMount
              onkeydown={(e) => { if (e.key === 'Enter') void commitAdd(); if (e.key === 'Escape') addingIn = null; }} onblur={() => void commitAdd()} />
          </td></tr>
        {/if}
        {#each categoriesOf(g.id) as c (c.id)}
          {@const row = budget.rows.get(c.id)}
          {@const assigned = row?.assigned ?? 0}
          {@const available = row?.available ?? 0}
          {@const sugg = suggestionFor(c)}
          {@const s = showStats ? stats(c.id) : null}
          <tr class:hidden={c.hidden} data-testid={`cat-row-${c.id}`}>
            <td>
              {#if renaming === c.id}
                <input data-testid={`rename-input-${c.id}`} bind:value={renameDraft} use:focusOnMount
                  onkeydown={(e) => { if (e.key === 'Enter') void commitRename('category', c.id, c.name); if (e.key === 'Escape') renaming = null; }}
                  onblur={() => void commitRename('category', c.id, c.name)} />
              {:else}
                {c.name}<RowMenu testid={`menu-${c.id}`} items={categoryItems(c)} />
              {/if}
            </td>
            <td class="money"><div class="wrap">
              {#if sugg !== null}
                <button class="suggest" data-testid={`suggest-${c.id}`} title={`Use ${formatMoney(sugg)} as the goal`} onclick={() => void commitGoal(c, sugg)}>{formatMoney(sugg)}?</button>
              {/if}
              <MoneyCell value={c.goal} testid={`goal-${c.id}`} inputTestid={`goal-input-${c.id}`} onCommit={(v) => commitGoal(c, v)} />
            </div></td>
            <td class="money"><div class="wrap">
              {#if c.goal > assigned}
                <button class="fill" data-testid={`fill-${c.id}`} title="Fill to goal" onclick={() => void fillOne(c)}>↑</button>
              {/if}
              <MoneyCell value={assigned} testid={`assigned-${c.id}`} inputTestid={`assigned-input-${c.id}`} onCommit={(v) => commitAssigned(c, v)} />
            </div></td>
            <td class={`money ${tone(row?.activity ?? 0)}`} data-testid={`activity-${c.id}`}>{formatMoney(row?.activity ?? 0)}</td>
            <td class="money availcell">
              <button class={`cell money ${tone(available)}`} data-testid={`available-${c.id}`} title="Move money"
                onclick={() => (move = { from: c.id, fromName: c.name, amount: available })}>{formatMoney(available)}</button>
              {#if move?.from === c.id}
                <MovePopover from={c.id} fromName={c.name} amount={available} {groups} categories={visibleCategories} onMove={doMove} onClose={() => (move = null)} />
              {/if}
            </td>
            {#if s}
              <td class={`money stat ${tone(s.allTimeAvg ?? 0)}`} data-testid={`avg-all-${c.id}`}>{fmtAvg(s.allTimeAvg)}</td>
              <td class={`money stat ${tone(s.trailing12Avg ?? 0)}`} data-testid={`avg-12-${c.id}`}>{fmtAvg(s.trailing12Avg)}</td>
              <td class={`money stat ${tone(s.lastMonth)}`} data-testid={`last-${c.id}`}>{formatMoney(s.lastMonth)}</td>
            {/if}
          </tr>
        {/each}
      {/each}
    </tbody>
  </table>
</section>

<style>
  .budget { max-width: 1200px; margin: 0 auto; padding: 16px 24px; }
  header { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
  h2 { margin: 0; min-width: 120px; text-align: center; }
  .rta { margin-left: auto; display: flex; align-items: baseline; gap: 10px; position: relative; }
  .rta .label { color: var(--dim); }
  .rtaval { border: none; padding: 0; font-size: 1.4rem; }
  .rtaval:hover { color: var(--blue); }
  .chip { background: var(--bg2); border: 1px solid var(--amber); color: var(--amber); border-radius: 999px; padding: 2px 10px; font-size: 0.85rem; }
  .toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; font-size: 0.9rem; }
  .toolbar .spacer { flex: 1; }
  .toggle { color: var(--dim); display: flex; align-items: center; gap: 4px; }
  button.armed { border-color: var(--red); color: var(--red); }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; color: var(--dim); font-weight: 500; padding: 6px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th.money { text-align: right; }
  td { padding: 6px 8px; border-bottom: 1px solid var(--line); }
  td.money { text-align: right; }
  td.stat, th.stat { color: var(--dim); font-size: 0.9rem; }
  tr.group td { background: var(--bg1); color: var(--blue); font-weight: 600; padding-top: 12px; }
  tr.hidden td { color: var(--dim); font-style: italic; }
  .wrap { display: flex; justify-content: flex-end; align-items: center; gap: 6px; }
  .cell { border: none; padding: 0; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
  .cell:hover { color: var(--blue); }
  .availcell { position: relative; }
  .suggest { border: 1px dashed var(--line); color: var(--dim); font-family: var(--font-mono); font-size: 0.85rem; padding: 0 6px; }
  .suggest:hover { color: var(--blue); border-color: var(--blue); }
  .fill { border: none; color: var(--dim); padding: 0 4px; }
  .fill:hover { color: var(--teal); }
  input { font-family: var(--font-sans); }
</style>
