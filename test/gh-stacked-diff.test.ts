import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

process.env.LEGIT_GITHUB_MOCK = '1';
const { githubRoute } = await import('../src/server/gh/routes.ts');
await import('../src/server/gh/mock/index.ts');
const { Repo } = await import('../src/server/repo.ts');

const tmp = mkdtempSync(join(tmpdir(), 'legit-stacked-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

test("a stacked pull request's whole diff leaves out what merging the branch below in brought", async () => {
  const dir = join(tmp, 'demo');
  execFileSync(process.execPath, ['scripts/gh-demo.ts', dir], { stdio: 'ignore' });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const commit = (msg: string, file: string) => {
    writeFileSync(join(dir, file), `${msg}\n`);
    git('add', '-A');
    git('commit', '-qm', msg);
    return git('rev-parse', 'HEAD');
  };
  // #13 (feature/parser-errors) is stacked on #12 (feature/parser), which moves on and is merged in.
  const first = git('rev-list', '--reverse', 'feature/parser..feature/parser-errors').split('\n')[0];
  git('switch', '-q', 'feature/parser');
  commit('More on the parser', 'below.ts');
  git('push', '-q', 'origin', 'feature/parser');
  git('switch', '-q', 'feature/parser-errors');
  git('merge', '-q', '--no-edit', 'origin/feature/parser');
  const head = commit('More on the errors', 'mine.ts');
  const repo = await Repo.open(dir);
  const pr = (await githubRoute(repo, 'GET', 'pr', new URLSearchParams({ branch: 'feature/parser-errors' }))) as { base: string };
  assert.equal(pr.base, 'feature/parser');
  const paths = ((await repo.diff(`q${head}-${first}`)) as { files: { path: string }[] }).files.map((f) => f.path).sort();
  assert.ok(paths.includes('mine.ts'));
  assert.ok(!paths.includes('below.ts'), paths.join(', '));
});
