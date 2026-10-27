// Watching a folder and what's in it, for the server's change notifications.

import { type FSWatcher, watch } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** macOS and Windows watch a whole tree natively; elsewhere Node stands in with a watch (and a stat) per file. */
const NATIVE = process.platform === 'darwin' || process.platform === 'win32';

/**
 * Watch `dir` and the folders under it, calling `changed` with what changed (its path from `dir`,
 * or undefined when the system doesn't say) and `failed` once if watching stops (out of watches,
 * say). Without native recursive watching, only folders are watched (a folder's watch sees its
 * files change), and only those `descend` allows (`/`-separated paths). Returns the way to stop.
 */
export function watchTree(
  dir: string,
  descend: (rel: string) => boolean,
  changed: (rel?: string) => void,
  failed: (e: Error) => void,
): () => void {
  let stopped = false;
  const fail = (e: Error) => {
    if (stopped) return;
    stop();
    failed(e);
  };
  const folders = new Map<string, FSWatcher>();
  const stop = () => {
    stopped = true;
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
    return stop;
  }
  const add = async (rel: string) => {
    if (stopped || folders.has(rel)) return;
    const path = join(dir, rel);
    const watching = open(rel, () =>
      watch(path, (type, f) => {
        if (!f) return changed(undefined);
        const sub = rel ? `${rel}/${f}` : f.toString();
        changed(sub);
        // A folder appeared, went or was moved: start or stop watching it.
        if (type === 'rename' && descend(sub)) {
          stat(join(dir, sub)).then(
            (st) => void (st.isDirectory() && add(sub)),
            () => remove(sub),
          );
        }
      }),
    );
    if (!watching) return;
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const sub = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && descend(sub)) await add(sub);
    }
    // A new folder's files may have been made before it was watched.
    if (ready) changed(rel);
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
  void add('').then(() => (ready = true));
  return stop;
}
