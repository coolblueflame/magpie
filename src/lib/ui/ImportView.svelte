<!-- YNAB export import (spec §5.1, §6): two files, per-account choices, a verified report, then commit. -->
<script lang="ts">
  import { app } from '../state/app.svelte';
  import { navigate } from './router.svelte';
  import {
    buildYnabImport, inferAccounts, isYnabPlan, isYnabRegister, readYnabPlan, readYnabRegister,
    type InferredAccount, type YnabAccountChoice, type YnabImport, type YnabPlanRow, type YnabRegisterRow,
  } from '../domain/ynab';
  import { formatMoney } from '../domain/money';
  import { monthLabel } from '../domain/month';
  import type { AccountKind } from '../domain/types';

  const KINDS: AccountKind[] = ['chequing', 'savings', 'credit', 'cash', 'person', 'loan', 'investment', 'other'];

  // $state.raw: these hold thousands of plain rows that go straight to IndexedDB; a deep proxy
  // would be slow to build and impossible to structured-clone.
  let register = $state.raw<YnabRegisterRow[] | null>(null);
  let plan = $state.raw<YnabPlanRow[] | null>(null);
  let build = $state.raw<YnabImport | null>(null);
  let choices = $state<(InferredAccount & { person: boolean })[]>([]);
  let error = $state('');
  let busy = $state(false);
  const isEmpty = $derived(!app.state.accounts.length && !app.state.categories.length && !app.state.transactions.length);

  async function onFile(e: Event, which: 'register' | 'plan') {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    error = '';
    build = null;
    const text = await file.text();
    const header = text.split(/\r?\n/, 1)[0] ?? '';
    try {
      if (which === 'register') {
        if (!isYnabRegister(header)) throw new Error('That is not a YNAB Register export.');
        register = readYnabRegister(text);
        choices = inferAccounts(register).map((a) => ({ ...a, person: false }));
      } else {
        if (!isYnabPlan(header)) throw new Error('That is not a YNAB Plan export.');
        plan = readYnabPlan(text);
      }
    } catch (err) {
      error = (err as Error).message;
    }
  }

  function setPerson(i: number) {
    choices = choices.map((c, k) => (k === i
      ? { ...c, person: true, kind: 'person' as const, onBudget: true }
      : { ...c, person: false, kind: c.kind === 'person' ? 'other' as const : c.kind }));
  }

  function analyse() {
    if (!register || !plan) return;
    error = '';
    try {
      const accounts: Record<string, YnabAccountChoice> = Object.fromEntries(
        choices.map((c) => [c.name, { kind: c.kind, onBudget: c.onBudget, person: c.person }]),
      );
      build = buildYnabImport(register, plan, { accounts, now: Date.now() });
    } catch (err) {
      error = (err as Error).message;
    }
  }

  async function doImport() {
    if (!build) return;
    busy = true;
    try {
      await app.importYnab(build);
      navigate({ name: 'budget' });
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<section class="import">
  <h2>Import from YNAB</h2>
  <p class="dim">In YNAB, open the budget menu and choose Export budget; unzip it and pick the two files below.</p>
  <div class="files">
    <label>Register CSV <input type="file" accept=".csv,text/csv" data-testid="file-register" onchange={(e) => void onFile(e, 'register')} /></label>
    <label>Plan CSV <input type="file" accept=".csv,text/csv" data-testid="file-plan" onchange={(e) => void onFile(e, 'plan')} /></label>
  </div>
  {#if error}<p class="error" data-testid="import-error">{error}</p>{/if}

  {#if register && plan}
    <h3>Accounts</h3>
    <p class="dim">Kind and on-budget were guessed from the rows; YNAB never categorises tracking accounts. Pick the partner's account if there is one.</p>
    <table>
      <thead><tr><th>Account</th><th>Rows</th><th>Kind</th><th>On budget</th><th>Partner</th></tr></thead>
      <tbody>
        {#each choices as c, i (c.name)}
          <tr data-testid={`account-row-${i}`}>
            <td>{c.name}</td>
            <td class="money">{c.rows}</td>
            <td>
              <select data-testid={`kind-${i}`} bind:value={c.kind} disabled={c.person}>
                {#each KINDS as k}<option value={k}>{k}</option>{/each}
              </select>
            </td>
            <td><input type="checkbox" data-testid={`onbudget-${i}`} bind:checked={c.onBudget} disabled={c.person} /></td>
            <td><input type="radio" name="person" data-testid={`person-${i}`} checked={c.person} onchange={() => setPerson(i)} /></td>
          </tr>
        {/each}
      </tbody>
    </table>
    <p><button data-testid="analyse" onclick={analyse}>Analyse</button></p>
  {/if}

  {#if build}
    {@const r = build.report}
    <h3>What would be imported</h3>
    <p data-testid="report-counts">
      {r.counts.accounts} accounts, {r.counts.categories} categories in {r.counts.groups} groups, {r.counts.payees} payees,
      {r.counts.transactions} transactions ({r.counts.splits} splits, {r.counts.transfers} transfers, {r.counts.newRows} still to categorise),
      {r.counts.assignments} assignments, {r.counts.history} months of history. Cutover month: {monthLabel(build.cutoverMonth)}.
    </p>
    <p data-testid="report-mismatches" class={r.cutoverMismatches || r.activityMismatches ? 'error' : 'ok'}>
      {r.cutoverMismatches} cutover mismatches, {r.activityMismatches} activity mismatches
    </p>
    {#if r.creditCardFolded > 0}
      <p data-testid="report-cc">Ready to Assign is {formatMoney(r.creditCardFolded)} higher than in YNAB: money YNAB kept aside for card payments is simply money here.</p>
    {:else if r.creditCardFolded < 0}
      <p data-testid="report-cc">Ready to Assign is {formatMoney(-r.creditCardFolded)} lower than in YNAB: card balances YNAB had not covered with payment money count as real debt here.</p>
    {/if}
    <h4>{monthLabel(build.cutoverMonth)} available, YNAB vs Magpie</h4>
    <table>
      <thead><tr><th>Category</th><th class="money">YNAB</th><th class="money">Magpie</th></tr></thead>
      <tbody>
        {#each r.cutover as c (c.categoryId)}
          <tr data-testid={`verify-${c.categoryId}`} class:mismatch={c.ynab !== c.magpie}>
            <td>{c.name}</td><td class="money">{formatMoney(c.ynab)}</td><td class="money">{formatMoney(c.magpie)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
    <h4>Account balances</h4>
    <ul>{#each r.balances as b (b.name)}<li>{b.name}: <span class="money">{formatMoney(b.working)}</span></li>{/each}</ul>
    {#if isEmpty}
      <p><button data-testid="import" onclick={() => void doImport()} disabled={busy}>{busy ? 'Importing…' : 'Import'}</button></p>
    {:else}
      <p class="error" data-testid="import-blocked">This database already has data. Delete all data in <a href="#/settings">Settings</a> first.</p>
    {/if}
  {/if}
</section>

<style>
  .import { max-width: 960px; margin: 0 auto; padding: 16px 24px; }
  .files { display: flex; gap: 24px; flex-wrap: wrap; }
  .files label { display: flex; flex-direction: column; gap: 4px; }
  .dim { color: var(--dim); }
  .error { color: var(--red); }
  .ok { color: var(--teal); }
  table { border-collapse: collapse; margin: 8px 0 16px; }
  th, td { padding: 4px 10px; border-bottom: 1px solid var(--line); text-align: left; }
  th.money, td.money { text-align: right; }
  tr.mismatch td { color: var(--red); }
  select { font: inherit; color: var(--text); background: var(--bg2); border: 1px solid var(--line); border-radius: 4px; }
  a { color: var(--blue); }
</style>
