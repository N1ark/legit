<script lang="ts">
  // A commit message rendered as markdown, built as elements from the lexer's tokens (never as
  // HTML, so a message's own tags show as text). `#123` links to the repository's GitHub issue.
  // A markdown file (`file`) renders as GitHub shows it, with the blocks a diff changed marked.
  import { isMac, tooltip } from 'purr';
  import { ChatCenteredTextRegular, ImageRegular, InfoRegular, LightbulbRegular, WarningOctagonRegular, WarningRegular } from 'purr/glyphs';
  import { app } from './lib/app.svelte.ts';
  import CodeBlock from './CodeBlock.svelte';
  import RefIcon from './gh/RefIcon.svelte';
  import { refCard } from './lib/gh-links.ts';
  import { refs } from './lib/gh-refs.svelte.ts';
  import type { IssueRef } from '../shared/gh-issues.ts';
  import {
    type Alert,
    type DocLink,
    type RefToken,
    type Token,
    type Tokens,
    blockLines,
    changedBlocks,
    docLink,
    headingSlugs,
    lexBlocks,
    lexDocument,
    lexInline,
    refUrl,
    safeHref,
  } from './lib/markdown.ts';

  let {
    text,
    inline = false,
    links = 'click',
    images = false,
    file,
    changed,
  }: {
    text: string;
    /** A title: inline markdown on one line. */
    inline?: boolean;
    /** How links open: on a click, on a ⌘-click (in a row a click selects), or not at all. */
    links?: 'click' | 'mod' | 'off';
    /** Show images (a GitHub comment's), rather than links to them. */
    images?: boolean;
    /** A markdown file's path, to render it as a document: relative links and images are its repository's files. */
    file?: string;
    /** A file's lines (1-based) a diff adds or changes, whose blocks are marked. */
    changed?: ReadonlySet<number>;
  } = $props();

  const doc = $derived(file !== undefined);
  const tokens = $derived(doc ? lexDocument(text) : inline ? lexInline(text) : lexBlocks(text));
  const marks = $derived(doc && changed?.size ? changedBlocks(tokens, changed) : null);
  const slugs = $derived(doc ? headingSlugs(tokens) : null);
  /** Each top-level block's first line in the file, as `data-line`: where the diff and the rendered file meet. */
  const starts = $derived(doc ? new Map<object, number>(blockLines(tokens).map(([s], k) => [tokens[k], s])) : null);
  const MOD = isMac ? '⌘' : 'Ctrl';
  let root = $state<HTMLElement>();

  const ALERTS = {
    note: ['Note', InfoRegular],
    tip: ['Tip', LightbulbRegular],
    important: ['Important', ChatCenteredTextRegular],
    warning: ['Warning', WarningRegular],
    caution: ['Caution', WarningOctagonRegular],
  } as const;

  /** A link to one of the file's headings: scrolled to, not navigated to. */
  function jump(e: MouseEvent, slug: string) {
    e.preventDefault();
    root?.querySelector(`[data-anchor="${CSS.escape(slug)}"]`)?.scrollIntoView({ block: 'center' });
  }

  const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

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

