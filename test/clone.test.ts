import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { cloneInfo, cloneRepo } from '../src/server/clone.ts';
import { cloneName, cloneUrl } from '../src/shared/clone.ts';
import { Repo } from '../src/server/repo.ts';
import { setup } from './util.ts';

const t = setup();

test("owner/name is GitHub's, over SSH when the repository reaches GitHub that way; a folder is named as git names it", () => {
  assert.equal(cloneUrl(' octo/legit ', false), 'https://github.com/octo/legit.git');
  assert.equal(cloneUrl('octo/legit.git', true), 'git@github.com:octo/legit.git');
  assert.equal(cloneUrl('https://example.com/a/b', true), 'https://example.com/a/b');
  assert.equal(cloneName('git@github.com:octo/legit.git'), 'legit');
  assert.equal(cloneName('https://github.com/octo/legit/'), 'legit');
  assert.equal(cloneName('/some/path/repo'), 'repo');
});

test('clone into a new folder, refused into one that has files; the default folder is beside this repository', async () => {
  t.commit('one', { a: 'x\n' });
  const source = t.dir;
  t.dir = t.tmp();
  t.git('init', '-q', '-b', 'main');
  t.commit('here', { b: 'y\n' });
  const repo = await Repo.open(t.dir);
  assert.deepEqual(await cloneInfo(repo), { parent: dirname(t.dir).replace(process.env.HOME ?? '\0', '~'), ssh: false });
  t.git('remote', 'add', 'origin', 'git@github.com:octo/here.git');
  assert.equal((await cloneInfo(repo)).ssh, true);

  const into = join(t.tmp(), 'copy');
  const r = await cloneRepo(repo, { url: source, path: into });
  assert.equal(r.path, into);
  assert.equal(readFileSync(join(into, 'a'), 'utf8'), 'x\n');

  const full = t.tmp();
  writeFileSync(join(full, 'f'), '');
  await assert.rejects(cloneRepo(repo, { url: source, path: full }), /already exists and isn't empty/);
  await assert.rejects(cloneRepo(repo, { url: '' }), /Clone what/);
  await assert.rejects(cloneRepo(repo, { url: '--upload-pack=x', path: join(t.tmp(), 'z') }), /isn't a repository URL/);
  const missing = join(t.tmp(), 'nope');
  await assert.rejects(cloneRepo(repo, { url: join(source, 'missing'), path: missing }), /Couldn't clone/);
  assert.equal(existsSync(missing), false);
});
