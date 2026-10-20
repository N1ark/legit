<script lang="ts">
  import { Avatar, Spinner, Tag, Twisty, VirtualList, formatRelative, isMac, menu, tooltip } from 'purr';
  import { tick } from 'svelte';
  import { ArrowUUpLeft, ArrowsMerge, CloudCheck, Copy, CopySimple, DotsSixVertical, GitBranch, GitMerge, Hash, PencilSimpleLine, Stack, Trash, Users } from 'purr/icons';
  import { WORK, app, avatarUrl, shortSha } from './lib/app.svelte.ts';
  import type { CommitInfo } from '../shared/types.ts';
  import Markdown from './Markdown.svelte';
  import CommitChecks from './gh/CommitChecks.svelte';
  import { copyToBranch, newBranch, rebuildOn } from './lib/branches.svelte.ts';

  let list = $state<HTMLDivElement>();
  let rows = $state<{ scrollToIndex: (index: number) => void }>();
  let probe = $state<HTMLDivElement>();

  /** What the list shows, in order: each a row of the virtual list. */
  type Item =
    | { kind: 'work'; key: string }
    | { kind: 'boundary'; key: string; merge: boolean }
    | { kind: 'commit'; key: string; c: CommitInfo; i: number }
    | { kind: 'note'; key: string; side: boolean; loading?: boolean; more?: number };

  const items = $derived.by(() => {
    const out: Item[] = [];
    const commits = app.commits;
    if (app.hasWork && app.repo) out.push({ kind: 'work', key: WORK });
    for (let i = 0; i < commits.length; i++) {
      const c = commits[i];
      if (!c.editable && (i === 0 || commits[i - 1].editable)) out.push({ kind: 'boundary', key: `boundary:${c.sha}`, merge: c.merge });
      out.push({ kind: 'commit', key: c.sha, c, i });
      const m = c.merge ? app.expanded[c.sha] : undefined;
      if (m === null) out.push({ kind: 'note', key: `note:${c.sha}`, side: true, loading: true });
      else if (m?.commits.length === 0) out.push({ kind: 'note', key: `note:${c.sha}`, side: true });
      if (c.side && commits[i + 1]?.side !== c.side) {
        const s = app.expanded[c.side];
        if (s && s.total > s.commits.length) out.push({ kind: 'note', key: `more:${c.side}`, side: true, more: s.total - s.commits.length });
      }
    }
    if (app.loadingOlder) out.push({ kind: 'note', key: 'older', side: false, loading: true });
    return out;
  });
  /** Where each SHA (and the work row) sits in `items`. */
  const positions = $derived.by(() => {
    const at = new Map<string, number>();
    items.forEach((it, k) => (it.kind === 'commit' || it.kind === 'work') && at.set(it.key, k));
    return at;
  });
  const options = $derived(app.commits.length + (app.hasWork ? 1 : 0));

  /** The read-only divider's height, which follows the font: measured once, off-screen. */
  let boundaryHeight = $state(36);
  $effect(() => {
    if (probe) boundaryHeight = parseFloat(getComputedStyle(probe).height);
  });
  const ROW = 30;
  const heightOf = (it: Item) => (it.kind === 'boundary' ? boundaryHeight : ROW);

  /** Whether the item at `k` is a selected row, which a selected neighbour joins up with. */
  function joined(k: number): boolean {
    const it = items[k];
    return it?.kind === 'commit' ? app.selected.includes(it.c.sha) : it?.kind === 'work' && app.selected[0] === WORK;
  }

  // Keyboard steps bring the new row into view, mounted or not.
  $effect(() => {
    app.reveal = (sha) => rows?.scrollToIndex(positions.get(sha) ?? -1);
    return () => (app.reveal = null);
  });

  $effect(() => app.keep('list', () => list?.scrollTop ?? 0));
  $effect(() => {
    const top = app.started ? app.restore<number>('list') : undefined;
    if (top) tick().then(() => list && (list.scrollTop = top));
  });
  let dragging = $state<string[] | null>(null);
  let drop = $state<{ sha: string; after: boolean } | null>(null);

  function onclick(e: MouseEvent, sha: string) {
    app.select(sha, e.shiftKey ? 'range' : (isMac ? e.metaKey : e.ctrlKey) ? 'toggle' : 'set');
  }

  // Right-click inside a multi-selection offers to squash it; elsewhere it just selects the row.
  const canSquash = $derived(
    app.selection.length > 1 && app.selection.every((c) => c.editable) && !app.repo?.blocked,
  );

  /** Cherry-pick commits onto another branch, picked from the branch list. */
  function copyEntry(commits: CommitInfo[]) {
    const merge = commits.some((c) => c.merge);
    return {
      label: commits.length > 1 ? `Copy ${commits.length} commits to branch…` : 'Copy to branch…',
      icon: CopySimple,
      disabled: app.busy || !!app.repo?.blocked || merge,
      note: merge ? "Merges can't be cherry-picked." : 'Cherry-picked there, without switching',
      run: () => copyToBranch(commits.map((c) => c.sha)),
    };
  }

  /** Make the current branch another one plus these commits, picked from the branch list. */
  function rebuildEntry(commits: CommitInfo[]) {
    const merge = commits.some((c) => c.merge);
    const here = app.repo?.branch;
    return {
      label: `Rebuild ${here ?? 'branch'} on…`,
      icon: Stack,
      disabled: app.busy || !!app.repo?.blocked || merge || !here,
      note: merge
        ? "Merges can't be replayed."
        : !here
          ? 'HEAD is detached.'
          : `With only ${commits.length > 1 ? `these ${commits.length} commits` : 'this commit'} on top; the others are dropped`,
      run: () => rebuildOn(commits.map((c) => c.sha)),
    };
  }

  function oncontextmenu(e: MouseEvent, sha: string) {
    e.preventDefault();
    if (app.selected.includes(sha) && app.selected.length > 1) {
      menu.show(e, [
        {
          label: `Squash ${app.selection.length} commits`,
          icon: ArrowsMerge,
          disabled: !canSquash || app.busy,
          note: canSquash
            ? `Into ${shortSha(app.selection.at(-1)!)}, with the message on the right`
            : "Some of these commits can't be rewritten.",
          run: () => app.squash(app.selection),
        },
        copyEntry(app.selection),
        rebuildEntry(app.selection),
        'separator',
        {
          label: `Drop ${app.selection.length} commits`,
          icon: Trash,
          danger: true,
          disabled: !canSquash || app.busy,
          confirm: `Click again to drop ${app.selection.length} commits`,
          run: () => app.drop(app.selection),
        },
      ]);
      return;
    }
    app.select(sha);
    const c = app.bySha.get(sha);
    if (!c) return;
    const blocked = !!app.repo?.blocked;
    menu.show(e, [
      // The newest commit can be undone (its changes stay staged).
      sha === app.repo?.head && c.editable && !c.merge && !blocked && {
        label: 'Undo commit (keep changes)',
        icon: ArrowUUpLeft,
        disabled: app.busy,
        note: c.pushed ? "It was pushed: you'll need to force push afterwards." : undefined,
        run: () => app.uncommit(),
      },
      c.editable && !c.merge && !blocked && {
        label: 'Edit files…',
        icon: PencilSimpleLine,
        disabled: app.busy,
        note: 'Check it out, change anything, then finish to amend',
        run: () => app.editCommit(c.sha),
      },
      {
        label: 'New branch from here…',
        icon: GitBranch,
        disabled: app.busy || blocked,
        run: () => newBranch(c.sha, `"${c.subject}"`),
      },
      copyEntry([c]),
      rebuildEntry([c]),
      'separator',
      { label: 'Copy hash', icon: Copy, run: () => app.copy(c.sha, shortSha(c)) },
      { label: 'Copy short hash', icon: Hash, run: () => app.copy(shortSha(c)) },
      c.editable && !blocked && 'separator',
      c.editable && !blocked && {
        label: 'Drop this commit',
        icon: Trash,
        danger: true,
        disabled: app.busy,
        note: c.pushed ? "It was pushed: you'll need to force push afterwards." : undefined,
        confirm: 'Click again to drop',
        run: () => app.drop([c]),
      },
    ]);
  }

  // Rows scrolling under a still pointer aren't being pointed at: prefetching each would queue dozens of diffs.
  let scrolledAt = 0;
  function onscroll() {
    scrolledAt = performance.now();
    loadIfNearEnd();
  }
  function hovered(sha: string) {
    if (performance.now() - scrolledAt > 150) app.prefetch(sha);
  }

  // Older history loads as the list nears its end, and again after each page if it still does.
  function loadIfNearEnd() {
    if (list && list.scrollHeight - list.scrollTop - list.clientHeight < 600) app.loadOlder();
  }

  $effect(() => {
    void app.commits.length;
    if (!app.loadingOlder) tick().then(loadIfNearEnd);
  });

  function ondragstart(e: DragEvent, sha: string) {
    if (!app.selected.includes(sha) || app.selection.some((c) => !c.editable)) app.select(sha);
    dragging = app.editable.map((c) => c.sha).filter((s) => app.selected.includes(s));
    e.dataTransfer!.effectAllowed = 'move';
    e.dataTransfer!.setData('text/plain', dragging.join(' '));
    // A row scrolled out of view is unmounted, and its dragend never comes: the next pointer move after the drag ends it.
    window.addEventListener('pointermove', () => dragging && ondragend(), { once: true });
  }

  function ondragover(e: DragEvent, sha: string) {
    if (!dragging) return;
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    drop = { sha, after: e.clientY > r.top + r.height / 2 };
  }

  function ondrop(e: DragEvent) {
    e.preventDefault();
    if (dragging && drop && !dragging.includes(drop.sha)) {
      const rest = app.editable.map((c) => c.sha).filter((s) => !dragging!.includes(s));
      const at = rest.indexOf(drop.sha) + (drop.after ? 1 : 0);
      app.reorder([...rest.slice(0, at), ...dragging, ...rest.slice(at)]);
    }
    ondragend();
  }

  function ondragend() {
    dragging = null;
    drop = null;
  }
