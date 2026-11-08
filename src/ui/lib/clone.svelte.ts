import { IS_TAURI, toast } from 'purr';
import { app, request } from './app.svelte.ts';
import { invoke } from './desktop.ts';

/** The clone dialog (CloneDialog.svelte): shown or not. */
export const cloning = $state({ open: false });

export function cloneRepository() {
  cloning.open = true;
}

/** Switch to a repository just cloned; while something runs, only say where it is. */
export async function openCloned(path: string) {
  if (app.switchBlocker) return toast(`Cloned into ${path}. ${app.switchBlocker}`);
  try {
    if (IS_TAURI) await invoke('open_repo', { path });
    else location.href = (await request<{ url: string }>('/api/openClone', { path })).url;
  } catch (e) {
    toast.error(e);
  }
}
