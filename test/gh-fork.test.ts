import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { CheckoutPlan } from '../src/shared/gh-inbox.ts';

process.env.LEGIT_GITHUB_MOCK = '1';
const { githubRoute } = await import('../src/server/gh/routes.ts');
const { db } = await import('../src/server/gh/mock/registry.ts');
await import('../src/server/gh/mock/index.ts');
const { checkoutPr } = await import('../src/server/gh/checkout.ts');
const { Repo } = await import('../src/server/repo.ts');

const tmp = mkdtempSync(join(tmpdir(), 'legit-fork-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

async function demo(name: string) {
  const dir = join(tmp, name);
  execFileSync(process.execPath, ['scripts/gh-demo.ts', dir], { stdio: 'ignore' });
  const repo = await Repo.open(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const plan = (await githubRoute(repo, 'POST', 'prCheckoutPlan', { number: 15 })) as CheckoutPlan;
  return { dir, repo, git, plan };
}

test("a fork that takes your pushes is added as a remote, and its branch tracks it there", async () => {
  const { dir, repo, git, plan } = await demo('pushable');
  assert.deepEqual(plan.addRemote, { name: 'defunkt', url: `${dir}.fork.git` });
  assert.deepEqual([plan.branch, plan.upstream], ['fix-crlf', { remote: 'defunkt', branch: 'fix-crlf' }]);
  await checkoutPr(repo, { ...plan, stash: true });
  assert.equal(git('branch', '--show-current'), 'fix-crlf');
  assert.equal(git('remote', 'get-url', 'defunkt'), `${dir}.fork.git`);
  assert.equal(git('rev-parse', '--abbrev-ref', 'fix-crlf@{upstream}'), 'defunkt/fix-crlf');
  assert.equal(git('config', '--get', 'branch.fix-crlf.legit-head'), 'defunkt:fix-crlf');
  // A commit of yours goes to the fork.
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'Address the review'], { cwd: dir });
  const state = await repo.state();
  assert.deepEqual([state.push?.remote, state.push?.ahead, state.push?.foreign], ['defunkt', 1, undefined]);
  await repo.push({});
  assert.equal(execFileSync('git', ['--git-dir', `${dir}.fork.git`, 'rev-parse', 'fix-crlf'], { encoding: 'utf8' }).trim(), git('rev-parse', 'HEAD'));
});

test("a fork that doesn't goes on <owner>/<branch>, with nowhere to push it", async () => {
  const pr = db.pulls.find((p: { number: number }) => p.number === 15);
  pr.maintainerCanModify = false;
  try {
    const { repo, git, plan } = await demo('readonly');
    assert.equal(plan.addRemote, null);
    assert.deepEqual([plan.branch, plan.upstream], ['defunkt/fix-crlf', null]);
    await checkoutPr(repo, { ...plan, stash: true });
    assert.equal(git('remote'), 'origin');
    const state = await repo.state();
    assert.equal(state.push?.foreign, 'defunkt:fix-crlf');
    await assert.rejects(repo.push({}), /doesn't take your pushes/);
  } finally {
    pr.maintainerCanModify = true;
  }
});
