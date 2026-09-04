<!-- The budget screen: one month, groups and categories, Ready to Assign (spec §6). -->
<script lang="ts">
  import { app } from '../state/app.svelte';
  import { undoStack } from '../state/undo.svelte';
  import { toast } from './toast.svelte';
  import { computeBudget } from '../domain/budget';
  import { formatCents, formatMoney, parseCents } from '../domain/money';
  import { addMonths, monthLabel } from '../domain/month';
  import { navigate, router } from './router.svelte';
  import { focusOnMount } from './focusOnMount';
  import type { MonthKey } from '../domain/types';

  const month = $derived<MonthKey>(
    router.current.name === 'budget' && router.current.month ? router.current.month : app.currentMonth,
  );
  // Snapshot first: computeBudget scans every row, and proxy reads at that scale are slow (PB §2.13).
  const budget = $derived(computeBudget(
    { ...$state.snapshot(app.state), currentMonth: app.currentMonth, cutoverMonth: app.state.settings.cutoverMonth },
    month,
  ));
  const groups = $derived([...app.state.groups].filter((g) => !g.hidden).sort((a, b) => a.sortOrder - b.sortOrder));
  const categoriesOf = (groupId: string) =>
    app.state.categories.filter((c) => c.groupId === groupId && !c.hidden).sort((a, b) => a.sortOrder - b.sortOrder);

  let editing = $state<string | null>(null);
  let draft = $state('');
  let invalid = $state(false);

  function startEdit(id: string, cents: number) { editing = id; draft = formatCents(cents); invalid = false; }
  async function commit(id: string, name: string) {
    if (editing !== id) return;
    const cents = parseCents(draft);
    if (cents === null) { invalid = true; return; }
    editing = null;
    await app.setAssigned(id, month, cents);
    toast.show(`Assigned ${name}`, () => void undoStack.undo());
  }
  function cancel() { editing = null; invalid = false; }
  const cls = (cents: number) => `money ${cents < 0 ? 'neg' : cents > 0 ? 'pos' : ''}`;
</script>

<section class="budget">
  <header>
    <button data-testid="month-prev" onclick={() => navigate({ name: 'budget', month: addMonths(month, -1) })}>‹</button>
    <h2 data-testid="month-label">{monthLabel(month)}</h2>
    <button data-testid="month-next" onclick={() => navigate({ name: 'budget', month: addMonths(month, 1) })}>›</button>
    <div class="rta">
      <span class="label">Ready to Assign</span>
      <span class={cls(budget.rta)} data-testid="rta">{formatMoney(budget.rta)}</span>
      {#if budget.uncategorised !== 0}
        <span class="chip" data-testid="uncategorised">Uncategorised {formatMoney(budget.uncategorised)}</span>
      {/if}
    </div>
  </header>
  <table>
    <thead>
      <tr><th>Category</th><th class="money">Goal</th><th class="money">Assigned</th><th class="money">Activity</th><th class="money">Available</th></tr>
    </thead>
    <tbody>
      {#each groups as g (g.id)}
        <tr class="group" data-testid={`group-${g.id}`}><td colspan="5">{g.name}</td></tr>
        {#each categoriesOf(g.id) as c (c.id)}
          {@const row = budget.rows.get(c.id)}
          <tr data-testid={`cat-row-${c.id}`}>
            <td>{c.name}</td>
            <td class="money" data-testid={`goal-${c.id}`}>{formatMoney(c.goal)}</td>
            <td class="money">
              {#if editing === c.id}
                <input data-testid={`assigned-input-${c.id}`} class:invalid bind:value={draft} use:focusOnMount
                  onkeydown={(e) => { if (e.key === 'Enter') void commit(c.id, c.name); if (e.key === 'Escape') cancel(); }}
                  onblur={() => void commit(c.id, c.name)} />
              {:else}
                <button class="cell" data-testid={`assigned-${c.id}`} onclick={() => startEdit(c.id, row?.assigned ?? 0)}>
                  {formatMoney(row?.assigned ?? 0)}
                </button>
              {/if}
            </td>
            <td class={cls(row?.activity ?? 0)} data-testid={`activity-${c.id}`}>{formatMoney(row?.activity ?? 0)}</td>
            <td class={cls(row?.available ?? 0)} data-testid={`available-${c.id}`}>{formatMoney(row?.available ?? 0)}</td>
          </tr>
        {/each}
      {/each}
    </tbody>
  </table>
</section>

<style>
  .budget { max-width: 960px; margin: 0 auto; padding: 16px 24px; }
  header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
  h2 { margin: 0; min-width: 120px; text-align: center; }
  .rta { margin-left: auto; display: flex; align-items: baseline; gap: 10px; }
  .rta .label { color: var(--dim); }
  .rta .money { font-size: 1.4rem; }
  .chip { background: var(--bg2); border: 1px solid var(--amber); color: var(--amber); border-radius: 999px; padding: 2px 10px; font-size: 0.85rem; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; color: var(--dim); font-weight: 500; padding: 6px 8px; border-bottom: 1px solid var(--line); }
  th.money { text-align: right; }
  td { padding: 6px 8px; border-bottom: 1px solid var(--line); }
  tr.group td { background: var(--bg1); color: var(--blue); font-weight: 600; padding-top: 12px; }
  .cell { border: none; padding: 0; width: 100%; text-align: right; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
  .cell:hover { color: var(--blue); }
  input { width: 110px; text-align: right; font-family: var(--font-mono); }
  input.invalid { outline: 1px solid var(--red); border-color: var(--red); }
</style>
