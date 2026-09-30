// Main-thread side of syntax highlighting: one worker, fed one file at a time, always the
// file nearest the viewport first, so fast scrolling never queues up stale work.

import type { HunkData } from '../../shared/types.ts';
import { language } from './languages.ts';

/** Per-row runs of [length, class id]; row r spans data[offsets[r]..offsets[r+1]). */
export interface Tokens {
  classes: string[];
  offsets: Uint32Array;
  data: Uint32Array;
}

interface Job {
  key: string;
  path: string;
  hunks: HunkData[];
  /** Lower runs first; re-read whenever the worker frees up. */
  priority: () => number;
  /** False once nobody needs the result (e.g. the diff was closed). */
  wanted: () => boolean;
  done: (t: Tokens | null) => void;
}

const cache = new Map<string, Tokens | null>();
const queue: Job[] = [];
let worker: Worker | null = null;
let running: Job | null = null;
let nextId = 0;

function pump() {
  if (running) return;
  for (let k = queue.length - 1; k >= 0; k--) if (!queue[k].wanted()) queue.splice(k, 1);
  if (!queue.length) return;
  let best = 0;
  for (let k = 1; k < queue.length; k++) if (queue[k].priority() < queue[best].priority()) best = k;
  running = queue.splice(best, 1)[0];
  worker ??= start();
  worker.postMessage({ id: ++nextId, path: running.path, hunks: running.hunks });
}

function start() {
  const w = new Worker(new URL('./highlight.worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (e: MessageEvent<{ tokens: Tokens | null }>) => {
    const job = running!;
    running = null;
    if (cache.size > 300) cache.delete(cache.keys().next().value!);
    cache.set(job.key, e.data.tokens);
    job.done(e.data.tokens);
    pump();
  };
  return w;
}

export function highlight(
  key: string,
  path: string,
  hunks: HunkData[],
  priority: () => number,
  wanted: () => boolean,
): Promise<Tokens | null> {
  if (!language(path)) return Promise.resolve(null);
  if (cache.has(key)) return Promise.resolve(cache.get(key)!);
  return new Promise((done) => {
    queue.push({ key, path, hunks, priority, wanted, done });
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
