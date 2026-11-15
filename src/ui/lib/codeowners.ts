// CODEOWNERS, read as GitHub does: a pattern and its owners per line, the last matching line wins
// (one with no owners leaves the file unowned). Patterns follow .gitignore's rules, except that
// `!` and `[…]` aren't supported (GitHub skips such lines), and a trailing `/*` only matches the
// folder's own files, not deeper ones.

export interface OwnerRule {
  pattern: string;
  owners: string[];
  /** 1-based, in the file. */
  line: number;
  re: RegExp;
}

export interface Owners {
  owners: string[];
  rule: OwnerRule;
}

const OWNER = /^(@[\w.-]+(\/[\w.-]+)?|[^@\s]+@[^@\s]+)$/;

/** A line's fields, split at unescaped whitespace, up to an unescaped `#` that starts one (a comment). Escapes are kept. */
export function fields(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length) {
      cur += ch + line[++i];
    } else if (ch === ' ' || ch === '\t') {
      if (cur) out.push(cur);
      cur = '';
    } else if (ch === '#' && !cur) {
      break;
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

const quote = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** A segment's characters as a regex: `*` and `?` within the segment, `\x` as a literal x. */
function segment(seg: string): string {
  let out = '';
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (ch === '\\' && i + 1 < seg.length) out += quote(seg[++i]);
    else if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else out += quote(ch);
  }
  return out;
}

/** The pattern as a regex over repo-relative paths (no leading slash); null when GitHub wouldn't take it. */
export function compile(pattern: string): RegExp | null {
  if (!pattern || /^!|(^|[^\\])\[/.test(pattern)) return null;
  let segs = pattern.split('/');
  if (segs[0] === '') segs = segs.slice(1);
  else if (segs.length === 1 || (segs.length === 2 && segs[1] === '')) {
    // No slash but a trailing one: at any depth.
    if (segs[0] !== '**') segs = ['**', ...segs];
  }
  if (segs.length > 1 && segs[segs.length - 1] === '') segs[segs.length - 1] = '**';
  if (!segs.length || (segs.length === 1 && segs[0] === '')) return null;
  const last = segs.length - 1;
  let re = '^';
  let slash = false;
  segs.forEach((seg, i) => {
    if (seg === '**') {
      if (i === 0 && i === last) re += '.+';
      else if (i === 0) {
        re += '(?:.+/)?';
        slash = false;
      } else if (i === last) re += '/.*';
      else {
        re += '(?:/.+)?';
        slash = true;
      }
    } else if (seg === '*') {
      re += `${slash ? '/' : ''}[^/]+`;
      slash = true;
    } else {
      re += (slash ? '/' : '') + segment(seg);
      // A file, or a folder and everything under it.
      if (i === last) re += '(?:/.*)?';
      slash = true;
    }
  });
  return new RegExp(`${re}$`);
}

/** A CODEOWNERS file's rules, in order; lines GitHub would skip (a bad pattern or owner) are left out. */
export function parseCodeowners(text: string): OwnerRule[] {
  const out: OwnerRule[] = [];
  text.split(/\r?\n/).forEach((l, k) => {
    const [pattern, ...owners] = fields(l);
    if (!pattern || owners.some((o) => !OWNER.test(o))) return;
    const re = compile(pattern);
    if (re) out.push({ pattern, owners, line: k + 1, re });
  });
  return out;
}

/** Who owns `path`: the last rule matching it; null when none does, or it leaves the file unowned. */
export function ownersOf(rules: OwnerRule[], path: string): Owners | null {
  for (let k = rules.length - 1; k >= 0; k--) {
    if (rules[k].re.test(path)) return rules[k].owners.length ? { owners: rules[k].owners, rule: rules[k] } : null;
  }
  return null;
}

/** `login` is one of the owners by name (teams and e-mail addresses aren't checked). */
export const ownedBy = (owners: string[], login: string) => !!login && owners.some((o) => o.toLowerCase() === `@${login.toLowerCase()}`);
