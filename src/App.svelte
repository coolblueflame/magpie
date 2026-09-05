<!-- Shell: boot line until the store hydrates, then nav and the active screen. -->
<script lang="ts">
  import { app } from './lib/state/app.svelte';
  import { undoStack } from './lib/state/undo.svelte';
  import { toast } from './lib/ui/toast.svelte';
  import { navigate, router } from './lib/ui/router.svelte';
  import BudgetView from './lib/ui/BudgetView.svelte';
  import SettingsView from './lib/ui/SettingsView.svelte';
  import ImportView from './lib/ui/ImportView.svelte';
  import AccountsView from './lib/ui/AccountsView.svelte';
  import LedgerView from './lib/ui/LedgerView.svelte';
  import ReviewView from './lib/ui/ReviewView.svelte';
  import PayeesView from './lib/ui/PayeesView.svelte';
  import LoansView from './lib/ui/LoansView.svelte';
  import ChartsView from './lib/ui/ChartsView.svelte';
  const hasLoans = $derived(app.state.accounts.some((a) => a.kind === 'loan' && !a.closed));

  const onBudgetIds = $derived(new Set(app.state.accounts.filter((a) => a.onBudget).map((a) => a.id)));
  const reviewCount = $derived(app.state.transactions.filter((t) => t.status === 'new' && onBudgetIds.has(t.accountId)).length);
  import UndoToast from './lib/ui/UndoToast.svelte';

  // Global undo/redo. A focused input owns its own Ctrl+Z, so skip when one is active.
  function onKey(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod || e.key.toLowerCase() !== 'z') return;
    if (document.activeElement instanceof HTMLInputElement) return;
    e.preventDefault();
    const redo = e.shiftKey;
    void (redo ? undoStack.redo() : undoStack.undo()).then((label) => {
      if (label) toast.show(`${redo ? 'Redid' : 'Undid'} ${label}`, () => {});
    });
  }

  // Returning to the tab pulls other devices' changes (PB §2.6: a tab that is merely open never pulls).
  function onVisibility() {
    if (document.visibilityState === 'visible') void app.syncThenSweep();
  }
</script>

<svelte:window onkeydown={onKey} />
<svelte:document onvisibilitychange={onVisibility} />

{#if !app.ready}
  <p data-testid="boot" class="boot">Opening the nest…</p>
{:else}
  <nav>
    <span class="brand">Magpie</span>
    <button data-testid="nav-budget" onclick={() => navigate({ name: 'budget' })}>Budget</button>
    <button data-testid="nav-accounts" onclick={() => navigate({ name: 'accounts' })}>Accounts</button>
    <button data-testid="nav-review" onclick={() => navigate({ name: 'review' })}>Review{#if reviewCount} <span class="badge" data-testid="nav-review-count">{reviewCount}</span>{/if}</button>
    <button data-testid="nav-payees" onclick={() => navigate({ name: 'payees' })}>Payees</button>
    {#if hasLoans}<button data-testid="nav-loans" onclick={() => navigate({ name: 'loans' })}>Loans</button>{/if}
    <button data-testid="nav-charts" onclick={() => navigate({ name: 'charts' })}>Charts</button>
    <button data-testid="nav-import" onclick={() => navigate({ name: 'import' })}>Import</button>
    <button data-testid="nav-settings" onclick={() => navigate({ name: 'settings' })}>Settings</button>
  </nav>
  {#if router.current.name === 'settings'}
    <SettingsView />
  {:else if router.current.name === 'import'}
    <ImportView />
  {:else if router.current.name === 'accounts'}
    <AccountsView />
  {:else if router.current.name === 'account'}
    {#key router.current.id}<LedgerView id={router.current.id} />{/key}
  {:else if router.current.name === 'review'}
    <ReviewView />
  {:else if router.current.name === 'payees'}
    <PayeesView />
  {:else if router.current.name === 'loans'}
    <LoansView />
  {:else if router.current.name === 'charts'}
    <ChartsView />
  {:else}
    <BudgetView />
  {/if}
  <UndoToast />
{/if}

<style>
  nav { display: flex; align-items: center; gap: 8px; padding: 10px 24px; border-bottom: 1px solid var(--line); background: var(--bg1); }
  .brand { color: var(--blue); font-weight: 700; margin-right: 12px; }
  .badge { background: var(--amber); color: var(--bg0); border-radius: 999px; padding: 0 6px; font-size: 0.8rem; font-weight: 600; }
  .boot { color: var(--dim); padding: 24px; }
</style>
