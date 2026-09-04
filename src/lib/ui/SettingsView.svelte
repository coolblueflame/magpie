<script lang="ts">
  import { app } from '../state/app.svelte';
  async function loadSeed() {
    if (app.state.transactions.length && !confirm('Add the sample data on top of what is here?')) return;
    await app.loadSeed();
  }
</script>

<section class="settings">
  <h2>Settings</h2>
  <p>Version <span data-testid="version">{__APP_VERSION__}</span></p>
  <p>Storage persistence: <span data-testid="persistence">{app.persistentStorage}</span></p>
  <p><button data-testid="load-seed" onclick={loadSeed}>Load sample data</button></p>
</section>

<style>
  .settings { max-width: 960px; margin: 0 auto; padding: 16px 24px; }
</style>
