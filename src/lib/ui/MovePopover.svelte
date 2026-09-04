<!-- Move money from one category (or Ready to Assign) to another in the shown month (spec §4.2). -->
<script lang="ts">
  import { formatCents, parseCents } from '../domain/money';
  import { RTA, type Category, type CategoryGroup, type Cents } from '../domain/types';
  import { focusOnMount } from './focusOnMount';

  let { from, fromName, amount: initial, groups, categories, onMove, onClose }: {
    from: string; fromName: string; amount: Cents; groups: CategoryGroup[]; categories: Category[];
    onMove: (to: string, amount: Cents) => void | Promise<void>; onClose: () => void;
  } = $props();

  // The popover is mounted fresh each time it opens, so capturing the initial props is the intent.
  // svelte-ignore state_referenced_locally
  let amount = $state(initial > 0 ? formatCents(initial) : '');
  // svelte-ignore state_referenced_locally
  let to = $state(from === RTA ? '' : RTA);
  let invalid = $state(false);

  function confirm() {
    const cents = parseCents(amount);
    if (cents === null || cents <= 0 || !to || to === from) { invalid = true; return; }
    void onMove(to, cents);
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter') confirm();
    if (e.key === 'Escape') onClose();
  }
</script>

<div class="popover" data-testid="move-popover" role="dialog" aria-label="Move money">
  <div class="title">Move from {fromName}</div>
  <label>Amount <input data-testid="move-amount" class:invalid bind:value={amount} use:focusOnMount onkeydown={onKey} /></label>
  <label>To
    <select data-testid="move-to" class:invalid={invalid && !to} bind:value={to} onkeydown={onKey}>
      {#if from !== RTA}<option value={RTA}>Ready to Assign</option>{/if}
      {#each groups as g (g.id)}
        <optgroup label={g.name}>
          {#each categories.filter((c) => c.groupId === g.id && c.id !== from) as c (c.id)}
            <option value={c.id}>{c.name}</option>
          {/each}
        </optgroup>
      {/each}
    </select>
  </label>
  <div class="actions">
    <button data-testid="move-confirm" onclick={confirm}>Move</button>
    <button data-testid="move-cancel" onclick={onClose}>Cancel</button>
  </div>
</div>

<style>
  .popover { position: absolute; right: 0; top: 100%; z-index: 20; min-width: 280px; text-align: left;
    background: var(--bg2); border: 1px solid var(--blue-deep); border-radius: 8px; padding: 12px; display: grid; gap: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4); font-family: var(--font-sans); font-size: 0.95rem; }
  .title { color: var(--blue); font-weight: 600; }
  label { display: grid; gap: 4px; color: var(--dim); }
  input, select { font-family: var(--font-mono); color: var(--text); background: var(--bg1); border: 1px solid var(--line); border-radius: 4px; padding: 4px 6px; }
  input { text-align: right; }
  .invalid { outline: 1px solid var(--red); border-color: var(--red); }
  .actions { display: flex; gap: 8px; justify-content: flex-end; }
</style>
