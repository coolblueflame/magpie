<!-- An inline-editable amount: click to edit, Enter or blur commits, Escape cancels, unparseable text keeps the editor open. -->
<script lang="ts">
  import { formatCents, formatMoney, parseCents } from '../domain/money';
  import { focusOnMount } from './focusOnMount';
  import type { Cents } from '../domain/types';

  let { value, testid, inputTestid, tone = '', title = '', onCommit }: {
    value: Cents; testid: string; inputTestid: string; tone?: string; title?: string;
    onCommit: (cents: Cents) => void | Promise<void>;
  } = $props();

  let editing = $state(false);
  let draft = $state('');
  let invalid = $state(false);

  function start() { editing = true; draft = formatCents(value); invalid = false; }
  function commit() {
    if (!editing) return;
    const cents = parseCents(draft);
    if (cents === null) { invalid = true; return; }
    editing = false;
    if (cents !== value) void onCommit(cents);
  }
  function cancel() { editing = false; invalid = false; }
</script>

{#if editing}
  <input data-testid={inputTestid} class:invalid bind:value={draft} use:focusOnMount
    onkeydown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') cancel(); }}
    onblur={commit} />
{:else}
  <button class={`cell money ${tone}`} data-testid={testid} {title} onclick={start}>{formatMoney(value)}</button>
{/if}

<style>
  .cell { border: none; padding: 0; text-align: right; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
  .cell:hover { color: var(--blue); }
  input { width: 110px; text-align: right; font-family: var(--font-mono); }
  input.invalid { outline: 1px solid var(--red); border-color: var(--red); }
</style>
