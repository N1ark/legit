import { combinedMessage } from './squash.ts';
import type { CommitInfo, DiffSummary, FileContents, HunkData, OpResult, RepoState } from '../../shared/types.ts';

async function request<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(
    path,
    body === undefined
      ? {}
      : { method: 'POST', headers: { 'content-type': 'application/json', 'x-legit': '1' }, body: JSON.stringify(body) },
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

export interface Toast {
  id: number;
  text: string;
  kind: 'error' | 'info';
}

let toastId = 0;

class App {
  repo = $state<RepoState | null>(null);
  /** Selected commit SHAs, in click order. */
  selected = $state<string[]>([]);
  anchor: string | null = null;
  busy = $state(false);
  toasts = $state<Toast[]>([]);

  private diffs = new Map<string, Promise<DiffSummary>>();
  private contents = new Map<string, Promise<HunkData[]>>();
  private gen = 0;

  commits = $derived(this.repo?.commits ?? []);
  editable = $derived(this.commits.filter((c) => c.editable));
  bySha = $derived(new Map(this.commits.map((c) => [c.sha, c])));
  /** Selected commits, newest first. */
  selection = $derived(this.commits.filter((c) => this.selected.includes(c.sha)));
  people = $derived.by(() => {
    const seen = new Map<string, { name: string; email: string }>();
    for (const c of this.commits) {
      for (const p of [c.author, ...c.coauthors]) {
        const key = p.email.toLowerCase();
        if (!seen.has(key)) seen.set(key, { name: p.name, email: p.email });
      }
    }
    return [...seen.values()];
  });

  async refresh() {
    const gen = ++this.gen;
    try {
      const repo = await request<RepoState>('/api/state');
      if (gen === this.gen) this.setRepo(repo);
    } catch (e) {
      this.toast(String((e as Error).message), 'error');
    }
  }

  private setRepo(repo: RepoState, focus?: string[]) {
    this.repo = repo;
    const shas = new Set(repo.commits.map((c) => c.sha));
    let sel = (focus ?? this.selected).filter((s) => shas.has(s));
    if (!sel.length && repo.commits.length) sel = [repo.commits[0].sha];
    this.selected = sel;
    if (this.anchor && !shas.has(this.anchor)) this.anchor = sel[0] ?? null;
  }

  /** A commit's file list (no content). Cached: commits are immutable. */
  diff(sha: string): Promise<DiffSummary> {
    let d = this.diffs.get(sha);
    if (!d) {
      d = request<DiffSummary>(`/api/diff/${sha}`);
      d.catch(() => this.diffs.delete(sha));
      if (this.diffs.size > 200) this.diffs.delete(this.diffs.keys().next().value!);
      this.diffs.set(sha, d);
    }
    return d;
  }

  /** Contents of some of a commit's files; misses are fetched in one request. */
  async fileContents(sha: string, files: number[]): Promise<Record<number, HunkData[]>> {
    const key = (i: number) => `${sha}:${i}`;
    const missing = files.filter((i) => !this.contents.has(key(i)));
    if (missing.length) {
      const batch = request<FileContents>(`/api/diff/${sha}/files?i=${missing.join(',')}`);
      for (const i of missing) {
        const p = batch.then((r) => r[i] ?? []);
        p.catch(() => this.contents.delete(key(i)));
        this.contents.set(key(i), p);
      }
      while (this.contents.size > 4000) this.contents.delete(this.contents.keys().next().value!);
    }
    const out: Record<number, HunkData[]> = {};
    for (const i of files) out[i] = await this.contents.get(key(i))!;
    return out;
  }

  /** Warm the caches for a commit: its file list and the files on its first screen. */
  prefetch(sha: string) {
    this.diff(sha)
      .then((d) => {
        const first: number[] = [];
        let y = 0;
        for (let i = 0; i < d.files.length && y < 2000; i++) {
          if (d.files[i].rows) first.push(i);
          y += 40 + d.files[i].rows * 19;
        }
        if (first.length) return this.fileContents(sha, first);
      })
      .catch(() => {});
  }

  /** Run a history-rewriting operation. Returns true on success. */
  async op(name: string, body: unknown = {}, optimistic?: () => void): Promise<boolean> {
    if (this.busy) return false;
    const gen = ++this.gen;
    const before = this.repo;
    this.busy = true;
    optimistic?.();
    try {
      const r = await request<OpResult>(`/api/${name}`, body);
      this.gen = Math.max(this.gen, gen);
      this.setRepo(r.state, r.focus.length ? r.focus : this.selected.map((s) => r.renamed[s] ?? s));
      return true;
    } catch (e) {
      if (optimistic) this.repo = before;
      this.toast((e as Error).message, 'error');
      this.refresh();
      return false;
    } finally {
      this.busy = false;
    }
  }

  toast(text: string, kind: Toast['kind'] = 'info') {
    const id = ++toastId;
    this.toasts.push({ id, text, kind });
    setTimeout(() => (this.toasts = this.toasts.filter((t) => t.id !== id)), kind === 'error' ? 8000 : 3000);
  }

  /** Click on a commit: plain, toggle (cmd/ctrl) or range (shift). */
  select(sha: string, mode: 'set' | 'toggle' | 'range' = 'set') {
    const c = this.bySha.get(sha);
    if (!c) return;
    if (mode === 'toggle' && c.editable) {
      this.selected = this.selected.includes(sha)
        ? this.selected.filter((s) => s !== sha)
        : [...this.selected.filter((s) => this.bySha.get(s)?.editable), sha];
      if (!this.selected.length) this.selected = [sha];
    } else if (mode === 'range' && this.anchor && c.editable) {
      const a = this.commits.findIndex((x) => x.sha === this.anchor);
      const b = this.commits.findIndex((x) => x.sha === sha);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      this.selected = this.commits.slice(lo, hi + 1).filter((x) => x.editable).map((x) => x.sha);
      return;
    } else {
      this.selected = [sha];
      const i = this.commits.findIndex((x) => x.sha === sha);
      for (const n of [this.commits[i - 1], this.commits[i + 1]]) if (n) this.prefetch(n.sha);
    }
    this.anchor = sha;
  }

  /** Move selection up (-1) or down (+1). */
  step(dir: number, extend = false) {
    const cur = this.anchor ?? this.selected[0];
    const i = this.commits.findIndex((c) => c.sha === cur);
    const next = this.commits[Math.max(0, Math.min(this.commits.length - 1, i + dir))];
    if (!next) return;
    if (extend) {
      if (!next.editable) return;
      const keep = this.selected.includes(next.sha);
      this.selected = keep ? this.selected.filter((s) => s !== cur) : [...this.selected, next.sha];
      this.anchor = next.sha;
    } else this.select(next.sha);
    document.querySelector(`[data-sha="${next.sha}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  /** Move the selected commits by `dir` positions (negative = newer). */
  move(dir: number) {
    const list = this.editable.map((c) => c.sha);
    const picked = list.filter((s) => this.selected.includes(s));
    if (!picked.length) return;
    const rest = list.filter((s) => !picked.includes(s));
    const first = list.indexOf(picked[0]);
    const at = Math.max(0, Math.min(rest.length, first + dir));
    this.reorder([...rest.slice(0, at), ...picked, ...rest.slice(at)]);
  }

  /** Apply a new order of the editable commits (newest first), optimistically. */
  reorder(order: string[]) {
    const cur = this.editable.map((c) => c.sha);
    if (order.every((s, i) => s === cur[i])) return;
    this.op('reorder', { order }, () => {
      if (!this.repo) return;
      const by = this.bySha;
      const rest = this.repo.commits.filter((c) => !c.editable);
      this.repo = { ...this.repo, commits: [...order.map((s) => by.get(s)!), ...rest] };
    });
  }

  /** Open a file of the working tree (path relative to the repo root) in Zed. */
  async openInZed(path: string, line?: number) {
    try {
      await request('/api/open', { path, line });
    } catch (e) {
      this.toast((e as Error).message, 'error');
    }
  }

  copy(text: string, what = text) {
    navigator.clipboard.writeText(text).then(
      () => this.toast(`Copied ${what}`),
      () => this.toast("Couldn't access the clipboard", 'error'),
    );
  }

  /** Message the squash panel is showing, if the user edited it (keyed by the selected SHAs). */
  squashDraft = $state<{ key: string; message: string } | null>(null);

  /** Squash commits (any order) into the oldest, with the edited draft or the combined message. */
  squash(commits: CommitInfo[]) {
    const newestFirst = this.commits.filter((c) => commits.some((x) => x.sha === c.sha));
    const key = newestFirst.map((c) => c.sha).join(' ');
    const message = this.squashDraft?.key === key ? this.squashDraft.message : combinedMessage(newestFirst);
    return this.op('squash', { shas: newestFirst.map((c) => c.sha), message });
  }

  undo = () => this.op('undo');
  redo = () => this.op('redo');
}

export const app = new App();

export function shortSha(c: CommitInfo | string) {
  return (typeof c === 'string' ? c : c.sha).slice(0, 7);
}

const units: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60],
];
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'narrow' });

export function ago(time: number) {
  const s = time - Date.now() / 1000;
  for (const [u, n] of units) if (Math.abs(s) >= n) return rtf.format(Math.round(s / n), u);
  return 'just now';
}
