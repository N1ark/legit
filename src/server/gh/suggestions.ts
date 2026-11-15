// Suggestions applied together, as GitHub's "Commit suggestions": each written into its file where
// its lines still read the same (see withSuggestion), then one commit of those files on the current
// branch, its authors as co-authors. Undone like a commit: HEAD goes back, the files stay changed.

import { readFile } from 'node:fs/promises';
import { GitError } from '../git.ts';
import { buildMessage } from '../message.ts';
import { viewerLogin } from './client.ts';
import { replaceFile, withSuggestion, workFile } from './review.ts';
import type { ApplySuggestion, ApplySuggestions, SuggestionRefused, SuggestionsApplied } from '../../shared/gh-review.ts';
import type { GhUser } from '../../shared/github.ts';
import type { OpResult, Person } from '../../shared/types.ts';
import type { Repo } from '../repo.ts';
import type { PostRoute } from './routes.ts';

type Edit = Pick<ApplySuggestion, 'startLine' | 'lines' | 'replacement'>;

/** `file` with each of `list` applied that can be (by its index), and why each other one can't. */
export function withSuggestions(file: string, list: Edit[]): { text: string; applied: number[]; refused: { index: number; why: string }[] } {
  const refused: { index: number; why: string }[] = [];
  const taken: { index: number; s: Edit; at: number; end: number }[] = [];
  list.forEach((s, index) => {
    const r = withSuggestion(file, s);
    if ('error' in r) return void refused.push({ index, why: r.error });
    const at = r.at;
    const end = at + s.lines.length - 1;
    if (taken.some((t) => at <= t.end && t.at <= end)) refused.push({ index, why: 'It changes lines another suggestion in the batch changes: apply it on its own afterwards.' });
    else taken.push({ index, s, at, end });
  });
  // From the bottom up, so each one's lines are where they were found.
  let text = file;
  for (const t of taken.toSorted((a, b) => b.at - a.at)) {
    const r = withSuggestion(text, { ...t.s, startLine: t.at });
    if ('error' in r) refused.push({ index: t.index, why: r.error });
    else text = r.text;
  }
  const out = new Set(refused.map((r) => r.index));
  return { text, applied: taken.map((t) => t.index).filter((i) => !out.has(i)).sort((a, b) => a - b), refused: refused.sort((a, b) => a.index - b.index) };
}

/** A GitHub user's commit email: the noreply address with their id (in their avatar's URL) when known, as GitHub's own suggestion commits use. */
export function noreplyEmail(u: GhUser): string {
  const id = /^https:\/\/avatars\.githubusercontent\.com\/u\/(\d+)/.exec(u.avatar ?? '')?.[1];
  return `${id ? `${id}+` : ''}${u.login}@users.noreply.github.com`;
}

/** Paths of `paths` with changes not committed (staged or not, or untracked), from `git status -z`. */
async function dirty(repo: Repo, paths: string[]): Promise<Set<string>> {
  // Not trimmed: the first entry's status can start with a space.
  const out = (await repo.git.run(['--literal-pathspecs', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...paths])).out.toString('utf8');
  const set = new Set<string>();
  const parts = out.split('\0');
  for (let k = 0; k < parts.length; k++) {
    if (parts[k].length < 4) continue;
    set.add(parts[k].slice(3));
    // A rename's or copy's old path follows it.
    if (/^[RC]/.test(parts[k])) set.add(parts[++k]);
  }
  return set;
}

export const suggestionsPost: Record<string, PostRoute> = {
  reviewApplyBatch: (repo, b: ApplySuggestions) => applySuggestions(repo, b),
};

export async function applySuggestions(repo: Repo, b: ApplySuggestions): Promise<OpResult & SuggestionsApplied> {
  const list = Array.isArray(b?.suggestions) ? b.suggestions : [];
  if (!list.length) throw new GitError('Pick suggestions to apply first.');
  for (const s of list) {
    if (typeof s.path !== 'string' || !Array.isArray(s.lines) || !Array.isArray(s.replacement) || !Number.isInteger(s.startLine)) throw new GitError('Bad suggestion.');
  }
  const viewer = await viewerLogin().catch(() => null);
  return repo.exclusive(async () => {
    const why = repo.blocked();
    if (why) throw new GitError(why);
    const { branch, head: before } = await repo.git.headState();
    if (!branch || branch !== b.branch) throw new GitError(`Check out ${b.branch} first: these suggestions are for its pull request.`);
    if (!before || before !== b.head) throw new GitError(`${branch} has moved since; look at the suggestions again.`);
    const refused: SuggestionRefused[] = [];
    const refuse = (s: (typeof list)[number], why: string) => refused.push({ index: list.indexOf(s), path: s.path, startLine: s.startLine, why });
    const paths = [...new Set(list.map((s) => s.path))];
    const changed = await dirty(repo, paths);
    const writes: { path: string; abs: string; mode: number; before: Buffer; text: string }[] = [];
    const applied: typeof list = [];
    for (const path of paths) {
      const mine = list.filter((s) => s.path === path);
      const file = await workFile(repo, path).catch((e: Error) => e);
      if (file instanceof Error) {
        mine.forEach((s) => refuse(s, file.message));
        continue;
      }
      if (changed.has(path)) {
        mine.forEach((s) => refuse(s, `${path} has uncommitted changes: commit or stash them first, or apply it on its own.`));
        continue;
      }
      const content = await readFile(file.abs);
      const r = withSuggestions(content.toString('utf8'), mine);
      r.refused.forEach((x) => refuse(mine[x.index], x.why));
      if (!r.applied.length) continue;
      applied.push(...r.applied.map((i) => mine[i]));
      writes.push({ path, ...file, before: content, text: r.text });
    }
    if (!applied.length) throw new GitError(`None of the suggestions could be applied: ${refused.map((r) => `${r.path}:${r.startLine}: ${r.why}`).join(' ')}`);
    const done: typeof writes = [];
    try {
      for (const w of writes) {
        await replaceFile(w.abs, w.path, w.mode, w.before, w.text);
        done.push(w);
      }
      const people = new Map<string, Person>();
      for (const s of applied) if (s.author?.login && s.author.login !== viewer) people.set(s.author.login, { name: s.author.login, email: noreplyEmail(s.author) });
      const subject = applied.length === 1 ? 'Apply suggestion from code review' : 'Apply suggestions from code review';
      const r = await repo.git.run(['--literal-pathspecs', 'commit', '--cleanup=whitespace', '-F', '-', '--only', '--', ...writes.map((w) => w.path)], {
        input: buildMessage(subject, '', [...people.values()]),
        allowFail: true,
        timeout: 600_000,
      });
      if (r.code !== 0) throw new GitError(`Commit failed; your files are as they were.\n${(r.err + r.out.toString('utf8')).trim()}`);
    } catch (e) {
      // The files go back to what they were: nothing half done.
      for (const w of done) await replaceFile(w.abs, w.path, w.mode, Buffer.from(w.text), w.before).catch(() => {});
      throw e;
    }
    const after = await repo.head();
    if (after && after !== before) await repo.record({ label: 'apply suggestions', before, after, soft: true });
    const n = applied.length;
    const note = refused.length
      ? `Committed ${n} suggestion${n === 1 ? '' : 's'}. Not applied: ${refused.map((r) => `${r.path}:${r.startLine} (${r.why})`).join('; ')}`
      : undefined;
    refused.sort((a, c) => a.index - c.index);
    return { state: await repo.state(), renamed: {}, focus: after ? [after] : [], note, applied: applied.map((s) => list.indexOf(s)).sort((a, c) => a - c), refused };
  });
}
