<script lang="ts">
  // A markdown file's code block (the `<code>` in its `<pre>`), highlighted by its language once
  // the worker has it: plain text until then, which takes the same room.
  import { onDestroy } from 'svelte';
  import { type Tokens, highlight, segments } from './lib/highlighter.ts';
  import { fencePath } from './lib/languages.ts';

  interface Props {
    text: string;
    /** The block's info string (```ts). */
    lang?: string;
  }
  let { text, lang }: Props = $props();

  let tokens = $state.raw<{ for: string; t: Tokens } | null>(null);
  let alive = true;
  onDestroy(() => (alive = false));

  const lines = $derived(text.split('\n'));

  $effect(() => {
    const path = fencePath(lang);
    if (!path) return;
    const src = text;
    const hunk = { header: '', oldStart: 1, newStart: 1, types: ' '.repeat(lines.length), text: lines, eof: [] };
    highlight(`fence:${path}:${src}`, path, [hunk], () => 0, () => alive).then((t) => {
      if (t && alive) tokens = { for: src, t };
    });
  });
</script>

<code
  >{#if tokens?.for === text}{#each lines as line, k (k)}{#each segments(tokens.t, k + 1, line) as s, j (j)}<span class={s.c}
          >{s.t}</span
        >{/each}{k < lines.length - 1 ? '\n' : ''}{/each}{:else}{text}{/if}</code
>
