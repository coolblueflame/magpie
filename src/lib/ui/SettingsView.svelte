<script lang="ts">
  import { app } from '../state/app.svelte';

  let error = $state('');
  let armed = $state(false);
  let owner = $state('');
  let repo = $state('magpie-data');
  let token = $state('');
  let syncError = $state('');
  let connecting = $state(false);
  async function connect() {
    syncError = '';
    connecting = true;
    try { await app.connectSync({ owner: owner.trim(), repo: repo.trim(), token: token.trim() }); token = ''; }
    catch (err) { syncError = (err as Error).message; }
    finally { connecting = false; }
  }
  const lastSync = $derived(app.lastSyncAt ? new Date(app.lastSyncAt).toLocaleTimeString() : 'never');
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

  {#if app.updateReady}<p class="warn" data-testid="update-ready">A new version is installed. <button data-testid="reload-app" onclick={() => location.reload()}>Reload</button></p>{/if}

  <h3>Sync</h3>
  {#if app.syncTarget}
    <p data-testid="sync-status">Connected to <b>{app.syncTarget.owner}/{app.syncTarget.repo}</b>: {app.syncStatus}{app.syncDetail ? `, ${app.syncDetail}` : ''}. Last sync <span data-testid="sync-last">{lastSync}</span>.</p>
    <p><button data-testid="sync-now" onclick={() => void app.syncNow()}>Sync now</button> <button data-testid="sync-disconnect" onclick={() => void app.disconnectSync()}>Disconnect this device</button></p>
  {:else}
    <p class="dim">Keep the data in a private GitHub repository so it survives this browser and follows you to another machine.</p>
    <div class="row">
      <label>Owner <input data-testid="sync-owner" bind:value={owner} placeholder="github user" /></label>
      <label>Repository <input data-testid="sync-repo" bind:value={repo} /></label>
      <label>Token <input data-testid="sync-token" type="password" bind:value={token} placeholder="github_pat_…" /></label>
      <button data-testid="sync-connect" disabled={connecting || !owner.trim() || !repo.trim() || !token.trim()} onclick={() => void connect()}>{connecting ? 'Connecting…' : 'Connect and sync'}</button>
    </div>
    {#if syncError}<p class="error" data-testid="sync-error">{syncError}</p>{/if}
  {/if}
  <p class="dim small" data-testid="sync-privacy">
    Plain facts: the only network destination is api.github.com. GitHub can read a private repository. Git history keeps
    everything ever synced, including deleted rows. The token is stored unencrypted on this device only and is never
    synced or included in a backup. Never make the data repository public.
  </p>

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
  .dim { color: var(--dim); }
  .small { font-size: 0.85rem; max-width: 720px; }
  .row { display: flex; gap: 12px; align-items: end; flex-wrap: wrap; }
  .row label { display: grid; gap: 3px; color: var(--dim); font-size: 0.9rem; }
  .warn { color: var(--amber); margin-left: 8px; }
  button.armed { border-color: var(--red); color: var(--red); }
</style>
