<script lang="ts">
  // An Actions job's log, a step at a time: its colours, line numbers, `##[error]` lines marked and
  // scrolled to, groups as headers. Find (⌘F in it) steps through the lines that match. A step
  // keeps up to 3000 lines: only those on screen are drawn.
  import { IconButton, Modal, SearchInput, Spinner, VirtualList, copyText, toast, tooltip } from 'purr';
  import { ArrowSquareOutRegular, CaretDownRegular, CaretRightBold, CaretUpRegular, CopyRegular } from 'purr/glyphs';
  import { tick } from 'svelte';
  import CheckIcon from './CheckIcon.svelte';
  import { checks, type LogTarget } from '../lib/gh-checks.svelte.ts';
  import { STATE_LABEL, ansiRuns } from '../lib/gh-checks.ts';
  import type { JobLog, LogStep } from '../../shared/gh-checks.ts';

  interface Props {
    target: LogTarget;
  }
  let { target }: Props = $props();

  let log = $state.raw<JobLog | null>(null);
  let current = $state<number | null>(null);
  let scroller = $state<HTMLElement | null>(null);
  let lines = $state<HTMLElement | null>(null);
  /** Every line is one row (they never wrap), as high as the log's line height. */
  let lineHeight = $state(19);
  let query = $state('');
  let cursor = $state(0);
  let findInput = $state<HTMLInputElement | null>(null);

  const close = () => (checks.log = null);

  $effect(() => {
    const jobId = target.jobId;
    checks.loadLog(jobId).then(
      (l) => {
        log = l;
        show(target.step ?? l.open ?? l.steps[0]?.number ?? null);
      },
      (e) => {
        toast.error(e);
        close();
      },
    );
  });

  const step = $derived<LogStep | null>(log?.steps.find((s) => s.number === current) ?? null);
  // Each line's styled runs, worked out once per step; find and copy use their text.
  const runs = $derived(step ? step.lines.map((l) => ansiRuns(l.t).map((r) => ({ text: r.text, cls: runClass(r) }))) : []);
  const plain = $derived(runs.map((line) => line.map((r) => r.text).join('')));
  /** The longest line, in characters: the lines are drawn as wide, so they scroll sideways as one. */
  const widest = $derived(plain.reduce((n, t) => Math.max(n, t.length), 0));

  $effect(() => {
    if (scroller) lineHeight = parseFloat(getComputedStyle(scroller).lineHeight) || lineHeight;
  });
  const matches = $derived.by(() => {
    if (!query) return [];
    // Ignores case unless the text has a capital, as the diff's find does.
    const caseless = query === query.toLowerCase();
    return plain.flatMap((t, i) => ((caseless ? t.toLowerCase() : t).includes(query) ? [i] : []));
  });
  const matched = $derived(new Set(matches));
  const cursorLine = $derived(matches.length ? matches[Math.min(cursor, matches.length - 1)] : -1);

  /** Show step `n`, scrolled to its first error (the end, when it failed without saying where; else the top). */
  async function show(n: number | null) {
    current = n;
    cursor = 0;
    await tick();
    const s = step;
    if (!s) return;
    const at = s.firstError >= 0 ? s.firstError : s.state === 'failure' ? s.lines.length - 1 : -1;
    if (at >= 0) scrollTo(at);
    else if (scroller) scroller.scrollTop = 0;
  }

  function scrollTo(i: number) {
    if (!scroller || !lines) return;
    const top = lines.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    scroller.scrollTop = top + i * lineHeight - scroller.clientHeight / 3;
  }

  function move(by: number) {
    if (!matches.length) return;
    cursor = (cursor + by + matches.length) % matches.length;
    scrollTo(matches[cursor]);
  }

  $effect(() => {
    void query;
    cursor = 0;
    if (matches.length) tick().then(() => scrollTo(matches[0]));
  });

  function onkeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      e.stopPropagation();
      findInput?.focus();
      findInput?.select();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'g') {
      e.preventDefault();
      e.stopPropagation();
      move(e.shiftKey ? -1 : 1);
    }
  }

  function onFindKey(e: KeyboardEvent) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    move(e.shiftKey ? -1 : 1);
  }

  async function copy() {
    if (!step) return;
    const prefix = { error: 'Error: ', warning: 'Warning: ', notice: 'Notice: ' } as Record<string, string>;
    const text = step.lines.map((l, i) => (prefix[l.k ?? ''] ?? '') + plain[i]).join('\n');
    if (await copyText(text)) toast(`Copied the log of "${step.name}"`);
    else toast.error('Couldn’t copy the log.');
  }

  const stepUrl = $derived(log && step ? `${log.url}#step:${step.number}:1` : (target.url ?? null));
  const runClass = (r: ReturnType<typeof ansiRuns>[number]) =>
    [
      r.fg !== undefined && `fg-${r.fg}`,
      r.bg !== undefined && `bg-${r.bg}`,
      r.bold && 'b',
      r.dim && 'd',
      r.italic && 'i',
      r.underline && 'u',
      r.inverse && 'inv',
    ]
      .filter(Boolean)
      .join(' ');
  const LABEL: Record<string, string> = { error: 'Error: ', warning: 'Warning: ', notice: 'Notice: ' };
