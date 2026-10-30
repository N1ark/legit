// A markdown file's blocks as elements, built straight from the lexer's tokens with createElement and
// text nodes, never from HTML, so the file's own HTML shows as text. Links are plain anchors: whoever
// shows them handles their clicks, once, on the document (Markdown.svelte).

import { tooltip } from 'purr';
import { ChatCenteredTextRegular, ImageRegular, InfoRegular, LightbulbRegular, WarningOctagonRegular, WarningRegular } from 'purr/glyphs';
import { type Component, mount } from 'svelte';
import { fencePath } from './languages.ts';
import { type Alert, type DocLink, type Token, type Tokens, docLink, safeHref } from './markdown.ts';

export interface DomOptions {
  /** The file's path: its relative links and images are its repository's files. */
  file: string;
  /** Show web images, rather than a placeholder. */
  images: boolean;
  /** How links open: on a click, on a ⌘-click, or not at all (then they're text). */
  links: 'click' | 'mod' | 'off';
  /** The text of a link's tooltip when it has no title. */
  tip: (href: string) => string;
  /** Each heading's anchor, as `headingSlugs` makes them over the whole file. */
  slugs: ReadonlyMap<Token, string>;
  /** Called with each block, list item and table row built (a table's header row is its `header` array)
   *  and its element: to mark what a diff changed, say. */
  each?: (t: object, el: HTMLElement) => void;
  /** Called with each code block whose language can be highlighted: its `<code>`, text and a path of that language. */
  fence?: (code: HTMLElement, text: string, path: string) => void;
  /** Builds inline tokens of types this module doesn't know (a diff's insertions, say) into `into`: false to show their text. */
  inline?: (t: Token, into: Node, spans: (list: Token[], into: Node) => void) => boolean;
}

const ALERTS = {
  note: ['Note', InfoRegular],
  tip: ['Tip', LightbulbRegular],
  important: ['Important', ChatCenteredTextRegular],
  warning: ['Warning', WarningRegular],
  caution: ['Caution', WarningOctagonRegular],
} as const;

/** Each icon drawn once, then cloned. */
const icons = new Map<unknown, Element>();
function icon(c: Component): Node {
  let svg = icons.get(c);
  if (!svg) {
    const host = document.createElement('span');
    mount(c, { target: host });
    icons.set(c, (svg = host.firstElementChild!));
  }
  return svg.cloneNode(true);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };
const decode = (s: string) => (s.includes('&') ? s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => ENTITIES[e]) : s);
const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, into?: Node | null, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  into?.appendChild(e);
  return e;
}

/** Text into an element or fragment: appended as a string, it makes no object for the script to hold. */
const text = (into: Node, s: string) => s && (into as Element).append(s);

/** Builds the blocks of one file with the same options. */
export class DomBuilder {
  constructor(private o: DomOptions) {}

  /** A top-level block's element (null for blank lines and link definitions), saying which line it starts at. */
  block(t: Token, line?: number): HTMLElement | null {
    const e = this.blockInto(t, null);
    if (e && line !== undefined) e.dataset.line = String(line);
    return e;
  }

  /** Inline tokens into `into`. */
  spans = (list: Token[], into: Node): void => {
    for (const t of list) this.span(t, into);
  };

  private blocks(list: Token[], into: Node) {
    for (const t of list) this.blockInto(t, into);
  }

