// The desktop app's commands (src-tauri/src/main.rs `commands`), and the view a window keeps of
// each repo while it shows another: in the app's memory, or for the browser, this tab's session.
import { IS_TAURI } from 'purr';

export const invoke = <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
  (window as any).__TAURI_INTERNALS__.invoke(cmd, args);

const KEY = 'legit:view';

export async function remember(view: unknown) {
  try {
    const state = JSON.stringify(view);
    if (IS_TAURI) await invoke('remember_view', { origin: location.origin, state });
    else sessionStorage.setItem(KEY, state);
  } catch {}
}

/** What was remembered for this repo, once. */
export async function recall<T>(): Promise<T | null> {
  try {
    let state: string | null;
    if (IS_TAURI) state = await invoke<string | null>('recall_view', { origin: location.origin });
    else {
      state = sessionStorage.getItem(KEY);
      sessionStorage.removeItem(KEY);
    }
    return state ? JSON.parse(state) : null;
  } catch {
    return null;
  }
}
