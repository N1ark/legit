// Submodules from the UI: the commits between two of theirs (fetched once, as commits never change), and opening one in legit.
import { IS_TAURI, toast } from 'purr';
import type { SubmoduleLog } from '../../shared/types.ts';
import { app, request } from './app.svelte.ts';
import { invoke } from './desktop.ts';

const logs = new Map<string, Promise<SubmoduleLog>>();

/** The commits between `old` and `new` of the submodule at `path`; a failure isn't kept. */
export function submoduleLog(path: string, old?: string, now?: string): Promise<SubmoduleLog> {
  const key = `${path}\0${old ?? ''}\0${now ?? ''}`;
  let p = logs.get(key);
  if (!p) {
    const q = new URLSearchParams({ path, old: old ?? '', new: now ?? '' });
    p = request<SubmoduleLog>(`/api/submodule?${q}`);
    p.catch(() => logs.get(key) === p && logs.delete(key));
    if (logs.size >= 200) logs.delete(logs.keys().next().value!);
    logs.set(key, p);
  }
  return p;
}

/** Show the submodule at `path` (repo-relative) instead of this repository, as switching repository does. */
export async function openSubmodule(path: string) {
  if (app.switchBlocker) return toast(app.switchBlocker);
  try {
    if (IS_TAURI) await invoke('open_submodule', { path: `${app.repo?.root}/${path}` });
    else location.href = (await request<{ url: string }>('/api/openSubmodule', { path })).url;
  } catch (e) {
    toast.error(e);
  }
}
