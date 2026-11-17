import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { GitError, run } from '../src/server/git.ts';
import { Repo } from '../src/server/repo.ts';
import { serve } from '../src/server/server.ts';
import type { RepoGone } from '../src/shared/types.ts';
import { setup } from './util.ts';

const t = setup();

// The worktrees go next to the repo, so each test's repo gets a folder of its own.
beforeEach(() => {
  t.dir = join(t.tmp(), 'main');
  mkdirSync(t.dir);
  t.git('init', '-q', '-b', 'main');
  t.commit('one', { f: '1\n' });
});

const unhandled: unknown[] = [];
const onUnhandled = (e: unknown) => unhandled.push(e);
process.on('unhandledRejection', onUnhandled);
after(() => {
  process.off('unhandledRejection', onUnhandled);
  assert.deepEqual(unhandled, [], 'nothing went unhandled');
});

/** A page's view of the server: the events it's sent (`gone`'s with its data), until `close()`. */
async function page(url: string) {
  const ctrl = new AbortController();
  const res = await fetch(new URL('/api/events', url), { signal: ctrl.signal });
  const events: { event: string; data: string }[] = [];
  const reading = (async () => {
    let text = '';
    for await (const chunk of res.body!) {
      text += Buffer.from(chunk).toString();
      for (let end = text.indexOf('\n\n'); end >= 0; end = text.indexOf('\n\n')) {
        const block = text.slice(0, end);
        text = text.slice(end + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message';
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (data !== undefined) events.push({ event, data });
      }
    }
  })().catch(() => {});
  return {
    events,
    gone: async (ms = 5000): Promise<RepoGone> => {
      for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) {
        const e = events.find((x) => x.event === 'gone');
        if (e) return JSON.parse(e.data);
      }
      throw new Error(`no gone event; got ${JSON.stringify(events)}`);
    },
    close: async () => {
      ctrl.abort();
      await reading;
    },
  };
}

async function serveAt(path: string, opts: { open?: (p: string) => Promise<string> } = {}) {
  let left = 0;
  const s = await serve(await Repo.open(path), { port: 0, dist: t.tmp(), ...opts, onGone: () => left++ });
  return { ...s, left: () => left };
}

const get = async (url: string, path: string) => {
  const res = await fetch(new URL(path, url));
  return { status: res.status, body: await res.json() };
};

for (const [how, remove] of [
  ['deleted', (wt: string) => rmSync(wt, { recursive: true, force: true })],
  ['removed with git worktree remove', (wt: string) => t.git('worktree', 'remove', '--force', wt)],
  ['moved', (wt: string) => renameSync(wt, `${wt}-moved`)],
] as const) {
  test(`a worktree ${how} under the server: the page is told to go to the main worktree, and every request says it's gone`, async () => {
    const wt = join(t.dir, '..', 'wt');
    t.git('worktree', 'add', '-q', '-b', 'b', wt);
    const s = await serveAt(wt);
    const p = await page(s.url);
    try {
      await sleep(200);
      remove(wt);
      const g = await p.gone();
      assert.equal(g.code, 'repo-gone');
      assert.equal(g.to, realpathSync(t.dir));
      assert.match(g.error, /^wt is gone/);
      for (const path of ['/api/state', '/api/work', '/api/branches', '/api/worktrees', '/api/stashes']) {
        const r = await get(s.url, path);
        assert.equal(r.status, 410, path);
        assert.equal(r.body.code, 'repo-gone', path);
        assert.equal(r.body.to, g.to, path);
      }
      // A page that connects now is told at once.
      const late = await page(s.url);
      assert.equal((await late.gone(1000)).to, g.to);
      await late.close();
      // Only once every page has left (gone elsewhere) is the server done.
      if (how === 'deleted') {
        await sleep(2300);
        assert.equal(s.left(), 0);
        await p.close();
        await sleep(2300);
        assert.equal(s.left(), 1);
      }
    } finally {
      await p.close();
      s.close();
    }
  });
}

