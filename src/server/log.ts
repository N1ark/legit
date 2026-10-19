// What went wrong lately, for Settings ▸ Logs (to copy into a bug report): failed requests, GitHub
// trouble, and anything else written to stderr. Kept in memory, the last few hundred lines; stderr
// still gets them (the app keeps that in a file).

import { format } from 'node:util';

const MAX = 500;
const lines: string[] = [];

function keep(text: string) {
  const at = new Date().toISOString().replace('T', ' ').slice(0, 23);
  for (const line of text.split('\n')) lines.push(`${at} ${line}`);
  if (lines.length > MAX) lines.splice(0, lines.length - MAX);
}

const { error, warn } = console;
console.error = (...args: unknown[]) => {
  keep(format(...args));
  error(...args);
};
console.warn = (...args: unknown[]) => {
  keep(format(...args));
  warn(...args);
};

/** Note something in the log (and on stderr). */
export const log = (...args: unknown[]) => console.error(...args);

/** The log, oldest line first. */
export const logText = () => lines.join('\n');
