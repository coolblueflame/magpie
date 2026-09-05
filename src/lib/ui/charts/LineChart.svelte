<!-- Multi-series line chart (three series at most): 2px lines, ringed end markers, crosshair tooltip, legend at two or more series, table twin. -->
<script lang="ts">
  import { formatMoney } from '../../domain/money';
  import { monthLabel } from '../../domain/month';
  import { niceTicks } from '../../domain/charts';
  import type { MonthPoint } from '../../domain/charts';

  export interface LineSeries { name: string; points: MonthPoint[]; slot: 1 | 2 | 3; dashed?: boolean }
  let { series, title, testid, height = 220 }: { series: LineSeries[]; title: string; testid: string; height?: number } = $props();

  let width = $state(600);
  const pad = { top: 16, right: 84, bottom: 28, left: 56 };
  const months = $derived([...new Set(series.flatMap((s) => s.points.map((p) => p.month)))].sort());
  const allValues = $derived(series.flatMap((s) => s.points.map((p) => p.value)));
  const max = $derived(Math.max(0, ...allValues));
  const min = $derived(Math.min(0, ...allValues));
  const ticks = $derived(niceTicks(Math.max(max, -min)));
  const top = $derived(ticks[ticks.length - 1] || 1);
  const plotW = $derived(Math.max(10, width - pad.left - pad.right));
  const plotH = $derived(height - pad.top - pad.bottom);
  const x = (m: string) => pad.left + (months.length > 1 ? (months.indexOf(m) / (months.length - 1)) * plotW : plotW / 2);
  const y = (v: number) => pad.top + (min < 0 ? ((top - v) / (2 * top)) * plotH : ((top - v) / top) * plotH);
  const path = (pts: MonthPoint[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.month).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const colour = (slot: number) => `var(--series-${slot})`;

  let hover = $state<string | null>(null);
  function onMove(e: PointerEvent) {
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const px = e.clientX - rect.left;
    let best = months[0] ?? null, d = Infinity;
    for (const m of months) { const dd = Math.abs(x(m) - px); if (dd < d) { d = dd; best = m; } }
    hover = best;
  }
  const valueAt = (s: LineSeries, m: string) => s.points.find((p) => p.month === m)?.value;
  let table = $state(false);
  // Month labels: at most ~8, always the first and last.
  const labelEvery = $derived(Math.max(1, Math.ceil(months.length / 8)));
  const short = (m: string) => monthLabel(m).replace(' 20', ' ’');
</script>

<figure class="chart" data-testid={testid}>
  <figcaption><span class="title">{title}</span><button class="tbl" data-testid={`${testid}-table-toggle`} onclick={() => (table = !table)}>{table ? 'Chart' : 'Table'}</button></figcaption>
  {#if series.length >= 2}
    <ul class="legend">{#each series as s (s.name)}<li><span class="key" class:dashed={s.dashed} style={`--c:${colour(s.slot)}`}></span>{s.name}</li>{/each}</ul>
  {/if}
  {#if table}
    <table data-testid={`${testid}-table`}>
      <thead><tr><th>Month</th>{#each series as s (s.name)}<th class="num">{s.name}</th>{/each}</tr></thead>
      <tbody>{#each months as m (m)}<tr><td>{monthLabel(m)}</td>{#each series as s (s.name)}<td class="num">{valueAt(s, m) === undefined ? '' : formatMoney(valueAt(s, m)!)}</td>{/each}</tr>{/each}</tbody>
    </table>
  {:else}
    <div class="plot" bind:clientWidth={width}>
    <svg viewBox={`0 0 ${width} ${height}`} {width} {height} role="img" aria-label={title} onpointermove={onMove} onpointerleave={() => (hover = null)}>
      {#each ticks as t (t)}
        <line class="grid" x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} />
        <text class="axis" x={pad.left - 8} y={y(t) + 4} text-anchor="end">{formatMoney(t).replace('.00', '')}</text>
      {/each}
      {#if min < 0}<line class="grid" x1={pad.left} x2={width - pad.right} y1={y(-top)} y2={y(-top)} /><text class="axis" x={pad.left - 8} y={y(-top) + 4} text-anchor="end">{formatMoney(-top).replace('.00', '')}</text>{/if}
      {#each months as m, i (m)}
        {#if i % labelEvery === 0 || i === months.length - 1}<text class="axis" x={x(m)} y={height - 8} text-anchor="middle">{short(m)}</text>{/if}
      {/each}
      {#if hover}<line class="crosshair" x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + plotH} />{/if}
      {#each series as s (s.name)}
        <path class="line" class:dashed={s.dashed} d={path(s.points)} style={`stroke:${colour(s.slot)}`} />
        {#if s.points.length}
          {@const last = s.points[s.points.length - 1]!}
          <circle class="dot" cx={x(last.month)} cy={y(last.value)} r="4" style={`fill:${colour(s.slot)}`} />
          <text class="endlabel" x={x(last.month) + 10} y={y(last.value) + 4}>{formatMoney(last.value).replace('.00', '')}</text>
        {/if}
        {#if hover && valueAt(s, hover) !== undefined}<circle class="dot" cx={x(hover)} cy={y(valueAt(s, hover)!)} r="4" style={`fill:${colour(s.slot)}`} />{/if}
      {/each}
    </svg>
    </div>
    {#if hover}
      <div class="tip" data-testid={`${testid}-tip`} style={`left:${Math.min(x(hover) + 12, width - 180)}px`}>
        <div class="tipmonth">{monthLabel(hover)}</div>
        {#each series as s (s.name)}{#if valueAt(s, hover) !== undefined}<div class="tiprow"><span class="key" class:dashed={s.dashed} style={`--c:${colour(s.slot)}`}></span><b>{formatMoney(valueAt(s, hover)!)}</b><span class="dim">{s.name}</span></div>{/if}{/each}
      </div>
    {/if}
  {/if}
</figure>

<style>
  .chart { --series-1: #3987e5; --series-2: #d95926; --series-3: #199e70; --grid: #223040; --muted: #8c9bab;
    position: relative; margin: 0; background: var(--bg1); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px 6px; }
  figcaption { display: flex; align-items: baseline; gap: 10px; }
  .title { font-weight: 600; flex: 1; }
  .tbl { border: none; color: var(--dim); font-size: 0.85rem; padding: 0 6px; }
  .legend { list-style: none; display: flex; gap: 14px; margin: 4px 0 0; padding: 0; font-size: 0.85rem; color: var(--dim); flex-wrap: wrap; }
  .key { display: inline-block; width: 14px; height: 2px; background: var(--c); vertical-align: middle; margin-right: 6px; border-radius: 1px; }
  .key.dashed { background: repeating-linear-gradient(90deg, var(--c) 0 3px, transparent 3px 5px); }
  .plot { width: 100%; }
  svg { display: block; overflow: visible; }
  .grid { stroke: var(--grid); stroke-width: 1; }
  .axis { fill: var(--muted); font-size: 11px; font-family: var(--font-sans); font-variant-numeric: tabular-nums; }
  .line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  .line.dashed { stroke-dasharray: 5 4; }
  .dot { stroke: var(--bg1); stroke-width: 2; }
  .endlabel { fill: var(--text); font-size: 11px; font-family: var(--font-sans); }
  .crosshair { stroke: var(--muted); stroke-width: 1; }
  .tip { position: absolute; top: 40px; background: var(--bg2); border: 1px solid var(--line); border-radius: 6px; padding: 6px 10px; font-size: 0.85rem; pointer-events: none; min-width: 150px; }
  .tipmonth { color: var(--dim); margin-bottom: 4px; }
  .tiprow { display: flex; align-items: center; gap: 8px; }
  .tiprow b { font-family: var(--font-mono); }
  .dim { color: var(--dim); }
  table { border-collapse: collapse; width: 100%; margin-top: 6px; font-size: 0.9rem; }
  th, td { padding: 3px 8px; border-bottom: 1px solid var(--line); text-align: left; }
  .num { text-align: right; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
</style>
