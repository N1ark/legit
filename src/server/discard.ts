// Discarding uncommitted changes, and getting them back.
//
// Before a file is touched, what's on disk is saved as a commit under
// refs/legit/discarded/<time>: HEAD's tree with the files as they were, whose second parent is
// HEAD's tree with the files as the discard left them. So `git diff <ref>^2 <ref>` is exactly
// what was discarded. Files are compared byte for byte right before each write, so an edit
// made in the meantime is never overwritten. Files too big to keep in git go to the Trash.
//
// Discarding unstaged changes never touches the index. Discarding staged changes takes them
// out of both the index and the files; that snapshot has two more parents, HEAD's tree with
// the index entries as they were and as they were left, so what was staged comes back too.

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, readlink, rename, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Discarded, DiscardResult, FileDiff, RestoreDiscardedRequest, RestoreDiscardedResult, StageRequest } from '../shared/types.ts';
import { emit, restage } from './staging.ts';
import { type Git, GitError, fromUtf8, toUtf8 } from './git.ts';
import type { Repo } from './repo.ts';
import { pruneRefs } from './retention.ts';
import { stagingOf, workDiff } from './work.ts';

export const DISCARDED = 'refs/legit/discarded';

/** Files bigger than this go to the Trash instead of into git. Settable for tests. */
export const trashing = { above: 20 * 1024 * 1024, trash: moveToTrash };

/** A path on disk: its type, executable bit and content (a symlink's target). */
interface Disk {
  kind: 'file' | 'link' | 'missing' | 'other';
  exec: boolean;
  /** Absent for files too big to save, which are compared by size, mtime and inode instead. */
  data?: Buffer;
  stat?: string;
}

/** What a path should become: a blob (its content, or an existing object) and its mode, or nothing. */
type Entry = { mode: string; data: Buffer; sha?: undefined } | { mode: string; sha: string; data?: undefined } | null;
/** An index entry (stage 0), or no entry. */
type IndexEntry = { mode: string; sha: string } | null;

/** Absolute path of a repo path (a byte string), as a Buffer so any file name works. */
const abs = (git: Git, path: string) => Buffer.concat([Buffer.from(git.root + '/'), Buffer.from(path, 'latin1')]);
const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

async function readDisk(p: Buffer): Promise<Disk> {
  let st;
  try {
    st = await lstat(p);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing', exec: false };
    throw e;
  }
  if (st.isSymbolicLink()) return { kind: 'link', exec: false, data: await readlink(p, { encoding: 'buffer' }) };
  if (!st.isFile()) return { kind: 'other', exec: false };
  const exec = (st.mode & 0o100) !== 0;
  const stat = `${st.size} ${st.mtimeMs} ${st.ino}`;
  if (st.size > trashing.above) return { kind: 'file', exec, stat };
  return { kind: 'file', exec, data: await readFile(p), stat };
}

const same = (a: Disk, b: Disk) =>
  a.kind === b.kind && a.exec === b.exec && (a.data && b.data ? a.data.equals(b.data) : a.stat === b.stat);

const isBig = (d: Disk) => d.kind === 'file' && !d.data;

function entryOf(d: Disk): Entry {
  if (d.kind === 'missing') return null;
  if (d.kind === 'link') return { mode: '120000', data: d.data! };
  return { mode: d.exec ? '100755' : '100644', data: d.data! };
}

const matches = (d: Disk, e: Entry) =>
  e === null ? d.kind === 'missing' : d.kind !== 'missing' && !isBig(d) && same(d, diskOf(e));

function diskOf(e: Exclude<Entry, null>): Disk {
  return { kind: e.mode === '120000' ? 'link' : 'file', exec: e.mode === '100755', data: e.data };
}

