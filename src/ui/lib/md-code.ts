// A markdown file's code blocks, highlighted as they come near the view: plain text until then, which
// takes the same room. The blocks in view at once go to the worker together, one job a language.

import { Lru } from './cache.ts';
import { highlight, segments } from './highlighter.ts';
import { highlightable } from './languages.ts';

export interface Fence {
  code: HTMLElement;
  text: string;
  /** A path of the block's language (`x.ts`). */
  path: string;
  done?: boolean;
}

/** Highlighted blocks lately seen, by language and text, to copy from: the same block in another version of the file shows at once. */
const known = new Lru<string, DocumentFragment>(500, 4 << 20);
/** Blocks sent to the worker together are at most this much text. */
const BATCH = 200_000;

/** The highlighted lines of a block's text, from the rows of tokens `t` it starts at. */
function lines(t: Parameters<typeof segments>[0], row: number, text: string): DocumentFragment {
  const out = document.createDocumentFragment();
  const list = text.split('\n');
  list.forEach((line, k) => {
    for (const s of segments(t, row + k, line)) {
      if (!s.c) out.append(s.t);
      else {
        const span = document.createElement('span');
        span.className = s.c;
        span.textContent = s.t;
        out.append(span);
      }
    }
    if (k < list.length - 1) out.append('\n');
  });
  return out;
}

/** Highlights code blocks once they come within a screen or so of what `scroller` (the viewport if null) shows. */
export class Fences {
  private io: IntersectionObserver;
  private fences = new Map<Element, Fence>();
  private due: Fence[] = [];
  private alive = true;

  constructor(scroller: Element | null) {
    this.io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const f = e.isIntersecting && this.fences.get(e.target);
          if (f) this.want(f);
        }
        if (this.due.length) this.flush();
      },
      { root: scroller, rootMargin: '100% 0px' },
    );
  }

  /** Highlight `f` when it's near the view: at once when its text was highlighted lately. */
  add(f: Fence) {
    if (f.done) return;
    const copy = known.get(`${f.path}\0${f.text}`);
    if (copy) return this.fill(f, copy.cloneNode(true) as DocumentFragment);
    this.fences.set(f.code, f);
    this.io.observe(f.code);
  }

  destroy() {
    this.alive = false;
    this.io.disconnect();
    this.fences.clear();
  }

  private fill(f: Fence, frag: DocumentFragment) {
    f.code.textContent = '';
    f.code.append(frag);
    f.done = true;
  }

  private want(f: Fence) {
    this.io.unobserve(f.code);
    this.fences.delete(f.code);
    // The worker refuses a block too long, and would refuse the others with it.
    if (highlightable([{ text: f.text.split('\n') }])) this.due.push(f);
  }

  private flush() {
    const byLang = new Map<string, Fence[]>();
    for (const f of this.due.splice(0)) {
      const list = byLang.get(f.path);
      if (list) list.push(f);
      else byLang.set(f.path, [f]);
    }
    for (const [path, all] of byLang) {
      for (let k = 0; k < all.length; ) {
        const batch: Fence[] = [];
        let size = 0;
        while (k < all.length && (!batch.length || size + all[k].text.length <= BATCH)) {
          size += all[k].text.length;
          batch.push(all[k++]);
        }
        this.run(path, batch);
      }
    }
  }

  private run(path: string, batch: Fence[]) {
    const hunks = batch.map(({ text }) => {
      const lines = text.split('\n');
      return { header: '', oldStart: 1, newStart: 1, types: ' '.repeat(lines.length), text: lines, eof: [] };
    });
    const key = `fences:${path}:${batch.map((f) => f.text).join('\0')}`;
    highlight(key, path, hunks, () => 0, () => this.alive).then((t) => {
      // Filled even once this view is gone: its blocks may be kept, to be shown again.
      if (!t) return;
      // Each block's rows follow the ones before it, after a header row of its own.
      let row = 0;
      for (const f of batch) {
        const frag = lines(t, row + 1, f.text);
        row += f.text.split('\n').length + 1;
        known.set(`${f.path}\0${f.text}`, frag.cloneNode(true) as DocumentFragment, f.text.length);
        if (!f.done) this.fill(f, frag);
      }
    });
  }
}
