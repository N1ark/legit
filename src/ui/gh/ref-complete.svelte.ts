// `{@attach refComplete}` on a message field: typing `#` and some of a title (or a number) lists
// matching issues and pull requests (RefSuggestions.svelte shows them, mounted once in the app);
// ↑/↓ walk them, ↵ or Tab insert `#123`, Esc closes the list.

import type { Attachment } from 'svelte/attachments';
import { gh } from '../lib/github.svelte.ts';
import { refAt } from '../lib/gh-links.ts';
import { searchRefs } from '../lib/gh-refs.svelte.ts';
import type { IssueRef } from '../../shared/gh-issues.ts';

type Field = HTMLInputElement | HTMLTextAreaElement;

export const LIST_ID = 'ref-suggestions';

class Completion {
  /** The field typing a reference; null when the list is closed. */
  field = $state.raw<Field | null>(null);
  /** Where the `#` is on screen, for the list to hang below. */
  at = $state.raw<{ x: number; y: number; width: number; height: number } | null>(null);
  query = $state('');
  items = $state.raw<IssueRef[]>([]);
  loading = $state(false);
  cursor = $state(0);
  span = { from: 0, to: 0 };
  private timer: ReturnType<typeof setTimeout> | null = null;

  open(el: Field, hit: { from: number; to: number; query: string }) {
    const fresh = this.field !== el || this.span.from !== hit.from;
    this.span = hit;
    if (fresh) {
      this.field = el;
      this.at = caretRect(el, hit.from);
      this.items = [];
      el.setAttribute('aria-expanded', 'true');
    }
    if (!fresh && hit.query === this.query) return;
    this.query = hit.query;
    this.loading = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const q = hit.query;
      searchRefs(q).then(
        (items) => {
          if (this.field !== el || this.query !== q) return;
          this.items = items;
          this.loading = false;
          this.move(-this.cursor);
        },
        () => this.field === el && (this.loading = false),
      );
    }, 120);
  }

  close() {
    if (this.timer) clearTimeout(this.timer);
    this.field?.setAttribute('aria-expanded', 'false');
    this.field?.removeAttribute('aria-activedescendant');
    this.field = null;
    this.items = [];
    this.query = '';
  }

  /** Replace the `#text` typed with `#123`, as typing would (so the field's undo takes it back). */
  insert(r: IssueRef) {
    const el = this.field;
    if (!el) return;
    const { from, to } = this.span;
    const text = `#${r.number}${/\s/.test(el.value[to] ?? '') ? '' : ' '}`;
    el.focus();
    el.setSelectionRange(from, to);
    if (!document.execCommand('insertText', false, text)) {
      el.setRangeText(text, from, to, 'end');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    this.close();
  }

  move(by: number) {
    const n = this.items.length;
    this.cursor = n ? (this.cursor + by + n) % n : 0;
    if (n) this.field?.setAttribute('aria-activedescendant', `${LIST_ID}-${this.cursor}`);
    else this.field?.removeAttribute('aria-activedescendant');
  }
}

export const completion = new Completion();

/** Where character `index` of a field is on screen: a copy of the field's text box, measured. */
function caretRect(el: Field, index: number) {
  const style = getComputedStyle(el);
  const copy = document.createElement('div');
  for (const p of [
    'boxSizing', 'width', 'fontFamily', 'fontSize', 'fontWeight', 'fontFeatureSettings', 'fontVariationSettings', 'letterSpacing', 'lineHeight', 'tabSize', 'wordSpacing',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  ] as const) copy.style[p] = style[p];
  Object.assign(copy.style, { position: 'fixed', top: '0', left: '0', visibility: 'hidden', overflow: 'hidden', borderStyle: 'solid' });
  copy.style.whiteSpace = el instanceof HTMLTextAreaElement ? 'pre-wrap' : 'pre';
  copy.style.overflowWrap = 'break-word';
  copy.textContent = el.value.slice(0, index);
  const mark = document.createElement('span');
  mark.textContent = '#';
  copy.append(mark);
  document.body.append(copy);
  const box = el.getBoundingClientRect();
  const x = box.left + mark.offsetLeft - el.scrollLeft;
  const y = box.top + mark.offsetTop - el.scrollTop;
  const height = mark.offsetHeight;
  copy.remove();
  return { x: Math.min(x, box.right), y: Math.max(box.top, Math.min(y, box.bottom - height)), width: 0, height };
}

/** Suggest issues and pull requests for the `#text` being typed in this field. */
export const refComplete: Attachment<Field> = (el) => {
  const check = () => {
    const caret = el.selectionStart ?? 0;
    const hit = gh.ready && caret === el.selectionEnd ? refAt(el.value, caret) : null;
    if (hit) completion.open(el, hit);
    else if (completion.field === el) completion.close();
  };
  const key = (e: KeyboardEvent) => {
    if (completion.field !== el || e.isComposing) return;
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
    const has = completion.items.length > 0;
    if (plain && has && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) completion.move(e.key === 'ArrowDown' ? 1 : -1);
    else if (plain && has && ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab')) completion.insert(completion.items[completion.cursor]);
    else if (e.key === 'Escape') completion.close();
    else return;
    // The field's own keys (Esc reverts, ↵ saves...) and the app's stay out of it.
    e.preventDefault();
    e.stopPropagation();
  };
  const caretMoved = (e: KeyboardEvent) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) check();
  };
  const leave = () => completion.field === el && completion.close();
  el.setAttribute('aria-autocomplete', 'list');
  el.setAttribute('aria-controls', LIST_ID);
  const node: HTMLElement = el;
  node.addEventListener('input', check);
  node.addEventListener('click', check);
  node.addEventListener('keydown', key);
  node.addEventListener('keyup', caretMoved);
  node.addEventListener('blur', leave);
  return () => {
    node.removeEventListener('input', check);
    node.removeEventListener('click', check);
    node.removeEventListener('keydown', key);
    node.removeEventListener('keyup', caretMoved);
    node.removeEventListener('blur', leave);
    leave();
  };
};
