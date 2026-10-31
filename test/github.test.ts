import assert from 'node:assert/strict';
import { test } from 'node:test';
import { githubRepo, pickGithubRepo } from '../src/server/github.ts';

test('github remotes in every URL form', () => {
  for (const url of [
    'https://github.com/N1ark/legit.git',
    'https://github.com/N1ark/legit',
    'https://user@github.com/N1ark/legit/',
    'git@github.com:N1ark/legit.git',
    'github.com:N1ark/legit',
    'ssh://git@github.com/N1ark/legit.git',
    'ssh://git@github.com:22/N1ark/legit',
  ]) assert.equal(githubRepo(url), 'N1ark/legit', url);
  assert.equal(githubRepo('git@github.com:a/my.repo.git'), 'a/my.repo');
  assert.equal(githubRepo('https://gitlab.com/a/b.git'), null);
  assert.equal(githubRepo('https://github.com.evil.com/a/b'), null);
  assert.equal(githubRepo('/some/local/path'), null);
});

test('the push remote wins, then origin, then any github remote', () => {
  const remotes = new Map([
    ['backup', 'git@gitlab.com:a/b.git'],
    ['fork', 'git@github.com:me/b.git'],
    ['origin', 'https://github.com/up/b.git'],
  ]);
  assert.equal(pickGithubRepo(remotes, 'fork'), 'me/b');
  assert.equal(pickGithubRepo(remotes, 'backup'), 'up/b');
  assert.equal(pickGithubRepo(remotes), 'up/b');
  remotes.delete('origin');
  assert.equal(pickGithubRepo(remotes), 'me/b');
  assert.equal(pickGithubRepo(new Map()), null);
});

test("issue links go to the repository forked from: upstream's, ahead of the push remote", async () => {
  const { issueRepo } = await import('../src/server/gh/context.ts');
  const remotes = new Map([
    ['origin', 'git@github.com:me/b.git'],
    ['upstream', 'https://github.com/up/b.git'],
  ]);
  assert.equal(await issueRepo(remotes, 'origin'), 'up/b');
  assert.equal(await issueRepo(new Map([['origin', 'git@gitlab.com:me/b.git']])), null);
});
