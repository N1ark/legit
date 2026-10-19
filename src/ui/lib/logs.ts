// Settings ▸ Logs: the server's log (server/log.ts), with the page's own uncaught errors woven in.

import { request } from './app.svelte.ts';

const MAX = 200;
const page: string[] = [];

/** Same stamp as the server's lines, so the two sort together. */
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 23);

function keep(what: string, e: unknown) {
  const text = e instanceof Error ? (e.stack ?? `${e.name}: ${e.message}`) : String(e);
  page.push(`${stamp()} page ${what}: ${text}`);
  if (page.length > MAX) page.shift();
}

window.addEventListener('error', (e) => keep('error', e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => keep('unhandled', e.reason));

/** Both logs, oldest line first (the sort is stable: lines stamped alike keep their order). */
export async function loadLogs(): Promise<string> {
  const server = (await request<string>('/api/logs')).split('\n').filter(Boolean);
  return [...server, ...page].sort((a, b) => a.slice(0, 23).localeCompare(b.slice(0, 23))).join('\n');
}
