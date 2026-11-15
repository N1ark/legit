<script lang="ts">
  // One of a pull request's diffs in place of a commit, whether or not it's checked out: Files
  // changed (from where its head branched off the base, as GitHub's tab), what changed since your
  // review or in a push, or one of its commits. Read-only, with the pull request's review threads.
  import { Button, IconButton, Spinner, Tag, hasOverlay, isTyping, tooltip } from 'purr';
  import { ArrowLeftRegular, ArrowSquareOutRegular } from 'purr/glyphs';
  import { untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import type { PrCompare, PrDiffShow } from '../../shared/gh-prdiff.ts';
  import type { PrOverview } from '../../shared/gh-prview.ts';
  import type { CommitInfo, DiffSummary } from '../../shared/types.ts';
  import CommitView from '../CommitView.svelte';
  import DiffView from '../DiffView.svelte';
  import { app } from '../lib/app.svelte.ts';
  import { prDiffs, showTitle } from '../lib/gh-prdiff.svelte.ts';
  import { DiffReview } from '../lib/gh-review.svelte.ts';
  import { ghPost, ghRequest, keepPrview, keptPrview, loadPrview } from '../lib/github.svelte.ts';
  import { tip } from '../lib/tip.ts';
  import ReviewButton from './ReviewButton.svelte';

  interface Props {
    number: number;
    show: PrDiffShow;
  }
  let { number, show }: Props = $props();
  const what = untrack(() => show);
  const title = showTitle(what);

  type Shown =
    | { kind: 'diff'; diff: DiffSummary; sel: Record<string, SvelteSet<number>>; review: DiffReview; from: string; to: string; rebased: boolean }
    | { kind: 'commit'; commit: CommitInfo };
  let pr = $state.raw<PrOverview | null>(untrack(() => keptPrview(number)?.pr ?? null));
  let shown = $state.raw<Shown | null>(null);
  let error = $state<string | null>(null);
  let step = $state(`Fetching #${untrack(() => number)}…`);

  async function overview(): Promise<PrOverview> {
    if (pr) return pr;
    const got = await loadPrview(number);
    keepPrview(got);
    return (pr = got);
  }

  /** The diff's key and the commits it's of (newest first, for the review threads), as the server works them out. */
  async function range(p: PrOverview): Promise<{ key: string; shas: string[]; from: string; to: string; rebased: boolean }> {
    const got = await prDiffs.ensure(p);
    step = 'Comparing…';
    if (what.kind === 'files') {
      if (!got.mergeBase) throw new Error(`${p.head} shares no history with ${p.base}.`);
      const shas = prDiffs.allCommits(p).map((c) => c.sha).reverse();
      return { key: `r${got.head}-${got.mergeBase}`, shas, from: got.mergeBase, to: got.head, rebased: false };
    }
    const from = what.kind === 'since' ? p.myReview?.sha : what.kind === 'compare' ? what.from : null;
    if (!from) throw new Error("You haven't reviewed it yet.");
    const to = what.kind === 'compare' ? what.to : got.head;
    const c = await ghPost<PrCompare>('prCompare', { number: p.number, from, to });
    // Rebased, it's of no commits in particular, but ends at the head when it does.
    return { key: c.key, shas: c.rebased ? [c.to, c.from] : c.commits, from: c.from, to: c.to, rebased: c.rebased };
  }

  async function load() {
    error = null;
    shown = null;
    try {
      const p = await overview();
      if (what.kind === 'commit') {
        await prDiffs.ensure(p);
        shown = { kind: 'commit', commit: await ghRequest<CommitInfo>('prCommit', { number, sha: what.sha }) };
        return;
      }
      const r = await range(p);
      step = 'Loading the diff…';
      const diff = await app.diff(r.key);
      const sel = Object.fromEntries(diff.files.map((f) => [f.path, new SvelteSet<number>()]));
      shown = { kind: 'diff', diff, sel, review: new DiffReview(r.key, r.shas), from: r.from, to: r.to, rebased: r.rebased };
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  load();

  const back = () => prDiffs.back(number);

  const url = $derived.by(() => {
    if (!pr) return null;
    if (what.kind === 'commit') return `${pr.url}/commits/${what.sha}`;
    if (what.kind === 'files' || shown?.kind !== 'diff') return `${pr.url}/files`;
    return `${pr.url}/files/${shown.from}..${shown.to}`;
  });

  let barHeight = $state(0);

  function onkeydown(e: KeyboardEvent) {
    if (e.key !== 'Escape' || e.defaultPrevented || isTyping(document.activeElement) || hasOverlay()) return;
    e.preventDefault();
    back();
  }

  const short = (s: string) => s.slice(0, 7);
  const REBASED = "This version isn't built on the earlier one (it was rebased or force-pushed): the two are compared only in the files the pull request changes, so what the new base changed in those files shows too.";
</script>

<svelte:window {onkeydown} />

<div class="view">
  <div class="top" class:sticky={shown?.kind !== 'commit'} bind:offsetHeight={barHeight}>
    <Button variant="ghost" onclick={back} {@attach tip('Back to the overview (Esc)')}>
      <ArrowLeftRegular /> #{number}
    </Button>
    <h2>{title}</h2>
    {#if shown?.kind === 'diff'}
      {#if shown.rebased}
        <span use:tooltip={REBASED}><Tag color="var(--warn)" label="rebased" /></span>
      {/if}
      <span class="mono muted range" use:tooltip={what.kind === 'files' ? `From where ${pr?.head} branched off ${pr?.base}, to its head` : 'From → to'}>
        {short(shown.from)} → {short(shown.to)}
      </span>
    {/if}
    <span class="spacer"></span>
    {#if shown?.kind === 'diff'}<ReviewButton />{/if}
    {#if url}
      <IconButton label="Open on GitHub" onclick={() => url && app.openUrl(url)}><ArrowSquareOutRegular /></IconButton>
    {/if}
  </div>

  {#if error}
    <div class="empty">
      <p class="muted">{error}</p>
      <Button onclick={load}>Try again</Button>
    </div>
  {:else if !shown}
    <p class="muted empty"><Spinner label="Loading" /> {step}</p>
  {:else if shown.kind === 'commit'}
    <CommitView commit={shown.commit} />
  {:else if !shown.diff.files.length}
    <p class="muted empty">No changes{shown.rebased ? ' in the files the pull request changes' : ''}.</p>
  {:else}
    {#if shown.rebased}<p class="note muted">{REBASED}</p>{/if}
    <DiffView summary={shown.diff} sel={shown.sel} readonly={true} review={shown.review} inset={barHeight} />
  {/if}
</div>

<style>
  .view {
    display: flex;
    flex-direction: column;
    min-height: 100%;
  }

  .top {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--gap-4);
    padding: var(--sp-4) var(--sp-5) var(--sp-3);
    background: var(--bg);
    border-bottom: 1px solid var(--border);
  }

  .top.sticky {
    position: sticky;
    top: 0;
    z-index: calc(var(--z-sticky) + 1);
  }

  h2 {
    margin: 0;
    font-size: var(--fs-lg);
    font-weight: 600;
    color: var(--color2);
  }

  .range {
    font-size: var(--fs-sm);
  }

  .spacer {
    flex: 1;
  }

  .note {
    margin: 0;
    padding: var(--sp-3) var(--sp-5);
    font-size: var(--fs-sm);
  }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sp-4);
    padding: 40px;
    text-align: center;
  }
</style>
