<!-- Shell: boot line until the store hydrates, then nav and the active screen. -->
<script lang="ts">
  import { app } from './lib/state/app.svelte';
  import { undoStack } from './lib/state/undo.svelte';
  import { toast } from './lib/ui/toast.svelte';
  import { navigate, router } from './lib/ui/router.svelte';
  import BudgetView from './lib/ui/BudgetView.svelte';
  import SettingsView from './lib/ui/SettingsView.svelte';
  import ImportView from './lib/ui/ImportView.svelte';
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
</script>

<svelte:window onkeydown={onKey} />

{#if !app.ready}
  <p data-testid="boot" class="boot">Opening the nest…</p>
{:else}
  <nav>
    <span class="brand">Magpie</span>
    <button data-testid="nav-budget" onclick={() => navigate({ name: 'budget' })}>Budget</button>
    <button data-testid="nav-import" onclick={() => navigate({ name: 'import' })}>Import</button>
    <button data-testid="nav-settings" onclick={() => navigate({ name: 'settings' })}>Settings</button>
  </nav>
  {#if router.current.name === 'settings'}
    <SettingsView />
  {:else if router.current.name === 'import'}
    <ImportView />
  {:else}
    <BudgetView />
  {/if}
  <UndoToast />
{/if}

<style>
  nav { display: flex; align-items: center; gap: 8px; padding: 10px 24px; border-bottom: 1px solid var(--line); background: var(--bg1); }
  .brand { color: var(--blue); font-weight: 700; margin-right: 12px; }
  .boot { color: var(--dim); padding: 24px; }
</style>
