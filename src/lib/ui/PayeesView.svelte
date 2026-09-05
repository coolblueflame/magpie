<!-- Payees: usage, rename, merge (spec §4.5). Every view groups by payee, so tidy names here pay off everywhere. -->
<script lang="ts">
  import { app } from '../state/app.svelte';
  import { undoStack } from '../state/undo.svelte';
  import { toast } from './toast.svelte';
  import { payeeUsage } from '../domain/payees';
  import { focusOnMount } from './focusOnMount';

  let search = $state('');
  let renaming = $state<string | null>(null);
  let draft = $state('');
  let picked = $state<string[]>([]);
  let mergeInto = $state('');

  const usage = $derived(payeeUsage(app.transactionsSnap));
  const rows = $derived([...app.state.payees]
    .filter((p) => !search || p.name.toLowerCase().includes(search.toLowerCase()) || p.aliases.some((a) => a.includes(search.toLowerCase())))
    .sort((a, b) => a.name.localeCompare(b.name)));

  async function commitRename(id: string, old: string) {
    if (renaming !== id) return;
    renaming = null;
    const name = draft.trim();
    if (!name || name === old) return;
    await app.renamePayee(id, name);
    toast.show(`Renamed ${old}`, () => void undoStack.undo());
  }
  function toggle(id: string, on: boolean) {
    picked = on ? [...picked, id] : picked.filter((x) => x !== id);
    if (!picked.includes(mergeInto)) mergeInto = picked[0] ?? '';
  }
  async function merge() {
    const n = picked.length;
    await app.mergePayees(picked, mergeInto);
    picked = [];
    mergeInto = '';
    toast.show(`Merged ${n} payees`, () => void undoStack.undo());
  }
</script>

<section class="payees">
  <header>
    <h2>Payees</h2>
    <input data-testid="pay-search" placeholder="Search" bind:value={search} />
    <span class="dim">{rows.length} of {app.state.payees.length}</span>
    <span class="spacer"></span>
    {#if picked.length >= 2}
      <label class="dim">Merge into
        <select data-testid="merge-into" bind:value={mergeInto}>
          {#each picked as id (id)}<option value={id}>{app.state.payees.find((p) => p.id === id)?.name}</option>{/each}
        </select>
      </label>
      <button data-testid="merge" class="primary" onclick={() => void merge()}>Merge {picked.length}</button>
    {/if}
  </header>
  <table>
    <thead><tr><th></th><th>Payee</th><th class="money">Transactions</th><th>Last used</th><th>Also known as</th></tr></thead>
    <tbody>
      {#each rows as p (p.id)}
        {@const u = usage.get(p.id)}
        <tr data-testid={`pay-${p.id}`}>
          <td><input type="checkbox" data-testid={`pay-pick-${p.id}`} checked={picked.includes(p.id)} onchange={(e) => toggle(p.id, e.currentTarget.checked)} /></td>
          <td>
            {#if renaming === p.id}
              <input data-testid={`pay-rename-${p.id}`} bind:value={draft} use:focusOnMount
                onkeydown={(e) => { if (e.key === 'Enter') void commitRename(p.id, p.name); if (e.key === 'Escape') renaming = null; }}
                onblur={() => void commitRename(p.id, p.name)} />
            {:else}
              <button class="name" data-testid={`pay-name-${p.id}`} title="Rename" onclick={() => { renaming = p.id; draft = p.name; }}>{p.name}</button>
            {/if}
          </td>
          <td class="money">{u?.count ?? 0}</td>
          <td class="dim date">{u?.last ?? ''}</td>
          <td class="dim">{p.aliases.join(', ')}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</section>

<style>
  .payees { max-width: 1000px; margin: 0 auto; padding: 16px 24px; }
  header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
  h2 { margin: 0; }
  .dim { color: var(--dim); }
  .spacer { flex: 1; }
  .primary { border-color: var(--blue); color: var(--blue); }
  select { font: inherit; color: var(--text); background: var(--bg2); border: 1px solid var(--line); border-radius: 4px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; color: var(--dim); font-weight: 500; padding: 6px 8px; border-bottom: 1px solid var(--line); }
  th.money { text-align: right; }
  td { padding: 5px 8px; border-bottom: 1px solid var(--line); }
  td.money { text-align: right; font-family: var(--font-mono); }
  td.date { font-family: var(--font-mono); font-size: 0.9rem; }
  .name { border: none; padding: 0; text-align: left; }
  .name:hover { color: var(--blue); }
</style>
