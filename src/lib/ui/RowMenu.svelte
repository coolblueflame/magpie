<!-- A small "…" menu. A native <details> so it needs no outside-click plumbing. -->
<script lang="ts">
  let { testid, items }: { testid: string; items: { label: string; testid: string; run: () => void }[] } = $props();
  let open = $state(false);
</script>

<details class="menu" bind:open data-testid={testid}>
  <summary aria-label="More">…</summary>
  <div class="items">
    {#each items as it (it.testid)}
      <button data-testid={it.testid} onclick={() => { open = false; it.run(); }}>{it.label}</button>
    {/each}
  </div>
</details>

<style>
  .menu { display: inline-block; position: relative; margin-left: 6px; }
  summary { list-style: none; cursor: pointer; color: var(--dim); padding: 0 6px; border-radius: 4px; opacity: 0.35; }
  :global(tr:hover) summary, .menu[open] summary { opacity: 1; }
  summary::-webkit-details-marker { display: none; }
  summary:hover { color: var(--blue); background: var(--bg2); }
  .items { position: absolute; left: 0; top: 100%; z-index: 10; display: grid; min-width: 150px;
    background: var(--bg2); border: 1px solid var(--line); border-radius: 6px; padding: 4px; }
  .items button { border: none; text-align: left; padding: 6px 10px; border-radius: 4px; }
  .items button:hover { background: var(--bg1); color: var(--blue); }
</style>
