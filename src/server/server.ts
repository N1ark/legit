// Local HTTP server: JSON API, change notifications (SSE), and the UI.

import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { fileBytes, fileContent, fileSizes, oldLines, summarize } from './diff.ts';
import { imageType } from '../shared/files.ts';
import { avatars } from './avatars.ts';
import './gh/mock/index.ts';
import { githubRoute, warmGithub } from './gh/routes.ts';
import {
  checkoutRemote, createBranch, deleteBranch, deleteRemoteBranch, deletedBranches, remoteBranches, renameBranch, restoreBranch,
  deleteBranches, deleteRemoteBranches, remotes, setUpstream, unsetUpstream,
} from './branches.ts';
import { stash, stashApply, stashDrop, stashPop, stashes } from './stash.ts';
import { discard, discarded, restoreDiscarded } from './discard.ts';
import { cancelEdit, editChanges, finishEdit, startEdit } from './edit.ts';
import { displaySettings, globalSettingsFile, effectiveSettings, readSettings, repoSettingsFile, saveSettings } from './settings.ts';
import { grammarFiles, grammarProblems, syntaxes, zedGrammars } from './syntax.ts';
import { openInZed, openUrl } from './editor.ts';
import { generatedPaths } from './generated.ts';
import { type Git, GitError } from './git.ts';
import { log, logText } from './log.ts';
import { branchCommits, cherryPick, copyTo } from './pick.ts';
import { onProgress } from './progress.ts';
import { watchTree } from './watch.ts';
import {
  abortOp, conflictDiff, continueOp, fetchRemote, markResolved, mergeBranch, pull, rebaseBranch, rebuildBranch, rebuildPlan,
} from './sync.ts';
import { addWorktree, findWorktree, removeWorktree, worktrees } from './worktrees.ts';
import type { CommitDiff, FileContents, SettingsInfo } from '../shared/types.ts';
import type { Repo } from './repo.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  // web-tree-sitter compiles its runtime while it downloads only when served as this; otherwise it fetches it again.
  '.wasm': 'application/wasm',
};

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

export interface ServeOpts {
  port: number;
  /** Directory with the built UI. */
  dist: string;
  /** Vite dev middleware, when running in dev mode. */
  dev?: Middleware;
  /** Serve another worktree of the repository, returning its URL (the browser version; the app switches its window itself). */
  open?: (path: string) => Promise<string>;
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        done(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (e) {
        fail(e);
      }
    });
    req.on('error', fail);
  });
}

/** `etag`: the body never changes under it, so the page may keep it and ask again with the tag (see `unchanged`). */
function send(res: ServerResponse, status: number, body: unknown, etag?: string) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...(etag ? { 'cache-control': 'private, no-cache', etag } : { 'cache-control': 'no-store' }) });
  res.end(data);
}

/** The page already has the response tagged `etag`: tell it so (304), and it shows its own copy. */
function unchanged(req: IncomingMessage, res: ServerResponse, etag: string | undefined): boolean {
  if (!etag || req.headers['if-none-match'] !== etag) return false;
  res.writeHead(304, { 'cache-control': 'private, no-cache', etag });
  res.end();
  return true;
}

/** Diff keys (see `Repo.diff`): a commit, a stash, a working-tree snapshot, or a squash's result. */
const KEY = String.raw`(s?[0-9a-f]{40,64}|w\d+|q[0-9a-f]{40,64}(?:[-.][0-9a-f]{40,64})*)`;
const DIFF = new RegExp(`^/api/diff/${KEY}$`);
const DIFF_FILES = new RegExp(`^/api/diff/${KEY}/files$`);
const DIFF_OLD = new RegExp(`^/api/diff/${KEY}/old$`);
const DIFF_IMAGE = new RegExp(`^/api/diff/${KEY}/image$`);
const DIFF_TEXT = new RegExp(`^/api/diff/${KEY}/text$`);
/** Files bigger than this aren't rendered. */
const MAX_TEXT = 5 * 1024 * 1024;
/** A diff key whose content never changes (a commit's, a stash's or a squash's), unlike a working-tree snapshot's. */
const fixedKey = (key: string) => !/^w\d+$/.test(key);
/** Images bigger than this aren't shown. */
const MAX_IMAGE = 50 * 1024 * 1024;
/** Summaries kept, and how much of their JSON in all. */
const MAX_SUMMARIES = 100;
const MAX_SUMMARY_BYTES = 16 * 1024 * 1024;

