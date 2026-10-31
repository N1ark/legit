/** A staged file, as far as naming the commit goes. */
export interface TitleFile {
  path: string;
  status: 'A' | 'M' | 'D' | 'T' | 'R' | 'C';
  oldPath?: string;
  untracked?: boolean;
}

const VERB: Record<TitleFile['status'], string> = { A: 'Add', C: 'Add', D: 'Delete', R: 'Rename', M: 'Update', T: 'Update' };
const name = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const dir = (p: string) => p.slice(0, p.lastIndexOf('/') + 1);

/**
 * A default title for a commit of `files`, so a quick commit needs no typing: what was done
 * to them (Add, Delete, Rename, else Update) and which, by name when there are one or two,
 * else how many and the folder they share.
 */
export function commitTitle(files: TitleFile[]): string {
  if (!files.length) return '';
  const verbs = new Set(files.map((f) => (f.untracked ? 'Add' : VERB[f.status])));
  const verb = verbs.size === 1 ? [...verbs][0] : 'Update';
  if (files.length === 1 && verb === 'Rename' && files[0].oldPath) {
    const [from, to] = [files[0].oldPath, files[0].path];
    return `Rename ${dir(from) === dir(to) ? name(from) : from} to ${dir(from) === dir(to) ? name(to) : to}`;
  }
  const names = [...new Set(files.map((f) => name(f.path)))];
  if (names.length === 1 && files.length === 1) return `${verb} ${names[0]}`;
  if (names.length === 2 && files.length === 2) return `${verb} ${names[0]} and ${names[1]}`;
  let common = dir(files[0].path);
  for (const f of files) while (!f.path.startsWith(common)) common = dir(common.slice(0, -1));
  return `${verb} ${files.length} files${common ? ` in ${common.slice(0, -1)}` : ''}`;
}