<!-- `ref`: what a `#123` link points at, once known, shown as its state's icon and a hover card. -->
{#snippet link(href: string | null, title: string | null | undefined, inner: Token[], ref?: IssueRef | null)}
  {#if href && links !== 'off'}
    <a
      {href}
      use:tooltip={ref ? { html: refCard(ref, links === 'mod' ? `${MOD}-click to open` : undefined) } : title || tip(href)}
      tabindex={links === 'mod' ? -1 : undefined}
      target="_blank"
      rel="noopener noreferrer"
      onclick={(e) => follow(e, href)}
      >{#if ref}<RefIcon {ref} />{/if}{@render spans(inner)}</a
    >
  {:else}
    {#if ref}<RefIcon {ref} />{/if}{@render spans(inner)}
  {/if}
{/snippet}

<!-- A file's link: to a web page, one of its headings, or one of the repository's files, which can't be opened from here. -->
{#snippet fileLink(to: DocLink | null, title: string | null | undefined, inner: Token[])}
  {#if to?.kind === 'url'}
    {@render link(to.href, title, inner)}
  {:else if to?.kind === 'anchor'}
    <a href="#{to.slug}" onclick={(e) => jump(e, to.slug)}>{@render spans(inner)}</a>
  {:else if to}
    <span class="file-link" role="link" aria-disabled="true" tabindex="0" use:tooltip={`${to.path || '/'}, in the repository`}
      >{@render spans(inner)}</span
    >
  {:else}
    {@render spans(inner)}
  {/if}
{/snippet}

<!-- A file's image: a web one is shown, one of the repository's can't be loaded yet. -->
{#snippet fileImage(l: Tokens.Image, at: string)}
  {@const src = safeHref(l.href)}
  {#if images && src?.startsWith('https:')}
    <img class="img" {src} alt={l.text} title={l.title ?? undefined} loading="lazy" referrerpolicy="no-referrer" />
  {:else}
    {@const to = docLink(l.href, at)}
    {@const where = to?.kind === 'file' ? `${to.path}, in the repository: not shown` : `${l.href}: not shown`}
    <span class="img-missing" role="img" aria-label={l.text || where} use:tooltip={where}
      ><ImageRegular />{l.text || fileName(to?.kind === 'file' ? to.path : l.href)}</span
    >
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
    {:else if t.type === 'link' && file !== undefined}
      {@const l = t as Tokens.Link}
      {@render fileLink(docLink(l.href, file), l.title, l.tokens)}
    {:else if t.type === 'link'}
      {@const l = t as Tokens.Link}
      {@render link(safeHref(l.href), l.title, l.tokens)}
    {:else if t.type === 'image' && file !== undefined}
      {@render fileImage(t as Tokens.Image, file)}
    {:else if t.type === 'image' && images && safeHref((t as Tokens.Image).href)?.startsWith('https:')}
      {@const l = t as Tokens.Image}
      <img class="img" src={safeHref(l.href)} alt={l.text} title={l.title ?? undefined} loading="lazy" referrerpolicy="no-referrer" />
    {:else if t.type === 'image'}
      <!-- Not loaded: a message shouldn't fetch from wherever it points. -->
      {@const l = t as Tokens.Image}
      {@render link(safeHref(l.href), l.title, [plain(`🖼 ${l.text || l.href}`)])}
    {:else if t.type === 'ref'}
      {@const r = t as unknown as RefToken}
      {@const href = refUrl(r, app.repo?.github)}
      {#if href}
        {@render link(href, null, [plain(r.raw)], refs.get(r.repo ?? app.repo?.github, r.number))}
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
      <p class:changed={marks?.has(t)} data-line={starts?.get(t)}>{@render spans((t as Tokens.Paragraph).tokens)}</p>
    {:else if t.type === 'heading'}
      {@const h = t as Tokens.Heading}
      <svelte:element this={`h${h.depth}`} class:changed={marks?.has(t)} data-anchor={slugs?.get(t)} data-line={starts?.get(t)}
        >{@render spans(h.tokens)}</svelte:element
      >
    {:else if t.type === 'code' && file !== undefined}
      <pre class:changed={marks?.has(t)} data-line={starts?.get(t)}><CodeBlock text={t.text} lang={(t as Tokens.Code).lang} /></pre>
    {:else if t.type === 'code'}
      <pre><code>{t.text}</code></pre>
    {:else if t.type === 'blockquote' && (t as Alert).alert}
      {@const [label, Icon] = ALERTS[(t as Alert).alert]}
      <div class="alert {(t as Alert).alert}" class:changed={marks?.has(t)} data-line={starts?.get(t)}>
        <p class="alert-title"><Icon />{label}</p>
        {@render blocks((t as Alert).tokens)}
      </div>
    {:else if t.type === 'blockquote'}
      <blockquote class:changed={marks?.has(t)} data-line={starts?.get(t)}>{@render blocks((t as Tokens.Blockquote).tokens)}</blockquote>
    {:else if t.type === 'list'}
      {@const l = t as Tokens.List}
      <svelte:element this={l.ordered ? 'ol' : 'ul'} start={l.ordered && l.start !== '' ? Number(l.start) : undefined} data-line={starts?.get(t)}>
        {#each l.items as item, j (j)}
          <li class:task-item={item.task} class:changed={marks?.has(item)}>{@render blocks(item.tokens)}</li>
        {/each}
      </svelte:element>
    {:else if t.type === 'table'}
      {@const tb = t as Tokens.Table}
      <table data-line={starts?.get(t)}>
        <thead
          ><tr class:changed={marks?.has(tb.header)}
            >{#each tb.header as c, j (j)}<th style:text-align={c.align}>{@render spans(c.tokens)}</th>{/each}</tr
          ></thead
        >
        <tbody>
          {#each tb.rows as row, j (j)}
            <tr class:changed={marks?.has(row)}
              >{#each row as c, x (x)}<td style:text-align={c.align}>{@render spans(c.tokens)}</td>{/each}</tr
            >
          {/each}
        </tbody>
      </table>
    {:else if t.type === 'hr'}
      <hr class:changed={marks?.has(t)} data-line={starts?.get(t)} />
    {:else if t.type === 'html' && file !== undefined}
      <!-- Shown as the text it is, never as HTML. -->
      <pre class="html" class:changed={marks?.has(t)} data-line={starts?.get(t)}><code>{t.raw.trim()}</code></pre>
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
  <div class="md" class:doc bind:this={root}>{@render blocks(tokens)}</div>
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
    font-family: var(--mono);
    font-size: 0.9em;
    padding: 0.05em 0.3em;
    border-radius: var(--radius-sm, 4px);
    background: var(--bg3);
  }

  pre code {
    padding: 0;
    background: none;
  }

  .md-inline :global(.ref-icon),
  .md :global(.ref-icon) {
    margin-right: 0.2em;
    vertical-align: -0.125em;
  }

  .task {
    margin: 0 0.4em 0 0;
    vertical-align: middle;
  }

  /* By depth within the message: a browser counts every enclosing list, so a comment shown inside
     a list (the timeline) would otherwise start at circles. */
  .md ul {
    list-style-type: disc;
  }

  .md :is(ul, ol) ul {
    list-style-type: circle;
  }

  .md :is(ul, ol) :is(ul, ol) ul {
    list-style-type: square;
  }

  .task-item {
    list-style: none;
  }

  .img {
    max-width: 100%;
    border-radius: var(--radius-sm);
  }

  /* ---- A file, as GitHub's file view shows it -------------------------------------------- */

  .doc {
    --md-block: 0.9em;
    --md-h1: 1.9em;
    --md-h2: 1.45em;
    --md-h3: 1.2em;
    --md-heading-weight: 600;
  }

  .doc :is(h1, h2) {
    padding-bottom: 0.3em;
    border-bottom: 1px solid var(--border);
  }

  .doc code {
    font-family: var(--mono);
    background: var(--code-inline-bg);
  }

  .doc pre code {
    background: none;
  }

  .doc pre.html {
    color: var(--muted);
    white-space: pre-wrap;
  }

  /* A changed block is washed as a diff's added line, across the whole pane (whoever shows it clips
     the overflow): a border image paints outside the box without taking room or following its corners. */
  .doc .changed {
    border-image-source: linear-gradient(var(--add-bg), var(--add-bg));
    border-image-slice: 0 fill;
    border-image-outset: var(--gap-2) 100vw;
  }

  .doc li.changed {
    border-image-outset: 0 100vw;
  }

  .doc th {
    background: var(--bg3);
  }

  .doc tr.changed > td {
    background: var(--add-bg);
  }

  .doc tr.changed > th {
    background: linear-gradient(var(--add-bg), var(--add-bg)), var(--bg3);
  }

  .file-link {
    color: var(--theme2);
    text-decoration: underline dotted;
    text-underline-offset: 0.2em;
  }

  .img-missing {
    display: inline-flex;
    align-items: center;
    gap: var(--gap-2);
    padding: 0 var(--sp-2);
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius);
    color: var(--muted);
    font-size: var(--fs-sm);
    vertical-align: bottom;
  }

  .alert {
    --alert: var(--info);
    margin: var(--md-block) 0;
    padding: 0 0 0 0.75em;
    border-left: 2px solid var(--border-strong);
  }

  .alert.tip {
    --alert: var(--success);
  }

  .alert.important {
    --alert: var(--theme2);
  }

  .alert.warning {
    --alert: var(--warn);
  }

  .alert.caution {
    --alert: var(--danger);
  }

  .alert > :nth-child(2) {
    margin-top: 0;
  }

  .alert > :last-child {
    margin-bottom: 0;
  }

  .alert-title {
    display: flex;
    align-items: center;
    gap: var(--gap-3);
    margin: 0 0 var(--gap-2);
    font-weight: 600;
    color: var(--alert);
  }
</style>
