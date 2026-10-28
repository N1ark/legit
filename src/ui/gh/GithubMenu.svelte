<script lang="ts">
  // The header's GitHub button, when the repo is on GitHub: new issues and pull requests, its pages,
  // and whether GitHub can be reached (a warning dot when signed out, with why and "Try again").
  // Also hosts what GitHub features open anywhere: the new-issue dialog, `#` suggestions.
  import { IconButton, menu } from 'purr';
  import { ArrowClockwiseRegular, ArrowSquareOutRegular, GitPullRequestRegular, GithubLogoRegular, IssueOpenedRegular, UserCircleRegular, WarningRegular } from 'purr/glyphs';
  import { untrack } from 'svelte';
  import CreateIssue from './CreateIssue.svelte';
  import RefSuggestions from './RefSuggestions.svelte';
  import { app } from '../lib/app.svelte.ts';
  import { issueDialog, openNewIssue } from '../lib/gh-issues.svelte.ts';
  import { openCreatePr } from '../lib/gh-prs.svelte.ts';
  import { repoUrl } from '../lib/gh-links.ts';
  import { refs } from '../lib/gh-refs.svelte.ts';
  import { gh } from '../lib/github.svelte.ts';

  const repo = $derived(gh.status?.repo ?? null);
  const error = $derived(gh.status?.error ?? null);

  // References shown are looked up again along with the rest of GitHub, now and then.
  $effect(() => {
    void gh.tick;
    untrack(() => refs.stale());
  });

  function show(e: MouseEvent & { currentTarget: HTMLButtonElement }) {
    if (!repo) return;
    const why = error ? 'Not signed in to GitHub' : undefined;
    const link = (label: string, tab?: 'issues' | 'pulls' | 'actions') => ({
      label,
      icon: ArrowSquareOutRegular,
      run: () => app.openUrl(repoUrl(repo, tab)),
    });
    menu.showFor(
      e.currentTarget,
      [
        !!error && { label: 'Not signed in to GitHub', icon: WarningRegular, disabled: true, note: error },
        !!error && { label: 'Try again', icon: ArrowClockwiseRegular, run: () => gh.refresh({ retry: true }) },
        !!error && 'separator',
        { label: 'New issue…', icon: IssueOpenedRegular, disabled: !!why, note: why, run: () => openNewIssue() },
        gh.pr
          ? { label: `Pull request #${gh.pr.number}`, icon: GitPullRequestRegular, hint: 'p', run: () => gh.showPr(gh.pr!.number) }
          : { label: 'New pull request…', icon: GitPullRequestRegular, disabled: !!why, note: why, run: () => openCreatePr() },
        'separator',
        link('Open repository on GitHub'),
        link('Issues', 'issues'),
        link('Pull requests', 'pulls'),
        link('Actions', 'actions'),
        !!gh.status?.login && 'separator',
        !!gh.status?.login && { label: `Signed in as ${gh.status.login}`, icon: UserCircleRegular, disabled: true },
      ],
      repo,
      'bottom-end',
    );
  }
</script>

{#if repo}
  <span class="gh">
    <IconButton
      label={error ? 'GitHub (not signed in)' : 'GitHub'}
      tip={error ? { text: `GitHub: ${error}` } : { text: `GitHub: ${repo}` }}
      size="lg"
      aria-haspopup="menu"
      onclick={show}
    >
      <GithubLogoRegular />
    </IconButton>
    {#if error}<span class="dot" aria-hidden="true"></span>{/if}
  </span>
{/if}

{#if issueDialog.draft}
  <CreateIssue draft={issueDialog.draft} onclose={(left) => issueDialog.close(left)} />
{/if}
<RefSuggestions />

<style>
  .gh {
    position: relative;
    display: inline-flex;
  }

  /* Signed out: the reason is in the tooltip and the menu. */
  .dot {
    position: absolute;
    top: 3px;
    right: 3px;
    width: 7px;
    height: 7px;
    border-radius: var(--radius-pill);
    background: var(--warn);
    box-shadow: 0 0 0 2px var(--bg2);
    pointer-events: none;
  }
</style>
