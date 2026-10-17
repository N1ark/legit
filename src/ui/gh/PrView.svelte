<script lang="ts">
  // A pull request, in place of a commit: its description and conversation.
  import { gh } from '../lib/github.svelte.ts';

  interface Props {
    number: number;
  }
  let { number }: Props = $props();
</script>

<div class="pr">
  <h2>#{number}</h2>
  <button class="btn btn--link" onclick={() => gh.close()}>Close</button>
</div>

<style>
  .pr {
    padding: var(--sp-5);
  }
</style>