  /** Block `t`, appended to `into`; its element, if it has one of its own. */
  private blockInto(t: Token, into: Node | null): HTMLElement | null {
    const o = this.o;
    let e: HTMLElement;
    switch (t.type) {
      case 'paragraph':
        this.spans(t.tokens!, (e = el('p')));
        break;
      case 'heading': {
        e = el(`h${(t as Tokens.Heading).depth}` as 'h1');
        const slug = o.slugs.get(t);
        if (slug !== undefined) e.dataset.anchor = slug;
        this.spans(t.tokens!, e);
        break;
      }
      case 'code': {
        e = el('pre');
        const code = el('code', e);
        code.textContent = t.text;
        const path = fencePath((t as Tokens.Code).lang);
        if (path) o.fence?.(code, t.text, path);
        break;
      }
      case 'blockquote':
        if ((t as Alert).alert) {
          const kind = (t as Alert).alert;
          const [label, glyph] = ALERTS[kind];
          e = el('div', null, `alert ${kind}`);
          const title = el('p', e, 'alert-title');
          title.append(icon(glyph), label);
        } else e = el('blockquote');
        this.blocks(t.tokens!, e);
        break;
      case 'list': {
        const l = t as Tokens.List;
        e = el(l.ordered ? 'ol' : 'ul');
        if (l.ordered && l.start !== '') e.setAttribute('start', String(Number(l.start)));
        for (const item of l.items) {
          const li = el('li', e, item.task ? 'task-item' : undefined);
          this.blocks(item.tokens, li);
          o.each?.(item, li);
        }
        break;
      }
      case 'table': {
        const tb = t as Tokens.Table;
        e = el('table');
        const head = el('tr', el('thead', e));
        for (const c of tb.header) this.cell('th', c, head);
        o.each?.(tb.header, head);
        const body = el('tbody', e);
        for (const row of tb.rows) {
          const tr = el('tr', body);
          for (const c of row) this.cell('td', c, tr);
          o.each?.(row, tr);
        }
        break;
      }
      case 'hr':
        e = el('hr');
        break;
      case 'html':
        // Shown as the text it is, never as HTML.
        e = el('pre', null, 'html');
        el('code', e).textContent = t.raw.trim();
        break;
      case 'text':
      case 'checkbox':
        // A tight list item's text, or its task's box.
        if (!into) {
          this.span(t, (e = el('p')));
          break;
        }
        this.span(t, into);
        return null;
      case 'space':
      case 'def':
        return null;
      default:
        // Anything else, as the text it is.
        e = el('p');
        e.textContent = t.raw;
    }
    o.each?.(t, e);
    into?.appendChild(e);
    return e;
  }

  private cell(tag: 'th' | 'td', c: Tokens.TableCell, row: HTMLElement) {
    const e = el(tag, row);
    if (c.align) e.style.textAlign = c.align;
    this.spans(c.tokens, e);
  }

  private span(t: Token, into: Node) {
    switch (t.type) {
      case 'text':
        if ('tokens' in t && t.tokens) this.spans(t.tokens, into);
        else text(into, decode(t.text));
        return;
      case 'escape':
        text(into, t.text);
        return;
      case 'strong':
      case 'em':
      case 'del':
        this.spans(t.tokens!, el(t.type, into));
        return;
      case 'codespan':
        el('code', into).textContent = t.text;
        return;
      case 'br':
        el('br', into);
        return;
      case 'link':
        this.link(docLink(t.href, this.o.file), t.title, t.tokens!, into);
        return;
      case 'image':
        this.image(t as Tokens.Image, into);
        return;
      case 'checkbox': {
        const box = el('input', into, 'task');
        box.type = 'checkbox';
        box.checked = (t as Tokens.Checkbox).checked;
        box.disabled = true;
        return;
      }
      default:
        if (!this.o.inline?.(t, into, this.spans)) text(into, t.raw);
    }
  }

  /** A link: to a web page, one of the file's headings, or one of the repository's files, which can't be opened from here. */
  private link(to: DocLink | null, title: string | null | undefined, inner: Token[], into: Node) {
    const o = this.o;
    let e: HTMLElement;
    if (to?.kind === 'url' && o.links !== 'off') {
      const a = el('a');
      a.href = to.href;
      if (o.links === 'mod') a.tabIndex = -1;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      tooltip(a, title || o.tip(to.href));
      e = a;
    } else if (to?.kind === 'anchor') {
      e = el('a');
      e.setAttribute('href', `#${to.slug}`);
    } else if (to?.kind === 'file') {
      e = el('span', null, 'file-link');
      e.setAttribute('role', 'link');
      e.setAttribute('aria-disabled', 'true');
      e.tabIndex = 0;
      tooltip(e, `${to.path || '/'}, in the repository`);
    } else return this.spans(inner, into);
    this.spans(inner, e);
    into.appendChild(e);
  }

  /** An image: a web one is shown, one of the repository's can't be loaded yet. */
  private image(l: Tokens.Image, into: Node) {
    const src = safeHref(l.href);
    if (this.o.images && src?.startsWith('https:')) {
      // How it loads is set before what: setting `src` starts the request.
      const img = el('img', null, 'img');
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.alt = l.text;
      if (l.title) img.title = l.title;
      img.src = src;
      into.appendChild(img);
      return;
    }
    const to = docLink(l.href, this.o.file);
    const where = to?.kind === 'file' ? `${to.path}, in the repository: not shown` : `${l.href}: not shown`;
    const e = el('span', into, 'img-missing');
    e.setAttribute('role', 'img');
    e.setAttribute('aria-label', l.text || where);
    tooltip(e, where);
    e.append(icon(ImageRegular), l.text || fileName(to?.kind === 'file' ? to.path : l.href));
  }
}
