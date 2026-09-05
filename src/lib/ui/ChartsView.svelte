<!-- Charts: one range row scopes everything below it; each chart has a table twin (spec §6, §10). -->
<script lang="ts">
  import { app } from '../state/app.svelte';
  import { computeBudget } from '../domain/budget';
  import { categorySpendSeries, incomeSpendSeries, investmentIncomeSeries, lastMonths, netWorthSeries } from '../domain/charts';
  import { categoryStats } from '../domain/stats';
  import { monthsBetween, monthOf } from '../domain/month';
  import { visibleCategories } from '../domain/goals';
  import LineChart from './charts/LineChart.svelte';
  import BarChart from './charts/BarChart.svelte';

  const RANGES = [{ key: '12', label: '12 months', n: 12 }, { key: '24', label: '24 months', n: 24 }, { key: 'all', label: 'All time', n: 0 }];
  let range = $state('24');
  let categoryId = $state('');

  const firstMonth = $derived(app.transactionsSnap.reduce((m, t) => (monthOf(t.date) < m ? monthOf(t.date) : m), app.currentMonth));
  const months = $derived(range === 'all' ? monthsBetween(firstMonth, app.currentMonth) : lastMonths(app.currentMonth, Number(range)));
  const net = $derived(netWorthSeries(app.accountsSnap, app.transactionsSnap, months));
  const flow = $derived(incomeSpendSeries(app.accountsSnap, app.transactionsSnap, months));
  const invest = $derived(investmentIncomeSeries(app.accountsSnap, app.transactionsSnap, months));
  const hasInvestments = $derived(app.state.accounts.some((a) => a.kind === 'investment'));
  const budget = $derived(computeBudget({ accounts: app.accountsSnap, categories: app.categoriesSnap, assignments: app.assignmentsSnap, transactions: app.transactionsSnap, history: app.historySnap, currentMonth: app.currentMonth, cutoverMonth: app.state.settings.cutoverMonth }, app.currentMonth));
  const cats = $derived(visibleCategories(app.state.categories, app.state.groups).sort((a, b) => a.name.localeCompare(b.name)));
  const category = $derived(app.state.categories.find((c) => c.id === categoryId) ?? cats[0]);
  const catSeries = $derived(category ? categorySpendSeries(budget.activityByCategory.get(category.id), months) : []);
  const catStats = $derived(category ? categoryStats(budget.activityByCategory.get(category.id), app.currentMonth) : null);
  const catRefs = $derived([
    ...(catStats?.trailing12Avg ? [{ label: '12-month average', value: -catStats.trailing12Avg }] : []),
    ...(category?.goal ? [{ label: 'Goal', value: category.goal }] : []),
  ]);
</script>

<section class="charts">
  <div class="filters">
    <h2>Charts</h2>
    <div class="range" role="radiogroup" aria-label="Range">
      {#each RANGES as r (r.key)}<button class:on={range === r.key} data-testid={`range-${r.key}`} onclick={() => (range = r.key)}>{r.label}</button>{/each}
    </div>
  </div>
  <div class="grid">
    <LineChart testid="chart-networth" title="Net worth at month end" series={[
      { name: 'Total', points: net.total, slot: 1 }, { name: 'Budget accounts', points: net.budget, slot: 3 }, { name: 'Tracking accounts', points: net.tracking, slot: 2 },
    ]} />
    <BarChart testid="chart-flow" title="Income and spending by month" series={[{ name: 'Income', points: flow.income, slot: 1 }, { name: 'Spending', points: flow.spending, slot: 2 }]} />
    <div class="catpick">
      <label>Category <select data-testid="chart-category-pick" value={category?.id ?? ''} onchange={(e) => (categoryId = e.currentTarget.value)}>{#each cats as c (c.id)}<option value={c.id}>{c.name}</option>{/each}</select></label>
    </div>
    {#if category}
      <BarChart testid="chart-category" title={`${category.name}: spending by month`} series={[{ name: 'Spent', points: catSeries, slot: 1 }]} refs={catRefs} />
    {/if}
    {#if hasInvestments}
      <LineChart testid="chart-invest" title="Investment income, running total" series={[{ name: 'Running total', points: invest.cumulative, slot: 3 }]} />
    {/if}
  </div>
</section>

<style>
  .charts { max-width: 1200px; margin: 0 auto; padding: 16px 24px; }
  .filters { display: flex; align-items: center; gap: 16px; margin-bottom: 12px; }
  h2 { margin: 0; }
  .range { display: flex; gap: 6px; }
  .range button.on { border-color: var(--blue); color: var(--blue); }
  .grid { display: grid; gap: 14px; }
  .catpick label { color: var(--dim); display: flex; gap: 8px; align-items: center; }
  select { font: inherit; color: var(--text); background: var(--bg2); border: 1px solid var(--line); border-radius: 4px; padding: 3px 6px; }
</style>
