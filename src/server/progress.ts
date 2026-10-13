// Progress of fetches and pushes: git's --progress lines on stderr, parsed and passed on to
// whoever listens (the server streams them to the UI over its event stream).

import type { Progress } from '../shared/types.ts';
import type { Git, RunOpts } from './git.ts';

type Phase = Pick<Progress, 'phase' | 'server' | 'percent' | 'detail'>;

/** `Receiving objects:  41% (5/12), 3.11 MiB | 590.00 KiB/s`, `remote: Counting objects: 13, done.` */
const LINE = /^(remote: )?([A-Z][a-z]+(?: [a-z]+)*): +(?:(\d+)% \((\d+\/\d+)\)|(\d+))(?:, ([^,]*?\/s))?(?:, done\.)?\s*$/;

/** One progress line, or null for anything else git says. */
export function parseProgress(line: string): Phase | null {
  const m = LINE.exec(line.trim());
  if (!m) return null;
  const [, server, phase, percent, count, total, speed] = m;
  return { phase, server: !!server, percent: percent ? Number(percent) : null, detail: speed ?? count ?? total ?? null };
}

const listeners = new Set<(root: string, p: Progress) => void>();

/** Listen to every repo's progress; returns the way to stop. */
export function onProgress(fn: (root: string, p: Progress) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** How often a phase's percentage is passed on, at most. */
const EVERY_MS = 150;

/**
 * `git <args> --progress` (the flag goes after the subcommand), reporting each phase as it goes
 * and a finished one (phase null) at the end.
 */
export async function runWithProgress(git: Git, op: Progress['op'], remote: string, args: string[], opts: RunOpts = {}) {
  const emit = (p: Phase) => listeners.forEach((fn) => fn(git.root, { op, remote, ...p }));
  let partial = '';
  let last: Phase | null = null;
  let sent = 0;
  const onErr = (chunk: string) => {
    const lines = (partial + chunk).split(/[\r\n]/);
    partial = lines.pop() ?? '';
    for (const line of lines) {
      const p = parseProgress(line);
      if (!p) continue;
      const now = Date.now();
      if (p.phase === last?.phase && p.server === last.server && now - sent < EVERY_MS && p.percent !== 100) continue;
      last = p;
      sent = now;
      emit(p);
    }
  };
  try {
    return await git.run([args[0], '--progress', ...args.slice(1)], { ...opts, onErr });
  } finally {
    emit({ phase: null, server: false, percent: null, detail: null });
  }
}
