<!-- One select for a line's target: Ready to Assign, a category, or a transfer to another account. -->
<script lang="ts">
  import { app } from '../state/app.svelte';
  import { RTA } from '../domain/types';
  import type { LineTarget } from '../domain/transactions';

  let { value, accountId, testid, mode = 'full', onChange }: {
    value: LineTarget; accountId: string; testid: string; mode?: 'full' | 'categories'; onChange: (t: LineTarget) => void;
  } = $props();

  const encode = (t: LineTarget): string =>
    t.type === 'category' ? (t.categoryId === RTA ? 'rta' : `cat:${t.categoryId}`) : t.type === 'transfer' ? `xfer:${t.accountId}` : '';
  function decode(v: string): LineTarget {
    if (!v) return { type: 'none' };
    if (v === 'rta') return { type: 'category', categoryId: RTA };
    if (v.startsWith('cat:')) return { type: 'category', categoryId: v.slice(4) };
    const acct = v.slice(5);
    // Re-picking the same transfer account keeps the far side's state.
    return value.type === 'transfer' && value.accountId === acct ? value : { type: 'transfer', accountId: acct };
  }
  const groups = $derived([...app.state.groups].filter((g) => !g.hidden).sort((a, b) => a.sortOrder - b.sortOrder));
  const cats = (gid: string) => app.state.categories.filter((c) => c.groupId === gid && !c.hidden).sort((a, b) => a.sortOrder - b.sortOrder);
  const accounts = $derived(app.state.accounts.filter((a) => !a.closed && a.id !== accountId).sort((a, b) => a.sortOrder - b.sortOrder));
  /** The current value kept as an option when it is not in the visible lists, so the select never shows blank for a real value. */
  const fallback = $derived.by((): { value: string; label: string } | null => {
    if (value.type === 'category' && value.categoryId !== RTA) {
      const c = app.state.categories.find((x) => x.id === value.categoryId);
      const g = c && app.state.groups.find((x) => x.id === c.groupId);
      if (!c || c.hidden || !g || g.hidden) return { value: encode(value), label: `${c?.name ?? 'Unknown category'} (hidden)` };
    }
    if (value.type === 'transfer' && mode === 'full') {
      const a = app.state.accounts.find((x) => x.id === value.accountId);
      if (!a || a.closed || a.id === accountId) return { value: encode(value), label: `Transfer to ${a?.name ?? '?'} (closed)` };
    }
    return null;
  });
</script>

<select data-testid={testid} value={encode(value)} onchange={(e) => onChange(decode(e.currentTarget.value))}>
  <option value="">Choose…</option>
  {#if fallback}<option value={fallback.value}>{fallback.label}</option>{/if}
  <option value="rta">Ready to Assign</option>
  {#each groups as g (g.id)}
    <optgroup label={g.name}>
      {#each cats(g.id) as c (c.id)}<option value={`cat:${c.id}`}>{c.name}</option>{/each}
    </optgroup>
  {/each}
  {#if mode === 'full'}
    <optgroup label="Transfer to">
      {#each accounts as a (a.id)}<option value={`xfer:${a.id}`}>{a.name}</option>{/each}
    </optgroup>
  {/if}
</select>

<style>
  select { font: inherit; color: var(--text); background: var(--bg2); border: 1px solid var(--line); border-radius: 4px; padding: 3px 6px; max-width: 240px; }
</style>
