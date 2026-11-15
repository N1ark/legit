<script lang="ts">
  // In a pull request's overview: check it out here, or review it in a worktree of its own. Not shown
  // for the current branch's own pull request, which is checked out already.
  import { Spinner, menu, tooltip } from 'purr';
  import { CaretDownRegular, FolderSimplePlusRegular, GitBranchRegular } from 'purr/glyphs';
  import { checkoutPr, checkouts } from '../lib/gh-checkout.svelte.ts';
  import { gh } from '../lib/github.svelte.ts';

  interface Props {
    number: number;
  }
  let { number }: Props = $props();

  function show(e: MouseEvent & { currentTarget: HTMLButtonElement }) {
    menu.showFor(
      e.currentTarget,
      [
        { label: 'Check out', icon: GitBranchRegular, note: 'Fetch it and switch to its branch here', run: () => void checkoutPr(number) },
        { label: 'Review in a worktree', icon: FolderSimplePlusRegular, note: 'In a folder of its own: your checkout stays as it is', run: () => void checkoutPr(number, true) },
      ],
      `#${number}`,
      'bottom-end',
    );
  }
</script>

{#if gh.pr?.number !== number}
  <button class="btn" aria-haspopup="menu" disabled={checkouts.fetching !== null} use:tooltip={'Check it out here, or in a worktree'} onclick={show}>
    {#if checkouts.fetching === number}<Spinner label={`Fetching #${number}`} />{:else}<GitBranchRegular />{/if}
    Check out
    <CaretDownRegular />
  </button>
{/if}
