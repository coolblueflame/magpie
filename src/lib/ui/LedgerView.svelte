<!-- One account's ledger: transfers on both sides, running balance, inline editing, a render budget (spec §6). -->
<script lang="ts">
  import { app } from '../state/app.svelte';
  import { undoStack } from '../state/undo.svelte';
  import { toast, undoToast } from './toast.svelte';
  import { accountBalances, ledgerRows, type LedgerKind, type LedgerRow } from '../domain/ledger';
  import { formatMoney } from '../domain/money';
  import { todayKey } from '../domain/month';
  import { draftFromTransaction, emptyDraft, type TxDraft } from '../domain/transactions';
  import { RTA } from '../domain/types';
  import { navigate } from './router.svelte';
  import TransactionEditor from './TransactionEditor.svelte';

  let { id }: { id: string } = $props();
  const PAGE = 100;

  const account = $derived(app.state.accounts.find((a) => a.id === id));
  const rows = $derived(ledgerRows(id, app.transactionsSnap));
  const balance = $derived(accountBalances(app.accountsSnap, app.transactionsSnap).get(id));
  let limit = $state(PAGE);
  /** A ledger row id being edited, or 'new' for the add form. */
  let editing = $state<string | null>(null);

  const accountName = (aid: string) => app.state.accounts.find((a) => a.id === aid)?.name ?? '?';
  const categoryName = (cid: string) => (cid === RTA ? 'Ready to Assign' : app.state.categories.find((c) => c.id === cid)?.name ?? '?');
  const payeeName = (pid?: string) => (pid ? app.state.payees.find((p) => p.id === pid)?.name ?? '' : '');
  function label(k: LedgerKind): string {
    if (k.type === 'split') return `Split (${k.lines})`;
    if (k.type === 'transfer') return `Transfer: ${accountName(k.accountId)}${k.categoryId ? ` · ${categoryName(k.categoryId)}` : ''}`;
    return k.categoryId ? categoryName(k.categoryId) : '';
  }
  const tone = (c: number) => (c < 0 ? 'neg' : c > 0 ? 'pos' : '');

  function draftFor(row: LedgerRow): { draft: TxDraft; payee: string; note: string; shared: { accountId: string; percent: number } | null } {
    const tx = app.state.transactions.find((t) => t.id === row.txId)!;
    return {
      draft: draftFromTransaction($state.snapshot(tx)), payee: payeeName(tx.payeeId), shared: tx.shared ? { ...tx.shared } : null,
      note: row.far ? `Entered in ${accountName(tx.accountId)}; amounts below are from that side.` : '',
    };
  }
  const sharedOf = (txId: string) => app.state.transactions.find((t) => t.id === txId)?.shared;
  async function save(row: LedgerRow | null, draft: TxDraft, payee: string, shared: { accountId: string; percent: number } | null | undefined) {
    if (row) await app.updateTransaction(row.txId, draft, payee, shared);
    else await app.addTransaction(draft, payee, shared);
    editing = null;
    undoToast(row ? 'Saved transaction' : 'Added transaction');
  }
  async function remove(row: LedgerRow) {
    editing = null;
    await app.deleteTransaction(row.txId);
    undoToast('Deleted transaction');
  }
  async function toggleCleared(row: LedgerRow) {
    await app.setCleared(row.txId, id, row.cleared === 'cleared' ? 'uncleared' : 'cleared');
  }
</script>

