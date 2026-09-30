<script lang="ts">
  import ArrowUUpLeftIcon from 'phosphor-svelte/lib/ArrowUUpLeftIcon';
  import ArrowUUpRightIcon from 'phosphor-svelte/lib/ArrowUUpRightIcon';
  import GitBranchIcon from 'phosphor-svelte/lib/GitBranchIcon';
  import WarningIcon from 'phosphor-svelte/lib/WarningIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';
  import { onMount } from 'svelte';
  import Backups from './Backups.svelte';
  import CommitList from './CommitList.svelte';
  import CommitView from './CommitView.svelte';
  import SquashView from './SquashView.svelte';
  import { app, shortSha } from './lib/app.svelte.ts';

  const mac = navigator.platform.startsWith('Mac');
  const mod = mac ? '⌘' : 'Ctrl';
  // Running inside the desktop app: the header is the title bar.
  const desktop = '__TAURI_INTERNALS__' in window;

  // Called by the desktop app's Edit ▸ Undo/Redo menu items, which take ⌘Z before the page sees it.
  const typing = () => !!document.activeElement?.closest('input, textarea, [contenteditable]');
  (window as any).__legit = {
    undo: () => (typing() ? document.execCommand('undo') : app.undo()),
    redo: () => (typing() ? document.execCommand('redo') : app.redo()),
  };

  onMount(() => {
    app.refresh();
    const events = new EventSource('/api/events');
    events.onmessage = () => app.refresh();
    const focus = () => app.refresh();
    window.addEventListener('focus', focus);
    return () => {
      events.close();
      window.removeEventListener('focus', focus);
    };
  });

  function onkeydown(e: KeyboardEvent) {
    const typing = (e.target as HTMLElement).closest('input, textarea, [contenteditable]');
    const cmd = mac ? e.metaKey : e.ctrlKey;
    if (cmd && e.key.toLowerCase() === 'z' && !typing) {
      e.preventDefault();
      if (e.shiftKey) app.redo();
      else app.undo();
      return;
    }
    if (typing || cmd || e.defaultPrevented) return;
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
  <header class:desktop data-tauri-drag-region>
    <span class="brand" data-tauri-drag-region>legit</span>
    {#if app.repo}
      <span class="repo" title={app.repo.root} data-tauri-drag-region>{app.repo.name}</span>
      <span class="branch" data-tauri-drag-region>
        <GitBranchIcon size={14} />
        {app.repo.branch ?? `detached @ ${app.repo.head ? shortSha(app.repo.head) : '?'}`}
      </span>
    {/if}
    <span class="spacer" data-tauri-drag-region></span>
    {#if app.busy}<span class="spinner" aria-label="Working"></span>{/if}
    <button class="ghost" disabled={!app.repo?.canUndo || app.busy} onclick={app.undo} title="Undo ({mod}Z)">
      <ArrowUUpLeftIcon size={16} />
    </button>
    <button class="ghost" disabled={!app.repo?.canRedo || app.busy} onclick={app.redo} title="Redo ({mod}⇧Z)">
      <ArrowUUpRightIcon size={16} />
    </button>
    <Backups />
  </header>

  {#if app.repo?.blocked}
    <div class="blocked"><WarningIcon size={14} weight="bold" /> {app.repo.blocked} History is read-only.</div>
  {/if}

  <main>
    <aside>
      <CommitList />
      <footer class="dim">
        <span><kbd>j</kbd><kbd>k</kbd> move</span>
        <span><kbd>⌥↑</kbd><kbd>⌥↓</kbd> reorder</span>
        <span><kbd>{mod}</kbd>/<kbd>⇧</kbd>+click select many</span>
      </footer>
    </aside>
    <section data-scroller>
      {#if app.selection.length > 1}
        <SquashView commits={app.selection} />
      {:else if app.selection.length === 1}
        {#key app.selection[0].sha}
          <CommitView commit={app.selection[0]} />
        {/key}
      {:else if app.repo}
        <p class="empty dim">{app.repo.blocked ?? 'No commit selected.'}</p>
      {/if}
    </section>
  </main>

  <div class="toasts">
    {#each app.toasts as t (t.id)}
      <div class="toast {t.kind}">
        <span>{t.text}</span>
        <button class="ghost" onclick={() => (app.toasts = app.toasts.filter((x) => x.id !== t.id))}>
          <XIcon size={12} />
        </button>
      </div>
    {/each}
  </div>
</div>

<style>
  .shell {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 12px 8px 16px;
    border-bottom: 1px solid var(--border);
    background:
      linear-gradient(90deg, var(--theme-soft), transparent 60%),
      var(--bg2);
    flex-shrink: 0;
  }

  header.desktop {
    height: 50px;
    padding-left: 88px;
    user-select: none;
    -webkit-user-select: none;
  }

  header.desktop .brand {
    display: none;
  }

  .brand {
    font-weight: 700;
    font-size: 15px;
    color: var(--theme);
    letter-spacing: -0.02em;
  }

  .repo {
    font-weight: 600;
    color: var(--color2);
  }

  .branch {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--dim);
    font-family: var(--font-mono);
    font-size: 12px;
  }

  .spacer {
    flex: 1;
  }

  .spinner {
    width: 12px;
    height: 12px;
    border: 2px solid var(--theme-mid);
    border-top-color: var(--theme);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .blocked {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 16px;
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
    gap: 4px 12px;
    padding: 6px 12px;
    border-top: 1px solid var(--border);
    font-size: 11px;
  }

  section {
    overflow: auto;
    min-width: 0;
  }

  .empty {
    padding: 40px;
    text-align: center;
  }

  .toasts {
    position: fixed;
    right: 16px;
    bottom: 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    z-index: 100;
    max-width: min(480px, calc(100vw - 32px));
  }

  .toast {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 8px 8px 8px 12px;
    border-radius: 4px;
    background: var(--bg2);
    box-shadow: var(--box-shadow), 0 8px 24px #0003;
    white-space: pre-wrap;
    animation: pop 0.15s ease-out;
  }

  .toast span {
    flex: 1;
  }

  .toast.error {
    border-left: 3px solid var(--del);
  }

  .toast.info {
    border-left: 3px solid var(--theme);
  }

  @keyframes pop {
    from {
      transform: translateY(6px);
      opacity: 0;
    }
  }
</style>
