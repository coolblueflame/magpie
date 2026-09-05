<!-- The undo and redo stacks as a list: click an entry to undo (or redo) everything down to it. Session-only, like the stack. -->
<script lang="ts">
  import { undoStack, type UndoEntry } from '../state/undo.svelte';
  import { toast } from './toast.svelte';

  let open = $state(false);
  const undoable = $derived([...undoStack.entries].reverse());
  const redoable = $derived([...undoStack.redoEntries].reverse());
  const when = (e: UndoEntry) => new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  async function undoTo(target: UndoEntry) {
    let n = 0;
    while (undoStack.entries.some((e) => e.id === target.id)) { if (!(await undoStack.undo())) break; n++; }
    open = false;
    toast.show(`Undid ${n} ${n === 1 ? 'step' : 'steps'}`, () => {});
  }
  async function redoTo(target: UndoEntry) {
    let n = 0;
    while (undoStack.redoEntries.some((e) => e.id === target.id)) { if (!(await undoStack.redo())) break; n++; }
    open = false;
    toast.show(`Redid ${n} ${n === 1 ? 'step' : 'steps'}`, () => {});
  }
</script>

<details class="history" bind:open data-testid="history">
  <summary data-testid="nav-history" title="Undo history (Ctrl+Z, Ctrl+Y)">History{#if undoable.length} <span class="count">{undoable.length}</span>{/if}</summary>
  <div class="panel">
    {#if !undoable.length && !redoable.length}
      <p class="dim">Nothing to undo yet. Ctrl+Z undoes, Ctrl+Y or Shift+Ctrl+Z redoes; this list covers the current visit.</p>
    {/if}
    {#if redoable.length}
      <h4>Redo</h4>
      {#each redoable as e (e.id)}<button class="entry redo" data-testid={`history-redo-${e.id}`} onclick={() => void redoTo(e)}><span>{e.label}</span><span class="dim">{when(e)}</span></button>{/each}
    {/if}
    {#if undoable.length}
      <h4>Undo</h4>
      {#each undoable as e, i (e.id)}<button class="entry" data-testid={`history-undo-${e.id}`} title={i ? `Undo this and the ${i} step${i === 1 ? '' : 's'} after it` : 'Undo'} onclick={() => void undoTo(e)}><span>{e.label}</span><span class="dim">{when(e)}</span></button>{/each}
    {/if}
  </div>
</details>

<style>
  .history { position: relative; }
  summary { list-style: none; cursor: pointer; border: 1px solid var(--line); border-radius: 6px; padding: 4px 10px; }
  summary::-webkit-details-marker { display: none; }
  summary:hover { border-color: var(--blue); }
  .count { background: var(--bg2); border-radius: 999px; padding: 0 6px; font-size: 0.8rem; color: var(--dim); }
  .panel { position: absolute; right: 0; top: 100%; z-index: 30; width: 320px; max-height: 70vh; overflow: auto;
    background: var(--bg2); border: 1px solid var(--line); border-radius: 8px; padding: 8px; display: grid; gap: 2px; }
  h4 { margin: 6px 4px 2px; color: var(--dim); font-size: 0.8rem; font-weight: 500; text-transform: uppercase; letter-spacing: 0.04em; }
  .entry { display: flex; justify-content: space-between; gap: 10px; border: none; text-align: left; padding: 5px 8px; border-radius: 4px; }
  .entry:hover { background: var(--bg1); color: var(--blue); }
  .entry.redo { color: var(--dim); }
  .dim { color: var(--dim); font-size: 0.85rem; }
  p.dim { margin: 4px; }
</style>
