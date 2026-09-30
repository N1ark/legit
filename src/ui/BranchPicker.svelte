<script lang="ts">
  import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon';
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon';
  import GitBranchIcon from 'phosphor-svelte/lib/GitBranchIcon';
  import type { BranchInfo } from '../shared/types.ts';
  import { ago, app, shortSha } from './lib/app.svelte.ts';

  let open = $state(false);
  let list = $state<BranchInfo[] | null>(null);
  let filter = $state('');
  let active = $state(0);
  let input = $state<HTMLInputElement>();

  const shown = $derived((list ?? []).filter((b) => b.name.toLowerCase().includes(filter.trim().toLowerCase())));
  const disabled = $derived(!!app.repo?.blocked || app.busy);

  export async function show() {
    if (disabled) return;
    open = true;
    filter = '';
    active = 0;
    requestAnimationFrame(() => input?.focus());
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
      app.toast(`Switched to ${b.name}`);
    }
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = shown.length;
      if (n) active = (active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      document.querySelector(`.branches li:nth-child(${active + 1})`)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(shown[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      open = false;
    }
  }
</script>

<div class="wrap">
  <button class="ghost branch" onclick={() => (open ? (open = false) : show())} {disabled} title="Switch branch (b)">
    <GitBranchIcon size={14} />
    <span>{app.repo?.branch ?? `detached @ ${app.repo?.head ? shortSha(app.repo.head) : '?'}`}</span>
    <CaretDownIcon size={10} />
  </button>
  {#if open}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="backdrop" onclick={() => (open = false)}></div>
    <div class="panel">
      <input
        bind:this={input}
        bind:value={filter}
        oninput={() => (active = 0)}
        {onkeydown}
        placeholder="Switch to branch…"
        spellcheck="false"
        class="mono"
      />
      {#if list === null}
        <p class="dim">Loading…</p>
      {:else if !shown.length}
        <p class="dim">No matching branch.</p>
      {:else}
        <ol class="branches">
          {#each shown as b, k (b.name)}
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
            <li class:active={k === active} class:current={b.current} onclick={() => choose(b)} onmousemove={() => (active = k)}>
              <span class="check">{#if b.current}<CheckIcon size={12} weight="bold" />{/if}</span>
              <span class="name mono">{b.name}</span>
              <span class="subject dim" title={b.subject}>{b.subject}</span>
              {#if b.track}<span class="track">{b.track}</span>{/if}
              <span class="when dim">{ago(b.time)}</span>
            </li>
          {/each}
        </ol>
      {/if}
      <p class="foot dim">Uses <code>git switch</code>: uncommitted changes come along, and it refuses if they'd be overwritten.</p>
    </div>
  {/if}
</div>

<style>
  .wrap {
    position: relative;
  }

  .branch {
    gap: 5px;
    color: var(--dim);
    font-family: var(--font-mono);
    font-size: 12px;
    padding: 3px 6px;
  }

  .branch:hover:not(:disabled) {
    color: var(--color2);
  }

  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 19;
  }

  .panel {
    position: absolute;
    left: 0;
    top: calc(100% + 6px);
    z-index: 20;
    width: min(560px, calc(100vw - 32px));
    background: var(--bg2);
    border-radius: 6px;
    box-shadow: var(--box-shadow), 0 12px 40px #0004;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  input {
    width: 100%;
    font-size: 12.5px;
  }

  p {
    margin: 4px 6px;
  }

  ol {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 50vh;
    overflow: auto;
  }

  li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 6px;
    border-radius: 4px;
    cursor: pointer;
  }

  li.active {
    background: var(--theme-soft);
  }

  .check {
    width: 12px;
    display: flex;
    color: var(--theme);
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
    color: var(--theme);
  }

  .subject {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
  }

  .track {
    font-size: 11px;
    color: var(--warn);
    flex-shrink: 0;
  }

  .when {
    font-size: 11px;
    flex-shrink: 0;
  }

  .foot {
    font-size: 11px;
  }

  code {
    font-family: var(--font-mono);
    font-size: 11px;
  }
</style>
