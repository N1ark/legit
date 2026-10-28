<script lang="ts" module>
  /** One of a picker's choices: a label, a reviewer, an assignee. */
  export interface Choice {
    key: string;
    label: string;
    description?: string;
    /** A label's colour (`#rrggbb`). */
    color?: string;
    /** A person's avatar. */
    avatar?: string | null;
    /** Said after the label, e.g. a reviewer's latest review. */
    note?: string;
    /** Choices are listed under their group's heading, groups in the order they first appear. */
    group?: string;
  }
</script>

<script lang="ts">
  // GitHub's picker for labels, reviewers and assignees: tick any number of choices, each at once
  // and without a request, filtering as you go; closing it hands back what's ticked, to apply in one go.
  import { Avatar, Highlight, Popover, rank } from 'purr';
  import { CheckBold } from 'purr/glyphs';

  interface Props {
    anchor: HTMLElement;
    /** The heading, e.g. "Apply labels to this pull request". */
    title: string;
    choices: Choice[];
    /** What's ticked as it opens; listed first, as GitHub does. */
    chosen: string[];
    placeholder?: string;
    /** Closed (Escape, a click outside, or ⌘↩/Enter on an empty filter): what's ticked now, in the choices' order. */
    onclose: (chosen: string[]) => void;
  }
  let { anchor, title, choices, chosen, placeholder = 'Filter…', onclose }: Props = $props();

  // svelte-ignore state_referenced_locally
  let ticked = $state(new Set(chosen));
  let filter = $state('');
  let cursor = $state(0);
  let listEl = $state<HTMLElement | null>(null);

  // The ticked ones first, as they were when it opened: rows don't jump as they're ticked.
  // svelte-ignore state_referenced_locally
  const ordered = [...choices.filter((c) => ticked.has(c.key)), ...choices.filter((c) => !ticked.has(c.key))];
  const rows = $derived(rank(ordered, filter, { keys: [(c) => c.label, (c) => c.description] }));
  const at = $derived(Math.min(cursor, Math.max(rows.length - 1, 0)));

  function toggle(key: string) {
    const next = new Set(ticked);
    if (!next.delete(key)) next.add(key);
    ticked = next;
  }

  let closed = false;
  /** Close it as Escape would (its anchor clicked again, say). */
  export function close() {
    if (closed) return;
    closed = true;
    onclose(choices.filter((c) => ticked.has(c.key)).map((c) => c.key));
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = rows.length;
      if (!n) return;
      cursor = (at + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      listEl?.querySelector(`[data-row="${cursor}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // Enter ticks the row under the cursor, as on GitHub; ⌘↩ (or Enter with nothing to tick) is done.
      if (e.metaKey || e.ctrlKey || !rows.length) close();
      else toggle(rows[at].item.key);
    }
  }

  /** The group heading shown above row `k`, if it starts one (not while filtering: matches are by rank). */
  const heading = (k: number) => {
    if (filter.trim()) return null;
    const g = rows[k].item.group;
    return g && g !== rows[k - 1]?.item.group ? g : null;
  };
</script>

<Popover {anchor} label={title} onclose={close} layer="card" width="min(320px, calc(100vw - 32px))" padding="0" autofocus>
  <div class="picker">
    <header>{title}</header>
    <div class="filter">
      <input
        bind:value={filter}
        oninput={() => (cursor = 0)}
        {onkeydown}
        {placeholder}
        spellcheck="false"
        class="field-input"
        aria-controls="pick-many-list"
        aria-activedescendant={rows.length ? `pick-many-${at}` : undefined}
      />
    </div>
    <ol bind:this={listEl} id="pick-many-list" role="listbox" aria-label={title} aria-multiselectable="true">
      {#each rows as r, k (r.item.key)}
        {@const c = r.item}
        {@const h = heading(k)}
        {#if h}<li class="heading muted" role="presentation">{h}</li>{/if}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <li
          id="pick-many-{k}"
          class="row-item"
          class:is-cursor={k === at}
          class:described={!!c.description}
          role="option"
          aria-selected={ticked.has(c.key)}
          data-row={k}
          onclick={() => toggle(c.key)}
          onmousedown={(e) => e.preventDefault()}
          onmousemove={() => (cursor = k)}
        >
          <span class="tick">{#if ticked.has(c.key)}<CheckBold />{/if}</span>
          {#if c.color}<span class="swatch" style:background={c.color}></span>{/if}
          {#if c.avatar !== undefined}<Avatar name={c.label} src={c.avatar} size={18} round title="" />{/if}
          <span class="text">
            <span class="label"><Highlight text={c.label} indices={r.field === 0 ? r.indices : []} />{#if c.note}<span class="note muted">{c.note}</span>{/if}</span>
            {#if c.description}<span class="description muted">{c.description}</span>{/if}
          </span>
        </li>
      {:else}
        <li class="empty muted" role="presentation">No match</li>
      {/each}
    </ol>
  </div>
</Popover>

<style>
  .picker {
    display: flex;
    flex-direction: column;
    max-height: min(420px, 60vh);
  }

  header {
    padding: var(--gap-3) var(--gap-4) var(--gap-2);
    font-size: var(--fs-sm);
    font-weight: 600;
  }

  .filter {
    padding: 0 var(--gap-3) var(--gap-3);
    border-bottom: 1px solid var(--border);
  }

  input {
    width: 100%;
  }

  ol {
    list-style: none;
    margin: 0;
    padding: var(--gap-2);
    overflow: auto;
  }

  li {
    cursor: pointer;
  }

  /* Two lines: as tall as they need, the tick and colour level with the first. */
  li.described {
    height: auto;
    min-height: var(--row-h);
    padding-block: var(--gap-2);
    align-items: flex-start;
  }

  li.described :is(.tick, .swatch) {
    margin-top: 3px;
  }

  li.heading,
  li.empty {
    cursor: default;
    font-size: var(--fs-xs);
    padding: var(--gap-2) var(--gap-3);
  }

  .tick {
    width: 14px;
    flex-shrink: 0;
    display: flex;
    font-size: var(--icon-sm);
    color: var(--theme2);
  }

  .swatch {
    width: 12px;
    height: 12px;
    flex-shrink: 0;
    border-radius: 50%;
  }

  .text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .note {
    margin-left: var(--gap-2);
    font-size: var(--fs-xs);
  }

  .description {
    font-size: var(--fs-xs);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
