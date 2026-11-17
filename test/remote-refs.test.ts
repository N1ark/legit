import assert from 'node:assert/strict';
import { readdirSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Repo } from '../src/server/repo.ts';
import { setup } from './util.ts';

const t = setup();

/** Make packed-refs and refs/remotes look as if they last changed a while ago (`s` seconds). */
function age(s: number) {
  const when = new Date(Date.now() - s * 1000);
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) walk(join(d, e.name));
    utimesSync(d, when, when);
  };
  walk(join(t.dir, '.git/refs/remotes'));
  try {
    statSync(join(t.dir, '.git/packed-refs'));
    utimesSync(join(t.dir, '.git/packed-refs'), when, when);
  } catch {}
}

test('remote-tracking refs are listed again only once they may have changed', async () => {
  const a = t.commit('a', { f: '1' });
  t.commit('b', { f: '2' });
  t.remote();
  t.git('push', '-q', '-u', 'origin', 'main');
  const repo = await Repo.open(t.dir);
  let listed = 0;
  const text = repo.git.text.bind(repo.git);
  repo.git.text = (args, opts) => {
    if (args[0] === 'for-each-ref' && args.includes('refs/remotes/')) listed++;
    return text(args, opts);
  };
  const ahead = async () => (await repo.state()).push?.ahead;

  age(10);
  assert.equal(await ahead(), 0);
  assert.equal(await ahead(), 0);
  assert.equal(listed, 1);

  // Moved just now: read every time until its time can be trusted.
  t.git('update-ref', 'refs/remotes/origin/main', a);
  assert.equal(await ahead(), 1);
  assert.equal(await ahead(), 1);
  assert.equal(listed, 3);
  age(9);
  assert.equal(await ahead(), 1);
  assert.equal(await ahead(), 1);
  assert.equal(listed, 4);

  // A ref in a new directory, then everything packed.
  t.git('update-ref', 'refs/remotes/origin/team/x', a);
  age(8);
  assert.equal((await repo.state()).github, null);
  assert.equal(listed, 5);
  t.git('pack-refs', '--all');
  t.git('update-ref', 'refs/remotes/origin/main', t.git('rev-parse', 'HEAD'));
  age(7);
  assert.equal(await ahead(), 0);
  assert.equal(await ahead(), 0);
  assert.equal(listed, 6);
});
