<script lang="ts">
  import {
    ContextMenuHost,
    IS_TAURI,
    IconButton,
    Kbd,
    MOD,
    Spinner,
    ToastHost,
    isMac,
    isTyping,
  } from 'purr';
  import { ArrowUUpLeft, ArrowUUpRight, Warning } from 'purr/icons';
  import { onMount } from 'svelte';
  import Backups from './Backups.svelte';
  import BranchPicker from './BranchPicker.svelte';
  import CommitList from './CommitList.svelte';
  import PushButton from './PushButton.svelte';
  import CommitView from './CommitView.svelte';
  import SquashView from './SquashView.svelte';
  import WorkView from './WorkView.svelte';
  import { WORK, app } from './lib/app.svelte.ts';

  let branchPicker = $state<BranchPicker>();

  // Called by the desktop app's Edit ▸ Undo/Redo menu items, which take ⌘Z before the page sees it.
  const typing = () => isTyping(document.activeElement);
  (window as any).__legit = {
    undo: () => (typing() ? document.execCommand('undo') : app.undo()),
    redo: () => (typing() ? document.execCommand('redo') : app.redo()),
  };

  onMount(() => {
    app.refresh();
    const events = new EventSource('/api/events');
    events.onmessage = (e) => (e.data === 'work' ? app.workChanged() : app.refresh());
    const focus = () => app.refresh();
    window.addEventListener('focus', focus);
    return () => {
      events.close();
      window.removeEventListener('focus', focus);
    };
  });

  function onkeydown(e: KeyboardEvent) {
    const typing = isTyping(e.target);
    const cmd = isMac ? e.metaKey : e.ctrlKey;
    if (cmd && e.key.toLowerCase() === 'z' && !typing) {
      e.preventDefault();
      if (e.shiftKey) app.redo();
      else app.undo();
      return;
    }
    if (typing || cmd || e.defaultPrevented) return;
    if (e.key === 'b' && !e.altKey) {
      e.preventDefault();
      branchPicker?.show();
      return;
    }
    const down = e.key === 'ArrowDown' || e.key === 'j' || e.key === 'J';
    const up = e.key === 'ArrowUp' || e.key === 'k' || e.key === 'K';
    if (!down && !up) return;
    e.preventDefault();
    if (e.altKey || e.key === 'J' || e.key === 'K') app.move(down ? 1 : -1);
    else app.step(down ? 1 : -1, e.shiftKey);
  }
</script>

<svelte:window {onkeydown} />

<div class="shell">
  <header class:desktop={IS_TAURI} data-tauri-drag-region>
    <span class="brand" data-tauri-drag-region>legit</span>
    {#if app.repo}
      <span class="repo" title={app.repo.root} data-tauri-drag-region>{app.repo.name}</span>
      <BranchPicker bind:this={branchPicker} />
    {/if}
    <span class="spacer" data-tauri-drag-region></span>
    {#if app.busy}<Spinner label="Working" />{/if}
    <PushButton />
    <IconButton label="Undo" shortcut="⌘Z" size="lg" disabled={!app.repo?.canUndo || app.busy} onclick={app.undo}>
      <ArrowUUpLeft />
    </IconButton>
    <IconButton label="Redo" shortcut="⇧⌘Z" size="lg" disabled={!app.repo?.canRedo || app.busy} onclick={app.redo}>
      <ArrowUUpRight />
    </IconButton>
    <Backups />
  </header>

  {#if app.repo?.blocked}
    <div class="blocked"><Warning weight="bold" /> {app.repo.blocked} History is read-only.</div>
  {/if}

  <main>
    <aside>
      <CommitList />
      <footer class="muted">
        <span><Kbd hint="j" /><Kbd hint="k" /> move</span>
        <span><Kbd hint="⌥↑" /><Kbd hint="⌥↓" /> reorder</span>
        <span><Kbd hint={MOD} />/<Kbd hint="⇧" />+click select many</span>
      </footer>
    </aside>
    <section data-scroller>
      {#if app.selected[0] === WORK}
        <WorkView />
      {:else if app.selection.length > 1}
        <SquashView commits={app.selection} />
      {:else if app.selection.length === 1}
        {#key app.selection[0].sha}
          <CommitView commit={app.selection[0]} />
        {/key}
      {:else if app.repo}
        <p class="empty muted">{app.repo.blocked ?? 'No commit selected.'}</p>
      {/if}
    </section>
  </main>
</div>

<ContextMenuHost />
<ToastHost position="bottom-end" />

<style>
  .shell {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  header {
    display: flex;
    align-items: center;
    gap: var(--sp-4);
    padding: var(--gap-4) var(--sp-4) var(--gap-4) var(--sp-5);
    border-bottom: 1px solid var(--border);
    background:
      linear-gradient(90deg, var(--theme-soft), transparent 60%),
      var(--bg2);
    flex-shrink: 0;
  }

  header.desktop {
    height: 50px;
    padding-left: 88px;
  }

  header.desktop .brand {
    display: none;
  }

  .brand {
    font-weight: 700;
    font-size: var(--fs-xl);
    color: var(--theme2);
    letter-spacing: -0.02em;
  }

  .repo {
    font-weight: 600;
    color: var(--color2);
  }

  .spacer {
    flex: 1;
  }

  .blocked {
    display: flex;
    align-items: center;
    gap: var(--gap-3);
    padding: var(--gap-3) var(--sp-5);
    background: var(--del-bg);
    color: var(--warn);
    border-bottom: 1px solid var(--border);
  }

  main {
    flex: 1;
    display: grid;
    grid-template-columns: minmax(300px, 34%) 1fr;
    min-height: 0;
  }

  aside {
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--border);
    background: var(--bg2);
    min-height: 0;
  }

  aside footer {
    display: flex;
    flex-wrap: wrap;
    gap: var(--gap-2) var(--sp-4);
    padding: var(--gap-3) var(--sp-4);
    border-top: 1px solid var(--border);
    font-size: var(--fs-xs);
  }

  footer span {
    display: inline-flex;
    align-items: baseline;
    gap: var(--gap-1);
  }

  section {
    overflow: auto;
    min-width: 0;
  }

  .empty {
    padding: 40px;
    text-align: center;
  }
</style>