</script>

<!-- Only the rows in view are mounted: histories run to thousands of commits. -->
<div class="list" role="listbox" aria-multiselectable="true" bind:this={list} onscroll={onscroll}>
  <div class="probe" aria-hidden="true"><div bind:this={probe}><div class="boundary">read-only</div></div></div>
  {#if list}
    <VirtualList bind:this={rows} {items} rowHeight={heightOf} key={(it) => it.key} scroller={list}>
      {#snippet children(it, index)}
        {@const up = joined(index - 1)}
        {@const down = joined(index + 1)}
        {#if it.kind === 'work' && app.repo}
          {@const w = app.repo.work}
          <!-- svelte-ignore a11y_interactive_supports_focus -->
          <div
            data-sha={WORK}
            class="row work"
            class:is-current={app.selected[0] === WORK}
            class:join-up={app.selected[0] === WORK && up}
            class:join-down={app.selected[0] === WORK && down}
            role="option"
            aria-selected={app.selected[0] === WORK}
            aria-setsize={options}
            aria-posinset={1}
            onclick={() => app.selectWork()}
            onkeydown={() => {}}
          >
            <span class="grip"><PencilSimpleLine /></span>
            {#if app.repo.conflict?.edit}
              <span class="subject">Editing "{app.repo.conflict.edit.subject}"</span>
            {:else if app.repo.conflict}
              {@const c = app.repo.conflict}
              <span class="subject">{c.kind === 'am' ? 'Patch series' : c.kind[0].toUpperCase() + c.kind.slice(1)} in progress</span>
              {#if c.files.length}<span use:tooltip={'Files with conflicts'}><Tag color="var(--warn)" label="{c.files.length} conflicted" /></span>{/if}
            {:else}
              <span class="subject">Uncommitted changes</span>
            {/if}
            {#if w.staged}<span use:tooltip={'Files with staged changes'}><Tag color="var(--add)" label="{w.staged} staged" /></span>{/if}
            {#if w.unstaged}<span use:tooltip={'Files with unstaged changes'}><Tag label="{w.unstaged} changed" /></span>{/if}
            {#if w.untracked}<span use:tooltip={'Untracked files'}><Tag label="{w.untracked} new" /></span>{/if}
          </div>
        {:else if it.kind === 'boundary'}
          <div class="boundary muted">
            <span use:tooltip={it.merge ? "History below a merge can't be rewritten" : "Older history can't be rewritten here"}>read-only</span>
          </div>
        {:else if it.kind === 'commit'}
          {@const c = it.c}
          {@const selected = app.selected.includes(c.sha)}
          <!-- svelte-ignore a11y_interactive_supports_focus -->
          <div
            data-sha={c.sha}
            class="row"
            class:is-current={selected}
            class:join-up={selected && up}
            class:join-down={selected && down}
            class:locked={!c.editable}
            class:side={c.side}
            class:dnd-dragging={dragging?.includes(c.sha)}
            class:dnd-before={drop?.sha === c.sha && !drop.after}
            class:dnd-after={drop?.sha === c.sha && drop.after}
            role="option"
            aria-selected={selected}
            aria-setsize={options}
            aria-posinset={it.i + (app.hasWork ? 2 : 1)}
            draggable={c.editable && !app.repo?.blocked}
            onclick={(e) => onclick(e, c.sha)}
            onmouseenter={() => hovered(c.sha)}
            oncontextmenu={(e) => oncontextmenu(e, c.sha)}
            onkeydown={() => {}}
            ondragstart={(e) => ondragstart(e, c.sha)}
            ondragover={(e) => c.editable && ondragover(e, c.sha)}
            ondragleave={() => drop?.sha === c.sha && (drop = null)}
            {ondrop}
            {ondragend}
          >
            {#if c.merge && !c.side}
              {@const open = c.sha in app.expanded}
              <button
                class="grip twisty"
                use:tooltip={open ? 'Hide the merged commits' : 'Show the merged commits'}
                aria-label={open ? 'Hide the merged commits' : 'Show the merged commits'}
                aria-expanded={open}
                onclick={(e) => {
                  e.stopPropagation();
                  app.toggleMerge(c.sha);
                }}
              >
                <Twisty {open} size={10} />
              </button>
            {:else}
              <span class="grip">
                {#if c.merge}<GitMerge />{:else if c.editable}<DotsSixVertical weight="bold" />{/if}
              </span>
            {/if}
            <span class="sha mono">{shortSha(c)}</span>
            <span class="who" use:tooltip={`${c.author.name} <${c.author.email}>`}>
              <Avatar
                name={c.author.name}
                src={avatarUrl(c.author.email, 16)}
                seed={c.author.email.toLowerCase()}
                size={16}
                round
                title=""
              />
            </span>
            <span class="subject" class:muted={!c.subject}
              >{#if c.subject}<Markdown text={c.subject} inline links="mod" />{:else}(no message){/if}</span
            >
            {#if c.coauthors.length}
              <span class="meta" use:tooltip={c.coauthors.map((p) => p.name).join(', ')}><Users /></span>
            {/if}
            <span class="meta">{formatRelative(c.author.time * 1000)}</span>
            {#if c.pushed}<CommitChecks sha={c.sha} />{/if}
            <span class="meta pushed" use:tooltip={c.pushed ? 'Pushed: rewriting it needs a force-push' : null}>{#if c.pushed}<CloudCheck />{/if}</span>
          </div>
        {:else if it.kind === 'note'}
          <div class="note muted" class:side={it.side}>
            {#if it.more !== undefined}…and {it.more} more{:else if it.loading}<Spinner size={12} /> Loading…{:else}No commits brought in{/if}
          </div>
        {/if}
      {/snippet}
    </VirtualList>
  {/if}
</div>

<style>
  .list {
    position: relative;
    padding: var(--gap-3) 0;
    overflow: auto;
    flex: 1;
  }

  /* Out of the way, and adding nothing to what scrolls. */
  .probe {
    position: absolute;
    width: 100%;
    height: 0;
    overflow: hidden;
    visibility: hidden;
  }

  .probe > div {
    display: flow-root;
  }

  /* Each item fills the virtual list's row it sits in. */
  .row,
  .note,
  .boundary {
    flex: 1;
    min-width: 0;
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--gap-4);
    height: 30px;
    padding: 0 var(--sp-4) 0 var(--gap-2);
    margin: 0 var(--gap-3);
    border-radius: var(--radius);
    cursor: default;
  }

  @media (hover: hover) {
    .row:hover {
      background: var(--bg3);
    }
  }

  .row.is-current {
    background: var(--theme-soft);
  }

  /* Adjacent selected rows read as one block, with a thin divider between them. */
  .row.join-down {
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
  }

  .row.join-up {
    position: relative;
    border-top-left-radius: 0;
    border-top-right-radius: 0;
  }

  .row.join-up::before {
    content: '';
    position: absolute;
    top: 0;
    left: var(--gap-3);
    right: var(--gap-3);
    border-top: 1px solid color-mix(in oklch, var(--theme2) 14%, transparent);
  }

  .row.is-current .subject {
    color: var(--color2);
  }

  .row.locked {
    opacity: 0.5;
  }

  .grip {
    width: 14px;
    display: flex;
    font-size: var(--icon-md);
    color: var(--muted);
    opacity: 0.5;
    flex-shrink: 0;
  }

  .row[draggable='true'] .grip {
    cursor: grab;
  }

  .row:hover .grip {
    opacity: 1;
  }

  .sha {
    color: var(--theme2);
    flex-shrink: 0;
  }

  .subject {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta {
    display: flex;
    color: var(--muted);
    font-size: var(--fs-xs);
    flex-shrink: 0;
  }

  .who {
    display: flex;
    flex-shrink: 0;
  }

  .pushed {
    width: 13px;
    font-size: var(--icon-md);
  }

  .side {
    margin-left: calc(var(--gap-3) + 18px);
  }

  .twisty {
    all: unset;
    width: 14px;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    opacity: 1;
    cursor: pointer;
  }

  .note {
    display: flex;
    align-items: center;
    gap: var(--gap-3);
    height: 30px;
    padding: 0 var(--sp-4) 0 var(--sp-5);
    font-size: var(--fs-xs);
  }

  .row.work .subject {
    font-style: italic;
    color: var(--color2);
  }

  .row.work .grip {
    opacity: 1;
    color: var(--theme2);
  }

  .boundary {
    font-size: var(--fs-xs);
    padding: var(--sp-4) var(--sp-5) var(--gap-2);
    border-top: 1px dashed var(--border);
    margin-top: var(--gap-3);
  }
</style>
