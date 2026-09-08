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
  import UndoHistory from './lib/ui/UndoHistory.svelte';
  import SearchView from './lib/ui/SearchView.svelte';
  const hasLoans = $derived(app.state.accounts.some((a) => a.kind === 'loan' && !a.closed));
  const syncLabel = $derived.by(() => {
    switch (app.syncStatus) {
      case 'syncing': return 'Syncing…';
      case 'error': return 'Sync error';
      case 'offline': return 'Offline';
      case 'disabled': return 'Sync off';
      default: return app.lastSyncAt ? `Synced ${new Date(app.lastSyncAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Synced';
    }
  });

  const onBudgetIds = $derived(new Set(app.state.accounts.filter((a) => a.onBudget).map((a) => a.id)));
  const reviewCount = $derived(app.state.transactions.filter((t) => t.status === 'new' && onBudgetIds.has(t.accountId)).length);
  import UndoToast from './lib/ui/UndoToast.svelte';

  /** The nav search box. Typing on the results screen narrows live; Enter searches from anywhere. */
  let searchEl = $state<HTMLInputElement | null>(null);
  let query = $state('');
  $effect(() => { if (router.current.name === 'search') query = router.current.q ?? ''; });
  function search(live: boolean) {
    if (live && router.current.name !== 'search') return;
    navigate({ name: 'search', q: query.trim() });
  }

  // Global keys: / focuses search; Ctrl/Cmd+Z, Shift+Ctrl/Cmd+Z and Ctrl+Y (Windows) undo and redo.
  // A focused text field owns its own keys.
  function onKey(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    const el = document.activeElement;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return;
    if (key === '/' && !mod) { e.preventDefault(); searchEl?.focus(); return; }
    if (!mod || (key !== 'z' && key !== 'y')) return;
    e.preventDefault();
    const redo = key === 'y' || e.shiftKey;
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
    <span class="brand"><img class="mark" src={`${import.meta.env.BASE_URL}icons/icon.svg`} alt="" width="22" height="22" /> Magpie</span>
    <button data-testid="nav-budget" onclick={() => navigate({ name: 'budget' })}>Budget</button>
    <button data-testid="nav-accounts" onclick={() => navigate({ name: 'accounts' })}>Accounts</button>
    <button data-testid="nav-review" onclick={() => navigate({ name: 'review' })}>Review{#if reviewCount} <span class="badge" data-testid="nav-review-count">{reviewCount}</span>{/if}</button>
    <button data-testid="nav-payees" onclick={() => navigate({ name: 'payees' })}>Payees</button>
    {#if hasLoans}<button data-testid="nav-loans" onclick={() => navigate({ name: 'loans' })}>Loans</button>{/if}
    <button data-testid="nav-charts" onclick={() => navigate({ name: 'charts' })}>Charts</button>
    <button data-testid="nav-import" onclick={() => navigate({ name: 'import' })}>Import</button>
    <button data-testid="nav-settings" onclick={() => navigate({ name: 'settings' })}>Settings</button>
    <span class="spacer"></span>
    <input class="search" data-testid="nav-search" type="search" placeholder="Search  /" aria-label="Search transactions" bind:this={searchEl} bind:value={query}
      oninput={() => search(true)} onkeydown={(e) => { if (e.key === 'Enter') search(false); if (e.key === 'Escape') searchEl?.blur(); }} />
    {#if app.syncTarget}
      <button class={`sync ${app.syncStatus}`} data-testid="nav-sync" title={app.syncDetail || app.syncStatus} onclick={() => navigate({ name: 'settings' })}>
        <span class="dot"></span>{syncLabel}
      </button>
    {/if}
    <UndoHistory />
  </nav>
  {#if router.current.name === 'settings'}
    <SettingsView />
  {:else if router.current.name === 'import'}
    <ImportView />
  {:else if router.current.name === 'accounts'}
    <AccountsView />
  {:else if router.current.name === 'account'}
    {#key router.current.id}<LedgerView id={router.current.id} focus={router.current.focus} />{/key}
  {:else if router.current.name === 'review'}
    <ReviewView />
  {:else if router.current.name === 'payees'}
    <PayeesView />
  {:else if router.current.name === 'loans'}
    <LoansView />
  {:else if router.current.name === 'charts'}
    <ChartsView />
  {:else if router.current.name === 'search'}
    <SearchView />
  {:else}
    <BudgetView />
  {/if}
  <UndoToast />
{/if}

<style>
  nav { display: flex; align-items: center; gap: 8px; padding: 10px 24px; border-bottom: 1px solid var(--line); background: var(--bg1); }
  .spacer { flex: 1; }
  .search { width: 200px; font-size: 0.9rem; }
  .sync { display: inline-flex; align-items: center; gap: 6px; color: var(--dim); font-size: 0.85rem; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--teal); }
  .sync.syncing .dot { background: var(--blue); }
  .sync.error .dot, .sync.offline .dot { background: var(--red); }
  .sync.error, .sync.offline { color: var(--red); border-color: var(--red); }
  .brand { color: var(--blue); font-weight: 700; margin-right: 12px; display: inline-flex; align-items: center; gap: 6px; }
  .mark { border-radius: 5px; display: block; }
  .badge { background: var(--amber); color: var(--bg0); border-radius: 999px; padding: 0 6px; font-size: 0.8rem; font-weight: 600; }
  .boot { color: var(--dim); padding: 24px; }
</style>
