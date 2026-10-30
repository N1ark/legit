<script lang="ts">
  // A commit message rendered as markdown, built as elements from the lexer's tokens (never as
  // HTML, so a message's own tags show as text). `#123` links to the repository's GitHub issue.
  // A markdown file (`file`) renders as GitHub shows it, with the blocks a diff changed marked:
  // built by a view of its own (lib/md-view.ts), a slice at a time, however big it is.
  import { isMac, tooltip } from 'purr';
  import { untrack } from 'svelte';
  import { app } from './lib/app.svelte.ts';
  import RefIcon from './gh/RefIcon.svelte';
  import { refCard } from './lib/gh-links.ts';
  import { refs } from './lib/gh-refs.svelte.ts';
  import { DocView } from './lib/md-view.ts';
  import type { IssueRef } from '../shared/gh-issues.ts';
  import { type RefToken, type Token, type Tokens, lexBlocks, lexInline, refUrl, safeHref } from './lib/markdown.ts';

  let {
    text,
    inline = false,
    links = 'click',
    images = false,
    file,
    changed,
    onprogress,
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
    /** Told as a file is shown: the first line of the last top-level block shown, and whether that's all of them. */
    onprogress?: (line: number, done: boolean) => void;
  } = $props();

  const tokens = $derived(file !== undefined ? [] : inline ? lexInline(text) : lexBlocks(text));
  const MOD = isMac ? '⌘' : 'Ctrl';
  let root = $state<HTMLElement>();

  // Each top-level block of a file says which line it starts at (`data-line`): where the diff and the rendered file meet.
  let view: DocView | undefined;
  $effect(() => {
    if (!root || file === undefined) return;
    const v = new DocView(root, {
      text,
      file,
      images,
      links,
      tip,
      changed: untrack(() => changed),
      key: `${file}\0${images}\0${links}\0${text}`,
      onprogress: (line, done) => onprogress?.(line, done),
    });
    view = v;
    return () => v.destroy();
  });
  $effect(() => {
    const c = changed;
    untrack(() => view?.mark(c));
  });

  /** A file's link followed, or one to its headings scrolled to rather than navigated to. */
  function click(e: MouseEvent) {
    const a = (e.target as Element).closest('a');
    if (!a || !root?.contains(a)) return;
    const href = a.getAttribute('href') ?? '';
    if (!href.startsWith('#')) return follow(e, href);
    e.preventDefault();
    view?.reveal(href.slice(1))?.scrollIntoView({ block: 'center' });
  }

  function follow(e: MouseEvent, href: string) {
    e.preventDefault();
    if (links === 'mod' && !(isMac ? e.metaKey : e.ctrlKey)) return;
    e.stopPropagation();
    app.openUrl(href);
  }

  const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };
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
      <p>{@render spans((t as Tokens.Paragraph).tokens)}</p>
    {:else if t.type === 'heading'}
      <svelte:element this={`h${(t as Tokens.Heading).depth}`}>{@render spans((t as Tokens.Heading).tokens)}</svelte:element>
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
{:else if file !== undefined}
  <!-- Filled by its view (`md-file` styles what that builds); a link's click is handled here, for all of them. -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="md doc md-file" bind:this={root} onclick={click}></div>
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

  /* What a file's view builds has no scoping class: these are the rules above, and the file's own,
     under `.md-file`, each as specific as it would be scoped, so they win and lose where those would. */
  /* A file's blocks are in parts (lib/md-view.ts): its first has no margin above, its last none below, as
     `.md > :first-child` and `:last-child` (purr) would make them, and as specific. */
  :global(:where(.md-file) > .md-part:where(:first-child) > :first-child) {
    margin-top: 0;
  }

  :global(.md-file .md-last) {
    margin-bottom: 0;
  }

  /* Positioned, a part is a paint layer while the file is shown a part at a time (lib/md-view.ts). It doesn't
     move, and margins still collapse through it. */
  :global(.md-file > .md-layer) {
    position: relative;
  }

  :global(.md-file a) {
    color: var(--theme2);
    text-decoration: none;
  }

  :global(.md-file a:hover) {
    text-decoration: underline;
  }

  :global(.md-file code) {
    font-family: var(--mono);
    font-size: 0.9em;
    padding: 0.05em 0.3em;
    border-radius: var(--radius-sm, 4px);
    background: var(--bg3);
  }

  :global(.md-file pre code) {
    padding: 0;
    background: none;
  }

  :global(.md-file .task) {
    margin: 0 0.4em 0 0;
    vertical-align: middle;
  }

  :global(.md.md-file ul) {
    list-style-type: disc;
  }

  :global(.md.md-file :is(ul, ol) ul) {
    list-style-type: circle;
  }

  :global(.md.md-file :is(ul, ol) :is(ul, ol) ul) {
    list-style-type: square;
  }

  :global(.md-file .task-item) {
    list-style: none;
  }

  :global(.md-file .img) {
    max-width: 100%;
    border-radius: var(--radius-sm);
  }

  .doc {
    --md-block: 0.9em;
    --md-h1: 1.9em;
    --md-h2: 1.45em;
    --md-h3: 1.2em;
    --md-heading-weight: 600;
  }

  :global(.doc.md-file :is(h1, h2)) {
    padding-bottom: 0.3em;
    border-bottom: 1px solid var(--border);
  }

  :global(.doc.md-file code) {
    font-family: var(--mono);
    background: var(--code-inline-bg);
  }

  :global(.doc.md-file pre code) {
    background: none;
  }

  :global(.doc.md-file pre.html) {
    color: var(--muted);
    white-space: pre-wrap;
  }

  /* A changed block is washed as a diff's added line, across the whole pane (whoever shows it clips
     the overflow): a border image paints outside the box without taking room or following its corners. */
  :global(.doc.md-file .changed) {
    border-image-source: linear-gradient(var(--add-bg), var(--add-bg));
    border-image-slice: 0 fill;
    border-image-outset: var(--gap-2) 100vw;
  }

  :global(.doc.md-file li.changed) {
    border-image-outset: 0 100vw;
  }

  :global(.doc.md-file th) {
    background: var(--bg3);
  }

  :global(.doc.md-file tr.changed > td) {
    background: var(--add-bg);
  }

  :global(.doc.md-file tr.changed > th) {
    background: linear-gradient(var(--add-bg), var(--add-bg)), var(--bg3);
  }

  :global(.md-file .file-link) {
    color: var(--theme2);
    text-decoration: underline dotted;
    text-underline-offset: 0.2em;
  }

  :global(.md-file .img-missing) {
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

  :global(.md-file .alert) {
    --alert: var(--info);
    margin: var(--md-block) 0;
    padding: 0 0 0 0.75em;
    border-left: 2px solid var(--border-strong);
  }

  :global(.md-file .alert.tip) {
    --alert: var(--success);
  }

  :global(.md-file .alert.important) {
    --alert: var(--theme2);
  }

  :global(.md-file .alert.warning) {
    --alert: var(--warn);
  }

  :global(.md-file .alert.caution) {
    --alert: var(--danger);
  }

  :global(.md-file .alert > :nth-child(2)) {
    margin-top: 0;
  }

  :global(.md-file .alert > :last-child) {
    margin-bottom: 0;
  }

  :global(.md-file .alert-title) {
    display: flex;
    align-items: center;
    gap: var(--gap-3);
    margin: 0 0 var(--gap-2);
    font-weight: 600;
    color: var(--alert);
  }
</style>
