// The repository's pull requests (the inbox, ⇧P): loaded along with the rest of GitHub on each
// refresh and when opened, and one by number looked up as it's typed.

import { persisted, toast } from 'purr';
import { gh, ghRequest, sameData } from './github.svelte.ts';
import type { InboxList, InboxPage, InboxPr, PrInbox } from '../../shared/gh-inbox.ts';
import { addPage } from './gh-inbox.ts';

const LIST_IDS: InboxList[] = ['review', 'mine', 'assigned', 'open'];

class Inbox {
  /** Null until loaded. */
  data = $state.raw<PrInbox | null>(null);
  error = $state<string | null>(null);
  /** The inbox is shown. */
  open = $state(false);
  /** Pull requests looked up by number: null when there's none. */
  found = $state.raw<Record<number, InboxPr | null>>({});
  /** The list it shows. */
  readonly list = persisted<InboxList>('legit:pr-inbox', 'review', (v): v is InboxList => LIST_IDS.includes(v as InboxList));
  /** Open ones asking for your review. */
  reviews = $derived(this.data?.items.filter((p) => p.requested !== null).length ?? 0);

  private lastAt = 0;
  private loading: Promise<void> | null = null;
  private gen = 0;
  private looking = new Set<number>();

  load(fresh = false): Promise<void> {
    if (this.loading && !fresh) return this.loading;
    this.lastAt = Date.now();
    const run = this.fetch(fresh).finally(() => {
      if (this.loading === run) this.loading = null;
    });
    this.loading = run;
    return run;
  }

  private async fetch(fresh: boolean) {
    const gen = ++this.gen;
    try {
      const r = await ghRequest<PrInbox>('prInbox', { fresh: fresh ? 1 : null });
      if (gen !== this.gen) return;
      // Polled with every refresh: the same lists again keep the ones shown, which then don't redraw.
      if (!sameData(this.data, r)) this.data = r;
      this.error = null;
    } catch (e) {
      if (gen === this.gen) this.error = e instanceof Error ? e.message : String(e);
    }
  }

  private filling: InboxList | null = null;

  /** Load the rest of `list` while it's shown, 50 at a time (GitHub's search goes to 1000), so all of it can be filtered. */
  async fill(list: InboxList) {
    if (this.filling === list) return;
    this.filling = list;
    try {
      for (let page = 0; page < 20 && this.open && this.list.value === list; page++) {
        const gen = this.gen;
        const after = this.data?.cursors[list];
        if (!after) break;
        const got = await ghRequest<InboxPage>('prInboxMore', { list, after });
        if (gen !== this.gen || !this.data || this.data.cursors[list] !== after) break;
        this.data = addPage(this.data, list, got);
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      if (this.filling === list) this.filling = null;
    }
  }

  /** Look up pull request `n`, unless it's known. */
  lookup(n: number) {
    if (n in this.found || this.looking.has(n) || this.data?.items.some((p) => p.number === n)) return;
    this.looking.add(n);
    ghRequest<InboxPr | null>('prLookup', { number: n })
      .then((p) => (this.found = { ...this.found, [n]: p }), () => {})
      .finally(() => this.looking.delete(n));
  }

  show() {
    if (!gh.ready) return void toast(gh.status?.error ?? 'This repository is not on GitHub.');
    this.open = true;
    // What was looked up by number may have moved on since.
    this.found = {};
    if (Date.now() - this.lastAt > 10_000) this.load();
  }

  toggle() {
    if (this.open) this.open = false;
    else this.show();
  }
}

export const inbox = new Inbox();
