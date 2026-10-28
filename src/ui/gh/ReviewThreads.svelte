<script lang="ts">
  // Every review thread of pull request `number`, by file, unresolved first: each opens in place to
  // read and answer, and "Show in diff" selects the commit it's on and scrolls to it. Also says
  // how many comments of the viewer's review are pending, with a way to finish it. In a popover
  // (`ondone`), it also leads to the pull request's overview.
  import { Button, IconButton } from 'purr';
  import { ArrowsClockwiseRegular, ArticleRegular, CrosshairRegular } from 'purr/glyphs';
  import Thread from './Thread.svelte';
  import { app } from '../lib/app.svelte.ts';
  import { gh } from '../lib/github.svelte.ts';
  import { reviews } from '../lib/gh-review.svelte.ts';
  import { threadOrder } from '../lib/gh-threads.ts';
  import type { ReviewThread } from '../../shared/gh-review.ts';

  interface Props {
    number: number;
    /** After "Show in diff", "Finish review" or "Overview", for a popover holding it to close. */
    ondone?: () => void;
  }
  let { number, ondone }: Props = $props();

  $effect(() => {
    void gh.tick;
    reviews.load(number);
  });

  const data = $derived(reviews.byNumber[number] ?? null);
  const files = $derived.by(() => {
    const by = new Map<string, ReviewThread[]>();
    for (const t of [...(data?.threads ?? [])].sort(threadOrder)) {
      const list = by.get(t.path);
      if (list) list.push(t);
      else by.set(t.path, [t]);
    }
    return [...by].map(([path, threads]) => ({ path, threads, open: threads.filter((t) => !t.resolved).length }));
  });
  const unresolved = $derived(data?.threads.filter((t) => !t.resolved).length ?? 0);

  let refreshing = $state(false);
  async function refresh() {
    refreshing = true;
    await reviews.load(number, true);
    refreshing = false;
  }

  /** The commits to show a thread on: the one it was made on, else the pull request's up to its head. */
  function where(t: ReviewThread): string[] | string {
    const made = t.comments[0]?.originalCommit;
    if (made && app.bySha.has(made)) return [made];
    if (!data || t.outdated) return "It was made on a commit that isn't in your history any more.";
    const local = data.commits.filter((c) => app.bySha.has(c));
    if (local.length !== data.commits.length || !local.length) return "The pull request's commits on GitHub aren't the ones in your history.";
    return local.toReversed();
  }

  function show(t: ReviewThread) {
    const w = where(t);
    if (typeof w === 'string') return;
    app.select(w[0]);
    if (w.length > 1) app.select(w[w.length - 1], 'range');
    reviews.opened[t.id] = true;
    reviews.focus = { id: t.id, path: t.path };
    ondone?.();
  }
</script>

<div class="panel">
  <div class="head">
    <b>Review threads</b>
    {#if data}
      <span class="muted">{unresolved} unresolved{data.threads.length > unresolved ? ` · ${data.threads.length - unresolved} resolved` : ''}</span>
    {/if}
    <span class="spacer"></span>
    {#if ondone}
      <Button size="sm" variant="ghost" onclick={() => (gh.showPr(number), ondone())}><ArticleRegular /> Overview</Button>
    {/if}
    <IconButton label="Refresh" size="sm" onclick={refresh} disabled={refreshing}><ArrowsClockwiseRegular /></IconButton>
  </div>
  {#if data?.pending}
    <div class="pending">
      <span>
        <b>{data.pending.comments}</b> pending {data.pending.comments === 1 ? 'comment' : 'comments'}: only you see them until you submit.
      </span>
      <Button size="sm" variant="primary" onclick={() => (gh.showPr(number), ondone?.())}>Finish review</Button>
    </div>
  {/if}
  {#if !data}
    <p class="muted">Loading…</p>
  {:else if !files.length}
    <p class="muted">None yet. Pick lines in a commit to comment on them.</p>
  {:else}
    {#each files as f (f.path)}
      <div class="file">
        <span class="path mono">{f.path}</span>
        <span class="muted">{f.open ? `${f.open} unresolved` : 'all resolved'}{f.threads.length > f.open ? ` · ${f.threads.length} threads` : ''}</span>
      </div>
      {#each f.threads as t (t.id)}
        {@const w = where(t)}
        <div class="row">
          <div class="thread"><Thread {number} thread={t} pending={!!data.pending} scope="panel:" hunk /></div>
          <IconButton
            label="Show in diff"
            tip={typeof w === 'string' ? w : w.length > 1 ? "Show it in the pull request's changes" : 'Show it in the commit it was made on'}
            size="sm"
            disabled={typeof w === 'string'}
            onclick={() => show(t)}><CrosshairRegular /></IconButton
          >
        </div>
      {/each}
    {/each}
  {/if}
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    gap: var(--gap-3);
  }

  .head,
  .file,
  .pending {
    display: flex;
    align-items: center;
    gap: var(--gap-4);
  }

  .file {
    margin-top: var(--gap-4);
    font-size: var(--fs-sm);
  }

  .file .muted {
    font-size: var(--fs-xs);
  }

  .path {
    color: var(--color2);
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .pending {
    padding: var(--gap-3) var(--gap-4);
    border-radius: var(--radius);
    background: var(--theme-soft);
    font-size: var(--fs-sm);
  }

  .pending span {
    flex: 1;
  }

  .row {
    display: flex;
    align-items: flex-start;
    gap: var(--gap-2);
  }

  .thread {
    flex: 1;
    min-width: 0;
  }

  .spacer {
    flex: 1;
  }

  p {
    margin: 0;
  }
</style>
