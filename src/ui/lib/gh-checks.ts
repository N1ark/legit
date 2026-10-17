// Pure helpers for the CI views: what a state is called, durations, and ANSI colours in job logs.

import type { CheckCounts, CheckState, RollupState } from '../../shared/gh-checks.ts';

export const STATE_LABEL: Record<CheckState, string> = {
  success: 'Passed',
  failure: 'Failed',
  cancelled: 'Cancelled',
  action_required: 'Needs action',
  running: 'Running',
  pending: 'Queued',
  neutral: 'Neutral',
  skipped: 'Skipped',
};

export const ROLLUP_LABEL: Record<RollupState, string> = { success: 'Checks passed', failure: 'Checks failed', pending: 'Checks running' };

/** "45s", "3m 12s", "1h 4m". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** How long something ran (or has been running, as of `now`); null before it started. */
export function duration(state: CheckState, startedAt: string | null, completedAt: string | null, now: number): number | null {
  if (!startedAt || state === 'pending' || state === 'skipped') return null;
  const end = completedAt ? Date.parse(completedAt) : state === 'running' ? now : null;
  return end === null ? null : end - Date.parse(startedAt);
}

/** "1 failed, 1 running, 3 passed" (skipped and neutral ones aren't worth a word). */
export function describeCounts(c: CheckCounts): string {
  const parts = [
    c.failure && `${c.failure} failed`,
    c.running && `${c.running} running`,
    c.pending && `${c.pending} queued`,
    c.success && `${c.success} passed`,
  ].filter(Boolean);
  const other = c.total - c.failure - c.running - c.pending - c.success;
  if (other) parts.push(`${other} skipped or cancelled`);
  return parts.join(', ') || 'no checks';
}

export interface AnsiStyle {
  /** 0–15: the 8 colours, then their bright versions. */
  fg?: number;
  bg?: number;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** Foreground and background swapped. */
  inverse?: boolean;
}

export interface AnsiRun extends AnsiStyle {
  text: string;
}

/** A 256-colour index as one of the 16 basic colours, roughly; null for greys and the cube's mid tones. */
function basic(n: number): number | undefined {
  if (n < 16) return n;
  if (n >= 232) return n < 244 ? 8 : 7;
  const v = n - 16;
  const [r, g, b] = [Math.floor(v / 36), Math.floor(v / 6) % 6, v % 6].map((x) => (x >= 3 ? 1 : 0));
  return r | (g << 1) | (b << 2) || undefined;
}

/** Split a line into runs of one style, applying SGR escapes (`ESC[…m`) and dropping every other escape. */
export function ansiRuns(line: string): AnsiRun[] {
  const out: AnsiRun[] = [];
  let style: AnsiStyle = {};
  const re = /\x1b\[([0-9;]*)([A-Za-z])|\x1b[()][A-Za-z0-9]|\x1b./g;
  let last = 0;
  const push = (text: string) => {
    if (!text) return;
    const prev = out[out.length - 1];
    if (prev && sameStyle(prev, style)) prev.text += text;
    else out.push({ ...style, text });
  };
  for (let m; (m = re.exec(line)); ) {
    push(line.slice(last, m.index));
    last = re.lastIndex;
    if (m[2] !== 'm') continue;
    const codes = (m[1] || '0').split(';').map((x) => Number(x) || 0);
    style = { ...style };
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) style = {};
      else if (c === 1) style.bold = true;
      else if (c === 2) style.dim = true;
      else if (c === 3) style.italic = true;
      else if (c === 4) style.underline = true;
      else if (c === 7) style.inverse = true;
      else if (c === 22) style.bold = style.dim = undefined;
      else if (c === 23) style.italic = undefined;
      else if (c === 24) style.underline = undefined;
      else if (c === 27) style.inverse = undefined;
      else if (c >= 30 && c <= 37) style.fg = c - 30;
      else if (c === 39) style.fg = undefined;
      else if (c >= 40 && c <= 47) style.bg = c - 40;
      else if (c === 49) style.bg = undefined;
      else if (c >= 90 && c <= 97) style.fg = c - 90 + 8;
      else if (c >= 100 && c <= 107) style.bg = c - 100 + 8;
      else if (c === 38 || c === 48) {
        // 38;5;n picks from 256 colours, 38;2;r;g;b is true colour (left as the default).
        const key = c === 38 ? 'fg' : 'bg';
        if (codes[i + 1] === 5) style[key] = basic(codes[i + 2] ?? 0);
        else if (codes[i + 1] === 2) style[key] = undefined;
        i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 0;
      }
    }
    for (const k of Object.keys(style) as (keyof AnsiStyle)[]) if (style[k] === undefined) delete style[k];
  }
  push(line.slice(last));
  return out;
}

const sameStyle = (a: AnsiStyle, b: AnsiStyle) =>
  a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.dim === b.dim && a.italic === b.italic && a.underline === b.underline && a.inverse === b.inverse;

/** The text without its escapes, for copying and finding. */
export const stripAnsi = (line: string) => ansiRuns(line).map((r) => r.text).join('');
