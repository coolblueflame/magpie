<!-- Loans (spec §4.8): terms, what is owed, the projection at the standard payment, and a lump-sum what-if. -->
<script lang="ts">
  import { app } from '../state/app.svelte';
  import { undoToast } from './toast.svelte';
  import { accountBalances } from '../domain/ledger';
  import { projectLoan, whatIf } from '../domain/loans';
  import { formatCents, formatMoney, parseCents } from '../domain/money';
  import { monthLabel } from '../domain/month';
  import type { Account, LoanTerms } from '../domain/types';
  import { navigate } from './router.svelte';

  const loans = $derived(app.state.accounts.filter((a) => a.kind === 'loan' && !a.closed).sort((a, b) => a.sortOrder - b.sortOrder));
  const balances = $derived(accountBalances(app.accountsSnap, app.transactionsSnap));
  const owedOf = (a: Account) => -(balances.get(a.id)?.working ?? 0);

  // Drafts of the terms per loan, as text, so a half-typed rate does not save.
  let drafts = $state<Record<string, { rate: string; payment: string; generate: boolean; day: string }>>({});
  let lump = $state<Record<string, string>>({});
  let errors = $state<Record<string, string>>({});
  const draftOf = (a: Account) => drafts[a.id] ?? {
    rate: a.loan ? String(a.loan.annualRatePct) : '', payment: a.loan ? formatCents(a.loan.standardPayment) : '',
    generate: a.loan?.generateInterest ?? false, day: String(a.loan?.interestDay ?? 1),
  };
  function edit(a: Account, patch: Partial<{ rate: string; payment: string; generate: boolean; day: string }>) {
    drafts[a.id] = { ...draftOf(a), ...patch };
  }
  async function save(a: Account) {
    const d = draftOf(a);
    const rate = Number(d.rate), payment = parseCents(d.payment), day = Number(d.day);
    if (!Number.isFinite(rate) || rate < 0 || payment === null || payment < 0 || !Number.isInteger(day) || day < 1 || day > 28) {
      errors[a.id] = 'Rate as a percentage, payment in dollars, interest day 1 to 28.';
      return;
    }
    delete errors[a.id];
    const terms: LoanTerms = { annualRatePct: rate, standardPayment: payment, generateInterest: d.generate, interestDay: day };
    await app.setLoanTerms(a.id, terms);
    delete drafts[a.id];
    undoToast(`Loan terms for ${a.name}`);
  }
  const projectionOf = (a: Account) => (a.loan && owedOf(a) > 0 ? projectLoan(owedOf(a), a.loan, app.currentMonth) : null);
  const whatIfOf = (a: Account) => {
    const cents = parseCents(lump[a.id] ?? '');
    return a.loan && cents && cents > 0 && owedOf(a) > 0 ? whatIf(owedOf(a), a.loan, app.currentMonth, cents) : null;
  };
</script>

<section class="loans">
  <h2>Loans</h2>
  {#if !loans.length}
    <p class="dim">No loan accounts. Add one under <button onclick={() => navigate({ name: 'accounts' })}>Accounts</button> with kind "loan"; payments are transfers into it from a budget account.</p>
  {/if}
  {#each loans as a (a.id)}
    {@const d = draftOf(a)}
    {@const p = projectionOf(a)}
    {@const w = whatIfOf(a)}
    <article data-testid={`loan-${a.id}`}>
      <header>
        <h3><button class="link" onclick={() => navigate({ name: 'account', id: a.id })}>{a.name}</button></h3>
        <span class="dim">owed</span> <span class="money big neg" data-testid={`loan-owed-${a.id}`}>{formatMoney(owedOf(a))}</span>
      </header>
      <div class="terms">
        <label>Annual rate % <input data-testid={`loan-rate-${a.id}`} value={d.rate} oninput={(e) => edit(a, { rate: e.currentTarget.value })} /></label>
        <label>Standard payment <input data-testid={`loan-payment-${a.id}`} class="money" value={d.payment} oninput={(e) => edit(a, { payment: e.currentTarget.value })} /></label>
        <label class="check"><input type="checkbox" data-testid={`loan-generate-${a.id}`} checked={d.generate} onchange={(e) => edit(a, { generate: e.currentTarget.checked })} /> Post monthly interest (no statements for this loan)</label>
        <label>Interest day <input data-testid={`loan-day-${a.id}`} value={d.day} oninput={(e) => edit(a, { day: e.currentTarget.value })} /></label>
        <button data-testid={`loan-save-${a.id}`} class="primary" onclick={() => void save(a)}>Save terms</button>
      </div>
      {#if errors[a.id]}<p class="error">{errors[a.id]}</p>{/if}
      {#if p}
        <div class="projection">
          {#if p.stalls}
            <p class="error" data-testid={`loan-stalls-${a.id}`}>At {formatMoney(a.loan!.standardPayment)} a month the payment does not cover the interest; the balance would never fall.</p>
          {:else}
            <p>At {formatMoney(a.loan!.standardPayment)} a month: paid off in <b data-testid={`loan-months-${a.id}`}>{p.months}</b> months
              ({#if p.payoffMonth}<span data-testid={`loan-payoff-${a.id}`}>{monthLabel(p.payoffMonth)}</span>{/if}),
              with <span class="money neg" data-testid={`loan-interest-${a.id}`}>{formatMoney(p.totalInterest)}</span> of interest still to come.</p>
          {/if}
          <label>What if you paid a lump sum now? <input data-testid={`loan-lump-${a.id}`} class="money" placeholder="0.00" bind:value={lump[a.id]} /></label>
          {#if w}
            <p data-testid={`loan-saved-${a.id}`}>
              {#if w.withLump.months === 0}That clears the loan today and saves {formatMoney(w.interestSaved)} of interest.
              {:else}Paid off {w.monthsSaved} months sooner ({monthLabel(w.withLump.payoffMonth ?? app.currentMonth)}), saving {formatMoney(w.interestSaved)} of interest.{/if}
            </p>
          {/if}
        </div>
      {:else if a.loan && owedOf(a) <= 0}
        <p class="dim">Nothing owed.</p>
      {/if}
    </article>
  {/each}
</section>

<style>
  .loans { max-width: 960px; margin: 0 auto; padding: 16px 24px; }
  article { background: var(--bg1); border: 1px solid var(--line); border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; }
  header { display: flex; align-items: baseline; gap: 10px; }
  h3 { margin: 0; flex: 1; }
  .link { border: none; padding: 0; font: inherit; font-weight: 600; color: var(--blue); }
  .dim { color: var(--dim); }
  .big { font-size: 1.3rem; }
  .terms { display: flex; gap: 14px; align-items: end; flex-wrap: wrap; margin: 10px 0; }
  .terms label { display: grid; gap: 3px; color: var(--dim); font-size: 0.9rem; }
  .terms label.check { display: flex; align-items: center; gap: 6px; }
  .terms input { width: 120px; }
  .terms input.money { text-align: right; font-family: var(--font-mono); }
  .primary { border-color: var(--blue); color: var(--blue); }
  .error { color: var(--red); }
  .projection label { display: flex; gap: 8px; align-items: center; color: var(--dim); }
  .projection input { width: 120px; text-align: right; font-family: var(--font-mono); }
</style>
