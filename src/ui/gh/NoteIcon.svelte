<script lang="ts">
  // A CI annotation's level as GitHub draws it. Decorative: whoever shows it also says the level in words.
  import { InfoFill, WarningFill, XCircleFill } from 'purr/glyphs';
  import type { AnnotationLevel } from '../../shared/gh-files.ts';

  let { level }: { level: AnnotationLevel } = $props();
</script>

<span class="icon {level}" aria-hidden="true">
  {#if level === 'failure'}<XCircleFill />{:else if level === 'warning'}<WarningFill />{:else}<InfoFill />{/if}
</span>

<style>
  .icon {
    display: inline-flex;
    flex-shrink: 0;
  }

  .failure {
    color: var(--danger);
  }

  .warning {
    color: var(--warn);
  }

  .notice {
    color: var(--info);
  }
</style>
