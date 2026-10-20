// Low-level git access: process spawning, object reading, and direct loose-object writing.
//
// Strings holding git object content are "byte strings" (latin1-decoded) so they
// round-trip exactly; `toUtf8` / `fromUtf8` convert at the UI boundary.

import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

export class GitError extends Error {
  /** Lets the UI offer a way out, e.g. 'not-integrated' for a force push it can retry. */
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

export const toUtf8 = (s: string) => Buffer.from(s, 'latin1').toString('utf8');
export const fromUtf8 = (s: string) => Buffer.from(s, 'utf8').toString('latin1');

export interface RunResult {
  code: number;
  out: Buffer;
  err: string;
}

export interface RunOpts {
  input?: string | Buffer;
  env?: Record<string, string>;
  /** Don't throw on a non-zero exit code. */
  allowFail?: boolean;
  /** Kill the process after this many ms (for network operations). */
  timeout?: number;
  /** Called with stderr as it arrives (for progress). */
  onErr?: (chunk: string) => void;
}

export function run(cwd: string, args: string[], opts: RunOpts = {}): Promise<RunResult> {
  return new Promise((done, fail) => {
    const p = spawn('git', args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...opts.env },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    p.stdout.on('data', (d: Buffer) => out.push(d));
    p.stderr.on('data', (d: Buffer) => {
      err.push(d);
      opts.onErr?.(d.toString('utf8'));
    });
    p.stdin.on('error', () => {});
    const timer = opts.timeout ? setTimeout(() => p.kill('SIGTERM'), opts.timeout) : undefined;
    p.on('error', fail);
    p.on('close', (code) => {
      clearTimeout(timer);
      const res = { code: code ?? -1, out: Buffer.concat(out), err: Buffer.concat(err).toString('utf8') };
      if (res.code !== 0 && !opts.allowFail) {
        fail(new GitError(`git ${args[0]} failed: ${res.err.trim() || `exit ${res.code}`}`));
      } else done(res);
    });
    p.stdin.end(opts.input);
  });
}

export interface RawCommit {
  sha: string;
  tree: string;
  parents: string[];
  /** Raw ident line value: `Name <email> 1700000000 +0100`. */
  author: string;
  committer: string;
  /** Other headers (e.g. `encoding`), verbatim. Signatures are dropped. */
  extra: string[];
  message: string;
}

export interface Ident {
  name: string;
  email: string;
  time: number;
  tz: string;
}

export function parseIdent(raw: string): Ident {
  const m = /^(.*?) ?<([^>]*)> (\d+) ([+-]\d{4})$/.exec(raw);
  if (!m) return { name: raw, email: '', time: 0, tz: '+0000' };
  return { name: m[1], email: m[2], time: Number(m[3]), tz: m[4] };
}

export const formatIdent = (i: Ident) => `${i.name} <${i.email}> ${i.time} ${i.tz}`;

function parseCommit(sha: string, data: string): RawCommit {
  const split = data.indexOf('\n\n');
  const head = split < 0 ? data : data.slice(0, split);
  const message = split < 0 ? '' : data.slice(split + 2);
  const c: RawCommit = { sha, tree: '', parents: [], author: '', committer: '', extra: [], message };
  const headers: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith(' ') && headers.length) headers[headers.length - 1] += '\n' + line;
    else headers.push(line);
  }
  for (const h of headers) {
    const sp = h.indexOf(' ');
    const key = h.slice(0, sp);
    const val = h.slice(sp + 1);
    if (key === 'tree') c.tree = val;
    else if (key === 'parent') c.parents.push(val);
    else if (key === 'author') c.author = val;
    else if (key === 'committer') c.committer = val;
    else if (key !== 'gpgsig' && key !== 'gpgsig-sha256') c.extra.push(h);
  }
  return c;
}

function serializeCommit(c: Omit<RawCommit, 'sha'>): Buffer {
  let s = `tree ${c.tree}\n`;
  for (const p of c.parents) s += `parent ${p}\n`;
  s += `author ${c.author}\ncommitter ${c.committer}\n`;
  for (const h of c.extra) s += h + '\n';
  return Buffer.from(s + '\n' + c.message, 'latin1');
}

export class Git {
  readonly root: string;
  readonly gitDir: string;
  readonly commonDir: string;
  private objectsDir: string;
  private hashAlgo: string;
  readonly emptyTree: string;
  private commits = new Map<string, RawCommit>();
  private written = new Set<string>();
  private pending: Promise<void>[] = [];
  private reader: ObjectReader;

  private constructor(root: string, gitDir: string, commonDir: string, objectsDir: string, hashAlgo: string) {
    this.root = root;
    this.gitDir = gitDir;
    this.commonDir = commonDir;
    this.objectsDir = objectsDir;
    this.hashAlgo = hashAlgo;
    this.emptyTree =
      hashAlgo === 'sha256'
        ? '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321'
        : '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    this.reader = new ObjectReader(root);
  }