test("a worktree whose git dir is pruned while its folder stays is gone too; the browser version's page is given the main worktree's URL", async () => {
  const wt = join(t.dir, '..', 'wt');
  t.git('worktree', 'add', '-q', '-b', 'b', wt);
  const opened: string[] = [];
  const s = await serveAt(wt, { open: async (path) => (opened.push(path), 'http://127.0.0.1:1/') });
  const p = await page(s.url);
  try {
    await sleep(200);
    rmSync(join(t.dir, '.git', 'worktrees', 'wt'), { recursive: true });
    const g = await p.gone();
    assert.deepEqual([g.to, g.url], [realpathSync(t.dir), 'http://127.0.0.1:1/']);
    assert.deepEqual(opened, [realpathSync(t.dir)]);
  } finally {
    await p.close();
    s.close();
  }
});

test('a worktree moved with git worktree move: the page follows it, with the main worktree to fall back on', async () => {
  const wt = join(t.dir, '..', 'wt');
  t.git('worktree', 'add', '-q', '-b', 'b', wt);
  t.git('worktree', 'add', '-q', '-b', 'c', join(t.dir, '..', 'other'));
  const s = await serveAt(wt);
  const p = await page(s.url);
  try {
    await sleep(200);
    t.git('worktree', 'move', wt, join(t.dir, '..', 'moved'));
    const g = await p.gone();
    assert.deepEqual([g.to, ...g.or], [join(t.dir, '..', 'moved'), t.dir, join(t.dir, '..', 'other')].map((x) => realpathSync(x)));
  } finally {
    await p.close();
    s.close();
  }
});

test('the whole repository deleted: gone, with nowhere to go', async () => {
  const s = await serveAt(t.dir);
  const p = await page(s.url);
  try {
    await sleep(200);
    rmSync(t.dir, { recursive: true, force: true });
    const g = await p.gone();
    assert.equal(g.to, null);
    assert.equal((await get(s.url, '/api/state')).status, 410);
  } finally {
    await p.close();
    s.close();
  }
});

test("with the main worktree gone too, another worktree that's still there is the way out", async () => {
  // A bare repository with worktrees: none of them is the main one.
  const bare = join(t.dir, '..', 'repo.git');
  t.git('clone', '-q', '--bare', t.dir, bare);
  const a = join(t.dir, '..', 'a');
  const b = join(t.dir, '..', 'b');
  t.gitIn(bare, 'worktree', 'add', '-q', '-b', 'a', a);
  t.gitIn(bare, 'worktree', 'add', '-q', '-b', 'b', b);
  const s = await serveAt(a);
  const p = await page(s.url);
  try {
    await sleep(200);
    rmSync(a, { recursive: true, force: true });
    assert.equal((await p.gone()).to, realpathSync(b));
  } finally {
    await p.close();
    s.close();
  }
});

test('found gone by a request, with no page on it: the server is done once it knows', async () => {
  const wt = join(t.dir, '..', 'wt');
  t.git('worktree', 'add', '-q', '-b', 'b', wt);
  const s = await serveAt(wt);
  try {
    rmSync(wt, { recursive: true, force: true });
    const r = await get(s.url, '/api/state');
    assert.equal(r.status, 410);
    assert.equal(r.body.to, realpathSync(t.dir));
    await sleep(2300);
    assert.equal(s.left(), 1);
  } finally {
    s.close();
  }
});

test("git says plainly when another git holds the index's lock, or the folder it runs in is gone", async () => {
  writeFileSync(join(t.dir, '.git', 'index.lock'), '');
  t.write('f', '2\n');
  const locked = await run(t.dir, ['add', 'f']).catch((e) => e);
  assert.ok(locked instanceof GitError);
  assert.equal(locked.code, 'locked');
  assert.match(locked.message, /^Another git process is running in this repository \(it holds .*index\.lock\)/);
  rmSync(join(t.dir, '.git', 'index.lock'));
  await run(t.dir, ['add', 'f']);

  const gone = join(t.dir, 'sub');
  mkdirSync(gone);
  const repo = await Repo.open(gone);
  rmSync(t.dir, { recursive: true, force: true });
  assert.ok(repo.gone());
  const e = await run(gone, ['status']).catch((x) => x);
  assert.ok(e instanceof GitError);
  assert.equal(e.code, 'repo-gone');
  assert.doesNotMatch(e.message, /ENOENT/);
});
