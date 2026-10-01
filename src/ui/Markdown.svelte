<script lang="ts">
  // A commit message rendered as markdown, built as elements from the lexer's tokens (never as
  // HTML, so a message's own tags show as text). `#123` links to the repository's GitHub issue.
  import { isMac } from 'purr';
  import { app } from './lib/app.svelte.ts';
  import { type RefToken, type Token, type Tokens, lexBlocks, lexInline, refUrl, safeHref } from './lib/markdown.ts';

  let {
    text,
    inline = false,
    links = 'click',
  }: {
    text: string;
    /** A title: inline markdown on one line. */
    inline?: boolean;
    /** How links open: on a click, on a ⌘-click (in a row a click selects), or not at all. */
    links?: 'click' | 'mod' | 'off';
  } = $props();

  const tokens = $derived(inline ? lexInline(text) : lexBlocks(text));
  const MOD = isMac ? '⌘' : 'Ctrl';

  function follow(e: MouseEvent, href: string) {
    e.preventDefault();
    if (links === 'mod' && !(isMac ? e.metaKey : e.ctrlKey)) return;
    e.stopPropagation();
    app.openUrl(href);
  }

  const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };
  const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => ENTITIES[e]);
  const plain = (s: string): Token => ({ type: 'text', raw: s, text: s, escaped: true });
  const tip = (href: string) => (links === 'mod' ? `${MOD}-click to open ${href}` : href);
</script>

{#snippet link(href: string | null, title: string | null | undefined, inner: Token[])}
  {#if href && links !== 'off'}
    <a {href} title={title || tip(href)} tabindex={links === 'mod' ? -1 : undefined} target="_blank" rel="noopener noreferrer" onclick={(e) => follow(e, href)}
      >{@render spans(inner)}</a
    >
  {:else}
    {@render spans(inner)}
  {/if}
{/snippet}

{#snippet spans(list: Token[])}
  {#each list as t, k (k)}
    {#if t.type === 'text'}
      {#if 'tokens' in t && t.tokens}{@render spans(t.tokens)}{:else}{decode(t.text)}{/if}
    {:else if t.type === 'escape'}
      {t.text}
    {:else if t.type === 'strong'}
      <strong>{@render spans((t as Tokens.Strong).tokens)}</strong>
    {:else if t.type === 'em'}
      <em>{@render spans((t as Tokens.Em).tokens)}</em>
    {:else if t.type === 'del'}
      <del>{@render spans((t as Tokens.Del).tokens)}</del>
    {:else if t.type === 'codespan'}
      <code>{t.text}</code>
    {:else if t.type === 'br'}
      <br />
    {:else if t.type === 'link'}
      {@const l = t as Tokens.Link}
      {@render link(safeHref(l.href), l.title, l.tokens)}
    {:else if t.type === 'image'}
      <!-- Not loaded: a message shouldn't fetch from wherever it points. -->
      {@const l = t as Tokens.Image}
      {@render link(safeHref(l.href), l.title, [plain(`🖼 ${l.text || l.href}`)])}
    {:else if t.type === 'ref'}
      {@const r = t as unknown as RefToken}
      {@const href = refUrl(r, app.repo?.github)}
      {#if href}
        {@render link(href, null, [plain(r.raw)])}
      {:else}{r.raw}{/if}
    {:else if t.type === 'checkbox'}
      <input type="checkbox" class="task" checked={(t as Tokens.Checkbox).checked} disabled />
    {:else}
      {t.raw}
    {/if}
  {/each}
{/snippet}

{#snippet blocks(list: Token[])}
  {#each list as t, k (k)}
    {#if t.type === 'paragraph'}
      <p>{@render spans((t as Tokens.Paragraph).tokens)}</p>
    {:else if t.type === 'heading'}
      {@const h = t as Tokens.Heading}
      <svelte:element this={`h${h.depth}`}>{@render spans(h.tokens)}</svelte:element>
    {:else if t.type === 'code'}
      <pre><code>{t.text}</code></pre>
    {:else if t.type === 'blockquote'}
      <blockquote>{@render blocks((t as Tokens.Blockquote).tokens)}</blockquote>
    {:else if t.type === 'list'}
      {@const l = t as Tokens.List}
      <svelte:element this={l.ordered ? 'ol' : 'ul'} start={l.ordered && l.start !== '' ? Number(l.start) : undefined}>
        {#each l.items as item, j (j)}
          <li class:task-item={item.task}>{@render blocks(item.tokens)}</li>
        {/each}
      </svelte:element>
    {:else if t.type === 'table'}
      {@const tb = t as Tokens.Table}
      <table>
        <thead><tr>{#each tb.header as c, j (j)}<th style:text-align={c.align}>{@render spans(c.tokens)}</th>{/each}</tr></thead>
        <tbody>
          {#each tb.rows as row, j (j)}
            <tr>{#each row as c, x (x)}<td style:text-align={c.align}>{@render spans(c.tokens)}</td>{/each}</tr>
          {/each}
        </tbody>
      </table>
    {:else if t.type === 'hr'}
      <hr />
    {:else if t.type === 'html'}
      <p>{t.raw.trim()}</p>
    {:else if t.type === 'text'}
      <!-- A tight list item's text. -->
      {@render spans([t])}
    {:else if t.type === 'checkbox'}
      {@render spans([t])}
    {:else if t.type !== 'space' && t.type !== 'def'}
      <p>{t.raw}</p>
    {/if}
  {/each}
{/snippet}

{#if inline}
  <span class="md-inline">{@render spans(tokens)}</span>
{:else}
  <div class="md">{@render blocks(tokens)}</div>
{/if}

<style>
  a {
    color: var(--theme2);
    text-decoration: none;
  }

  a:hover {
    text-decoration: underline;
  }

  code {
    font-family: var(--font-mono);
    font-size: 0.9em;
    padding: 0.05em 0.3em;
    border-radius: var(--radius-sm, 4px);
    background: var(--bg3);
  }

  pre code {
    padding: 0;
    background: none;
  }

  .task {
    margin: 0 0.4em 0 0;
    vertical-align: middle;
  }

  .task-item {
    list-style: none;
  }
</style>