</script>

<Modal label="Job log" title="{target.name}{step ? ` · ${step.name}` : ''}" onclose={close} width="min(1200px, calc(100vw - 32px))" height="86vh" {onkeydown}>
  {#snippet actions()}
    <div class="find">
      <SearchInput variant="field" label="Find in the log" placeholder="Find" bind:value={query} bind:input={findInput} onkeydown={onFindKey} />
      {#if query}
        <span class="muted count" aria-live="polite">{matches.length ? `${Math.min(cursor, matches.length - 1) + 1}/${matches.length}` : 'none'}</span>
        <IconButton label="Previous match" shortcut="⇧⌘G" disabled={!matches.length} onclick={() => move(-1)}><CaretUpRegular /></IconButton>
        <IconButton label="Next match" shortcut="⌘G" disabled={!matches.length} onclick={() => move(1)}><CaretDownRegular /></IconButton>
      {/if}
    </div>
    <IconButton label="Copy this step's log" disabled={!step} onclick={copy}><CopyRegular /></IconButton>
    {#if stepUrl}
      <a class="btn btn--icon btn--ghost" href={stepUrl} target="_blank" rel="noreferrer" aria-label="Open on GitHub" use:tooltip={'Open on GitHub'}
        ><ArrowSquareOutRegular /></a
      >
    {/if}
  {/snippet}
  {#if !log}
    <p class="muted loading"><Spinner size={14} /> Loading…</p>
  {:else}
    <div class="body">
      <nav aria-label="Steps">
        {#each log.steps as s (s.number)}
          <button
            class="step"
            class:is-current={s.number === current}
            aria-current={s.number === current ? 'step' : undefined}
            aria-label="{s.name}: {STATE_LABEL[s.state].toLowerCase()}"
            disabled={!s.lines.length}
            onclick={() => show(s.number)}
          >
            <CheckIcon state={s.state} />
            <span class="name">{s.name}</span>
          </button>
        {/each}
      </nav>
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div class="log mono" bind:this={scroller} tabindex="0" role="region" aria-label="Log of {step?.name ?? 'the job'}">
        {#if step}
          {#if step.skipped}
            <p class="muted cut">
              {step.skipped} earlier lines left out.
              {#if stepUrl}<a href={stepUrl} target="_blank" rel="noreferrer">On GitHub</a>{/if}
            </p>
          {/if}
          {#if step.lines.length}
            {@const skipped = step.skipped}
            <div class="lines" bind:this={lines} style:min-width="calc(5em + var(--sp-4) + var(--sp-5) + {widest + 4}ch)">
              <VirtualList items={step.lines} rowHeight={lineHeight} {scroller}>
                {#snippet children(l, i)}
                  <div class="line {l.k ?? ''}" class:match={matched.has(i)} class:is-cursor={i === cursorLine}>
                    <span class="n">{skipped + i + 1}</span>
                    <span class="t"
                      >{#if l.k === 'group'}<CaretRightBold />{/if}{#if LABEL[l.k ?? '']}<b>{LABEL[l.k ?? '']}</b>{/if}{#each runs[i] ?? [] as r, j (j)}{#if r.cls}<span
                            class={r.cls}>{r.text}</span
                          >{:else}{r.text}{/if}{/each}</span
                    >
                  </div>
                {/snippet}
              </VirtualList>
            </div>
          {:else}
            <p class="muted cut">No output</p>
          {/if}
        {/if}
      </div>
    </div>
  {/if}
</Modal>

<style>
  .find {
    display: flex;
    align-items: center;
    gap: var(--gap-2);
    margin-right: var(--gap-4);
  }

  .count {
    font-size: var(--fs-xs);
    font-variant-numeric: tabular-nums;
    min-width: 4em;
    text-align: right;
  }

  .loading {
    display: flex;
    align-items: center;
    gap: var(--gap-3);
    padding: var(--sp-5);
  }

  .body {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(180px, 240px) 1fr;
  }

  nav {
    overflow: auto;
    padding: var(--gap-3);
    border-right: 1px solid var(--border);
    background: var(--bg2);
  }

  .step {
    display: flex;
    align-items: center;
    gap: var(--gap-4);
    width: 100%;
    min-height: 28px;
    padding: 0 var(--gap-4);
    border-radius: var(--radius);
    font-size: var(--fs-sm);
    text-align: left;
    cursor: pointer;
  }

  .step:disabled {
    cursor: default;
    opacity: 0.6;
  }

  .step.is-current {
    background: var(--theme-soft);
    color: var(--color2);
  }

  @media (hover: hover) {
    .step:not(:disabled, .is-current):hover {
      background: var(--bg3);
    }
  }

  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .log {
    overflow: auto;
    padding: var(--gap-3) 0;
    background: var(--code-bg);
    font-size: var(--fs-xs);
    line-height: 1.6;
    outline: none;
  }

  .cut {
    margin: var(--gap-3) var(--sp-5);
    font-family: var(--font);
  }

  .line {
    display: flex;
    flex: 1;
    align-self: stretch;
    align-items: center;
    min-width: max-content;
    padding-right: var(--sp-5);
  }

  .n {
    position: sticky;
    left: 0;
    flex-shrink: 0;
    width: 5em;
    padding-right: var(--sp-4);
    text-align: right;
    color: var(--faint);
    background: var(--code-bg);
    user-select: none;
  }

  .t {
    white-space: pre;
  }

  .t :global(svg) {
    vertical-align: -0.15em;
    margin-right: var(--gap-2);
  }

  .group {
    font-weight: 600;
    color: var(--color2);
  }

  .command {
    color: var(--info);
  }

  .debug {
    color: var(--muted);
  }

  .error,
  .error .n {
    background: var(--del-bg);
  }

  .error .t {
    color: var(--danger);
  }

  .warning,
  .warning .n {
    background: color-mix(in oklch, var(--warn) 14%, var(--code-bg));
  }

  .notice,
  .notice .n {
    background: color-mix(in oklch, var(--info) 12%, var(--code-bg));
  }

  .match,
  .match .n {
    background: var(--selection);
  }

  .is-cursor,
  .is-cursor .n {
    background: var(--theme-mid);
  }

  .log :global(.b) {
    font-weight: 700;
  }

  .log :global(.d) {
    opacity: 0.7;
  }

  .log :global(.i) {
    font-style: italic;
  }

  .log :global(.u) {
    text-decoration: underline;
  }

  .log :global(:is(.fg-0, .fg-8)) {
    --fg: var(--muted);
    color: var(--fg);
  }

  .log :global(:is(.fg-1, .fg-9)) {
    --fg: var(--danger);
    color: var(--fg);
  }

  .log :global(:is(.fg-2, .fg-10)) {
    --fg: var(--success);
    color: var(--fg);
  }

  .log :global(:is(.fg-3, .fg-11)) {
    --fg: var(--warn);
    color: var(--fg);
  }

  .log :global(:is(.fg-4, .fg-12)) {
    --fg: var(--info);
    color: var(--fg);
  }

  .log :global(:is(.fg-5, .fg-13)) {
    --fg: var(--code-kw);
    color: var(--fg);
  }

  .log :global(:is(.fg-6, .fg-14)) {
    --fg: var(--code-type);
    color: var(--fg);
  }

  .log :global(:is(.fg-7, .fg-15)) {
    --fg: var(--color2);
    color: var(--fg);
  }

  .log :global(:is(.bg-0, .bg-8)) {
    background: color-mix(in oklch, var(--muted) 30%, transparent);
  }

  .log :global(:is(.bg-1, .bg-9)) {
    background: color-mix(in oklch, var(--danger) 30%, transparent);
  }

  .log :global(:is(.bg-2, .bg-10)) {
    background: color-mix(in oklch, var(--success) 30%, transparent);
  }

  .log :global(:is(.bg-3, .bg-11)) {
    background: color-mix(in oklch, var(--warn) 30%, transparent);
  }

  .log :global(:is(.bg-4, .bg-12)) {
    background: color-mix(in oklch, var(--info) 30%, transparent);
  }

  .log :global(:is(.bg-5, .bg-13)) {
    background: color-mix(in oklch, var(--code-kw) 30%, transparent);
  }

  .log :global(:is(.bg-6, .bg-14)) {
    background: color-mix(in oklch, var(--code-type) 30%, transparent);
  }

  .log :global(:is(.bg-7, .bg-15)) {
    background: color-mix(in oklch, var(--color) 30%, transparent);
  }

  .log :global(.inv) {
    background: var(--fg, var(--color));
    color: var(--code-bg);
  }
</style>
