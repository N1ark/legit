// Web worker: reads a CSV or TSV text's rows (see `indexDelimited`), off the main thread.
// In: { id, text, delimiter, limit }. Out: { id, index }.

import { indexDelimited } from './csv.ts';

self.onmessage = (e: MessageEvent<{ id: number; text: string; delimiter: string; limit: number }>) => {
  const { id, text, delimiter, limit } = e.data;
  self.postMessage({ id, index: indexDelimited(text, delimiter, limit) });
};
