<script lang="ts">
  // A merge, rebase, cherry-pick or revert that stopped halfway (from legit or a terminal), or a
  // stash applied with conflicts: what's still conflicted, what's merged, and Continue or Abort. Files are resolved in an
  // editor; "Mark resolved" stages one ("Mark all resolved" every one), and asks again while it still has conflict markers.
  // A rebase also needs files changed since they were staged to be staged again. Abort saves
  // what was resolved before throwing it away.
  import { Button, ConfirmButton, Kbd, Tag, hasOverlay, matches, menu, tooltip } from 'purr';
  import { ArrowCounterClockwiseRegular, CheckBold, CheckRegular, ChecksRegular, CopyRegular, FileArrowUpRegular } from 'purr/glyphs';
  import { SvelteSet } from 'svelte/reactivity';
  import type { DiffSummary } from '../shared/types.ts';
  import DiffView from './DiffView.svelte';
  import { app } from './lib/app.svelte.ts';
  import { tip } from './lib/tip.ts';

  const c = $derived(app.repo?.conflict ?? null);
  const NAME = { merge: 'Merge', rebase: 'Rebase', 'cherry-pick': 'Cherry-pick', revert: 'Revert', am: 'git am', stash: 'Stash restore' };
  const CONTINUE = { merge: 'Commit merge', rebase: 'Continue rebase', 'cherry-pick': 'Continue cherry-pick', revert: 'Continue revert', am: 'Continue', stash: 'Done' };
  const name = $derived(c?.stash && !c.stash.pop ? 'Stash apply' : c ? NAME[c.kind] : '');
  // Unmerged files git left with nothing in progress: legit can't tell what aborting would put back.
  const abortable = $derived(!!c && (c.kind !== 'stash' || !!c.stash));

  // What finishing would change on top of HEAD, straight from the working tree (markers included).
  let diff = $state.raw<DiffSummary | null>(null);
  let error = $state<string | null>(null);
  let loading = false;
  let again = false;
  async function load() {
    if (loading) {
      again = true;
      return;
    }
    loading = true;
    try {
      const res = await fetch('/api/conflict');
      const d: DiffSummary | { error: string } = await res.json();
      if ('error' in d) error = d.error;
      else {
        error = null;
        if (d.sha !== diff?.sha) diff = d;
      }
    } finally {
      loading = false;
      if (again) {
        again = false;
        load();
      }
    }
  }

  // Derived, so a refresh that brings a new state but the same HEAD and conflicts doesn't load the diff again.
  const head = $derived(app.repo?.head);
  const conflicted = $derived(c ? c.files.length : null);
  $effect(() => {
    void app.workTick;
    void head;
    if (conflicted !== null) load();
  });

  const sel = $derived(diff ? Object.fromEntries(diff.files.map((f) => [f.path, new SvelteSet<number>()])) : {});
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

  const resolve = (path: string, force = false) => app.sync('resolve', { path, force });
  // Every conflicted file, and in a rebase every one changed since it was staged.
  const pending = $derived(c ? [...c.files.map((f) => f.path), ...c.unstaged] : []);
  const marked = $derived(c ? c.files.filter((f) => f.markers).length : 0);
  const resolveAll = (force = false) => app.sync('resolve', { paths: pending, force });
  // A conflict settled from its <<<<<<< line in the diff; the toast can put the file back.
  let picks = 0;
  function keep(path: string, line: number, side: 'ours' | 'theirs' | 'both') {
    const id = String(++picks);
    app.sync('resolveBlock', { path, line, side, id }, undefined, false, { label: 'Undo', run: () => app.sync('unresolveBlock', { path, id }) });
  }

  /** A listed file's menu: open it, mark it resolved (or stage it again), copy its path. */
  function fileMenu(e: MouseEvent, path: string, o: { line?: number | null; exists?: boolean; markers?: boolean; stage?: boolean } = {}) {
    e.preventDefault();
    menu.show(e, [
      {
        label: 'Open in Zed',
        icon: FileArrowUpRegular,
        disabled: o.exists === false,
        note: o.line ? `At line ${o.line}` : undefined,
        run: () => app.openInZed(path, o.line ?? undefined),
      },
      {
        label: o.stage ? 'Stage' : 'Mark resolved',
        icon: CheckRegular,
        disabled: app.busy,
        confirm: o.markers ? 'It still has conflict markers. Click again' : undefined,
        run: () => resolve(path, !!o.markers),
      },
      'separator',
      { label: 'Copy path', icon: CopyRegular, run: () => app.copy(`${app.repo?.root}/${path}`, 'path') },
      { label: 'Copy relative path', icon: CopyRegular, run: () => app.copy(path, 'relative path') },
    ]);
  }

  /** A path split into its folder (with the trailing slash) and the file's name. */
  const split = (path: string) => {
    const k = path.lastIndexOf('/') + 1;
    return { dir: path.slice(0, k), name: path.slice(k) };
  };

  const MERGED_SHOWN = 8;
  let allMerged = $state(false);
  const blocked = $derived(!!c && (c.files.length > 0 || c.unstaged.length > 0));

  function onkeydown(e: KeyboardEvent) {
    if (matches('⌘↩', e) && !e.isComposing && !hasOverlay() && c && abortable && !blocked && !app.busy) {
      e.preventDefault();
      app.sync('continue');
    }
  }
