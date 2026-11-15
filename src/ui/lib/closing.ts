// A pull request's description links the issues it closes by GitHub's closing keywords
// ("Closes #12", "fixes owner/repo#3"): there's no other way to link one through GitHub's API.

const KEYWORD = '(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)';

/** How the description names issue `number` of `repo`, as seen from `here` (`owner/name`). */
export function issueName(repo: string, number: number, here: string): string {
  return repo.toLowerCase() === here.toLowerCase() ? `#${number}` : `${repo}#${number}`;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The ways `body` can name the issue: `#12`, `owner/repo#12` or its URL. */
function names(repo: string, number: number, here: string): string {
  const full = `${escape(repo)}#${number}|https?://github\\.com/${escape(repo)}/issues/${number}`;
  return repo.toLowerCase() === here.toLowerCase() ? `#${number}|${full}` : full;
}

/** `body` with "Closes <issue>" added on a line of its own at the end, unless a closing keyword names it already. */
export function addClosing(body: string, repo: string, number: number, here: string): string {
  if (closes(body, repo, number, here)) return body;
  const line = `Closes ${issueName(repo, number, here)}`;
  const text = body.replace(/\s+$/, '');
  if (!text) return line;
  // Right under a closing line already at the end, else after a blank line.
  const last = text.split('\n').at(-1) ?? '';
  return new RegExp(`^\\s*${KEYWORD}:?\\s+(?:#\\d+|[\\w.-]+/[\\w.-]+#\\d+|https?://github\\.com/\\S+)\\W*$`, 'i').test(last) ? `${text}\n${line}` : `${text}\n\n${line}`;
}

/** Whether a closing keyword in `body` names the issue. */
export function closes(body: string, repo: string, number: number, here: string): boolean {
  return new RegExp(`\\b${KEYWORD}:?\\s+(?:${names(repo, number, here)})(?![\\w/])`, 'i').test(body);
}

/** `body` without the closing keywords naming the issue: a line left with nothing else goes, a list of several keeps the others. */
export function removeClosing(body: string, repo: string, number: number, here: string): string {
  const one = new RegExp(`\\b${KEYWORD}:?\\s+(?:${names(repo, number, here)})(?![\\w/])`, 'gi');
  const lines = body.split('\n').flatMap((l) => {
    if (!one.test(l)) return [l];
    one.lastIndex = 0;
    const left = l.replace(one, '').replace(/\s*,\s*(,\s*)+/g, ', ').replace(/^(\s*(?:[-*]\s+)?)\s*(?:,|and)\s*/i, '$1').replace(/\s*(?:,|and)\s*$/i, '');
    return /^\s*(?:[-*]\s*)?$/.test(left) ? [] : [left];
  });
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + (body.endsWith('\n') ? '\n' : '');
}
