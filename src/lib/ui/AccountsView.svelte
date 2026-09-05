<!-- Accounts with working and cleared balances, budget accounts apart from tracking accounts (spec §6). -->
<script lang="ts">
  import { app } from '../state/app.svelte';
  import { accountBalances } from '../domain/ledger';
  import { formatMoney } from '../domain/money';
  import { navigate } from './router.svelte';
  import type { Account, AccountKind } from '../domain/types';
  import { undoStack } from '../state/undo.svelte';
  import { toast } from './toast.svelte';
  import { focusOnMount } from './focusOnMount';

  const KINDS: AccountKind[] = ['chequing', 'savings', 'credit', 'cash', 'person', 'loan', 'investment', 'other'];
  let showClosed = $state(false);
  let adding = $state(false);
  let newName = $state('');
  let newKind = $state<AccountKind>('chequing');
  let newOnBudget = $state(true);
  async function addAccount() {
    const name = newName.trim();
    if (!name) return;
    adding = false;
    newName = '';
    await app.addAccount(name, newKind, newOnBudget);
    toast.show(`Added ${name}`, () => void undoStack.undo());
  }
  const balances = $derived(accountBalances(app.state.accounts, $state.snapshot(app.state.transactions)));
  const list = (onBudget: boolean) => app.state.accounts
    .filter((a) => a.onBudget === onBudget && (showClosed || !a.closed))
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const total = (accts: Account[]) => accts.reduce((t, a) => t + (balances.get(a.id)?.working ?? 0), 0);
  const tone = (c: number) => (c < 0 ? 'neg' : c > 0 ? 'pos' : '');
</script>

<section class="accounts">
  <header>
    <h2>Accounts</h2>
    <label class="toggle"><input type="checkbox" data-testid="show-closed" bind:checked={showClosed} /> Show closed</label>
    {#if adding}
      <input data-testid="new-account-name" placeholder="Account name" bind:value={newName} use:focusOnMount
        onkeydown={(e) => { if (e.key === 'Enter') void addAccount(); if (e.key === 'Escape') adding = false; }} />
      <select data-testid="new-account-kind" bind:value={newKind}>{#each KINDS as k}<option value={k}>{k}</option>{/each}</select>
      <label class="toggle"><input type="checkbox" data-testid="new-account-onbudget" bind:checked={newOnBudget} disabled={newKind === 'person'} /> On budget</label>
      <button data-testid="new-account-save" onclick={() => void addAccount()}>Add</button>
    {:else}
      <button data-testid="add-account" onclick={() => (adding = true)}>Add account</button>
    {/if}
    <span class="spacer"></span>
    <span class="dim">Net worth</span> <span class={`money big ${tone(total(app.state.accounts))}`} data-testid="net-worth">{formatMoney(total(app.state.accounts))}</span>
  </header>
  {#each [{ key: 'budget', title: 'Budget accounts', on: true }, { key: 'tracking', title: 'Tracking accounts', on: false }] as sec (sec.key)}
    {@const accts = list(sec.on)}
    <h3>{sec.title} <span class={`money ${tone(total(accts))}`} data-testid={`acct-total-${sec.key}`}>{formatMoney(total(accts))}</span></h3>
    <table>
      <thead><tr><th>Account</th><th>Kind</th><th class="money">Working</th><th class="money">Cleared</th></tr></thead>
      <tbody>
        {#each accts as a (a.id)}
          {@const b = balances.get(a.id)}
          <tr data-testid={`acct-${a.id}`} class:closed={a.closed} onclick={() => navigate({ name: 'account', id: a.id })}>
            <td>{a.name}</td>
            <td class="dim">{a.kind}</td>
            <td class={`money ${tone(b?.working ?? 0)}`} data-testid={`acct-working-${a.id}`}>{formatMoney(b?.working ?? 0)}</td>
            <td class={`money ${tone(b?.cleared ?? 0)}`} data-testid={`acct-cleared-${a.id}`}>{formatMoney(b?.cleared ?? 0)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/each}
</section>

<style>
  .accounts { max-width: 960px; margin: 0 auto; padding: 16px 24px; }
  header { display: flex; align-items: baseline; gap: 12px; }
  h2 { margin: 0; }
  .spacer { flex: 1; }
  .dim { color: var(--dim); }
  .big { font-size: 1.3rem; }
  .toggle { color: var(--dim); font-size: 0.9rem; display: flex; align-items: center; gap: 4px; }
  select { font: inherit; color: var(--text); background: var(--bg2); border: 1px solid var(--line); border-radius: 4px; }
  h3 { color: var(--blue); display: flex; justify-content: space-between; margin: 20px 0 6px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; color: var(--dim); font-weight: 500; padding: 6px 8px; border-bottom: 1px solid var(--line); }
  th.money { text-align: right; }
  td { padding: 8px; border-bottom: 1px solid var(--line); }
  tbody tr { cursor: pointer; }
  tbody tr:hover td { background: var(--bg1); }
  tr.closed td { color: var(--dim); font-style: italic; }
</style>
