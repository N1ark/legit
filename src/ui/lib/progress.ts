import type { Progress } from '../../shared/types.ts';

/** "Receiving objects 41%", "origin: counting objects 23%" for the remote's side, or with `named`. */
export function progressText(p: Progress, named = false): string {
  const phase = p.phase ?? 'Done';
  const what = named || p.server ? `${p.remote}: ${phase[0].toLowerCase()}${phase.slice(1)}` : phase;
  return p.percent === null ? what : `${what} ${p.percent}%`;
}

/** What several running transfers are at: each one's phase, plus the amount and speed when there's one. */
export function progressSummary(list: Progress[]): string {
  if (list.length === 1) {
    const [p] = list;
    return p.detail?.includes('/s') ? `${progressText(p)} · ${p.detail}` : progressText(p);
  }
  return list.map((p) => progressText(p, true)).join(' · ');
}
