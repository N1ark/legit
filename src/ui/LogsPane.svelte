<script lang="ts">
  // Settings ▸ Logs: what went wrong lately, kept up to date while shown, to copy into a bug report.
  import { Button, copyText, toast } from 'purr';
  import { Copy } from 'purr/icons';
  import { loadLogs } from './lib/logs.ts';

  let text = $state<string | null>(null);
  let pre = $state<HTMLPreElement>();

  async function load() {
    try {
      const got = await loadLogs();
      if (got === text) return;
      // Follow new lines unless scrolled up to read older ones.
      const atEnd = !pre || pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
      text = got;
      if (atEnd) requestAnimationFrame(() => pre && (pre.scrollTop = pre.scrollHeight));
    } catch (e) {
      if (text === null) toast.error(e);
      text ??= '';
    }
  }

  $effect(() => {
    load();
    const poll = setInterval(load, 2000);
    return () => clearInterval(poll);
  });

  async function copy() {
    if (await copyText(text ?? '')) toast('Copied the logs');
    else toast.error("Couldn't copy the logs");
  }
</script>

<div class="logs">
  <div class="bar">
    <Button size="sm" variant="ghost" disabled={!text} onclick={copy}><Copy /> Copy</Button>
  </div>
  {#if text}
    <pre class="mono" bind:this={pre}>{text}</pre>
  {:else if text === ''}
    <p class="muted">Nothing logged.</p>
  {/if}
</div>

<style>
  .logs {
    display: flex;
    flex-direction: column;
    gap: var(--gap-2);
    height: 100%;
    min-height: 0;
  }

  .bar {
    display: flex;
    justify-content: flex-end;
  }

  pre {
    flex: 1;
    min-height: 0;
    margin: 0;
    overflow: auto;
    font-size: var(--fs-xs);
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
  }
</style>
