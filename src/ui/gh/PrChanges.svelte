<script lang="ts">
  // A pull request's changes in its overview: Files changed and, once you've reviewed it, what changed
  // since (its commits are in the conversation, each opening its diff). None of it needs the pull request
  // checked out: opening the overview fetches it into hidden refs (lib/gh-prdiff.svelte.ts), again when its head moves.
  import { Button, Spinner, formatFull, formatRelative, tooltip } from 'purr';
  import { ClockCounterClockwiseRegular, FilesRegular, WarningRegular } from 'purr/glyphs';
  import type { PrOverview } from '../../shared/gh-prview.ts';
  import { prDiffs } from '../lib/gh-prdiff.svelte.ts';

  interface Props {
    pr: PrOverview;
  }
  let { pr }: Props = $props();

  $effect(() => void prDiffs.ensure(pr));

  const fetched = $derived(prDiffs.fetched[pr.number]);
  const since = $derived(pr.myReview && pr.myReview.sha !== pr.headSha ? pr.myReview : null);

  const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;
</script>

<section class="changes" aria-label="Changes">
  <div class="entries">
    <button class="entry" onclick={() => prDiffs.show(pr, { kind: 'files' })} use:tooltip={`What merging it changes in ${pr.base}`}>
      <span class="glyph"><FilesRegular /></span>
      <span class="label">Files changed</span>
      <span class="muted">{plural(pr.changedFiles, 'file')}</span>
      <span class="add">+{pr.additions}</span>
      <span class="del">−{pr.deletions}</span>
    </button>
    {#if since}
      <button
        class="entry"
        onclick={() => prDiffs.show(pr, { kind: 'since' })}
        use:tooltip={`From ${since.sha.slice(0, 7)}, the commit you last reviewed, to the head`}
      >
        <span class="glyph"><ClockCounterClockwiseRegular /></span>
        <span class="label">Changes since your review</span>
        {#if since.at}<span class="muted" use:tooltip={formatFull(since.at)}>{formatRelative(since.at)}</span>{/if}
      </button>
    {/if}
  </div>
  {#if fetched?.error}
    <p class="note">
      <span class="warn"><WarningRegular /></span>
      <span class="why">{fetched.error}</span>
      <Button size="sm" onclick={() => prDiffs.ensure(pr, true)}>Try again</Button>
    </p>
  {:else if fetched && !fetched.got}
    <p class="note muted"><Spinner label="Fetching" /> Fetching #{pr.number}…</p>
  {:else if fetched?.got?.offline}
    <p class="note muted" use:tooltip={fetched.got.offline}>
      <span class="warn"><WarningRegular /></span>
      <span class="why">Couldn't fetch it just now ({fetched.got.offline}), so this may not be the latest.</span>
    </p>
  {/if}
</section>

<style>
  .changes {
    display: flex;
    flex-direction: column;
    gap: var(--gap-3);
  }

  .entries {
    display: flex;
    flex-wrap: wrap;
    gap: var(--gap-3);
    margin-bottom: var(--gap-3);
  }

  .entry {
    display: inline-flex;
    align-items: center;
    gap: var(--gap-3);
    padding: var(--sp-2) var(--sp-4);
    min-height: var(--btn);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface);
    color: var(--color2);
    font-size: var(--fs-sm);
    cursor: pointer;
  }

  @media (hover: hover) {
    .entry:hover {
      border-color: var(--theme2);
      color: var(--theme2);
    }
  }

  .entry .label {
    font-weight: 600;
  }

  .glyph,
  .warn {
    display: inline-flex;
    font-size: var(--icon-md);
  }

  .glyph {
    color: var(--theme2);
  }

  .warn {
    color: var(--warn);
  }

  .add {
    color: var(--add);
  }

  .del {
    color: var(--del);
  }

  .note {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--gap-3);
    margin: 0 0 var(--gap-3);
    font-size: var(--fs-sm);
  }

  .why {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
</style>
