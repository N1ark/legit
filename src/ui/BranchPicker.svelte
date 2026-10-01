<script lang="ts">
  import { Highlight, Popover, formatRelative, menu, rank, toast } from 'purr';
  import { CaretDown, Check, GitBranch } from 'purr/icons';
  import type { BranchInfo } from '../shared/types.ts';
  import { app, shortSha } from './lib/app.svelte.ts';
  import { integrateEntries } from './lib/integrate.ts';

  let open = $state(false);
  let list = $state<BranchInfo[] | null>(null);
  let filter = $state('');
  let active = $state(0);
  let button = $state<HTMLButtonElement>();
  let listEl = $state<HTMLElement>();

  const shown = $derived(rank(list ?? [], filter, { keys: [(b) => b.name] }));
  const disabled = $derived(!!app.repo?.blocked || app.busy);

  export async function show() {
    if (disabled) return;
    open = true;
    filter = '';
    active = 0;
    list = await fetch('/api/branches').then((r) => r.json());
  }

  async function choose(b: BranchInfo | undefined) {
    if (!b) return;
    if (b.current) {
      open = false;
      return;
    }
    if (await app.op('switch', { branch: b.name })) {
      open = false;
      toast(`Switched to ${b.name}`);
    }
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = shown.length;
      if (n) active = (active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      listEl?.children[active]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(shown[active]?.item);
    }
  }
</script>

<button
  bind:this={button}
  class="btn btn--ghost branch"
  onclick={() => (open ? (open = false) : show())}
  {disabled}
  aria-expanded={open}
  title="Switch branch (b)"
>
  <GitBranch />
  <span>{app.repo?.branch ?? `detached @ ${app.repo?.head ? shortSha(app.repo.head) : '?'}`}</span>
  <CaretDown />
</button>
{#if open && button}
  <Popover
    anchor={button}
    label="Switch branch"
    onclose={() => (open = false)}
    width="min(560px, calc(100vw - 32px))"
    padding="var(--gap-4)"
    autofocus
  >
    <div class="panel">
      <input
        bind:value={filter}
        oninput={() => (active = 0)}
        {onkeydown}
        placeholder="Switch to branch…"
        spellcheck="false"
        class="field-input mono"
      />
      {#if list === null}
        <p class="muted">Loading…</p>
      {:else if !shown.length}
        <p class="muted">No matching branch.</p>
      {:else}
        <ol bind:this={listEl} role="listbox" aria-label="Branches">
          {#each shown as { item: b, indices }, k (b.name)}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <li
              class="row-item"
              class:is-cursor={k === active}
              class:current={b.current}
              role="option"
              aria-selected={k === active}
              onclick={() => choose(b)}
              onmousemove={() => (active = k)}
              oncontextmenu={(e) => menu.show(e, integrateEntries(b.name, b.current, () => (open = false)))}
            >
              <span class="check">{#if b.current}<Check weight="bold" />{/if}</span>
              <span class="name mono"><Highlight text={b.name} {indices} /></span>
              <span class="subject muted" title={b.subject}>{b.subject}</span>
              {#if b.track}<span class="track">{b.track}</span>{/if}
              <span class="when muted">{formatRelative(b.time * 1000)}</span>
            </li>
          {/each}
        </ol>
      {/if}
      <p class="foot muted">Uses <code>git switch</code>: uncommitted changes come along, and it refuses if they'd be overwritten.</p>
    </div>
  </Popover>
{/if}

<style>
  .branch {
    font-family: var(--mono);
    font-weight: 400;
  }

  .panel {
    display: flex;
    flex-direction: column;
    gap: var(--gap-3);
  }

  p {
    margin: var(--gap-2) var(--gap-3);
  }

  ol {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 50vh;
    overflow: auto;
  }

  li {
    cursor: pointer;
    font-size: var(--fs-base);
  }

  .check {
    width: 12px;
    display: flex;
    font-size: var(--icon-sm);
    color: var(--theme2);
  }

  .name {
    color: var(--color2);
    flex-shrink: 0;
    max-width: 45%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  li.current .name {
    color: var(--theme2);
  }

  .subject {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-sm);
  }

  .track {
    font-size: var(--fs-xs);
    color: var(--warn);
    flex-shrink: 0;
  }

  .when {
    font-size: var(--fs-xs);
    flex-shrink: 0;
  }

  .foot {
    font-size: var(--fs-xs);
  }

  code {
    font-family: var(--mono);
    font-size: var(--fs-xs);
  }
</style>
