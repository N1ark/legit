// Local HTTP server: JSON API, change notifications (SSE), and the UI.

import { watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileContent, summarize } from './diff.ts';
import { avatars } from './avatars.ts';
import {
  checkoutRemote, createBranch, deleteBranch, deleteRemoteBranch, deletedBranches, remoteBranches, renameBranch, restoreBranch,
} from './branches.ts';
import { stash, stashApply, stashDrop, stashPop, stashes } from './stash.ts';
import { discard, discarded, restoreDiscarded } from './discard.ts';
import { openInZed } from './editor.ts';
import { generatedPaths } from './generated.ts';
import { GitError } from './git.ts';
import { abortOp, conflictDiff, continueOp, fetchRemote, markResolved, mergeBranch, pull, rebaseBranch } from './sync.ts';
import type { CommitDiff, FileContents } from '../shared/types.ts';
import type { Repo } from './repo.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

export interface ServeOpts {
  port: number;
  /** Directory with the built UI. */
  dist: string;
  /** Vite dev middleware, when running in dev mode. */
  dev?: Middleware;
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

function send(res: ServerResponse, status: number, body: unknown) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(data);
}

export function serve(repo: Repo, opts: ServeOpts): Promise<{ url: string; close: () => void }> {
  const clients = new Set<ServerResponse>();
  const summaries = new Map<string, string>();

  // Tell the UI when refs or in-progress operations change (commits from a terminal, etc),
  // and, separately, when files or the index change (uncommitted changes).
  let timer: NodeJS.Timeout | undefined;
  const notify = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      for (const c of clients) c.write('data: change\n\n');
    }, 60);
  };
  // Throttled rather than debounced, so a file that keeps changing still shows up.
  let workTimer: NodeJS.Timeout | undefined;
  const notifyWork = () => {
    workTimer ??= setTimeout(() => {
      workTimer = undefined;
      for (const c of clients) c.write('data: work\n\n');
    }, 250);
  };
  const relevant = /^(HEAD|ORIG_HEAD|packed-refs|refs[\\/]|rebase-|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|BISECT_LOG)/;
  const dirs = [...new Set([repo.git.gitDir, repo.git.commonDir])];
  const watchers = dirs.map((d) =>
    watch(d, { recursive: true }, (_, f) => {
      const name = f?.toString() ?? '';
      if (name.endsWith('.lock')) return;
      if (relevant.test(name)) notify();
      else if (name === 'index') notifyWork();
    }),
  );
  watchers.push(
    watch(repo.git.root, { recursive: true }, (_, f) => {
      const name = f?.toString() ?? '';
      if (name !== '.git' && !name.startsWith('.git/') && !name.startsWith('.git\\')) notifyWork();
    }),
  );

  const ops: Record<string, (body: any) => Promise<unknown>> = {
    edit: (b) => repo.edit(b),
    split: (b) => repo.split(b),
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
    resolve: (b) => markResolved(repo, b),
    continue: () => continueOp(repo),
    abort: () => abortOp(repo),
    createBranch: (b) => createBranch(repo, b),
    renameBranch: (b) => renameBranch(repo, b),
    deleteBranch: (b) => deleteBranch(repo, b),
    deleteRemoteBranch: (b) => deleteRemoteBranch(repo, b),
    restoreBranch: (b) => restoreBranch(repo, b),
    checkoutRemote: (b) => checkoutRemote(repo, b),
    stash: () => stash(repo),
    stashApply: (b) => stashApply(repo, b),
    stashPop: (b) => stashPop(repo, b),
    stashDrop: (b) => stashDrop(repo, b),
    discard: (b) => discard(repo, b),
    restoreDiscarded: (b) => restoreDiscarded(repo, b),
  };

  let origin = '';

  /** A diff's summary as JSON, cached by key (commit SHAs and snapshot keys never change content). */
  async function summary(d: CommitDiff): Promise<string> {
    let json = summaries.get(d.sha);
    if (!json) {
      const work = /^w\d+$/.test(d.sha);
      const generated = await generatedPaths(repo.git, work ? null : d.sha.replace(/^s/, ''), d.files.map((f) => f.path));
      json = JSON.stringify(summarize(d, generated));
      if (summaries.size > 100) summaries.delete(summaries.keys().next().value!);
      summaries.set(d.sha, json);
    }
    return json;
  }

  async function api(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams) {
    if (path === '/api/state') return send(res, 200, await repo.state());
    if (path === '/api/backups') return send(res, 200, await repo.backups());
    if (path === '/api/discarded') return send(res, 200, await discarded(repo.git));
    if (path === '/api/branches') return send(res, 200, await repo.branches());
    if (path === '/api/branches/remote') return send(res, 200, await remoteBranches(repo));
    if (path === '/api/branches/deleted') return send(res, 200, await deletedBranches(repo));
    if (path === '/api/stashes') return send(res, 200, await stashes(repo.git));
    if (path === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': hi\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (path === '/api/avatars' && req.method === 'POST') {
      if (req.headers['x-legit'] !== '1') return send(res, 403, { error: 'Forbidden' });
      const { emails } = await readBody(req);
      return send(res, 200, await avatars(repo.git, Array.isArray(emails) ? emails.slice(0, 2000) : []));
    }
    if (path === '/api/work') {
      const { staged, unstaged } = await repo.work();
      return send(res, 200, `{"staged":${await summary(staged)},"unstaged":${await summary(unstaged)}}`);
    }
    if (path === '/api/conflict') return send(res, 200, await summary(await conflictDiff(repo)));
    const older = /^\/api\/older\/([0-9a-f]{40,64})$/.exec(path);
    if (older) return send(res, 200, await repo.older(older[1]));
    const merged = /^\/api\/merged\/([0-9a-f]{40,64})$/.exec(path);
    if (merged) return send(res, 200, await repo.merged(merged[1]));
    const diff = /^\/api\/diff\/(s?[0-9a-f]{40,64}|w\d+)$/.exec(path);
    if (diff) return send(res, 200, await summary(await repo.diff(diff[1])));
    // /api/diff/<sha>/files?i=0,1,2: contents of some files, loaded as they scroll into view.
    const files = /^\/api\/diff\/(s?[0-9a-f]{40,64}|w\d+)\/files$/.exec(path);
    if (files) {
      const d = await repo.diff(files[1]);
      const out: FileContents = {};
      for (const i of (query.get('i') ?? '').split(',').map(Number)) {
        if (Number.isInteger(i) && d.files[i]) out[i] = fileContent(d.files[i]);
      }
      return send(res, 200, out);
    }
    if (path === '/api/open' && req.method === 'POST') {
      if (req.headers['x-legit'] !== '1') return send(res, 403, { error: 'Forbidden' });
      const { path: file, line } = await readBody(req);
      if (typeof file !== 'string') return send(res, 400, { error: 'Missing path' });
      await openInZed(repo.git.root, file, typeof line === 'number' ? line : undefined);
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
    try {
      if (path.startsWith('/api/')) await api(req, res, path, url.searchParams);
      else if (opts.dev) opts.dev(req, res, () => send(res, 404, { error: 'Not found' }));
      else await staticFile(res, path);
    } catch (e) {
      const known = e instanceof GitError;
      if (!known) console.error(e);
      send(res, known ? 409 : 500, { error: e instanceof Error ? e.message : String(e) });
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
          watchers.forEach((w) => w.close());
          for (const c of clients) c.end();
          server.close();
        },
      });
    });
  });
}
