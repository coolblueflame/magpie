<script lang="ts">
  import { toast } from './toast.svelte';
</script>

{#if toast.current}
  <div class="toast" data-testid="undo-toast">
    <span>{toast.current.label}</span>
    <button data-testid="undo-toast-button" onclick={() => toast.undo()}>Undo</button>
  </div>
{/if}

<style>
  .toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
    background: var(--bg2); border: 1px solid var(--line); border-radius: 8px;
    padding: 8px 12px; display: flex; gap: 12px; align-items: center; }
</style>