  static async open(path: string): Promise<Git> {
    const r = await run(path, [
      'rev-parse',
      '--path-format=absolute',
      '--show-toplevel',
      '--git-dir',
      '--git-common-dir',
      '--git-path',
      'objects',
      '--show-object-format',
    ]).catch(() => {
      throw new GitError(`Not a git repository: ${resolve(path)}`);
    });
    const [root, gitDir, commonDir, objects, algo] = r.out.toString('utf8').trim().split('\n');
    return new Git(root, gitDir, commonDir, objects, algo);
  }

  run(args: string[], opts?: RunOpts) {
    return run(this.root, args, opts);
  }

  /** Run git and return trimmed utf8 stdout. */
  async text(args: string[], opts?: RunOpts): Promise<string> {
    return (await this.run(args, opts)).out.toString('utf8').trim();
  }

  /** Read many objects at once (through one long-lived `cat-file --batch`). Missing objects are absent from the result. */
  readObjects(names: string[]): Promise<Map<string, { type: string; data: Buffer }>> {
    return this.reader.read(names.filter((n) => n && !n.includes('\n')));
  }

  /** Load commits (cached: commits are immutable). */
  async loadCommits(shas: string[]): Promise<RawCommit[]> {
    const missing = shas.filter((s) => !this.commits.has(s));
    if (missing.length) {
      const objs = await this.readObjects(missing);
      for (const [sha, o] of objs) {
        if (o.type === 'commit') this.commits.set(sha, parseCommit(sha, o.data.toString('latin1')));
      }
    }
    return shas.map((s) => {
      const c = this.commits.get(s);
      if (!c) throw new GitError(`Unknown commit ${s}`);
      return c;
    });
  }

  async commit(sha: string): Promise<RawCommit> {
    return (await this.loadCommits([sha]))[0];
  }

  async treeOf(sha: string | null): Promise<string> {
    return sha ? (await this.commit(sha)).tree : this.emptyTree;
  }

  /**
   * Write an object straight into the object store, skipping a git process.
   * The SHA is returned immediately; call `flush()` before git needs to see the object.
   */
  writeObject(type: 'blob' | 'commit', data: Buffer): string {
    const full = Buffer.concat([Buffer.from(`${type} ${data.length}\0`), data]);
    const sha = createHash(this.hashAlgo).update(full).digest('hex');
    const dir = join(this.objectsDir, sha.slice(0, 2));
    const file = join(dir, sha.slice(2));
    if (!this.written.has(sha) && !existsSync(file)) {
      this.written.add(sha);
      this.pending.push(
        (async () => {
          await mkdir(dir, { recursive: true });
          const tmp = join(dir, `tmp_obj_legit_${randomBytes(6).toString('hex')}`);
          await writeFile(tmp, deflateSync(full, { level: 1 }), { mode: 0o444 });
          await rename(tmp, file);
        })(),
      );
    }
    return sha;
  }

  /** Wait for pending object writes. */
  async flush() {
    const pending = this.pending.splice(0);
    try {
      await Promise.all(pending);
    } catch (e) {
      this.written.clear();
      throw e;
    }
  }

  writeCommit(c: Omit<RawCommit, 'sha'>): string {
    const sha = this.writeObject('commit', serializeCommit(c));
    this.commits.set(sha, { ...c, sha });
    return sha;
  }

  /** Committer ident for new commits, honouring git config and GIT_COMMITTER_* env. */
  async committerIdent(): Promise<string> {
    return fromUtf8(await this.text(['var', 'GIT_COMMITTER_IDENT']));
  }

  /** Start a tree merger; call `close()` when done. */
  merger(): Merger {
    return new Merger(this.root);
  }
}

interface ObjectRequest {
  names: string[];
  next: number;
  res: Map<string, { type: string; data: Buffer }>;
  done: (r: Map<string, { type: string; data: Buffer }>) => void;
  fail: (e: Error) => void;
}

type Handle = { ref(): void; unref(): void };

/** Ends an idle `cat-file --batch` after this long. */
const READER_IDLE_MS = 30_000;

/**
 * One long-lived `git cat-file --batch` answering object reads in turn (a process per read
 * costs a few ms). It only reads objects by name, which never change, and git looks for new
 * packs and loose objects whenever one isn't found, so it never answers out of date.
 */
class ObjectReader {
  private cwd: string;
  private proc: ChildProcess | null = null;
  private chunks: Buffer[] = [];
  private length = 0;
  /** Bytes needed before the next response can be parsed. */
  private need = 1;
  private waiting: ObjectRequest[] = [];
  private idle: NodeJS.Timeout | undefined;
  private err = '';

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  read(names: string[]): Promise<Map<string, { type: string; data: Buffer }>> {
    const res = new Map<string, { type: string; data: Buffer }>();
    if (!names.length) return Promise.resolve(res);
    clearTimeout(this.idle);
    const p = this.proc ?? this.start();
    p.ref();
    (p.stdout as unknown as Handle).ref();
    return new Promise((done, fail) => {
      this.waiting.push({ names, next: 0, res, done, fail });
      p.stdin!.write(names.join('\n') + '\n');
    });
  }

