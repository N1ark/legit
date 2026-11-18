<script lang="ts">
  // A submodule in a diff: the commit it pointed at and the one it points at, the commits between (read in
  // the submodule when the card first shows), what's going on inside it, and a way to open it in legit.
  // Its height is fixed (see lib/submodule.ts): the commit list scrolls inside it.
  import { Button, Tag, formatRelative, tooltip } from 'purr';
  import { ArrowSquareOutRegular, CubeRegular } from 'purr/glyphs';
  import type { SubmoduleChange, SubmoduleLog } from '../shared/types.ts';
  import { SUB, type SubmoduleCard, logRows, logSummary } from './lib/submodule.ts';
  import { openSubmodule, submoduleLog } from './lib/submodules.svelte.ts';

  let {
    path,
    sub,
    card,
    height,
    sel = false,
    last,
    onpick,
  }: {
    path: string;
    sub: SubmoduleChange;
    card: SubmoduleCard;
    /** Fixed, so the diff's layout is known before anything loads. */
    height: number;
    /** Picked (or staged) whole. */
    sel?: boolean;
    /** Nothing below it in the file: round its bottom corners. */
    last: boolean;
    /** Picking it, or staging it, whole; absent when there's nothing to pick. */
    onpick?: () => void;
  } = $props();

  let log = $state.raw<SubmoduleLog | null>(null);
  let failed = $state(false);
  $effect(() => {
    if (!card.log) return;
    let alive = true;
    log = null;
    failed = false;
    submoduleLog(path, sub.old, sub.new).then(
      (l) => alive && (log = l),
      () => alive && (failed = true),
    );
    return () => (alive = false);
  });
  const rows = $derived(log ? logRows(log) : []);
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="sub" class:last class:sel class:pick={!!onpick} style:height="{height}px" style:--pad="{SUB.PAD}px" onclick={onpick}>
  <div class="line" style:height="{SUB.LINE}px">
    <CubeRegular />
    <span class="what">Submodule</span>
    <span class="mono change">{card.change}</span>
    {#each card.badges as b (b.label)}
      <span use:tooltip={b.tip}><Tag color={b.warn ? 'var(--warn)' : undefined} label={b.label} /></span>
    {/each}
    {#if log && !log.unavailable}<span class="muted">{logSummary(log)}</span>{/if}
    <span class="spacer"></span>
    {#if card.openable}
      <!-- Opening isn't picking it. -->
      <span class="open" onclick={(e) => e.stopPropagation()}>
        <Button size="sm" variant="ghost" onclick={() => openSubmodule(path)}><ArrowSquareOutRegular /> Open</Button>
      </span>
    {/if}
  </div>
  {#if card.note}<div class="note muted" style:height="{SUB.NOTE}px">{card.note}</div>{/if}
  {#if card.log}
    <div class="log mono" style:height="{SUB.ROWS * SUB.ROW}px" style:--row="{SUB.ROW}px">
      {#if failed}
        <div class="row muted">Its commits couldn't be read; {card.change}</div>
      {:else if !log}
        <div class="row muted">Loading commits…</div>
      {:else if log.unavailable}
        <div class="row muted">{logSummary(log)}</div>
      {:else}
        {#each rows as r (r.kind === 'more' ? `more${r.side}` : r.kind + r.sha)}
          {#if r.kind === 'more'}
            <div class="row muted">…and {r.n} more {r.side === '+' ? 'added' : 'dropped'}</div>
          {:else}
            <div class="row" class:add={r.kind === '+'} class:del={r.kind === '-'} use:tooltip={`${r.sha}\n${r.author}`}>
              <span class="mark">{r.kind === '+' ? '+' : '−'}</span>
              <span class="sha">{r.sha.slice(0, 7)}</span>
              <span class="subject">{r.subject}</span>
              <span class="meta muted">{r.author} · {formatRelative(r.time * 1000)}</span>
            </div>
          {/if}
        {/each}
      {/if}
    </div>
  {/if}
</div>

<style>
  .sub {
    display: flex;
    flex-direction: column;
    gap: 0;
    padding: var(--pad) var(--sp-4);
    box-sizing: border-box;
    background: var(--code-bg);
    font-size: var(--fs-sm);
    overflow: hidden;
  }

  .sub.last {
    border-radius: 0 0 var(--radius) var(--radius);
  }

  .sub.pick {
    cursor: pointer;
  }

  .sub.sel {
    background: var(--theme-soft);
  }

  .line {
    flex: none;
    display: flex;
    align-items: center;
    gap: var(--gap-3);
    min-width: 0;
    white-space: nowrap;
  }

  .what {
    font-weight: 600;
  }

  .spacer {
    flex: 1;
  }

  .open {
    display: contents;
  }

  .note {
    flex: none;
    display: flex;
    align-items: center;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .log {
    flex: none;
    margin-top: var(--pad);
    overflow-y: auto;
    overscroll-behavior: contain;
    font-size: var(--fs-xs);
  }

  .row {
    height: var(--row);
    display: flex;
    align-items: center;
    gap: var(--gap-3);
    white-space: nowrap;
    overflow: hidden;
  }

  .mark {
    width: 1ch;
    text-align: center;
  }

  .add .mark {
    color: var(--add);
  }

  .del .mark,
  .del .subject {
    color: var(--del);
  }

  .sha {
    color: var(--theme2);
  }

  .subject {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .meta {
    flex: none;
  }
</style>
