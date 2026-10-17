// An Actions job's log (one text file, each line stamped with the time it was written) split
// into the job's steps: by time, using the steps' start and end, and at the line every step's
// output starts with (`##[group]Run …`, `Post job cleanup.`), as steps often share a second.

import type { JobInfo, JobLog, LogLine, LogLineKind, LogStep } from '../../shared/gh-checks.ts';

const STAMP = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.\d+)?Z ?/;
const COMMAND = /^##\[(group|endgroup|error|warning|notice|command|debug)\]/;

const STARTS = /^(##\[group\]Run |Post job cleanup\.$|Cleaning up orphan processes$)/;

const second = (iso: string | null) => (iso ? Math.floor(Date.parse(iso) / 1000) : null);

/** One line without its timestamp, its `##[…]` marker turned into a kind; null for `##[endgroup]`. */
export function logLine(body: string): LogLine | null {
  const m = COMMAND.exec(body);
  if (!m) return { t: body };
  if (m[1] === 'endgroup') return null;
  return { t: body.slice(m[0].length), k: m[1] as LogLineKind };
}

/** Split `text` into `job`'s steps, keeping the last `cap` lines of each. */
export function parseJobLog(text: string, job: JobInfo, cap = 3000): JobLog {
  const steps = job.steps.length
    ? [...job.steps].sort((a, b) => a.number - b.number)
    : [{ number: 1, name: job.name, state: job.state, startedAt: null, completedAt: null }];
  const buckets: LogLine[][] = steps.map(() => []);
  let cur = 0;
  let started = false;
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = STAMP.exec(raw);
    const body = m ? raw.slice(m[0].length) : raw;
    const at = m ? second(`${m[1]}Z`) : null;
    if (at !== null) {
      for (;;) {
        const end = second(steps[cur].completedAt);
        const next = steps[cur + 1];
        if (!next) break;
        const nextStart = second(next.startedAt);
        const header = STARTS.test(body) && (started || cur === 0);
        if ((end !== null && at > end) || (header && nextStart !== null && at >= nextStart)) {
          cur++;
          started = false;
          if (header) break;
        } else break;
      }
    }
    if (STARTS.test(body)) started = true;
    const line = logLine(body);
    if (line) buckets[cur].push(line);
  }
  // The file ends with a newline.
  const last = buckets[cur];
  if (last.length && !last[last.length - 1].t && !last[last.length - 1].k) last.pop();

  const out: LogStep[] = steps.map((s, i) => {
    const all = buckets[i];
    const lines = all.length > cap ? all.slice(-cap) : all;
    return {
      number: s.number,
      name: s.name,
      state: s.state,
      lines,
      skipped: all.length - lines.length,
      firstError: lines.findIndex((l) => l.k === 'error'),
    };
  });
  const open =
    out.find((s) => s.state === 'failure' && s.lines.length) ??
    out.find((s) => s.firstError >= 0) ??
    out.findLast((s) => s.lines.length);
  return { jobId: job.id, name: job.name, url: job.url, state: job.state, steps: out, open: open?.number ?? null };
}
