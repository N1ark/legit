import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { onProgress, parseProgress } from '../src/server/progress.ts';
import { fetchRemote } from '../src/server/sync.ts';
import { Repo } from '../src/server/repo.ts';
import type { Progress } from '../src/shared/types.ts';

test("git's progress lines: phase, percentage, and amount and speed or count", () => {
  assert.deepEqual(parseProgress('Receiving objects:  41% (5/12), 3.11 MiB | 590.00 KiB/s'), {
    phase: 'Receiving objects', server: false, percent: 41, detail: '3.11 MiB | 590.00 KiB/s',
  });
  assert.deepEqual(parseProgress('Receiving objects: 100% (12/12), 5.73 MiB | 585.00 KiB/s, done.'), {
    phase: 'Receiving objects', server: false, percent: 100, detail: '5.73 MiB | 585.00 KiB/s',
  });
  assert.deepEqual(parseProgress('remote: Counting objects:  23% (3/13)        '), {
    phase: 'Counting objects', server: true, percent: 23, detail: '3/13',
  });
  assert.deepEqual(parseProgress('remote: Enumerating objects: 13, done.'), {
    phase: 'Enumerating objects', server: true, percent: null, detail: '13',
  });
  assert.deepEqual(parseProgress('Writing objects:  50% (2/4)'), { phase: 'Writing objects', server: false, percent: 50, detail: '2/4' });
  assert.equal(parseProgress('remote: Total 12 (delta 7), reused 0 (delta 0), pack-reused 0'), null);
  assert.equal(parseProgress('From /tmp/remote'), null);
  assert.equal(parseProgress('   0d56bda..8848923  main       -> origin/main'), null);
});

test('a fetch reports its progress, per remote, then that it finished', async () => {
  const base = mkdtempSync(join(tmpdir(), 'legit-progress-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@x.org', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@x.org', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' });
  const remote = join(base, 'remote');
  const dir = join(base, 'work');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(base, 'clone', '-q', remote, dir);
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'base');
  git(dir, 'push', '-q', 'origin', 'main');
  // More objects than fetch.unpackLimit, so the receiving side reports them.
  const other = join(base, 'other');
  git(base, 'clone', '-q', remote, other);
  for (let i = 0; i < 120; i++) writeFileSync(join(other, `f${i}`), `${i}\n`.repeat(50));
  git(other, 'add', '-A');
  git(other, 'commit', '-qm', 'many');
  git(other, 'push', '-q', 'origin', 'main');

  const seen: Progress[] = [];
  const stop = onProgress((root, p) => root === dir && seen.push(p));
  try {
    const repo = await Repo.open(dir);
    await fetchRemote(repo);
    assert.ok(seen.every((p) => p.op === 'fetch' && p.remote === 'origin'));
    assert.ok(seen.some((p) => p.phase === 'Receiving objects' && !p.server && p.percent === 100), JSON.stringify(seen));
    assert.ok(seen.some((p) => p.server));
    assert.equal(seen.at(-1)?.phase, null);

    // And a push, its writing side.
    seen.length = 0;
    git(dir, 'merge', '-q', '--ff-only', 'origin/main');
    writeFileSync(join(dir, 'mine'), 'x\n'.repeat(1000));
    git(dir, 'add', 'mine');
    git(dir, 'commit', '-qm', 'mine');
    await repo.push({});
    assert.ok(seen.some((p) => p.op === 'push' && p.phase === 'Writing objects' && p.percent === 100), JSON.stringify(seen));
    assert.equal(seen.at(-1)?.phase, null);
  } finally {
    stop();
    rmSync(base, { recursive: true, force: true });
  }
});
