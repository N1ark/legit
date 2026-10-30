// CSV and TSV texts read into tables (see `indexDelimited`): a big one in a worker, so reading
// a 5 MB file never holds the page up; a small one at once, quicker than the worker's round trip.

import { type CsvIndex, indexDelimited } from './csv.ts';

/** Rows a table reads the fields of: its header and up to 500 more. */
export const TABLE_ROWS = 501;
const SYNC_CHARS = 100_000;

let worker: Worker | null = null;
let nextId = 0;
const waiting = new Map<number, { text: string; delimiter: string; done: (t: CsvIndex) => void }>();

function start(): Worker {
  const w = new Worker(new URL('./csv.worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (e: MessageEvent<{ id: number; index: CsvIndex }>) => {
    const job = waiting.get(e.data.id);
    waiting.delete(e.data.id);
    job?.done(e.data.index);
  };
  // A worker that fails: what's waiting is read here instead (the next table starts another).
  w.onerror = () => {
    w.terminate();
    worker = null;
    for (const job of waiting.values()) job.done(indexDelimited(job.text, job.delimiter, TABLE_ROWS));
    waiting.clear();
  };
  return w;
}

/** The table `text` (delimited by `delimiter`) reads as. */
export function readTable(text: string, delimiter: string): Promise<CsvIndex> {
  const here = text.length < SYNC_CHARS || typeof Worker === 'undefined';
  if (here) return Promise.resolve(indexDelimited(text, delimiter, TABLE_ROWS));
  return new Promise((done) => {
    const id = ++nextId;
    waiting.set(id, { text, delimiter, done });
    (worker ??= start()).postMessage({ id, text, delimiter, limit: TABLE_ROWS });
  });
}