{#if !account}
  <section class="ledger"><p>No such account. <button onclick={() => navigate({ name: 'accounts' })}>Accounts</button></p></section>
{:else}
  <section class="ledger">
    <header>
      <button onclick={() => navigate({ name: 'accounts' })}>‹</button>
      <h2>{account.name}</h2>
      <span class="dim">{account.kind}{account.onBudget ? '' : ' · tracking'}</span>
      <span class="spacer"></span>
      <span class="dim">Working</span> <span class={`money big ${tone(balance?.working ?? 0)}`} data-testid="ledger-working">{formatMoney(balance?.working ?? 0)}</span>
      <span class="dim">Cleared</span> <span class={`money ${tone(balance?.cleared ?? 0)}`} data-testid="ledger-cleared">{formatMoney(balance?.cleared ?? 0)}</span>
      <button data-testid="add-tx" class="primary" onclick={() => (editing = 'new')}>Add transaction</button>
    </header>
    {#if editing === 'new'}
      <TransactionEditor draft={emptyDraft(id, todayKey())} onSave={(d, p, s) => save(null, d, p, s)} onCancel={() => (editing = null)} />
    {/if}
    <table>
      <thead><tr><th>Date</th><th>Payee</th><th>Category</th><th>Memo</th><th class="money">Outflow</th><th class="money">Inflow</th><th class="money">Balance</th><th>C</th></tr></thead>
      <tbody>
        {#each rows.slice(0, limit) as row (row.id)}
          <tr data-testid={`row-${row.id}`} class:far={row.far} class:isnew={row.status === 'new'} onclick={() => (editing = editing === row.id ? null : row.id)}>
            <td class="date">{row.date}</td>
            <td>{payeeName(row.payeeId)}</td>
            <td>{label(row.kind)}{#if !row.far && sharedOf(row.txId)} <span class="shared" data-testid={`shared-${row.id}`}>· shared {sharedOf(row.txId)!.percent}%</span>{/if}{#if row.status === 'new'} <span class="badge" data-testid={`new-${row.id}`}>new</span>{/if}</td>
            <td class="dim memo">{row.memo}</td>
            <td class="money neg">{row.amount < 0 ? formatMoney(-row.amount) : ''}</td>
            <td class="money pos">{row.amount > 0 ? formatMoney(row.amount) : ''}</td>
            <td class={`money ${tone(row.running)}`} data-testid={`running-${row.id}`}>{formatMoney(row.running)}</td>
            <td><button class="clr" class:on={row.cleared === 'cleared'} data-testid={`clr-${row.id}`} title="Cleared"
              onclick={(e) => { e.stopPropagation(); void toggleCleared(row); }}>{row.cleared === 'cleared' ? '●' : '○'}</button></td>
          </tr>
          {#if editing === row.id}
            {@const e = draftFor(row)}
            <tr class="editrow"><td colspan="8">
              <TransactionEditor draft={e.draft} payeeName={e.payee} note={e.note} shared={e.shared}
                onSave={(d, p, s) => save(row, d, p, s)} onCancel={() => (editing = null)} onDelete={() => void remove(row)} />
            </td></tr>
          {/if}
        {/each}
      </tbody>
    </table>
    {#if rows.length > limit}
      <p><button data-testid="show-more" onclick={() => (limit += PAGE)}>Show {Math.min(PAGE, rows.length - limit)} more of {rows.length - limit}</button></p>
    {/if}
  </section>
{/if}

<style>
  .ledger { max-width: 1200px; margin: 0 auto; padding: 16px 24px; }
  header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
  h2 { margin: 0; }
  .dim { color: var(--dim); }
  .spacer { flex: 1; }
  .big { font-size: 1.3rem; }
  .primary { border-color: var(--blue); color: var(--blue); }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; color: var(--dim); font-weight: 500; padding: 6px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th.money { text-align: right; }
  td { padding: 5px 8px; border-bottom: 1px solid var(--line); }
  td.money { text-align: right; }
  td.date { font-family: var(--font-mono); font-size: 0.9rem; white-space: nowrap; }
  td.memo { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  tbody tr:not(.editrow) { cursor: pointer; }
  tbody tr:not(.editrow):hover td { background: var(--bg1); }
  tr.far td:first-child { border-left: 2px solid var(--blue-deep); }
  tr.isnew td { background: rgba(240, 180, 90, 0.06); }
  .badge { background: var(--amber); color: var(--bg0); border-radius: 999px; padding: 0 6px; font-size: 0.75rem; font-weight: 600; }
  .shared { color: var(--teal); font-size: 0.85rem; }
  .clr { border: none; padding: 0 4px; color: var(--dim); }
  .clr.on { color: var(--teal); }
  tr.editrow td { padding: 8px; }
</style>
