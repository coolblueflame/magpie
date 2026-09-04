<script lang="ts">
  import { app } from '../state/app.svelte';

  let error = $state('');
  let armed = $state(false);
  let armTimer: ReturnType<typeof setTimeout> | undefined;

  async function loadSeed() {
    if (app.state.transactions.length && !confirm('Add the sample data on top of what is here?')) return;
    await app.loadSeed();
  }

  async function exportJson() {
    const text = await app.exportJson();
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `magpie-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function importJson(e: Event) {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    error = '';
    try { await app.importJson(await file.text()); }
    catch (err) { error = (err as Error).message; }
  }

  // Armed confirm (PB §4 UX patterns): first click arms for 5 s, second click acts, blur disarms.
  function deleteAll() {
    if (!armed) {
      armed = true;
      armTimer = setTimeout(() => (armed = false), 5000);
      return;
    }
    disarm();
    void app.deleteAllData();
  }
  function disarm() { armed = false; clearTimeout(armTimer); }
</script>

<section class="settings">
  <h2>Settings</h2>
  <p>Version <span data-testid="version">{__APP_VERSION__}</span></p>
  <p>Storage persistence: <span data-testid="persistence">{app.persistentStorage}</span></p>

  <h3>Data</h3>
  <p><button data-testid="export-json" onclick={() => void exportJson()}>Export backup (JSON)</button></p>
  <p><label>Restore a backup into an empty database <input type="file" accept=".json,application/json" data-testid="import-json" onchange={(e) => void importJson(e)} /></label></p>
  <p><button data-testid="load-seed" onclick={() => void loadSeed()}>Load sample data</button></p>
  <p>
    <button data-testid="delete-all" class:armed onclick={deleteAll} onblur={disarm}>{armed ? 'Really delete everything?' : 'Delete all data'}</button>
    {#if armed}<span data-testid="delete-all-armed" class="warn">Click again within 5 seconds. This cannot be undone.</span>{/if}
  </p>
  {#if error}<p class="error" data-testid="settings-error">{error}</p>{/if}
</section>

<style>
  .settings { max-width: 960px; margin: 0 auto; padding: 16px 24px; }
  .error { color: var(--red); }
  .warn { color: var(--amber); margin-left: 8px; }
  button.armed { border-color: var(--red); color: var(--red); }
</style>