/** Write a path atomically (a temp file renamed over it), or remove it and any directories left empty. */
async function put(git: Git, path: string, e: Entry) {
  const p = abs(git, path);
  if (!e) {
    await unlink(p).catch((err) => {
      if (err.code !== 'ENOENT') throw err;
    });
    for (let d = parentOf(path); d; d = parentOf(d)) {
      try {
        await rmdir(abs(git, d));
      } catch {
        break;
      }
    }
    return;
  }
  if (!e.data) throw new GitError(`Internal error: no content to write for ${toUtf8(path)}.`);
  const dir = parentOf(path);
  if (dir) await mkdir(abs(git, dir), { recursive: true });
  const tmp = abs(git, `${dir ? dir + '/' : ''}.legit-${randomBytes(6).toString('hex')}`);
  try {
    if (e.mode === '120000') await symlink(e.data, tmp);
    else await writeFile(tmp, e.data, { mode: e.mode === '100755' ? 0o755 : 0o644, flag: 'wx' });
    await rename(tmp, p);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

const TRASH = `ObjC.import('Foundation');
function run(argv) {
  const err = $();
  const ok = $.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(argv[0]), null, err);
  if (!ok) throw new Error(ObjC.unwrap(err.localizedDescription) || 'unknown error');
}`;

/** Move a file to the macOS Trash (NSFileManager, so no Finder automation permission is needed). */
function moveToTrash(path: string): Promise<void> {
  if (process.platform !== 'darwin') return Promise.reject(new Error('the Trash is only supported on macOS'));
  return new Promise((done, fail) =>
    execFile('osascript', ['-l', 'JavaScript', '-e', TRASH, path], (err, _out, stderr) =>
      err ? fail(new Error(stderr.trim().replace(/^.*Error: /, '') || err.message)) : done(),
    ),
  );
}

/** A tree: HEAD's, with `entries` written over it. */
async function treeWith(git: Git, base: string, entries: Map<string, Entry>): Promise<string> {
  const zero = '0'.repeat(base.length);
  const records: string[] = [];
  for (const [path, e] of entries) {
    records.push(e ? `${e.mode} ${e.sha ?? git.writeObject('blob', e.data)}\t${path}` : `0 ${zero}\t${path}`);
  }
  await git.flush();
  const index = join(tmpdir(), `legit-index-${randomBytes(6).toString('hex')}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    await git.run(['read-tree', base], { env });
    if (records.length) {
      await git.run(['update-index', '-z', '--index-info'], { env, input: Buffer.from(records.map((r) => r + '\0').join(''), 'latin1') });
    }
    return await git.text(['write-tree'], { env });
  } finally {
    await unlink(index).catch(() => {});
  }
}

/**
 * Save `before` (what's on disk now) as refs/legit/discarded/<time>, a commit on HEAD whose
 * second parent holds `after` (what the files will become). With `index`, the third and
 * fourth parents hold the index entries before and after. Returns the ref.
 */
async function save(
  repo: Repo,
  subject: string,
  list: string[],
  before: Map<string, Entry>,
  after: Map<string, Entry>,
  index?: { before: Map<string, IndexEntry>; after: Map<string, IndexEntry> },
) {
  const git = repo.git;
  const head = await repo.head();
  if (!head) throw new GitError('This branch has no commits yet.');
  const base = await git.treeOf(head);
  const committer = await git.committerIdent();
  const commit = (tree: string, parents: string[], message: string) =>
    git.writeCommit({ tree, parents, author: committer, committer, extra: [], message });
  const left = commit(await treeWith(git, base, after), [head], `legit: after ${subject}\n`);
  const parents = [head, left];
  if (index) {
    parents.push(commit(await treeWith(git, base, index.before), [head], `legit: index before ${subject}\n`));
    parents.push(commit(await treeWith(git, base, index.after), [head], `legit: index after ${subject}\n`));
  }
  const sha = commit(await treeWith(git, base, before), parents, `legit: ${subject}\n\n${list.join('\n')}\n`);
  await git.flush();
  for (let time = Date.now(), tries = 0; ; time++, tries++) {
    const ref = `${DISCARDED}/${time}`;
    const r = await git.run(['update-ref', '-m', `legit: ${subject}`, ref, sha, ''], { allowFail: true });
    if (r.code === 0) {
      await pruneRefs(git);
      return ref;
    }
    if (tries > 5) throw new GitError(`Couldn't save the discarded changes; nothing was discarded. ${r.err.trim()}`);
  }
}

interface Step {
  path: string;
  /** What must be on disk right before the write; anything else stops everything. */
  expect: Disk;
  write: Entry;
  /** Too big to save: goes to the Trash first. */
  trash: boolean;
}

/** Apply the steps in order; on failure, say what was done and where it's saved. */
async function apply(git: Git, steps: Step[], ref: string | null, verb: string) {
  let done = 0;
  try {
    for (const s of steps) {
      const name = toUtf8(s.path);
      if (!same(await readDisk(abs(git, s.path)), s.expect)) {
        throw new GitError(`${name} changed in the meantime, so it was left as it is.`);
      }
      if (s.trash) {
        await trashing.trash(toUtf8(abs(git, s.path).toString('latin1'))).catch((e) => {
          throw new GitError(`Couldn't move ${name} to the Trash (${e.message}), so it was left as it is.`);
        });
      }
      await put(git, s.path, s.write);
      done++;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const progress = done ? `${done} of ${plural(steps.length, 'file')} were ${verb} before that.` : `Nothing was ${verb}.`;
    const saved = ref ? ` What was there before is saved in ${ref} (Backups ▸ Discarded changes).` : '';
    throw new GitError(`${msg} ${progress}${saved}`);
  }
}

/**
 * The files index `records` (`<mode> <sha>\t<path>`) check out as, through git's checkout
 * filters (line endings, LFS), without touching the index or the working tree.
 */
async function smudge(git: Git, records: string[], paths: string[]): Promise<Map<string, Entry>> {
  const out = new Map<string, Entry>();
  const modes = new Map(records.map((r) => [r.slice(r.indexOf('\t') + 1), r.slice(0, r.indexOf(' '))]));
  const index = join(tmpdir(), `legit-index-${randomBytes(6).toString('hex')}`);
  const env = { GIT_INDEX_FILE: index };
  const temps: string[] = [];
  try {
    await git.run(['update-index', '-z', '--index-info'], { env, input: Buffer.from(records.map((r) => r + '\0').join(''), 'latin1') });
    // --temp writes each file (a symlink as its target) to a temp file in the repo root.
    const r = await git.run(['checkout-index', '--temp', '-z', '--stdin'], {
      env,
      input: Buffer.from(paths.map((p) => p + '\0').join(''), 'latin1'),
    });
    for (const rec of r.out.toString('latin1').split('\0').filter(Boolean)) {
      const tab = rec.indexOf('\t');
      temps.push(rec.slice(0, tab));
      const path = rec.slice(tab + 1);
      out.set(path, { mode: modes.get(path)!, data: await readFile(join(git.root, rec.slice(0, tab))) });
    }
  } finally {
    await unlink(index).catch(() => {});
    await Promise.all(temps.map((t) => unlink(join(git.root, t)).catch(() => {})));
  }
  for (const p of paths) if (!out.has(p)) throw new GitError(`Couldn't check out ${toUtf8(p)}; nothing was discarded.`);
  return out;
}

/**
 * Discard uncommitted changes: lines or whole files of the working tree's diff, untracked files
 * included. The file loses them, and so does the index where they're staged (the rest of what's
 * staged stays). What's on disk and in the index is saved first.
 */
export function discard(repo: Repo, req: StageRequest): Promise<DiscardResult> {
  return repo.exclusive(async () => {
    const git = repo.git;
    const why = repo.blocked();
    if (why) throw new GitError(why);
    const snap = repo.snapshots.get(req.key);
    if (!snap) throw new GitError('Those changes are out of date; refresh and select again.');

    // Read the files first, then check them against what was shown: what gets saved is then
    // what was shown, and it's compared again right before each write.
    const before = new Map<string, Disk>();
    for (const pathU of Object.keys(req.selection)) {
      const path = fromUtf8(pathU);
      if (!snap.files.some((f) => f.path === path)) throw new GitError(`${pathU} changed since it was shown; nothing was discarded.`);
      before.set(path, await readDisk(abs(git, path)));
    }
    const { whole, partial } = await repo.resolve(req, (await workDiff(git, '')).diff);
    const files = [...whole, ...partial.map(({ f }) => f)];
    if (!files.length) throw new GitError('Select some changes to discard first.');
    for (const f of files) {
      const name = toUtf8(f.path);
      if (f.oldMode === '160000' || f.newMode === '160000') {
        throw new GitError(`${name} is a submodule; legit can't discard changes inside it. Nothing was discarded.`);
      }
      if (before.get(f.path)!.kind === 'other') throw new GitError(`${name} isn't a file or a symlink; nothing was discarded.`);
    }
    for (const { f } of partial) {
      if (isBig(before.get(f.path)!)) throw new GitError(`${toUtf8(f.path)} is too big to discard line by line; discard the whole file. Nothing was discarded.`);
    }

    // A renamed file goes back to its old path, which must be free.
    const renamed = whole.filter((f) => f.oldPath !== undefined);
    for (const f of renamed) {
      const d = await readDisk(abs(git, f.oldPath!));
      if (d.kind !== 'missing') throw new GitError(`${toUtf8(f.path)} was renamed from ${toUtf8(f.oldPath!)}, which is there again; nothing was discarded.`);
      before.set(f.oldPath!, d);
    }

    // What each file becomes (HEAD's version, or the changes not discarded), and its index entry.
    const paths = [...files.map((f) => f.path), ...renamed.map((f) => f.oldPath!)];
    const indexBefore = await indexEntries(git, paths);
    const indexAfter = new Map<string, IndexEntry>();
    const after = new Map<string, Entry>();
    const records: string[] = [];
    const headOf = (f: FileDiff): IndexEntry => (f.untracked || /^0+$/.test(f.oldSha) ? null : { mode: f.oldMode, sha: f.oldSha });
    for (const f of whole) {
      const h = headOf(f);
      const at = f.oldPath ?? f.path;
      if (f.oldPath !== undefined) {
        indexAfter.set(f.path, null);
        after.set(f.path, null);
      }
      if (!f.untracked) indexAfter.set(at, h);
      if (h) records.push(`${h.mode} ${h.sha}\t${at}`);
      else after.set(at, null);
    }
    const heads = await git.readObjects(partial.flatMap(({ f }) => (headOf(f) ? [f.oldSha] : [])));
    for (const { f, picked } of partial) {
      const s = stagingOf(f, heads.get(f.oldSha)?.data.toString('latin1') ?? '');
      const kept = emit(s.pos, (ci) => !picked.has(ci));
      // A mode change isn't a line, so it stays.
      records.push(`${f.status === 'D' ? f.oldMode : f.newMode} ${git.writeObject('blob', Buffer.from(kept, 'latin1'))}\t${f.path}`);
      const next = f.untracked ? s.index : restage(s.pos, s.index, s.staging, picked, false);
      if (next !== s.index) indexAfter.set(f.path, { mode: s.mode, sha: git.writeObject('blob', Buffer.from(next, 'latin1')) });
    }
    await git.flush();
    if (records.length) {
      for (const [p, e] of await smudge(git, records, records.map((r) => r.slice(r.indexOf('\t') + 1)))) after.set(p, e);
    }
    for (const [p, e] of indexAfter) if (sameEntry(indexBefore.get(p), e)) indexAfter.delete(p);
    const touched = paths.filter((p) => !matches(before.get(p)!, after.get(p)!));
    if (!touched.length && !indexAfter.size) throw new GitError('Those changes are already gone.');

    // Big files go first: if one can't go to the Trash, nothing else has been discarded yet.
    const big = touched.filter((p) => isBig(before.get(p)!));
    const kept = touched.filter((p) => !big.includes(p));
    const indexed = [...indexAfter.keys()];
    const ref =
      kept.length || indexed.length
        ? await save(
            repo,
            `discarded changes to ${plural(files.length, 'file')}`,
            paths.map((p) => (big.includes(p) ? `${p} (moved to the Trash)` : p)),
            new Map(kept.map((p) => [p, entryOf(before.get(p)!)])),
            new Map(kept.map((p) => [p, after.get(p)!])),
            indexed.length
              ? { before: new Map(indexed.map((p) => [p, indexBefore.get(p) ?? null])), after: indexAfter }
              : undefined,
          )
        : null;
    const steps = [...big, ...kept].map((p) => ({ path: p, expect: before.get(p)!, write: after.get(p)!, trash: big.includes(p) }));
    await apply(git, steps, ref, 'discarded');

    // Last, the index, if nothing changed it since it was read.
    if (indexed.length) {
      const fail = (msg: string) =>
        new GitError(`${msg} The files were discarded but the index wasn't; what was there before is saved in ${ref} (Backups ▸ Discarded changes).`);
      const current = await indexEntries(git, indexed);
      for (const p of indexed) if (!sameEntry(current.get(p), indexBefore.get(p))) throw fail(`${toUtf8(p)} was staged again meanwhile.`);
      const zero = '0'.repeat(git.emptyTree.length);
      const r = await git.run(['update-index', '-z', '--index-info'], {
        input: Buffer.from(indexed.map((p) => { const n = indexAfter.get(p); return (n ? `${n.mode} ${n.sha}\t${p}` : `0 ${zero}\t${p}`) + '\0'; }).join(''), 'latin1'),
        allowFail: true,
      });
      if (r.code !== 0) throw fail(`Couldn't update the index: ${r.err.trim()}`);
    }
    return { state: await repo.state(), ref, files: files.length, trashed: big.map((p) => toUtf8(p)) };
  });
}

/** Saved discards, newest first. */
export async function discarded(git: Git): Promise<Discarded[]> {
  const r = await git.run(['for-each-ref', '--format=%(refname)%00%(objectname)%00%(contents)%01', `${DISCARDED}/`]);
  return r.out
    .toString('latin1')
    .split('\x01\n')
    .filter(Boolean)
    .flatMap((rec) => {
      const [ref, sha, contents] = rec.split('\0');
      const time = Number(/\/(\d+)(?:-[\w-]+)?$/.exec(ref)?.[1]);
      if (!Number.isFinite(time)) return [];
      const [subject, ...body] = toUtf8(contents).split('\n');
      const files = body.filter(Boolean);
      return [{ ref, sha, time, label: subject.replace(/^legit: /, ''), files: files.slice(0, 50), count: files.length }];
    })
    .sort((a, b) => b.time - a.time);
}

/**
 * Put discarded files back. Files that changed since the discard are only overwritten with
 * `overwrite`, and their current content is saved first (as another discard).
 */
export function restoreDiscarded(repo: Repo, req: RestoreDiscardedRequest): Promise<RestoreDiscardedResult> {
  return repo.exclusive(async () => {
    const git = repo.git;
    const why = repo.blocked();
    if (why) throw new GitError(why);
    if (typeof req.ref !== 'string' || !req.ref.startsWith(`${DISCARDED}/`)) throw new GitError('Not a legit discard.');
    const sha = await git.text(['rev-parse', '--verify', '-q', `${req.ref}^{commit}`], { allowFail: true });
    if (!sha) throw new GitError('That discard is gone (they are kept for two weeks).');
    const s = await git.commit(sha);
    if (s.parents.length !== 2 && s.parents.length !== 4) throw new GitError('Not a legit discard.');
    const leftTree = await git.treeOf(s.parents[1]);

    // Every path the discard changed: as it was before (to restore) and as it was left.
    const { out } = await git.run(['diff-tree', '-r', '-z', '--no-renames', leftTree, s.tree]);
    const raw = out.toString('latin1').split('\0');
    const changes: { path: string; left: { mode: string; sha: string }; was: { mode: string; sha: string } }[] = [];
    for (let k = 0; k + 1 < raw.length; k += 2) {
      const [oldMode, newMode, oldSha, newSha] = raw[k].slice(1).split(' ');
      changes.push({ path: raw[k + 1], left: { mode: oldMode, sha: oldSha }, was: { mode: newMode, sha: newSha } });
    }
    const blobs = await git.readObjects(changes.flatMap((c) => [c.left, c.was].filter((e) => e.mode !== '000000').map((e) => e.sha)));
    const entry = (e: { mode: string; sha: string }): Entry => (e.mode === '000000' ? null : { mode: e.mode, data: blobs.get(e.sha)!.data });

    const steps: Step[] = [];
    const conflicts: { path: string; now: Disk }[] = [];
    for (const c of changes) {
      const now = await readDisk(abs(git, c.path));
      const was = entry(c.was);
      if (matches(now, was)) continue;
      if (now.kind === 'other') throw new GitError(`${toUtf8(c.path)} isn't a file or a symlink anymore; nothing was restored.`);
      if (!matches(now, entry(c.left))) conflicts.push({ path: c.path, now });
      steps.push({ path: c.path, expect: now, write: was, trash: isBig(now) });
    }
    if (conflicts.length && !req.overwrite) {
      return { state: await repo.state(), restored: 0, conflicts: conflicts.map((c) => toUtf8(c.path)), saved: null };
    }
    const staged = s.parents.length === 4 ? await indexChanges(git, s.parents[3], s.parents[2]) : [];
    const keep = conflicts.filter((c) => !isBig(c.now));
    const saved = keep.length
      ? await save(
          repo,
          `replaced ${plural(keep.length, 'file')} restoring discarded changes`,
          keep.map((c) => c.path),
          new Map(keep.map((c) => [c.path, entryOf(c.now)])),
          new Map(keep.map((c) => [c.path, entry(changes.find((x) => x.path === c.path)!.was)])),
        )
      : null;
    await apply(git, steps, saved, 'restored');
    // What was staged goes back where the index is still as the discard left it.
    const current = await indexEntries(git, staged.map((c) => c.path));
    const back = staged.filter((c) => sameEntry(current.get(c.path), c.left));
    if (back.length) {
      const zero = '0'.repeat(sha.length);
      await git.run(['update-index', '-z', '--index-info'], {
        input: Buffer.from(back.map((c) => (c.was ? `${c.was.mode} ${c.was.sha}\t${c.path}` : `0 ${zero}\t${c.path}`) + '\0').join(''), 'latin1'),
      });
    }
    const restored = new Set([...steps.map((x) => x.path), ...back.map((c) => c.path)]).size;
    return { state: await repo.state(), restored, conflicts: [], saved };
  });
}

/** Stage-0 index entries of `paths`; refuses on unmerged ones. */
async function indexEntries(git: Git, paths: string[]): Promise<Map<string, IndexEntry>> {
  const out = new Map<string, IndexEntry>(paths.map((p) => [p, null]));
  const recs: string[] = [];
  for (let i = 0; i < paths.length; i += 500) {
    const chunk = paths.slice(i, i + 500).map((p) => Buffer.from(p, 'latin1').toString('utf8'));
    const r = await git.run(['--literal-pathspecs', 'ls-files', '-s', '-z', '--', ...chunk]);
    recs.push(...r.out.toString('latin1').split('\0').filter(Boolean));
  }
  for (const rec of recs) {
    const tab = rec.indexOf('\t');
    const [mode, sha, stage] = rec.slice(0, tab).split(' ');
    const path = rec.slice(tab + 1);
    if (stage !== '0') throw new GitError(`${toUtf8(path)} has unresolved conflicts; nothing was discarded.`);
    if (out.has(path)) out.set(path, { mode, sha });
  }
  return out;
}

const sameEntry = (a: IndexEntry | undefined, b: IndexEntry | undefined) =>
  (a ?? null) === null ? (b ?? null) === null : !!b && a!.mode === b.mode && a!.sha === b.sha;

/** Index entries a staged discard changed: as it left them (`left`) and as they were (`was`). */
async function indexChanges(git: Git, leftCommit: string, wasCommit: string) {
  const { out } = await git.run(['diff-tree', '-r', '-z', '--no-renames', leftCommit, wasCommit]);
  const raw = out.toString('latin1').split('\0');
  const entry = (mode: string, sha: string): IndexEntry => (mode === '000000' ? null : { mode, sha });
  const changes: { path: string; left: IndexEntry; was: IndexEntry }[] = [];
  for (let k = 0; k + 1 < raw.length; k += 2) {
    const [oldMode, newMode, oldSha, newSha] = raw[k].slice(1).split(' ');
    changes.push({ path: raw[k + 1], left: entry(oldMode, oldSha), was: entry(newMode, newSha) });
  }
  return changes;
}
