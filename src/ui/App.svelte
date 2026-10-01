<script lang="ts">
  import {
    ContextMenuHost,
    DialogHost,
    IS_TAURI,
    IconButton,
    Kbd,
    MOD,
    ResizeEdge,
    ShortcutsOverlay,
    Spinner,
    ToastHost,
    createKeymap,
    isTyping,
    persisted,
    type Binding,
  } from 'purr';
  import { ArrowUUpLeft, ArrowUUpRight, Warning } from 'purr/icons';
  import { onMount } from 'svelte';
  import Backups from './Backups.svelte';
  import StashBanner from './StashBanner.svelte';
  import StashPanel from './StashPanel.svelte';
  import SwitchDialog from './SwitchDialog.svelte';
  import BranchPicker from './BranchPicker.svelte';
  import CommitList from './CommitList.svelte';
  import PushButton from './PushButton.svelte';
  import RepoPicker from './RepoPicker.svelte';
  import CommitView from './CommitView.svelte';
  import ConflictView from './ConflictView.svelte';
  import SquashView from './SquashView.svelte';
  import StashView from './StashView.svelte';
  import WorkView from './WorkView.svelte';
  import { WORK, app } from './lib/app.svelte.ts';

  let branchPicker = $state<BranchPicker>();
  let repoPicker = $state<RepoPicker>();
  let help = $state(false);

  // The commit list's width: dragged live, remembered when the drag ends.
  const LIST_WIDTH = 440;
  const savedListWidth = persisted('legit:list-width', LIST_WIDTH);
  let listWidth = $state(savedListWidth.value);

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

  type Action =
    | 'undo' | 'redo' | 'branch' | 'repo' | 'help' | 'down' | 'up' | 'addDown' | 'addUp' | 'moveDown' | 'moveUp'
    | 'open' | 'close';
  const C = 'Commits';
  const bindings: Binding<Action>[] = [
    { keys: 'j', action: 'down', label: 'Next commit', group: C },
    { keys: '↓', action: 'down', label: 'Next commit', group: C },
    { keys: 'k', action: 'up', label: 'Previous commit', group: C },
    { keys: '↑', action: 'up', label: 'Previous commit', group: C },
    { keys: '⇧↓', action: 'addDown', label: 'Select the next one too', group: C },
    { keys: '⇧↑', action: 'addUp', label: 'Select the previous one too', group: C },
    { keys: '⌥↓', action: 'moveDown', label: 'Move down', group: C },
    { keys: '⇧J', action: 'moveDown', label: 'Move down', group: C },
    { keys: '⌥j', action: 'moveDown', label: 'Move down', group: C, hidden: true },
    { keys: '⌥↑', action: 'moveUp', label: 'Move up', group: C },
    { keys: '⇧K', action: 'moveUp', label: 'Move up', group: C },
    { keys: '⌥k', action: 'moveUp', label: 'Move up', group: C, hidden: true },
    { keys: '→', action: 'open', label: "Show a merge's commits", group: C },
    { keys: '←', action: 'close', label: "Hide a merge's commits", group: C },
    // In a field, ⌘Z is the field's own undo.
    { keys: '⌘Z', action: 'undo', label: 'Undo', typing: false },
    { keys: '⇧⌘Z', action: 'redo', label: 'Redo', typing: false },
    { keys: 'b', action: 'branch', label: 'Switch branch' },
    // Only the desktop app has other repositories to switch to (and ⌘T opens a tab in a browser).
    ...(IS_TAURI ? [{ keys: '⌘T', action: 'repo' as const, label: 'Switch repository' }] : []),
    { keys: '?', action: 'help', label: 'Show shortcuts' },
  ];
  const keymap = createKeymap(bindings);
  const shortcuts = keymap.help({
    groups: ['General', C],
    extra: [
      { label: 'Select several (click)', hints: [MOD, '⇧'], group: C },
      { label: 'Save, commit or squash', hints: ['⌘↩'] },
      { label: 'Stage / unstage picked changes', hints: ['s', 'u'] },
      { label: "Remove picked changes from the commit", hints: ['⌫'] },
      { label: 'Editing a line (double-click it): save / add a line', hints: ['↩', '⇧↩'] },
      { label: 'Revert edits, clear picked changes', hints: ['Esc'] },
    ],
  });

  function run(action: Action) {
    if (action === 'undo') app.undo();
    else if (action === 'redo') app.redo();
    else if (action === 'branch') branchPicker?.show();
    else if (action === 'repo') repoPicker?.show();
    else if (action === 'help') help = true;
    else if (action === 'down' || action === 'up') app.step(action === 'down' ? 1 : -1);
    else if (action === 'addDown' || action === 'addUp') app.step(action === 'addDown' ? 1 : -1, true);
    else if (action === 'open' || action === 'close') {
      const c = app.selection.length === 1 ? app.selection[0] : null;
      const merge = c?.side ?? (c?.merge ? c.sha : null);
      if (merge) app.toggleMerge(merge, action === 'open');
    }
    else app.move(action === 'moveDown' ? 1 : -1);
  }
</script>

<svelte:window onkeydown={(e) => keymap.handle(e, run)} />

<div class="shell">
  <header class:desktop={IS_TAURI} data-tauri-drag-region>
    <span class="brand" data-tauri-drag-region>legit</span>
    {#if app.repo}
      <RepoPicker bind:this={repoPicker} />
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
    <StashPanel />
    <Backups />
  </header>

  {#if app.repo?.blocked}
    <div class="blocked">
      <Warning weight="bold" />
      {app.repo.blocked} History is read-only.
      {#if app.repo.conflict}
        <button class="btn btn--link" onclick={() => app.selectWork()}>Resolve, continue or abort it</button>
      {/if}
    </div>
  {/if}

  <main style:grid-template-columns="min({listWidth}px, 70%) 1fr">
    <aside>
      <ResizeEdge
        side="left"
        label="Resize the commit list"
        size={listWidth}
        min={260}
        max={900}
        preset={LIST_WIDTH}
        onresize={(w) => (listWidth = w)}
        oncommit={(w) => (savedListWidth.value = w)}
      />
      <StashBanner />
      <CommitList />
      <footer class="muted">
        <span><Kbd hint="j" /><Kbd hint="k" /> move</span>
        <span><Kbd hint="⌥↑" /><Kbd hint="⌥↓" /> reorder</span>
        <span><Kbd hint={MOD} />/<Kbd hint="⇧" />+click select many</span>
        <span><Kbd hint="?" /> more</span>
      </footer>
    </aside>
    <section data-scroller>
      {#if app.stash}
        {#key app.stash.sha}
          <StashView stash={app.stash} />
        {/key}
      {:else if app.selected[0] === WORK && app.repo?.conflict}
        <ConflictView />
      {:else if app.selected[0] === WORK}
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
<DialogHost />
<SwitchDialog />
<ToastHost position="bottom-end" />
{#if help}
  <ShortcutsOverlay groups={shortcuts} onclose={() => (help = false)} />
{/if}

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
    min-height: 0;
  }

  aside {
    position: relative;
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
