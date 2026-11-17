// Watching a folder and what's in it, for the server's change notifications.

import { type FSWatcher, watch } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** macOS and Windows watch a whole tree natively; elsewhere Node stands in with a watch (and a stat) per file. */
const NATIVE = process.platform === 'darwin' || process.platform === 'win32';

/** How long folders that appeared are gathered before they're looked at together. */
const BATCH_MS = 50;

export interface TreeWatch {
  stop(): void;
  /** Look through the tree again for folders to watch (what `skip` says may have changed: a .gitignore). */
  rescan(): void;
}

/**
 * Watch `dir` and the folders under it, calling `changed` with what changed (its path from `dir`,
 * or undefined when the system doesn't say) and `failed` once if watching stops (out of watches,
 * say). Without native recursive watching, only folders are watched (a folder's watch sees its
 * files change), and only those `descend` allows (`/`-separated paths) and `skip` doesn't name
 * (asked a level at a time, for the folders found together).
 */
export function watchTree(
  dir: string,
  descend: (rel: string) => boolean,
  changed: (rel?: string) => void,
  failed: (e: Error) => void,
  skip?: (rels: string[]) => Promise<Set<string>>,
): TreeWatch {
  let stopped = false;
  const fail = (e: Error) => {
    if (stopped) return;
    stop();
    failed(e);
  };
  const folders = new Map<string, FSWatcher>();
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    for (const w of folders.values()) w.close();
    folders.clear();
  };
  const open = (rel: string, w: () => FSWatcher) => {
    try {
      const watcher = w();
      watcher.on('error', fail);
      folders.set(rel, watcher);
      return true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') fail(e as Error);
      return false;
    }
  };
  if (NATIVE) {
    open('', () => watch(dir, { recursive: true }, (_, f) => changed(f?.toString())));
    return { stop, rescan: () => {} };
  }

  // Names that appeared, went or moved, looked at together: a burst of files written is one look at each.
  let renamed = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  const settle = async () => {
    timer = undefined;
    const names = [...renamed];
    renamed = new Set();
    const found: string[] = [];
    await Promise.all(
      names.map((sub) =>
        stat(join(dir, sub)).then(
          (st) => {
            if (!st.isDirectory()) return remove(sub);
            // A folder that's there again was made anew (deleted and recreated, or moved in): its old watch sees nothing.
            remove(sub);
            found.push(sub);
          },
          () => remove(sub),
        ),
      ),
    );
    if (found.length && !stopped) await scan(found);
  };
  const watchFolder = (rel: string) =>
    open(rel, () =>
      watch(join(dir, rel), (type, f) => {
        if (!f) return changed(undefined);
        const sub = rel ? `${rel}/${f}` : f.toString();
        changed(sub);
        if (type === 'rename' && descend(sub)) {
          renamed.add(sub);
          timer ??= setTimeout(settle, BATCH_MS);
        }
      }),
    );

  /** Watch the folders `rels` and those under them, a level at a time; `again`: through those watched already too. */
  const scan = async (rels: string[], again = false) => {
    let level = rels;
    while (level.length && !stopped) {
      const asked = level.filter(Boolean);
      const skipped = skip && asked.length ? await skip(asked).catch(() => new Set<string>()) : new Set<string>();
      const next: string[] = [];
      await Promise.all(
        level.map(async (rel) => {
          if (stopped || skipped.has(rel)) return;
          const fresh = !folders.has(rel);
          if (fresh && !watchFolder(rel)) return;
          if (!fresh && !again) return;
          const entries = await readdir(join(dir, rel), { withFileTypes: true }).catch(() => []);
          for (const e of entries) {
            const sub = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory() && descend(sub)) next.push(sub);
          }
          // A new folder's files may have been made before it was watched.
          if (fresh && ready) changed(rel);
        }),
      );
      level = next;
    }
  };
  const remove = (rel: string) => {
    for (const [r, w] of folders) {
      if (r === rel || r.startsWith(rel + '/')) {
        w.close();
        folders.delete(r);
      }
    }
  };
  let ready = false;
  void scan(['']).then(() => (ready = true));
  return { stop, rescan: () => void scan([''], true) };
}
