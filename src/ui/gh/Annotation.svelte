<script lang="ts">
  // A CI annotation under the lines it's on: its level, title and check, and its message.
  import { tooltip } from 'purr';
  import { ArrowSquareOutRegular } from 'purr/glyphs';
  import NoteIcon from './NoteIcon.svelte';
  import { noteLines } from '../lib/gh-files.ts';
  import type { Annotation } from '../../shared/gh-files.ts';

  let { note }: { note: Annotation } = $props();
  const LEVEL = { failure: 'Failure', warning: 'Warning', notice: 'Notice' };
</script>

<div class="note {note.level}" role="note" aria-label="{LEVEL[note.level]} from {note.check}">
  <div class="bar">
    <NoteIcon level={note.level} />
    <span class="level">{LEVEL[note.level]}</span>
    {#if note.title}<span class="title">{note.title}</span>{/if}
    <span class="where muted">{noteLines(note)} · {note.check}</span>
    {#if note.url}
      <a
        class="btn btn--ghost btn--icon btn--sm"
        href={note.url}
        target="_blank"
        rel="noreferrer"
        aria-label="Open the check on GitHub"
        use:tooltip={'Open the check on GitHub'}><ArrowSquareOutRegular /></a
      >
    {/if}
  </div>
  <pre class="message mono">{note.message}</pre>
  {#if note.details}
    <details><summary class="muted">Details</summary><pre class="message mono">{note.details}</pre></details>
  {/if}
</div>

<style>
  .note {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    box-shadow: var(--box-shadow);
    font-family: var(--font);
    font-size: var(--fs-sm);
    line-height: var(--line-height);
    white-space: normal;
    color: var(--color);
    overflow: hidden;
  }

  .bar {
    display: flex;
    align-items: center;
    gap: var(--gap-3);
    height: 30px;
    padding: 0 var(--gap-2) 0 var(--gap-4);
    white-space: nowrap;
    border-bottom: 1px solid var(--border);
  }

  .failure .bar {
    background: var(--del-bg);
  }

  .level {
    font-weight: 600;
    flex-shrink: 0;
  }

  .failure .level {
    color: var(--danger);
  }

  .warning .level {
    color: var(--warn);
  }

  .notice .level {
    color: var(--info);
  }

  .title {
    color: var(--color2);
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  .where {
    margin-left: auto;
    font-size: var(--fs-xs);
    flex-shrink: 0;
  }

  .message {
    margin: 0;
    padding: var(--sp-3) var(--sp-4);
    max-height: 240px;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: var(--fs-xs);
  }

  details {
    border-top: 1px solid var(--border);
    padding: var(--sp-2) var(--sp-4);
  }

  details .message {
    padding: var(--sp-2) 0 0;
  }

  summary {
    font-size: var(--fs-xs);
    cursor: pointer;
  }
</style>
