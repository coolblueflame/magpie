<!-- Accounts with working and cleared balances, budget accounts apart from tracking accounts (spec §6). -->
<script lang="ts">
  import { app } from '../state/app.svelte';
  import { accountBalances } from '../domain/ledger';
  import { formatMoney } from '../domain/money';
  import { navigate } from './router.svelte';
  import type { Account, AccountKind } from '../domain/types';
  import { toast, undoToast } from './toast.svelte';
  import { focusOnMount } from './focusOnMount';
  import RowMenu from './RowMenu.svelte';
  import { PERSON_HELP } from './help';

  let renaming = $state<string | null>(null);
  let renameDraft = $state('');
  async function commitRename(a: Account) {
    if (renaming !== a.id) return;
    renaming = null;
    const name = renameDraft.trim();
    if (!name || name === a.name) return;
    await app.renameAccount(a.id, name);
    undoToast(`Renamed ${a.name}`);
  }
  async function toggleClosed(a: Account) {
    await app.setAccountClosed(a.id, !a.closed);
    undoToast(`${a.closed ? 'Reopened' : 'Closed'} ${a.name}`);
  }
  let editingKind = $state<string | null>(null);
  let kindDraft = $state<AccountKind>('chequing');
  let onBudgetDraft = $state(true);
  function startKind(a: Account) { editingKind = a.id; kindDraft = a.kind; onBudgetDraft = a.onBudget; }
  async function saveKind(a: Account) {
    editingKind = null;
    if (kindDraft === a.kind && (onBudgetDraft || kindDraft === 'person') === a.onBudget) return;
    await app.setAccountKind(a.id, kindDraft, onBudgetDraft);
    undoToast(`Changed ${a.name}`);
  }
  const items = (a: Account) => [
    { label: 'Rename', testid: `acct-menu-${a.id}-rename`, run: () => { renaming = a.id; renameDraft = a.name; } },
    { label: 'Change kind', testid: `acct-menu-${a.id}-kind`, run: () => startKind(a) },
    { label: a.closed ? 'Reopen' : 'Close', testid: `acct-menu-${a.id}-close`, run: () => void toggleClosed(a) },
  ];

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
    undoToast(`Added ${name}`);
  }
  const balances = $derived(accountBalances(app.accountsSnap, app.transactionsSnap));
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
      {#if newKind === 'person'}<span class="dim small" data-testid="person-help">{PERSON_HELP}</span>{/if}
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
          <tr data-testid={`acct-${a.id}`} class:closed={a.closed} onclick={(e) => { if (!(e.target as HTMLElement).closest('button, input, select, details, label')) navigate({ name: 'account', id: a.id }); }}>
            <td>
              {#if renaming === a.id}
                <input data-testid={`acct-rename-${a.id}`} bind:value={renameDraft} use:focusOnMount
                  onkeydown={(e) => { if (e.key === 'Enter') void commitRename(a); if (e.key === 'Escape') renaming = null; }} onblur={() => void commitRename(a)} />
              {:else}
                <button class="name" onclick={() => navigate({ name: 'account', id: a.id })}>{a.name}</button><RowMenu testid={`acct-menu-${a.id}`} items={items(a)} />
              {/if}
            </td>
            <td class="dim">
              {#if editingKind === a.id}
                <span class="kindform">
                  <select data-testid={`acct-kind-${a.id}`} bind:value={kindDraft}>{#each KINDS as k}<option value={k}>{k}</option>{/each}</select>
                  <label class="toggle"><input type="checkbox" data-testid={`acct-onbudget-${a.id}`} bind:checked={onBudgetDraft} disabled={kindDraft === 'person'} /> On budget</label>
                  <button data-testid={`acct-kind-save-${a.id}`} onclick={() => void saveKind(a)}>Save</button>
                  <button onclick={() => (editingKind = null)}>Cancel</button>
                  {#if (onBudgetDraft || kindDraft === 'person') !== a.onBudget}<span class="warn">Moves this balance {a.onBudget ? 'out of' : 'into'} Ready to Assign.</span>{/if}
                  {#if kindDraft === 'person'}<span class="small">{PERSON_HELP}</span>{/if}
                </span>
              {:else}{a.kind}{/if}
            </td>
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
  .name { border: none; padding: 0; text-align: left; font: inherit; }
  .name:hover { color: var(--blue); }
  .small { font-size: 0.85rem; max-width: 520px; }
  .kindform { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .warn { color: var(--amber); font-size: 0.85rem; }
</style>
