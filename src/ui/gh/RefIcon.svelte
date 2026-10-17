<script lang="ts">
  // An issue's or pull request's state as GitHub draws it: its icon, in its colour, named in words.
  import { CheckCircle, GitMerge, GitPullRequest, GitPullRequestClosed, IssueOpened, Prohibit } from 'purr/icons';
  import { refStateWords } from '../lib/gh-links.ts';
  import type { IssueRef } from '../../shared/gh-issues.ts';

  interface Props {
    ref: Pick<IssueRef, 'state' | 'isPullRequest' | 'notPlanned'>;
    size?: number | string;
  }
  let { ref, size = '1em' }: Props = $props();

  const Icon = $derived(
    ref.isPullRequest
      ? { open: GitPullRequest, draft: GitPullRequest, merged: GitMerge, closed: GitPullRequestClosed }[ref.state]
      : ref.state === 'open'
        ? IssueOpened
        : ref.notPlanned
          ? Prohibit
          : CheckCircle,
  );
  // A completed issue is purple like a merged pull request; one not planned is grey like a draft.
  const tone = $derived(ref.isPullRequest || ref.state === 'open' ? ref.state : ref.notPlanned ? 'draft' : 'merged');
</script>

<span class="ref-icon {tone}" role="img" aria-label={refStateWords(ref)}><Icon {size} weight="bold" aria-hidden="true" /></span>

<style>
  .ref-icon {
    display: inline-flex;
    flex-shrink: 0;
  }

  .open {
    color: var(--success);
  }

  .merged {
    color: var(--theme2);
  }

  .closed {
    color: var(--danger);
  }

  .draft {
    color: var(--muted);
  }
</style>
