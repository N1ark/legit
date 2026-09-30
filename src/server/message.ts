// Commit message <-> (subject, body, co-authors).

import type { Person } from '../shared/types.ts';

const COAUTHOR = /^co-authored-by:\s*(.*?)\s*<([^>]*)>\s*$/i;
const TRAILER = /^[A-Za-z0-9-]+:\s/;
const LEADING_BLANK = /^(?:[ \t]*\n)+/;

export function parseMessage(msg: string): { subject: string; body: string; coauthors: Person[] } {
  const nl = msg.indexOf('\n');
  const subject = (nl < 0 ? msg : msg.slice(0, nl)).trim();
  const coauthors: Person[] = [];
  const rest = (nl < 0 ? '' : msg.slice(nl + 1)).split('\n').filter((l) => {
    const m = COAUTHOR.exec(l.trim());
    if (m) coauthors.push({ name: m[1], email: m[2] });
    return !m;
  });
  return { subject, body: rest.join('\n').replace(LEADING_BLANK, '').trimEnd(), coauthors };
}

export function buildMessage(subject: string, body: string, coauthors: Person[]): string {
  let msg = subject.trim();
  body = body.replace(LEADING_BLANK, '').trimEnd();
  if (body) msg += '\n\n' + body;
  const people = coauthors.filter((c) => c.name.trim() || c.email.trim());
  if (people.length) {
    const trailers = people.map((c) => `Co-authored-by: ${c.name.trim()} <${c.email.trim()}>`).join('\n');
    // Join an existing trailer block (e.g. Signed-off-by) so git still parses them as trailers.
    const last = body.split(/\n[ \t]*\n/).pop() ?? '';
    const inBlock = body !== '' && last.split('\n').every((l) => TRAILER.test(l));
    msg += (inBlock ? '\n' : '\n\n') + trailers;
  }
  return msg + '\n';
}
