import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Git } from '../src/server/git.ts';
import { Repo } from '../src/server/repo.ts';
import { serve } from '../src/server/server.ts';
import { displaySettings, effectiveSettings, globalSettingsFile, readSettings, repoSettingsFile, saveSettings } from '../src/server/settings.ts';
import type { DiffSummary, WorkState } from '../src/shared/types.ts';
import { env, setup } from './util.ts';

const t = setup();

/** Run `f` with a fresh home (so a fresh global settings file and global git config). */
async function withHome(f: (home: string) => Promise<void>) {
  const home = t.tmp('legit-home-');
  const before = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME, CFG: process.env.GIT_CONFIG_GLOBAL };
  process.env.HOME = home;
  delete process.env.XDG_CONFIG_HOME;
  process.env.GIT_CONFIG_GLOBAL = join(home, '.gitconfig');
  try {
    await f(home);
  } finally {
    process.env.HOME = before.HOME;
    if (before.XDG !== undefined) process.env.XDG_CONFIG_HOME = before.XDG;
    process.env.GIT_CONFIG_GLOBAL = before.CFG ?? env.GIT_CONFIG_GLOBAL;
  }
}

test('legit.hide patterns are copied into the settings once, by scope, and git config is left alone', async () => {
  await withHome(async (home) => {
    const git = await Git.open(t.dir);
    t.git('config', '--add', 'legit.hide', 'docs/*.html');
    t.git('config', '--add', 'legit.hide', 'gen/**');
    t.gitIn(t.dir, 'config', '--file', join(home, '.gitconfig'), '--add', 'legit.hide', '*.snap.txt');
    let s = await readSettings(git);
    assert.deepEqual(s.repo, { collapse: ['docs/*.html', 'gen/**'], syntax: [] });
    assert.deepEqual(s.global, { collapse: ['*.snap.txt'], syntax: [] });
    assert.ok(existsSync(repoSettingsFile(git)) && existsSync(globalSettingsFile()));
    assert.equal(t.git('config', '--local', '--get-all', 'legit.hide'), 'docs/*.html\ngen/**');

    // Only once: removing one in the settings sticks, though git config still has it.
    await saveSettings(git, { scope: 'repo', settings: { collapse: ['gen/**'], syntax: [] } });
    s = await readSettings(git);
    assert.deepEqual(s.repo.collapse, ['gen/**']);
  });
});

test('settings: saved per scope, cleaned, and applied global first then the repo', async () => {
  await withHome(async () => {
    const git = await Git.open(t.dir);
    await saveSettings(git, {
      scope: 'global',
      settings: { collapse: [' *.lock2 ', ''], syntax: [{ pattern: '*.out', grammar: 'ullbc' }, { pattern: '', grammar: 'x' }, 'junk'] },
    });
    await saveSettings(git, { scope: 'repo', settings: { syntax: [{ pattern: 'tests/*.out', grammar: 'other' }] } });
    const s = await readSettings(git);
    assert.deepEqual(s.global, { collapse: ['*.lock2'], syntax: [{ pattern: '*.out', grammar: 'ullbc' }] });
    assert.deepEqual(s.repo, { collapse: [], syntax: [{ pattern: 'tests/*.out', grammar: 'other' }] });
    assert.deepEqual((await effectiveSettings(git)).syntax.map((r) => r.grammar), ['ullbc', 'other']);
    // Stored in the repo's git dir (not the work tree), readable JSON.
    assert.ok(repoSettingsFile(git).startsWith(git.commonDir));
    assert.deepEqual(JSON.parse(readFileSync(repoSettingsFile(git), 'utf8')).syntax, [{ pattern: 'tests/*.out', grammar: 'other' }]);
    await assert.rejects(saveSettings(git, { scope: 'nope' as never, settings: {} }), /Unknown settings scope/);

    // A broken file is reported, not overwritten.
    writeFileSync(repoSettingsFile(git), '{oops');
    await assert.rejects(readSettings(git), /Couldn't read the settings in .*settings\.json/);
    assert.equal(readFileSync(repoSettingsFile(git), 'utf8'), '{oops');
  });
});

test("display settings: the repo's win where set, else all repos", async () => {
  await withHome(async () => {
    const git = await Git.open(t.dir);
    assert.deepEqual(displaySettings(await readSettings(git)), { wrap: 'none', wrapColumn: 100, guides: [] });
    await saveSettings(git, { scope: 'global', settings: { wrap: 'column', wrapColumn: 80, guides: [100, 80, 80, -1, 'x'] } });
    await saveSettings(git, { scope: 'repo', settings: { wrap: 'window', wrapColumn: 0 } });
    let s = await readSettings(git);
    assert.deepEqual(s.global, { collapse: [], syntax: [], wrap: 'column', wrapColumn: 80, guides: [80, 100] });
    assert.deepEqual(displaySettings(s), { wrap: 'window', wrapColumn: 80, guides: [80, 100] });
    await saveSettings(git, { scope: 'repo', settings: { wrap: 'nope', guides: [] } });
    s = await readSettings(git);
    assert.deepEqual(displaySettings(s), { wrap: 'column', wrapColumn: 80, guides: [] });
  });
});

test('a commit diff is tagged for the page to keep: its summary until the settings change (even by hand), its contents always', async () => {
  await withHome(async () => {
    t.commit('base', { 'a.txt': '1\n' });
    const sha = t.commit('one', { 'a.txt': '2\n', 'b.lock2': '1\n' });
    const repo = await Repo.open(t.dir);
    const s = await serve(repo, { port: 0, dist: t.tmp() });
    const get = (path: string, etag?: string | null) => fetch(new URL(path, s.url), { headers: etag ? { 'if-none-match': etag } : {} });
    const lock = async (r: Response) => ((await r.json()) as DiffSummary).files.find((f) => f.path === 'b.lock2')!.generated;
    try {
      const first = await get(`/api/diff/${sha}`);
      assert.equal(first.headers.get('cache-control'), 'private, no-cache');
      const etag = first.headers.get('etag');
      assert.equal(await lock(first), false);
      assert.equal((await get(`/api/diff/${sha}`, etag)).status, 304);
      // Collapsing it in the settings file by hand shows (as it does from another repo's server).
      writeFileSync(repoSettingsFile(repo.git), JSON.stringify({ collapse: ['*.lock2'], syntax: [] }));
      const again = await get(`/api/diff/${sha}`, etag);
      assert.equal(again.status, 200);
      assert.equal(await lock(again), true);

      const files = await get(`/api/diff/${sha}/files?i=0`);
      assert.equal((await get(`/api/diff/${sha}/files?i=0`, files.headers.get('etag'))).status, 304);
      assert.equal((await get(`/api/diff/${sha}/old?i=0`, files.headers.get('etag'))).status, 304);
      // Uncommitted changes are never kept.
      t.write('a.txt', '3\n');
      const work: WorkState = await (await get('/api/work')).json();
      const changed = await get(`/api/diff/${work.changes.sha}/files?i=0`);
      assert.equal(changed.headers.get('cache-control'), 'no-store');
      assert.equal(changed.headers.get('etag'), null);
    } finally {
      s.close();
    }
  });
});
