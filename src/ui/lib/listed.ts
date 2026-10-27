// Lists the pickers show (branches, worktrees…), kept so that opening one again shows them at
// once while they're asked for again. One is only shown again in the state it was fetched in:
// after anything changes it (a switch, a commit, a fetch, any operation), the picker waits for
// the new one as it did the first time.
import { app } from './app.svelte.ts';

export class Listed<T> {
  private readonly path: string;
  private last: { repo: unknown; text: string; value: T; n: number } | null = null;
  private asking: { repo: unknown; list: Promise<T> } | null = null;
  private sent = 0;

  constructor(path: string) {
    this.path = path;
  }

  /** The list as last fetched, if that was in the state shown now. */
  get cached(): T | null {
    return this.last && this.last.repo === app.repo ? this.last.value : null;
  }

  /** Ask for it ahead of need (a picker is about to open), unless it's here or on its way for the state shown. */
  warm() {
    if (!this.cached && this.asking?.repo !== app.repo) this.load().catch(() => {});
  }

  /** The list as it is now. The same object as before when nothing in it changed, so what shows it stays as it is. */
  load(): Promise<T> {
    const repo = app.repo;
    if (this.asking?.repo === repo) return this.asking.list;
    const n = ++this.sent;
    const list = (async () => {
      const res = await fetch(this.path);
      const text = await res.text();
      if (!res.ok) throw new Error((JSON.parse(text) as { error?: string }).error ?? res.statusText);
      // An answer overtaken by a later one is passed on, not kept.
      if (this.last && this.last.n > n) return text === this.last.text ? this.last.value : (JSON.parse(text) as T);
      if (text !== this.last?.text) this.last = { repo, text, value: JSON.parse(text), n };
      else Object.assign(this.last, { repo, n });
      return this.last.value;
    })();
    const asking = (this.asking = { repo, list });
    list.finally(() => this.asking === asking && (this.asking = null)).catch(() => {});
    return list;
  }
}
