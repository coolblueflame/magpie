<!-- Search results across every account; the query lives in the URL so results survive reload and back. -->
<script lang="ts">
  import { app } from '../state/app.svelte';
  import { kindLabel, kindOf } from '../domain/ledger';
  import { searchTransactions } from '../domain/search';
  import { formatMoney } from '../domain/money';
  import { RTA } from '../domain/types';
  import { navigate, router } from './router.svelte';

  const q = $derived(router.current.name === 'search' ? router.current.q ?? '' : '');
  const result = $derived(searchTransactions(q, app.transactionsSnap, { accounts: app.accountsSnap, categories: app.categoriesSnap, payees: app.payeesSnap }));
  const accountName = (aid: string) => app.state.accounts.find((a) => a.id === aid)?.name ?? '?';
  const categoryName = (cid: string) => (cid === RTA ? 'Ready to Assign' : app.state.categories.find((c) => c.id === cid)?.name ?? '?');
  const payeeName = (pid?: string) => (pid ? app.state.payees.find((p) => p.id === pid)?.name ?? '' : '');
  const tone = (c: number) => (c < 0 ? 'neg' : c > 0 ? 'pos' : '');
</script>

<section class="search">
  <header>
    <h2>Search</h2>
    {#if q}<span class="dim" data-testid="search-count">{result.hits.length < result.total ? `${result.hits.length} of ${result.total}` : result.total} matching “{q}”</span>{/if}
  </header>
  {#if !q}
    <p class="dim">Type in the search box above. Every word must match somewhere in the payee, memo, category, account, amount or date.</p>
  {:else if !result.total}
    <p class="dim" data-testid="search-empty">Nothing matches.</p>
  {:else}
    <table>
      <thead><tr><th>Date</th><th>Account</th><th>Payee</th><th>Category</th><th>Memo</th><th class="money">Amount</th></tr></thead>
      <tbody>
        {#each result.hits as t (t.id)}
          <tr data-testid={`hit-${t.id}`} class="hit" onclick={() => navigate({ name: 'account', id: t.accountId })}>
            <td class="dim">{t.date}</td>
            <td>{accountName(t.accountId)}</td>
            <td>{payeeName(t.payeeId)}</td>
            <td>{kindLabel(kindOf(t.lines), accountName, categoryName)}{#if t.status === 'new'} <span class="badge">new</span>{/if}</td>
            <td class="dim memo">{t.memo || t.lines.map((l) => l.memo).filter(Boolean).join('; ')}</td>
            <td class={`money ${tone(t.amount)}`}>{formatMoney(t.amount)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</section>

<style>
  .search { max-width: 1100px; margin: 0 auto; padding: 16px 24px; }
  header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 12px; }
  h2 { margin: 0; }
  .dim { color: var(--dim); }
  table { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
  th { text-align: left; color: var(--dim); font-weight: 500; padding: 6px 8px; border-bottom: 1px solid var(--line); }
  td { padding: 6px 8px; border-bottom: 1px solid var(--line); }
  .money { text-align: right; font-variant-numeric: tabular-nums; }
  .neg { color: var(--red); }
  .pos { color: var(--teal); }
  .hit { cursor: pointer; }
  .hit:hover td { background: var(--bg1); }
  .memo { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge { background: var(--amber); color: var(--bg0); border-radius: 999px; padding: 0 6px; font-size: 0.75rem; font-weight: 600; }
</style>