</script>

<svelte:window {onkeydown} />

{#if c}
  <div class="view">
    <div class="top">
      <h2 use:tooltip={"History can't be rewritten until it's finished or aborted"}>{abortable ? `${name} in progress` : 'Conflicts'}</h2>
      <span class="muted title" use:tooltip={c.title}>{c.title}</span>
    </div>

    <div class="meta">
      <p class="muted hint">
        {#if c.files.length}
          Pick a side on each conflict in the diff below, or resolve the file in your editor and mark it resolved.
        {:else if c.unstaged.length}
          Stage these again or undo their changes to continue.
        {:else}
          All resolved.
        {/if}
      </p>

      {#if c.files.length}
        <ul class="files">
          {#each c.files as f (f.path)}
            <li>
              {#if f.markers}
                <ConfirmButton
                  size="sm"
                  variant="default"
                  confirmLabel="It still has conflict markers. Mark resolved anyway?"
                  onconfirm={() => resolve(f.path, true)}
                  disabled={app.busy}><CheckRegular /> Mark resolved</ConfirmButton
                >
              {:else}
                <Button
                  size="sm"
                  onclick={() => resolve(f.path)}
                  disabled={app.busy}
                  {@attach tip(f.exists ? 'Stage the file as it is now (git add)' : 'Resolve by deleting the file (git add)')}
                >
                  <CheckRegular /> Mark resolved{f.exists ? '' : ' (deleted)'}
                </Button>
              {/if}
              <Button size="sm" variant="ghost" onclick={() => app.openInZed(f.path, f.line ?? undefined)} disabled={!f.exists}>
                <FileArrowUpRegular /> Open in Zed
              </Button>
              <span class="spacer"></span>
              {#if f.markers}<span use:tooltip={'<<<<<<<, ======= or >>>>>>> at a line start'}><Tag color="var(--warn)" label="conflict markers" /></span>{/if}
              <Tag label={f.status} />
              <button
                class="path mono"
                use:tooltip={`${f.path}${f.exists ? '\nDouble-click to open in Zed' : ''}`}
                ondblclick={() => f.exists && app.openInZed(f.path, f.line ?? undefined)}
                oncontextmenu={(e) => fileMenu(e, f.path, f)}>{f.path}</button
              >
            </li>
          {/each}
        </ul>
      {/if}

      {#if c.unstaged.length}
        <ul class="files">
          {#each c.unstaged as path (path)}
            <li>
              <Button size="sm" onclick={() => resolve(path)} disabled={app.busy} {@attach tip('Stage the file as it is now (git add)')}>
                <CheckRegular /> Stage
              </Button>
              <Button size="sm" variant="ghost" onclick={() => app.openInZed(path)}><FileArrowUpRegular /> Open in Zed</Button>
              <span class="spacer"></span>
              <Tag color="var(--warn)" label="changed since staged" />
              <button
                class="path mono"
                use:tooltip={`${path}\nDouble-click to open in Zed`}
                ondblclick={() => app.openInZed(path)}
                oncontextmenu={(e) => fileMenu(e, path, { stage: true })}>{path}</button
              >
            </li>
          {/each}
        </ul>
      {/if}

      {#if c.resolved.length}
        <div class="merged">
          <span class="muted">Merged: {plural(c.resolved.length, 'file')}</span>
          <ul class="mono">
            {#each allMerged ? c.resolved : c.resolved.slice(0, MERGED_SHOWN) as path (path)}
              {@const p = split(path)}
              <li use:tooltip={path}><span class="dir">{p.dir}</span><span class="name">{p.name}</span></li>
            {/each}
          </ul>
          {#if c.resolved.length > MERGED_SHOWN}
            <Button size="sm" variant="ghost" onclick={() => (allMerged = !allMerged)}>
              {allMerged ? 'Show fewer' : `Show ${c.resolved.length - MERGED_SHOWN} more`}
            </Button>
          {/if}
        </div>
      {/if}

      <div class="actions">
        {#if pending.length > 1}
          {#if marked}
            <ConfirmButton
              variant="default"
              confirmLabel="{marked === 1 ? 'One file still has' : `${marked} files still have`} conflict markers. Mark all resolved anyway?"
              onconfirm={() => resolveAll(true)}
              disabled={app.busy}><ChecksRegular /> Mark all resolved</ConfirmButton
            >
          {:else}
            <Button onclick={() => resolveAll()} disabled={app.busy} {@attach tip('Stage every file as it is now (git add)')}>
              <ChecksRegular /> Mark all resolved
            </Button>
          {/if}
        {/if}
        {#if abortable}
          <Button
            variant="primary"
            onclick={() => app.sync('continue')}
            disabled={blocked || app.busy}
            {@attach tip(
              c.files.length ? 'Mark every file resolved first'
              : c.unstaged.length ? 'Stage the files changed since they were staged first'
              : c.kind === 'stash' ? 'Keep the result as uncommitted changes (unstaged, like a stash restored without conflicts)'
              : 'Commits with the prepared message; hooks run as usual',
            )}
          >
            <CheckBold /> {CONTINUE[c.kind]} <Kbd hint="⌘↩" />
          </Button>
          <ConfirmButton
            confirmLabel="Click to abort. What you resolved is saved first"
            onconfirm={() => app.sync('abort')}
            disabled={app.busy}
            {@attach tip(
              c.stash
                ? `Put the files the stash changed back as they were${c.stash.pop ? ', and the stash back in the list' : ''}; your other changes stay, and your files are saved under refs/legit/aborted first`
                : `Go back to before the ${name.toLowerCase()}; your work in progress is saved under refs/legit/aborted first`,
            )}
          >
            <ArrowCounterClockwiseRegular /> Abort {name.toLowerCase()}
          </ConfirmButton>
        {/if}
      </div>
    </div>

    {#if error}
      <p class="muted empty">{error}</p>
    {:else if diff}
      {#key diff.sha}
        <DiffView summary={diff} {sel} readonly={true} onresolve={keep} />
      {/key}
    {:else}
      <p class="muted empty">Loading changes…</p>
    {/if}
  </div>
{/if}

<style>
  .view {
    display: flex;
    flex-direction: column;
    min-height: 100%;
  }

  .top {
    display: flex;
    align-items: baseline;
    gap: var(--sp-4);
    padding: var(--sp-5) var(--sp-5) 0;
    min-width: 0;
  }

  h2 {
    margin: 0;
    font-size: var(--fs-xl);
    color: var(--color2);
    flex-shrink: 0;
  }

  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta {
    display: flex;
    flex-direction: column;
    gap: var(--gap-4);
    padding: var(--sp-4) var(--sp-5) var(--sp-5);
    border-bottom: 1px solid var(--border);
  }

  p {
    margin: 0;
  }

  .hint,
  .merged {
    font-size: var(--fs-sm);
  }

  .merged {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--gap-2);
  }

  .merged ul {
    list-style: none;
    margin: 0;
    padding: 0 0 0 var(--gap-4);
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-width: 100%;
  }

  .merged li {
    display: flex;
    min-width: 0;
    white-space: pre;
  }

  /* The folder a step dimmer than the file's name, so names stand out; a long one is cut, never the name. */
  .merged .dir {
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  .merged .name {
    color: var(--color);
    flex-shrink: 0;
  }

  .files {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--gap-2);
  }

  li {
    display: flex;
    align-items: center;
    gap: var(--gap-4);
    padding: var(--gap-2) var(--gap-4);
    border-radius: var(--radius);
    background: var(--bg2);
    min-width: 0;
  }

  .path {
    cursor: default;
    color: var(--color2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .spacer {
    flex: 1;
  }

  .path:focus-visible {
    outline: 2px solid var(--theme2);
    outline-offset: 2px;
    border-radius: var(--radius);
  }

  .actions {
    display: flex;
    align-items: center;
    gap: var(--sp-4);
  }

  .empty {
    padding: var(--sp-5);
  }
</style>