  private start() {
    const p = spawn('git', ['cat-file', '--batch'], { cwd: this.cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    this.proc = p;
    this.chunks = [];
    this.length = 0;
    this.need = 1;
    this.err = '';
    p.stdout!.on('data', (d: Buffer) => this.data(d));
    p.stderr!.on('data', (d: Buffer) => (this.err += d.toString('utf8')));
    p.stdin!.on('error', () => {});
    const die = (e?: Error) => {
      if (this.proc !== p) return;
      this.proc = null;
      clearTimeout(this.idle);
      const err = new GitError(`git cat-file failed: ${this.err.trim() || e?.message || 'it exited'}`);
      for (const w of this.waiting.splice(0)) w.fail(err);
    };
    p.on('error', die);
    p.on('close', () => die());
    return p;
  }

  private data(d: Buffer) {
    this.chunks.push(d);
    this.length += d.length;
    if (this.length < this.need) return;
    const buf = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.length);
    let pos = 0;
    this.need = 1;
    while (this.waiting.length) {
      const w = this.waiting[0];
      const eol = buf.indexOf(10, pos);
      if (eol < 0) {
        this.need = buf.length - pos + 1;
        break;
      }
      const header = buf.toString('latin1', pos, eol);
      if (header.endsWith(' missing') || header.endsWith(' ambiguous')) pos = eol + 1;
      else {
        const [, type, size] = header.split(' ');
        const end = eol + 1 + Number(size);
        if (buf.length < end + 1) {
          this.need = end + 1 - pos;
          break;
        }
        w.res.set(w.names[w.next], { type, data: buf.subarray(eol + 1, end) });
        pos = end + 1;
      }
      if (++w.next === w.names.length) {
        this.waiting.shift();
        w.done(w.res);
      }
    }
    const rest = buf.subarray(pos);
    this.chunks = rest.length ? [rest] : [];
    this.length = rest.length;
    if (!this.waiting.length && this.proc) this.rest(this.proc);
  }

  /** Let node exit while nothing is being read, and end the process after a while. */
  private rest(p: ChildProcess) {
    p.unref();
    for (const s of [p.stdin, p.stdout, p.stderr]) (s as unknown as Handle).unref();
    clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      if (this.proc === p && !this.waiting.length) {
        this.proc = null;
        p.stdin!.end();
      }
    }, READER_IDLE_MS);
    this.idle.unref();
  }
}

export type PickResult = { tree: string } | { conflicts: string[] };

/**
 * Three-way tree merges without touching the index or working tree, served by one
 * long-lived `git merge-tree --stdin` process (a process per merge costs ~15ms).
 */
export class Merger {
  private cwd: string;
  private proc: ReturnType<typeof spawn> | null = null;
  private buf = '';
  private waiting: { done: (r: PickResult) => void; fail: (e: Error) => void }[] = [];
  private err = '';

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  private start() {
    const p = spawn('git', ['merge-tree', '--write-tree', '--stdin', '--name-only', '--no-messages'], { cwd: this.cwd });
    p.stdout!.setEncoding('latin1');
    p.stdout!.on('data', (d: string) => {
      this.buf += d;
      this.drain();
    });
    p.stderr!.on('data', (d: Buffer) => (this.err += d.toString('utf8')));
    p.stdin!.on('error', () => {});
    const die = () => {
      for (const w of this.waiting.splice(0)) w.fail(new GitError(`git merge-tree failed: ${this.err.trim()}`));
      this.proc = null;
    };
    p.on('error', die);
    p.on('close', die);
    this.proc = p;
  }

  /** Responses are `status\0tree\0(conflicted path\0)*\0`. */
  private drain() {
    for (;;) {
      const parts = this.buf.split('\0');
      // The last part is whatever follows the final NUL, so it isn't a complete token yet.
      const end = parts.indexOf('', 2);
      if (end < 0 || end >= parts.length - 1 || !this.waiting.length) return;
      const [status, tree, ...conflicts] = parts.slice(0, end);
      this.buf = parts.slice(end + 1).join('\0');
      this.waiting.shift()!.done(status === '1' ? { tree } : { conflicts });
    }
  }

  /** Apply the change `base -> pick` on top of `onto`. */
  pick(base: string, onto: string, pick: string): Promise<PickResult> {
    if (base === onto || onto === pick) return Promise.resolve({ tree: pick });
    if (base === pick) return Promise.resolve({ tree: onto });
    if (!this.proc) this.start();
    return new Promise((done, fail) => {
      this.waiting.push({ done, fail });
      this.proc!.stdin!.write(`${base} -- ${onto} ${pick}\n`);
    });
  }

  close() {
    this.proc?.stdin!.end();
  }
}