/** Most changed paths checked for being ignored at once; past that, a change is just assumed to count. */
const MAX_CHECKED = 2000;

/** Every path (relative to the root) is ignored by git, and isn't tracked. Asks a fresh git, so it knows the current rules. */
async function allIgnored(git: Git, paths: string[]): Promise<boolean> {
  if (!paths.length) return true;
  const r = await git
    .run(['check-ignore', '-z', '--stdin'], { input: paths.join('\0') + '\0', env: { GIT_OPTIONAL_LOCKS: '0' }, allowFail: true })
    .catch(() => null);
  if (r?.code !== 0) return false;
  const ignored = new Set(r.out.toString('utf8').split('\0'));
  return paths.every((p) => ignored.has(p));
}

export function serve(repo: Repo, opts: ServeOpts): Promise<{ url: string; close: () => void }> {
  warmGithub(repo);
  const clients = new Set<ServerResponse>();
  /** Summaries' JSON by settings and key, least recently used first. */
  const summaries = new Map<string, string>();
  let summaryBytes = 0;
  // Tags what never changes on this server (its diffs, under the same settings), so a page reloaded on it, as
  // the app's is on coming back to its repo, keeps what it loaded. Another server, or version, has another.
  const boot = randomBytes(8).toString('hex');

  // Tell the UI when refs or in-progress operations change (commits from a terminal, etc),
  // and, separately, when files or the index change (uncommitted changes).
  let timer: NodeJS.Timeout | undefined;
  const notify = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      for (const c of clients) c.write('data: change\n\n');
    }, 60);
  };
  // Throttled rather than debounced, so a file that keeps changing still shows up. Changes only
  // to ignored files (build output, node_modules) can't change what's uncommitted, so they don't count.
  let workTimer: NodeJS.Timeout | undefined;
  let changed = new Set<string>();
  let anyChange = false;
  const notifyWork = (path?: string) => {
    if (path === undefined || changed.size >= MAX_CHECKED) anyChange = true;
    else changed.add(path);
    workTimer ??= setTimeout(async () => {
      workTimer = undefined;
      const [paths, any] = [[...changed], anyChange];
      [changed, anyChange] = [new Set(), false];
      if (!clients.size) return;
      if (any || !(await allIgnored(repo.git, paths))) for (const c of clients) c.write('data: work\n\n');
    }, 250);
  };
  // Fetches and pushes say how far they've got, as a `progress` event.
  const stopProgress = onProgress((root, p) => {
    if (root !== repo.git.root) return;
    for (const c of clients) c.write(`event: progress\ndata: ${JSON.stringify(p)}\n\n`);
  });
  // Out of watches (too many folders for the system's limit): the page is told to look again whenever it's focused.
  let blind = false;
  const lost = (e: Error) => {
    if (!blind) log(`Changes made outside legit won't show until the window is focused: ${e.message}`);
    blind = true;
    for (const c of clients) c.write('data: blind\n\n');
  };
  const relevant = /^(HEAD|ORIG_HEAD|packed-refs|refs[\\/]|rebase-|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|BISECT_LOG)/;
  const dirs = [...new Set([repo.git.gitDir, repo.git.commonDir])];
  const watchers = dirs.map((d) =>
    watchTree(
      d,
      (rel) => /^(refs|rebase-merge|rebase-apply)(\/|$)/.test(rel),
      (name = '') => {
        if (name.endsWith('.lock')) return;
        if (relevant.test(name)) notify();
        else if (name === 'index') notifyWork(undefined);
      },
      lost,
    ),
  );
  watchers.push(
    watchTree(
      repo.git.root,
      (rel) => rel !== '.git',
      (name) => {
        if (name === '.git' || name?.startsWith('.git/') || name?.startsWith('.git\\')) return;
        notifyWork(name && sep === '/' ? name : undefined);
      },
      lost,
    ),
  );

  const ops: Record<string, (body: any) => Promise<unknown>> = {
    edit: (b) => repo.edit(b),
    split: (b) => repo.split(b),
    removeChanges: (b) => repo.removeChanges(b),
    editLine: (b) => repo.editLine(b),
    squash: (b) => repo.squash(b),
    reorder: (b) => repo.reorder(b),
    drop: (b) => repo.drop(b),
    undo: () => repo.undo(),
    redo: () => repo.redo(),
    restore: (b) => repo.restore(b),
    switch: (b) => repo.switchBranch(b),
    push: (b) => repo.push(b),
    stage: (b) => repo.stage(b),
    unstage: (b) => repo.unstage(b),
    commit: (b) => repo.commit(b),
    uncommit: () => repo.uncommit(),
    fetch: () => fetchRemote(repo),
    pull: (b) => pull(repo, b),
    merge: (b) => mergeBranch(repo, b),
    rebase: (b) => rebaseBranch(repo, b),
    rebuild: (b) => rebuildBranch(repo, b),
    cherryPick: (b) => cherryPick(repo, b),
    copyTo: (b) => copyTo(repo, b),
    resolve: (b) => markResolved(repo, b),
    continue: () => continueOp(repo),
    abort: () => abortOp(repo),
    editStart: (b) => startEdit(repo, b),
    editFinish: () => finishEdit(repo),
    editCancel: () => cancelEdit(repo),
    createBranch: (b) => createBranch(repo, b),
    renameBranch: (b) => renameBranch(repo, b),
    deleteBranch: (b) => deleteBranch(repo, b),
    deleteRemoteBranch: (b) => deleteRemoteBranch(repo, b),
    deleteBranches: (b) => deleteBranches(repo, b),
    deleteRemoteBranches: (b) => deleteRemoteBranches(repo, b),
    restoreBranch: (b) => restoreBranch(repo, b),
    checkoutRemote: (b) => checkoutRemote(repo, b),
    setUpstream: (b) => setUpstream(repo, b),
    unsetUpstream: (b) => unsetUpstream(repo, b),
    addWorktree: (b) => addWorktree(repo, b),
    removeWorktree: (b) => removeWorktree(repo, b),
    openWorktree: async (b) => {
      if (!opts.open) throw new GitError('Switching worktree is done by the app here.');
      return { url: await opts.open((await findWorktree(repo, b.path)).path) };
    },
    stash: () => stash(repo),
    stashApply: (b) => stashApply(repo, b),
    stashPop: (b) => stashPop(repo, b),
    stashDrop: (b) => stashDrop(repo, b),
    discard: (b) => discard(repo, b),
    restoreDiscarded: (b) => restoreDiscarded(repo, b),
    // Diffs' summaries say which files are collapsed and how they're highlighted: work them out again.
    saveSettings: async (b) => {
      const s = await saveSettings(repo.git, b);
      summaries.clear();
      summaryBytes = 0;
      return s;
    },
  };

  let origin = '';

  /**
   * The settings summaries depend on, and a tag for them. Read each time (it's quick), so settings
   * changed elsewhere (by hand, or on another repo's server for all repos) apply here too.
   */
  async function summarySettings() {
    const settings = await effectiveSettings(repo.git);
    return { settings, tag: createHash('sha1').update(JSON.stringify(settings)).digest('hex').slice(0, 16) };
  }

  /** A diff's summary as JSON, cached by key and settings (commit SHAs and snapshot keys never change content). */
  async function summary(d: CommitDiff, current?: Awaited<ReturnType<typeof summarySettings>>): Promise<string> {
    const { settings, tag } = current ?? (await summarySettings());
    const key = `${tag}:${d.sha}`;
    let json = summaries.get(key);
    if (json) {
      summaries.delete(key);
      summaries.set(key, json);
      return json;
    }
    const work = /^w\d+$/.test(d.sha);
    const paths = d.files.map((f) => f.path);
    // A squash's attributes are its newest commit's.
    const source = work ? null : d.sha.replace(/^[sq]/, '').split(/[-.]/)[0];
    const [generated, sizes] = await Promise.all([generatedPaths(repo.git, source, paths, settings.collapse), fileSizes(repo.git, d)]);
    const s = summarize(d, generated, syntaxes(settings.syntax, paths));
    for (const [k, size] of sizes) Object.assign(s.files[k], size);
    // A snapshot's key changes with any file: the UI keeps what it loaded of the others by their tokens.
    if (work) s.files.forEach((f, k) => (f.token = d.files[k].token));
    json = JSON.stringify(s);
    if (summaries.has(key)) return json;
    summaries.set(key, json);
    summaryBytes += json.length;
    for (const [k, v] of summaries) {
      if (summaries.size <= MAX_SUMMARIES && summaryBytes <= MAX_SUMMARY_BYTES) break;
      if (k === key) continue;
      summaries.delete(k);
      summaryBytes -= v.length;
    }
    return json;
  }

  async function api(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams) {
    if (path === '/api/state') return send(res, 200, await repo.state());
    if (path === '/api/logs') return send(res, 200, JSON.stringify(logText()));
    if (path === '/api/backups') return send(res, 200, await repo.backups());
    if (path === '/api/discarded') return send(res, 200, await discarded(repo.git));
    if (path === '/api/branches') return send(res, 200, await repo.branches());
    if (path === '/api/branches/remote') return send(res, 200, await remoteBranches(repo, query.get('all') === '1'));
    if (path === '/api/branches/commits') return send(res, 200, await branchCommits(repo, query.get('branch') ?? ''));
    if (path === '/api/branches/deleted') return send(res, 200, await deletedBranches(repo));
    if (path === '/api/rebuild/plan') {
      return send(res, 200, await rebuildPlan(repo, { branch: query.get('branch'), shas: (query.get('shas') ?? '').split(',').filter(Boolean) }));
    }
    if (path === '/api/remotes') return send(res, 200, await remotes(repo));
    if (path === '/api/worktrees') return send(res, 200, await worktrees(repo));
    if (path === '/api/stashes') return send(res, 200, await stashes(repo.git));
    if (path === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(blind ? 'data: blind\n\n' : ': hi\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (path === '/api/avatars' && req.method === 'POST') {
      if (req.headers['x-legit'] !== '1') return send(res, 403, { error: 'Forbidden' });
      const { emails } = await readBody(req);
      return send(res, 200, await avatars(repo.git, Array.isArray(emails) ? emails.slice(0, 2000) : []));
    }
    // /api/gh/<name>: GitHub, through server/gh/routes.ts.
    const gh = /^\/api\/gh\/(\w+)$/.exec(path)?.[1];
    if (gh) {
      if (req.method === 'POST' && req.headers['x-legit'] !== '1') return send(res, 403, { error: 'Forbidden' });
      return send(res, 200, (await githubRoute(repo, req.method ?? 'GET', gh, req.method === 'POST' ? await readBody(req) : query)) ?? null);
    }
    if (path === '/api/work') {
      const changes = await repo.work();
      // The same diff with only what's staged changed keeps its id, so the UI keeps its view of it.
      const content = createHash('sha1').update(changes.files.map((f) => `${f.path}\0${f.token}`).join('\0')).digest('hex');
      return send(res, 200, `{"changes":${await summary(changes)},"content":"${content}"}`);
    }
    if (path === '/api/conflict') return send(res, 200, await summary(await conflictDiff(repo)));
    if (path === '/api/editing') return send(res, 200, await summary(await editChanges(repo, query.get('whole') === '1')));
    if (path === '/api/locate') return send(res, 200, await repo.locate(query.get('rev') ?? ''));
    const older = /^\/api\/older\/([0-9a-f]{40,64})$/.exec(path);
    if (older) return send(res, 200, await repo.older(older[1], query.get('pushed') === '1'));
    const merged = /^\/api\/merged\/([0-9a-f]{40,64})$/.exec(path);
    if (merged) return send(res, 200, await repo.merged(merged[1]));
    const diff = DIFF.exec(path);
    if (diff) {
      const current = await summarySettings();
      // Then the summary changes only with the settings.
      const etag = fixedKey(diff[1]) ? `"${boot}.${current.tag}"` : undefined;
      if (unchanged(req, res, etag)) return;
      return send(res, 200, await summary(await repo.diff(diff[1]), current), etag);
    }
    // /api/diff/<sha>/files?i=0,1,2: contents of some files, loaded as they scroll into view.
    const files = DIFF_FILES.exec(path);
    if (files) {
      const etag = fixedKey(files[1]) ? `"${boot}"` : undefined;
      if (unchanged(req, res, etag)) return;
      const d = await repo.diff(files[1]);
      const out: FileContents = {};
      for (const i of (query.get('i') ?? '').split(',').map(Number)) {
        if (Number.isInteger(i) && d.files[i]) out[i] = fileContent(d.files[i]);
      }
      return send(res, 200, out, etag);
    }
    // /api/diff/<sha>/old?i=3: a modified file's old version, to show the lines between its hunks.
    const old = DIFF_OLD.exec(path);
    if (old) {
      const etag = fixedKey(old[1]) ? `"${boot}"` : undefined;
      if (unchanged(req, res, etag)) return;
      const f = (await repo.diff(old[1])).files[Number(query.get('i'))];
      if (!f) return send(res, 404, { error: 'Not found' });
      return send(res, 200, await oldLines(repo.git, f), etag);
    }
    // /api/diff/<sha>/text?i=3&side=new: a file's whole text as it was or is, to show it rendered.
    const whole = DIFF_TEXT.exec(path);
    if (whole) {
      const side = query.get('side') === 'old' ? 'old' : 'new';
      const etag = fixedKey(whole[1]) ? `"${boot}"` : undefined;
      if (unchanged(req, res, etag)) return;
      const f = (await repo.diff(whole[1])).files[Number(query.get('i'))];
      const data = f && !f.binary ? await fileBytes(repo.git, f, side) : null;
      if (!data) return send(res, 404, { error: 'Not found' });
      if (data.length > MAX_TEXT) return send(res, 413, { error: 'Too big to render' });
      return send(res, 200, { text: data.toString('utf8') }, etag);
    }
    // /api/diff/<sha>/image?i=3&side=old: an image file as it was or is, for an <img> of this page only.
    const image = DIFF_IMAGE.exec(path);
    if (image) {
      const site = req.headers['sec-fetch-site'];
      if (site && site !== 'same-origin' && site !== 'none') return send(res, 403, { error: 'Forbidden' });
      const f = (await repo.diff(image[1])).files[Number(query.get('i'))];
      const type = f && imageType(f.path);
      if (!type) return send(res, 404, { error: 'Not found' });
      const data = await fileBytes(repo.git, f, query.get('side') === 'old' ? 'old' : 'new');
      if (!data) return send(res, 404, { error: 'Not found' });
      if (data.length > MAX_IMAGE) return send(res, 413, { error: 'Too big to show' });
      res.writeHead(200, {
        'content-type': type,
        // Commits and stashes never change; working-tree snapshots' files might.
        'cache-control': /^w\d+$/.test(image[1]) ? 'no-store' : 'private, max-age=3600',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
        // An SVG opened on its own runs no script and loads nothing.
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      });
      return res.end(data);
    }
    if (path === '/api/display') return send(res, 200, displaySettings(await readSettings(repo.git)));
    if (path === '/api/settings') {
      const s = await readSettings(repo.git);
      const [grammars, problems] = await Promise.all([
        zedGrammars(),
        grammarProblems(repo.git, [...s.global.syntax, ...s.repo.syntax]),
      ]);
      const info: SettingsInfo = { ...s, files: { repo: repoSettingsFile(repo.git), global: globalSettingsFile() }, grammars, problems };
      return send(res, 200, info);
    }
    // /api/grammar?name=ullbc&part=wasm|highlights: a grammar the syntax highlighting rules use.
    if (path === '/api/grammar') {
      const g = await grammarFiles(repo.git, (await effectiveSettings(repo.git)).syntax, query.get('name') ?? '');
      if (query.get('part') === 'wasm') {
        res.writeHead(200, { 'content-type': 'application/wasm', 'cache-control': 'no-store' });
        return res.end(g.wasm);
      }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(g.highlights);
    }
    if (path === '/api/open' && req.method === 'POST') {
      if (req.headers['x-legit'] !== '1') return send(res, 403, { error: 'Forbidden' });
      const { path: file, line } = await readBody(req);
      if (typeof file !== 'string') return send(res, 400, { error: 'Missing path' });
      await openInZed(repo.git.root, file, typeof line === 'number' ? line : undefined);
      return send(res, 200, {});
    }
    if (path === '/api/open-url' && req.method === 'POST') {
      if (req.headers['x-legit'] !== '1') return send(res, 403, { error: 'Forbidden' });
      const { url: link } = await readBody(req);
      if (typeof link !== 'string') return send(res, 400, { error: 'Missing url' });
      await openUrl(link);
      return send(res, 200, {});
    }
    const op = /^\/api\/(\w+)$/.exec(path)?.[1];
    if (op && ops[op] && req.method === 'POST') {
      // A custom header can't be sent cross-origin without a CORS preflight, which we never grant.
      if (req.headers['x-legit'] !== '1') return send(res, 403, { error: 'Forbidden' });
      return send(res, 200, await ops[op](await readBody(req)));
    }
    send(res, 404, { error: 'Not found' });
  }

  async function staticFile(res: ServerResponse, path: string) {
    const file = normalize(join(opts.dist, path === '/' ? 'index.html' : path));
    if (!file.startsWith(opts.dist)) return send(res, 404, { error: 'Not found' });
    try {
      const data = await readFile(file);
      const immutable = path.startsWith('/assets/');
      res.writeHead(200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
      res.end(data);
    } catch {
      send(res, 404, { error: 'Not found' });
    }
  }

  const server = createServer(async (req, res) => {
    // Only answer requests addressed to us (guards against DNS rebinding).
    if (req.headers.host !== origin) return send(res, 403, { error: 'Forbidden' });
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    if (path === '/') warmGithub(repo);
    try {
      if (path.startsWith('/api/')) await api(req, res, path, url.searchParams);
      else if (opts.dev) opts.dev(req, res, () => send(res, 404, { error: 'Not found' }));
      else await staticFile(res, path);
    } catch (e) {
      const known = e instanceof GitError;
      log(`${req.method} ${path}${url.search}:`, known ? e.message : e);
      send(res, known ? 409 : 500, { error: e instanceof Error ? e.message : String(e), ...(known && e.code ? { code: e.code } : {}) });
    }
  });

  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(opts.port, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      origin = `127.0.0.1:${port}`;
      done({
        url: `http://${origin}/`,
        close: () => {
          watchers.forEach((stop) => stop());
          stopProgress();
          for (const c of clients) c.end();
          server.close();
        },
      });
    });
  });
}
