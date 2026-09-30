import type { Person } from '../../shared/types.ts';

/** `Name <email>` */
const PERSON = /^\s*(.*?)\s*<([^>]*)>\s*$/;

export const formatPerson = (p: Person) => `${p.name} <${p.email}>`;

export function parsePerson(s: string): Person | null {
  const m = PERSON.exec(s);
  return m ? { name: m[1], email: m[2] } : null;
}

/** Co-authors from the editor's lines; null if a non-empty line isn't `Name <email>`. */
export function parsePeople(lines: string[]): Person[] | null {
  const out: Person[] = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    const p = parsePerson(l);
    if (!p) return null;
    out.push(p);
  }
  return out;
}
