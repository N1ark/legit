// Main-thread side of syntax highlighting: one worker, fed one file at a time, always the
// file nearest the viewport first, and what's no longer wanted dropped, so fast scrolling never
// queues up stale work.

import type { HunkData } from '../../shared/types.ts';
import { highlightable, language } from './languages.ts';
import type { Tokens } from './rows.ts';

export type { Tokens };

interface Job {
  key: string;
  path: string;
  hunks: HunkData[];
  /** A tree-sitter grammar to use instead of Prism. */
  syntax?: string;
  /** Lower runs first; re-read whenever the worker frees up. */
  priority: () => number;
  /** False once nobody needs the result (e.g. the diff was closed). */
  wanted: () => boolean;
  /** Undefined when the job was dropped. */
  done: (t: Tokens | null | undefined) => void;
}

/** Results by key, least recently used first, kept to a few MB however big the files. */
const cache = new Map<string, Tokens | null>();
const MAX_CACHED = 1000;
const MAX_BYTES = 16 << 20;
let cachedBytes = 0;
const bytes = (t: Tokens | null | undefined) => (t ? t.offsets.byteLength + t.data.byteLength : 0);

function remember(key: string, t: Tokens | null) {
  cachedBytes += bytes(t) - bytes(cache.get(key));
  cache.delete(key);
  cache.set(key, t);
  for (const [k, old] of cache) {
    if (cache.size <= MAX_CACHED && cachedBytes <= MAX_BYTES) break;
    cache.delete(k);
    cachedBytes -= bytes(old);
  }
}
const queue: Job[] = [];
/** Jobs queued or running, by key. */
const jobs = new Map<string, Job>();
let worker: Worker | null = null;
let running: Job | null = null;
let nextId = 0;

function pump() {
  if (running) return;
  for (let k = queue.length - 1; k >= 0; k--) {
    if (queue[k].wanted()) continue;
    jobs.delete(queue[k].key);
    queue.splice(k, 1)[0].done(undefined);
  }
  if (!queue.length) return;
  let best = 0;
  for (let k = 1; k < queue.length; k++) if (queue[k].priority() < queue[best].priority()) best = k;
  running = queue.splice(best, 1)[0];
  worker ??= start();
  worker.postMessage({ id: ++nextId, path: running.path, hunks: running.hunks, syntax: running.syntax });
}

function start() {
  const w = new Worker(new URL('./highlight.worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (e: MessageEvent<{ tokens: Tokens | null }>) => {
    const job = running!;
    running = null;
    jobs.delete(job.key);
    remember(job.key, e.data.tokens);
    job.done(e.data.tokens);
    pump();
  };
  return w;
}

const prepared = new Set<string>();

/** Start the worker, with Prism and the grammars `paths` take, ahead of the first job wanting them. */
export function prepare(paths: string[] = []) {
  const langs = [...new Set(paths.map(language))].filter((l): l is string => !!l && !prepared.has(l));
  if (worker && !langs.length) return;
  for (const l of langs) prepared.add(l);
  worker ??= start();
  worker.postMessage({ prepare: langs });
}

// With the page, in its own thread: the first diff then doesn't wait for the worker and Prism to load.
if (typeof Worker !== 'undefined') prepare();

/** File `path`'s tokens (null when it isn't highlighted), or undefined when the job was dropped before it ran, unwanted. */
export function highlight(
  key: string,
  path: string,
  hunks: HunkData[],
  priority: () => number,
  wanted: () => boolean,
  syntax?: string,
): Promise<Tokens | null | undefined> {
  if (!syntax && !language(path)) return Promise.resolve(null);
  if (cache.has(key)) {
    const t = cache.get(key)!;
    remember(key, t);
    return Promise.resolve(t);
  }
  // The worker would refuse it, after copying it all over.
  if (!highlightable(hunks)) return Promise.resolve(null);
  const same = jobs.get(key);
  if (same) {
    // Asked for again (prefetched, then shown): it runs as soon as either wants it, for both.
    const { priority: p, wanted: w, done: d } = same;
    return new Promise((done) => {
      same.priority = () => Math.min(p(), priority());
      same.wanted = () => w() || wanted();
      same.done = (t) => {
        d(t);
        done(t);
      };
    });
  }
  return new Promise((done) => {
    const job = { key, path, hunks, syntax, priority, wanted, done };
    jobs.set(key, job);
    queue.push(job);
    pump();
  });
}

export interface Segment {
  t: string;
  c: string;
}

/** Split a row's text into highlighted runs. */
export function segments(tokens: Tokens, row: number, text: string): Segment[] {
  const out: Segment[] = [];
  let pos = 0;
  for (let k = tokens.offsets[row]; k < tokens.offsets[row + 1]; k += 2) {
    const len = tokens.data[k];
    out.push({ t: text.slice(pos, pos + len), c: tokens.classes[tokens.data[k + 1]] });
    pos += len;
  }
  if (pos < text.length) out.push({ t: text.slice(pos), c: '' });
  return out;
}
