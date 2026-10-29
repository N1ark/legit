<script lang="ts">
  // A file shown as it reads rather than as lines: markdown as a document, CSV and TSV as a table.
  // Its height is its content's: the diff measures it, and the view scrolls past it as past a diff.
  import type { RenderKind } from '../shared/files.ts';

  interface Props {
    kind: RenderKind;
    path: string;
    text: string;
    /** Line numbers (1-based, in `text`) the diff adds or changes, to mark what changed. */
    changed?: ReadonlySet<number>;
  }
  let { kind, path, text, changed }: Props = $props();
</script>

<!-- Placeholder: the renderers replace this. -->
<pre class="rendered" data-kind={kind} data-path={path} data-changed={changed?.size ?? 0}>{text}</pre>

<style>
  .rendered {
    margin: 0;
    padding: var(--sp-4);
    white-space: pre-wrap;
  }
</style>
