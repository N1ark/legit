// Discarding unstaged changes, and putting them back. What's discarded is saved first
// (refs/legit/discarded, kept for two weeks), so every discard can be undone.

import { toast } from 'purr';
import type { DiscardResult, RestoreDiscardedResult, Selection } from '../../shared/types.ts';
import { app, request } from './app.svelte.ts';

export const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** "a, b and 3 more". */
export function names(list: string[], max = 3) {
  const shown = list.slice(0, max).join(', ');
  return list.length > max ? `${shown} and ${list.length - max} more` : shown;
}

/** Discard unstaged changes (a selection made on snapshot `key`). The toast offers to undo it. */
export async function discardChanges(key: string, selection: Selection): Promise<boolean> {
  if (app.busy || !Object.keys(selection).length) return false;
  app.busy = true;
  app.running = 'discard';
  try {
    const r = await request<DiscardResult>('/api/discard', { key, selection });
    const trashed = r.trashed.length ? ` Too big to keep, ${names(r.trashed)} went to the Trash.` : '';
    const ref = r.ref;
    toast(
      `Discarded changes to ${plural(r.files, 'file')}.${trashed}`,
      ref ? { timeout: 10_000, action: { label: 'Undo', run: () => restoreDiscarded(ref) } } : { timeout: 8000 },
    );
    return true;
  } catch (e) {
    toast.error(e);
    return false;
  } finally {
    app.busy = false;
    app.workChanged();
  }
}

/**
 * Put discarded files back. Files that changed since are left alone (and listed in the result)
 * unless `overwrite`; with `offer`, a toast offers to overwrite them.
 */
export async function restoreDiscarded(ref: string, overwrite = false, offer = true): Promise<RestoreDiscardedResult | null> {
  if (app.busy) return null;
  app.busy = true;
  app.running = 'restoreDiscarded';
  try {
    const r = await request<RestoreDiscardedResult>('/api/restoreDiscarded', { ref, overwrite });
    if (r.conflicts.length) {
      if (offer) {
        toast.error(`${names(r.conflicts)} changed since the discard, so nothing was restored.`, {
          timeout: 15_000,
          action: { label: 'Overwrite', run: () => restoreDiscarded(ref, true) },
        });
      }
    } else if (!r.restored) toast('Those changes are already back.');
    else {
      const saved = r.saved ? ' What they replaced is saved under Backups ▸ Discarded changes.' : '';
      toast(`Restored ${plural(r.restored, 'file')}.${saved}`);
    }
    return r;
  } catch (e) {
    toast.error(e);
    return null;
  } finally {
    app.busy = false;
    app.workChanged();
  }
}
