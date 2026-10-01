import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Git } from '../src/server/git.ts';
import { effectiveSettings, globalSettingsFile, readSettings, repoSettingsFile, saveSettings } from '../src/server/settings.ts';
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
