<script lang="ts">
  // A pull request's changes in its overview: Files changed and, once you've reviewed it, what changed
  // since; then every commit, each opening its diff. None of it needs the pull request checked out:
  // opening the overview fetches it into hidden refs (lib/gh-prdiff.svelte.ts), again when its head moves.
  import { Button, Spinner, formatFull, formatRelative, tooltip } from 'purr';
  import { CheckCircleFill, CircleFill, CircleRegular, ClockCounterClockwiseRegular, FilesRegular, WarningRegular, XCircleFill, type GlyphComponent } from 'purr/glyphs';
  import type { CheckState, PrOverview } from '../../shared/gh-prview.ts';
  import { app } from '../lib/app.svelte.ts';
  import { checks } from '../lib/gh-checks.svelte.ts';
  import { prDiffs } from '../lib/gh-prdiff.svelte.ts';
  import { gh } from '../lib/github.svelte.ts';

  interface Props {
    pr: PrOverview;
  }
  let { pr }: Props = $props();

  $effect(() => {
    prDiffs.ensure(pr);
    prDiffs.loadCommits(pr);
  });

  const fetched = $derived(prDiffs.fetched[pr.number]);
  const commits = $derived(prDiffs.allCommits(pr));
  /** The branch's own pull request: its commits that are in the list open there, where they can be edited. */
  const ours = $derived(gh.pr?.number === pr.number);
  const since = $derived(pr.myReview && pr.myReview.sha !== pr.headSha ? pr.myReview : null);

  const CHECK: Record<NonNullable<CheckState>, { icon: GlyphComponent; color: string; label: string }> = {
    success: { icon: CheckCircleFill, color: 'var(--success)', label: 'Checks passed' },
    failure: { icon: XCircleFill, color: 'var(--danger)', label: 'Checks failed' },
    error: { icon: XCircleFill, color: 'var(--danger)', label: 'Checks errored' },
    pending: { icon: CircleFill, color: 'var(--warn)', label: 'Checks running' },
    expected: { icon: CircleFill, color: 'var(--warn)', label: 'Checks expected' },
  };

  const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;

  function open(sha: string) {
    if (ours && app.bySha.has(sha)) app.select(sha);
    else prDiffs.show(pr, { kind: 'commit', sha });
  }
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

  <h3 class="muted">
    {plural(pr.commitCount, 'commit')}
    {#if pr.commitCount > commits.length}<span>({commits.length === pr.commits.length ? `the last ${commits.length}; loading the rest…` : `GitHub lists ${commits.length}`})</span>{/if}
  </h3>
  <ol>
    {#each commits as c (c.sha)}
      {@const k = c.checks ? CHECK[c.checks] : null}
      {@const here = app.bySha.has(c.sha)}
      <li>
        {#if k}
          <button
            class="check"
            style:color={k.color}
            use:tooltip={`${k.label}: show them`}
            aria-label={k.label}
            aria-expanded={checks.open?.sha === c.sha}
            onclick={(e) => checks.show(c.sha, e.currentTarget, c.sha === pr.headSha ? pr.number : undefined)}
          >
            <k.icon />
          </button>
        {:else}
          <span class="check" style:color="var(--faint)" use:tooltip={'No checks'} role="img" aria-label="No checks"><CircleRegular /></span>
        {/if}
        <button class="headline" use:tooltip={ours && here ? 'Show this commit' : "Show this commit's changes"} onclick={() => open(c.sha)}>{c.headline}</button>
        <span class="mono sha" class:here>{c.short}</span>
      </li>
    {/each}
  </ol>
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

    .headline:hover {
      color: var(--theme2);
      text-decoration: underline;
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

  h3 {
    margin: 0;
    font-size: var(--fs-sm);
    font-weight: 500;
  }

  ol {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }

  li {
    display: flex;
    align-items: center;
    gap: var(--gap-4);
    padding: var(--sp-2) var(--sp-4);
    min-height: var(--row-h);
  }

  li + li {
    border-top: 1px solid var(--border);
  }

  .check {
    display: inline-flex;
    font-size: var(--icon-md);
  }

  button.check {
    border-radius: var(--radius-pill);
    cursor: pointer;
  }

  .headline {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: left;
    color: var(--color2);
    cursor: pointer;
  }

  .sha {
    color: var(--faint);
    font-size: var(--fs-xs);
  }

  .sha.here {
    color: var(--theme2);
  }
</style>
