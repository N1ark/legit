<script lang="ts">
  // A merge, rebase, cherry-pick or revert that stopped halfway (from legit or a terminal):
  // what's still conflicted, what's merged, and Continue or Abort. Files are resolved in an
  // editor; "Mark resolved" stages one, and asks again while it still has conflict markers.
  // A rebase also needs files changed since they were staged to be staged again. Abort saves
  // what was resolved before throwing it away.
  import { Button, ConfirmButton, Tag } from 'purr';
  import { ArrowCounterClockwise, Check, FileArrowUp } from 'purr/icons';
  import { SvelteSet } from 'svelte/reactivity';
  import type { DiffSummary } from '../shared/types.ts';
  import DiffView from './DiffView.svelte';
  import { app } from './lib/app.svelte.ts';

  const c = $derived(app.repo?.conflict ?? null);
  const NAME = { merge: 'Merge', rebase: 'Rebase', 'cherry-pick': 'Cherry-pick', revert: 'Revert', am: 'git am' };
  const CONTINUE = { merge: 'Commit merge', rebase: 'Continue rebase', 'cherry-pick': 'Continue cherry-pick', revert: 'Continue revert', am: 'Continue' };

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

  $effect(() => {
    void app.workTick;
    void app.repo?.head;
    void c?.files.length;
    if (c) load();
  });

  const sel = $derived(diff ? Object.fromEntries(diff.files.map((f) => [f.path, new SvelteSet<number>()])) : {});
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

  const resolve = (path: string, force = false) => app.sync('resolve', { path, force });

  /** A path split into its folder (with the trailing slash) and the file's name. */
  const split = (path: string) => {
    const k = path.lastIndexOf('/') + 1;
    return { dir: path.slice(0, k), name: path.slice(k) };
  };

  const MERGED_SHOWN = 8;
  let allMerged = $state(false);
  const blocked = $derived(!!c && (c.files.length > 0 || c.unstaged.length > 0));
</script>

{#if c}
  <div class="view">
    <div class="top">
      <h2>{NAME[c.kind]} in progress</h2>
      <span class="muted title" title={c.title}>{c.title}</span>
    </div>

    <div class="meta">
      <p class="muted hint">
        {#if c.files.length}
          Resolve each file in your editor, then mark it resolved. History can't be rewritten until this is finished or
          aborted.
        {:else if c.unstaged.length}
          Some files changed after they were staged. Stage them to keep the changes in the commit, or undo them in your
          editor: a rebase won't continue otherwise.
        {:else}
          Nothing is conflicted any more. {c.kind === 'merge' ? 'Commit the merge' : 'Continue'} to finish, or abort.
        {/if}
      </p>

      {#if c.files.length}
        <ul class="files">
          {#each c.files as f (f.path)}
            <li>
              <span class="path mono" title={f.path}>{f.path}</span>
              <Tag label={f.status} />
              {#if f.markers}<Tag color="var(--warn)" label="conflict markers" title="<<<<<<<, ======= or >>>>>>> at a line start" />{/if}
              <span class="spacer"></span>
              <Button size="sm" variant="ghost" onclick={() => app.openInZed(f.path, f.line ?? undefined)} disabled={!f.exists}>
                <FileArrowUp /> Open in Zed
              </Button>
              {#if f.markers}
                <ConfirmButton
                  size="sm"
                  variant="default"
                  confirmLabel="It still has conflict markers. Mark resolved anyway?"
                  onconfirm={() => resolve(f.path, true)}
                  disabled={app.busy}><Check /> Mark resolved</ConfirmButton
                >
              {:else}
                <Button
                  size="sm"
                  onclick={() => resolve(f.path)}
                  disabled={app.busy}
                  title={f.exists ? 'Stage the file as it is now (git add)' : 'Resolve by deleting the file (git add)'}
                >
                  <Check /> Mark resolved{f.exists ? '' : ' (deleted)'}
                </Button>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}

      {#if c.unstaged.length}
        <ul class="files">
          {#each c.unstaged as path (path)}
            <li>
              <span class="path mono" title={path}>{path}</span>
              <Tag color="var(--warn)" label="changed since staged" title="Changed in your files after it was staged (git add)" />
              <span class="spacer"></span>
              <Button size="sm" variant="ghost" onclick={() => app.openInZed(path)}><FileArrowUp /> Open in Zed</Button>
              <Button size="sm" onclick={() => resolve(path)} disabled={app.busy} title="Stage the file as it is now (git add)">
                <Check /> Stage
              </Button>
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
              <li title={path}><span class="dir">{p.dir}</span><span class="name">{p.name}</span></li>
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
        <Button
          variant="primary"
          onclick={() => app.sync('continue')}
          disabled={blocked || app.busy}
          title={c.files.length
            ? 'Mark every file resolved first'
            : c.unstaged.length
              ? 'Stage the files changed since they were staged first'
              : 'Commits with the prepared message; hooks run as usual'}
        >
          <Check weight="bold" /> {CONTINUE[c.kind]}
        </Button>
        <ConfirmButton
          confirmLabel="Click to abort. What you resolved is saved first"
          onconfirm={() => app.sync('abort')}
          disabled={app.busy}
          title="Go back to before the {NAME[c.kind].toLowerCase()}. Your work in progress is saved under refs/legit/aborted first."
        >
          <ArrowCounterClockwise /> Abort {NAME[c.kind].toLowerCase()}
        </ConfirmButton>
      </div>
    </div>

    {#if error}
      <p class="muted empty">{error}</p>
    {:else if diff}
      {#key diff.sha}
        <DiffView summary={diff} {sel} readonly={true} />
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
    color: var(--color2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .spacer {
    flex: 1;
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
